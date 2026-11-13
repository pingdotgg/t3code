//! The app-server's JSON-RPC framing: one object per line, no `"jsonrpc"` member. See
//! `PROTOCOL.md`. Params and results stay `serde_json::Value`: the mapper reads the few fields
//! it needs, so a new field or a renamed one costs nothing until it is used.

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

/// One frame from the app-server.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    /// The answer to a request this side sent.
    Response {
        id: u64,
        result: Result<Value, RpcError>,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// A request the app-server sends; `id` goes back verbatim in the reply.
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    /// Not a JSON object, or one that fits no frame kind.
    Invalid(String),
}

impl Inbound {
    pub fn decode(line: &str) -> Inbound {
        match serde_json::from_str::<Value>(line) {
            Ok(value) => Inbound::from_value(value),
            Err(e) => Inbound::Invalid(format!("not JSON: {e}")),
        }
    }

    pub fn from_value(mut value: Value) -> Inbound {
        let Some(object) = value.as_object_mut() else {
            return Inbound::Invalid("not an object".into());
        };
        let id = object.remove("id");
        let method = object
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let params = object.remove("params").unwrap_or(Value::Null);
        match (id, method) {
            (Some(id), Some(method)) => Inbound::Request { id, method, params },
            (None, Some(method)) => Inbound::Notification { method, params },
            (Some(id), None) => {
                let Some(id) = id.as_u64() else {
                    return Inbound::Invalid(format!("response id {id} is not ours"));
                };
                let result = match object.remove("error") {
                    Some(error) => Err(RpcError {
                        code: error["code"].as_i64().unwrap_or(0),
                        message: error["message"].as_str().unwrap_or_default().to_owned(),
                    }),
                    None => Ok(object.remove("result").unwrap_or(Value::Null)),
                };
                Inbound::Response { id, result }
            }
            (None, None) => Inbound::Invalid("no id and no method".into()),
        }
    }
}

pub fn request(id: u64, method: &str, params: Value) -> String {
    json!({"id": id, "method": method, "params": params}).to_string()
}

pub fn notification(method: &str) -> String {
    json!({ "method": method }).to_string()
}

pub fn reply(id: &Value, result: Value) -> String {
    json!({"id": id, "result": result}).to_string()
}

pub fn reply_error(id: &Value, code: i64, message: &str) -> String {
    json!({"id": id, "error": {"code": code, "message": message}}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_each_frame_kind() {
        assert_eq!(
            Inbound::decode(r#"{"id":4,"result":{"turn":{"id":"t"}}}"#),
            Inbound::Response {
                id: 4,
                result: Ok(json!({"turn": {"id": "t"}}))
            }
        );
        assert_eq!(
            Inbound::decode(r#"{"id":2,"error":{"code":-32600,"message":"Already initialized"}}"#),
            Inbound::Response {
                id: 2,
                result: Err(RpcError {
                    code: -32600,
                    message: "Already initialized".into()
                })
            }
        );
        assert_eq!(
            Inbound::decode(r#"{"method":"turn/started","params":{"threadId":"a"}}"#),
            Inbound::Notification {
                method: "turn/started".into(),
                params: json!({"threadId": "a"})
            }
        );
        assert_eq!(
            Inbound::decode(r#"{"method":"item/tool/requestUserInput","id":0,"params":{}}"#),
            Inbound::Request {
                id: json!(0),
                method: "item/tool/requestUserInput".into(),
                params: json!({})
            }
        );
        assert!(matches!(Inbound::decode("[1]"), Inbound::Invalid(_)));
        assert!(matches!(Inbound::decode("nope"), Inbound::Invalid(_)));
    }

    #[test]
    fn encodes_requests_and_replies() {
        assert_eq!(
            request(1, "initialize", json!({})),
            r#"{"id":1,"method":"initialize","params":{}}"#
        );
        assert_eq!(notification("initialized"), r#"{"method":"initialized"}"#);
        assert_eq!(
            reply(&json!(0), json!({"decision": "accept"})),
            r#"{"id":0,"result":{"decision":"accept"}}"#
        );
    }
}
