//! Typed Orbit Gateway operations, generated from the Gateway's OpenAPI document
//! (`openapi.json`, pinned with its source in `openapi.source`). Plan: nckrtl/conn#227.
//!
//! - [`types`]: serde types for every schema the operations in `operations.txt` use.
//! - [`ops`]: one struct per operation that implements [`GatewayOperation`]: method, path
//!   template, path, query and header parameters, request body, success and error types, auth.
//! - No HTTP client. A caller sends an operation through its own transport, so TLS, timeouts
//!   and the iOS trust store stay where they are.
//!
//! `src/types.rs` and `src/ops.rs` are generated: never edit them by hand. Regenerate with
//! `cargo run -p conn-gateway-api --features gen` (see `README.md`). Checks such as
//! `pattern`, `minLength` or `minimum` are not enforced; the Gateway validates them.

use serde::{Serialize, de::DeserializeOwned};

#[rustfmt::skip]
pub mod ops;
#[rustfmt::skip]
pub mod types;

pub use ops::OPENAPI_SHA256;

/// The HTTP method of an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    /// The method as it goes on the wire.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

/// How the Gateway identifies the caller of an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuthKind {
    /// The caller's WireGuard address names its Node; no credential in the request.
    WireGuardPeer,
    /// A managed Conn Server: `Authorization: Bearer <managed token>` on top of the peer.
    ManagedBearer,
}

/// The body of an operation that sends none. It has no values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum NoBody {}

/// Why an answer did not decode.
#[derive(Debug)]
pub enum DecodeError {
    /// The operation does not document this status.
    UnexpectedStatus(u16),
    /// The body is not the documented JSON.
    Json {
        status: u16,
        error: serde_json::Error,
    },
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedStatus(status) => write!(f, "undocumented status {status}"),
            Self::Json { status, error } => write!(f, "status {status}: {error}"),
        }
    }
}

impl std::error::Error for DecodeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::UnexpectedStatus(_) => None,
            Self::Json { error, .. } => Some(error),
        }
    }
}

/// One Gateway operation, ready for a caller's transport.
pub trait GatewayOperation {
    /// The OpenAPI `operationId`.
    const ID: &'static str;
    const METHOD: Method;
    /// The path with `{name}` placeholders, as the document gives it.
    const PATH_TEMPLATE: &'static str;
    const AUTH: AuthKind;
    /// The documented 2xx statuses.
    const SUCCESS_STATUSES: &'static [u16];
    /// The documented error statuses; each answers [`GatewayOperation::Error`].
    const ERROR_STATUSES: &'static [u16];

    /// The JSON request body, or [`NoBody`].
    type Body: Serialize;
    /// The decoded 2xx answer: one type, or an enum by status when the statuses differ.
    type Success;
    /// The decoded error answer.
    type Error: DeserializeOwned;

    /// The path with every placeholder filled in and percent-encoded.
    fn path(&self) -> String;
    /// The query parameters that are set, not encoded. See [`query_string`].
    fn query(&self) -> Vec<(&'static str, String)>;
    /// The header parameters that are set, such as `Idempotency-Key`.
    fn headers(&self) -> Vec<(&'static str, String)>;
    /// The request body, when the operation sends one.
    fn body(&self) -> Option<&Self::Body>;
    /// Decodes a 2xx answer.
    fn decode_success(status: u16, body: &[u8]) -> Result<Self::Success, DecodeError>;

    /// Decodes an error answer.
    fn decode_error(status: u16, body: &[u8]) -> Result<Self::Error, DecodeError> {
        if !Self::ERROR_STATUSES.contains(&status) {
            return Err(DecodeError::UnexpectedStatus(status));
        }
        decode_json(status, body)
    }

    /// The path and its query string, as the request line takes them.
    fn path_and_query(&self) -> String {
        let query = query_string(&self.query());
        if query.is_empty() {
            self.path()
        } else {
            format!("{}?{query}", self.path())
        }
    }
}

/// Decodes a JSON body; generated code calls it.
pub fn decode_json<T: DeserializeOwned>(status: u16, body: &[u8]) -> Result<T, DecodeError> {
    serde_json::from_slice(body).map_err(|error| DecodeError::Json { status, error })
}

/// Percent-encodes one path segment or query component (RFC 3986 unreserved stay as they are).
pub fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `name=value` pairs joined with `&`, each side percent-encoded.
pub fn query_string(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{}={}", encode_component(name), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_components() {
        assert_eq!(
            encode_component("a b/c~d"),
            "a%20b%2Fc~d",
            "space and slash encode"
        );
        assert_eq!(
            query_string(&[("name", "x&y".to_owned()), ("n", "1".to_owned())]),
            "name=x%26y&n=1",
            "pairs join with &"
        );
    }
}
