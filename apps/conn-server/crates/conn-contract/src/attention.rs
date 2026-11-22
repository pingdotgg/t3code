//! The event a Conn Server reports to the Orbit Gateway when a thread needs the user, or no
//! longer does (nckrtl/conn#229, section 1). Orbit sends the iOS push; the server only
//! reports. The Gateway takes it at `POST /api/v1/conn/managed/attention` (container servers)
//! or `POST /api/v1/conn/environments/{environment}/attention` (native servers), answers 200
//! for a new or a repeated `event_id`, and 429 when the server must retry later.
//!
//! The thread title is the only content: no message text, prompt, tool argument or path.

use serde::{Deserialize, Serialize};

/// The version of [`ConnAttentionEvent`]. A change to the body's shape raises it, and the
/// Gateway route that takes the new shape changes with it.
pub const CONN_ATTENTION_EVENT_VERSION: u32 = 1;

/// The longest `thread_title`, in characters.
pub const CONN_ATTENTION_TITLE_MAX_CHARS: usize = 64;

/// Why a thread needs the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnAttentionKind {
    /// A pending approval request.
    Approval,
    /// A pending question, or a pending secret only the user can give.
    Input,
    /// The latest run of an idle thread completed.
    TurnFinished,
    /// The latest run failed.
    TurnFailed,
}

impl ConnAttentionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approval => "approval",
            Self::Input => "input",
            Self::TurnFinished => "turn_finished",
            Self::TurnFailed => "turn_failed",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "approval" => Self::Approval,
            "input" => Self::Input,
            "turn_finished" => Self::TurnFinished,
            "turn_failed" => Self::TurnFailed,
            _ => return None,
        })
    }
}

/// `attention` raises a notification; `attention_cleared` removes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnAttentionEventType {
    Attention,
    AttentionCleared,
}

impl ConnAttentionEventType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attention => "attention",
            Self::AttentionCleared => "attention_cleared",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "attention" => Some(Self::Attention),
            "attention_cleared" => Some(Self::AttentionCleared),
            _ => None,
        }
    }
}

/// The body of one attention call, version [`CONN_ATTENTION_EVENT_VERSION`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnAttentionEvent {
    /// A ULID. The Gateway stores it with a unique index, so a repeat is a no-op.
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: ConnAttentionEventType,
    /// Set for `attention`; null for `attention_cleared`.
    pub kind: Option<ConnAttentionKind>,
    pub environment_id: String,
    pub thread_id: String,
    /// The pending request, when the event is about one.
    pub request_id: Option<String>,
    /// RFC 3339.
    pub occurred_at: String,
    /// At most [`CONN_ATTENTION_TITLE_MAX_CHARS`] characters.
    pub thread_title: Option<String>,
}

/// `title` cut to [`CONN_ATTENTION_TITLE_MAX_CHARS`] characters; none when it is blank.
pub fn attention_title(title: &str) -> Option<String> {
    let title = title.trim();
    (!title.is_empty()).then(|| title.chars().take(CONN_ATTENTION_TITLE_MAX_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_body_has_the_gateway_contract_shape() {
        let event = ConnAttentionEvent {
            event_id: "01JDZ0000000000000000000AA".into(),
            event_type: ConnAttentionEventType::Attention,
            kind: Some(ConnAttentionKind::TurnFinished),
            environment_id: "env".into(),
            thread_id: "thread".into(),
            request_id: None,
            occurred_at: "2026-11-22T10:00:00.000Z".into(),
            thread_title: Some("Fix it".into()),
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "event_id": "01JDZ0000000000000000000AA",
                "type": "attention",
                "kind": "turn_finished",
                "environment_id": "env",
                "thread_id": "thread",
                "request_id": null,
                "occurred_at": "2026-11-22T10:00:00.000Z",
                "thread_title": "Fix it",
            })
        );
        let cleared = ConnAttentionEvent {
            event_type: ConnAttentionEventType::AttentionCleared,
            kind: None,
            request_id: Some("req".into()),
            thread_title: None,
            ..event
        };
        let value = serde_json::to_value(&cleared).unwrap();
        assert_eq!(value["type"], "attention_cleared");
        assert_eq!(value["kind"], json!(null));
        assert_eq!(value["request_id"], "req");
        assert_eq!(
            serde_json::from_value::<ConnAttentionEvent>(value).unwrap(),
            cleared
        );
    }

    #[test]
    fn kinds_round_trip_their_wire_names() {
        for kind in [
            ConnAttentionKind::Approval,
            ConnAttentionKind::Input,
            ConnAttentionKind::TurnFinished,
            ConnAttentionKind::TurnFailed,
        ] {
            assert_eq!(ConnAttentionKind::parse(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        assert_eq!(ConnAttentionKind::parse("completion"), None);
    }

    #[test]
    fn titles_are_cut_by_characters() {
        let long = "é".repeat(80);
        assert_eq!(attention_title(&long).unwrap().chars().count(), 64);
        assert_eq!(attention_title("  "), None);
        assert_eq!(attention_title(" Fix ").as_deref(), Some("Fix"));
    }
}
