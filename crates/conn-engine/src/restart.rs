//! What a start does with runs a stopped process left live (`ProviderRuntimeRecoveryService.ts`,
//! `RestartContinuation.ts`).
//!
//! - A run the provider had (`running`) ends `cancelled` with a "Server restarted" notice, and a
//!   continuation message asks the agent to go on in the same provider thread, so it keeps its
//!   context. At most 3 continuations chain within 5 minutes; a fourth restart only cancels.
//! - A run the provider never took (`preparing`, `starting`) starts again: its message was not
//!   delivered, so sending it is not a repeat.
//! - A run waiting on an approval or a question ends `cancelled` with no continuation: the
//!   prompt died with the process and only the user can answer it again.
//! - A run left `waiting` (its provider turn ended, its checkpoint was not taken) is captured
//!   and completed (`checkpoint.capture` again).
//! - Queued runs stay queued and start after the continuation, as after any turn.

use serde_json::{Value, json};

use crate::commands::{self, CommandError, Effect, finish_run};
use crate::store::{Draft, StoreResult, Tx};
use crate::time::millis_from_iso;

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

fn may_continue(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<bool> {
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(false);
    };
    let resting = !thread["archivedAt"].is_null()
        || thread["settledOverride"] == "settled"
        || !thread["snoozedUntil"].is_null();
    let pending = !tx
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

/// Recovers one live run at start. Returns the effects to run once the runtime is up.
pub(crate) fn recover(tx: &mut Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<Vec<Effect>> {
    let run_id = run["id"].as_str().unwrap_or_default().to_owned();
    // The provider finished; only the checkpoint capture was cut off.
    if run["status"] == "waiting" {
        return Ok(vec![crate::checkpoint::resume_capture(thread_id, run)]);
    }
    if matches!(run["status"].as_str(), Some("preparing" | "starting")) {
        let mut again = run.clone();
        again["status"] = json!("starting");
        tx.append(Draft::new(thread_id, "run.updated", again).run(Some(&run_id)))?;
        return Ok(vec![Effect::StartTurn {
            thread_id: thread_id.to_owned(),
            run_id,
        }]);
    }
    let continues =
        may_continue(tx, thread_id, run)? && chain_length(tx, thread_id, run)? < MAX_CHAIN;
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
    for mut session in tx.entities(thread_id, "providerSessions")? {
        if session["status"] != "stopped" {
            session["status"] = json!("stopped");
            session["updatedAt"] = json!(now);
            tx.append(Draft::new(thread_id, "provider-session.updated", session))?;
        }
    }
    if !continues {
        return Ok(commands::start_next_queued(tx, thread_id, None)?
            .into_iter()
            .collect());
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
