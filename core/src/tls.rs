//! How Wingox trusts a router's TLS certificate.
//!
//! RouterOS routers almost always use self-signed certificates (or ones from a
//! company's internal CA), which public-root verification rejects. Besides the
//! standard check, Wingox offers:
//! - **pinning** (trust on first use): the certificate's SHA-256 fingerprint is
//!   shown on first contact, the user accepts it, and from then on only that
//!   exact certificate is accepted — a changed certificate is refused loudly;
//! - **a trusted CA** per connection (PEM), for routers whose certificate is
//!   issued by an internal CA: the full chain and the name are verified.
//!
//! Pinning uses its own rustls verifier; the handshake signatures are still
//! checked with the crypto provider, only the chain/name check is replaced by
//! the fingerprint comparison.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Serialize;

use crate::error::{Error, Result};

/// marker in a rustls error: the certificate was captured on purpose (first contact)
pub(crate) const CAPTURED: &str = "wingox-captured-certificate";
/// marker in a rustls error: the certificate did not match the pinned fingerprint
pub(crate) const PIN_MISMATCH: &str = "wingox-pin-mismatch";

/// A fingerprint as lowercase hex without separators (accepts `AA:BB…`,
/// spaces, upper case). `None` if it is not a SHA-256 (64 hex digits).
pub fn normalize_fingerprint(raw: &str) -> Option<String> {
    let hex: String = raw
        .chars()
        .filter(|c| !matches!(c, ':' | ' ' | '-' | '\t' | '\n' | '\r'))
        .collect::<String>()
        .to_ascii_lowercase();
    (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then_some(hex)
}

/// `aa:bb:cc…` — the way certificate tools usually print a fingerprint
pub fn pretty_fingerprint(hex: &str) -> String {
    hex.as_bytes()
        .chunks(2)
        .map(|p| String::from_utf8_lossy(p).to_ascii_uppercase())
        .collect::<Vec<_>>()
        .join(":")
}

pub fn sha256_hex(der: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, der);
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// What a router's certificate says, shown before the user pins it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateInfo {
    /// SHA-256 of the certificate (lowercase hex) — what gets pinned
    pub sha256: String,
    /// the same, `AA:BB:…`
    pub sha256_pretty: String,
    pub subject: String,
    pub issuer: String,
    pub not_before: String,
    pub not_after: String,
    pub subject_alt_names: Vec<String>,
    /// issuer == subject
    pub self_signed: bool,
}

impl CertificateInfo {
    pub fn from_der(der: &[u8]) -> Self {
        let sha256 = sha256_hex(der);
        let sha256_pretty = pretty_fingerprint(&sha256);
        match x509_parser::parse_x509_certificate(der) {
            Ok((_, cert)) => {
                let subject = cert.subject().to_string();
                let issuer = cert.issuer().to_string();
                let sans = cert
                    .subject_alternative_name()
                    .ok()
                    .flatten()
                    .map(|ext| ext.value.general_names.iter().map(general_name).collect())
                    .unwrap_or_default();
                CertificateInfo {
                    sha256,
                    sha256_pretty,
                    self_signed: subject == issuer,
                    subject,
                    issuer,
                    not_before: cert.validity().not_before.to_string(),
                    not_after: cert.validity().not_after.to_string(),
                    subject_alt_names: sans,
                }
            }
            Err(_) => CertificateInfo {
                sha256,
                sha256_pretty,
                subject: "(unreadable certificate)".into(),
                issuer: String::new(),
                not_before: String::new(),
                not_after: String::new(),
                subject_alt_names: vec![],
                self_signed: false,
            },
        }
    }
}

/// a subject-alt-name the way people write it (`IP:192.168.1.1`, `DNS:router`)
fn general_name(name: &x509_parser::extensions::GeneralName<'_>) -> String {
    use x509_parser::extensions::GeneralName;
    match name {
        GeneralName::DNSName(d) => format!("DNS:{d}"),
        GeneralName::IPAddress(ip) => match ip.len() {
            4 => format!("IP:{}", std::net::Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3])),
            16 => {
                let mut b = [0u8; 16];
                b.copy_from_slice(ip);
                format!("IP:{}", std::net::Ipv6Addr::from(b))
            }
            _ => "IP:?".into(),
        },
        GeneralName::RFC822Name(m) => format!("email:{m}"),
        GeneralName::URI(u) => format!("URI:{u}"),
        other => other.to_string(),
    }
}

/// Accepts exactly the pinned certificate; with no pin it records the
/// certificate and aborts the handshake (so nothing — no credentials — is sent).
#[derive(Debug)]
struct PinVerifier {
    pin: Option<String>,
    seen: Arc<Mutex<Option<Vec<u8>>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(end_entity.as_ref().to_vec());
        }
        let got = sha256_hex(end_entity.as_ref());
        match &self.pin {
            Some(pin) if *pin == got => Ok(ServerCertVerified::assertion()),
            Some(pin) => Err(rustls::Error::General(format!("{PIN_MISMATCH} expected={pin} got={got}"))),
            None => Err(rustls::Error::General(CAPTURED.into())),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// a rustls client config that pins `pin` (or, with `None`, captures the
/// certificate into `seen` and aborts)
pub(crate) fn pinned_config(
    pin: Option<String>,
    seen: Arc<Mutex<Option<Vec<u8>>>>,
) -> Result<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = PinVerifier { pin, seen, provider: provider.clone() };
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Other(format!("TLS setup: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    // reqwest is built without HTTP/2 here: offer HTTP/1.1 only
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// the certificates of a PEM bundle, as reqwest roots (fails clearly on junk)
pub(crate) fn ca_roots(pem: &str) -> Result<Vec<reqwest::Certificate>> {
    let certs = reqwest::Certificate::from_pem_bundle(pem.as_bytes())
        .map_err(|e| Error::Other(format!("the trusted CA is not a valid PEM certificate: {e}")))?;
    if certs.is_empty() {
        return Err(Error::Other(
            "the trusted CA has no certificate (expected -----BEGIN CERTIFICATE----- …)".into(),
        ));
    }
    Ok(certs)
}
