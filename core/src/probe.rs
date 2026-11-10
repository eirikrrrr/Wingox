//! The reachability "ping" behind the monitor.
//!
//! A real ICMP ping cannot cross a SOCKS5 or HTTP proxy — they relay TCP
//! connections only — so Wingox probes the router's TCP services along the
//! profile's own route instead, without credentials:
//!   1. its web service (the REST protocol and port of the profile): any HTTP
//!      answer from the router counts;
//!   2. if that fails, its SSH port: the router must greet with `SSH-…`.
//! The router is up if either answers. When every attempt was refused by the
//! proxy itself (e.g. Squid only allows CONNECT to 443/22), the router is not
//! "down" — it cannot be probed through that proxy — and the report says so.

use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::AsyncReadExt;

use crate::error::Error;
use crate::routeros::rest::reach;
use crate::routeros::ConnectionConfig;

/// One probe round's verdict.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub up: bool,
    /// nothing could be probed because the proxy refused every port
    pub blocked: bool,
    /// round trip of the probe that answered, ms
    pub ms: Option<u64>,
    /// what answered, e.g. `https:443`, `ssh:22`
    pub via: Option<String>,
    /// why each failed attempt failed (`what — error`), when not up
    pub detail: Option<String>,
}

/// Probe the web service, then (if it fails) the SSH port.
pub async fn probe(cfg: &ConnectionConfig, ssh_port: u16, timeout: Duration) -> ProbeReport {
    let web = format!("{}:{}", cfg.scheme.as_str(), cfg.port);
    let web_err = match reach(cfg, timeout).await {
        Ok(rtt) => return up(rtt, web),
        Err(e) => e,
    };
    let ssh = format!("ssh:{ssh_port}");
    let ssh_err = match ssh_banner(cfg, ssh_port, timeout).await {
        Ok(rtt) => return up(rtt, ssh),
        Err(e) => e,
    };
    let refused = |e: &Error| matches!(e, Error::ProxyRefused { .. });
    let blocked = cfg.proxy.is_some() && refused(&web_err) && refused(&ssh_err);
    let detail = if blocked {
        format!(
            "the proxy refuses both ports this router uses ({web}, {ssh}), so it cannot be probed through it — \
             allow one of them in the proxy (Squid: SSL_ports/Safe_ports)"
        )
    } else {
        format!("{web} — {web_err}; {ssh} — {ssh_err}")
    };
    ProbeReport { up: false, blocked, ms: None, via: None, detail: Some(detail) }
}

fn up(rtt: Duration, via: String) -> ProbeReport {
    ProbeReport { up: true, blocked: false, ms: Some(rtt.as_millis() as u64), via: Some(via), detail: None }
}

/// TCP to the SSH port along the route, and the router's `SSH-` greeting
async fn ssh_banner(cfg: &ConnectionConfig, port: u16, timeout: Duration) -> Result<Duration, Error> {
    let started = Instant::now();
    let attempt = async {
        let mut stream = crate::net::connect(&cfg.host, port, cfg.proxy.as_ref()).await?;
        let mut greeting = [0u8; 4];
        stream
            .read_exact(&mut greeting)
            .await
            .map_err(|e| Error::Other(format!("no SSH greeting: {e}")))?;
        if &greeting != b"SSH-" {
            return Err(Error::Other("something answered, but not SSH".into()));
        }
        Ok(started.elapsed())
    };
    tokio::time::timeout(timeout, attempt)
        .await
        .map_err(|_| Error::Timeout { host: cfg.host.clone(), port })?
}
