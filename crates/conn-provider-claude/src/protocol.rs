//! The messages the Agent SDK yields (the CLI's stream-JSON messages, which the SDK passes
//! through), and the CLI control-request shapes the mapper reads and answers. The session turns
//! SDK callbacks into those control requests and the mapper's answers back into callback
//! results (`session::callback_request`, `session::callback_answer`).
//!
//! Every inbound line decodes to [`Inbound`]. Known kinds are typed with lenient structs
//! (unknown fields ignored, most fields optional). A kind we do not know, or a known kind whose
//! shape changed, becomes [`Inbound::Other`] with the raw JSON, so a new CLI message is logged
//! and skipped instead of failing the session.

use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
#[expect(clippy::large_enum_variant, reason = "one per stdout line, moved once")]
pub enum Inbound {
    /// Answer to a request we sent.
    ControlResponse {
        request_id: String,
        result: Result<Value, String>,
    },
    /// The CLI asks us something (permission, hook, dialog, elicitation).
    ControlRequest {
        request_id: String,
        request: ControlRequest,
    },
    /// The CLI withdraws a request it sent.
    ControlCancel {
        request_id: String,
    },
    System(SystemMsg),
    StreamEvent(StreamEventMsg),
    Assistant(AssistantMsg),
    User(UserMsg),
    Result(ResultMsg),
    /// `command_lifecycle`: a prompt we wrote was queued, started, completed or cancelled.
    CommandLifecycle {
        command_uuid: String,
        state: String,
    },
    /// `rate_limit_event`: the account's usage window.
    RateLimit(Value),
    /// Swallowed like the SDK does (`keep_alive`, `transcript_mirror`, ...).
    Ignored(String),
    /// Unknown kind or a shape we could not read. `kind` is the `type` field.
    Other {
        kind: String,
        raw: Value,
    },
}

impl Inbound {
    /// Decodes one line of JSON text. Never fails: unreadable input becomes `Other`.
    pub fn decode(line: &str) -> Inbound {
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                return Inbound::Other {
                    kind: "_unparsed".into(),
                    raw: Value::String(truncate(line, 512)),
                };
            }
        };
        Self::from_value(value)
    }

    pub fn from_value(value: Value) -> Inbound {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let typed = match kind.as_str() {
            "control_response" => decode_control_response(&value),
            "control_request" => decode_control_request(&value),
            "control_cancel_request" => {
                value
                    .get("request_id")
                    .and_then(Value::as_str)
                    .map(|id| Inbound::ControlCancel {
                        request_id: id.into(),
                    })
            }
            "system" => Deserialize::deserialize(&value).ok().map(Inbound::System),
            "stream_event" => Deserialize::deserialize(&value)
                .ok()
                .map(Inbound::StreamEvent),
            "assistant" => Deserialize::deserialize(&value)
                .ok()
                .map(Inbound::Assistant),
            "user" => Deserialize::deserialize(&value).ok().map(Inbound::User),
            "result" => Deserialize::deserialize(&value).ok().map(Inbound::Result),
            "command_lifecycle" => Some(Inbound::CommandLifecycle {
                command_uuid: str_field(&value, "command_uuid"),
                state: str_field(&value, "state"),
            }),
            "rate_limit_event" => Some(Inbound::RateLimit(
                value.get("rate_limit_info").cloned().unwrap_or(Value::Null),
            )),
            "keep_alive" | "transcript_mirror" | "prompt_suggestion" | "active_goal"
            | "autocompact_state" => Some(Inbound::Ignored(kind.clone())),
            _ => None,
        };
        typed.unwrap_or(Inbound::Other { kind, raw: value })
    }
}

fn decode_control_response(value: &Value) -> Option<Inbound> {
    let response = value.get("response")?;
    let request_id = response.get("request_id")?.as_str()?.to_string();
    let result = if response.get("subtype").and_then(Value::as_str) == Some("success") {
        Ok(response.get("response").cloned().unwrap_or(Value::Null))
    } else {
        Err(match response.get("error") {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => "control request failed".into(),
        })
    };
    Some(Inbound::ControlResponse { request_id, result })
}

fn decode_control_request(value: &Value) -> Option<Inbound> {
    let request_id = value.get("request_id")?.as_str()?.to_string();
    let body = value.get("request")?;
    let subtype = body.get("subtype").and_then(Value::as_str).unwrap_or("");
    let request = match subtype {
        "can_use_tool" => Deserialize::deserialize(body)
            .ok()
            .map(ControlRequest::CanUseTool),
        "hook_callback" => Some(ControlRequest::HookCallback {
            callback_id: str_field(body, "callback_id"),
        }),
        "elicitation" => Deserialize::deserialize(body)
            .ok()
            .map(ControlRequest::Elicitation),
        "request_user_dialog" => Deserialize::deserialize(body)
            .ok()
            .map(ControlRequest::UserDialog),
        _ => None,
    }
    .unwrap_or_else(|| ControlRequest::Other {
        subtype: subtype.to_string(),
    });
    Some(Inbound::ControlRequest {
        request_id,
        request,
    })
}

fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[derive(Debug, Clone, PartialEq)]
pub enum ControlRequest {
    CanUseTool(CanUseTool),
    HookCallback {
        callback_id: String,
    },
    Elicitation(Elicitation),
    UserDialog(UserDialog),
    /// `mcp_message`, `oauth_token_refresh`, ...: answered with an error, as the SDK does
    /// when it has no handler.
    Other {
        subtype: String,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CanUseTool {
    pub tool_name: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub tool_use_id: String,
    #[serde(default)]
    pub permission_suggestions: Option<Value>,
    #[serde(default)]
    pub decision_reason: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub blocked_path: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Elicitation {
    #[serde(default)]
    pub mcp_server_name: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub requested_schema: Option<Value>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UserDialog {
    #[serde(default)]
    pub dialog_kind: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SystemMsg {
    pub subtype: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub uuid: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "permissionMode")]
    pub permission_mode: Option<String>,
    /// `status` subtype: `"requesting"`, `"compacting"`, or null.
    #[serde(default)]
    pub status: Option<Value>,
    #[serde(default)]
    pub compact_result: Option<String>,
    #[serde(default)]
    pub compact_metadata: Option<Value>,
    /// `api_retry`.
    #[serde(default)]
    pub attempt: Option<f64>,
    #[serde(default)]
    pub max_retries: Option<f64>,
    #[serde(default)]
    pub retry_delay_ms: Option<f64>,
    #[serde(default)]
    pub error_status: Option<f64>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub compact_error: Option<String>,
    /// `informational`.
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub content: Option<Value>,
    /// `task_started`, `task_progress`, `task_notification`.
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub task_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub is_backgrounded: Option<bool>,
    /// `task_started`: the subagent task whose own background work this is (undeclared).
    #[serde(default)]
    pub parent_task_id: Option<Value>,
    /// `thinking_tokens`: the prompt it thinks about.
    #[serde(default)]
    pub user_message_uuid: Option<String>,
    /// `task_started`: 1 for the root's subagents, more for nested ones.
    #[serde(default)]
    pub spawn_depth: Option<f64>,
    /// `background_tasks_changed`: the CLI's whole roster.
    #[serde(default)]
    pub tasks: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StreamEventMsg {
    pub event: StreamEvent,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub user_message_uuids: Option<Vec<String>>,
    #[serde(default)]
    pub user_message_uuid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    MessageStart {
        message: StreamMessage,
    },
    MessageDelta {
        #[serde(default)]
        usage: Option<UsageDelta>,
    },
    MessageStop,
    ContentBlockStart {
        index: u32,
        content_block: Block,
    },
    ContentBlockDelta {
        index: u32,
        delta: Delta,
    },
    ContentBlockStop {
        index: u32,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StreamMessage {
    pub id: String,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Delta {
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        #[serde(default)]
        thinking: String,
    },
    #[serde(other)]
    Other,
}

/// A content block in an assistant snapshot, a stream start, or a user message.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        #[serde(default)]
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_creation: Option<CacheCreation>,
    #[serde(default)]
    pub output_tokens_details: Option<OutputTokensDetails>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct OutputTokensDetails {
    #[serde(default)]
    pub thinking_tokens: Option<u64>,
}

impl Usage {
    /// Field-wise sum, for a turn made of several API segments.
    pub fn plus(&self, other: &Usage) -> Usage {
        let add = |a: Option<u64>, b: Option<u64>| match (a, b) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
        let thinking = |u: &Usage| {
            u.output_tokens_details
                .as_ref()
                .and_then(|d| d.thinking_tokens)
        };
        Usage {
            input_tokens: self.input_tokens + other.input_tokens,
            output_tokens: self.output_tokens + other.output_tokens,
            cache_creation_input_tokens: add(
                self.cache_creation_input_tokens,
                other.cache_creation_input_tokens,
            ),
            cache_read_input_tokens: add(
                self.cache_read_input_tokens,
                other.cache_read_input_tokens,
            ),
            cache_creation: None,
            output_tokens_details: Some(OutputTokensDetails {
                thinking_tokens: add(thinking(self), thinking(other)),
            }),
        }
    }

    /// `claudeMessageInputTokens`: fresh + cache-creation + cache-read input.
    pub fn input_total(&self) -> u64 {
        self.input_tokens
            + self.cache_creation_input_tokens.unwrap_or(0)
            + self.cache_read_input_tokens.unwrap_or(0)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CacheCreation {
    #[serde(default)]
    pub ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    pub ephemeral_1h_input_tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct UsageDelta {
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AssistantMsg {
    pub message: AssistantBody,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub uuid: String,
    /// `authentication_failed`, `rate_limit`, ... on CLI-made `<synthetic>` messages.
    #[serde(default)]
    pub error: Option<String>,
    /// Carries `rate_limit_info` on a blocked response.
    #[serde(default)]
    pub api_error_params: Option<Value>,
    /// The prompts this frame answers.
    #[serde(default)]
    pub user_message_uuids: Option<Vec<String>>,
    #[serde(default)]
    pub user_message_uuid: Option<String>,
    /// Per MCP `tool_use`: `id`, `display_name`, `server_display_name`, `icon_url`.
    #[serde(default)]
    pub tool_use_meta: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AssistantBody {
    pub id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub content: Vec<Block>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UserMsg {
    pub message: UserBody,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub uuid: Option<String>,
    /// The structured tool result (stdout/stderr, file patch, or an error string).
    #[serde(default)]
    pub tool_use_result: Option<Value>,
    #[serde(default)]
    pub tool_result_meta: Option<Vec<ToolResultMeta>>,
    #[serde(default, rename = "isReplay")]
    pub is_replay: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UserBody {
    #[serde(default)]
    pub content: UserContent,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Blocks(Vec<Block>),
}

impl Default for UserContent {
    fn default() -> Self {
        UserContent::Blocks(Vec::new())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ToolResultMeta {
    pub id: String,
    #[serde(default)]
    pub non_execution_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ResultMsg {
    #[serde(default)]
    pub subtype: String,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub errors: Option<Vec<String>>,
    #[serde(default)]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub terminal_reason: Option<String>,
    #[serde(default)]
    pub api_error_status: Option<u32>,
    #[serde(default)]
    pub num_turns: Option<u32>,
    #[serde(default, rename = "modelUsage")]
    pub model_usage: Option<Value>,
    #[serde(default)]
    pub user_message_uuids: Option<Vec<String>>,
    #[serde(default)]
    pub user_message_uuid: Option<String>,
    /// Who started the turn: `{"kind": "human" | "task-notification" | ...}`.
    #[serde(default)]
    pub origin: Option<Value>,
}

// ---- Host → CLI ----

/// How the CLI takes a user message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Starts a turn.
    Turn,
    /// `priority: "now"`: steers the running turn.
    Steer,
}

/// A user message (`SDKUserMessage`), as T3's `claudeUserMessage` builds it. `content` is a
/// string, or blocks when the message carries images.
pub fn user_message_value(content: Value, uuid: &str, delivery: Delivery) -> Value {
    let mut message = json!({
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": null,
        "uuid": uuid,
    });
    if delivery == Delivery::Steer {
        message["priority"] = json!("now");
    }
    message
}

pub fn control_success(request_id: &str, response: Value) -> String {
    json!({"type": "control_response", "response": {
        "subtype": "success", "request_id": request_id, "response": response,
    }})
    .to_string()
}

pub fn control_error(request_id: &str, error: &str) -> String {
    json!({"type": "control_response", "response": {
        "subtype": "error", "request_id": request_id, "error": error,
    }})
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_and_changed_kinds_fall_back_to_json() {
        let unknown = Inbound::decode(r#"{"type":"brand_new","x":1}"#);
        assert!(matches!(unknown, Inbound::Other { ref kind, .. } if kind == "brand_new"));
        // A known kind with a broken shape is kept as raw JSON, not an error.
        let broken = Inbound::decode(r#"{"type":"assistant","message":"nope"}"#);
        assert!(matches!(broken, Inbound::Other { ref kind, .. } if kind == "assistant"));
        let garbage = Inbound::decode("not json");
        assert!(matches!(garbage, Inbound::Other { ref kind, .. } if kind == "_unparsed"));
        assert_eq!(
            Inbound::decode(r#"{"type":"keep_alive"}"#),
            Inbound::Ignored("keep_alive".into())
        );
        let unknown_event =
            Inbound::decode(r#"{"type":"stream_event","event":{"type":"brand_new_event"}}"#);
        assert!(matches!(
            unknown_event,
            Inbound::StreamEvent(StreamEventMsg {
                event: StreamEvent::Other,
                ..
            })
        ));
    }

    #[test]
    fn decodes_control_traffic() {
        let ok = Inbound::decode(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"mode":"plan"}}}"#,
        );
        assert_eq!(
            ok,
            Inbound::ControlResponse {
                request_id: "r1".into(),
                result: Ok(json!({"mode": "plan"}))
            }
        );
        let err = Inbound::decode(
            r#"{"type":"control_response","response":{"subtype":"error","request_id":"r2","error":"bad"}}"#,
        );
        assert_eq!(
            err,
            Inbound::ControlResponse {
                request_id: "r2".into(),
                result: Err("bad".into())
            }
        );
        let other = Inbound::decode(
            r#"{"type":"control_request","request_id":"x","request":{"subtype":"mcp_message"}}"#,
        );
        assert_eq!(
            other,
            Inbound::ControlRequest {
                request_id: "x".into(),
                request: ControlRequest::Other {
                    subtype: "mcp_message".into()
                }
            }
        );
        assert_eq!(
            Inbound::decode(r#"{"type":"control_cancel_request","request_id":"x"}"#),
            Inbound::ControlCancel {
                request_id: "x".into()
            }
        );
    }

    #[test]
    fn every_recorded_line_decodes_to_a_known_kind() {
        for (name, text) in crate::testdata::cli_transcripts() {
            for line in text.lines() {
                let record: Value = serde_json::from_str(line).unwrap();
                if record["dir"] != "in" {
                    continue;
                }
                if let Inbound::Other { kind, raw } = Inbound::from_value(record["msg"].clone()) {
                    panic!(
                        "{name}: undecoded {kind}: {}",
                        truncate(&raw.to_string(), 300)
                    );
                }
            }
        }
    }
}
