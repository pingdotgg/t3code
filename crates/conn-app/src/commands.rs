//! Orchestration commands the app dispatches (`orchestration.dispatchCommand`), built as typed
//! `conn_contract::OrchestrationV2Command` values from their wire JSON.

use std::sync::atomic::{AtomicU64, Ordering};

use conn_contract::{ChatAttachment, OrchestrationV2Command, ProjectMutation};
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

/// `message.dispatch`: send `text` and `attachments` to `thread_id`. While a turn runs, the
/// message queues after it (Conn's default when you press Enter on a working thread).
pub(crate) fn send_message(
    thread_id: &str,
    text: &str,
    attachments: &[ChatAttachment],
    working: bool,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    let mode = if working {
        "queue_after_active"
    } else {
        "start_immediately"
    };
    let attachments_json: Vec<serde_json::Value> =
        attachments.iter().map(conn_contract::to_json).collect();
    conn_contract::from_json(json!({
        "type": "message.dispatch",
        "createdBy": "user",
        "creationSource": "web",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "messageId": new_id("msg"),
        "text": text,
        "attachments": attachments_json,
        "dispatchMode": { "type": mode },
    }))
}

/// A new thread id in the client's format.
pub(crate) fn new_thread_id() -> String {
    new_id("thread")
}

/// `orchestration.launchThread` payload: create `thread_id` in `project_id` and send `text`
/// and `attachments` as its first message (Conn's composer does the same for a new thread).
pub(crate) fn launch_thread_payload(
    thread_id: &str,
    project_id: &str,
    text: &str,
    attachments: &[ChatAttachment],
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
    let attachments_json: Vec<serde_json::Value> =
        attachments.iter().map(conn_contract::to_json).collect();
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
            "attachments": attachments_json,
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

/// `thread.model-selection.set`: switch the thread to `model` on provider `instance_id`,
/// optionally passing provider/model `options` (such as `{ "effort": "high" }`).
pub(crate) fn set_model_selection(
    thread_id: &str,
    instance_id: &str,
    model: &str,
    options: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    let mut selection = serde_json::Map::new();
    selection.insert("instanceId".to_owned(), json!(instance_id));
    selection.insert("model".to_owned(), json!(model));
    if let Some(opts) = options
        && !opts.is_empty()
    {
        selection.insert(
            "options".to_owned(),
            serde_json::Value::Object(opts.clone()),
        );
    }
    conn_contract::from_json(json!({
        "type": "thread.model-selection.set",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "modelSelection": serde_json::Value::Object(selection),
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

/// `thread.interaction-mode.set`: switch the thread between `"default"` and `"plan"`.
pub(crate) fn set_interaction_mode(
    thread_id: &str,
    interaction_mode: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.interaction-mode.set",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "interactionMode": interaction_mode,
    }))
}

/// `thread.runtime-mode.set`: switch the thread's runtime permission mode
/// (`"approval-required"`, `"auto-accept-edits"`, `"auto"`, `"full-access"`).
pub(crate) fn set_runtime_mode(
    thread_id: &str,
    runtime_mode: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.runtime-mode.set",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "runtimeMode": runtime_mode,
    }))
}

/// `thread.settle` / `thread.unsettle`: move a thread into or out of the Settled shelf.
pub(crate) fn settle_thread(
    thread_id: &str,
    settled: bool,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    if settled {
        conn_contract::from_json(json!({
            "type": "thread.settle",
            "commandId": new_id("cmd"),
            "threadId": thread_id,
        }))
    } else {
        conn_contract::from_json(json!({
            "type": "thread.unsettle",
            "commandId": new_id("cmd"),
            "threadId": thread_id,
            "reason": "user",
        }))
    }
}

/// `thread.metadata.update`: rename `thread_id` to `title`.
pub(crate) fn rename_thread(
    thread_id: &str,
    title: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.metadata.update",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "title": title,
    }))
}

/// `projects.mutate` (`project.create`): register a local workspace folder as a project.
pub(crate) fn create_project_mutation(
    workspace_root: &str,
    title: &str,
) -> Result<ProjectMutation, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "project.create",
        "commandId": new_id("cmd"),
        "projectId": new_id("proj"),
        "title": title,
        "workspaceRoot": workspace_root,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_decode_as_contract_types() {
        let sample_attachment = ChatAttachment::File(conn_contract::ChatFileAttachment {
            r#type: conn_contract::lit::File,
            id: "att-1".to_owned(),
            name: "notes.md".to_owned(),
            mime_type: "text/markdown".to_owned(),
            size_bytes: 128,
            source: None,
        });
        assert!(
            send_message("t1", "hi", &[], false).is_ok(),
            "message.dispatch decodes"
        );
        assert!(
            send_message("t1", "hi", &[sample_attachment], true).is_ok(),
            "queued dispatch with attachment decodes"
        );
        assert!(stop_thread("t1").is_ok(), "thread.stop decodes");
        assert!(
            set_model_selection("t1", "claudeAgent", "haiku", None).is_ok(),
            "thread.model-selection.set decodes"
        );
        let mut opts = serde_json::Map::new();
        opts.insert("effort".to_owned(), json!("high"));
        assert!(
            set_model_selection("t1", "claudeAgent", "sonnet", Some(&opts)).is_ok(),
            "thread.model-selection.set with effort option decodes"
        );
        assert!(
            respond_approval("t1", "r1", "accept").is_ok(),
            "runtime-request.respond decodes"
        );
        assert!(
            set_interaction_mode("t1", "plan").is_ok(),
            "thread.interaction-mode.set (plan) decodes"
        );
        assert!(
            set_interaction_mode("t1", "default").is_ok(),
            "thread.interaction-mode.set (default) decodes"
        );
        assert!(
            set_runtime_mode("t1", "full-access").is_ok(),
            "thread.runtime-mode.set (full-access) decodes"
        );
        assert!(
            set_runtime_mode("t1", "approval-required").is_ok(),
            "thread.runtime-mode.set (approval-required) decodes"
        );
        assert!(settle_thread("t1", true).is_ok(), "thread.settle decodes");
        assert!(
            settle_thread("t1", false).is_ok(),
            "thread.unsettle decodes"
        );
        assert!(
            rename_thread("t1", "New title").is_ok(),
            "thread.metadata.update decodes"
        );
        assert!(
            create_project_mutation("/tmp/demo", "demo").is_ok(),
            "project.create mutation decodes"
        );
    }

    #[test]
    fn launch_payload_decodes_as_contract_input() {
        let payload = launch_thread_payload(
            "t1",
            "p1",
            "hello\nworld",
            &[],
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
