//! Orchestration commands the app dispatches (`orchestration.dispatchCommand`), built as typed
//! `conn_contract::OrchestrationV2Command` values from their wire JSON.

use std::sync::atomic::{AtomicU64, Ordering};

use conn_contract::OrchestrationV2Command;
use serde_json::json;

/// A process-unique id with a prefix, such as `gpui-msg-1732150000000-3`.
fn new_id(kind: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("gpui-{kind}-{millis}-{n}")
}

/// `message.dispatch`: send `text` to `thread_id`. While a turn runs, the message queues
/// after it (Conn's default when you press Enter on a working thread).
pub(crate) fn send_message(
    thread_id: &str,
    text: &str,
    working: bool,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    let mode = if working {
        "queue_after_active"
    } else {
        "start_immediately"
    };
    conn_contract::from_json(json!({
        "type": "message.dispatch",
        "createdBy": "user",
        "creationSource": "web",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "messageId": new_id("msg"),
        "text": text,
        "attachments": [],
        "dispatchMode": { "type": mode },
    }))
}

/// A new thread id in the client's format.
pub(crate) fn new_thread_id() -> String {
    new_id("thread")
}

/// `orchestration.launchThread` payload: create `thread_id` in `project_id` and send `text`
/// as its first message (Conn's composer does the same for a new thread).
pub(crate) fn launch_thread_payload(
    thread_id: &str,
    project_id: &str,
    text: &str,
    model_selection: serde_json::Value,
    runtime_mode: &str,
    interaction_mode: &str,
) -> serde_json::Value {
    let title: String = text
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(80)
        .collect();
    json!({
        "commandId": new_id("cmd"),
        "creationSource": "web",
        "threadId": thread_id,
        "projectId": project_id,
        "title": title,
        "generateTitle": true,
        "modelSelection": model_selection,
        "runtimeMode": runtime_mode,
        "interactionMode": interaction_mode,
        "workspaceStrategy": { "type": "root" },
        "initialMessage": {
            "messageId": new_id("msg"),
            "text": text,
            "attachments": [],
        },
    })
}

/// `runtime-request.respond`: answer an approval with `decision` (`accept`,
/// `acceptForSession`, `decline`, `cancel`).
pub(crate) fn respond_approval(
    thread_id: &str,
    request_id: &str,
    decision: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "runtime-request.respond",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "requestId": request_id,
        "decision": decision,
    }))
}

/// `thread.model-selection.set`: switch the thread to `model` on provider `instance_id`.
pub(crate) fn set_model_selection(
    thread_id: &str,
    instance_id: &str,
    model: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.model-selection.set",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "modelSelection": { "instanceId": instance_id, "model": model },
    }))
}

/// `thread.stop`: stop the running turn.
pub(crate) fn stop_thread(thread_id: &str) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.stop",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_decode_as_contract_types() {
        assert!(
            send_message("t1", "hi", false).is_ok(),
            "message.dispatch decodes"
        );
        assert!(
            send_message("t1", "hi", true).is_ok(),
            "queued dispatch decodes"
        );
        assert!(stop_thread("t1").is_ok(), "thread.stop decodes");
        assert!(
            set_model_selection("t1", "claudeAgent", "haiku").is_ok(),
            "thread.model-selection.set decodes"
        );
        assert!(
            respond_approval("t1", "r1", "accept").is_ok(),
            "runtime-request.respond decodes"
        );
    }

    #[test]
    fn launch_payload_decodes_as_contract_input() {
        let payload = launch_thread_payload(
            "t1",
            "p1",
            "hello\nworld",
            json!({"instanceId": "claudeAgent", "model": "haiku"}),
            "full-access",
            "default",
        );
        let decoded: Result<conn_contract::OrchestrationV2ThreadLaunchInput, _> =
            conn_contract::from_json(payload);
        assert!(decoded.is_ok(), "launchThread input decodes: {decoded:?}");
    }

    #[test]
    fn ids_are_unique() {
        assert_ne!(new_id("x"), new_id("x"), "ids differ");
    }
}
