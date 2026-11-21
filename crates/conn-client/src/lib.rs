#![forbid(unsafe_code)]

//! Effect RPC WebSocket and HTTP client for `conn-server`.
//!
//! Uses `conn-wire` for frame codecs and `conn-contract` for typed RPC payloads/responses.
//! Runs on its own Tokio runtime (GPUI's main thread has no Tokio) and bridges events to
//! `conn-app` via bounded channels.
//!
//! API contract (`conn-app` builds against these names; keep them stable):
//! - [`ServerConfig`]: where and how to connect.
//! - [`Connection::start`]: spawns the connection on a Tokio runtime handle and returns a
//!   cloneable [`Connection`] plus a receiver of [`ClientEvent`]s.
//! - [`Connection::subscribe_shell`], [`Connection::subscribe_thread`]: streams whose items
//!   arrive as [`ClientEvent::Shell`] / [`ClientEvent::Thread`].
//! - [`Connection::call`] / [`Connection::call_json`]: unary RPCs.

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
    #[error("auth failed: {0}")]
    Auth(String),
    /// The server ended the request with a failure exit (typed error or defect), as JSON.
    #[error("rpc failed: {0}")]
    Rpc(serde_json::Value),
    #[error("connection closed")]
    Closed,
}

/// How to reach and authenticate with a `conn-server`.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// `http://127.0.0.1:3773`
    pub http_base_url: url::Url,
    pub credential: Credential,
}

/// What the client presents to the server.
#[derive(Clone)]
pub enum Credential {
    /// A single-use pairing code (the `#token=` part of the server's `pairingUrl`). Exchanged
    /// once at `POST /oauth/token` for a bearer token.
    PairingCode(String),
    /// A bearer access token from an earlier exchange.
    Bearer(String),
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PairingCode(_) => f.write_str("PairingCode(<redacted>)"),
            Self::Bearer(_) => f.write_str("Bearer(<redacted>)"),
        }
    }
}

/// Connection lifecycle as the UI shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    /// Lost; retrying after a backoff.
    Reconnecting { attempt: u32 },
    Failed(String),
}

/// Everything the connection reports to the UI.
#[derive(Clone, Debug)]
pub enum ClientEvent {
    Status(ConnectionStatus),
    /// The bearer token after a pairing-code exchange, so the app can persist it.
    BearerIssued(String),
    Shell(conn_contract::OrchestrationV2ShellStreamItem),
    Thread {
        thread_id: String,
        item: conn_contract::OrchestrationV2ThreadStreamItem,
    },
    /// A stream ended or failed; the UI may resubscribe.
    StreamEnded {
        tag: String,
        key: String,
        error: Option<String>,
    },
}

/// Handle to a running connection. Cheap to clone; every method is non-blocking.
#[derive(Clone, Debug)]
pub struct Connection {
    _private: (),
}
