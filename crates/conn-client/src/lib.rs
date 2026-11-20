#![forbid(unsafe_code)]

//! Effect RPC WebSocket and HTTP client for `conn-server`.
//!
//! Uses `conn-wire` for frame codecs and `conn-contract` for typed RPC payloads/responses.
//! Runs on its own Tokio runtime (GPUI's main thread has no Tokio) and bridges events to
//! `conn-app` via bounded channels.

use thiserror::Error;

/// Errors returned by the `conn-server` transport layer.
#[derive(Debug, Error)]
pub enum ClientError {
    #[error("invalid server url: {0}")]
    InvalidUrl(#[from] url::ParseError),
    #[error("connection failed: {0}")]
    Connection(String),
    #[error("wire codec error: {0}")]
    Codec(#[from] serde_json::Error),
}
