//! One error type for the core, so callers (CLI, Tauri commands) can show a
//! clear message and map it to their own result shape.
//!
//! Network failures are classified (see [`Error::from_request`]) so the user
//! reads *why* a device could not be reached — a router without a TLS
//! certificate, a self-signed one, a proxy that refused the port — instead of
//! a bare "error sending request".

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    /// transport or HTTP failure (also wraps proxy connect failures from reqwest)
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),

    /// the device aborted the TLS handshake. On RouterOS this is what a
    /// `www-ssl` service with `certificate=none` does: it only offers anonymous
    /// ciphers, which no modern TLS client accepts.
    #[error(
        "the router refused the TLS handshake on {host}:{port}. Its www-ssl service most likely has \
         no certificate (certificate=none), so HTTPS cannot work. Fix it on the router by assigning a \
         certificate to www-ssl, or connect with Protocol = HTTP (unencrypted: the RouterOS user and \
         password travel in clear text). [{detail}]"
    )]
    TlsHandshake { host: String, port: u16, detail: String },

    /// the device's certificate did not validate (RouterOS ships self-signed ones)
    #[error(
        "the router's TLS certificate is not trusted (self-signed, from a private CA, or for another \
         name). RouterOS certificates are usually self-signed: pin this router's certificate \
         (Certificate = Pinned, then Fetch), or trust the CA that issued it (Certificate = Trusted \
         CA). [{detail}]"
    )]
    Certificate { detail: String },

    /// the router presented a certificate other than the pinned one
    #[error(
        "the router's certificate CHANGED — it does not match the pinned fingerprint. Expected \
         {expected}, got {got}. If you renewed the certificate on the router, fetch and pin the new \
         one (compare it with /certificate print on the router); otherwise someone may be \
         intercepting the connection: do not continue."
    )]
    PinMismatch { expected: String, got: String },

    /// the HTTP proxy answered the CONNECT with an error status
    #[error(
        "the proxy refused to open a tunnel to {host}:{port}. An HTTP proxy such as Squid only \
         allows CONNECT to the ports in its ACLs (by default just 443 — see SSL_ports/Safe_ports), \
         or this client is not allowed to use it."
    )]
    ProxyRefused { host: String, port: u16 },

    /// nothing came back in time (the router, or the proxy on its behalf, did not answer)
    #[error("no answer from {host}:{port} in time (timed out) — the router or the path to it is down")]
    Timeout { host: String, port: u16 },

    /// the router's SSH host key has not been accepted yet
    #[error("the router's SSH host key is not trusted yet ({algorithm} {got}): check and accept it first")]
    HostKeyUnknown { got: String, algorithm: String },

    /// the router presented an SSH host key other than the pinned one
    #[error(
        "the router's SSH host key CHANGED — expected {expected}, got {got}. If the router was \
         reinstalled or its host key regenerated, accept the new key; otherwise someone may be \
         intercepting the connection: do not continue."
    )]
    HostKeyMismatch { expected: String, got: String },

    /// SSH password authentication was refused
    #[error("the router refused the SSH login for user {user:?} (wrong password, or SSH not allowed for this user/address)")]
    SshAuth { user: String },

    /// any other SSH failure
    #[error("{0}")]
    Ssh(String),

    /// the proxy wants credentials (HTTP 407)
    #[error("the proxy requires authentication or refused the credentials: set or fix the proxy user and password")]
    ProxyAuth,

    /// the proxy configuration itself is invalid
    #[error("invalid proxy: {0}")]
    Proxy(String),

    /// RouterOS answered with a non-success status
    #[error("RouterOS returned HTTP {status}: {message}")]
    Api { status: u16, message: String },

    /// anything else, with context
    #[error("{0}")]
    Other(String),
}

impl Error {
    /// Turn a failed request to `host:port` into the most telling error.
    pub fn from_request(err: reqwest::Error, host: &str, port: u16) -> Error {
        let chain = chain_text(&err);
        let lower = chain.to_ascii_lowercase();
        if lower.contains("proxy authorization required") {
            return Error::ProxyAuth;
        }
        if let Some(at) = chain.find(crate::tls::PIN_MISMATCH) {
            let rest = &chain[at..];
            let field = |key: &str| {
                rest.split_whitespace()
                    .find_map(|w| w.strip_prefix(key))
                    .map(|v| crate::tls::pretty_fingerprint(v.trim_end_matches(|c: char| !c.is_ascii_hexdigit())))
                    .unwrap_or_default()
            };
            return Error::PinMismatch { expected: field("expected="), got: field("got=") };
        }
        if lower.contains("tunnel error: unsuccessful") || lower.contains("unsuccessful tunnel") {
            return Error::ProxyRefused { host: host.to_string(), port };
        }
        if lower.contains("invalid peer certificate")
            || lower.contains("unknownissuer")
            || lower.contains("notvalidforname")
            || lower.contains("certificate expired")
        {
            return Error::Certificate { detail: chain };
        }
        if lower.contains("handshakefailure")
            || lower.contains("handshake failure")
            || lower.contains("received fatal alert")
            || lower.contains("peerincompatible")
            || lower.contains("no cipher suites in common")
        {
            return Error::TlsHandshake { host: host.to_string(), port, detail: chain };
        }
        if err.is_timeout() {
            return Error::Timeout { host: host.to_string(), port };
        }
        Error::Http(err)
    }
}

/// the error and all its sources, joined — reqwest keeps the useful part
/// (the TLS alert, the tunnel status) a few levels down
fn chain_text(err: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(e) = source {
        let text = e.to_string();
        if !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        source = e.source();
    }
    parts.join(": ")
}

pub type Result<T> = std::result::Result<T, Error>;
