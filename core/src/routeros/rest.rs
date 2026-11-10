//! The RouterOS 7 REST client: HTTPS (or, when the user explicitly chooses
//! it, plain HTTP) to `/rest`, HTTP Basic auth, JSON. The
//! reqwest client is built once with the connection's proxy and TLS settings,
//! so every request goes through the same route to the device.

use reqwest::Client;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::model::{Identity, SystemResource};
use super::{ConnectionConfig, Scheme};
use crate::error::{Error, Result};
use crate::tls::{self, CertificateInfo};
use crate::transport::TlsMode;

pub struct RestClient {
    http: Client,
    base: String,
    host: String,
    port: u16,
    username: String,
    password: String,
}

/// a reqwest client that reaches the device the way `cfg` says (proxy, TLS)
fn http_client(cfg: &ConnectionConfig, tls_mode: &TlsMode, timeout: Duration) -> Result<Client> {
    let mut builder = Client::builder()
        .user_agent(concat!("wingox/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(timeout.min(Duration::from_secs(15)))
        .timeout(timeout);

    if let Some(proxy) = &cfg.proxy {
        builder = builder.proxy(proxy.to_reqwest()?);
    }
    if cfg.scheme == Scheme::Https {
        builder = match tls_mode {
            TlsMode::Verify => builder,
            TlsMode::AcceptInvalid => builder.danger_accept_invalid_certs(true),
            TlsMode::TrustedCa(pem) => {
                let mut b = builder;
                for cert in tls::ca_roots(pem)? {
                    b = b.add_root_certificate(cert);
                }
                b
            }
            TlsMode::Pinned(pin) => {
                let pin = tls::normalize_fingerprint(pin).ok_or_else(|| {
                    Error::Other("the pinned fingerprint is not a SHA-256 (64 hex digits)".into())
                })?;
                builder.use_preconfigured_tls(tls::pinned_config(Some(pin), Arc::default())?)
            }
        };
    }
    Ok(builder.build()?)
}

fn base_url(cfg: &ConnectionConfig) -> String {
    format!("{}://{}:{}", cfg.scheme.as_str(), cfg.host, cfg.port)
}

impl RestClient {
    /// Build a client for a connection. This only prepares the HTTP client
    /// (proxy, TLS); the first request is what actually reaches the device.
    pub fn connect(cfg: &ConnectionConfig) -> Result<Self> {
        let http = http_client(cfg, &cfg.tls, Duration::from_secs(30))?;
        Ok(Self {
            http,
            base: format!("{}/rest", base_url(cfg)),
            host: cfg.host.clone(),
            port: cfg.port,
            username: cfg.username.clone(),
            password: cfg.password.clone(),
        })
    }

    /// GET a menu path (e.g. `ip/address`) and return its parsed JSON: an array
    /// of rows for a list menu, an object for a settings menu. Only plain menu
    /// paths are accepted (letters, digits, `-`, `/`), so a UI cannot smuggle a
    /// query or another host into the URL.
    pub async fn get(&self, path: &str) -> Result<serde_json::Value> {
        let path = path.trim_matches('/');
        if path.is_empty()
            || !path.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '/')
            || path.contains("//")
        {
            return Err(Error::Other(format!("not a RouterOS menu path: {path:?}")));
        }
        let url = format!("{}/{}", self.base, path);
        let resp = self
            .http
            .get(&url)
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .await
            .map_err(|e| Error::from_request(e, &self.host, self.port))?;
        // read the status first: on an error we still report it cleanly even if
        // reading the body then fails (a device may frame an error response loosely)
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(Error::Api {
                status: status.as_u16(),
                message: short(&body),
            });
        }
        serde_json::from_str(&body)
            .map_err(|e| Error::Other(format!("RouterOS sent invalid JSON: {e}")))
    }

    pub async fn system_resource(&self) -> Result<SystemResource> {
        let value = self.get("system/resource").await?;
        serde_json::from_value(value).map_err(|e| Error::Other(e.to_string()))
    }

    pub async fn identity(&self) -> Result<Identity> {
        let value = self.get("system/identity").await?;
        serde_json::from_value(value).map_err(|e| Error::Other(e.to_string()))
    }

    /// The interfaces, left as raw JSON rows for now (RouterOS reports some
    /// fields as "true"/"false" strings; typed models come with the browser).
    pub async fn interfaces(&self) -> Result<Vec<serde_json::Value>> {
        match self.get("interface").await? {
            serde_json::Value::Array(rows) => Ok(rows),
            other => Ok(vec![other]),
        }
    }
}

/// Read the router's TLS certificate without trusting it and without sending
/// anything else: the handshake is aborted right after the certificate
/// arrives, so no credentials ever leave. Goes through the connection's proxy.
pub async fn fetch_certificate(cfg: &ConnectionConfig) -> Result<CertificateInfo> {
    if cfg.scheme != Scheme::Https {
        return Err(Error::Other("plain HTTP has no certificate".into()));
    }
    let seen: Arc<Mutex<Option<Vec<u8>>>> = Arc::default();
    let mut plain = cfg.clone();
    plain.tls = TlsMode::Verify; // replaced below by the capturing verifier
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .use_preconfigured_tls(tls::pinned_config(None, seen.clone())?);
    if let Some(proxy) = &cfg.proxy {
        builder = builder.proxy(proxy.to_reqwest()?);
    }
    let client = builder.build()?;
    let outcome = client.get(format!("{}/", base_url(cfg))).send().await;
    let captured = seen.lock().ok().and_then(|s| s.clone());
    match (captured, outcome) {
        (Some(der), _) => Ok(CertificateInfo::from_der(&der)),
        (None, Err(e)) => Err(Error::from_request(e, &cfg.host, cfg.port)),
        (None, Ok(_)) => Err(Error::Other("the router sent no certificate".into())),
    }
}

/// Is the router reachable along its route (proxy included)? An
/// unauthenticated GET of the web service's root: any answer from the router
/// counts, no credentials are sent and the certificate is not checked (nothing
/// secret travels). ICMP cannot cross a SOCKS/HTTP proxy, so this is the
/// "ping" that works for every connection. Returns the round trip.
pub async fn reach(cfg: &ConnectionConfig, timeout: Duration) -> Result<Duration> {
    let client = http_client(cfg, &TlsMode::AcceptInvalid, timeout)?;
    let started = Instant::now();
    let resp = client
        .get(format!("{}/", base_url(cfg)))
        .send()
        .await
        .map_err(|e| Error::from_request(e, &cfg.host, cfg.port))?;
    let elapsed = started.elapsed();
    // an HTTP proxy forwarding plain HTTP answers 502/503/504 itself when it
    // cannot reach the router (Squid adds X-Squid-Error)
    let status = resp.status().as_u16();
    let from_proxy = cfg.proxy.is_some()
        && matches!(status, 502..=504)
        && (resp.headers().contains_key("x-squid-error") || resp.headers().contains_key("via"));
    if from_proxy {
        return Err(Error::Other(format!("the proxy could not reach the router (HTTP {status})")));
    }
    Ok(elapsed)
}

/// a RouterOS error body, trimmed to one short line
fn short(body: &str) -> String {
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(serde_json::Value::String(message)) = map.get("message") {
            return message.clone();
        }
    }
    let line = body.trim().lines().next().unwrap_or("").trim();
    line.chars().take(200).collect()
}
