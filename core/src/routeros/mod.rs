//! Talking to RouterOS. For the MVP this is the REST API (RouterOS 7). The
//! binary API (8728/8729) is added later behind a shared client trait so the
//! rest of the app does not care which one answered.

pub mod model;
pub mod rest;

use crate::transport::{ProxyConfig, TlsMode};

/// Everything needed to reach one RouterOS device over REST, including the
/// optional route (proxy) to it.
#[derive(Debug, Clone)]
pub struct ConnectionConfig {
    pub host: String,
    /// the HTTPS port of the device's `www-ssl` service (443 by default)
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
            port: 443,
            username: username.into(),
            password: password.into(),
            tls: TlsMode::default(),
            proxy: None,
        }
    }
}
