//! How a connection reaches the device: directly, or through a proxy. This is
//! Wingox's headline feature — WinBox cannot do it. For the REST MVP a reqwest
//! proxy covers SOCKS5 and HTTP CONNECT; an SSH jump (via `russh`) is added in
//! a later slice, behind this same `ProxyConfig`.

use crate::error::{Error, Result};

/// How the device's TLS certificate is trusted. RouterOS ships self-signed
/// certificates, so `Verify` (public roots) usually fails; `Pinned` and
/// `TrustedCa` are the safe ways to trust a router (see `tls.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum TlsMode {
    /// standard chain validation against the public roots
    #[default]
    Verify,
    /// accept exactly the certificate with this SHA-256 fingerprint
    /// (lowercase hex, see `tls::normalize_fingerprint`)
    Pinned(String),
    /// validate the chain and the name against this CA (PEM, one or more certs)
    /// in addition to the public roots
    TrustedCa(String),
    /// skip verification — anything is accepted, including an impostor; the
    /// UI shows a clear warning. Pinning is the safe replacement.
    AcceptInvalid,
}

/// The kind of proxy a connection routes its traffic through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyKind {
    /// SOCKS5 (names are resolved by the proxy, so a device reachable only on
    /// the far side by name still works)
    Socks5,
    /// an HTTP proxy's `CONNECT` tunnel
    Http,
}

/// A proxy a connection goes through to reach a device on another network.
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ProxyConfig {
    pub fn new(kind: ProxyKind, host: impl Into<String>, port: u16) -> Self {
        Self {
            kind,
            host: host.into(),
            port,
            username: None,
            password: None,
        }
    }

    pub fn with_auth(mut self, username: impl Into<String>, password: impl Into<String>) -> Self {
        self.username = Some(username.into());
        self.password = Some(password.into());
        self
    }

    /// A reqwest proxy that routes all of a connection's traffic. `socks5h`
    /// makes the proxy resolve DNS, so a name that only resolves on the far
    /// network still reaches the device.
    pub fn to_reqwest(&self) -> Result<reqwest::Proxy> {
        let scheme = match self.kind {
            ProxyKind::Socks5 => "socks5h",
            ProxyKind::Http => "http",
        };
        let url = format!("{scheme}://{}:{}", self.host, self.port);
        let mut proxy = reqwest::Proxy::all(&url).map_err(|e| Error::Proxy(e.to_string()))?;
        if let Some(user) = &self.username {
            proxy = proxy.basic_auth(user, self.password.as_deref().unwrap_or(""));
        }
        Ok(proxy)
    }
}
