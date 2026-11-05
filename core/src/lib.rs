//! Wingox core.
//!
//! The reusable heart of Wingox: how to reach a RouterOS device (directly or
//! through a proxy) and talk to it. The headless CLI and, later, the Tauri
//! desktop app both build on this crate — no UI, no platform specifics here.

pub mod error;
pub mod routeros;
pub mod transport;

pub use error::{Error, Result};
pub use routeros::rest::RestClient;
pub use routeros::ConnectionConfig;
pub use transport::{ProxyConfig, ProxyKind, TlsMode};
