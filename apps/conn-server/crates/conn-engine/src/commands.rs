//! Command handlers. Each one reads what it needs, appends its events, and returns the side
//! effects to run after the commit. To support a new command, add one function and one line
//! in [`handler`].

use conn_provider::goal::GoalCommand;
use conn_support::ids::join_id;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::shell::{ACTIVE_RUN_STATUSES, LIVE_RUN_STATUSES};
use crate::store::{Draft, StoreResult, Tx};

/// Work that touches a provider. Runs after the command's events are committed. Stored as an
/// outbox row (`outbox.rs`); the tag is the row's `effect_type`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub(crate) enum Effect {
    /// Rolls a thread back to a checkpoint (`provider-thread.rollback`).
    #[serde(rename = "provider-thread.rollback")]
    Rollback(crate::rollback::RollbackRequest),
    /// Captures a run's checkpoint and finishes it (`checkpoint.capture`).
    #[serde(rename = "checkpoint.capture")]
    CaptureCheckpoint { thread_id: String, run_id: String },
    #[serde(rename = "provider-turn.start")]
    StartTurn { thread_id: String, run_id: String },
    /// Adds a message to a running turn. Falls back to the queue when the provider declines.
    #[serde(rename = "provider-turn.steer")]
    Steer {
        thread_id: String,
        run_id: String,
        message_id: String,
    },
    #[serde(rename = "provider-turn.interrupt")]
    Interrupt { thread_id: String, run_id: String },
    /// Stop ended the run before the provider accepted its turn: the start still in flight is
    /// abandoned (T3 cancels `provider-turn.start`). Runs at once, outside the lane.
    #[serde(rename = "provider-turn.abandon-start")]
    AbandonStart { thread_id: String, run_id: String },
    /// Stop on a thread whose latest run settled while its background work still runs: the
    /// provider gets `interruptTurn` with `requestRuntimeRestart` for that settled turn.
    #[serde(rename = "provider-turn.stop-background-work")]
    StopBackgroundWork { thread_id: String, run_id: String },
    #[serde(rename = "runtime-request.respond")]
    Respond { thread_id: String, request: Value },
    /// Ends the provider session; a workspace move does this too. Its MCP credential is
    /// revoked when the process ends, and kept for the thread's next session while a shared
    /// process (Codex's `app-server`) still runs, as T3 does.
    #[serde(rename = "provider-session.detach")]
    CloseSession { thread_id: String },
    /// Ends every provider session of a deleted thread, the ones a fresh run moved aside too.
    #[serde(rename = "provider-session.detach-thread")]
    CloseThreadSessions { thread_id: String },
    /// Sends a model selection to the thread's running provider turn
    /// (`provider-session.apply-model-selection`). The provider applies what it can live; the
    /// rest waits for the next turn.
    #[serde(rename = "provider-session.apply-model-selection")]
    ApplyModelSelection { thread_id: String, selection: Value },
    /// Its outbox row outlives a server update, so each field a later build adds takes
    /// `#[serde(default)]`: a row stored before the field existed still decodes.
    #[serde(rename = "attachment.cleanup")]
    CleanupHtmlAttachments {
        thread_id: String,
        #[serde(default)]
        ids: Vec<(String, String)>,
    },
    /// Tells the host a remote task of `thread_id` now owes its thread there a stop, so its
    /// follower runs again (T3's `RemoteDelegation.start` stream of `subagent.updated`).
    #[serde(rename = "delegated-task.remote-changed")]
    RemoteTaskChanged { thread_id: String, task_id: String },
    /// Tells the host a thread was archived, deleted or settled (its terminals close).
    #[serde(rename = "thread.closed")]
    ThreadClosed {
        thread_id: String,
        #[serde(deserialize_with = "close_reason")]
        reason: crate::ThreadClose,
    },
    /// Asks the title generator; answers with `thread.title.regeneration.complete`.
    #[serde(rename = "thread-title.generate")]
    GenerateTitle {
        thread_id: String,
        request_id: String,
        regenerate: bool,
    },
}

/// A close's reason as an outbox row stores it. A row from before closes named their
/// settlement holds the bare `"settled"`.
fn close_reason<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<crate::ThreadClose, D::Error> {
    let reason = Value::deserialize(deserializer)?;
    if reason == "settled" {
        return Ok(crate::ThreadClose::SettledUnnamed);
    }
    serde_json::from_value(reason).map_err(serde::de::Error::custom)
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
        "thread.created.record" => thread_created_record,
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
        "thread.issue.link" | "thread.issue.unlink" => thread_issue_link,
        "thread.pull-request.unlink" => thread_pull_request_unlink,
        "thread.pull-request.watch" => thread_pull_request_watch,
        "thread.pull-request-link.sync" => thread_pull_request_link_sync,
        "thread.pull-request.sync" => thread_pull_request_sync,
        "thread.user-input.dismiss" => thread_user_input_dismiss,
        "provider-session.detach" => provider_session_detach,
        "provider.switch" => provider_switch,
        "thread.title.regeneration.complete" => thread_title_regeneration_complete,
        "delegated_task.request" => crate::families::delegated_task_request,
        "checkpoint.rollback" => crate::rollback::checkpoint_rollback,
        "thread.fork" => crate::fork::thread_fork,
        "thread.merge_back" => crate::merge_back::thread_merge_back,
        "delegated_task.wake-policy" => crate::families::wake_policy,
        "delegated_task.completion-delivery.acknowledge"
        | "delegated_task.completion-delivery.dispose" => crate::families::completion_delivery,
        _ => return None,
    })
}

/// Why a contract command this engine does not handle is refused. The client shows the text.
pub(crate) fn refusal(command_type: &str) -> &'static str {
    match command_type {
        "prepared-run.release"
        | "prepared-run.progress"
        | "prepared-run.fail"
        | "prepared-run.retry" => "Conn Server does not prepare worktrees for runs yet.",
        "thread.guest-share.close" | "thread.guest-message.dismiss" => {
            "Conn Server does not share threads with guests."
        }
        "notification.delivery.accept" => {
            "Conn Server does not deliver background notifications yet."
        }
        "subagent.stop" => {
            "Conn Server cannot stop a single subagent yet; stop the thread instead."
        }

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
    let initial_message = command.get("initialMessage").cloned();
    let link_origin = command.get("linkOrigin").cloned();
    let delegated_from = command.get("delegatedFrom").cloned();
    let c: ThreadCreate = decode(command)?;
    if tx.thread(&c.thread_id)?.is_some() {
        return reject(format!("Thread {} already exists.", c.thread_id));
    }
    // T3's `dispatchThreadCreate` does not look the project up: a thread may name a project
    // this server does not know (its replay fixtures do). `launchThread` checks it.
    let model = normalize_model_selection(&c.model_selection);
    let now = tx.now().to_owned();
    let mut thread = json!({
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
    if let Some(origin) = link_origin {
        thread["linkOrigin"] = origin;
        // Only stamped work names a remote parent.
        if let Some(from) = delegated_from.filter(Value::is_object) {
            thread["delegatedFrom"] = from;
        }
    }
    tx.append(
        Draft::new(&c.thread_id, "thread.created", thread)
            .command(Some(&c.command_id))
            .payload_instance(),
    )?;
    if let Some(mut message) = initial_message {
        message["type"] = json!("message.dispatch");
        message["threadId"] = json!(c.thread_id);
        message["commandId"] = json!(c.command_id);
        message["createdBy"] = json!(c.created_by);
        message["creationSource"] = json!(c.creation_source);
        message["dispatchMode"] = json!({"type":"start_immediately"});
        return message_dispatch(tx, message);
    }
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
    sender_thread_id: Option<String>,
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
    /// The server's own `/compact` before a prompt cache expires (`IdleCompactionService`).
    idle_compaction: Option<String>,
    /// The run's provider instance's capabilities, which the engine adds before the command
    /// reaches its handler (`ensureContextHandoff` for a provider switch).
    target_capabilities: Option<Value>,
}

/// How a message reaches the thread, after the busy-thread rules.
enum Delivery {
    Start,
    Queue { first: bool },
    Steer(Value),
}

/// `resolveDeliveryIntent` in `CommandPolicy.ts`, for one provider that may or may not steer:
/// we steer into a running provider turn and let the provider decline (then it queues).
fn delivery(
    tx: &Tx<'_>,
    c: &mut MessageDispatch,
    goal: Option<&GoalCommand>,
) -> Result<(Delivery, Option<Value>), CommandError> {
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
            Some("steer" | "restart" | "auto") => Some(active.clone()),
            _ => None,
        },
        _ => None,
    };
    if let Some(goal) = goal {
        let target = match c.dispatch_mode.kind.as_str() {
            "queue_after_active" if c.delivery_intent.is_some() => Some(active),
            _ => steer_target.clone(),
        };
        if let Some(target) = target {
            let stops = goal_stops_run(tx, &c.thread_id, goal, &target)?;
            // A goal stays its own run: never a steer, now or once the turn runs.
            c.dispatch_mode = DispatchMode {
                kind: "queue_after_active".into(),
                target_run_id: None,
            };
            return Ok(if stops {
                (Delivery::Queue { first: true }, Some(target))
            } else {
                (Delivery::Queue { first: false }, None)
            });
        }
    }
    // A steer on another instance cannot join the running turn: it restarts there, with the
    // conversation (`selectionMustApplyNow` in `dispatchMessage`).
    let requested = match &c.model_selection {
        Some(selection) => selection["instanceId"].clone(),
        None => tx
            .thread(&c.thread_id)?
            .map_or(Value::Null, |t| t["modelSelection"]["instanceId"].clone()),
    };
    let switches = steer_target
        .as_ref()
        .is_some_and(|t| requested.is_string() && t["providerInstanceId"] != requested);
    let restart = switches
        || c.dispatch_mode.kind == "restart_active"
        || c.delivery_intent.as_deref() == Some("restart");
    Ok(match steer_target {
        // Interrupt-and-restart: the message goes first in the queue and the turn stops.
        Some(target) if restart => (Delivery::Queue { first: true }, Some(target)),
        Some(target) if turn_running(&target)? => (Delivery::Steer(target), None),
        _ => (Delivery::Queue { first: false }, None),
    })
}

/// `validateReusableThread` in T3's `ThreadLaunchService`: a launch may reuse only an empty,
/// active thread of its own project.
fn check_reusable(tx: &Tx<'_>, thread_id: &str, project_id: &str) -> Result<(), CommandError> {
    let thread = live_thread(tx, thread_id)?;
    if thread["projectId"] != project_id
        || !thread["archivedAt"].is_null()
        || !thread["deletedAt"].is_null()
        || is_used(tx, thread_id)?
    {
        return reject(
            "Only an empty active thread in the target project can change workspace during launch.",
        );
    }
    Ok(())
}

/// A thread with a message or a run: what `expectedEmpty` and `onlyIfUnused` read.
fn is_used(tx: &Tx<'_>, thread_id: &str) -> Result<bool, CommandError> {
    Ok(tx.has(thread_id, "messages")? || tx.has(thread_id, "runs")?)
}

/// `exceededDispatchModeLimit` and `OrchestratorThreadAboveModeLimitError`.
fn refuse_above_mode_limit(
    thread_id: &str,
    thread: &Value,
    limit: &Value,
) -> Result<(), CommandError> {
    use conn_support::modes::{interaction_rank, runtime_rank};
    let mode = |v: &Value, key: &str| v[key].as_str().unwrap_or_default().to_owned();
    let (runtime, interaction) = (mode(thread, "runtimeMode"), mode(thread, "interactionMode"));
    if runtime_rank(&runtime) > runtime_rank(&mode(limit, "runtimeMode"))
        || interaction_rank(&interaction) > interaction_rank(&mode(limit, "interactionMode"))
    {
        return reject(format!(
            "Thread {thread_id} now runs in {runtime}/{interaction} mode, above what this caller may change."
        ));
    }
    Ok(())
}

/// A launch's own checks, run in its command's write before the decision. T3 runs them in
/// `ThreadLaunchService` (`validateReusableThread`, the project check, `DispatchModeLimit`),
/// outside the orchestrator: a refusal here is no outcome of the command, so it records no
/// receipt and the launch id stays usable.
pub(crate) fn admit_launch(tx: &Tx<'_>, command: &Value) -> Result<(), CommandError> {
    let Some(thread_id) = command["threadId"].as_str() else {
        return Ok(());
    };
    if let Some(project) = command["launchProjectId"].as_str()
        && live_thread(tx, thread_id)?["projectId"] != project
    {
        return reject("Project identity changed.");
    }
    if let Some(project) = command["reuseProjectId"].as_str() {
        check_reusable(tx, thread_id, project)?;
    }
    // The checkout the launch's claim recorded: T3 carries the workspace with the accepted
    // message, so a reuse that rebound the thread meanwhile does not move this one.
    if let Some(checkout) = command.get("launchCheckout").filter(|c| c.is_object())
        && live_thread(tx, thread_id)?["worktreePath"] != checkout["worktreePath"]
    {
        return reject("The thread's checkout changed during the launch.");
    }
    if let Some(limit) = command.get("modeLimit").filter(|l| l.is_object()) {
        refuse_above_mode_limit(thread_id, &live_thread(tx, thread_id)?, limit)?;
    }
    Ok(())
}

/// `isNativeMaintenanceCommand`: compaction and sign-out, which take no steering input.
fn is_native_maintenance(message: &Value) -> bool {
    let text =
        conn_support::text::js_trim(message["text"].as_str().unwrap_or_default()).to_lowercase();
    message["attachments"].as_array().is_none_or(Vec::is_empty)
        && matches!(text.as_str(), "/compact" | "/logout")
}

/// `goalDriverFor` and `ensureGoalCommandSupported`: the `/goal` in a message sent to
/// `instance`, when that provider runs native goals. A control it cannot run is refused.
fn native_goal(
    tx: &Tx<'_>,
    text: &str,
    has_attachments: bool,
    instance: &str,
) -> Result<Option<GoalCommand>, CommandError> {
    let Some(goal) = conn_provider::goal::parse_command(text, has_attachments) else {
        return Ok(None);
    };
    match tx.driver(instance).as_deref() {
        Some("claudeAgent") if matches!(goal, GoalCommand::Pause | GoalCommand::Resume) => {
            reject("Claude goals cannot be paused or resumed. Send /goal clear to remove the goal.")
        }
        Some("codex" | "claudeAgent") => Ok(Some(goal)),
        _ => Ok(None),
    }
}

/// The goal rule of `dispatchMessage` and `promoteQueuedMessageToSteer` for a native `/goal`
/// aimed at `target`: whether it stops the run (`goalCommandStopsActiveRun`), from the goal on
/// the run's provider thread. A run that is only finishing is never stopped, nor a compaction
/// or sign-out.
fn goal_stops_run(
    tx: &Tx<'_>,
    thread_id: &str,
    goal: &GoalCommand,
    target: &Value,
) -> Result<bool, CommandError> {
    let provider_thread = match target["providerThreadId"].as_str() {
        Some(id) => tx.entity(thread_id, "providerThreads", id)?,
        None => None,
    };
    let live = matches!(
        target["status"].as_str(),
        Some("preparing" | "starting" | "running")
    );
    let goal_status = provider_thread
        .as_ref()
        .and_then(|pt| pt["goal"]["status"].as_str());
    let maintenance = match target["userMessageId"].as_str() {
        Some(id) => tx
            .entity(thread_id, "messages", id)?
            .is_some_and(|m| is_native_maintenance(&m)),
        None => false,
    };
    Ok(live && goal.stops_active_run(goal_status) && !maintenance)
}

pub(crate) fn message_dispatch(tx: &mut Tx<'_>, command: Value) -> Outcome {
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
    // A user's fresh send supersedes a pending fork, or the next send would bring the
    // parent's context back; a schedule's is a side conversation and was refused above.
    if fresh && let Some(mut transfer) = crate::fork::pending_fork(tx, &c.thread_id)? {
        transfer["status"] = json!("superseded");
        transfer["error"] = json!("Superseded by a fresh session.");
        transfer["updatedAt"] = json!(tx.now());
        tx.append(
            Draft::new(&c.thread_id, "context-transfer.updated", transfer)
                .command(Some(&c.command_id)),
        )?;
    }
    let fork = crate::fork::decide_fork_execution(
        tx,
        &thread,
        c.model_selection
            .as_ref()
            .unwrap_or(&thread["modelSelection"])["instanceId"]
            .as_str()
            .unwrap_or_default(),
        c.target_capabilities.as_ref(),
        &c.command_id,
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
    // The service checked idleness before this command; a run or a delegated result that
    // landed since makes the thread busy, and that turn refreshes the cache anyway
    // (`Orchestrator.ts:7027`). A result is undelivered while its wake message is pending.
    if c.idle_compaction.as_deref() == Some("beforeCacheExpires")
        && (tx
            .entities(&c.thread_id, "runs")?
            .iter()
            .any(|run| run["status"] == "queued" || is_active(run))
            || tx
                .entities(&c.thread_id, "subagents")?
                .iter()
                .any(crate::families::completion_undelivered))
    {
        return Ok(vec![]);
    }
    // After a failed or stopped worktree setup, work waits for a worktree rather than start
    // in the project checkout (`worktreeMissingRun`).
    let worktree_missing = matches!(
        c.dispatch_mode.kind.as_str(),
        "queue_after_active" | "start_immediately"
    ) && active_run(tx, &c.thread_id)?.is_none()
        && is_null(&thread, "worktreePath")
        && latest_executed_run(tx, &c.thread_id)?.is_some_and(|run| failed_worktree_setup(&run));
    let instance = normalize_model_selection(
        c.model_selection
            .as_ref()
            .unwrap_or(&thread["modelSelection"]),
    )["instanceId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let goal = native_goal(tx, &c.text, !c.attachments.is_empty(), &instance)?;
    let (delivery, interrupt) = delivery(tx, &mut c, goal.as_ref())?;
    if let Delivery::Steer(target) = delivery {
        return steer_into(tx, &c, &target);
    }
    let delivery = match delivery {
        Delivery::Start if worktree_missing => Delivery::Queue { first: false },
        other => other,
    };
    let setup_pending = worktree_setup_pending(tx, &c.thread_id)?;
    // A client send releases a queue that Stop or a failure held; server messages, such as
    // an async answer, scheduled tasks and steer follow-ups do not (`sentByUserFromClient`).
    if c.created_by == "user"
        && matches!(c.creation_source.as_str(), "web" | "mobile")
        && c.steer_follow_up_of_run_id.is_none()
        && c.scheduled_task_id.is_none()
        && !setup_pending
    {
        release_held(tx, &c.thread_id)?;
    }
    let queued = matches!(delivery, Delivery::Queue { .. });
    let ordinal = tx.next_run_ordinal(&c.thread_id)?;
    let run_id = format!("run:{}:{ordinal}", c.thread_id);
    let root = format!("node:{run_id}:root");
    let model = normalize_model_selection(
        c.model_selection
            .as_ref()
            .unwrap_or(&thread["modelSelection"]),
    );
    // A fresh run starts a new provider thread when it runs.
    let mut provider_thread_id = if fresh {
        Value::Null
    } else {
        thread["activeProviderThreadId"].clone()
    };
    let now = tx.now().to_owned();
    let cid = Some(c.command_id.as_str());
    // A run on another instance than the conversation's carries its history there. A queued
    // run decides when it starts (`start_next_queued`).
    let from = if fresh || queued {
        None
    } else {
        crate::provider_handoff::conversation_instance(tx, &thread, c.notification.is_some())?
    };
    let created_by = json!(c.created_by);
    let place = crate::provider_handoff::Place {
        thread_id: &c.thread_id,
        run_id: &run_id,
        root_node_id: &root,
        ordinal,
        model_selection: &model,
        created_by: &created_by,
        requires_full: !crate::merge_back::pending(tx, &c.thread_id)?.is_empty(),
        queued: false,
        now: &now,
    };
    let switch = match (&fork, from) {
        (crate::fork::ForkExecution::Portable(pending), _) => Some(
            crate::provider_handoff::prepare_fork(tx, &thread, &place, pending)?,
        ),
        (_, Some(from)) if from != model["instanceId"] => {
            crate::provider_handoff::prepare(tx, &thread, &place)?
        }
        _ => None,
    };
    if let Some(switch) = &switch {
        if let Some(capabilities) = &c.target_capabilities {
            switch.ensure_supported(
                capabilities,
                model["instanceId"].as_str().unwrap_or_default(),
                &c.command_id,
            )?;
        }
        provider_thread_id = switch.provider_thread_id.clone();
    }
    let draft = |event_type, payload| {
        Draft::new(&c.thread_id, event_type, payload)
            .run(Some(&run_id))
            .node(Some(&root))
            .command(cid)
    };
    let merge_back = crate::merge_back::consume(
        tx,
        &crate::merge_back::RunPlace {
            thread_id: &c.thread_id,
            run_id: &run_id,
            root_node_id: &root,
            ordinal,
            provider_thread_id: &provider_thread_id,
            model_selection: &model,
            queued,
            fresh,
            now: &now,
        },
    )?;

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
    // A provider result arriving while a held queue waits still drains, unless Stop reached
    // the active run (`wakeSkipsHold`): it replays output the CLI already produced.
    let wake_skips_hold = c.created_by == "agent"
        && c.creation_source == "provider"
        && !setup_pending
        && match active_run(tx, &c.thread_id)? {
            Some(active) => {
                interrupt_request(tx, &c.thread_id, active["id"].as_str().unwrap_or_default())?
                    .is_none()
            }
            None => false,
        };
    let held = worktree_missing
        || (queued
            && !wake_skips_hold
            && queued_runs(tx, &c.thread_id)?
                .iter()
                .any(|r| r["queueHeld"] == true));
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
        "contextHandoffId": switch
            .as_ref()
            .map(|s| &s.handoff)
            .or(merge_back.as_ref().map(|m| &m.handoff))
            .map(|h| h["id"].clone()),
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
    // A run the thread queues for itself continues the task of the run that sent it.
    let continued = match &c.restart_continuation_of_run_id {
        Some(source) => tx.entity(&c.thread_id, "runs", source)?,
        None if c.sender_thread_id.as_deref() == Some(c.thread_id.as_str()) => {
            active_run(tx, &c.thread_id)?
        }
        None => None,
    };
    if let Some(task) = continued.as_ref().map(|r| &r["delegatedTaskId"])
        && task.is_string()
    {
        run["delegatedTaskId"] = task.clone();
    }
    if let Some(switch) = &switch {
        switch.append_records(tx, &c.thread_id, &run_id, cid)?;
    }
    if let Some(merge_back) = &merge_back {
        crate::merge_back::append_records(
            tx,
            merge_back,
            &run_id,
            cid,
            &c.thread_id,
            model["instanceId"].as_str(),
        )?;
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
        // An unpinned scheduled run follows the thread's selection (`Orchestrator.ts`).
        if c.model_selection.is_none() {
            message["followsThreadSelection"] = json!(true);
        }
    }
    if let Some(sender) = &c.sender_thread_id {
        message["senderThreadId"] = json!(sender);
    }
    if let Some(mode) = &c.idle_compaction {
        message["idleCompaction"] = json!(mode);
    }
    // One handoff item per run: the merge-back's, with the switch's sources when both.
    let handoff_item = match (&merge_back, &switch) {
        (Some(merge_back), Some(switch)) => {
            let mut item = merge_back.turn_item.clone();
            let (instances, selections) = switch.sources();
            item["fromProviderInstanceIds"] = instances;
            item["fromModelSelections"] = selections;
            Some(item)
        }
        (Some(merge_back), None) => Some(merge_back.turn_item.clone()),
        (None, Some(switch)) => Some(switch.turn_item.clone()),
        (None, None) => None,
    };
    if let Some(item) = handoff_item {
        tx.append(draft("turn-item.updated", item))?;
    }
    tx.append(draft("message.updated", message))?;
    crate::families::record_follow_up(
        tx,
        &crate::families::FollowUpSource {
            command_id: &c.command_id,
            thread_id: &c.thread_id,
            run_id: &run_id,
            text: &c.text,
            created_by: &c.created_by,
            creation_source: &c.creation_source,
            sender_thread_id: c.sender_thread_id.as_deref(),
            notification: c.notification.as_ref(),
            excluded: c.scheduled_task_id.is_some() || c.restart_continuation_of_run_id.is_some(),
        },
    )?;
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
        // A rename before the first message keeps that name (#38683).
        Some(seed)
            if !seed.is_empty()
                && thread["titleRenamed"] != json!(true)
                && tx.count(&c.thread_id, "messages")? == 1 =>
        {
            Some(seed)
        }
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
        tx.append(
            Draft::new(&c.thread_id, "thread.metadata-updated", thread)
                .command(cid)
                .payload_instance(),
        )?;
    }
    if let Some(target) = interrupt {
        // A run stopped before its provider started also abandons that start, and the
        // restart's message starts at once (T3's queued command path).
        effects.extend(stop_run(tx, &c.thread_id, &target, None, false)?);
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

/// T3's refusals of a fresh start (`dispatchMessage`): not a schedule's while a fork is still
/// being applied (a user's supersedes the fork), and not while the current session runs background work that a new session would
/// end, unless a schedule sent it (nobody is there to wait or press Stop).
fn fresh_context_allowed(
    tx: &Tx<'_>,
    c: &MessageDispatch,
    thread: &Value,
) -> Result<(), CommandError> {
    if !crate::merge_back::pending(tx, &c.thread_id)?.is_empty() {
        return reject("Send a message without /clear to apply the merged context first.");
    }
    if c.scheduled_task_id.is_some() && crate::fork::pending_fork(tx, &c.thread_id)?.is_some() {
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
    if let Some(sender) = &c.sender_thread_id {
        message["senderThreadId"] = json!(sender);
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

/// `releaseUnattendedHolds`: a hold waits for a person to review what they queued. Nobody
/// reviews what agents, the server or scheduled tasks queued, so the thread's newest run
/// completing without a Stop releases those, before the next run is picked.
pub(crate) fn release_unattended_holds(
    tx: &mut Tx<'_>,
    thread_id: &str,
    completed_run_id: &str,
) -> StoreResult<()> {
    let held: Vec<Value> = queued_runs(tx, thread_id)?
        .into_iter()
        .filter(|run| run["queueHeld"] == true)
        .collect();
    if held.is_empty()
        || latest_executed_run(tx, thread_id)?.is_none_or(|run| run["id"] != completed_run_id)
        || interrupt_request(tx, thread_id, completed_run_id)?.is_some()
        || worktree_setup_pending(tx, thread_id)?
    {
        return Ok(());
    }
    for mut run in held {
        let message = match run["userMessageId"].as_str() {
            Some(id) => tx.entity(thread_id, "messages", id)?,
            None => None,
        };
        let unattended =
            message.is_some_and(|m| m["createdBy"] != "user" || !is_null(&m, "scheduledTaskId"));
        if unattended {
            run["queueHeld"] = json!(false);
            let id = run["id"].as_str().unwrap_or_default().to_owned();
            tx.append(Draft::new(thread_id, "run.updated", run).run(Some(&id)))?;
        }
    }
    Ok(())
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

/// Cancels the queued runs of buffered provider notifications: their output lived in the
/// provider process that is gone (T3's `isBufferedProviderNotification` at recovery).
pub(crate) fn cancel_buffered_notifications(tx: &mut Tx<'_>, thread_id: &str) -> StoreResult<()> {
    for run in queued_runs(tx, thread_id)? {
        let message_id = run["userMessageId"].as_str().unwrap_or_default();
        let buffered = tx
            .entity(thread_id, "messages", message_id)?
            .is_some_and(|m| {
                m["createdBy"] == "agent"
                    && m["creationSource"] == "provider"
                    && !is_null(&m, "notification")
                    && is_null(&m, "delegatedCompletion")
            });
        if buffered {
            let run_id = run["id"].as_str().unwrap_or_default();
            finish_run(tx, thread_id, run_id, "cancelled", None)?;
        }
    }
    Ok(())
}

/// Sets `queueHeld` on every queued run, so they wait for the user.
pub(crate) fn hold_queue(tx: &mut Tx<'_>, thread_id: &str) -> StoreResult<()> {
    hold_queued(tx, thread_id, Held::All)
}

/// Which queued runs a hold leaves free.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Held {
    All,
    /// A provider failure leaves buffered provider notifications free: they replay output the
    /// CLI already produced and prompt nothing (T3's `startNextQueuedRun`).
    ExceptBufferedWakes,
}

/// T3's `isBufferedProviderNotification`: a wake the provider buffered, not a delegated result.
fn is_buffered_provider_notification(message: &Value) -> bool {
    message["createdBy"] == "agent"
        && message["creationSource"] == "provider"
        && message["notification"].is_object()
        && is_null(message, "delegatedCompletion")
}

pub(crate) fn hold_queued(tx: &mut Tx<'_>, thread_id: &str, held: Held) -> StoreResult<()> {
    for mut run in queued_runs(tx, thread_id)? {
        if held == Held::ExceptBufferedWakes && run["queueHeld"] != true {
            let message = match run["userMessageId"].as_str() {
                Some(id) => tx.entity(thread_id, "messages", id)?,
                None => None,
            };
            if message.is_some_and(|m| is_buffered_provider_notification(&m)) {
                continue;
            }
        }
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
/// Whether the next queued run the queue would start runs on the failed run's provider.
/// Stale pull request wakes at the head of the queue are dropped first, as T3's
/// `startNextQueuedRun` drops them before it compares providers.
pub(crate) fn next_runs_on_failed_provider(
    tx: &mut Tx<'_>,
    thread_id: &str,
    failed_run_id: &str,
) -> StoreResult<bool> {
    let (Some(thread), Some(failed)) = (
        tx.thread(thread_id)?,
        tx.entity(thread_id, "runs", failed_run_id)?,
    ) else {
        return Ok(false);
    };
    let next = loop {
        let Some(next) = queued_runs(tx, thread_id)?
            .into_iter()
            .find(|run| run["queueHeld"] != true)
        else {
            return Ok(false);
        };
        let message = match next["userMessageId"].as_str() {
            Some(id) => tx.entity(thread_id, "messages", id)?,
            None => None,
        };
        // Only a pull request wake needs the thread's history.
        let stale = match message.filter(crate::pull_requests::is_watch_wake) {
            Some(message) => crate::pull_requests::stale_wake(
                &thread,
                &tx.entities(thread_id, "messages")?,
                &message,
            ),
            None => false,
        };
        if !stale {
            break next;
        }
        let id = next["id"].as_str().unwrap_or_default().to_owned();
        finish_run(tx, thread_id, &id, "cancelled", None)?;
    };
    Ok(
        effective_selection(tx, thread_id, &thread, &next)?["instanceId"]
            == failed["providerInstanceId"],
    )
}

/// `latestExecutedRun`: the run that ran last. Unfinished runs count as latest, then by end
/// time, then by ordinal; queued runs and runs cancelled before they started do not count.
pub(crate) fn latest_executed_run(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Option<Value>> {
    let key = |run: &Value| {
        (
            run["completedAt"]
                .as_str()
                .map_or("\u{10FFFF}".to_owned(), str::to_owned),
            run["ordinal"].as_u64().unwrap_or(0),
        )
    };
    Ok(tx
        .entities(thread_id, "runs")?
        .into_iter()
        .filter(|run| {
            run["status"] != "queued"
                && !(run["status"] == "cancelled" && is_null(run, "startedAt"))
        })
        .max_by_key(key))
}

/// A run whose worktree setup failed or was stopped, on a thread with no checkout of its own:
/// work started now would run in the project checkout (`worktreeSetupPending`). Runs imported
/// from T3 carry `workspacePreparation`.
fn failed_worktree_setup(run: &Value) -> bool {
    matches!(run["status"].as_str(), Some("failed" | "interrupted"))
        && run["workspacePreparation"]["type"] == "worktree"
}

/// `worktreeSetupPending`.
pub(crate) fn worktree_setup_pending(tx: &Tx<'_>, thread_id: &str) -> StoreResult<bool> {
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(false);
    };
    Ok(is_null(&thread, "worktreePath")
        && tx
            .entities(thread_id, "runs")?
            .iter()
            .any(failed_worktree_setup))
}

/// `usageLimitHoldsQueue`: the provider instance's last run failed on its usage limit, and
/// that is still the thread's last run, or (with `now`) its reset is still ahead.
pub(crate) fn usage_limit_holds(
    tx: &Tx<'_>,
    thread_id: &str,
    instance: &str,
    now: Option<&str>,
) -> StoreResult<bool> {
    let runs = tx.entities(thread_id, "runs")?;
    let key = |run: &&Value| {
        (
            run["completedAt"]
                .as_str()
                .map_or("\u{10FFFF}".to_owned(), str::to_owned),
            run["ordinal"].as_u64().unwrap_or(0),
        )
    };
    let Some(limited) = runs
        .iter()
        .filter(|run| {
            run["providerInstanceId"] == instance
                && run["status"] != "queued"
                && !(run["status"] == "cancelled" && is_null(run, "startedAt"))
        })
        .max_by_key(key)
        .filter(|run| run["status"] == "failed")
    else {
        return Ok(false);
    };
    let run_id = limited["id"].as_str().unwrap_or_default();
    let failure = tx
        .entities_where(thread_id, "turnItems", "runId", run_id)?
        .into_iter()
        .filter(|item| {
            item["type"] == "error"
                && item["status"] == "failed"
                && item["nodeId"] == limited["rootNodeId"]
        })
        .max_by(|a, b| {
            let at = |i: &Value| i["updatedAt"].as_str().unwrap_or_default().to_owned();
            at(a).cmp(&at(b))
        })
        .map(|item| item["failure"].clone());
    let Some(failure) = failure.filter(|f| f["class"] == "usage_limit") else {
        return Ok(false);
    };
    // A newer session error replaces the limit (`threadErrorSummary`).
    let session_error = tx
        .entities_where(
            thread_id,
            "providerSessions",
            "providerInstanceId",
            instance,
        )?
        .into_iter()
        .max_by_key(|s| s["updatedAt"].as_str().unwrap_or_default().to_owned())
        .map(|s| s["lastError"].clone())
        .filter(|e| !e.is_null());
    if session_error.is_some_and(|e| e != failure["message"]) {
        return Ok(false);
    }
    if latest_executed_run(tx, thread_id)?.is_some_and(|latest| latest["id"] == run_id) {
        return Ok(true);
    }
    Ok(match (now, failure["resetAt"].as_str()) {
        (Some(now), Some(reset)) => {
            match (
                crate::time::millis_from_iso(reset),
                crate::time::millis_from_iso(now),
            ) {
                (Some(reset), Some(now)) => reset > now,
                _ => false,
            }
        }
        _ => false,
    })
}

/// `queuedRunModelSelection`: a queued run whose message follows the thread's conversation
/// (a delegated result, a message that follows the selection, a monitor wake that is not
/// buffered provider output) runs on the thread's current selection; others on their own.
pub(crate) fn effective_selection(
    tx: &Tx<'_>,
    thread_id: &str,
    thread: &Value,
    run: &Value,
) -> StoreResult<Value> {
    let message = match run["userMessageId"].as_str() {
        Some(id) => tx.entity(thread_id, "messages", id)?,
        None => None,
    };
    let follows = message.is_some_and(|m| {
        is_delegated_completion(&m)
            || m["followsThreadSelection"] == true
            || (m["notification"]["source"]["kind"] == "monitor"
                && !is_buffered_provider_notification(&m))
    });
    Ok(if follows && thread["modelSelection"].is_object() {
        thread["modelSelection"].clone()
    } else {
        run["modelSelection"].clone()
    })
}

/// Starts the next queued run on its own, as after a run ends.
pub(crate) fn start_next_queued(
    tx: &mut Tx<'_>,
    thread_id: &str,
    only: Option<&str>,
) -> StoreResult<Option<Effect>> {
    start_next_queued_as(tx, thread_id, only, false)
}

/// `user_started`: the user asked for it (Send now, resume), so a usage limit's reset time
/// does not hold it, only a limit that is still the thread's last run.
fn start_next_queued_as(
    tx: &mut Tx<'_>,
    thread_id: &str,
    only: Option<&str>,
    user_started: bool,
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
    let mut only = only;
    let mut run = loop {
        let next = queued_runs(tx, thread_id)?
            .into_iter()
            .find(|run| match only {
                Some(id) => run["id"] == id,
                None => run["queueHeld"] != true,
            });
        let Some(run) = next else {
            return Ok(None);
        };
        // A queued pull request wake whose watches all moved on is dropped, and one that
        // outlived some of them tells only the current ones (`startNextQueuedRun`).
        let message_id = run["userMessageId"].as_str().unwrap_or_default();
        let Some(message) = tx
            .entity(thread_id, "messages", message_id)?
            .filter(|m| m["notification"]["source"]["kind"] == "monitor")
        else {
            break run;
        };
        let messages = tx.entities(thread_id, "messages")?;
        let run_id = run["id"].as_str().unwrap_or_default().to_owned();
        if crate::pull_requests::stale_wake(&thread, &messages, &message) {
            finish_run(tx, thread_id, &run_id, "cancelled", None)?;
            only = None;
            continue;
        }
        if let Some(mut current) = crate::pull_requests::current_wake(&thread, &messages, &message)
        {
            current["updatedAt"] = json!(tx.now());
            let mut write = Draft::new(thread_id, "message.updated", current).run(Some(&run_id));
            if let Some(root) = run["rootNodeId"].as_str() {
                write = write.node(Some(root));
            }
            tx.append(write)?;
        }
        break run;
    };
    // A limited provider would fail and use up every waiting message; the queue keeps its
    // order and waits (`usageLimitHoldsQueue`).
    let now = (!user_started).then(|| tx.now().to_owned());
    let selection = effective_selection(tx, thread_id, &thread, &run)?;
    let instance = selection["instanceId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if usage_limit_holds(tx, thread_id, &instance, now.as_deref())? {
        return Ok(None);
    }
    run["modelSelection"] = selection;
    run["providerInstanceId"] = json!(instance);
    // A provider turned off for the project holds the queue for the user instead of starting
    // it (`startNextQueuedRun`).
    if !tx.queue_enabled(thread["projectId"].as_str(), &instance) {
        hold_queue(tx, thread_id)?;
        return Ok(None);
    }
    // The thread moves to the run's selection as it starts, so a run queued behind it that
    // follows the thread takes the same one (`startNextQueuedRun`).
    if run["modelSelection"] != thread["modelSelection"] {
        let event = if run["providerInstanceId"] == thread["providerInstanceId"] {
            "thread.model-selection-updated"
        } else {
            "thread.provider-switched"
        };
        let mut moved = thread.clone();
        moved["providerInstanceId"] = run["providerInstanceId"].clone();
        moved["modelSelection"] = run["modelSelection"].clone();
        moved["updatedAt"] = json!(tx.now());
        tx.append(Draft::new(thread_id, event, moved).payload_instance())?;
    }
    let run_id = run["id"].as_str().unwrap_or_default().to_owned();
    let root = run["rootNodeId"].as_str().unwrap_or_default().to_owned();
    let now = tx.now().to_owned();
    let message_id = run["userMessageId"].as_str().unwrap_or_default().to_owned();
    let draft = |event_type, payload| {
        Draft::new(thread_id, event_type, payload)
            .run(Some(&run_id))
            .node(Some(&root))
    };
    let message = tx.entity(thread_id, "messages", &message_id)?;
    // A run queued for another instance than the last run carries the history there.
    let switch = if run["freshContext"] == true {
        None
    } else {
        crate::provider_handoff::prepare(
            tx,
            &thread,
            &crate::provider_handoff::Place {
                thread_id,
                run_id: &run_id,
                root_node_id: &root,
                ordinal: run["ordinal"].as_u64().unwrap_or(0),
                model_selection: &run["modelSelection"],
                created_by: message.as_ref().map_or(&Value::Null, |m| &m["createdBy"]),
                requires_full: false,
                queued: true,
                now: &now,
            },
        )?
    };
    let provider_thread_id = match &switch {
        Some(switch) => switch.provider_thread_id.clone(),
        None => queued_provider_thread(&run, &thread),
    };
    if let Some(switch) = &switch {
        switch.append_records(tx, thread_id, &run_id, None)?;
        tx.append(draft("turn-item.updated", switch.turn_item.clone()))?;
        run["contextHandoffId"] = switch.handoff["id"].clone();
    }
    if let Some(message) = message {
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
        item["providerThreadId"] = provider_thread_id.clone();
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
    run["providerThreadId"] = provider_thread_id;
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
    resumable(tx, &c.thread_id, Some(&c.run_id))?;
    release_held(tx, &c.thread_id)?;
    Ok(
        start_next_queued_as(tx, &c.thread_id, Some(&c.run_id), true)?
            .into_iter()
            .collect(),
    )
}

/// `queue.resume`'s checks on the run it would start (the selected one, else the next): its
/// effective provider must not be limited, and no worktree setup may be pending. A refusal
/// leaves every hold as it was.
fn resumable(tx: &Tx<'_>, thread_id: &str, selected: Option<&str>) -> Result<(), CommandError> {
    let thread = live_thread(tx, thread_id)?;
    let next = queued_runs(tx, thread_id)?
        .into_iter()
        .find(|run| selected.is_none_or(|id| run["id"] == id));
    let instance = match &next {
        Some(run) => effective_selection(tx, thread_id, &thread, run)?["instanceId"].clone(),
        None => thread["modelSelection"]["instanceId"].clone(),
    };
    if usage_limit_holds(tx, thread_id, instance.as_str().unwrap_or_default(), None)? {
        return reject("Continue the limited thread before resuming its queue.");
    }
    if worktree_setup_pending(tx, thread_id)? {
        return reject("Retry worktree setup or choose a workspace before resuming the queue.");
    }
    Ok(())
}

fn queue_resume(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadOnly = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    resumable(tx, &c.thread_id, None)?;
    release_held(tx, &c.thread_id)?;
    Ok(start_next_queued_as(tx, &c.thread_id, None, true)?
        .into_iter()
        .collect())
}

fn queued_run_cancel(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: QueuedRun = decode(command)?;
    queued_run(tx, &c)?;
    finish_run(tx, &c.thread_id, &c.run_id, "cancelled", None)?;
    // A follow-up whose queued run is cancelled before it starts ends cancelled.
    Ok(crate::families::finalize_tasks(tx, &c.thread_id)?)
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
    command_id: String,
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
    let has_attachments = message["attachments"]
        .as_array()
        .is_some_and(|a| !a.is_empty());
    // A queued message goes to the provider its run selected (`queuedRunModelSelection`).
    let instance = normalize_model_selection(&queued["modelSelection"])["instanceId"]
        .as_str()
        .or_else(|| queued["providerInstanceId"].as_str())
        .unwrap_or_default()
        .to_owned();
    if let Some(goal) = native_goal(
        tx,
        message["text"].as_str().unwrap_or_default(),
        has_attachments,
        &instance,
    )? {
        // A goal keeps its own run, first in the queue, and stops the turn it ends or replaces.
        queue_first(tx, &c.thread_id, &queued)?;
        return Ok(if goal_stops_run(tx, &c.thread_id, &goal, &target)? {
            stop_run(tx, &c.thread_id, &target, None, false)?
        } else {
            vec![]
        });
    }
    finish_run(tx, &c.thread_id, &c.queued_run_id, "cancelled", None)?;
    // Queued on another instance: the message restarts there, as a direct steer does.
    let selection = &queued["modelSelection"];
    if selection["instanceId"].is_string()
        && selection["instanceId"] != target["providerInstanceId"]
    {
        let mut command = json!({
            "type": "message.dispatch", "commandId": c.command_id, "threadId": c.thread_id,
            "messageId": message_id, "text": message["text"], "attachments": message["attachments"],
            "modelSelection": selection, "createdBy": message["createdBy"],
            "creationSource": message["creationSource"],
            "dispatchMode": {"type": "steer_active", "targetRunId": c.target_run_id},
        });
        for field in ["context", "notification", "scheduledTaskId"] {
            if message[field].is_object() || message[field].is_string() {
                command[field] = message[field].clone();
            }
        }
        return message_dispatch(tx, command);
    }
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
        sender_thread_id: None,
        title_seed: None,
        target_capabilities: None,
        notification: message
            .get("notification")
            .filter(|v| v.is_object())
            .cloned(),
        scheduled_task_id: message["scheduledTaskId"].as_str().map(str::to_owned),
        fresh_context: None,
        idle_compaction: None,
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

/// Moves a queued run to the front; the others follow in their order (`stopRunForQueuedCommand`).
fn queue_first(tx: &mut Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<()> {
    let others = queued_runs(tx, thread_id)?
        .into_iter()
        .filter(|r| r["id"] != run["id"]);
    let positions = std::iter::once(run.clone()).chain(others).zip(1_u64..);
    for (mut run, position) in positions {
        if run["queuePosition"] == position {
            continue;
        }
        run["queuePosition"] = json!(position);
        let id = run["id"].as_str().unwrap_or_default().to_owned();
        tx.append(Draft::new(thread_id, "run.updated", run).run(Some(&id)))?;
    }
    Ok(())
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
    // Stopping a run that already ended changes nothing, so a retry succeeds.
    match run.filter(is_active) {
        Some(run) => Ok(stop_run(tx, &c.thread_id, &run, c.reason.as_deref(), true)?),
        None => Ok(vec![]),
    }
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
    let command_id = command["commandId"].as_str().map(str::to_owned);
    let c: ThreadStop = decode(command)?;
    let mut thread = live_thread(tx, &c.thread_id)?;
    crate::link_requests::close_pending(tx, &c.thread_id)?;
    // Stop means stop: queued messages wait until the user sends again or resumes the queue.
    hold_queue(tx, &c.thread_id)?;
    // Stop also ends the thread's pull request watches.
    if crate::pull_requests::has_watch(&thread) {
        crate::pull_requests::end_watches(&mut thread);
        tx.append(
            Draft::new(&c.thread_id, "thread.pull-request-synced", thread)
                .command(command_id.as_deref())
                .payload_instance(),
        )?;
    }
    Ok(stop_thread_work(
        tx,
        &c.thread_id,
        c.reason.as_deref(),
        true,
    )?)
}

/// What Stop ends in a thread: its delegates first, then its active run or, with none, the
/// background work that outlives its latest run (`dispatchThreadStop`). `mark` records the
/// Stop on the run, as a Stop the user asked for does.
pub(crate) fn stop_thread_work(
    tx: &mut Tx<'_>,
    thread_id: &str,
    reason: Option<&str>,
    mark: bool,
) -> StoreResult<Vec<Effect>> {
    let children = crate::families::stop_children(tx, thread_id)?;
    let active = active_run(tx, thread_id)?;
    // Only the provider knows whether background work remains, so it is asked to stop it.
    let settled = match &active {
        Some(_) => None,
        None => crate::shell::settled_background_target(tx, thread_id)?
            .and_then(|(run, _)| run["id"].as_str().map(str::to_owned)),
    };
    let own = match &active {
        Some(run) => stop_run(tx, thread_id, run, reason, mark)?,
        None => vec![],
    };
    let background = settled.map(|run_id| Effect::StopBackgroundWork {
        thread_id: thread_id.to_owned(),
        run_id,
    });
    Ok(children.into_iter().chain(own).chain(background).collect())
}

/// Stop for one active run (`dispatchRunInterrupt`). Before the provider accepted the run's
/// turn, the run ends in this commit and its start is abandoned, as T3's "before provider
/// start" branch does; what follows a run's end (a parent's wake, the next queued run) is
/// planned here too. Otherwise the Stop is recorded (with `mark`) and the provider gets
/// `Interrupt`, which waits in the thread's lane.
pub(crate) fn stop_run(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    reason: Option<&str>,
    mark: bool,
) -> StoreResult<Vec<Effect>> {
    let run_id = run["id"].as_str().unwrap_or_default().to_owned();
    let unaccepted = matches!(
        run["status"].as_str(),
        Some("preparing" | "starting" | "running")
    ) && !tx.start_accepted(&run_id);
    if !unaccepted {
        if mark {
            mark_stopped_run(tx, thread_id, run, reason)?;
        }
        return Ok(vec![Effect::Interrupt {
            thread_id: thread_id.to_owned(),
            run_id,
        }]);
    }
    interrupt_before_start(tx, thread_id, run, reason)?;
    let mut effects = vec![Effect::AbandonStart {
        thread_id: thread_id.to_owned(),
        run_id: run_id.clone(),
    }];
    effects.extend(crate::families::on_run_end(tx, thread_id, &run_id)?);
    effects.extend(start_next_queued(tx, thread_id, None)?);
    Ok(effects)
}

/// T3's "before provider start" branch of `dispatchRunInterrupt`: the Stop request and its
/// result ("Run interrupted before provider start"), then the attempt, the root node and the
/// run end `interrupted`, in that order. Nothing else is settled: no checkpoint is captured
/// and the provider thread keeps its status, as in T3. Items need the run's provider thread
/// and root node, as T3's do.
fn interrupt_before_start(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    reason: Option<&str>,
) -> StoreResult<()> {
    let run_id = run["id"].as_str().unwrap_or_default().to_owned();
    let root = run["rootNodeId"].as_str().map(str::to_owned);
    let now = tx.now().to_owned();
    let draft = |event_type, payload| {
        Draft::new(thread_id, event_type, payload)
            .run(Some(&run_id))
            .node(root.as_deref())
    };
    mark_stopped_run(tx, thread_id, run, reason)?;
    if let Some(request) = interrupt_request(tx, thread_id, &run_id)? {
        let result = json!({
            "id": interrupt_item_id(&run_id, "interrupt-result"),
            "threadId": thread_id,
            "runId": run_id,
            "nodeId": request["nodeId"],
            "providerThreadId": request["providerThreadId"],
            "providerTurnId": null,
            "nativeItemRef": null,
            "parentItemId": request["id"],
            "ordinal": request["ordinal"].as_u64().map_or(0, |o| o + 1),
            "status": "interrupted",
            "title": "Interrupted",
            "startedAt": now,
            "completedAt": now,
            "updatedAt": now,
            "type": "run_interrupt_result",
            "message": "Run interrupted before provider start",
        });
        tx.append(draft("turn-item.updated", result))?;
    }
    if let Some(attempt_id) = run["activeAttemptId"].as_str()
        && let Some(mut attempt) = tx.entity(thread_id, "attempts", attempt_id)?
    {
        attempt["status"] = json!("interrupted");
        attempt["completedAt"] = json!(now);
        tx.append(draft("run-attempt.updated", attempt))?;
    }
    if let Some(root) = &root
        && let Some(mut node) = tx.entity(thread_id, "nodes", root)?
    {
        node["status"] = json!("interrupted");
        node["completedAt"] = json!(now);
        tx.append(draft("node.updated", node))?;
    }
    let mut ended = run.clone();
    ended["status"] = json!("interrupted");
    ended["completedAt"] = json!(now);
    tx.append(draft("run.updated", ended))?;
    tx.release_turn_item_positions(thread_id)?;
    tx.abandon_start(&run_id);
    Ok(())
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
pub(crate) fn interrupt_request(
    tx: &Tx<'_>,
    thread_id: &str,
    run_id: &str,
) -> StoreResult<Option<Value>> {
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

/// The id of a run's provider stop reason notice (T3's `runSignalTurnItem`).
pub fn provider_stop_reason_id(run_id: &str) -> String {
    join_id(
        "turn-item",
        &["run", run_id, "signal", "provider-stop-reason"],
    )
}

/// `subagentResultForRun`'s result for a completed child with no answer, with the hook's
/// reason when a hook stopped it.
pub fn completed_without_result(stop_reason: Option<&str>) -> String {
    let text = "Child task completed without an assistant result.";
    stop_reason.map_or_else(|| text.to_owned(), |reason| format!("{text}\n\n{reason}"))
}

/// `PROVIDER_STOP_REASON_SIGNAL`: Codex reports a turn a hook stopped as completed; the run
/// keeps the hook's reason as a warning (`RunExecutionService`). Its id is T3's
/// `runSignalTurnItem`, which `subagentProjection.ts` looks up.
pub(crate) fn write_provider_stop_reason(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
    reason: &str,
) -> StoreResult<()> {
    let Some(run) = tx.entity(thread_id, "runs", run_id)? else {
        return Ok(());
    };
    let Some(root) = run["rootNodeId"].as_str() else {
        return Ok(());
    };
    let provider_turn = tx
        .entity(thread_id, "nodes", root)?
        .map(|node| node["providerTurnId"].clone())
        .unwrap_or(Value::Null);
    let now = tx.now().to_owned();
    let item = json!({
        "id": provider_stop_reason_id(run_id),
        "threadId": thread_id,
        "runId": run_id,
        "nodeId": root,
        "providerThreadId": run["providerThreadId"],
        "providerTurnId": provider_turn,
        "nativeItemRef": null,
        "parentItemId": null,
        "ordinal": run["ordinal"].as_u64().unwrap_or(0) * 100 + 98,
        "status": "completed",
        "title": "Stopped by the provider",
        "startedAt": now,
        "completedAt": now,
        "updatedAt": now,
        "type": "system_notice",
        "level": "warning",
        "message": reason,
    });
    tx.append(
        Draft::new(thread_id, "turn-item.updated", item)
            .run(Some(run_id))
            .node(Some(root)),
    )?;
    Ok(())
}

/// `makeInterruptResultTurnItem`: the Stop result of a run that ended interrupted. Its message
/// is `reason` (Force stop), else the Stop request's, else the provider's `fallback`, else
/// "Stopped by the provider" (`RunExecutionService`). Written once.
pub(crate) fn write_interrupt_result(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    reason: Option<&str>,
    fallback: Option<&str>,
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
        .or_else(|| fallback.map(str::to_owned))
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
    command_id: String,
    thread_id: String,
    request_id: String,
    decision: Option<Value>,
    feedback: Option<String>,
    answers: Option<Value>,
    attachments_by_question_id: Option<Value>,
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
    let declined = matches!(
        c.decision.as_ref().and_then(Value::as_str),
        Some("decline" | "cancel")
    );
    let node = request["nodeId"].as_str().map(str::to_owned);
    // A question the provider can no longer take live (an imported or async one) is answered
    // with a user message that starts a turn (T3's `responseCapability.type: message`).
    let is_message = request["responseCapability"]["type"] == "message";
    let message_reply = match is_message {
        true if !declined => {
            let item = node
                .as_deref()
                .map(|node| request_item(tx, &c, node))
                .transpose()?
                .flatten()
                .filter(|item| item["type"] == "user_input_request");
            let Some(item) = item else {
                return reject("The question for this request was not found.");
            };
            let answers = c.answers.as_ref().and_then(Value::as_object);
            Some(async_reply(&item, answers).map_err(|e| CommandError::Rejected(e.into()))?)
        }
        _ => None,
    };
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
    let instance = respond_instance(tx, &c.thread_id, &request)?;
    tx.append(
        Draft::new(&c.thread_id, "runtime-request.updated", request)
            .node(node.as_deref())
            .provider_instance(instance.as_deref()),
    )?;
    settle_request_rows(tx, &c, node.as_deref(), instance.as_deref())?;
    if is_message {
        return match message_reply {
            Some(text) => async_answer(tx, &c, text),
            None => Ok(vec![]),
        };
    }
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

/// The request's approval or question item on its node.
fn request_item(
    tx: &Tx<'_>,
    c: &RuntimeRequestRespond,
    node_id: &str,
) -> StoreResult<Option<Value>> {
    Ok(tx
        .entities_where(&c.thread_id, "turnItems", "nodeId", node_id)?
        .into_iter()
        .filter(|item| {
            matches!(
                item["type"].as_str(),
                Some("approval_request" | "user_input_request")
            ) && item["requestId"] == c.request_id.as_str()
        })
        .min_by_key(|item| item["ordinal"].as_u64().unwrap_or(u64::MAX)))
}

/// A non-blank string, or a non-empty list of non-blank strings (T3's
/// `isMessageQuestionAnswer`). A `{answers: [...]}` object counts as its list.
fn message_answer(answer: &Value) -> Option<String> {
    let answer = answer.get("answers").unwrap_or(answer);
    let blank = |text: &str| text.trim().is_empty();
    match answer {
        Value::String(text) if !blank(text) => Some(text.trim().to_owned()),
        Value::Array(list) if !list.is_empty() => {
            let parts: Option<Vec<&str>> = list
                .iter()
                .map(|v| v.as_str().filter(|text| !blank(text)))
                .collect();
            Some(parts?.join(", ").trim().to_owned())
        }
        _ => None,
    }
}

/// The user's reply to an async question: each answered question and its answer, in the
/// question's order (`runtime-request.respond` in T3's `Orchestrator`). A skipped optional
/// question is left out; a skipped required one, or an extra blank answer, is refused.
fn async_reply(
    item: &Value,
    answers: Option<&serde_json::Map<String, Value>>,
) -> Result<String, &'static str> {
    const UNANSWERED: &str = "Answer each question before sending.";
    let questions = item["questions"].as_array().map_or(&[][..], Vec::as_slice);
    let empty = serde_json::Map::new();
    let answers = answers.unwrap_or(&empty);
    let known = |id: &str| questions.iter().any(|q| q["id"] == id);
    if !answers
        .iter()
        .all(|(id, answer)| known(id) || message_answer(answer).is_some())
    {
        return Err(UNANSWERED);
    }
    let mut replies = vec![];
    for question in questions {
        let answer = question["id"]
            .as_str()
            .and_then(|id| answers.get(id))
            .and_then(message_answer);
        match answer {
            Some(text) => replies.push(format!(
                "{}\n{text}",
                question["question"].as_str().unwrap_or_default()
            )),
            // Clients send "" for a skipped optional question.
            None if question["required"] == false => {}
            None => return Err(UNANSWERED),
        }
    }
    if replies.is_empty() {
        return Err("Enter an answer before sending.");
    }
    Ok(replies.join("\n\n"))
}

/// Whether the provider session the run's provider thread is on steers a running turn.
fn session_steers(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<bool> {
    let Some(provider_thread) = run["providerThreadId"]
        .as_str()
        .map(|id| tx.entity(thread_id, "providerThreads", id))
        .transpose()?
        .flatten()
    else {
        return Ok(false);
    };
    let Some(session) = provider_thread["providerSessionId"]
        .as_str()
        .map(|id| tx.entity(thread_id, "providerSessions", id))
        .transpose()?
        .flatten()
    else {
        return Ok(false);
    };
    Ok(session["capabilities"]["turns"]["supportsActiveSteering"] == true)
}

/// Sends the async answer as the user's message: it steers the active run, or queues or
/// starts a turn, with a stable id so a second answer cannot add another.
fn async_answer(tx: &mut Tx<'_>, c: &RuntimeRequestRespond, text: String) -> Outcome {
    // It steers only into a provider turn that runs; a run still starting gets the answer
    // as its own later run (T3's `getRunningTurnContext` admission). A session that cannot
    // steer declines it at delivery, and the answer then queues.
    let running = match active_run(tx, &c.thread_id)? {
        Some(run) if run["status"] == "running" => tx
            .entities_where(&c.thread_id, "providerTurns", "status", "running")?
            .iter()
            .any(|turn| turn["nodeId"] == run["rootNodeId"])
            .then_some(run),
        _ => None,
    };
    // Only a session that steers live takes it into the turn (`supportsActiveSteering`).
    let running = match running {
        Some(run) if session_steers(tx, &c.thread_id, &run)? => Some(run),
        _ => None,
    };
    // A steer accepted after Stop never reaches the agent: refused, so the answer can be sent
    // again (T3's `stopReachedRun`).
    if let Some(run) = &running {
        let id = run["id"].as_str().unwrap_or_default();
        if interrupt_request(tx, &c.thread_id, id)?.is_some() {
            return reject(format!(
                "Target run {id} is stopping and cannot be steered."
            ));
        }
    }
    let dispatch_mode = match running {
        Some(run) => json!({"type": "steer_active", "targetRunId": run["id"]}),
        None => json!({"type": "queue_after_active"}),
    };
    message_dispatch(
        tx,
        json!({
            "type": "message.dispatch",
            "commandId": c.command_id,
            "threadId": c.thread_id,
            "messageId": format!("async-answer:{}", c.request_id),
            "text": text,
            "attachments": [],
            "createdBy": "user",
            "creationSource": "server",
            "dispatchMode": dispatch_mode,
        }),
    )
}

/// The instance T3 names on a response's events: the live session's when the request is
/// answered through one, else none (`dispatchRuntimeRequestRespond`).
fn respond_instance(tx: &Tx<'_>, thread_id: &str, request: &Value) -> StoreResult<Option<String>> {
    let capability = &request["responseCapability"];
    let Some(session) = capability["providerSessionId"]
        .as_str()
        .filter(|_| capability["type"] == "live")
    else {
        return Ok(None);
    };
    Ok(tx
        .entity(thread_id, "providerSessions", session)?
        .and_then(|row| row["providerInstanceId"].as_str().map(str::to_owned)))
}

/// The answered request's node and its turn item end (`runtime-request.respond` in T3's
/// `Orchestrator`): `cancelled` for a declined or cancelled request, else `completed`; a
/// question's item carries the answer (`questionAnswer`).
fn settle_request_rows(
    tx: &mut Tx<'_>,
    c: &RuntimeRequestRespond,
    node_id: Option<&str>,
    instance: Option<&str>,
) -> StoreResult<()> {
    let Some(node_id) = node_id else {
        return Ok(());
    };
    let status = match c.decision.as_ref().and_then(Value::as_str) {
        Some("decline" | "cancel") => "cancelled",
        _ => "completed",
    };
    let now = tx.now().to_owned();
    if let Some(mut node) = tx.entity(&c.thread_id, "nodes", node_id)? {
        node["status"] = json!(status);
        node["completedAt"] = json!(now);
        let run = node["runId"].as_str().map(str::to_owned);
        tx.append(
            Draft::new(&c.thread_id, "node.updated", node)
                .run(run.as_deref())
                .node(Some(node_id))
                .provider_instance(instance),
        )?;
    }
    if let Some(mut item) = request_item(tx, c, node_id)? {
        if item["type"] == "user_input_request"
            && let Some(answers) = &c.answers
        {
            // T3 keeps each question's answer list (`{answers: [...]}` → `[...]`).
            let answers: serde_json::Map<String, Value> = answers
                .as_object()
                .into_iter()
                .flatten()
                .map(|(id, answer)| {
                    let answer = answer
                        .get("answers")
                        .cloned()
                        .unwrap_or_else(|| answer.clone());
                    (id.clone(), answer)
                })
                .collect();
            let questions: serde_json::Map<String, Value> = item["questions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|q| Some((q["id"].as_str()?.to_owned(), q["question"].clone())))
                .collect();
            item["questionAnswer"] = json!({
                "requestId": c.request_id,
                "answers": answers,
                "attachmentsByQuestionId": c.attachments_by_question_id.clone().unwrap_or_else(|| json!({})),
                "questionTextById": questions,
            });
        }
        item["status"] = json!(status);
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        let run = item["runId"].as_str().map(str::to_owned);
        tx.append(
            Draft::new(&c.thread_id, "turn-item.updated", item)
                .run(run.as_deref())
                .node(Some(node_id))
                .provider_instance(instance),
        )?;
    }
    Ok(())
}

/// Replaces fields of the thread record and records it as `event_type`.
fn patch_thread(
    tx: &mut Tx<'_>,
    thread_id: &str,
    event_type: &'static str,
    bump_updated_at: bool,
    patch: impl FnOnce(&mut Value, &str),
) -> Result<(), CommandError> {
    patch_thread_for(tx, thread_id, event_type, bump_updated_at, None, patch)
}

/// [`patch_thread`] with the event filed under the command that wrote it.
fn patch_thread_for(
    tx: &mut Tx<'_>,
    thread_id: &str,
    event_type: &'static str,
    bump_updated_at: bool,
    command_id: Option<&str>,
    patch: impl FnOnce(&mut Value, &str),
) -> Result<(), CommandError> {
    let mut thread = live_thread(tx, thread_id)?;
    let now = tx.now().to_owned();
    patch(&mut thread, &now);
    if bump_updated_at {
        thread["updatedAt"] = json!(now);
    }
    tx.append(
        Draft::new(thread_id, event_type, thread)
            .payload_instance()
            .command(command_id),
    )?;
    Ok(())
}

/// T3's `liveSideChatIds`: side chats live inside their parent, so deleting or archiving the
/// parent takes them too. Found by lineage, not by fork run: a side chat opened during the
/// parent's first turn has none. The command's one transaction stands in for T3's locks.
fn live_side_chats(tx: &Tx<'_>, parent_id: &str) -> StoreResult<Vec<Value>> {
    Ok(tx
        .threads_where("lineage.parentThreadId", parent_id)?
        .into_iter()
        .filter(|t| t["lineage"]["sideChat"] == true)
        .collect())
}

/// T3's `hasRunningDelegatedTasks`: an app-owned task with a child thread still at work.
fn has_running_delegated_tasks(tx: &Tx<'_>, thread_id: &str) -> StoreResult<bool> {
    Ok(tx.entities(thread_id, "subagents")?.iter().any(|task| {
        task["origin"] == "app_owned"
            && !task["childThreadId"].is_null()
            && matches!(
                task["status"].as_str(),
                Some("pending" | "running" | "waiting")
            )
    }))
}

/// T3's archive of one thread (`Orchestrator.ts` `thread.archive`): queued and preparing runs
/// are cancelled, live provider sessions detach, pending link requests close, and the thread's
/// terminals and devices go (`ThreadClosed`).
fn archive_one(tx: &mut Tx<'_>, thread_id: &str) -> Outcome {
    for run in tx.entities(thread_id, "runs")? {
        if matches!(run["status"].as_str(), Some("queued" | "preparing")) {
            let run_id = run["id"].as_str().unwrap_or_default();
            finish_run(tx, thread_id, run_id, "cancelled", None)?;
        }
    }
    let now = tx.now().to_owned();
    let mut effects = vec![];
    for session in tx.entities(thread_id, "providerSessions")? {
        if matches!(session["status"].as_str(), Some("stopped" | "error")) {
            continue;
        }
        tx.append(Draft::new(
            thread_id,
            "provider-session.detached",
            json!({"providerSessionId": session["id"], "detachedAt": now,
                "reason": "Thread archived."}),
        ))?;
        if effects.is_empty() {
            effects.push(Effect::CloseSession {
                thread_id: thread_id.to_owned(),
            });
        }
    }
    crate::link_requests::close_pending(tx, thread_id)?;
    patch_thread(tx, thread_id, "thread.archived", true, |t, now| {
        t["archivedAt"] = json!(now);
        crate::pull_requests::end_watches(t);
    })?;
    effects.push(Effect::ThreadClosed {
        thread_id: thread_id.to_owned(),
        reason: crate::ThreadClose::Archived,
    });
    Ok(effects)
}

fn thread_archive(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadOnly = decode(command)?;
    // T3's guards, decided before either thread changes.
    if !live_thread(tx, &c.thread_id)?["archivedAt"].is_null() {
        return reject(format!("Thread {} is already archived.", c.thread_id));
    }
    if has_running_delegated_tasks(tx, &c.thread_id)? {
        return reject(format!(
            "Thread {} has running delegated tasks. Wait for them or cancel them before archiving.",
            c.thread_id
        ));
    }
    let side_chats = live_side_chats(tx, &c.thread_id)?;
    let mut effects = archive_one(tx, &c.thread_id)?;
    // Orchestrator.ts `thread.archive`: an active side chat follows its parent, unless it
    // still waits on delegated tasks.
    for side_chat in side_chats {
        let id = side_chat["id"].as_str().unwrap_or_default();
        if side_chat["archivedAt"].is_null() && !has_running_delegated_tasks(tx, id)? {
            effects.extend(archive_one(tx, id)?);
        }
    }
    Ok(effects)
}

fn thread_unarchive(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadOnly = decode(command)?;
    let parent_archived_at = live_thread(tx, &c.thread_id)?["archivedAt"].clone();
    if parent_archived_at.is_null() {
        return reject(format!("Thread {} is not archived.", c.thread_id));
    }
    let side_chats = live_side_chats(tx, &c.thread_id)?;
    patch_thread(tx, &c.thread_id, "thread.unarchived", true, |t, _| {
        t["archivedAt"] = Value::Null;
    })?;
    // Unarchive restores the side chats this parent's archive took, not ones archived before it.
    for side_chat in side_chats {
        let at = |v: &Value| v.as_str().and_then(conn_support::time::millis_from_iso);
        let follows = matches!(
            (at(&side_chat["archivedAt"]), at(&parent_archived_at)),
            (Some(child), Some(parent)) if child >= parent
        );
        if follows {
            let id = side_chat["id"].as_str().unwrap_or_default();
            patch_thread(tx, id, "thread.unarchived", true, |t, _| {
                t["archivedAt"] = Value::Null;
            })?;
        }
    }
    Ok(vec![])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadDelete {
    thread_id: String,
    only_if_unused: Option<bool>,
}

fn thread_delete(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadDelete = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    // Checked under the thread lock (T3's `onlyIfUnused`): a message sent since the client
    // looked keeps the thread, and the delete is accepted with no change.
    if c.only_if_unused == Some(true) && is_used(tx, &c.thread_id)? {
        return Ok(vec![]);
    }
    let side_chats = live_side_chats(tx, &c.thread_id)?;
    let mut effects = delete_one(tx, &c.thread_id)?;
    for side_chat in side_chats {
        effects.extend(delete_one(
            tx,
            side_chat["id"].as_str().unwrap_or_default(),
        )?);
    }
    Ok(effects)
}

fn delete_one(tx: &mut Tx<'_>, thread_id: &str) -> Outcome {
    for run in tx.entities(thread_id, "runs")?.into_iter().filter(is_live) {
        let run_id = run["id"].as_str().unwrap_or_default();
        finish_run(tx, thread_id, run_id, "cancelled", None)?;
    }
    patch_thread(tx, thread_id, "thread.deleted", true, |t, now| {
        t["deletedAt"] = json!(now);
    })?;
    Ok(vec![
        Effect::CloseThreadSessions {
            thread_id: thread_id.to_owned(),
        },
        Effect::CleanupHtmlAttachments {
            thread_id: thread_id.to_owned(),
            ids: crate::html_cleanup::plan(tx, thread_id)?,
        },
        Effect::ThreadClosed {
            thread_id: thread_id.to_owned(),
            reason: crate::ThreadClose::Deleted,
        },
    ])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadVisit {
    command_id: String,
    thread_id: String,
    visited_at: Value,
}

/// `thread.visit`: the time parses as T3's `DateTime.make` reads it, or the command is refused.
fn thread_visit(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: ThreadVisit = decode(command)?;
    live_thread(tx, &c.thread_id)?;
    let text = c.visited_at.as_str().unwrap_or_default();
    let Some(visited) = tx.date_input_millis(text) else {
        return reject(format!(
            "Thread {} visit time {text} is not a valid timestamp.",
            c.thread_id
        ));
    };
    // T3's `dispatchThreadVisit`: only a later visit moves the read mark, compared as times,
    // and the event carries the visit, not the thread.
    let thread = live_thread(tx, &c.thread_id)?;
    // The stored mark may be in any form main stored; read it as the command time is read.
    let moves_forward = thread["lastVisitedAt"]
        .as_str()
        .and_then(|last| tx.date_input_millis(last))
        .is_none_or(|last| visited > last);
    if !moves_forward {
        return Ok(vec![]);
    }
    tx.append(
        Draft::new(
            &c.thread_id,
            "thread.visit-recorded",
            json!({"lastVisitedAt": crate::time::iso_from_millis(visited)}),
        )
        .command(Some(&c.command_id))
        .instance_of(&thread),
    )?;
    Ok(vec![])
}

fn thread_created_record(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let c: conn_contract::OrchestrationV2CommandThreadCreatedRecord = decode(command)?;
    let parent = live_thread(tx, &c.parent_thread_id)?;
    let target = live_thread(tx, &c.target_thread_id)?;
    let run = tx.entity(&c.parent_thread_id, "runs", &c.parent_run_id)?;
    let node = tx.entity(&c.parent_thread_id, "nodes", &c.parent_node_id)?;
    let Some(run) = run.filter(|r| {
        r["rootNodeId"] == c.parent_node_id
            && node.as_ref().is_some_and(|n| n["runId"] == c.parent_run_id)
    }) else {
        return reject(format!(
            "Parent node {} is not the root of run {}.",
            c.parent_node_id, c.parent_run_id
        ));
    };
    if parent["projectId"] != target["projectId"] {
        return reject(format!(
            "Target thread {} belongs to another project.",
            c.target_thread_id
        ));
    }
    if let Some(id) = &c.target_run_id
        && tx.entity(&c.target_thread_id, "runs", id)?.is_none()
    {
        return reject(format!(
            "Target run {id} does not belong to thread {}.",
            c.target_thread_id
        ));
    }
    let provider_turn = tx
        .entities(&c.parent_thread_id, "providerTurns")?
        .into_iter()
        .rfind(|t| t["attemptId"] == run["activeAttemptId"] && !run["activeAttemptId"].is_null());
    let now = tx.now().to_owned();
    tx.append(Draft::new(&c.parent_thread_id,"turn-item.updated",json!({
        "id":format!("turn-item:created-thread:{}",c.command_id),"threadId":c.parent_thread_id,
        "runId":c.parent_run_id,"nodeId":c.parent_node_id,"providerThreadId":run["providerThreadId"],
        "providerTurnId":provider_turn.map(|p|p["id"].clone()),"nativeItemRef":null,"parentItemId":null,
        "ordinal":0,"status":"completed","title":target["title"],"startedAt":now,"completedAt":now,"updatedAt":now,
        "type":"thread_created","targetThreadId":c.target_thread_id,"targetRunId":c.target_run_id,
        "targetProviderInstanceId":target["modelSelection"]["instanceId"],"targetModel":target["modelSelection"]["model"],
    })).run(Some(&c.parent_run_id)).node(Some(&c.parent_node_id)).command(Some(&c.command_id)))?;
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
    let c: ThreadMetadataUpdate = decode(command.clone())?;
    let old = live_thread(tx, &c.thread_id)?;
    for (expected, actual, label) in [
        ("expectedWorktreePath", "worktreePath", "worktree"),
        ("expectedBranch", "branch", "branch"),
    ] {
        if let Some(expected) = command.get(expected)
            && *expected != old[actual]
        {
            return reject(format!(
                "Thread {} {label} changed before the metadata update could be applied.",
                c.thread_id
            ));
        }
    }
    // A launch's claim on an existing thread (`expectedEmpty` in T3's `Orchestrator`).
    let expects_empty = command["expectedEmpty"] == true;
    if expects_empty && is_used(tx, &c.thread_id)? {
        return reject(format!("Thread {} is no longer empty.", c.thread_id));
    }
    let workspace_changed = command
        .get("worktreePath")
        .is_some_and(|p| *p != old["worktreePath"]);
    if workspace_changed
        && tx
            .entities(&c.thread_id, "providerThreads")?
            .iter()
            .any(|p| {
                p["pendingBackgroundTasks"]
                    .as_array()
                    .is_some_and(|tasks| !tasks.is_empty())
            })
    {
        return reject(
            "The current session is still running background agents or commands, and detaching it would end them. Wait for them to finish, or press Stop, then retry.",
        );
    }
    let regenerate = c.regenerate_title == Some(true);
    if regenerate && !tx.generates_titles {
        return reject("Conn Server has no title generator configured.");
    }
    let command_id = c.command_id.clone();
    let titled = c.title.is_some();
    let thread_id = c.thread_id.clone();
    patch_thread_for(
        tx,
        &c.thread_id,
        "thread.metadata-updated",
        true,
        // The claim's event names its command, so a replay can find the thread it claimed.
        expects_empty.then_some(command_id.as_str()),
        |t, now| {
            for field in ["branch", "worktreePath"] {
                if let Some(value) = command.get(field) {
                    t[field] = value.clone();
                }
            }
            if let Some(title) = c.title.filter(|title| !title.trim().is_empty()) {
                t["title"] = json!(title.trim());
                t["titleRenamed"] = json!(true);
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
    let previous_run = if workspace_changed {
        active_run(tx, &thread_id)?
    } else {
        None
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
    if workspace_changed {
        if let Some(run) = previous_run {
            let run_id = run["id"].as_str().unwrap_or_default();
            finish_run(tx, &thread_id, run_id, "completed", None)?;
            effects.extend(crate::families::on_run_end(tx, &thread_id, run_id)?);
        }
        effects.insert(
            0,
            Effect::CloseSession {
                thread_id: thread_id.clone(),
            },
        );
        effects.extend(start_next_queued(tx, &thread_id, None)?);
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
    finish_run_as(
        tx,
        thread_id,
        run_id,
        status,
        status,
        failure,
        None,
        IdleWrite::WhileActive,
        RunEnd::Settled,
    )
    .map(drop)
}

/// Why a run ends, which decides what happens to its live provider-native subagents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunEnd {
    /// The provider or the engine ended the run (a confirmed Stop, a failure, a cancel): an
    /// interrupted, failed or cancelled run takes its open native subagents with it, as T3's
    /// `cascadeTerminalizeRunOwnedSubagents`.
    Settled,
    /// The run's session went away (released, or its events ended). A native subagent still
    /// running keeps its item open: it ends with its own row, from the provider (Codex's
    /// shared `app-server` outlives the session) or from the orphan cleanup.
    Detached,
}

/// When a run's end writes its provider thread `idle`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IdleWrite {
    /// A provider terminal or a failed start: always, as T3's `writeFinalRunEvents` writes
    /// the run's provider thread at every turn end.
    TurnEnd,
    /// A cancel, Force stop, delete or restart recovery: only while the row still says
    /// `active`.
    WhileActive,
}

/// Ends a run's items with `status`, and the run and its root node with `persisted`: a
/// completed provider turn whose checkpoint is still to be taken persists `waiting`, with no
/// `completedAt` (`RunExecutionService.ts`). An interrupted run's Stop result falls back to the
/// provider's `stop_reason`. Returns whether it ended the run: `false` when the run is gone or
/// already ended.
#[expect(
    clippy::too_many_arguments,
    reason = "T3's turn terminal (status, failure, reason) plus how the run persists"
)]
pub(crate) fn finish_run_as(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
    status: &str,
    persisted: &str,
    failure: Option<Value>,
    stop_reason: Option<&str>,
    idle: IdleWrite,
    end: RunEnd,
) -> StoreResult<bool> {
    let Some(mut run) = tx.entity(thread_id, "runs", run_id)? else {
        return Ok(false);
    };
    if !is_live(&run) {
        return Ok(false);
    }
    // A queued run never started, so the thread's pending requests belong to the active run.
    let queued = run["status"] == "queued";
    crate::secret_requests::cancel_pending(tx, thread_id, run_id)?;
    if status == "interrupted" {
        write_interrupt_result(tx, thread_id, &run, None, stop_reason)?;
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
    if end == RunEnd::Settled && matches!(item_status, "interrupted" | "failed" | "cancelled") {
        crate::families::end_run_native_subagents(tx, thread_id, run_id, item_status)?;
    }

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
        let mut open = !background
            && matches!(
                item["status"].as_str(),
                Some("idle" | "pending" | "running" | "waiting")
            );
        if open
            && end == RunEnd::Detached
            && item["type"] == "subagent"
            && let Some(id) = item["subagentId"].as_str()
            && tx.entity(thread_id, "subagents", id)?.is_some_and(|row| {
                row["origin"] == "provider_native"
                    && matches!(
                        row["status"].as_str(),
                        Some("pending" | "running" | "waiting")
                    )
            })
        {
            open = false;
        }
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
    // Only this run's requests end with it: a queued run removed while another run waits on
    // an approval must leave that approval answerable. A request names its node; the node
    // names its run.
    let pending = if queued {
        vec![]
    } else {
        tx.entities_where(thread_id, "runtimeRequests", "status", "pending")?
    };
    for mut request in pending {
        let owner = match request["nodeId"].as_str() {
            Some(node) => tx.entity(thread_id, "nodes", node)?,
            None => None,
        };
        if owner.is_none_or(|node| node["runId"] != run_id) {
            continue;
        }
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
    settle_provider_thread(tx, thread_id, &run, "idle", idle)?;
    tx.forget_start(run_id);
    // Positions held text took and never used.
    tx.release_turn_item_positions(thread_id)?;
    Ok(true)
}

/// The run's provider thread when the run ends: `idle`, or `error` when the provider says the
/// native thread cannot take another turn (`finalProviderThreadStatus` in T3's
/// `RunExecutionService`). Only while this run is the thread's last (`lastRunOrdinal`), so a
/// later run's row is never overwritten; with [`IdleWrite::WhileActive`] only from `active`.
pub(crate) fn settle_provider_thread(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    status: &str,
    idle: IdleWrite,
) -> StoreResult<()> {
    let Some(id) = run["providerThreadId"].as_str() else {
        return Ok(());
    };
    let Some(mut thread) = tx.entity(thread_id, "providerThreads", id)? else {
        return Ok(());
    };
    let current = thread["status"].as_str().unwrap_or_default();
    let from_ok = match idle {
        IdleWrite::TurnEnd => true,
        IdleWrite::WhileActive => current == "active" || (status == "error" && current == "idle"),
    };
    if !from_ok || thread["lastRunOrdinal"] != run["ordinal"] {
        return Ok(());
    }
    thread["status"] = json!(status);
    thread["updatedAt"] = json!(tx.now());
    tx.append(Draft::new(thread_id, "provider-thread.updated", thread).instance_of(run))?;
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
    let now = tx.now().to_owned();
    patch(&mut thread, &now)?;
    // T3's `dispatchThreadMutation` records the event even when nothing changed (a re-pin keeps
    // `updatedAt`); a retry of the same command id is answered by its receipt instead.
    let cid = command["commandId"].as_str().map(str::to_owned);
    tx.append(
        Draft::new(&thread_id, event_type, thread)
            .command(cid.as_deref())
            .payload_instance(),
    )?;
    Ok(vec![])
}

/// T3's `dispatchThreadMutation` refuses settle, unsettle, snooze, unsnooze, auto-settle,
/// pin, unpin and both reorders on an archived thread before any other check of its own.
fn refuse_archived(tx: &Tx<'_>, command: &Value) -> Result<(), CommandError> {
    let thread_id = command["threadId"].as_str().unwrap_or_default();
    if is_null(&live_thread(tx, thread_id)?, "archivedAt") {
        Ok(())
    } else {
        reject(format!("Thread {thread_id} is archived."))
    }
}

fn is_null(thread: &Value, field: &str) -> bool {
    thread.get(field).is_none_or(Value::is_null)
}

fn thread_settle(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    // T3's `thread.auto-settle` rechecks the live thread against the sweep's snapshot: a user's
    // own choice or any change since wins. Then it is a settle.
    if command["type"] == "thread.auto-settle" {
        let thread = live_thread(tx, &thread_id)?;
        let changed_at = thread["updatedAt"]
            .as_str()
            .and_then(crate::time::millis_from_iso);
        let snapshot = command["snapshotAt"]
            .as_str()
            .and_then(|at| tx.date_input_millis(at));
        let unchanged = matches!((changed_at, snapshot), (Some(at), Some(seen)) if at <= seen);
        if !is_null(&thread, "settledOverride") || !unchanged {
            return reject(format!(
                "Thread {thread_id} changed before automatic settlement."
            ));
        }
    }
    refuse_archived(tx, &command)?;
    // T3 compares every run, queued ones too, and refuses when the latest is another.
    if let Some(expected) = command["expectedLatestRunId"].as_str() {
        let latest = tx
            .entities(&thread_id, "runs")?
            .into_iter()
            .max_by_key(|r| r["ordinal"].as_u64().unwrap_or(0));
        if latest.is_none_or(|r| r["id"] != expected) {
            return reject("The thread received another run before settlement.");
        }
    }
    if active_run(tx, &thread_id)?.is_some() {
        return reject(format!(
            "Thread {thread_id} is still running and cannot be settled."
        ));
    }
    // T3 settles past a queued message the server or a schedule sent, never a user's own, and
    // cancels those automatic runs so a later resume never starts them.
    let mut automatic_runs = vec![];
    for run in queued_runs(tx, &thread_id)? {
        let message_id = run["userMessageId"].as_str().unwrap_or_default();
        let message = tx.entity(&thread_id, "messages", message_id)?;
        let automatic = message.as_ref().is_some_and(|m| {
            m["createdBy"] != "user" || !is_null(m, "scheduledTaskId") || is_automatic(m)
        });
        if !automatic {
            return reject(format!(
                "Thread {thread_id} has a queued message. Send it or remove it from the queue before settling."
            ));
        }
        automatic_runs.push(run["id"].as_str().unwrap_or_default().to_owned());
    }
    for run_id in automatic_runs {
        finish_run(tx, &thread_id, &run_id, "cancelled", None)?;
    }
    let settled_at = command["settledAt"].clone();
    let current = live_thread(tx, &thread_id)?;
    let again = current["settledOverride"] == "settled"
        && !is_null(&current, "settledAt")
        && is_null(&current, "pinnedAt");
    thread_patch(tx, &command, "thread.settled", |t, now| {
        let already =
            t["settledOverride"] == "settled" && !is_null(t, "settledAt") && is_null(t, "pinnedAt");
        let snoozed = !is_null(t, "snoozedUntil") || !is_null(t, "snoozedAt");
        t["settledOverride"] = json!("settled");
        crate::pull_requests::end_watches(t);
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
        // T3 moves a settled thread that was still snoozed.
        if !already || snoozed {
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })?;
    let settled_at = live_thread(tx, &thread_id)?["settledAt"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok(vec![Effect::ThreadClosed {
        thread_id,
        reason: if again {
            crate::ThreadClose::SettledAgain { settled_at }
        } else {
            crate::ThreadClose::Settled { settled_at }
        },
    }])
}

/// `thread.unsettle` as `Orchestrator.ts`. An undo of a settle sends `restoreUnsettledAt`, the
/// Active anchor the settle cleared, so the thread goes back to its place, not to the top. An
/// archived thread refuses it before the anchor is read. A thread already active keeps its
/// anchor and `updatedAt`, but a fresh command still records `thread.unsettled`, as T3 does.
fn thread_unsettle(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    refuse_archived(tx, &command)?;
    let mut thread = live_thread(tx, &thread_id)?;
    let now = tx.now().to_owned();
    let anchor = match command.get("restoreUnsettledAt") {
        None => json!(now),
        Some(Value::Null) => Value::Null,
        Some(at) => {
            let text = at.as_str().unwrap_or_default();
            let Some(millis) = tx.date_input_millis(text) else {
                return reject(format!(
                    "Thread {thread_id} unsettle anchor {text} is not a valid time."
                ));
            };
            json!(crate::time::iso_from_millis(millis))
        }
    };
    if thread["settledOverride"] != "active" {
        thread["settledOverride"] = json!("active");
        thread["settledAt"] = Value::Null;
        thread["unsettledAt"] = anchor;
        thread["updatedAt"] = json!(now);
    } else if thread.get("unsettledAt").is_none() {
        thread["unsettledAt"] = Value::Null;
    }
    let cid = command["commandId"].as_str().map(str::to_owned);
    let instance = thread["providerInstanceId"].as_str().map(str::to_owned);
    tx.append(
        Draft::new(&thread_id, "thread.unsettled", thread)
            .command(cid.as_deref())
            .provider_instance(instance.as_deref()),
    )?;
    Ok(vec![])
}

/// `thread.snooze` as `Orchestrator.ts`: the wake time must parse and be in the future, a
/// pending approval refuses it, and only queued runs a person asked for block it. The wake time
/// is stored as UTC in the wire form.
fn thread_snooze(tx: &mut Tx<'_>, command: Value) -> Outcome {
    refuse_archived(tx, &command)?;
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let requested = command["snoozedUntil"].as_str().unwrap_or_default();
    let now = crate::time::millis_from_iso(tx.now()).unwrap_or(0);
    let Some(until) = tx.date_input_millis(requested).filter(|at| *at > now) else {
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

/// A delegated-task completion. This engine marks its completion wakes by their id
/// (`families::deliver`).
pub(crate) fn is_delegated_completion(message: &Value) -> bool {
    !is_null(message, "delegatedCompletion")
        || message["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("message:delegated-completion:"))
}

/// A message the server queued by itself: a notification or a delegated-task completion.
fn is_automatic(message: &Value) -> bool {
    !is_null(message, "notification") || is_delegated_completion(message)
}

fn thread_unsnooze(tx: &mut Tx<'_>, command: Value) -> Outcome {
    refuse_archived(tx, &command)?;
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
    refuse_archived(tx, &command)?;
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
    refuse_archived(tx, &command)?;
    let order_key = command["orderKey"].clone();
    thread_patch(tx, &command, "thread.pinned", |t, now| {
        let was_pinned = !is_null(t, "pinnedAt");
        let promotes = t["settledOverride"] == "settled" || !is_null(t, "snoozedUntil");
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
        if !was_pinned || promotes {
            t["updatedAt"] = json!(now);
        }
        Ok(())
    })
}

fn thread_unpin(tx: &mut Tx<'_>, command: Value) -> Outcome {
    refuse_archived(tx, &command)?;
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
    refuse_archived(tx, &command)?;
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
    refuse_archived(tx, &command)?;
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

/// `thread.pull-request.link` and `unlink`: T3's decider (`pull_requests.rs`). T3 emits
/// `thread.pull-request-synced` with the thread also when nothing changed.
fn thread_pull_request_link(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let thread = live_thread(tx, &thread_id)?;
    let now = tx.now().to_owned();
    let updated = crate::pull_requests::decide(&thread, &command, &now).unwrap_or(thread);
    let cid = command["commandId"].as_str().map(str::to_owned);
    tx.append(
        Draft::new(&thread_id, "thread.pull-request-synced", updated)
            .command(cid.as_deref())
            .payload_instance(),
    )?;
    Ok(vec![])
}

/// `threadIssueKeyOf`: tracker, host and scope compared trimmed and in lower case, key trimmed.
fn issue_key(link: &Value) -> (String, String, String, String) {
    let text = |key: &str| link[key].as_str().unwrap_or_default().trim().to_owned();
    (
        link["tracker"].as_str().unwrap_or_default().to_owned(),
        text("host").to_lowercase(),
        text("scope").to_lowercase(),
        text("key"),
    )
}

/// `thread.issue.link` and `thread.issue.unlink`: T3's decider over the thread's `issues`;
/// `thread.issue-synced` with the thread either way, as T3 emits it.
fn thread_issue_link(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let mut thread = live_thread(tx, &thread_id)?;
    let now = tx.now().to_owned();
    let mut links = thread["issues"].as_array().cloned().unwrap_or_default();
    let key = issue_key(&command);
    let existing = links.iter().position(|link| issue_key(link) == key);
    let changed = match (command["type"].as_str(), existing) {
        (Some("thread.issue.unlink"), Some(index)) => {
            links.remove(index);
            true
        }
        (Some("thread.issue.link"), None) => {
            let link = json!({
                "tracker": command["tracker"],
                "host": key.1,
                "scope": command["scope"].as_str().unwrap_or_default().trim(),
                "key": key.3,
                "projectId": command["projectId"],
                "url": command["url"],
                "displayKey": command["displayKey"],
                "title": command["title"],
                "source": command["source"],
                "linkedAt": now,
            });
            links.push(link);
            true
        }
        _ => false,
    };
    if changed && let Some(map) = thread.as_object_mut() {
        map.insert("issues".into(), json!(links));
        map.insert("updatedAt".into(), json!(now));
    }
    let cid = command["commandId"].as_str().map(str::to_owned);
    tx.append(
        Draft::new(&thread_id, "thread.issue-synced", thread)
            .command(cid.as_deref())
            .payload_instance(),
    )?;
    Ok(vec![])
}

fn thread_pull_request_unlink(tx: &mut Tx<'_>, command: Value) -> Outcome {
    thread_pull_request_link(tx, command)
}

/// `thread.pull-request-link.sync`, from the server's link sweep: the snapshot and stack a host
/// read gave. T3 emits `thread.pull-request-link-updated` (one link); this store keeps whole
/// threads, so it emits `thread.pull-request-synced`. Nothing when no link has the key.
fn thread_pull_request_link_sync(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let thread = live_thread(tx, &thread_id)?;
    if let Some(updated) = crate::pull_requests::decide_link_sync(&thread, &command) {
        let cid = command["commandId"].as_str().map(str::to_owned);
        tx.append(
            Draft::new(&thread_id, "thread.pull-request-synced", updated)
                .command(cid.as_deref())
                .payload_instance(),
        )?;
    }
    Ok(vec![])
}

/// `thread.pull-request.sync`, from the server's branch lookup: the branch's pull request. The
/// guards are T3's: the thread must still have the branch, worktree, project and pull requests
/// the lookup saw, and a replacement of the older single link must see no newer event.
fn thread_pull_request_sync(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let thread = live_thread(tx, &thread_id)?;
    if !is_null(&thread, "archivedAt") {
        return reject(format!("Thread {thread_id} is archived."));
    }
    let expected = &command["expected"];
    let project_id = command["projectId"].as_str().unwrap_or_default();
    let project = tx.project(project_id)?;
    let replaces = command
        .get("linkedPullRequest")
        .is_some_and(Value::is_object);
    let newer = replaces
        && tx.thread_latest_sequence(&thread_id)?
            > command["snapshotSequence"].as_u64().unwrap_or(0);
    let same = |field: &str| thread.get(field).unwrap_or(&Value::Null) == &expected[field];
    let changed = project.is_none_or(|p| p["workspaceRoot"] != expected["workspaceRoot"])
        || newer
        || thread["projectId"] != command["projectId"]
        || !same("branch")
        || !same("worktreePath")
        || !crate::pull_requests::linked_equal(
            thread.get("linkedPullRequest"),
            expected.get("linkedPullRequest"),
        )
        || !crate::pull_requests::linked_equal(
            thread.get("branchPullRequest"),
            expected.get("branchPullRequest"),
        );
    if changed {
        return reject(format!(
            "Thread {thread_id} changed before pull request discovery."
        ));
    }
    let now = tx.now().to_owned();
    let updated = crate::pull_requests::decide_branch_sync(&thread, &command, &now);
    let cid = command["commandId"].as_str().map(str::to_owned);
    tx.append(
        Draft::new(&thread_id, "thread.pull-request-synced", updated)
            .command(cid.as_deref())
            .payload_instance(),
    )?;
    Ok(vec![])
}

fn is_settled_or_archived(thread: &Value) -> bool {
    thread["settledOverride"] == "settled"
        || !is_null(thread, "settledAt")
        || !is_null(thread, "archivedAt")
}

/// `thread.pull-request.watch`: starts or stops a watch (`PullRequestWatchService`, the client).
/// The checks are T3's `dispatchThreadMutation` guards; the change is T3's decider.
fn thread_pull_request_watch(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let thread = live_thread(tx, &thread_id)?;
    if command["watching"] == true {
        if is_settled_or_archived(&thread) {
            return reject(format!(
                "Thread {thread_id} is settled or archived and cannot watch pull requests."
            ));
        }
        if thread["lineage"]["relationshipToParent"] == "subagent" {
            return reject(format!(
                "Thread {thread_id} is a subagent; its parent thread watches pull requests."
            ));
        }
        // Agent watches use the latest executed run to catch calls racing Stop.
        if command["link"]["source"] == "agent" {
            let latest = tx
                .entities(&thread_id, "runs")?
                .into_iter()
                .filter(|r| {
                    r["status"] != "queued"
                        && !(r["status"] == "cancelled" && r["startedAt"].is_null())
                })
                .max_by(|a, b| {
                    let end = |r: &Value| {
                        r["completedAt"]
                            .as_str()
                            .and_then(conn_support::time::millis_from_iso)
                            .unwrap_or(i64::MAX)
                    };
                    end(a).cmp(&end(b)).then_with(|| {
                        a["ordinal"]
                            .as_u64()
                            .unwrap_or(0)
                            .cmp(&b["ordinal"].as_u64().unwrap_or(0))
                    })
                });
            if let Some(latest) = latest
                && interrupt_request(tx, &thread_id, latest["id"].as_str().unwrap_or_default())?
                    .is_some()
            {
                return reject(format!("Thread {thread_id} was stopped."));
            }
        }
    }
    let now = tx.now().to_owned();
    let updated = crate::pull_requests::decide_watch(&thread, &command, &now).unwrap_or(thread);
    let cid = command["commandId"].as_str().map(str::to_owned);
    tx.append(
        Draft::new(&thread_id, "thread.pull-request-synced", updated)
            .command(cid.as_deref())
            .payload_instance(),
    )?;
    Ok(vec![])
}

/// `thread.pull-request-watch.checks-reopen`, sent when an agent's push command ends
/// (`PullRequestSyncReactor.reopenWatchedChecks`).
pub(crate) fn pull_request_watch_checks_reopen(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let thread = live_thread(tx, &thread_id)?;
    if let Some(updated) = crate::pull_requests::reopen_checks(&thread) {
        let cid = command["commandId"].as_str().map(str::to_owned);
        tx.append(
            Draft::new(&thread_id, "thread.pull-request-synced", updated)
                .command(cid.as_deref())
                .payload_instance(),
        )?;
    }
    Ok(vec![])
}

/// `thread.pull-request-watch.sync`, which only the server's watch loop sends: the watch's new
/// state for one or more pull requests of a thread, and at most one wake for them all
/// (`dispatchPullRequestWatchSync`). A watch that ended or moved during the host read, or a
/// wake for a thread that settled, refuses the whole command.
pub(crate) fn pull_request_watch_sync(tx: &mut Tx<'_>, command: Value) -> Outcome {
    const MOVED: &str = "The pull request watch ended or its thread settled while it was read.";
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let mut thread = live_thread(tx, &thread_id)?;
    let wake = command.get("wake").filter(|w| w.is_object());
    let mut primary = command.clone();
    if let Some(map) = primary.as_object_mut() {
        map.remove("others");
        map.remove("wake");
        if wake.is_some_and(|w| w["includesRemarks"] == true) {
            map.insert("includesRemarks".into(), json!(true));
        }
    }
    let mut entries = vec![primary];
    for other in command["others"].as_array().into_iter().flatten() {
        let mut entry = other.clone();
        if let Some(map) = entry.as_object_mut() {
            map.insert("type".into(), command["type"].clone());
            map.insert("commandId".into(), command["commandId"].clone());
            map.insert("threadId".into(), json!(thread_id));
        }
        entries.push(entry);
    }
    let inactive = is_settled_or_archived(&thread)
        || (thread["lineage"]["relationshipToParent"] == "subagent"
            && thread["creationSource"] == "provider");
    let monitor = wake.is_some_and(|w| w["notification"]["source"]["kind"] == "monitor");
    let links: Vec<Option<Value>> = entries
        .iter()
        .map(|entry| crate::pull_requests::sync_link(&thread, entry))
        .collect();
    let outdated: Vec<bool> = entries
        .iter()
        .zip(&links)
        .map(|(entry, link)| {
            monitor
                && entry["watch"].is_object()
                && crate::pull_requests::snapshot_ends_watch(
                    link.as_ref().map_or(&Value::Null, |l| &l["snapshot"]),
                    entry["startedAt"].as_str().unwrap_or_default(),
                )
        })
        .collect();
    let moved = entries.iter().zip(&links).any(|(entry, link)| {
        link.as_ref()
            .and_then(|l| l.get("watch"))
            .and_then(|w| w.get("startedAt"))
            != entry.get("startedAt")
    });
    if moved || (wake.is_some() && inactive) || (entries.len() > 1 && outdated.contains(&true)) {
        return reject(MOVED);
    }
    let now = tx.now().to_owned();
    let mut changed = false;
    for entry in &entries {
        if let Some(updated) = crate::pull_requests::decide_watch(&thread, entry, &now) {
            thread = updated;
            changed = true;
        }
    }
    let cid = command["commandId"].as_str().map(str::to_owned);
    if changed {
        // T3 sends `thread.pull-request-link-updated` per link; this store keeps whole threads.
        tx.append(
            Draft::new(&thread_id, "thread.pull-request-synced", thread)
                .command(cid.as_deref())
                .payload_instance(),
        )?;
    }
    let Some(wake) = wake else {
        return Ok(vec![]);
    };
    if outdated.first() == Some(&true) {
        return Ok(vec![]);
    }
    let sections = wake["sections"].as_array();
    let stamps: Vec<Value> = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let mut stamp = crate::pull_requests::entry_key(entry);
            if let Some(map) = stamp.as_object_mut() {
                map.insert("watchStartedAt".into(), entry["startedAt"].clone());
                let head = if entry["includesRemarks"] == true {
                    Value::Null
                } else {
                    entry["watch"]["headSha"].clone()
                };
                map.insert("headSha".into(), head);
                if entry["watch"].is_null() {
                    map.insert("watchEnded".into(), json!(true));
                }
                if entries.len() > 1
                    && let Some(section) = sections.and_then(|s| s.get(index))
                {
                    map.insert("section".into(), section.clone());
                }
            }
            stamp
        })
        .collect();
    let mut notification = wake["notification"].clone();
    if monitor {
        let mut source = json!({"kind": "monitor"});
        if let Some(map) = source.as_object_mut() {
            map.insert(
                "pullRequest".into(),
                stamps.first().cloned().unwrap_or(Value::Null),
            );
            if stamps.len() > 1 {
                map.insert(
                    "otherPullRequests".into(),
                    json!(stamps.get(1..).unwrap_or_default()),
                );
            }
        }
        notification["source"] = source;
    }
    message_dispatch(
        tx,
        json!({
            "type": "message.dispatch",
            "commandId": command["commandId"],
            "threadId": thread_id,
            "messageId": wake["messageId"],
            "text": wake["text"],
            "notification": notification,
            "attachments": [],
            "dispatchMode": {"type": "queue_after_active"},
            "createdBy": "agent",
            "creationSource": "server",
        }),
    )
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
    let instance = respond_instance(tx, &thread_id, &request)?;
    tx.append(
        Draft::new(&thread_id, "runtime-request.updated", request)
            .node(node.as_deref())
            .provider_instance(instance.as_deref()),
    )?;
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
        tx.append(Draft::new(&thread_id, "provider-session.updated", session).payload_instance())?;
    }
    Ok(vec![Effect::CloseSession { thread_id }])
}

/// `provider.switch`: the next turn runs on another provider instance. That run carries the
/// conversation's history to the new provider (`provider_handoff.rs`).
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
            t["titleRenamed"] = json!(false);
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

#[cfg(test)]
mod html_deletion_tests {
    use super::*;
    use crate::store::Store;

    #[test]
    fn deleting_a_thread_plans_html_cleanup_after_commit() {
        let dir =
            std::env::temp_dir().join(format!("conn-html-cleanup-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let mut tx = store.tx().unwrap();
        tx.append(Draft::new("owner", "thread.created", json!({"id":"owner", "projectId":"p", "createdAt":"2026-01-01T00:00:00.000Z", "updatedAt":"2026-01-01T00:00:00.000Z"}))).unwrap();
        tx.append(Draft::new("owner", "turn-item.updated", json!({"id":"html", "type":"dynamic_tool", "toolName":"html_render", "output":{"htmlRender":{"attachmentId":"owner-00000000-0000-4000-8000-000000000001-html", "title":"Page", "height":100}}}))).unwrap();
        let effects = thread_delete(&mut tx, json!({"threadId":"owner"}))
            .ok()
            .unwrap();
        let ids: Vec<_> = effects
            .into_iter()
            .filter_map(|effect| match effect {
                Effect::CleanupHtmlAttachments { ids, .. } => Some(ids),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(
            ids,
            [(
                "owner".into(),
                "owner-00000000-0000-4000-8000-000000000001-html".into()
            )]
        );
        drop(tx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
