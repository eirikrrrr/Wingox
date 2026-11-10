//! Wingox core.
//!
//! The reusable heart of Wingox: how to reach a RouterOS device (directly or
//! through a proxy) and talk to it. The headless CLI and, later, the Tauri
//! desktop app both build on this crate — no UI, no platform specifics here.

pub mod error;
pub mod net;
pub mod probe;
pub mod routeros;
pub mod ssh;
pub mod tls;
pub mod transport;

pub use error::{Error, Result};
pub use routeros::rest::{fetch_certificate, reach, RestClient};
pub use ssh::{fetch_host_key, HostKeyInfo, Shell, ShellInput, ShellOutput, SshTarget};
pub use probe::{probe, ProbeReport};
pub use tls::CertificateInfo;
pub use routeros::{ConnectionConfig, Scheme};
pub use transport::{ProxyConfig, ProxyKind, TlsMode};
