//! What a start does with runs a stopped process left live (`ProviderRuntimeRecoveryService.ts`,
//! `RestartContinuation.ts`).
//!
//! - A run the provider had (`running`) ends `cancelled` with a "Server restarted" notice.
//!   Where `continueThreadsAfterServerUpdate` allows it for the project ([`RestartPolicy`]), a
//!   continuation message asks the agent to go on in the same provider thread, so it keeps its
//!   context. At most 3 continuations chain within 5 minutes; a fourth restart only cancels.
//! - A run whose prompt the provider never accepted (T3's `rewindUnacceptedRuns`) is not sent
//!   again on its own, since the provider may have received it before the process died. A
//!   user's prompt waits at the head of the held queue for the user to send it again. Unattended
//!   work (a scheduled task or an MCP agent's prompt) is sent again, at most 3 times, unless the
//!   thread is archived, deleted, settled or snoozed. Anything else is cancelled.
//! - The evidence of acceptance is the run's `provider-turn.start` row: it settles only after
//!   `Session::start_turn` returned. T3 reads a provider turn of the run's attempt instead, but
//!   our Claude adapter reports its turn before a cold host has the prompt; a store without
//!   start rows (before the outbox) still falls back to provider turns.
//! - A `checkpoint.capture` row the previous process left runs again (replay-safe).
//! - A run waiting on an approval or a question ends `cancelled` with no continuation: the
//!   prompt died with the process and only the user can answer it again.
//! - A run left `waiting` (its provider turn ended, its checkpoint was not taken) is captured
//!   and completed (`checkpoint.capture` again).
//! - Queued runs are held (T3's held queue): the user sends them, after the continuation if one
//!   runs. A continuation an earlier restart admitted, whose start was cut off in turn, is sent
//!   again under the same policy and chain limit; a stored Stop or a waiting request cancels.

use serde_json::{Value, json};

use crate::commands::{self, CommandError, Effect, finish_run};
use crate::store::{Draft, StoreResult, Tx};
use crate::time::millis_from_iso;

/// `continueThreadsAfterServerUpdate`, resolved per project as T3's `resolveProjectSettings`
/// does: whether a restart continues a cut turn and sends unattended work again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestartPolicy {
    /// The machine-wide value (T3's default is on).
    pub continue_by_default: bool,
    /// Project overrides, by project id; each wins over the default either way.
    pub projects: std::collections::HashMap<String, bool>,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            continue_by_default: true,
            projects: std::collections::HashMap::new(),
        }
    }
}

impl RestartPolicy {
    /// Whether work in `project_id` continues after a restart.
    pub fn continues(&self, project_id: Option<&str>) -> bool {
        project_id
            .and_then(|id| self.projects.get(id).copied())
            .unwrap_or(self.continue_by_default)
    }
}

/// `MAX_CONTINUATION_CHAIN` and `CONTINUATION_LOOP_WINDOW_MS`.
const MAX_CHAIN: usize = 3;
const CHAIN_WINDOW_MS: i64 = 5 * 60 * 1000;

/// `CONTINUE_PROMPT` in `RestartContinuation.ts`.
pub(crate) const CONTINUE_PROMPT: &str = "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";

const NOTICE: &str = "Cancelled because the server restarted before the provider work completed.";

/// How many restart continuations lead up to `run`, within the window.
fn chain_length(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<usize> {
    let runs = tx.entities(thread_id, "runs")?;
    let start = run["requestedAt"]
        .as_str()
        .and_then(millis_from_iso)
        .unwrap_or(0);
    let mut length = 0;
    let mut current = run.clone();
    while let Some(source_id) = current["restartContinuationOfRunId"].as_str() {
        let Some(source) = runs.iter().find(|r| r["id"] == source_id) else {
            break;
        };
        let at = source["requestedAt"]
            .as_str()
            .and_then(millis_from_iso)
            .unwrap_or(0);
        if start - at > CHAIN_WINDOW_MS {
            break;
        }
        length += 1;
        current = source.clone();
    }
    Ok(length)
}

fn may_continue(
    tx: &Tx<'_>,
    thread_id: &str,
    run: &Value,
    policy: &RestartPolicy,
) -> StoreResult<bool> {
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(false);
    };
    if !policy.continues(thread["projectId"].as_str()) || stop_requested(tx, thread_id, run)? {
        return Ok(false);
    }
    let resting = !thread["archivedAt"].is_null()
        || thread["settledOverride"] == "settled"
        || !thread["snoozedUntil"].is_null();
    let secret_pending = tx
        .entities_where(thread_id, "turnItems", "secretStatus", "pending")?
        .iter()
        .any(|i| i.get("runId") == run.get("id"));
    let pending = secret_pending
        || !tx
            .entities_where(thread_id, "runtimeRequests", "status", "pending")?
            .is_empty();
    // The provider thread must be one it can resume.
    let resumable = thread["activeProviderThreadId"]
        .as_str()
        .map(|id| tx.entity(thread_id, "providerThreads", id))
        .transpose()?
        .flatten()
        .is_some_and(|pt| pt["nativeThreadRef"]["nativeId"].is_string());
    Ok(run["status"] == "running" && !resting && !pending && resumable)
}

/// `MAX_RESENDS`: a prompt whose start keeps cutting the server short is not sent forever.
const MAX_RESENDS: usize = 3;

/// `rewindUnacceptedRuns`: whether the provider accepted the run's prompt. A run is marked
/// `running` before the provider takes it, so only evidence of acceptance counts.
fn accepted(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<bool> {
    let started =
        run["status"] == "running" || (run["status"] == "starting" && !run["startedAt"].is_null());
    if !started || run["activeAttemptId"].is_null() {
        return Ok(false);
    }
    let run_id = run["id"].as_str().unwrap_or_default();
    let mut turns = vec![];
    for attempt in tx.entities_where(thread_id, "attempts", "runId", run_id)? {
        let attempt_id = attempt["id"].as_str().unwrap_or_default();
        turns.extend(tx.entities_where(thread_id, "providerTurns", "runAttemptId", attempt_id)?);
    }
    // The provider confirmed the turn itself (Codex's `turn/started`, Claude's first usage):
    // it took the prompt, whatever the start row says. Claude reports a weak turn on a cold
    // start before its host has the prompt, so a weak turn proves nothing.
    if turns
        .iter()
        .any(|t| t["nativeTurnRef"]["strength"] == "strong")
    {
        return Ok(true);
    }
    // A store from before the outbox has no start rows: only a confirmed turn counts there.
    Ok(tx.start_settled(run_id)?.unwrap_or(false))
}

/// `restartStopRequested`: Stop was asked for the run, or for the task that delegated its
/// thread while that task still runs.
fn stop_requested(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<bool> {
    let run_id = run["id"].as_str().unwrap_or_default();
    if commands::interrupt_request(tx, thread_id, run_id)?.is_some() {
        return Ok(true);
    }
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(false);
    };
    let Some((parent_id, task)) = crate::families::parent_task(tx, &thread)? else {
        return Ok(false);
    };
    let Some(task_run) = task["runId"].as_str() else {
        return Ok(false);
    };
    let settled = !task["result"].is_null()
        || crate::families::TERMINAL.contains(&task["status"].as_str().unwrap_or("failed"));
    Ok(!settled && commands::interrupt_request(tx, &parent_id, task_run)?.is_some())
}

/// A runtime request of the run still waits for an answer (`unstartedRuns`).
fn request_pending(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<bool> {
    let run_id = run["id"].as_str().unwrap_or_default();
    for request in tx.entities_where(thread_id, "runtimeRequests", "status", "pending")? {
        let node = request["nodeId"]
            .as_str()
            .map(|id| tx.entity(thread_id, "nodes", id))
            .transpose()?
            .flatten();
        if node.is_some_and(|n| n["runId"] == run_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// What a restart does with a run whose prompt the provider never accepted
/// (`reconcileProjection`).
enum Unaccepted {
    /// A user's prompt: it waits in the held queue for the user.
    Hold,
    /// Unattended work nobody reviews: it is sent again.
    Resend,
    /// Everything else ends.
    Cancel,
}

fn unaccepted(
    tx: &Tx<'_>,
    thread_id: &str,
    run: &Value,
    policy: &RestartPolicy,
) -> StoreResult<Unaccepted> {
    if run["status"] == "preparing" {
        return Ok(Unaccepted::Cancel);
    }
    let message = tx
        .entity(
            thread_id,
            "messages",
            run["userMessageId"].as_str().unwrap_or_default(),
        )?
        .unwrap_or(Value::Null);
    let delivered_elsewhere =
        message["notification"].is_object() || message["delegatedCompletion"].is_object();
    let scheduled = message["scheduledTaskId"].is_string();
    if request_pending(tx, thread_id, run)? {
        return Ok(Unaccepted::Cancel);
    }
    if message["createdBy"] == "user" && !scheduled && !delivered_elsewhere {
        return Ok(Unaccepted::Hold);
    }
    // A continuation an earlier restart admitted: its start was cut off too.
    let continuation = run["restartContinuationOfRunId"].is_string();
    if delivered_elsewhere || !(scheduled || continuation || message["creationSource"] == "mcp") {
        return Ok(Unaccepted::Cancel);
    }
    let run_id = run["id"].as_str().unwrap_or_default();
    let project = tx
        .thread(thread_id)?
        .and_then(|t| t["projectId"].as_str().map(str::to_owned));
    // A continuation sent again keeps its run id, so its claimed resends count as links of
    // the chain (T3 counts the process losses of the continuation).
    let capped = if continuation {
        chain_length(tx, thread_id, run)? + tx.resends(&resend_command(run_id))? >= MAX_CHAIN
    } else {
        tx.resends(&resend_command(run_id))? >= MAX_RESENDS
    };
    if !policy.continues(project.as_deref())
        || blocked(tx, thread_id)?
        || capped
        || stop_requested(tx, thread_id, run)?
    {
        return Ok(Unaccepted::Cancel);
    }
    Ok(Unaccepted::Resend)
}

/// `restartContinuationBlocked`, for the thread: a resting thread gets no unattended work.
fn blocked(tx: &Tx<'_>, thread_id: &str) -> StoreResult<bool> {
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(true);
    };
    let snoozed = thread["snoozedUntil"]
        .as_str()
        .and_then(millis_from_iso)
        .is_some_and(|until| until > tx.now_ms() as i64);
    Ok(!thread["archivedAt"].is_null()
        || !thread["deletedAt"].is_null()
        || thread["settledOverride"] == "settled"
        || snoozed)
}

fn resend_command(run_id: &str) -> String {
    format!("command:restart-resend:{run_id}")
}

/// Puts a run whose prompt never arrived at the head of the held queue, with the thread's
/// queued runs behind it, all held; its prompt goes back to pending.
fn hold(tx: &mut Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<()> {
    let run_id = run["id"].as_str().unwrap_or_default().to_owned();
    let queued = commands::queued_runs(tx, thread_id)?;
    let mut held = run.clone();
    held["status"] = json!("queued");
    held["queueHeld"] = json!(true);
    held["queuePosition"] = json!(1);
    held["startedAt"] = Value::Null;
    tx.append(Draft::new(thread_id, "run.updated", held).run(Some(&run_id)))?;
    for (index, mut other) in queued.into_iter().enumerate() {
        other["queueHeld"] = json!(true);
        other["queuePosition"] = json!(index + 2);
        let id = other["id"].as_str().unwrap_or_default().to_owned();
        tx.append(Draft::new(thread_id, "run.updated", other).run(Some(&id)))?;
    }
    let message_id = run["userMessageId"].as_str().unwrap_or_default();
    if let Some(mut item) = tx.entity(thread_id, "turnItems", &format!("turn-item:{message_id}"))? {
        let now = tx.now().to_owned();
        item["inputIntent"] = json!("queued_turn");
        item["status"] = json!("pending");
        item["startedAt"] = Value::Null;
        item["completedAt"] = Value::Null;
        item["updatedAt"] = json!(now);
        tx.append(Draft::new(thread_id, "turn-item.updated", item).run(Some(&run_id)))?;
    }
    Ok(())
}

/// A run kept for another start (held or sent again): its running attempt and root node go
/// back to pending, as T3 resets them for every kept run.
fn reset_start(tx: &mut Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<()> {
    let run_id = run["id"].as_str().unwrap_or_default().to_owned();
    if let Some(attempt_id) = run["activeAttemptId"].as_str()
        && let Some(mut attempt) = tx.entity(thread_id, "attempts", attempt_id)?
        && attempt["status"] == "running"
    {
        attempt["status"] = json!("pending");
        attempt["startedAt"] = Value::Null;
        tx.append(Draft::new(thread_id, "run-attempt.updated", attempt).run(Some(&run_id)))?;
    }
    let root = run["rootNodeId"].as_str().map(str::to_owned);
    if let Some(root) = &root
        && let Some(mut node) = tx.entity(thread_id, "nodes", root)?
        && node["status"] == "running"
    {
        node["status"] = json!("pending");
        node["startedAt"] = Value::Null;
        tx.append(
            Draft::new(thread_id, "node.updated", node)
                .run(Some(&run_id))
                .node(Some(root)),
        )?;
    }
    Ok(())
}

/// The previous process's provider sessions are gone with it.
fn stop_sessions(tx: &mut Tx<'_>, thread_id: &str) -> StoreResult<()> {
    let now = tx.now().to_owned();
    for mut session in tx.entities(thread_id, "providerSessions")? {
        if session["status"] != "stopped" {
            session["status"] = json!("stopped");
            session["updatedAt"] = json!(now);
            tx.append(
                Draft::new(thread_id, "provider-session.updated", session).payload_instance(),
            )?;
        }
    }
    Ok(())
}

/// Recovers one live run at start. Returns the effects to run once the runtime is up.
pub(crate) fn recover(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    policy: &RestartPolicy,
) -> StoreResult<Vec<Effect>> {
    let run_id = run["id"].as_str().unwrap_or_default().to_owned();
    // The previous process's sessions are gone. Its queued prompts are held already (`open`).
    stop_sessions(tx, thread_id)?;
    // The provider finished; only the checkpoint capture was cut off. A capture row the
    // previous process left is replay-safe and runs again by itself.
    if run["status"] == "waiting" {
        if tx.capture_queued(&run_id)? {
            return Ok(vec![]);
        }
        return Ok(vec![crate::checkpoint::resume_capture(thread_id, run)]);
    }
    let continues = if accepted(tx, thread_id, run)? {
        may_continue(tx, thread_id, run, policy)? && chain_length(tx, thread_id, run)? < MAX_CHAIN
    } else {
        match unaccepted(tx, thread_id, run, policy)? {
            Unaccepted::Hold => {
                reset_start(tx, thread_id, run)?;
                hold(tx, thread_id, run)?;
                return Ok(vec![]);
            }
            Unaccepted::Resend => {
                reset_start(tx, thread_id, run)?;
                let mut again = run.clone();
                again["status"] = json!("starting");
                again["startedAt"] = Value::Null;
                tx.append(Draft::new(thread_id, "run.updated", again).run(Some(&run_id)))?;
                let start = Effect::StartTurn {
                    thread_id: thread_id.to_owned(),
                    run_id: run_id.clone(),
                };
                tx.enqueue(Some(&resend_command(&run_id)), &[start])?;
                return Ok(vec![]);
            }
            Unaccepted::Cancel => false,
        }
    };
    finish_run(tx, thread_id, &run_id, "cancelled", None)?;
    let now = tx.now().to_owned();
    tx.append(
        Draft::new(
            thread_id,
            "turn-item.updated",
            json!({
                "id": format!("turn-item:{run_id}:server-recovery"),
                "threadId": thread_id, "runId": run_id, "nodeId": run["rootNodeId"],
                "providerThreadId": run["providerThreadId"], "providerTurnId": null,
                "nativeItemRef": null, "parentItemId": null, "ordinal": 0, "status": "completed",
                "title": "Server restarted", "startedAt": now, "completedAt": now, "updatedAt": now,
                "type": "system_notice", "message": NOTICE,
            }),
        )
        .run(Some(&run_id)),
    )?;
    // Without a continuation the run ends here: a delegated child's parent hears of it now.
    if !continues {
        return crate::families::on_run_end(tx, thread_id, &run_id);
    }
    let dispatch = commands::handler("message.dispatch").expect("message.dispatch");
    let outcome = dispatch(
        tx,
        json!({
            "type": "message.dispatch",
            "commandId": format!("command:restart-continuation:{run_id}"),
            "threadId": thread_id,
            "messageId": format!("message:restart-continuation:{run_id}"),
            "text": CONTINUE_PROMPT,
            "attachments": [],
            "modelSelection": run["modelSelection"],
            "dispatchMode": {"type": "start_immediately"},
            "createdBy": "agent",
            "creationSource": "server",
            "restartContinuationOfRunId": run_id,
        }),
    );
    match outcome {
        Ok(effects) => Ok(effects),
        Err(CommandError::Store(e)) => Err(e),
        Err(CommandError::Rejected(e)) => {
            eprintln!("conn-engine: no restart continuation for {thread_id}: {e}");
            Ok(vec![])
        }
    }
}
