//! The RouterOS 7 REST client: HTTPS (or, when the user explicitly chooses
//! it, plain HTTP) to `/rest`, HTTP Basic auth, JSON. The
//! reqwest client is built once with the connection's proxy and TLS settings,
//! so every request goes through the same route to the device.

use reqwest::Client;
use std::time::Duration;

use super::model::{Identity, SystemResource};
use super::{ConnectionConfig, Scheme};
use crate::error::{Error, Result};
use crate::transport::TlsMode;

pub struct RestClient {
    http: Client,
    base: String,
    host: String,
    port: u16,
    username: String,
    password: String,
}

impl RestClient {
    /// Build a client for a connection. This only prepares the HTTP client
    /// (proxy, TLS); the first request is what actually reaches the device.
    pub fn connect(cfg: &ConnectionConfig) -> Result<Self> {
        let mut builder = Client::builder()
            .user_agent(concat!("wingox/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30));

        if let Some(proxy) = &cfg.proxy {
            builder = builder.proxy(proxy.to_reqwest()?);
        }
        if cfg.scheme == Scheme::Https && cfg.tls == TlsMode::AcceptInvalid {
            builder = builder.danger_accept_invalid_certs(true);
        }

        let http = builder.build()?;
        Ok(Self {
            http,
            base: format!("{}://{}:{}/rest", cfg.scheme.as_str(), cfg.host, cfg.port),
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
