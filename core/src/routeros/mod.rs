//! Talking to RouterOS. For the MVP this is the REST API (RouterOS 7). The
//! binary API (8728/8729) is added later behind a shared client trait so the
//! rest of the app does not care which one answered.

pub mod model;
pub mod rest;

use crate::transport::{ProxyConfig, TlsMode};

/// Which RouterOS web service carries the REST API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Scheme {
    /// `www-ssl` (HTTPS, 443 by default) — the normal, encrypted way
    #[default]
    Https,
    /// `www` (plain HTTP, 80 by default). NOTHING is encrypted: the RouterOS
    /// username and password (HTTP Basic auth) and all data travel in clear
    /// text, readable by the proxy and by every network hop. Only for routers
    /// whose `www-ssl` cannot be used (e.g. it has no certificate assigned).
    Http,
}

impl Scheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Scheme::Https => "https",
            Scheme::Http => "http",
        }
    }

    pub fn default_port(self) -> u16 {
        match self {
            Scheme::Https => 443,
            Scheme::Http => 80,
        }
    }
}

/// Everything needed to reach one RouterOS device over REST, including the
/// optional route (proxy) to it.
#[derive(Debug, Clone)]
pub struct ConnectionConfig {
    pub host: String,
    /// HTTPS (`www-ssl`) or plain, unencrypted HTTP (`www`)
    pub scheme: Scheme,
    /// the port of that service (443 for `www-ssl`, 80 for `www` by default)
    pub port: u16,
    pub username: String,
    pub password: String,
    pub tls: TlsMode,
    /// how to reach the device; `None` means connect directly
    pub proxy: Option<ProxyConfig>,
}

impl ConnectionConfig {
    pub fn new(
        host: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        Self {
            host: host.into(),
            scheme: Scheme::Https,
            port: 443,
            username: username.into(),
            password: password.into(),
            tls: TlsMode::default(),
            proxy: None,
        }
    }
}
