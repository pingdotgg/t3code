//! JSON-RPC 2.0 frames on the agent's stdio, one per line. Params and results stay
//! `serde_json::Value`: the T3 server sends shapes no published ACP type holds (the
//! negotiating `initialize`, see README "Trial"), and reads agent frames field by field.

use serde_json::{Value, json};

use crate::ordered::{J, obj};

/// A request id as the agent sent it: T3 echoes it back unchanged in the reply.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum RequestId {
    Number(i64),
    Text(String),
}

impl RequestId {
    fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Number(n) => n.as_i64().map(Self::Number),
            Value::String(s) if !s.is_empty() => Some(Self::Text(s.clone())),
            _ => None,
        }
    }

    pub(crate) fn to_value(&self) -> Value {
        match self {
            Self::Number(n) => json!(n),
            Self::Text(s) => json!(s),
        }
    }

    /// A stable text form for maps and runtime request ids.
    pub(crate) fn key(&self) -> String {
        match self {
            Self::Number(n) => n.to_string(),
            Self::Text(s) => s.clone(),
        }
    }
}

/// An error object from a response.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    fn from_value(value: &Value) -> Self {
        Self {
            code: value.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            data: value.get("data").cloned(),
        }
    }
}

/// One frame the agent wrote.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Inbound {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: i64,
        result: Result<Value, RpcError>,
    },
}

impl Inbound {
    /// `None` for a line that is not a JSON-RPC frame we can route (logged by the caller).
    pub(crate) fn parse(line: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(line).ok()?;
        let object = value.as_object()?;
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            let params = object.get("params").cloned().unwrap_or(Value::Null);
            // effect-acp treats a missing, null or empty id as a notification.
            return Some(match object.get("id").and_then(RequestId::from_value) {
                Some(id) => Self::Request {
                    id,
                    method: method.to_owned(),
                    params,
                },
                None => Self::Notification {
                    method: method.to_owned(),
                    params,
                },
            });
        }
        // Our requests carry numeric ids only, so a reply with another id is not ours.
        let id = object.get("id")?.as_i64()?;
        let result = match object.get("error") {
            Some(error) if !error.is_null() => Err(RpcError::from_value(error)),
            _ => Ok(object.get("result").cloned().unwrap_or(Value::Null)),
        };
        Some(Self::Response { id, result })
    }
}

/// `{"jsonrpc":"2.0","id":…,"method":…,"params":…}` in the field order the T3 server writes.
pub(crate) fn request(id: i64, method: &str, params: J) -> String {
    obj()
        .with("jsonrpc", "2.0")
        .with("id", id)
        .with("method", method)
        .with("params", params)
        .to_line()
}

pub(crate) fn notification(method: &str, params: J) -> String {
    obj()
        .with("jsonrpc", "2.0")
        .with("method", method)
        .with("params", params)
        .to_line()
}

pub(crate) fn response(id: &RequestId, result: J) -> String {
    obj()
        .with("jsonrpc", "2.0")
        .with("id", id.to_value())
        .with("result", result)
        .to_line()
}

pub(crate) fn error_response(id: &RequestId, code: i64, message: &str) -> String {
    obj()
        .with("jsonrpc", "2.0")
        .with("id", id.to_value())
        .with("error", obj().with("code", code).with("message", message))
        .to_line()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_frame_kind() {
        assert_eq!(
            Inbound::parse(
                r#"{"jsonrpc":"2.0","id":3,"method":"session/request_permission","params":{"a":1}}"#
            ),
            Some(Inbound::Request {
                id: RequestId::Number(3),
                method: "session/request_permission".into(),
                params: json!({"a": 1})
            }),
            "a request"
        );
        assert_eq!(
            Inbound::parse(r#"{"jsonrpc":"2.0","id":"","method":"session/update","params":{}}"#),
            Some(Inbound::Notification {
                method: "session/update".into(),
                params: json!({})
            }),
            "an empty id is a notification"
        );
        assert_eq!(
            Inbound::parse(r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"bad"}}"#),
            Some(Inbound::Response {
                id: 2,
                result: Err(RpcError {
                    code: -32602,
                    message: "bad".into(),
                    data: None
                })
            }),
            "an error reply"
        );
        assert_eq!(Inbound::parse("not json"), None, "garbage is skipped");
        assert_eq!(Inbound::parse("[1]"), None, "a batch is skipped");
    }

    #[test]
    fn writes_fields_in_order() {
        assert_eq!(
            request(1, "initialize", obj().with("protocolVersion", 2)),
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}"#
        );
        assert_eq!(
            response(&RequestId::Text("x".into()), obj()),
            r#"{"jsonrpc":"2.0","id":"x","result":{}}"#
        );
    }
}
