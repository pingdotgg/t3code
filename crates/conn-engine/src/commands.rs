//! Command handlers. Each one reads what it needs, appends its events, and returns the side
//! effects to run after the commit. To support a new command, add one function and one line
//! in [`handler`].

use serde::Deserialize;
use serde_json::{Value, json};

use crate::shell::{ACTIVE_RUN_STATUSES, LIVE_RUN_STATUSES};
use crate::store::{Draft, StoreResult, Tx};

/// Work that touches a provider. Runs after the command's events are committed.
#[derive(Debug)]
pub(crate) enum Effect {
    /// Rolls a thread back to a checkpoint (`provider-thread.rollback`).
    Rollback(crate::rollback::RollbackRequest),
    /// Captures a run's checkpoint and finishes it (`checkpoint.capture`).
    CaptureCheckpoint {
        thread_id: String,
        run_id: String,
    },
    StartTurn {
        thread_id: String,
        run_id: String,
    },
    /// Adds a message to a running turn. Falls back to the queue when the provider declines.
    Steer {
        thread_id: String,
        run_id: String,
        message_id: String,
    },
    Interrupt {
        thread_id: String,
        run_id: String,
    },
    Respond {
        thread_id: String,
        request: Value,
    },
    CloseSession {
        thread_id: String,
    },
    /// Sends a model selection to the thread's running provider turn
    /// (`provider-session.apply-model-selection`). The provider applies what it can live; the
    /// rest waits for the next turn.
    ApplyModelSelection {
        thread_id: String,
        selection: Value,
    },
    /// Tells the host a thread was archived, deleted or settled (its terminals close).
    ThreadClosed {
        thread_id: String,
        reason: crate::ThreadClose,
    },
    /// Asks the title generator; answers with `thread.title.regeneration.complete`.
    GenerateTitle {
        thread_id: String,
        request_id: String,
        regenerate: bool,
    },
}

impl Effect {
    /// The thread whose effect lane this effect waits in; `None` runs at once (title
    /// generation, which T3 keeps out of a thread's lane).
    pub(crate) fn lane(&self) -> Option<&str> {
        match self {
            Self::Rollback(request) => Some(&request.thread_id),
            Self::CaptureCheckpoint { thread_id, .. }
            | Self::StartTurn { thread_id, .. }
            | Self::Steer { thread_id, .. }
            | Self::Interrupt { thread_id, .. }
            | Self::Respond { thread_id, .. }
            | Self::CloseSession { thread_id }
            | Self::ApplyModelSelection { thread_id, .. }
            | Self::ThreadClosed { thread_id, .. } => Some(thread_id),
            Self::GenerateTitle { .. } => None,
        }
    }
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

pub(crate) fn reject<T>(message: impl Into<String>) -> Result<T, CommandError> {
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
        "queued-run.start" => queued_run_start,
        "queued-run.cancel" => queued_run_cancel,
        "queued-run.reorder" => queued_run_reorder,
        "queued-run.edit" => queued_run_edit,
        "queue.resume" => queue_resume,
        "queued-message.promote-to-steer" => queued_message_promote_to_steer,
        "thread.settle" | "thread.auto-settle" => thread_settle,
        "thread.unsettle" => thread_unsettle,
        "thread.snooze" => thread_snooze,
        "thread.unsnooze" => thread_unsnooze,
        "thread.auto-settle.set" => thread_auto_settle_set,
        "thread.pin" => thread_pin,
        "thread.unpin" => thread_unpin,
        "thread.pin.reorder" => thread_pin_reorder,
        "thread.active.reorder" => thread_active_reorder,
        "thread.tag.set" => thread_tag_set,
        "thread.mark-unread" => thread_mark_unread,
        "thread.pull-request.link" => thread_pull_request_link,
        "thread.pull-request.unlink" => thread_pull_request_unlink,
        "thread.user-input.dismiss" => thread_user_input_dismiss,
        "provider-session.detach" => provider_session_detach,
        "provider.switch" => provider_switch,
        "thread.title.regeneration.complete" => thread_title_regeneration_complete,
        "delegated_task.request" => crate::families::delegated_task_request,
        "checkpoint.rollback" => crate::rollback::checkpoint_rollback,
        "thread.fork" => crate::fork::thread_fork,
        "delegated_task.wake-policy" => crate::families::wake_policy,
        "delegated_task.completion-delivery.acknowledge"
        | "delegated_task.completion-delivery.dispose" => crate::families::completion_delivery,
        _ => return None,
    })
}

/// Why a contract command this engine does not handle is refused. The client shows the text.
pub(crate) fn refusal(command_type: &str) -> &'static str {
    match command_type {
        "thread.merge_back" => "Conn Server cannot merge a fork back yet.",
        "prepared-run.release"
        | "prepared-run.progress"
        | "prepared-run.fail"
        | "prepared-run.retry" => "Conn Server does not prepare worktrees for runs yet.",
        "thread.guest-share.close" | "thread.guest-message.dismiss" => {
            "Conn Server does not share threads with guests."
        }
        "thread.pull-request-link.sync"
        | "thread.pull-request.watch"
        | "thread.pull-request.sync" => "Conn Server does not watch pull requests yet.",
        "notification.delivery.accept" => {
            "Conn Server does not deliver background notifications yet."
        }
        "subagent.stop" => {
            "Conn Server cannot stop a single subagent yet; stop the thread instead."
        }
        "thread.created.record" => "Conn Server does not record threads from linked environments.",
        _ => "Conn Server does not support this command.",
    }
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

pub(crate) fn live_thread(tx: &Tx<'_>, thread_id: &str) -> Result<Value, CommandError> {
    match tx.thread(thread_id)? {
        Some(thread) => Ok(thread),
        None => reject(format!("Thread {thread_id} does not exist.")),
    }
}

/// Live: active or queued. Only live runs can still end.
pub(crate) fn is_live(run: &Value) -> bool {
    LIVE_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or(""))
}

/// Active: the run that owns the provider now (`isActiveRun` in `CommandPolicy.ts`).
pub(crate) fn is_active(run: &Value) -> bool {
    ACTIVE_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or(""))
}

pub(crate) fn active_run(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Option<Value>> {
    tx.active_run(thread_id)
}

/// Queued runs in delivery order: `queuePosition`, then ordinal.
pub(crate) fn queued_runs(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Vec<Value>> {
    let mut runs: Vec<Value> = tx
        .entities_where(thread_id, "runs", "status", "queued")?
        .into_iter()
        .collect();
    runs.sort_by_key(|run| {
        let ordinal = run["ordinal"].as_u64().unwrap_or(0);
        (run["queuePosition"].as_u64().unwrap_or(ordinal), ordinal)
    });
    Ok(runs)
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
    // T3's `dispatchThreadCreate` does not look the project up: a thread may name a project
    // this server does not know (its replay fixtures do). `launchThread` checks it.
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
#[serde(rename_all = "camelCase")]
struct DispatchMode {
    #[serde(rename = "type")]
    kind: String,
    target_run_id: Option<String>,
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
    delivery_intent: Option<String>,
    steer_follow_up_of_run_id: Option<String>,
    restart_continuation_of_run_id: Option<String>,
    title_seed: Option<String>,
    /// A wake the server queued (`{ source, outcome, summary }`): shown as a notice.
    notification: Option<Value>,
    /// The scheduled task whose run sent this message.
    scheduled_task_id: Option<String>,
    /// Start a new provider conversation without the thread's earlier context. Never steers.
    fresh_context: Option<bool>,
}

/// How a message reaches the thread, after the busy-thread rules.
enum Delivery {
    Start,
    Queue { first: bool },
    Steer(Value),
}

/// `resolveDeliveryIntent` in `CommandPolicy.ts`, for one provider that may or may not steer:
/// we steer into a running provider turn and let the provider decline (then it queues).
fn delivery(tx: &Tx<'_>, c: &MessageDispatch) -> Result<(Delivery, Option<Value>), CommandError> {
    let active = active_run(tx, &c.thread_id)?;
    let Some(active) = active else {
        return Ok((Delivery::Start, None));
    };
    // A steer the provider declined waits first in line: it was meant for this turn.
    if c.steer_follow_up_of_run_id.is_some() {
        return Ok((Delivery::Queue { first: true }, None));
    }
    let turn_running = |run: &Value| -> StoreResult<bool> {
        Ok(run["status"] == "running"
            && tx
                .entities_where(&c.thread_id, "providerTurns", "status", "running")?
                .iter()
                .any(|turn| turn["nodeId"] == run["rootNodeId"]))
    };
    let steer_target = match c.dispatch_mode.kind.as_str() {
        "steer_active" | "restart_active" => {
            let target_id = c.dispatch_mode.target_run_id.clone().unwrap_or_default();
            match tx.entity(&c.thread_id, "runs", &target_id)? {
                Some(target) if is_active(&target) => Some(target),
                // The target ended: the message starts a turn, or queues behind the new one.
                Some(target) if target["status"] == "completed" => None,
                Some(target) => {
                    return reject(format!(
                        "Target run {target_id} is {} and cannot be steered.",
                        target["status"].as_str().unwrap_or("unknown")
                    ));
                }
                None => return reject(format!("Run {target_id} does not exist.")),
            }
        }
        "start_immediately" => match c.delivery_intent.as_deref() {
            Some("steer" | "restart" | "auto") => Some(active),
            _ => None,
        },
        _ => None,
    };
    let restart =
        c.dispatch_mode.kind == "restart_active" || c.delivery_intent.as_deref() == Some("restart");
    Ok(match steer_target {
        // Interrupt-and-restart: the message goes first in the queue and the turn stops.
        Some(target) if restart => (Delivery::Queue { first: true }, Some(target)),
        Some(target) if turn_running(&target)? => (Delivery::Steer(target), None),
        _ => (Delivery::Queue { first: false }, None),
    })
}

fn message_dispatch(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let mut c: MessageDispatch = decode(command)?;
    let thread = live_thread(tx, &c.thread_id)?;
    let fresh = c.fresh_context == Some(true);
    if fresh {
        fresh_context_allowed(tx, &c, &thread)?;
        // A fresh start never joins a running turn (`dispatchMessage`).
        if matches!(
            c.dispatch_mode.kind.as_str(),
            "steer_active" | "restart_active"
        ) {
            c.dispatch_mode = DispatchMode {
                kind: "queue_after_active".into(),
                target_run_id: None,
            };
        }
    }
    crate::fork::ensure_native_fork(
        tx,
        &c.thread_id,
        thread["modelSelection"]["instanceId"]
            .as_str()
            .unwrap_or_default(),
    )?;
    if !matches!(
        c.dispatch_mode.kind.as_str(),
        "start_immediately"
            | "queue_after_active"
            | "defer_start"
            | "steer_active"
            | "restart_active"
    ) {
        return reject(format!(
            "Conn Server does not support dispatch mode `{}` yet.",
            c.dispatch_mode.kind
        ));
    }
    let (delivery, interrupt) = delivery(tx, &c)?;
    if let Delivery::Steer(target) = delivery {
        return steer_into(tx, &c, &target);
    }
    // A user send releases a queue that Stop or a failure held.
    if c.created_by == "user" {
        release_held(tx, &c.thread_id)?;
    }
    let queued = matches!(delivery, Delivery::Queue { .. });
    let ordinal = tx.count(&c.thread_id, "runs")? + 1;
    let run_id = format!("run:{}:{ordinal}", c.thread_id);
    let root = format!("node:{run_id}:root");
    let model = normalize_model_selection(
        c.model_selection
            .as_ref()
            .unwrap_or(&thread["modelSelection"]),
    );
    // A fresh run starts a new provider thread when it runs.
    let provider_thread_id = if fresh {
        Value::Null
    } else {
        thread["activeProviderThreadId"].clone()
    };
    let now = tx.now().to_owned();
    let cid = Some(c.command_id.as_str());
    let draft = |event_type, payload| {
        Draft::new(&c.thread_id, event_type, payload)
            .run(Some(&run_id))
            .node(Some(&root))
            .command(cid)
    };

    let queue_position = match delivery {
        Delivery::Queue { first: true } => {
            // Everything already queued moves down one place.
            for mut run in queued_runs(tx, &c.thread_id)? {
                let position = run["queuePosition"].as_u64().unwrap_or(1);
                run["queuePosition"] = json!(position + 1);
                let id = run["id"].as_str().unwrap_or_default().to_owned();
                tx.append(
                    Draft::new(&c.thread_id, "run.updated", run)
                        .run(Some(&id))
                        .command(cid),
                )?;
            }
            json!(1)
        }
        Delivery::Queue { first: false } => {
            let last = queued_runs(tx, &c.thread_id)?
                .last()
                .and_then(|run| run["queuePosition"].as_u64().or(run["ordinal"].as_u64()))
                .unwrap_or(0);
            json!(last + 1)
        }
        _ => Value::Null,
    };
    let held = queued
        && queued_runs(tx, &c.thread_id)?
            .iter()
            .any(|r| r["queueHeld"] == true);
    let mut run = json!({
        "id": run_id,
        "threadId": c.thread_id,
        "ordinal": ordinal,
        "providerInstanceId": model["instanceId"],
        "modelSelection": model,
        "providerThreadId": provider_thread_id,
        "userMessageId": c.message_id,
        "rootNodeId": root,
        "activeAttemptId": null,
        "status": if queued { "queued" } else { "starting" },
        "queuePosition": queue_position,
        "requestedAt": now,
        "startedAt": null,
        "completedAt": null,
        "checkpointId": null,
        "contextHandoffId": null,
    });
    if held {
        run["queueHeld"] = json!(true);
    }
    if fresh {
        run["freshContext"] = json!(true);
    }
    // An explicit steer into a turn whose provider turn is not running yet waits as a queued
    // run and becomes a steer once it runs (`deliverDeferredSteers`).
    let explicit_steer = c.dispatch_mode.kind == "steer_active"
        || (c.dispatch_mode.kind == "start_immediately"
            && c.delivery_intent.as_deref() == Some("steer"));
    if matches!(delivery, Delivery::Queue { first: false })
        && explicit_steer
        && c.steer_follow_up_of_run_id.is_none()
        && let Some(target) = active_run(tx, &c.thread_id)?
    {
        run["steerWhenReadyRunId"] = target["id"].clone();
    }
    if let Some(source) = &c.restart_continuation_of_run_id {
        run["restartContinuationOfRunId"] = json!(source);
    }
    tx.append(draft("run.created", run))?;
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
    if let Some(context) = &c.context {
        message["context"] = context.clone();
    }
    if let Some(notification) = &c.notification {
        message["notification"] = notification.clone();
    }
    // A scheduled run's message names its task; the client's timeline marks it.
    if let Some(task) = &c.scheduled_task_id {
        message["scheduledTaskId"] = json!(task);
    }
    tx.append(draft("message.updated", message))?;
    let item_id = format!("turn-item:{}", c.message_id);
    let existing_item = tx.entity(&c.thread_id, "turnItems", &item_id)?;
    if queued {
        // A queued message has no turn item until its run starts (`Orchestrator.ts`), except a
        // declined steer, whose item already shows and now waits in the queue.
        if let Some(mut item) = existing_item {
            item["runId"] = json!(run_id);
            item["nodeId"] = json!(root);
            item["inputIntent"] = json!("queued_turn");
            item["status"] = json!("pending");
            item["completedAt"] = Value::Null;
            item["updatedAt"] = json!(now);
            tx.append(draft("turn-item.updated", item))?;
        }
    } else {
        tx.append(draft(
            "turn-item.updated",
            user_message_item(
                &c,
                &run_id,
                &root,
                &provider_thread_id,
                ordinal,
                "turn_start",
                &now,
            ),
        ))?;
    }
    let seed = match c.title_seed.as_deref().map(str::trim) {
        Some(seed) if !seed.is_empty() && tx.count(&c.thread_id, "messages")? == 1 => Some(seed),
        _ => None,
    };
    let mut effects = vec![];
    if let Some(seed) = seed {
        let mut thread = thread;
        thread["title"] = json!(seed);
        if tx.generates_titles {
            thread["titleRegeneration"] = json!({"requestId": c.command_id, "startedAt": now});
            effects.push(Effect::GenerateTitle {
                thread_id: c.thread_id.clone(),
                request_id: c.command_id.clone(),
                regenerate: false,
            });
        }
        tx.append(Draft::new(&c.thread_id, "thread.metadata-updated", thread).command(cid))?;
    }
    if let Some(target) = interrupt {
        effects.push(Effect::Interrupt {
            thread_id: c.thread_id.clone(),
            run_id: target["id"].as_str().unwrap_or_default().to_owned(),
        });
    } else if !queued {
        effects.push(Effect::StartTurn {
            thread_id: c.thread_id.clone(),
            run_id,
        });
    }
    Ok(effects)
}

fn user_message_item(
    c: &MessageDispatch,
    run_id: &str,
    root: &str,
    provider_thread_id: &Value,
    ordinal: u64,
    intent: &str,
    now: &str,
) -> Value {
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
        "inputIntent": intent,
        "text": c.text,
        "attachments": c.attachments,
    });
    if let Some(context) = &c.context {
        item["context"] = context.clone();
    }
    if let Some(task) = &c.scheduled_task_id {
        item["scheduledTaskId"] = json!(task);
    }
    if c.fresh_context == Some(true) {
        item["freshContext"] = json!(true);
    }
    match &c.notification {
        Some(notification) => as_notice(item, notification),
        None => item,
    }
}

/// The turn item of a message that carries a `notification`: the client shows a notice with
/// its source, outcome and summary instead of a user message (`notificationTurnItem`).
fn as_notice(mut item: Value, notification: &Value) -> Value {
    if let Value::Object(fields) = &mut item {
        for key in [
            "createdBy",
            "creationSource",
            "messageId",
            "inputIntent",
            "text",
            "attachments",
            "context",
        ] {
            fields.remove(key);
        }
        fields.insert("type".into(), json!("notification"));
        for key in ["source", "outcome", "summary"] {
            fields.insert(key.into(), notification[key].clone());
        }
    }
    item
}

/// The provider thread a queued run starts on: none for a fresh run (it makes a new one).
fn queued_provider_thread(run: &Value, thread: &Value) -> Value {
    if run["freshContext"] == true {
        Value::Null
    } else {
        thread["activeProviderThreadId"].clone()
    }
}

/// T3's refusals of a fresh start (`dispatchMessage`): not while a fork is still being
/// applied, and not while the current session runs background work that a new session would
/// end, unless a schedule sent it (nobody is there to wait or press Stop).
fn fresh_context_allowed(
    tx: &Tx<'_>,
    c: &MessageDispatch,
    thread: &Value,
) -> Result<(), CommandError> {
    if crate::fork::pending_fork(tx, &c.thread_id)?.is_some() {
        return reject("A fresh session can't start while a fork or merge is still being applied.");
    }
    if c.scheduled_task_id.is_some() {
        return Ok(());
    }
    let Some(active) = thread["activeProviderThreadId"].as_str() else {
        return Ok(());
    };
    let Some(active) = tx.entity(&c.thread_id, "providerThreads", active)? else {
        return Ok(());
    };
    let session = &active["providerSessionId"];
    let busy = tx
        .entities(&c.thread_id, "providerThreads")?
        .iter()
        .filter(|pt| !session.is_null() && pt["providerSessionId"] == *session)
        .any(|pt| {
            pt["pendingBackgroundTasks"]
                .as_array()
                .is_some_and(|tasks| !tasks.is_empty())
        });
    if busy {
        return reject(
            "The current session is still running background agents or commands, and a fresh session would end them. Wait for them to finish, or press Stop, then send the message again.",
        );
    }
    Ok(())
}

/// Writes the message into the running turn (`dispatchSteerIntoRun`): no new run.
fn steer_into(tx: &mut Tx<'_>, c: &MessageDispatch, target: &Value) -> Outcome {
    let run_id = target["id"].as_str().unwrap_or_default().to_owned();
    let root = target["rootNodeId"].as_str().unwrap_or_default().to_owned();
    let now = tx.now().to_owned();
    let cid = Some(c.command_id.as_str());
    let draft = |event_type, payload| {
        Draft::new(&c.thread_id, event_type, payload)
            .run(Some(&run_id))
            .node(Some(&root))
            .command(cid)
    };
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
    if let Some(context) = &c.context {
        message["context"] = context.clone();
    }
    tx.append(draft("message.updated", message))?;
    let ordinal = target["ordinal"].as_u64().unwrap_or(1);
    tx.append(draft(
        "turn-item.updated",
        user_message_item(
            c,
            &run_id,
            &root,
            &target["providerThreadId"],
            ordinal,
            "steer",
            &now,
        ),
    ))?;
    Ok(vec![Effect::Steer {
        thread_id: c.thread_id.clone(),
        run_id,
        message_id: c.message_id.clone(),
    }])
}

/// Clears `queueHeld` on every queued run.
fn release_held(tx: &mut Tx<'_>, thread_id: &str) -> StoreResult<bool> {
    let mut released = false;
    for mut run in queued_runs(tx, thread_id)? {
        if run["queueHeld"] == true {
            run["queueHeld"] = json!(false);
            let id = run["id"].as_str().unwrap_or_default().to_owned();
            tx.append(Draft::new(thread_id, "run.updated", run).run(Some(&id)))?;
            released = true;
        }
    }
    Ok(released)
}

/// Sets `queueHeld` on every queued run, so they wait for the user.
pub(crate) fn hold_queue(tx: &mut Tx<'_>, thread_id: &str) -> StoreResult<()> {
    for mut run in queued_runs(tx, thread_id)? {
        if run["queueHeld"] != true {
            run["queueHeld"] = json!(true);
            let id = run["id"].as_str().unwrap_or_default().to_owned();
            tx.append(Draft::new(thread_id, "run.updated", run).run(Some(&id)))?;
        }
    }
    Ok(())
}

/// Starts the next queued run when nothing is active (`startNextQueuedRun`). `only` picks one
/// queued run, as `queued-run.start` does. Returns the effect that starts it.
pub(crate) fn start_next_queued(
    tx: &mut Tx<'_>,
    thread_id: &str,
    only: Option<&str>,
) -> StoreResult<Option<Effect>> {
    if active_run(tx, thread_id)?.is_some() {
        return Ok(None);
    }
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(None);
    };
    if !thread["archivedAt"].is_null() {
        return Ok(None);
    }
    let next = queued_runs(tx, thread_id)?
        .into_iter()
        .find(|run| match only {
            Some(id) => run["id"] == id,
            None => run["queueHeld"] != true,
        });
    let Some(mut run) = next else {
        return Ok(None);
    };
    let run_id = run["id"].as_str().unwrap_or_default().to_owned();
    let root = run["rootNodeId"].as_str().unwrap_or_default().to_owned();
    let now = tx.now().to_owned();
    let message_id = run["userMessageId"].as_str().unwrap_or_default().to_owned();
    let draft = |event_type, payload| {
        Draft::new(thread_id, event_type, payload)
            .run(Some(&run_id))
            .node(Some(&root))
    };
    if let Some(message) = tx.entity(thread_id, "messages", &message_id)? {
        let item_id = format!("turn-item:{message_id}");
        let mut item = tx
            .entity(thread_id, "turnItems", &item_id)?
            .unwrap_or_else(|| {
                json!({
                    "id": item_id,
                    "threadId": thread_id,
                    "providerTurnId": null,
                    "nativeItemRef": null,
                    "parentItemId": null,
                    "ordinal": 0,
                    "title": null,
                    "startedAt": now,
                    "createdBy": message["createdBy"],
                    "creationSource": message["creationSource"],
                    "type": "user_message",
                    "messageId": message_id,
                    "text": message["text"],
                    "attachments": message["attachments"],
                })
            });
        if message["context"].is_object() {
            item["context"] = message["context"].clone();
        }
        if let Some(task) = message["scheduledTaskId"].as_str() {
            item["scheduledTaskId"] = json!(task);
        }
        if run["freshContext"] == true {
            item["freshContext"] = json!(true);
        }
        item["runId"] = json!(run_id);
        item["nodeId"] = json!(root);
        item["providerThreadId"] = queued_provider_thread(&run, &thread);
        item["inputIntent"] = json!("queued_turn");
        item["status"] = json!("completed");
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        if message["notification"].is_object() && item["type"] == "user_message" {
            item = as_notice(item, &message["notification"]);
        }
        tx.append(draft("turn-item.updated", item))?;
    }
    run["status"] = json!("starting");
    run["queuePosition"] = Value::Null;
    run["queueHeld"] = json!(false);
    run["providerThreadId"] = queued_provider_thread(&run, &thread);
    tx.append(draft("run.updated", run))?;
    Ok(Some(Effect::StartTurn {
        thread_id: thread_id.to_owned(),
        run_id,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedRun {
    thread_id: String,
    run_id: String,
}

fn queued_run(tx: &Tx<'_>, c: &QueuedRun) -> Result<Value, CommandError> {
    live_thread(tx, &c.thread_id)?;
    match tx.entity(&c.thread_id, "runs", &c.run_id)? {
        Some(run) if run["status"] == "queued" => Ok(run),
        Some(_) => reject(format!("Run {} is no longer queued.", c.run_id)),
        None => reject(format!("Run {} does not exist.", c.run_id)),
    }
}

fn queued_run_start(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: QueuedRun = decode(command)?;
    queued_run(tx, &c)?;
    if active_run(tx, &c.thread_id)?.is_some() {
        return reject("A queued user message can only be sent now while the thread is stopped.");
    }
    release_held(tx, &c.thread_id)?;
    Ok(start_next_queued(tx, &c.thread_id, Some(&c.run_id))?
        .into_iter()
        .collect())
}

fn queue_resume(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadOnly = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    release_held(tx, &c.thread_id)?;
    Ok(start_next_queued(tx, &c.thread_id, None)?
        .into_iter()
        .collect())
}

fn queued_run_cancel(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: QueuedRun = decode(command)?;
    queued_run(tx, &c)?;
    finish_run(tx, &c.thread_id, &c.run_id, "cancelled", None)?;
    Ok(vec![])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedRunReorder {
    thread_id: String,
    run_id: String,
    before_run_id: Option<String>,
}

fn queued_run_reorder(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: QueuedRunReorder = decode(command)?;
    queued_run(
        tx,
        &QueuedRun {
            thread_id: c.thread_id.clone(),
            run_id: c.run_id.clone(),
        },
    )?;
    let mut runs = queued_runs(tx, &c.thread_id)?;
    let Some(from) = runs.iter().position(|r| r["id"] == c.run_id.as_str()) else {
        return Ok(vec![]);
    };
    let moved = runs.remove(from);
    let to = match &c.before_run_id {
        Some(before) => runs
            .iter()
            .position(|r| r["id"] == before.as_str())
            .ok_or_else(|| CommandError::Rejected(format!("Run {before} is not queued.")))?,
        None => runs.len(),
    };
    runs.insert(to, moved);
    for (index, mut run) in runs.into_iter().enumerate() {
        let position = index as u64 + 1;
        if run["queuePosition"].as_u64() != Some(position) {
            run["queuePosition"] = json!(position);
            let id = run["id"].as_str().unwrap_or_default().to_owned();
            tx.append(Draft::new(&c.thread_id, "run.updated", run).run(Some(&id)))?;
        }
    }
    Ok(vec![])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedRunEdit {
    thread_id: String,
    run_id: String,
    text: String,
    attachments: Option<Vec<Value>>,
    context: Option<Value>,
}

fn queued_run_edit(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: QueuedRunEdit = decode(command)?;
    if c.text.trim().is_empty() {
        return reject("A queued message needs text.");
    }
    let run = queued_run(
        tx,
        &QueuedRun {
            thread_id: c.thread_id.clone(),
            run_id: c.run_id.clone(),
        },
    )?;
    let message_id = run["userMessageId"].as_str().unwrap_or_default();
    let Some(mut message) = tx.entity(&c.thread_id, "messages", message_id)? else {
        return reject(format!("Message {message_id} does not exist."));
    };
    message["text"] = json!(c.text);
    if let Some(attachments) = c.attachments {
        message["attachments"] = json!(attachments);
    }
    if let Some(context) = c.context {
        message["context"] = context;
    }
    message["updatedAt"] = json!(tx.now());
    tx.append(Draft::new(&c.thread_id, "message.updated", message).run(Some(&c.run_id)))?;
    Ok(vec![])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromoteToSteer {
    thread_id: String,
    queued_run_id: String,
    target_run_id: String,
}

fn queued_message_promote_to_steer(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: PromoteToSteer = decode(command)?;
    let queued = queued_run(
        tx,
        &QueuedRun {
            thread_id: c.thread_id.clone(),
            run_id: c.queued_run_id.clone(),
        },
    )?;
    let Some(target) = tx
        .entity(&c.thread_id, "runs", &c.target_run_id)?
        .filter(is_active)
    else {
        return reject(format!("Target run {} is not running.", c.target_run_id));
    };
    let message_id = queued["userMessageId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let Some(message) = tx.entity(&c.thread_id, "messages", &message_id)? else {
        return reject(format!("Message {message_id} does not exist."));
    };
    finish_run(tx, &c.thread_id, &c.queued_run_id, "cancelled", None)?;
    let dispatch = MessageDispatch {
        command_id: String::new(),
        thread_id: c.thread_id.clone(),
        message_id,
        text: message["text"].as_str().unwrap_or_default().to_owned(),
        attachments: message["attachments"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        context: message.get("context").filter(|v| v.is_object()).cloned(),
        model_selection: None,
        created_by: message["createdBy"].as_str().unwrap_or("user").to_owned(),
        creation_source: message["creationSource"]
            .as_str()
            .unwrap_or("web")
            .to_owned(),
        dispatch_mode: DispatchMode {
            kind: "steer_active".into(),
            target_run_id: Some(c.target_run_id.clone()),
        },
        delivery_intent: None,
        steer_follow_up_of_run_id: None,
        restart_continuation_of_run_id: None,
        title_seed: None,
        notification: message
            .get("notification")
            .filter(|v| v.is_object())
            .cloned(),
        scheduled_task_id: message["scheduledTaskId"].as_str().map(str::to_owned),
        fresh_context: None,
    };
    let mut effects = steer_into(tx, &dispatch, &target)?;
    // The item records that it came from the queue.
    let item_id = format!("turn-item:{}", dispatch.message_id);
    if let Some(mut item) = tx.entity(&c.thread_id, "turnItems", &item_id)? {
        item["inputIntent"] = json!("promoted_queued_to_steer");
        tx.append(Draft::new(&c.thread_id, "turn-item.updated", item).run(Some(&c.target_run_id)))?;
    }
    effects.truncate(1);
    Ok(effects)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunInterrupt {
    thread_id: String,
    run_id: String,
    hold_queue: Option<bool>,
    reason: Option<String>,
}

fn run_interrupt(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: RunInterrupt = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    let run = tx.entity(&c.thread_id, "runs", &c.run_id)?;
    if run.as_ref().is_some_and(|run| run["status"] == "queued") {
        finish_run(tx, &c.thread_id, &c.run_id, "cancelled", None)?;
        return Ok(vec![]);
    }
    if c.hold_queue == Some(true) {
        hold_queue(tx, &c.thread_id)?;
    }
    let live = run.filter(is_active);
    if let Some(run) = &live {
        mark_stopped_run(tx, &c.thread_id, run, c.reason.as_deref())?;
    }
    // Stopping a run that already ended changes nothing, so a retry succeeds.
    Ok(if live.is_some() {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadStop {
    thread_id: String,
    reason: Option<String>,
}

fn thread_stop(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadStop = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    // Stop means stop: queued messages wait until the user sends again or resumes the queue.
    hold_queue(tx, &c.thread_id)?;
    let children = crate::families::stop_children(tx, &c.thread_id)?;
    let active = active_run(tx, &c.thread_id)?;
    if let Some(run) = &active {
        mark_stopped_run(tx, &c.thread_id, run, c.reason.as_deref())?;
    }
    let own = active
        .and_then(|run| run["id"].as_str().map(str::to_owned))
        .map(|run_id| Effect::Interrupt {
            thread_id: c.thread_id,
            run_id,
        });
    Ok(children.into_iter().chain(own).collect())
}

/// `RunExecutionService.USER_STOP_REASON`: a Stop without a reason came from a person.
const USER_STOP_REASON: &str = "Stopped by user";
/// `ThreadManagementService.FORCE_STOP_REASON`.
pub(crate) const FORCE_STOP_REASON: &str = "Force stopped by user";

/// `runSignalTurnItem` for a run: its Stop request and its Stop result.
fn interrupt_item_id(run_id: &str, signal: &str) -> String {
    format!("turn-item:{run_id}:{signal}")
}

/// The `run_interrupt_request` item of a run, when Stop asked for it.
fn interrupt_request(tx: &Tx<'_>, thread_id: &str, run_id: &str) -> StoreResult<Option<Value>> {
    tx.entity(
        thread_id,
        "turnItems",
        &interrupt_item_id(run_id, "interrupt-request"),
    )
}

/// `Orchestrator.markStoppedRun`: records the Stop on the run as a `run_interrupt_request`
/// item, once per run. Clients show "Stopping" from it, and "Force stop" once it is marked
/// unresponsive. A run with no root node or provider thread yet gets none, as in T3.
fn mark_stopped_run(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    reason: Option<&str>,
) -> StoreResult<()> {
    let (Some(run_id), Some(root)) = (run["id"].as_str(), run["rootNodeId"].as_str()) else {
        return Ok(());
    };
    if run["providerThreadId"].is_null() || interrupt_request(tx, thread_id, run_id)?.is_some() {
        return Ok(());
    }
    let ordinal = tx
        .entities_where(thread_id, "turnItems", "runId", run_id)?
        .iter()
        .filter_map(|item| item["ordinal"].as_u64())
        .max()
        .map_or(0, |max| max + 1);
    let now = tx.now().to_owned();
    let item = json!({
        "id": interrupt_item_id(run_id, "interrupt-request"),
        "threadId": thread_id,
        "runId": run_id,
        "nodeId": root,
        "providerThreadId": run["providerThreadId"],
        "providerTurnId": null,
        "nativeItemRef": null,
        "parentItemId": null,
        "ordinal": ordinal,
        "status": "completed",
        "title": "Interrupt requested",
        "startedAt": now,
        "completedAt": now,
        "updatedAt": now,
        "type": "run_interrupt_request",
        "message": reason.unwrap_or(USER_STOP_REASON),
    });
    tx.append(
        Draft::new(thread_id, "turn-item.updated", item)
            .run(Some(run_id))
            .node(Some(root)),
    )?;
    Ok(())
}

/// `thread.interrupt.unresponsive`: the provider did not confirm the Stop in time, so the
/// run's Stop request gets `unresponsiveAt` and clients offer Force stop. Nothing changes once
/// the run has its Stop result, or when it was marked already.
pub(crate) fn mark_stop_unresponsive(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
) -> StoreResult<()> {
    if tx
        .entity(
            thread_id,
            "turnItems",
            &interrupt_item_id(run_id, "interrupt-result"),
        )?
        .is_some()
    {
        return Ok(());
    }
    let Some(mut request) = interrupt_request(tx, thread_id, run_id)? else {
        return Ok(());
    };
    if request.get("unresponsiveAt").is_some_and(|v| !v.is_null()) {
        return Ok(());
    }
    let now = tx.now().to_owned();
    request["unresponsiveAt"] = json!(now);
    request["updatedAt"] = json!(now);
    let node = request["nodeId"].as_str().map(str::to_owned);
    tx.append(
        Draft::new(thread_id, "turn-item.updated", request)
            .run(Some(run_id))
            .node(node.as_deref()),
    )?;
    Ok(())
}

/// `makeInterruptResultTurnItem`: the Stop result of a run that ended interrupted. Its message
/// is `reason`, else the Stop request's, else "Stopped by the provider". Written once.
pub(crate) fn write_interrupt_result(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    reason: Option<&str>,
) -> StoreResult<()> {
    let (Some(run_id), Some(root)) = (run["id"].as_str(), run["rootNodeId"].as_str()) else {
        return Ok(());
    };
    let id = interrupt_item_id(run_id, "interrupt-result");
    if run["providerThreadId"].is_null() || tx.entity(thread_id, "turnItems", &id)?.is_some() {
        return Ok(());
    }
    let request = interrupt_request(tx, thread_id, run_id)?;
    let message = reason
        .map(str::to_owned)
        .or_else(|| {
            request
                .as_ref()
                .and_then(|r| r["message"].as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "Stopped by the provider".to_owned());
    let provider_turn = tx
        .entity(thread_id, "nodes", root)?
        .map(|node| node["providerTurnId"].clone())
        .unwrap_or(Value::Null);
    let now = tx.now().to_owned();
    let item = json!({
        "id": id,
        "threadId": thread_id,
        "runId": run_id,
        "nodeId": root,
        "providerThreadId": run["providerThreadId"],
        "providerTurnId": provider_turn,
        "nativeItemRef": null,
        "parentItemId": interrupt_item_id(run_id, "interrupt-request"),
        "ordinal": run["ordinal"].as_u64().unwrap_or(0) * 100 + 98,
        "status": "interrupted",
        "title": "Interrupted",
        "startedAt": now,
        "completedAt": now,
        "updatedAt": now,
        "type": "run_interrupt_result",
        "message": message,
    });
    tx.append(
        Draft::new(thread_id, "turn-item.updated", item)
            .run(Some(run_id))
            .node(Some(root)),
    )?;
    Ok(())
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
    Ok(vec![Effect::ThreadClosed {
        thread_id: c.thread_id,
        reason: crate::ThreadClose::Archived,
    }])
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
    for run in tx
        .entities(&c.thread_id, "runs")?
        .into_iter()
        .filter(is_live)
    {
        let run_id = run["id"].as_str().unwrap_or_default();
        finish_run(tx, &c.thread_id, run_id, "cancelled", None)?;
    }
    effects.push(Effect::CloseSession {
        thread_id: c.thread_id.clone(),
    });
    patch_thread(tx, &c.thread_id, "thread.deleted", true, |t, now| {
        t["deletedAt"] = json!(now);
    })?;
    effects.push(Effect::ThreadClosed {
        thread_id: c.thread_id,
        reason: crate::ThreadClose::Deleted,
    });
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
    command_id: String,
    thread_id: String,
    title: Option<String>,
    regenerate_title: Option<bool>,
    continuation: Option<MetadataContinuation>,
}

/// A message queued in the same commit as the update (`metadataUpdateContinuation`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataContinuation {
    message_id: String,
    text: String,
}

fn thread_metadata_update(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadMetadataUpdate = decode(command)?;
    let regenerate = c.regenerate_title == Some(true);
    if regenerate && !tx.generates_titles {
        return reject("Conn Server has no title generator configured.");
    }
    let command_id = c.command_id.clone();
    let titled = c.title.is_some();
    let thread_id = c.thread_id.clone();
    patch_thread(
        tx,
        &c.thread_id,
        "thread.metadata-updated",
        true,
        |t, now| {
            if let Some(title) = c.title.filter(|title| !title.trim().is_empty()) {
                t["title"] = json!(title.trim());
            }
            if regenerate {
                t["titleRegeneration"] = json!({"requestId": command_id, "startedAt": now});
            } else if titled || c.regenerate_title == Some(false) {
                t["titleRegeneration"] = Value::Null;
            }
        },
    )?;
    let mut effects = if regenerate {
        vec![Effect::GenerateTitle {
            thread_id: thread_id.clone(),
            request_id: command_id.clone(),
            regenerate: true,
        }]
    } else {
        vec![]
    };
    // T3 queues the follow-up in the same commit, as the agent through /mcp, so a workspace
    // change cannot settle the thread before it exists. A refused message refuses the update.
    if let Some(continuation) = c.continuation {
        effects.extend(message_dispatch(
            tx,
            json!({
                "type": "message.dispatch", "commandId": command_id, "threadId": thread_id,
                "messageId": continuation.message_id, "text": continuation.text,
                "attachments": [], "dispatchMode": {"type": "queue_after_active"},
                "createdBy": "agent", "creationSource": "mcp",
            }),
        )?);
    }
    Ok(effects)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSetting {
    thread_id: String,
    runtime_mode: Option<Value>,
    interaction_mode: Option<Value>,
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

/// A model change on the thread's instance changes the thread, and goes to a running provider
/// turn as `ApplyModelSelection` (the runner checks that a turn runs). A change of instance is
/// a provider switch, as `Orchestrator.ts` plans it for `thread.model-selection.set`.
fn thread_model_selection_set(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let Some(selection) = command
        .get("modelSelection")
        .filter(|s| s.is_object())
        .map(normalize_model_selection)
    else {
        return reject("modelSelection is required.");
    };
    if live_thread(tx, &thread_id)?["providerInstanceId"] != selection["instanceId"] {
        return switch_provider(tx, &command, selection);
    }
    // The provider's plan (`Engine::plan_selection`; `decideProviderSessionTransition`).
    let transition = &command["selectionTransition"];
    match transition["type"].as_str() {
        Some("reject") => {
            return reject(
                transition["reason"]
                    .as_str()
                    .unwrap_or("The provider refused this model change."),
            );
        }
        // No handoff here: a new native thread would lose the conversation.
        Some("create_with_handoff") => {
            return reject("This provider needs a new conversation for this model.");
        }
        Some("restart_session") => {
            // `restart_and_resume`: the live session is released; a busy thread keeps it.
            if active_run(tx, &thread_id)?.is_some() {
                return reject(format!(
                    "Thread {thread_id} is running; change the model between turns."
                ));
            }
            patch_thread(
                tx,
                &thread_id,
                "thread.model-selection-updated",
                true,
                |t, _| {
                    t["modelSelection"] = selection;
                },
            )?;
            return Ok(vec![Effect::CloseSession { thread_id }]);
        }
        _ => {}
    }
    patch_thread(
        tx,
        &thread_id,
        "thread.model-selection-updated",
        true,
        |t, _| {
            t["modelSelection"] = selection.clone();
        },
    )?;
    Ok(vec![Effect::ApplyModelSelection {
        thread_id,
        selection,
    }])
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
    finish_run_as(tx, thread_id, run_id, status, status, failure)
}

/// Ends a run's items with `status`, and the run and its root node with `persisted`: a
/// completed provider turn whose checkpoint is still to be taken persists `waiting`, with no
/// `completedAt` (`RunExecutionService.ts`).
pub(crate) fn finish_run_as(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
    status: &str,
    persisted: &str,
    failure: Option<Value>,
) -> StoreResult<()> {
    let Some(mut run) = tx.entity(thread_id, "runs", run_id)? else {
        return Ok(());
    };
    if !is_live(&run) {
        return Ok(());
    }
    if status == "interrupted" {
        write_interrupt_result(tx, thread_id, &run, None)?;
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
        // A completed run leaves its background work running (a command, tool or subagent
        // the provider did not end): T3 settles only the rows its provider closes, and the
        // shell lists the rest as pending background work.
        let background = status == "completed"
            && crate::background::BACKGROUND_ITEM_TYPES
                .contains(&item["type"].as_str().unwrap_or_default());
        let open = !background
            && matches!(
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
    let completed_at = if persisted == "waiting" {
        Value::Null
    } else {
        json!(now)
    };
    run["status"] = json!(persisted);
    run["completedAt"] = completed_at.clone();
    tx.append(draft("run.updated", run.clone()))?;
    if let Some(root) = &root
        && let Some(mut node) = tx.entity(thread_id, "nodes", root)?
    {
        node["status"] = json!(if persisted == "waiting" {
            "waiting"
        } else {
            item_status
        });
        node["completedAt"] = completed_at;
        tx.append(draft("node.updated", node))?;
    }
    settle_provider_thread(tx, thread_id, &run, "idle")?;
    tx.compact_streaming(thread_id)
}

/// The run's provider thread goes back from `active` when the run ends: `idle`, or `error`
/// when the provider says the native thread cannot take another turn
/// (`finalProviderThreadStatus` in T3's `RunExecutionService`). Only while this run is the
/// thread's last (`lastRunOrdinal`), so a later run's row is never overwritten.
pub(crate) fn settle_provider_thread(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    status: &str,
) -> StoreResult<()> {
    let Some(id) = run["providerThreadId"].as_str() else {
        return Ok(());
    };
    let Some(mut thread) = tx.entity(thread_id, "providerThreads", id)? else {
        return Ok(());
    };
    let current = thread["status"].as_str().unwrap_or_default();
    if !(current == "active" || (status == "error" && current == "idle"))
        || thread["lastRunOrdinal"] != run["ordinal"]
    {
        return Ok(());
    }
    thread["status"] = json!(status);
    thread["updatedAt"] = json!(tx.now());
    tx.append(Draft::new(thread_id, "provider-thread.updated", thread))?;
    Ok(())
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

/// The thread record and the time of this write, for the field setters below.
fn thread_patch(
    tx: &mut Tx<'_>,
    command: &Value,
    event_type: &'static str,
    patch: impl FnOnce(&mut Value, &str) -> Result<(), CommandError>,
) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let mut thread = live_thread(tx, &thread_id)?;
    let before = thread.clone();
    let now = tx.now().to_owned();
    patch(&mut thread, &now)?;
    // A setter that changes nothing writes nothing, so a retry or a double click is quiet.
    if thread != before {
        let cid = command["commandId"].as_str().map(str::to_owned);
        tx.append(Draft::new(&thread_id, event_type, thread).command(cid.as_deref()))?;
    }
    Ok(vec![])
}

fn is_null(thread: &Value, field: &str) -> bool {
    thread.get(field).is_none_or(Value::is_null)
}

fn thread_settle(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    if let Some(expected) = command["expectedLatestRunId"].as_str() {
        let latest = tx
            .entities(&thread_id, "runs")?
            .into_iter()
            .filter(|r| r["status"] != "queued")
            .max_by_key(|r| r["ordinal"].as_u64().unwrap_or(0));
        if latest.is_some_and(|r| r["id"] != expected) {
            return Ok(vec![]);
        }
    }
    if command["type"] == "thread.auto-settle" {
        let thread = live_thread(tx, &thread_id)?;
        if !is_null(&thread, "autoSettleDisabledAt") || !is_null(&thread, "pinnedAt") {
            return Ok(vec![]);
        }
    }
    if active_run(tx, &thread_id)?.is_some() {
        return reject(format!(
            "Thread {thread_id} is still running and cannot be settled."
        ));
    }
    let settled_at = command["settledAt"].clone();
    thread_patch(tx, &command, "thread.settled", |t, now| {
        let already =
            t["settledOverride"] == "settled" && !is_null(t, "settledAt") && is_null(t, "pinnedAt");
        t["settledOverride"] = json!("settled");
        if !already {
            t["settledAt"] = if settled_at.is_string() {
                settled_at
            } else {
                json!(now)
            };
        }
        for field in [
            "unsettledAt",
            "pinnedAt",
            "pinOrderKey",
            "activeOrderKey",
            "snoozedUntil",
            "snoozedAt",
        ] {
            t[field] = Value::Null;
        }
        if !already {
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })?;
    Ok(vec![Effect::ThreadClosed {
        thread_id,
        reason: crate::ThreadClose::Settled,
    }])
}

fn thread_unsettle(tx: &mut Tx<'_>, command: Value) -> Outcome {
    thread_patch(tx, &command, "thread.unsettled", |t, now| {
        if t["settledOverride"] != "active" {
            t["settledOverride"] = json!("active");
            t["settledAt"] = Value::Null;
            t["unsettledAt"] = json!(now);
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })
}

/// `thread.snooze` as `Orchestrator.ts`: the wake time must parse and be in the future, a
/// pending approval refuses it, and only queued runs a person asked for block it. The wake time
/// is stored as UTC in the wire form.
fn thread_snooze(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let requested = command["snoozedUntil"].as_str().unwrap_or_default();
    let now = crate::time::millis_from_iso(tx.now()).unwrap_or(0);
    let Some(until) = crate::time::millis_from_iso(requested).filter(|at| *at > now) else {
        return reject(format!(
            "Thread {thread_id} snooze wake time {requested} is not in the future."
        ));
    };
    let pending_approval = tx
        .entities_where(&thread_id, "runtimeRequests", "status", "pending")?
        .iter()
        .any(|request| request["kind"] != "user_input");
    if pending_approval {
        return reject(format!(
            "Thread {thread_id} has a pending approval and cannot be snoozed."
        ));
    }
    for run in queued_runs(tx, &thread_id)? {
        let message_id = run["userMessageId"].as_str().unwrap_or_default();
        let message = tx.entity(&thread_id, "messages", message_id)?;
        if !message.as_ref().is_some_and(is_automatic) {
            return reject(format!(
                "Thread {thread_id} has a queued run and cannot be snoozed."
            ));
        }
    }
    let until = crate::time::iso_from_millis(until);
    thread_patch(tx, &command, "thread.snoozed", |t, now| {
        t["snoozedUntil"] = json!(until);
        t["snoozedAt"] = json!(now);
        t["updatedAt"] = json!(now);
        Ok(())
    })
}

/// A message the server queued by itself: a notification or a delegated-task completion. This
/// engine marks its completion wakes by their id (`families::deliver`).
fn is_automatic(message: &Value) -> bool {
    !is_null(message, "notification")
        || !is_null(message, "delegatedCompletion")
        || message["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("message:delegated-completion:"))
}

fn thread_unsnooze(tx: &mut Tx<'_>, command: Value) -> Outcome {
    thread_patch(tx, &command, "thread.unsnoozed", |t, now| {
        if !is_null(t, "snoozedUntil") {
            t["snoozedUntil"] = Value::Null;
            t["snoozedAt"] = Value::Null;
            t["lastSnoozeWakeAt"] = json!(now);
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })
}

fn thread_auto_settle_set(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let enabled = command["enabled"] == true;
    thread_patch(tx, &command, "thread.auto-settle-set", |t, now| {
        if enabled != is_null(t, "autoSettleDisabledAt") {
            t["autoSettleDisabledAt"] = if enabled { Value::Null } else { json!(now) };
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })
}

fn thread_pin(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let order_key = command["orderKey"].clone();
    thread_patch(tx, &command, "thread.pinned", |t, now| {
        let was_pinned = !is_null(t, "pinnedAt");
        if !was_pinned {
            t["pinnedAt"] = json!(now);
            if order_key.is_string() {
                t["pinOrderKey"] = order_key;
            }
        }
        if t["settledOverride"] == "settled" {
            t["settledOverride"] = json!("active");
            t["settledAt"] = Value::Null;
            t["unsettledAt"] = json!(now);
        }
        if !is_null(t, "snoozedUntil") {
            t["lastSnoozeWakeAt"] = json!(now);
        }
        t["snoozedUntil"] = Value::Null;
        t["snoozedAt"] = Value::Null;
        t["updatedAt"] = json!(now);
        Ok(())
    })
}

fn thread_unpin(tx: &mut Tx<'_>, command: Value) -> Outcome {
    thread_patch(tx, &command, "thread.unpinned", |t, now| {
        if !is_null(t, "pinnedAt") {
            t["pinnedAt"] = Value::Null;
            t["pinOrderKey"] = Value::Null;
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })
}

fn thread_pin_reorder(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let key = command["orderKey"].clone();
    thread_patch(tx, &command, "thread.pin-reordered", |t, now| {
        if t["pinOrderKey"] != key {
            t["pinOrderKey"] = key;
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })
}

fn thread_active_reorder(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let key = command["orderKey"].clone();
    thread_patch(tx, &command, "thread.active-reordered", |t, _| {
        t["activeOrderKey"] = key;
        Ok(())
    })
}

fn thread_tag_set(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let tag = command["tag"].clone();
    let tagged = command["tagged"] == true;
    thread_patch(tx, &command, "thread.tags-updated", |t, _| {
        let mut tags: Vec<Value> = t["tags"].as_array().cloned().unwrap_or_default();
        tags.retain(|existing| *existing != tag);
        if tagged {
            tags.push(tag);
        }
        t["tags"] = json!(tags);
        Ok(())
    })
}

fn thread_mark_unread(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let completed = tx
        .entities(&thread_id, "runs")?
        .into_iter()
        .filter_map(|r| {
            r["completedAt"]
                .as_str()
                .and_then(crate::time::millis_from_iso)
        })
        .max();
    let Some(completed) = completed else {
        return reject(format!(
            "Thread {thread_id} has no completed run to mark unread."
        ));
    };
    thread_patch(tx, &command, "thread.marked-unread", |t, _| {
        t["lastVisitedAt"] = json!(crate::time::iso_from_millis(completed - 1));
        Ok(())
    })
}

fn pull_request_key(link: &Value) -> (Value, Value, Value) {
    let lower = |v: &Value| json!(v.as_str().unwrap_or_default().to_lowercase());
    (
        lower(&link["host"]),
        lower(&link["repository"]),
        link["number"].clone(),
    )
}

fn thread_pull_request_link(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let key = pull_request_key(&command);
    let mut link = json!({
        "host": command["host"],
        "repository": command["repository"],
        "number": command["number"],
        "url": command["url"],
        "source": command["source"],
        "linkedAt": tx.now(),
        "snapshot": null,
        "stack": null,
    });
    if command["repositoryWebUrl"].is_string() {
        link["repositoryWebUrl"] = command["repositoryWebUrl"].clone();
    }
    thread_patch(tx, &command, "thread.metadata-updated", |t, now| {
        let mut links = t["pullRequests"].as_array().cloned().unwrap_or_default();
        if links
            .iter()
            .any(|l| pull_request_key(l) == key && l["source"] != "stack-dismissed")
        {
            return Ok(());
        }
        links.retain(|l| pull_request_key(l) != key);
        links.push(link);
        t["pullRequests"] = json!(links);
        t["updatedAt"] = json!(now);
        Ok(())
    })
}

fn thread_pull_request_unlink(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let key = pull_request_key(&command);
    thread_patch(tx, &command, "thread.metadata-updated", |t, now| {
        let mut links = t["pullRequests"].as_array().cloned().unwrap_or_default();
        let before = links.len();
        links.retain(|l| pull_request_key(l) != key);
        if links.len() != before {
            t["pullRequests"] = json!(links);
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })
}

/// Dismisses a pending user question without an answer: the provider gets an empty answer.
fn thread_user_input_dismiss(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let request_id = command["requestId"].as_str().unwrap_or_default().to_owned();
    live_thread(tx, &thread_id)?;
    let Some(mut request) = tx.entity(&thread_id, "runtimeRequests", &request_id)? else {
        return reject(format!("Request {request_id} does not exist."));
    };
    if request["status"] != "pending" {
        return Ok(vec![]);
    }
    request["status"] = json!("cancelled");
    request["resolvedAt"] = json!(tx.now());
    let node = request["nodeId"].as_str().map(str::to_owned);
    tx.append(Draft::new(&thread_id, "runtime-request.updated", request).node(node.as_deref()))?;
    Ok(vec![Effect::Respond {
        thread_id,
        request: json!({"requestId": request_id, "decision": "cancel"}),
    }])
}

/// Ends the thread's provider session. The next turn opens a new one.
fn provider_session_detach(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    live_thread(tx, &thread_id)?;
    if active_run(tx, &thread_id)?.is_some() {
        return reject(format!(
            "Thread {thread_id} is running; stop it before detaching its session."
        ));
    }
    let session_id = command["providerSessionId"].as_str().unwrap_or_default();
    if let Some(mut session) = tx.entity(&thread_id, "providerSessions", session_id)? {
        session["status"] = json!("stopped");
        session["updatedAt"] = json!(tx.now());
        tx.append(Draft::new(&thread_id, "provider-session.updated", session))?;
    }
    Ok(vec![Effect::CloseSession { thread_id }])
}

/// `provider.switch`: the next turn runs on another provider instance. Its history does not
/// move to the new provider (no context handoff yet), so the new provider starts fresh.
fn provider_switch(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default();
    if active_run(tx, thread_id)?.is_some() {
        return reject(format!(
            "Thread {thread_id} is running; switch providers between turns."
        ));
    }
    let selection = normalize_model_selection(&command["modelSelection"]);
    switch_provider(tx, &command, selection)
}

/// Moves the thread to `selection`. A change of instance is refused while a run is active,
/// clears the active provider thread and closes the session.
fn switch_provider(tx: &mut Tx<'_>, command: &Value, selection: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let switching = live_thread(tx, &thread_id)?["providerInstanceId"] != selection["instanceId"];
    if switching && active_run(tx, &thread_id)?.is_some() {
        return reject(format!(
            "Thread {thread_id} is running; switch providers between turns."
        ));
    }
    thread_patch(tx, command, "thread.provider-switched", |t, now| {
        t["providerInstanceId"] = selection["instanceId"].clone();
        t["modelSelection"] = selection;
        if switching {
            t["activeProviderThreadId"] = Value::Null;
        }
        t["updatedAt"] = json!(now);
        Ok(())
    })?;
    Ok(if switching {
        vec![Effect::CloseSession { thread_id }]
    } else {
        vec![]
    })
}

/// Applies a generated title when it answers the thread's current request.
fn thread_title_regeneration_complete(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let request_id = command["requestId"].clone();
    let title = command["title"].clone();
    let outcome = command["outcome"].clone();
    thread_patch(tx, &command, "thread.metadata-updated", |t, now| {
        if t["titleRegeneration"]["requestId"] != request_id {
            return Ok(());
        }
        if let Some(title) = title.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            t["title"] = json!(title);
        }
        if outcome.is_object() {
            let mut last = outcome;
            last["requestId"] = request_id;
            last["completedAt"] = json!(now);
            t["lastTitleRegeneration"] = last;
        }
        t["titleRegeneration"] = Value::Null;
        t["updatedAt"] = json!(now);
        Ok(())
    })
}
