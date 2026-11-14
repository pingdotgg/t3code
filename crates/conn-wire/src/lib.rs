//! Effect RPC wire frames as Conn clients send and expect them over `/ws`.
//!
//! Source of truth: `effect` 4.1.3 (`.repos/effect` holds 4.1.2; the wire is the same):
//! - `packages/effect/src/rpc/RpcMessage.ts`: `FromClientEncoded`, `FromServerEncoded`,
//!   `ExitEncoded`.
//! - `packages/effect/src/rpc/RpcSerialization.ts` (`json`): one JSON value per WebSocket
//!   text message. A message that is a JSON array holds several frames.
//! - `packages/effect/src/rpc/RpcServer.ts` (`makeSocketProtocol`, `make`): one frame per
//!   message from the server, `Ping` answered with `Pong`, acks enabled.
//! - `packages/effect/src/rpc/RpcClient.ts`: numeric request ids from a counter, `Ack` after
//!   each `Chunk`, `Ping` every 5 s with a 5 s timeout.
//!
//! T3 adds two layers on top, both server-side choices the client depends on:
//! - frame parts (`packages/shared/src/socketFrameParts.ts`), see [`frame_parts`];
//! - an ack window (`apps/server/src/terminal/OutputProtocol.ts`), see [`ack_window`].
//!
//! This crate holds types and codecs only. Session logic belongs to the server.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A request id. The Effect client sends numbers (`requestIdCounter++`); strings are legal too.
/// Echo it back exactly as received.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

/// `RequestEncoded`. Clients send it to call a method; servers may send it for
/// server-originated requests (unused by T3 today).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: RequestId,
    /// The RPC method, such as `orchestration.subscribeShell`.
    pub tag: String,
    /// The method's payload, encoded by its contract schema.
    pub payload: Value,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// No reply of any kind is sent for a notification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_notification: Option<bool>,
    /// The server answers with a void `Success` exit once the handler starts, then nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discard: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampled: Option<bool>,
}

/// `FromClientEncoded`: every frame a client sends.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum FromClient {
    Request(Request),
    /// The client consumed one `Chunk` of a stream; the server may send the next.
    #[serde(rename_all = "camelCase")]
    Ack {
        request_id: RequestId,
    },
    /// Cancel an in-flight request. The server ends it with an `Interrupt` exit.
    #[serde(rename_all = "camelCase")]
    Interrupt {
        request_id: RequestId,
    },
    /// Keepalive. Answer with `Pong`.
    Ping,
    /// The client sends nothing more; end the connection once in-flight requests finish.
    Eof,
}

/// `FromServerEncoded`: every frame a server sends.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum FromServer {
    /// A non-empty batch of stream items for one request.
    #[serde(rename_all = "camelCase")]
    Chunk {
        request_id: RequestId,
        values: Vec<Value>,
    },
    /// The terminal frame of a request, unary or stream.
    #[serde(rename_all = "camelCase")]
    Exit {
        request_id: RequestId,
        exit: Exit,
    },
    /// A connection-level defect. The client fails every pending request with it.
    Defect {
        defect: Value,
    },
    Pong,
    /// Fails the listed requests, or all when `requestIds` is absent. Clients mostly create
    /// this locally; the decoder accepts it from the wire.
    #[serde(rename_all = "camelCase")]
    ClientProtocolError {
        error: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_ids: Option<Vec<RequestId>>,
    },
    /// A server-originated request.
    Request(Request),
}

/// `ExitEncoded`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Exit {
    Success { value: Value },
    Failure { cause: Vec<CauseReason> },
}

/// One reason inside a failed `Exit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum CauseReason {
    /// A typed failure, encoded by the method's error schema.
    Fail { error: Value },
    /// A defect, encoded by `Schema.Defect` (any JSON; `{name, message}` decodes to an `Error`).
    Die { defect: Value },
    #[serde(rename_all = "camelCase")]
    Interrupt { fiber_id: Option<i64> },
}

impl Exit {
    pub fn success(value: Value) -> Self {
        Exit::Success { value }
    }

    pub fn fail(error: Value) -> Self {
        Exit::Failure {
            cause: vec![CauseReason::Fail { error }],
        }
    }

    pub fn die(defect: Value) -> Self {
        Exit::Failure {
            cause: vec![CauseReason::Die { defect }],
        }
    }

    pub fn interrupt() -> Self {
        Exit::Failure {
            cause: vec![CauseReason::Interrupt { fiber_id: None }],
        }
    }
}

/// A defect the Effect client decodes into an `Error` with this name and message.
pub fn error_defect(name: &str, message: impl Into<String>) -> Value {
    serde_json::json!({ "name": name, "message": message.into() })
}

/// Decodes one WebSocket text message: a single frame or a JSON array of frames.
pub fn decode_client_message(text: &str) -> Result<Vec<FromClient>, serde_json::Error> {
    let value: Value = serde_json::from_str(text)?;
    match value {
        Value::Array(items) => items.into_iter().map(serde_json::from_value).collect(),
        single => Ok(vec![serde_json::from_value(single)?]),
    }
}

/// Encodes one server frame as one WebSocket text message.
pub fn encode_server_frame(frame: &FromServer) -> String {
    serde_json::to_string(frame).expect("wire frames always serialize")
}

/// T3 frame parts. When the `/ws` URL has the `frameParts` query param, the server splits
/// text messages larger than [`PART_BYTES`]: every part but the last starts with
/// [`PART_PREFIX`]; the client joins them. Splits never fall inside a UTF-8 sequence.
pub mod frame_parts {
    pub const QUERY_PARAM: &str = "frameParts";
    pub const PART_BYTES: usize = 48 * 1024;
    pub const PART_PREFIX: char = '\u{1e}';

    /// Splits one text message as `splitSocketFrame` does: every part, prefix included, is at
    /// most `part_bytes` of UTF-8, and only the last part has no prefix.
    pub fn split(frame: &str, part_bytes: usize) -> Vec<String> {
        if frame.len() <= part_bytes {
            return vec![frame.to_owned()];
        }
        let prefix = PART_PREFIX.len_utf8();
        let mut parts = Vec::with_capacity(frame.len() / part_bytes + 1);
        let mut start = 0;
        let mut bytes = prefix;
        for (index, ch) in frame.char_indices() {
            if bytes + ch.len_utf8() > part_bytes {
                let mut part = String::with_capacity(prefix + index - start);
                part.push(PART_PREFIX);
                part.push_str(&frame[start..index]);
                parts.push(part);
                start = index;
                bytes = prefix;
            }
            bytes += ch.len_utf8();
        }
        parts.push(frame[start..].to_owned());
        parts
    }

    /// Joins parts back into whole messages, as `joinSocketFrameParts` does on the client.
    /// Conn clients do not split what they send; this keeps the server tolerant and bounded.
    #[derive(Debug)]
    pub struct Joiner {
        pending: String,
        max_bytes: usize,
    }

    /// A joined message would exceed the limit. The connection should close with 1009.
    #[derive(Debug, PartialEq, Eq)]
    pub struct TooLarge;

    impl Joiner {
        pub fn new(max_bytes: usize) -> Self {
            Self {
                pending: String::new(),
                max_bytes,
            }
        }

        /// `Ok(Some(message))` once a message is whole, `Ok(None)` while parts are pending.
        pub fn push(&mut self, text: &str) -> Result<Option<String>, TooLarge> {
            let (body, more) = match text.strip_prefix(PART_PREFIX) {
                Some(body) => (body, true),
                None => (text, false),
            };
            if self.pending.len() + body.len() > self.max_bytes {
                self.pending = String::new();
                return Err(TooLarge);
            }
            if more {
                self.pending.push_str(body);
                return Ok(None);
            }
            if self.pending.is_empty() {
                return Ok(Some(body.to_owned()));
            }
            let mut whole = std::mem::take(&mut self.pending);
            whole.push_str(body);
            Ok(Some(whole))
        }
    }
}

/// T3 ack window. Effect's server waits for an `Ack` after every `Chunk`. T3 instead lets
/// some streams run ahead by up to [`MAX_PENDING_CHUNKS`] unacked chunks (terminal streams
/// also cap pending bytes). The client still sends one `Ack` per `Chunk`.
pub mod ack_window {
    pub const MAX_PENDING_CHUNKS: usize = 8;
    pub const MAX_PENDING_BYTES: usize = 64 * 1024;
    pub const COUNT_WINDOWED: &[&str] = &[
        "subscribeServerConfig",
        "orchestration.subscribeShell",
        "orchestration.subscribeThread",
    ];
    pub const BYTE_WINDOWED: &[&str] = &["terminal.attach", "terminal.observe"];
    /// T3 charges each value this much on top of its size, so tiny values still count.
    pub const VALUE_OVERHEAD_BYTES: usize = 128;

    /// How many chunks of a stream may be unacked at once.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Window {
        /// Effect's default: wait for the `Ack` of each chunk before the next.
        One,
        /// Up to [`MAX_PENDING_CHUNKS`] chunks.
        Count,
        /// Up to [`MAX_PENDING_CHUNKS`] chunks and [`MAX_PENDING_BYTES`].
        Bytes,
    }

    impl Window {
        pub fn for_tag(tag: &str) -> Self {
            if BYTE_WINDOWED.contains(&tag) {
                Window::Bytes
            } else if COUNT_WINDOWED.contains(&tag) {
                Window::Count
            } else {
                Window::One
            }
        }

        /// Whether a window holding these pending chunk sizes may not send another chunk.
        pub fn is_full(self, pending: &std::collections::VecDeque<usize>) -> bool {
            match self {
                Window::One => !pending.is_empty(),
                Window::Count => pending.len() >= MAX_PENDING_CHUNKS,
                Window::Bytes => {
                    pending.len() >= MAX_PENDING_CHUNKS
                        || pending.iter().sum::<usize>() >= MAX_PENDING_BYTES
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_every_client_frame_kind() {
        let text = r#"[
            {"_tag":"Request","id":0,"tag":"server.probe","payload":{},"headers":[]},
            {"_tag":"Request","id":"7","tag":"x","payload":null,"headers":[["a","b"]],
             "discard":true,"traceId":"t","spanId":"s","sampled":false},
            {"_tag":"Ack","requestId":3},
            {"_tag":"Interrupt","requestId":3},
            {"_tag":"Ping"},
            {"_tag":"Eof"}
        ]"#;
        let frames = decode_client_message(text).unwrap();
        assert_eq!(frames.len(), 6);
        let FromClient::Request(r) = &frames[0] else {
            panic!()
        };
        assert_eq!(r.id, RequestId::Number(0));
        assert_eq!(r.tag, "server.probe");
        let FromClient::Request(r) = &frames[1] else {
            panic!()
        };
        assert_eq!(r.id, RequestId::String("7".into()));
        assert_eq!(r.discard, Some(true));
        assert_eq!(r.headers, vec![("a".into(), "b".into())]);
        assert_eq!(
            frames[2],
            FromClient::Ack {
                request_id: RequestId::Number(3)
            }
        );
        assert_eq!(
            frames[3],
            FromClient::Interrupt {
                request_id: RequestId::Number(3)
            }
        );
        assert_eq!(frames[4], FromClient::Ping);
        assert_eq!(frames[5], FromClient::Eof);
        assert_eq!(
            decode_client_message(r#"{"_tag":"Ping"}"#).unwrap(),
            vec![FromClient::Ping]
        );
    }

    #[test]
    fn encodes_server_frames_like_effect() {
        let id = RequestId::Number(4);
        let cases = [
            (
                FromServer::Chunk {
                    request_id: id.clone(),
                    values: vec![json!({"kind":"synchronized"})],
                },
                json!({"_tag":"Chunk","requestId":4,"values":[{"kind":"synchronized"}]}),
            ),
            (
                FromServer::Exit {
                    request_id: id.clone(),
                    exit: Exit::success(json!({})),
                },
                json!({"_tag":"Exit","requestId":4,"exit":{"_tag":"Success","value":{}}}),
            ),
            (
                FromServer::Exit {
                    request_id: id.clone(),
                    exit: Exit::fail(json!({"_tag":"E"})),
                },
                json!({"_tag":"Exit","requestId":4,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"E"}}]}}),
            ),
            (
                FromServer::Exit {
                    request_id: id.clone(),
                    exit: Exit::die(error_defect("X", "boom")),
                },
                json!({"_tag":"Exit","requestId":4,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":{"name":"X","message":"boom"}}]}}),
            ),
            (
                FromServer::Exit {
                    request_id: id.clone(),
                    exit: Exit::interrupt(),
                },
                json!({"_tag":"Exit","requestId":4,"exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":null}]}}),
            ),
            (
                FromServer::Defect {
                    defect: json!("bad frame"),
                },
                json!({"_tag":"Defect","defect":"bad frame"}),
            ),
            (FromServer::Pong, json!({"_tag":"Pong"})),
            (
                FromServer::ClientProtocolError {
                    error: json!({"_tag":"RpcClientError"}),
                    request_ids: Some(vec![id]),
                },
                json!({"_tag":"ClientProtocolError","error":{"_tag":"RpcClientError"},"requestIds":[4]}),
            ),
        ];
        for (frame, expected) in cases {
            let text = encode_server_frame(&frame);
            assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), expected);
            assert_eq!(serde_json::from_str::<FromServer>(&text).unwrap(), frame);
        }
    }

    #[test]
    fn splits_frames_on_char_boundaries_and_joins_them() {
        use frame_parts::{Joiner, PART_PREFIX, TooLarge, split};
        assert_eq!(split("small", 8), vec!["small".to_owned()]);

        // 'é' is 2 bytes and '😀' 4: no part may cut either, and each part fits the limit.
        let frame = "aé😀".repeat(50);
        let parts = split(&frame, 16);
        assert!(parts.len() > 1);
        for part in &parts[..parts.len() - 1] {
            assert!(part.starts_with(PART_PREFIX));
            assert!(part.len() <= 16, "{} bytes", part.len());
        }
        assert!(!parts.last().unwrap().starts_with(PART_PREFIX));

        let mut joiner = Joiner::new(1 << 20);
        let mut joined = None;
        for part in &parts {
            joined = joiner.push(part).unwrap();
        }
        assert_eq!(joined.as_deref(), Some(frame.as_str()));
        assert_eq!(joiner.push("{}").unwrap().as_deref(), Some("{}"));

        let mut joiner = Joiner::new(8);
        assert_eq!(joiner.push("\u{1e}12345"), Ok(None));
        assert_eq!(joiner.push("6789"), Err(TooLarge));
        assert_eq!(joiner.push("ok").unwrap().as_deref(), Some("ok"));
    }

    #[test]
    fn rejects_unknown_tags() {
        assert!(decode_client_message(r#"{"_tag":"Nope"}"#).is_err());
    }
}
