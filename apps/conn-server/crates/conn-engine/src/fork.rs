//! `thread.fork`, as the T3 server forks (`Orchestrator.ts` `dispatchThreadFork`,
//! `ThreadForkService.ts`, `CommandPolicy.ts` `decideForkExecution`, and the native fork in
//! `ProviderTurnStartService.ts`).
//!
//! The command makes the fork thread (a copy of the source with `lineage.relationshipToParent:
//! "fork"`) and a pending `fork` context transfer. The fork's first turn resolves it: the
//! provider forks the source's native thread from the source run's turn
//! (`Session::fork_thread`), the fork works on the new native thread, and the transfer is
//! `consumed` with a `native_fork` resolution.
//!
//! Not built: T3's portable path (`portable_context`, a `full_thread_summary` handoff from
//! `ContextHandoffService.ts`) for a fork to another provider, from an unfinished source run,
//! from a busy source, or after a failed native fork. A message that would need it is refused,
//! and a native fork that fails fails the turn. Side chats that start before the parent's first
//! turn need the same digest and are refused.

use conn_contract::from_json;
use conn_provider::ForkThreadInput;
use conn_support::ids::join_id;
use serde_json::{Value, json};

use crate::commands::{CommandError, Outcome, reject};
use crate::store::{Draft, StoreResult, Tx};

/// `isForkableSourceRunStatus`: `waiting` is a provider-finished run whose checkpoint is due.
fn forkable(status: &str) -> bool {
    matches!(
        status,
        "completed" | "waiting" | "failed" | "interrupted" | "cancelled"
    )
}

/// `latestStableRun`: the newest completed run with a checkpoint.
fn latest_stable_run(runs: &[Value]) -> Option<Value> {
    runs.iter()
        .filter(|r| r["status"] == "completed" && r["checkpointId"].is_string())
        .max_by_key(|r| r["ordinal"].as_u64().unwrap_or(0))
        .cloned()
}

/// `runForSourcePoint`.
fn run_for_source_point(tx: &Tx<'_>, thread_id: &str, point: &Value) -> StoreResult<Option<Value>> {
    let runs = tx.entities(thread_id, "runs")?;
    Ok(match point["type"].as_str() {
        Some("latest_stable") => latest_stable_run(&runs),
        Some("run") => runs.into_iter().find(|r| r["id"] == point["runId"]),
        Some("checkpoint") => {
            let checkpoint = point["checkpointId"]
                .as_str()
                .map(|id| tx.entity(thread_id, "checkpoints", id))
                .transpose()?
                .flatten();
            match checkpoint.as_ref().and_then(|c| c["runId"].as_str()) {
                Some(run_id) => runs.into_iter().find(|r| r["id"] == run_id),
                None => None,
            }
        }
        _ => None,
    })
}

/// The latest provider turn of a run's attempt (`providerTurnForRun`).
fn provider_turn_for_run(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<Option<Value>> {
    let Some(attempt_id) = run["activeAttemptId"].as_str() else {
        return Ok(None);
    };
    let turns = tx.entities(thread_id, "providerTurns")?;
    let latest = turns
        .iter()
        .filter(|t| t["runAttemptId"] == attempt_id)
        .max_by_key(|t| t["ordinal"].as_u64().unwrap_or(0))
        .cloned();
    if latest.is_some() {
        return Ok(latest);
    }
    let attempt = tx.entity(thread_id, "attempts", attempt_id)?;
    Ok(attempt.and_then(|a| turns.into_iter().find(|t| t["id"] == a["providerTurnId"])))
}

/// `contextSourcePointForRun`.
fn source_point(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<Value> {
    let mut point = json!({"threadId": thread_id, "runId": run["id"]});
    if run["checkpointId"].is_string() {
        point["checkpointId"] = run["checkpointId"].clone();
    }
    let provider_thread = run["providerThreadId"]
        .as_str()
        .map(|id| tx.entity(thread_id, "providerThreads", id))
        .transpose()?
        .flatten();
    if let Some(reference) = provider_thread.as_ref().map(|pt| &pt["nativeThreadRef"])
        && reference.is_object()
    {
        point["providerThreadRef"] = reference.clone();
    }
    if let Some(turn) = provider_turn_for_run(tx, thread_id, run)?
        && turn["nativeTurnRef"].is_object()
    {
        point["providerTurnRef"] = turn["nativeTurnRef"].clone();
    }
    Ok(point)
}

/// The admission of `thread.fork`.
pub(crate) fn thread_fork(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let source_id = command["sourceThreadId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let target_id = command["targetThreadId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let command_id = command["commandId"].as_str().unwrap_or_default().to_owned();
    let side_chat = command["sideChat"] == true;
    let point = &command["sourcePoint"];
    let point_type = point["type"].as_str().unwrap_or_default();
    let Some(source) = tx.thread(&source_id)? else {
        return reject(format!("Thread {source_id} does not exist."));
    };
    if tx.thread(&target_id)?.is_some() {
        return reject(format!("Thread {target_id} already exists."));
    }
    let lineage = &source["lineage"];
    if side_chat
        && (lineage["sideChat"] == true
            || lineage["relationshipToParent"] == "subagent"
            || source.get("delegatedFrom").is_some_and(|d| !d.is_null()))
    {
        return reject(if lineage["sideChat"] == true {
            "A side chat cannot start another side chat."
        } else {
            "A subagent cannot start a side chat."
        });
    }
    let Some(run) = run_for_source_point(tx, &source_id, point)? else {
        if side_chat && point_type == "latest_stable" {
            return reject(
                "Conn Server cannot open a side chat before the thread's first turn has finished.",
            );
        }
        return reject(format!(
            "No stable source run was found for fork source {point_type}."
        ));
    };
    let status = run["status"].as_str().unwrap_or_default();
    if !forkable(status) {
        return reject(format!(
            "Fork source run {} is {status}; in-progress and rolled-back runs cannot be forked.",
            run["id"].as_str().unwrap_or_default()
        ));
    }
    let provider_thread = run["providerThreadId"]
        .as_str()
        .map(|id| tx.entity(&source_id, "providerThreads", id))
        .transpose()?
        .flatten();
    let strong = provider_thread
        .as_ref()
        .is_some_and(|pt| pt["nativeThreadRef"]["strength"] == "strong");
    let now = match command["createdAt"].as_str() {
        Some(at) => at.to_owned(),
        None => tx.now().to_owned(),
    };

    // `ThreadForkService.plan`.
    let mut target = source.clone();
    if let Some(map) = target.as_object_mut() {
        map.remove("delegatedFrom");
    }
    if let Some(links) = target["pullRequests"].as_array_mut() {
        for link in links {
            if let Some(map) = link.as_object_mut() {
                map.remove("watch");
            }
        }
    }
    let mut new_lineage = json!({
        "parentThreadId": source_id,
        "relationshipToParent": "fork",
        "rootThreadId": lineage["rootThreadId"],
    });
    if side_chat {
        new_lineage["sideChat"] = json!(true);
    }
    let title = match command["title"].as_str() {
        Some(title) => title.to_owned(),
        None => format!("{} fork", source["title"].as_str().unwrap_or_default()),
    };
    for (field, value) in [
        ("createdBy", command["createdBy"].clone()),
        ("creationSource", command["creationSource"].clone()),
        ("id", json!(target_id)),
        ("title", json!(title)),
        ("titleRegeneration", Value::Null),
        // The source's title job and rename stay with the source thread (#38683).
        ("titleRenamed", json!(false)),
        ("activeProviderThreadId", Value::Null),
        ("lineage", new_lineage),
        (
            "forkedFrom",
            json!({"type": "run", "threadId": source_id, "runId": run["id"]}),
        ),
        ("createdAt", json!(now)),
        ("updatedAt", json!(now)),
        ("archivedAt", Value::Null),
        ("settledOverride", Value::Null),
        ("settledAt", Value::Null),
        ("snoozedUntil", Value::Null),
        ("snoozedAt", Value::Null),
        ("lastSnoozeWakeAt", Value::Null),
        ("pinnedAt", Value::Null),
        ("pinOrderKey", Value::Null),
        ("activeOrderKey", Value::Null),
        ("autoSettleDisabledAt", Value::Null),
        ("guestShare", Value::Null),
        ("lastVisitedAt", Value::Null),
        ("opens", Value::Null),
        ("deletedAt", Value::Null),
        // This server's run bookkeeping starts again on the fork.
        ("activeRunId", Value::Null),
        ("rollbackRequestId", Value::Null),
        ("rollbackFailure", Value::Null),
    ] {
        target[field] = value;
    }
    let mut transfer = json!({
        "id": join_id("context-transfer", &[
            "type", "fork", "source-thread", &source_id, "target-thread", &target_id,
            &conn_support::uuid_v4(),
        ]),
        "type": "fork", "sourceThreadId": source_id, "targetThreadId": target_id,
        "sourcePoint": source_point(tx, &source_id, &run)?, "basePoint": null,
        "sourceProviderInstanceId": run["providerInstanceId"],
        "targetProviderInstanceId": null, "targetRunId": null, "status": "pending",
        "resolution": null, "createdBy": command["createdBy"],
        "error": if strong { Value::Null } else {
            json!("Source provider thread does not expose a strong native thread ref.")
        },
        "createdAt": now, "updatedAt": now, "consumedAt": null,
    });
    // Only native forks keep the source's context size.
    if strong
        && matches!(status, "completed" | "waiting")
        && let Some(usage) = provider_turn_for_run(tx, &source_id, &run)?
            .map(|t| t["tokenUsage"].clone())
            .filter(|u| !u.is_null())
    {
        transfer["sourceTokenUsage"] = usage;
    }
    tx.append(Draft::new(&target_id, "thread.created", target).command(Some(&command_id)))?;
    tx.append(
        Draft::new(&target_id, "context-transfer.created", transfer).command(Some(&command_id)),
    )?;
    Ok(vec![])
}

/// The thread's pending fork transfer (`pendingForkTransferForThread`).
pub(crate) fn pending_fork(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Option<Value>> {
    Ok(tx
        .entities(thread_id, "contextTransfers")?
        .into_iter()
        .find(|t| {
            t["type"] == "fork" && t["targetThreadId"] == thread_id && t["status"] == "pending"
        }))
}

/// `decideForkExecution` for a message on a fork: this server forks natively or not at all.
pub(crate) fn ensure_native_fork(
    tx: &Tx<'_>,
    thread_id: &str,
    instance: &str,
) -> Result<(), CommandError> {
    let Some(transfer) = pending_fork(tx, thread_id)? else {
        return Ok(());
    };
    let source_id = transfer["sourceThreadId"].as_str().unwrap_or_default();
    let runs = tx.entities(source_id, "runs")?;
    let source_run = runs
        .iter()
        .find(|r| r["id"] == transfer["sourcePoint"]["runId"]);
    let provider_thread = source_run
        .and_then(|r| r["providerThreadId"].as_str())
        .map(|id| tx.entity(source_id, "providerThreads", id))
        .transpose()?
        .flatten();
    let capabilities = provider_thread
        .as_ref()
        .and_then(|pt| pt["providerSessionId"].as_str())
        .map(|id| tx.entity(source_id, "providerSessions", id))
        .transpose()?
        .flatten()
        .map(|s| s["capabilities"].clone())
        .unwrap_or(Value::Null);
    let ordinal = source_run.and_then(|r| r["ordinal"].as_u64()).unwrap_or(0);
    let busy = runs
        .iter()
        .any(|r| r["ordinal"].as_u64().unwrap_or(0) > ordinal && crate::commands::is_active(r));
    let native = source_run
        .is_some_and(|r| matches!(r["status"].as_str(), Some("completed" | "waiting")))
        && transfer["sourceProviderInstanceId"] == instance
        && provider_thread
            .as_ref()
            .is_some_and(|pt| pt["nativeThreadRef"]["strength"] == "strong")
        && !busy
        && capabilities["threads"]["canForkThread"] == true
        && capabilities["threads"]["canForkFromTurn"] == true
        && capabilities["identity"]["nativeThreadIds"] == "strong";
    if native {
        return Ok(());
    }
    reject(
        "Conn Server carries a fork's history only through a native fork: the same provider, a finished source turn, and no newer turn running on the source. Send the message on the source thread, or fork again.",
    )
}

/// What the fork's first turn needs to fork the source natively.
pub(crate) struct NativeFork {
    pub(crate) transfer: Value,
    pub(crate) input: ForkThreadInput,
}

/// Reads the source of the thread's pending fork, for its first provider turn.
/// The run's model selection and runtime policy are set by the caller.
pub(crate) fn native_fork_input(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Option<NativeFork>> {
    let Some(transfer) = pending_fork(tx, thread_id)? else {
        return Ok(None);
    };
    let source_id = transfer["sourceThreadId"].as_str().unwrap_or_default();
    let runs = tx.entities(source_id, "runs")?;
    let Some(source_run) = runs
        .iter()
        .find(|r| r["id"] == transfer["sourcePoint"]["runId"])
    else {
        return Ok(None);
    };
    let Some(provider_thread) = source_run["providerThreadId"]
        .as_str()
        .map(|id| tx.entity(source_id, "providerThreads", id))
        .transpose()?
        .flatten()
    else {
        return Ok(None);
    };
    // Rolled-back turns are no longer in the source conversation.
    let rolled_back: Vec<&Value> = runs
        .iter()
        .filter(|r| r["status"] == "rolled_back")
        .map(|r| &r["activeAttemptId"])
        .collect();
    let turns = tx
        .entities(source_id, "providerTurns")?
        .into_iter()
        .filter(|t| t["runAttemptId"].is_null() || !rolled_back.contains(&&t["runAttemptId"]))
        .filter_map(|t| from_json(t).ok())
        .collect();
    let provider_turn_id = provider_turn_for_run(tx, source_id, source_run)?
        .and_then(|t| t["id"].as_str().map(Into::into));
    let Ok(source_provider_thread) = from_json(provider_thread) else {
        return Ok(None);
    };
    Ok(Some(NativeFork {
        transfer,
        input: ForkThreadInput {
            source_provider_thread,
            source_provider_turns: turns,
            provider_turn_id,
            target_thread_id: thread_id.into(),
            owner_node_id: None,
            model_selection: None,
            runtime_policy: None,
        },
    }))
}

/// The transfer once the fork's first turn runs on the forked native thread.
pub(crate) fn consumed(transfer: &Value, provider_thread: &Value, run: &Value, now: &str) -> Value {
    let mut transfer = transfer.clone();
    transfer["targetProviderInstanceId"] = run["providerInstanceId"].clone();
    transfer["targetRunId"] = run["id"].clone();
    transfer["status"] = json!("consumed");
    transfer["resolution"] = json!({
        "strategy": "native_fork",
        "providerThreadRef": provider_thread["nativeThreadRef"],
    });
    transfer["error"] = Value::Null;
    transfer["updatedAt"] = json!(now);
    transfer["consumedAt"] = json!(now);
    transfer
}
