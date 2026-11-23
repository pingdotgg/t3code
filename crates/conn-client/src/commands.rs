//! Orchestration commands dispatched via `orchestration.dispatchCommand`, built as typed
//! [`conn_contract::OrchestrationV2Command`] values from their wire JSON.

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
/// message steers it when `steer_target_run_id` is set, else queues after it.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn send_message(
    thread_id: &str,
    text: &str,
    attachments: &[ChatAttachment],
    working: bool,
    steer_target_run_id: Option<&str>,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    let dispatch_mode = match steer_target_run_id {
        Some(target) if working => json!({ "type": "steer_active", "targetRunId": target }),
        _ if working => json!({ "type": "queue_after_active" }),
        _ => json!({ "type": "start_immediately" }),
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
        "dispatchMode": dispatch_mode,
    }))
}

/// A new thread id in the client's format.
#[must_use]
pub fn new_thread_id() -> String {
    new_id("thread")
}

/// Workspace preparation mode chosen for a new thread draft.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WorkspaceStrategyChoice {
    /// Run directly in the project's local checkout (`workspaceStrategy: { type: "root" }`).
    #[default]
    Local,
    /// Create a fresh git worktree from `HEAD` (`workspaceStrategy: { type: "worktree", baseRef: "HEAD" }`).
    Worktree,
}

/// `orchestration.launchThread` payload: create `thread_id` in `project_id` and send `text`
/// and `attachments` as its first message (Conn's composer does the same for a new thread).
#[expect(
    clippy::too_many_arguments,
    reason = "maps directly to OrchestrationV2ThreadLaunchInput wire fields"
)]
#[must_use]
pub fn launch_thread_payload(
    thread_id: &str,
    project_id: &str,
    text: &str,
    attachments: &[ChatAttachment],
    model_selection: serde_json::Value,
    runtime_mode: &str,
    interaction_mode: &str,
    workspace_strategy: WorkspaceStrategyChoice,
) -> serde_json::Value {
    let first_line: String = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("New thread")
        .chars()
        .take(80)
        .collect();
    let title = if first_line.is_empty() {
        "New thread".to_owned()
    } else {
        first_line
    };
    let attachments_json: Vec<serde_json::Value> =
        attachments.iter().map(conn_contract::to_json).collect();
    let strategy_json = match workspace_strategy {
        WorkspaceStrategyChoice::Local => json!({ "type": "root" }),
        WorkspaceStrategyChoice::Worktree => json!({ "type": "worktree", "baseRef": "HEAD" }),
    };
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
        "workspaceStrategy": strategy_json,
        "initialMessage": {
            "messageId": new_id("msg"),
            "text": text,
            "attachments": attachments_json,
        },
    })
}

/// Extracts a concise human-readable message from a [`crate::ClientError`].
#[must_use]
pub fn format_client_error(err: &crate::ClientError) -> String {
    match err {
        crate::ClientError::Rpc(val) => extract_rpc_message(val).unwrap_or_else(|| val.to_string()),
        other => other.to_string(),
    }
}

fn extract_rpc_message(val: &serde_json::Value) -> Option<String> {
    if let Some(msg) = val.get("detail").and_then(serde_json::Value::as_str)
        && !msg.trim().is_empty()
    {
        return Some(msg.trim().to_owned());
    }
    if let Some(msg) = val.get("message").and_then(serde_json::Value::as_str)
        && !msg.trim().is_empty()
    {
        return Some(msg.trim().to_owned());
    }
    if let Some(reasons) = val.get("reasons").and_then(serde_json::Value::as_array) {
        for reason in reasons {
            if let Some(err) = reason.get("error").and_then(extract_rpc_message) {
                return Some(err);
            }
            if let Some(defect) = reason.get("defect") {
                if let Some(msg) = extract_rpc_message(defect) {
                    return Some(msg);
                }
                if let Some(s) = defect.as_str()
                    && !s.trim().is_empty()
                {
                    return Some(s.trim().to_owned());
                }
            }
        }
    }
    None
}

/// `runtime-request.respond`: answer an approval with `decision` (`accept`,
/// `acceptForSession`, `decline`, `cancel`).
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn respond_approval(
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

/// `runtime-request.respond`: answer a `user_input_request` with `answers` keyed by question id
/// (each a string or a string array), as Conn's `ComposerPendingUserInputPanel` submits them.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn respond_user_input(
    thread_id: &str,
    request_id: &str,
    answers: &serde_json::Map<String, serde_json::Value>,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "runtime-request.respond",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "requestId": request_id,
        "answers": serde_json::Value::Object(answers.clone()),
    }))
}

/// `thread.user-input.dismiss`: dismiss a message-mode question without answering it.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn dismiss_user_input(
    thread_id: &str,
    request_id: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.user-input.dismiss",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "requestId": request_id,
    }))
}

/// `thread.fork`: fork `source_thread_id` at run `run_id` into the new `target_thread_id`
/// (Conn's `Fork from this response`, `forkThreadFromRun`).
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn fork_thread_from_run(
    source_thread_id: &str,
    target_thread_id: &str,
    run_id: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.fork",
        "commandId": new_id("cmd"),
        "createdBy": "user",
        "creationSource": "web",
        "sourceThreadId": source_thread_id,
        "targetThreadId": target_thread_id,
        "sourcePoint": { "type": "run", "runId": run_id },
    }))
}

/// RPC tag for answering a secret request.
pub const SECRETS_ANSWER_REQUEST: &str = "secrets.answerRequest";

/// `secrets.answerRequest` payload: save the trimmed `secret` (`Some`) or decline (`None`) for
/// the secret request turn item `turn_item_id` (`secretRequestAnswerInput`). Returns `None`
/// when a save has only whitespace.
#[must_use]
pub fn secret_answer_payload(
    thread_id: &str,
    turn_item_id: &str,
    secret: Option<&str>,
) -> Option<serde_json::Value> {
    let answer = match secret {
        None => json!({ "type": "decline" }),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            json!({ "type": "save", "secret": trimmed })
        }
    };
    Some(json!({
        "threadId": thread_id,
        "turnItemId": turn_item_id,
        "answer": answer,
    }))
}

/// `thread.model-selection.set`: switch the thread to `model` on provider `instance_id`,
/// optionally passing provider/model `options` (such as `{ "effort": "high" }`).
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn set_model_selection(
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
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn stop_thread(thread_id: &str) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.stop",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
    }))
}

/// `queued-message.promote-to-steer`: promote a queued run into the currently active turn (`Send now`).
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn promote_queued_to_steer(
    thread_id: &str,
    queued_run_id: &str,
    target_run_id: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "queued-message.promote-to-steer",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "queuedRunId": queued_run_id,
        "targetRunId": target_run_id,
    }))
}

/// `queued-run.start`: start a queued run immediately when the thread has no active turn (`Send now`).
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn start_queued_run(
    thread_id: &str,
    run_id: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "queued-run.start",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "runId": run_id,
    }))
}

/// `queued-run.edit`: update the text (and optional attachments) of a queued run.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn edit_queued_run(
    thread_id: &str,
    run_id: &str,
    text: &str,
    attachments: Option<&[ChatAttachment]>,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    let mut payload = serde_json::Map::new();
    payload.insert("type".to_owned(), json!("queued-run.edit"));
    payload.insert("commandId".to_owned(), json!(new_id("cmd")));
    payload.insert("threadId".to_owned(), json!(thread_id));
    payload.insert("runId".to_owned(), json!(run_id));
    payload.insert("text".to_owned(), json!(text));
    if let Some(atts) = attachments {
        let atts_json: Vec<serde_json::Value> = atts.iter().map(conn_contract::to_json).collect();
        payload.insert(
            "attachments".to_owned(),
            serde_json::Value::Array(atts_json),
        );
    }
    conn_contract::from_json(serde_json::Value::Object(payload))
}

/// `queued-run.cancel`: remove a queued run from the queue.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn cancel_queued_run(
    thread_id: &str,
    run_id: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "queued-run.cancel",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "runId": run_id,
    }))
}

/// `thread.interaction-mode.set`: switch the thread between `"default"` and `"plan"`.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn set_interaction_mode(
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
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn set_runtime_mode(
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
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn settle_thread(
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
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn rename_thread(
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

/// `thread.metadata.update` with `regenerateTitle: true`: ask the server to regenerate the
/// thread title (Conn's `Regenerate title` thread action).
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn regenerate_thread_title(
    thread_id: &str,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.metadata.update",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
        "regenerateTitle": true,
    }))
}

/// `thread.pin` / `thread.unpin`: move a thread into or out of the Pinned section.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn pin_thread(
    thread_id: &str,
    pinned: bool,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    let kind = if pinned { "thread.pin" } else { "thread.unpin" };
    conn_contract::from_json(json!({
        "type": kind,
        "commandId": new_id("cmd"),
        "threadId": thread_id,
    }))
}

/// `thread.mark-unread`: clear the thread's visit marker so it shows as unseen again.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn mark_thread_unread(thread_id: &str) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.mark-unread",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
    }))
}

/// `thread.delete`: permanently delete a thread and its conversation history.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the command payload cannot be decoded as
/// [`OrchestrationV2Command`].
pub fn delete_thread(thread_id: &str) -> Result<OrchestrationV2Command, serde_json::Error> {
    conn_contract::from_json(json!({
        "type": "thread.delete",
        "commandId": new_id("cmd"),
        "threadId": thread_id,
    }))
}

/// `projects.mutate` (`project.create`): register a local workspace folder as a project.
///
/// # Errors
///
/// Returns [`serde_json::Error`] if the mutation payload cannot be decoded as
/// [`ProjectMutation`].
pub fn create_project_mutation(
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
            send_message("t1", "hi", &[], false, None).is_ok(),
            "message.dispatch decodes"
        );
        assert!(
            send_message(
                "t1",
                "hi",
                std::slice::from_ref(&sample_attachment),
                true,
                None
            )
            .is_ok(),
            "queued dispatch with attachment decodes"
        );
        assert!(
            send_message("t1", "hi", &[], true, Some("run-active")).is_ok(),
            "steer_active dispatch decodes"
        );
        assert!(stop_thread("t1").is_ok(), "thread.stop decodes");
        assert!(
            promote_queued_to_steer("t1", "run-q1", "run-active").is_ok(),
            "queued-message.promote-to-steer decodes"
        );
        assert!(
            start_queued_run("t1", "run-q1").is_ok(),
            "queued-run.start decodes"
        );
        assert!(
            edit_queued_run("t1", "run-q1", "updated text", None).is_ok(),
            "queued-run.edit without attachments decodes"
        );
        assert!(
            edit_queued_run("t1", "run-q1", "updated text", Some(&[sample_attachment])).is_ok(),
            "queued-run.edit with attachments decodes"
        );
        assert!(
            cancel_queued_run("t1", "run-q1").is_ok(),
            "queued-run.cancel decodes"
        );
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
        let mut answers = serde_json::Map::new();
        answers.insert("q1".to_owned(), json!("golang"));
        answers.insert("q2".to_owned(), json!(["fmt", "clippy"]));
        assert!(
            respond_user_input("t1", "r1", &answers).is_ok(),
            "runtime-request.respond with answers decodes"
        );
        assert!(
            dismiss_user_input("t1", "r1").is_ok(),
            "thread.user-input.dismiss decodes"
        );
        assert!(
            fork_thread_from_run("t1", "t2", "run-1").is_ok(),
            "thread.fork from run decodes"
        );
        for secret in [Some("  ghp_abc  "), None] {
            let payload = secret_answer_payload("t1", "item-secret", secret);
            let decoded =
                payload.map(conn_contract::from_json::<conn_contract::SecretRequestAnswerInput>);
            assert!(
                matches!(decoded, Some(Ok(_))),
                "secrets.answerRequest payload decodes for {secret:?}"
            );
        }
        assert_eq!(
            secret_answer_payload("t1", "item-secret", Some("ghp_abc  "))
                .and_then(|p| p["answer"]["secret"].as_str().map(str::to_owned)),
            Some("ghp_abc".to_owned()),
            "saved secret is trimmed"
        );
        assert!(
            secret_answer_payload("t1", "item-secret", Some("   ")).is_none(),
            "blank secret is not sent"
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
            regenerate_thread_title("t1").is_ok(),
            "thread.metadata.update (regenerateTitle) decodes"
        );
        assert!(pin_thread("t1", true).is_ok(), "thread.pin decodes");
        assert!(pin_thread("t1", false).is_ok(), "thread.unpin decodes");
        assert!(
            mark_thread_unread("t1").is_ok(),
            "thread.mark-unread decodes"
        );
        assert!(delete_thread("t1").is_ok(), "thread.delete decodes");
        assert!(
            create_project_mutation("/tmp/demo", "demo").is_ok(),
            "project.create mutation decodes"
        );
    }

    #[test]
    fn launch_payload_decodes_as_contract_input() {
        for strategy in [
            WorkspaceStrategyChoice::Local,
            WorkspaceStrategyChoice::Worktree,
        ] {
            let payload = launch_thread_payload(
                "t1",
                "p1",
                "hello\nworld",
                &[],
                json!({"instanceId": "claudeAgent", "model": "haiku"}),
                "full-access",
                "default",
                strategy,
            );
            let decoded: Result<conn_contract::OrchestrationV2ThreadLaunchInput, _> =
                conn_contract::from_json(payload);
            assert!(
                decoded.is_ok(),
                "launchThread input ({strategy:?}) decodes: {decoded:?}"
            );
        }
    }

    #[test]
    fn format_client_error_extracts_nested_rpc_message() {
        let err = crate::ClientError::Rpc(json!({
            "reasons": [{
                "_tag": "Fail",
                "error": {
                    "_tag": "OrchestrationV2ThreadLaunchError",
                    "message": "Provider instance \"codex\" is disabled."
                }
            }]
        }));
        assert_eq!(
            format_client_error(&err),
            "Provider instance \"codex\" is disabled."
        );
    }

    #[test]
    fn ids_are_unique() {
        assert_ne!(new_id("x"), new_id("x"), "ids differ");
    }
}
