//! One error type for the core, so callers (CLI, Tauri commands) can show a
//! clear message and map it to their own result shape.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    /// transport or HTTP failure (also wraps proxy connect failures from reqwest)
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),

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

pub type Result<T> = std::result::Result<T, Error>;
