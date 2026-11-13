//! Command handlers. Each one reads what it needs, appends its events, and returns the side
//! effects to run after the commit. To support a new command, add one function and one line
//! in [`handler`].

use serde::Deserialize;
use serde_json::{Value, json};

use crate::shell::LIVE_RUN_STATUSES;
use crate::store::{Draft, StoreResult, Tx};

/// Work that touches a provider. Runs after the command's events are committed.
#[derive(Debug)]
pub(crate) enum Effect {
    StartTurn { thread_id: String, run_id: String },
    Interrupt { thread_id: String, run_id: String },
    Respond { thread_id: String, request: Value },
    CloseSession { thread_id: String },
}

pub(crate) enum CommandError {
    /// The client asked for something this state does not allow. A typed `Fail`.
    Rejected(String),
    /// The store failed. A defect.
    Store(String),
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self::Store(message)
    }
}

fn reject<T>(message: impl Into<String>) -> Result<T, CommandError> {
    Err(CommandError::Rejected(message.into()))
}

pub(crate) type Outcome = Result<Vec<Effect>, CommandError>;
pub(crate) type Handler = fn(&mut Tx<'_>, Value) -> Outcome;

pub(crate) fn handler(command_type: &str) -> Option<Handler> {
    Some(match command_type {
        "thread.create" => thread_create,
        "message.dispatch" => message_dispatch,
        "run.interrupt" => run_interrupt,
        "thread.stop" => thread_stop,
        "runtime-request.respond" => runtime_request_respond,
        "thread.archive" => thread_archive,
        "thread.unarchive" => thread_unarchive,
        "thread.delete" => thread_delete,
        "thread.visit" => thread_visit,
        "thread.metadata.update" => thread_metadata_update,
        "thread.runtime-mode.set" => thread_runtime_mode_set,
        "thread.interaction-mode.set" => thread_interaction_mode_set,
        "thread.model-selection.set" => thread_model_selection_set,
        _ => return None,
    })
}

fn decode<T: for<'de> Deserialize<'de>>(command: Value) -> Result<T, CommandError> {
    serde_json::from_value(command).or_else(|e| reject(format!("invalid command: {e}")))
}

/// `ModelSelection` decodes the legacy `{provider, model}` form to `{instanceId, model}`.
pub(crate) fn normalize_model_selection(selection: &Value) -> Value {
    let mut out = selection.clone();
    if out["instanceId"].is_null() && out["provider"].is_string() {
        out["instanceId"] = out["provider"].clone();
    }
    if let Some(map) = out.as_object_mut() {
        map.remove("provider");
    }
    out
}

fn live_thread(tx: &Tx<'_>, thread_id: &str) -> Result<Value, CommandError> {
    match tx.thread(thread_id)? {
        Some(thread) => Ok(thread),
        None => reject(format!("Thread {thread_id} does not exist.")),
    }
}

pub(crate) fn is_live(run: &Value) -> bool {
    LIVE_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or(""))
}

fn active_run(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Option<Value>> {
    Ok(tx
        .entities(thread_id, "runs")?
        .into_iter()
        .rev()
        .find(is_live))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCreate {
    command_id: String,
    thread_id: String,
    project_id: String,
    title: String,
    model_selection: Value,
    runtime_mode: Value,
    interaction_mode: Value,
    branch: Option<String>,
    worktree_path: Option<String>,
    created_by: String,
    creation_source: String,
}

fn thread_create(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadCreate = decode(command)?;
    if tx.thread(&c.thread_id)?.is_some() {
        return reject(format!("Thread {} already exists.", c.thread_id));
    }
    if tx.project(&c.project_id)?.is_none() {
        return reject(format!("Project {} does not exist.", c.project_id));
    }
    let model = normalize_model_selection(&c.model_selection);
    let now = tx.now().to_owned();
    let thread = json!({
        "createdBy": c.created_by,
        "creationSource": c.creation_source,
        "id": c.thread_id,
        "projectId": c.project_id,
        "title": c.title,
        "providerInstanceId": model["instanceId"],
        "modelSelection": model,
        "runtimeMode": c.runtime_mode,
        "interactionMode": c.interaction_mode,
        "branch": c.branch,
        "worktreePath": c.worktree_path,
        "pullRequests": [],
        "activeProviderThreadId": null,
        "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": c.thread_id},
        "forkedFrom": null,
        "createdAt": now,
        "updatedAt": now,
        "archivedAt": null,
        "settledOverride": null,
        "settledAt": null,
        "snoozedUntil": null,
        "snoozedAt": null,
        "lastVisitedAt": null,
        "deletedAt": null,
    });
    tx.append(Draft::new(&c.thread_id, "thread.created", thread).command(Some(&c.command_id)))?;
    Ok(vec![])
}

#[derive(Deserialize)]
struct DispatchMode {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageDispatch {
    command_id: String,
    thread_id: String,
    message_id: String,
    text: String,
    attachments: Vec<Value>,
    context: Option<Value>,
    model_selection: Option<Value>,
    created_by: String,
    creation_source: String,
    dispatch_mode: DispatchMode,
}

fn message_dispatch(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: MessageDispatch = decode(command)?;
    let thread = live_thread(tx, &c.thread_id)?;
    if !matches!(
        c.dispatch_mode.kind.as_str(),
        "start_immediately" | "queue_after_active" | "defer_start"
    ) {
        return reject(format!(
            "conn-server does not support dispatch mode `{}` yet.",
            c.dispatch_mode.kind
        ));
    }
    if active_run(tx, &c.thread_id)?.is_some() {
        return reject(
            "This thread is still running a turn. conn-server cannot queue or steer messages yet.",
        );
    }
    let ordinal = tx.count(&c.thread_id, "runs")? + 1;
    let run_id = format!("run:{}:{ordinal}", c.thread_id);
    let root = format!("node:{run_id}:root");
    let model = normalize_model_selection(
        c.model_selection
            .as_ref()
            .unwrap_or(&thread["modelSelection"]),
    );
    let provider_thread_id = thread["activeProviderThreadId"].clone();
    let now = tx.now().to_owned();
    let cid = Some(c.command_id.as_str());
    let draft = |event_type, payload| {
        Draft::new(&c.thread_id, event_type, payload)
            .run(Some(&run_id))
            .node(Some(&root))
            .command(cid)
    };

    tx.append(draft(
        "run.created",
        json!({
            "id": run_id,
            "threadId": c.thread_id,
            "ordinal": ordinal,
            "providerInstanceId": model["instanceId"],
            "modelSelection": model,
            "providerThreadId": provider_thread_id,
            "userMessageId": c.message_id,
            "rootNodeId": root,
            "activeAttemptId": null,
            "status": "starting",
            "queuePosition": null,
            "requestedAt": now,
            "startedAt": null,
            "completedAt": null,
            "checkpointId": null,
            "contextHandoffId": null,
        }),
    ))?;
    tx.append(draft(
        "node.updated",
        json!({
            "id": root,
            "threadId": c.thread_id,
            "runId": run_id,
            "parentNodeId": null,
            "rootNodeId": root,
            "kind": "root_turn",
            "status": "pending",
            "countsForRun": true,
            "providerThreadId": provider_thread_id,
            "providerTurnId": null,
            "nativeItemRef": null,
            "runtimeRequestId": null,
            "checkpointScopeId": null,
            "startedAt": null,
            "completedAt": null,
        }),
    ))?;
    let mut message = json!({
        "createdBy": c.created_by,
        "creationSource": c.creation_source,
        "id": c.message_id,
        "threadId": c.thread_id,
        "runId": run_id,
        "nodeId": root,
        "role": "user",
        "text": c.text,
        "attachments": c.attachments,
        "streaming": false,
        "createdAt": now,
        "updatedAt": now,
    });
    let mut item = json!({
        "id": format!("turn-item:{}", c.message_id),
        "threadId": c.thread_id,
        "runId": run_id,
        "nodeId": root,
        "providerThreadId": provider_thread_id,
        "providerTurnId": null,
        "nativeItemRef": null,
        "parentItemId": null,
        "ordinal": ordinal * 1_000_000 + 1,
        "status": "completed",
        "title": null,
        "startedAt": now,
        "completedAt": now,
        "updatedAt": now,
        "createdBy": c.created_by,
        "creationSource": c.creation_source,
        "type": "user_message",
        "messageId": c.message_id,
        "inputIntent": "turn_start",
        "text": c.text,
        "attachments": c.attachments,
    });
    if let Some(context) = c.context {
        message["context"] = context.clone();
        item["context"] = context;
    }
    tx.append(draft("message.updated", message))?;
    tx.append(draft("turn-item.updated", item))?;
    Ok(vec![Effect::StartTurn {
        thread_id: c.thread_id,
        run_id,
    }])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunInterrupt {
    thread_id: String,
    run_id: String,
}

fn run_interrupt(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: RunInterrupt = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    let live = tx
        .entity(&c.thread_id, "runs", &c.run_id)?
        .is_some_and(|run| is_live(&run));
    // Stopping a run that already ended changes nothing, so a retry succeeds.
    Ok(if live {
        vec![Effect::Interrupt {
            thread_id: c.thread_id,
            run_id: c.run_id,
        }]
    } else {
        vec![]
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadOnly {
    thread_id: String,
}

fn thread_stop(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadOnly = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    Ok(active_run(tx, &c.thread_id)?
        .and_then(|run| run["id"].as_str().map(str::to_owned))
        .map(|run_id| Effect::Interrupt {
            thread_id: c.thread_id,
            run_id,
        })
        .into_iter()
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRequestRespond {
    thread_id: String,
    request_id: String,
    decision: Option<Value>,
    feedback: Option<String>,
    answers: Option<Value>,
}

fn runtime_request_respond(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: RuntimeRequestRespond = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    let Some(mut request) = tx.entity(&c.thread_id, "runtimeRequests", &c.request_id)? else {
        return reject(format!("Request {} does not exist.", c.request_id));
    };
    if request["status"] != "pending" {
        return reject("This request was already answered or has expired.");
    }
    request["status"] = json!("resolved");
    request["resolvedAt"] = json!(tx.now());
    if let Some(decision) = &c.decision {
        request["decision"] = decision.clone();
    }
    if let Some(feedback) = &c.feedback {
        request["feedback"] = json!(feedback);
    }
    if let Some(answers) = &c.answers {
        request["answers"] = answers.clone();
    }
    let node = request["nodeId"].as_str().map(str::to_owned);
    tx.append(Draft::new(&c.thread_id, "runtime-request.updated", request).node(node.as_deref()))?;
    Ok(vec![Effect::Respond {
        thread_id: c.thread_id,
        request: json!({
            "requestId": c.request_id,
            "decision": c.decision,
            "feedback": c.feedback,
            "answers": c.answers,
        }),
    }])
}

/// Replaces fields of the thread record and records it as `event_type`.
fn patch_thread(
    tx: &mut Tx<'_>,
    thread_id: &str,
    event_type: &'static str,
    bump_updated_at: bool,
    patch: impl FnOnce(&mut Value, &str),
) -> Result<(), CommandError> {
    let mut thread = live_thread(tx, thread_id)?;
    let now = tx.now().to_owned();
    patch(&mut thread, &now);
    if bump_updated_at {
        thread["updatedAt"] = json!(now);
    }
    tx.append(Draft::new(thread_id, event_type, thread))?;
    Ok(())
}

fn thread_archive(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadOnly = decode(command)?;
    patch_thread(tx, &c.thread_id, "thread.archived", true, |t, now| {
        t["archivedAt"] = json!(now);
    })?;
    Ok(vec![])
}

fn thread_unarchive(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadOnly = decode(command)?;
    patch_thread(tx, &c.thread_id, "thread.unarchived", true, |t, _| {
        t["archivedAt"] = Value::Null;
    })?;
    Ok(vec![])
}

fn thread_delete(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadOnly = decode(command)?;
    let mut effects = vec![];
    if let Some(run) = active_run(tx, &c.thread_id)? {
        let run_id = run["id"].as_str().unwrap_or_default();
        finish_run(tx, &c.thread_id, run_id, "cancelled", None)?;
    }
    effects.push(Effect::CloseSession {
        thread_id: c.thread_id.clone(),
    });
    patch_thread(tx, &c.thread_id, "thread.deleted", true, |t, now| {
        t["deletedAt"] = json!(now);
    })?;
    Ok(effects)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadVisit {
    thread_id: String,
    visited_at: Value,
}

fn thread_visit(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadVisit = decode(command)?;
    patch_thread(tx, &c.thread_id, "thread.visited", false, |t, _| {
        t["lastVisitedAt"] = c.visited_at;
    })?;
    Ok(vec![])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMetadataUpdate {
    thread_id: String,
    title: Option<String>,
}

fn thread_metadata_update(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadMetadataUpdate = decode(command)?;
    patch_thread(tx, &c.thread_id, "thread.metadata-updated", true, |t, _| {
        if let Some(title) = c.title.filter(|title| !title.trim().is_empty()) {
            t["title"] = json!(title.trim());
        }
    })?;
    Ok(vec![])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSetting {
    thread_id: String,
    runtime_mode: Option<Value>,
    interaction_mode: Option<Value>,
    model_selection: Option<Value>,
}

fn thread_runtime_mode_set(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadSetting = decode(command)?;
    patch_thread(
        tx,
        &c.thread_id,
        "thread.runtime-mode-updated",
        true,
        |t, _| {
            t["runtimeMode"] = c.runtime_mode.unwrap_or(Value::Null);
        },
    )?;
    Ok(vec![])
}

fn thread_interaction_mode_set(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadSetting = decode(command)?;
    patch_thread(
        tx,
        &c.thread_id,
        "thread.interaction-mode-updated",
        true,
        |t, _| {
            t["interactionMode"] = c.interaction_mode.unwrap_or(Value::Null);
        },
    )?;
    Ok(vec![])
}

fn thread_model_selection_set(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadSetting = decode(command)?;
    let Some(selection) = c.model_selection.as_ref().map(normalize_model_selection) else {
        return reject("modelSelection is required.");
    };
    patch_thread(
        tx,
        &c.thread_id,
        "thread.model-selection-updated",
        true,
        |t, _| {
            t["providerInstanceId"] = selection["instanceId"].clone();
            t["modelSelection"] = selection;
        },
    )?;
    Ok(vec![])
}

/// Ends a live run: final versions of its streaming rows, its open requests, attempt, run and
/// root node, plus an `error` item when it failed. Used for provider terminals, interrupts
/// without a provider, deletes, and restart recovery.
pub(crate) fn finish_run(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
    status: &str,
    failure: Option<Value>,
) -> StoreResult<()> {
    let Some(mut run) = tx.entity(thread_id, "runs", run_id)? else {
        return Ok(());
    };
    if !is_live(&run) {
        return Ok(());
    }
    let now = tx.now().to_owned();
    let root = run["rootNodeId"].as_str().map(str::to_owned);
    let draft = |event_type, payload| {
        Draft::new(thread_id, event_type, payload)
            .run(Some(run_id))
            .node(root.as_deref())
    };
    let item_status = match status {
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "interrupted",
    };

    for mut message in tx.entities_where(thread_id, "messages", "runId", run_id)? {
        if message["streaming"] == true {
            message["streaming"] = json!(false);
            message["updatedAt"] = json!(now);
            tx.append(draft("message.updated", message))?;
        }
    }
    for mut item in tx.entities_where(thread_id, "turnItems", "runId", run_id)? {
        let open = matches!(
            item["status"].as_str(),
            Some("idle" | "pending" | "running" | "waiting")
        );
        if item["streaming"] == true || open {
            if item.get("streaming").is_some() {
                item["streaming"] = json!(false);
            }
            if open {
                item["status"] = json!(item_status);
                item["completedAt"] = json!(now);
            }
            item["updatedAt"] = json!(now);
            tx.append(draft("turn-item.updated", item))?;
        }
    }
    for mut request in tx.entities_where(thread_id, "runtimeRequests", "status", "pending")? {
        request["status"] = json!("cancelled");
        request["resolvedAt"] = json!(now);
        tx.append(draft("runtime-request.updated", request))?;
    }
    if let Some(failure) = failure {
        tx.append(draft(
            "turn-item.updated",
            json!({
                "id": format!("turn-item:{run_id}:error"),
                "threadId": thread_id,
                "runId": run_id,
                "nodeId": root,
                "providerThreadId": run["providerThreadId"],
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 0,
                "status": "failed",
                "title": null,
                "startedAt": now,
                "completedAt": now,
                "updatedAt": now,
                "type": "error",
                "failure": failure,
            }),
        ))?;
    }
    if let Some(attempt_id) = run["activeAttemptId"].as_str()
        && let Some(mut attempt) = tx.entity(thread_id, "attempts", attempt_id)?
    {
        attempt["status"] = json!(item_status);
        attempt["completedAt"] = json!(now);
        tx.append(draft("run-attempt.updated", attempt))?;
    }
    run["status"] = json!(status);
    run["completedAt"] = json!(now);
    tx.append(draft("run.updated", run))?;
    if let Some(root) = &root
        && let Some(mut node) = tx.entity(thread_id, "nodes", root)?
    {
        node["status"] = json!(item_status);
        node["completedAt"] = json!(now);
        tx.append(draft("node.updated", node))?;
    }
    tx.compact_streaming(thread_id)
}

/// A provider failure in the contract's shape (`OrchestrationV2ProviderFailure`).
pub(crate) fn failure(class: &str, message: &str, code: Option<&str>) -> Value {
    let message: String = message.trim().chars().take(4096).collect();
    json!({
        "class": class,
        "message": if message.is_empty() { "The turn failed.".to_owned() } else { message },
        "code": code,
        "retryable": null,
    })
}
