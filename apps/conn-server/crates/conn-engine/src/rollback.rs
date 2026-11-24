//! `checkpoint.rollback`, as the T3 server runs it (`Orchestrator.ts`
//! `dispatchCheckpointRollback`, `CheckpointRollbackService.ts`, `CheckpointRestoreSafety.ts`).
//!
//! Admission checks the target and records the request on the thread
//! (`rollbackRequestId`, `checkpoint.rollback-requested`). The effect then, in T3's order:
//! rolls the provider's native thread back (`Session::rollback_thread`, only when runs follow
//! the target), restores the files (unless `restoreFiles: false`), deletes the refs of the
//! checkpoints it makes stale, and writes the result in one commit: the provider thread, the
//! stale checkpoints, and every later run and its root node `rolled_back`. A failure at any of
//! the three steps writes nothing of that and sets `rollbackFailure` on the thread
//! (`checkpoint.rollback.fail`), after T3's effect worker's retries (up to 5 attempts). A retry
//! repeats only the step that failed: the provider rollback is sent once per request, and the
//! live session moves to the rolled-back thread only after the commit (T3 repeats every step;
//! see `RollbackProgress`).

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_contract::{from_json, to_json};
use conn_provider::{RollbackTarget, RollbackThreadInput};
use conn_vcs::checkpoint as git;
use serde_json::{Value, json};

use crate::commands::{CommandError, Effect, Outcome, live_thread, reject};
use crate::engine::Inner;
use crate::outbox::Settled;
use crate::store::{CaptureFolder, Draft, StoreResult, Tx};

/// `ROLLBACK_FAILED_MESSAGE`.
pub(crate) const ROLLBACK_FAILED_MESSAGE: &str = "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";
/// `SHARED_WORKSPACE_RESTORE_MESSAGE`.
pub(crate) const SHARED_WORKSPACE_RESTORE_MESSAGE: &str = "File restore requires an isolated worktree. This workspace may contain changes from another thread or a side chat. Rewind the conversation without restoring files instead, or delete side chats you no longer need.";

/// Not in T3, which restores a checkpoint into the scope's folder whichever checkout took it.
pub(crate) const OTHER_CHECKOUT_RESTORE_MESSAGE: &str = "File restore needs the checkout this checkpoint was taken in, and the thread has moved to another checkout since. Rewind the conversation without restoring files instead.";

/// Whether another checkout than the scope's folder now took `checkpoint`, or one the log
/// cannot tell. Worktrees of one repository share its refs, so restoring it here would put
/// that checkout's files into this one and remove what only this one has.
fn captured_elsewhere(
    tx: &Tx<'_>,
    thread_id: &str,
    checkpoint: &Value,
    scope: &Value,
) -> StoreResult<bool> {
    let id = checkpoint["id"].as_str().unwrap_or_default();
    let now = scope["cwd"].as_str().unwrap_or_default();
    Ok(match tx.checkpoint_capture_folder(thread_id, id)? {
        CaptureFolder::Imported => false,
        CaptureFolder::Unknown => true,
        CaptureFolder::Known(captured) => captured != now && resolve(&captured) != resolve(now),
    })
}

/// `latestProviderTurnForAttempt`, else the attempt's own turn id.
fn provider_turn_for_attempt(turns: &[Value], attempt: &Value) -> Option<Value> {
    turns
        .iter()
        .filter(|t| t["runAttemptId"] == attempt["id"])
        .max_by_key(|t| t["ordinal"].as_u64().unwrap_or(0))
        .or_else(|| turns.iter().find(|t| t["id"] == attempt["providerTurnId"]))
        .cloned()
}

fn provider_turn_for_run(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<Option<Value>> {
    let Some(attempt_id) = run["activeAttemptId"].as_str() else {
        return Ok(None);
    };
    let Some(attempt) = tx.entity(thread_id, "attempts", attempt_id)? else {
        return Ok(None);
    };
    Ok(provider_turn_for_attempt(
        &tx.entities(thread_id, "providerTurns")?,
        &attempt,
    ))
}

/// The real path, or the path as given when it does not exist (rollback may recreate it).
fn resolve(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn contains(parent: &Path, child: &Path) -> bool {
    child.starts_with(parent)
}

/// `isCheckpointRestoreIsolated`: the thread has its own worktree, the scope works in it, and
/// no other thread's folders overlap it. Reads the file system: call it on the store thread.
pub(crate) fn restore_isolated(tx: &Tx<'_>, thread: &Value, scope: &Value) -> StoreResult<bool> {
    let Some(worktree) = thread["worktreePath"].as_str() else {
        return Ok(false);
    };
    let cwd = resolve(scope["cwd"].as_str().unwrap_or_default());
    if cwd != resolve(worktree) {
        return Ok(false);
    }
    let own_id = thread["id"].as_str().unwrap_or_default();
    let others = tx
        .conn()
        .prepare("SELECT id FROM threads WHERE deleted = 0 AND id != ?1")
        .and_then(|mut stmt| {
            stmt.query_map([own_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<String>, _>>()
        })
        .map_err(|e| e.to_string())?;
    for other_id in others {
        let Some(other) = tx.thread(&other_id)? else {
            continue;
        };
        // An idle side chat that only answered questions never touched the worktree.
        if other["lineage"]["sideChat"] == true
            && other["activeRunId"].is_null()
            && other["worktreePath"].as_str() == Some(worktree)
        {
            let touched = tx.entities(&other_id, "turnItems")?.iter().any(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("command_execution" | "file_change" | "dynamic_tool")
                )
            });
            if !touched {
                continue;
            }
        }
        let mut paths: Vec<String> = vec![];
        if let Some(path) = other["worktreePath"].as_str() {
            paths.push(path.to_owned());
        }
        paths.extend(
            tx.entities(&other_id, "checkpointScopes")?
                .iter()
                .filter_map(|s| s["cwd"].as_str().map(str::to_owned)),
        );
        if other["worktreePath"].is_null() {
            match tx.project_any(other["projectId"].as_str().unwrap_or_default())? {
                Some(project) => {
                    if let Some(root) = project["workspaceRoot"].as_str() {
                        paths.push(root.to_owned());
                    }
                }
                None => return Ok(false),
            }
        }
        for path in paths {
            let Ok(other_cwd) = std::fs::canonicalize(&path) else {
                continue;
            };
            if contains(&cwd, &other_cwd) || contains(&other_cwd, &cwd) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn rejected<T>(message: impl Into<String>) -> Result<T, CommandError> {
    reject(message)
}

/// The admission of `checkpoint.rollback`.
pub(crate) fn checkpoint_rollback(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
    let command_id = command["commandId"].as_str().unwrap_or_default().to_owned();
    let checkpoint_id = command["checkpointId"].as_str().unwrap_or_default();
    let scope_id = command["scopeId"].as_str().unwrap_or_default();
    let restore_files = command["restoreFiles"].as_bool();
    let mut thread = live_thread(tx, &thread_id)?;
    let provider_thread = match thread["activeProviderThreadId"].as_str() {
        Some(id) => tx.entity(&thread_id, "providerThreads", id)?,
        None => None,
    };
    let Some(provider_thread) = provider_thread else {
        return rejected("No active provider thread exists for rollback.");
    };
    if provider_thread["providerSessionId"].as_str().is_none() {
        return rejected(format!(
            "Provider thread {} has no provider session.",
            provider_thread["id"].as_str().unwrap_or_default()
        ));
    }
    let instance = thread["modelSelection"]["instanceId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // `providerAdapters.get(instance).getCapabilities()`, asked before the store write
    // (`Inner::rollback_capabilities`), then `CommandPolicy.ensureRollback`.
    let asked = &command["providerCapabilities"];
    if asked["instanceId"].as_str() != Some(instance.as_str()) {
        return rejected(format!(
            "The thread's provider instance changed while rollback {command_id} was checked. Try again."
        ));
    }
    let Some(caps) = asked.get("capabilities") else {
        return rejected(
            asked["error"]
                .as_str()
                .unwrap_or("The provider's capabilities are unavailable.")
                .to_owned(),
        );
    };
    let unsupported = |capability: &str, detail: &str| {
        format!("{instance} cannot satisfy {capability} for command {command_id}: {detail}")
    };
    if caps["threads"]["canRollbackThread"] != true
        || caps["checkpointing"]["providerCanRollbackConversation"] != true
    {
        return rejected(unsupported(
            "rollback",
            "providerInstanceId conversation rollback is unavailable",
        ));
    }
    if caps["checkpointing"]["providerRollbackReturnsSnapshot"] != true {
        return rejected(unsupported(
            "rollback_snapshot",
            "rollback must return a providerInstanceId thread snapshot",
        ));
    }
    let Some(checkpoint) = tx.entity(&thread_id, "checkpoints", checkpoint_id)? else {
        return rejected(format!("Checkpoint {checkpoint_id} was not found."));
    };
    let status = checkpoint["status"].as_str().unwrap_or_default();
    if status != "ready" && !(restore_files == Some(false) && status == "missing") {
        return rejected(format!(
            "Checkpoint {checkpoint_id} is {status} and cannot be restored."
        ));
    }
    let target_scope_id = checkpoint["scopeId"].as_str().unwrap_or_default();
    let Some(scope) = tx.entity(&thread_id, "checkpointScopes", target_scope_id)? else {
        return rejected(format!("Checkpoint scope {target_scope_id} was not found."));
    };
    if target_scope_id != scope_id {
        return rejected(format!(
            "Checkpoint {checkpoint_id} belongs to scope {target_scope_id}, not {scope_id}."
        ));
    }
    if restore_files != Some(false) && !restore_isolated(tx, &thread, &scope)? {
        return rejected(SHARED_WORKSPACE_RESTORE_MESSAGE);
    }
    if restore_files != Some(false) && captured_elsewhere(tx, &thread_id, &checkpoint, &scope)? {
        return rejected(OTHER_CHECKOUT_RESTORE_MESSAGE);
    }
    let target_ordinal = checkpoint["appRunOrdinal"].as_u64().unwrap_or(0);
    if target_ordinal > 0 {
        let target_run = tx
            .entities(&thread_id, "runs")?
            .into_iter()
            .find(|run| run["ordinal"] == target_ordinal);
        let turn = match &target_run {
            Some(run) if run["status"] != "rolled_back" => {
                provider_turn_for_run(tx, &thread_id, run)?
            }
            _ => None,
        };
        let Some(turn) = turn else {
            return rejected(format!(
                "Cannot roll back to checkpoint {checkpoint_id}: its provider turn is unavailable."
            ));
        };
        if turn["providerThreadId"] != provider_thread["id"] {
            return rejected(format!(
                "Cannot roll back provider thread {} to checkpoint {checkpoint_id}: target provider turn {} belongs to provider thread {}.",
                provider_thread["id"].as_str().unwrap_or_default(),
                turn["id"].as_str().unwrap_or_default(),
                turn["providerThreadId"].as_str().unwrap_or_default(),
            ));
        }
    }
    let now = tx.now().to_owned();
    thread["rollbackRequestId"] = json!(command_id);
    thread["rollbackFailure"] = Value::Null;
    thread["updatedAt"] = json!(now);
    let selection = thread["modelSelection"]["instanceId"]
        .as_str()
        .map(str::to_owned);
    tx.append(
        Draft::new(&thread_id, "thread.metadata-updated", thread)
            .command(Some(&command_id))
            .payload_instance(),
    )?;
    tx.append(
        Draft::new(
            &thread_id,
            "checkpoint.rollback-requested",
            json!({"scopeId": scope_id, "checkpointId": checkpoint_id, "requestedAt": now}),
        )
        .command(Some(&command_id))
        .provider_instance(selection.as_deref()),
    )?;
    let request = RollbackRequest {
        thread_id,
        command_id,
        provider_thread_id: provider_thread["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        checkpoint_id: checkpoint_id.to_owned(),
        scope_id: scope_id.to_owned(),
        restore_files,
        resume_snapshot: None,
    };
    Ok(vec![Effect::Rollback(request)])
}

/// The `provider-thread.rollback` effect.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RollbackRequest {
    pub(crate) thread_id: String,
    pub(crate) command_id: String,
    pub(crate) provider_thread_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) scope_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) restore_files: Option<bool>,
    /// The provider's answer a previous process stored before it stopped: the rollback goes on
    /// from the file restore and sends no provider rollback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) resume_snapshot: Option<Value>,
}

/// The client message for a rollback a previous process stopped in after it sent the provider
/// rollback: whether the provider rolled back is unknown, and a second provider rollback could
/// cut its conversation again.
pub(crate) const ROLLBACK_INTERRUPTED_MESSAGE: &str = "The server stopped during this rollback, after it asked the provider to roll back. The provider's conversation may already be rolled back, while the files and the turns here are not. Check the conversation before you try again.";

/// What a restart does with a rollback a previous process left unsettled (T3 requeues
/// `provider-thread.rollback` after a process loss, `EffectOutbox.reconcileAfterProcessLoss`).
/// Before the provider rollback was sent, and after its answer was stored, the row runs again
/// from that point (the worker hands it the stored answer). In between, sending it again could
/// cut a Codex thread twice, so the rollback fails with [`ROLLBACK_INTERRUPTED_MESSAGE`].
pub(crate) fn recover_pending(
    tx: &mut Tx<'_>,
    thread_id: &str,
    command_id: &str,
    phase: &str,
    snapshot: Option<&Value>,
) -> StoreResult<()> {
    match (phase, snapshot) {
        ("admitted", _) | ("provider_done", Some(_)) => Ok(()),
        _ => write_rollback_failure(tx, thread_id, command_id, ROLLBACK_INTERRUPTED_MESSAGE),
    }
}

/// The stored provider answer a claimed rollback goes on from, if its row recorded one.
pub(crate) fn resume_from(request: &mut RollbackRequest, progress: Option<&Value>) {
    if let Some(progress) = progress
        && progress["phase"] == "provider_done"
        && !progress["snapshot"].is_null()
    {
        request.resume_snapshot = Some(progress["snapshot"].clone());
    }
}

/// `checkpoint.rollback.fail`: settles the rollback's row and sets `rollbackFailure` while
/// the request is still the thread's.
fn write_rollback_failure(
    tx: &mut Tx<'_>,
    tid: &str,
    request_id: &str,
    message: &str,
) -> StoreResult<()> {
    tx.settle_rollback(tid, request_id, Settled::Failed, Some(message))?;
    let Some(mut thread) = tx.thread(tid)? else {
        return Ok(());
    };
    if thread["rollbackRequestId"] != request_id {
        return Ok(());
    }
    let now = tx.now().to_owned();
    thread["rollbackFailure"] = json!({"requestId": request_id, "message": message});
    thread["updatedAt"] = json!(now);
    tx.append(
        Draft::new(tid, "thread.metadata-updated", thread)
            .payload_instance()
            .command(Some(&format!("{request_id}:rollback-failed"))),
    )?;
    Ok(())
}

/// `getCheckpointRollbackContext`.
struct RollbackContext {
    thread: Value,
    provider_thread: Value,
    checkpoint: Value,
    scope: Value,
    target_turn: Option<Value>,
    runs: Vec<Value>,
    root_nodes: Vec<Value>,
    provider_thread_turns: Vec<Value>,
    stale: Vec<Value>,
    isolated: bool,
    captured_elsewhere: bool,
}

enum RollbackFailure {
    /// The target is incomplete or the thread moved on; T3's ids are in the log line.
    Invalid(&'static str),
    Shared,
    Failed(String),
    /// This engine may not send the provider rollback: another engine owns the store, or the
    /// rollback is not in the phase this run left it in. It stops and writes nothing.
    Fenced,
}

fn read_context(
    tx: &Tx<'_>,
    request: &RollbackRequest,
) -> StoreResult<Result<RollbackContext, RollbackFailure>> {
    let tid = request.thread_id.as_str();
    let Some(thread) = tx.thread(tid)? else {
        return Ok(Err(RollbackFailure::Invalid("rollback-target-invalid")));
    };
    let provider_thread = tx.entity(tid, "providerThreads", &request.provider_thread_id)?;
    let checkpoint = tx.entity(tid, "checkpoints", &request.checkpoint_id)?;
    let scope = tx.entity(tid, "checkpointScopes", &request.scope_id)?;
    let (Some(provider_thread), Some(checkpoint), Some(scope)) =
        (provider_thread, checkpoint, scope)
    else {
        return Ok(Err(RollbackFailure::Invalid("rollback-target-invalid")));
    };
    let status = checkpoint["status"].as_str().unwrap_or_default();
    if provider_thread["providerSessionId"].is_null()
        || checkpoint["scopeId"] != scope["id"]
        || (status != "ready" && !(request.restore_files == Some(false) && status == "missing"))
    {
        return Ok(Err(RollbackFailure::Invalid("rollback-target-invalid")));
    }
    if provider_thread["id"] != thread["activeProviderThreadId"]
        || provider_thread["providerInstanceId"] != thread["modelSelection"]["instanceId"]
    {
        return Ok(Err(RollbackFailure::Invalid("active-provider-changed")));
    }
    let target = checkpoint["appRunOrdinal"].as_u64().unwrap_or(0);
    let all_runs = tx.entities(tid, "runs")?;
    let all_turns = tx.entities(tid, "providerTurns")?;
    let target_attempt = all_runs
        .iter()
        .find(|r| r["ordinal"] == target && r["status"] != "rolled_back")
        .and_then(|r| r["activeAttemptId"].as_str())
        .map(|id| tx.entity(tid, "attempts", id))
        .transpose()?
        .flatten();
    let target_turn = match &target_attempt {
        Some(attempt) if target > 0 => provider_turn_for_attempt(&all_turns, attempt),
        _ => None,
    };
    let mut runs: Vec<Value> = all_runs
        .iter()
        .filter(|r| {
            r["ordinal"].as_u64().unwrap_or(0) > target
                && matches!(
                    r["status"].as_str(),
                    Some("completed" | "interrupted" | "failed" | "cancelled")
                )
        })
        .cloned()
        .collect();
    runs.sort_by_key(|r| r["ordinal"].as_u64().unwrap_or(0));
    let mut root_nodes = vec![];
    for run in &runs {
        if let Some(node) = tx.entity(tid, "nodes", run["rootNodeId"].as_str().unwrap_or(""))? {
            root_nodes.push(node);
        }
    }
    let rolled_back_attempts: Vec<&Value> = all_runs
        .iter()
        .filter(|r| r["status"] == "rolled_back")
        .map(|r| &r["activeAttemptId"])
        .collect();
    let provider_thread_turns = all_turns
        .iter()
        .filter(|t| {
            t["providerThreadId"] == provider_thread["id"]
                && (t["runAttemptId"].is_null()
                    || !rolled_back_attempts.contains(&&t["runAttemptId"]))
        })
        .cloned()
        .collect();
    let mut stale: Vec<Value> = tx
        .entities_where(tid, "checkpoints", "scopeId", &request.scope_id)?
        .into_iter()
        .filter(|c| {
            c["status"] == "ready" && c["appRunOrdinal"].as_u64().is_some_and(|n| n > target)
        })
        .collect();
    stale.sort_by_key(|c| c["ordinalWithinScope"].as_u64().unwrap_or(0));
    let isolated = restore_isolated(tx, &thread, &scope)?;
    let captured_elsewhere = captured_elsewhere(tx, tid, &checkpoint, &scope)?;
    Ok(Ok(RollbackContext {
        thread,
        provider_thread,
        checkpoint,
        scope,
        target_turn,
        runs,
        root_nodes,
        provider_thread_turns,
        stale,
        isolated,
        captured_elsewhere,
    }))
}

/// T3's `maxAttempts` for an effect.
const ROLLBACK_ATTEMPTS: u32 = 5;

/// T3's retry delay after the `attempt`-th failure: `min(30 s, 100 ms * 2^(attempt - 1))`.
fn retry_delay(attempt: u32) -> std::time::Duration {
    let factor = 2u64.saturating_pow(attempt.saturating_sub(1));
    std::time::Duration::from_millis(100u64.saturating_mul(factor).min(30_000))
}

/// What one rollback request has done so far, kept across its attempts: a retry repeats only
/// the step that failed. T3 runs every step again on each attempt
/// (`CheckpointRollbackService.execute` under `EffectWorker`'s retries), so a Codex thread is
/// cut again on each retry; this server sends the provider rollback once per request.
#[derive(Default)]
struct RollbackProgress {
    /// The provider's answer: the row to commit, and the live session to move to it once the
    /// commit is done.
    provider: Option<(Value, Option<ProviderUpdate>)>,
    /// This run moved the rollback to `provider`; a retry goes on from there.
    provider_sent: bool,
    files_restored: bool,
    refs_deleted: bool,
}

type ProviderUpdate = (
    Arc<crate::runner::LiveThread>,
    conn_contract::ProviderThread,
);

impl RollbackFailure {
    fn detail(&self) -> String {
        match self {
            Self::Invalid(reason) => (*reason).to_owned(),
            Self::Shared => "shared-workspace".to_owned(),
            Self::Failed(detail) => detail.clone(),
            Self::Fenced => "fenced".to_owned(),
        }
    }
}

impl Inner {
    /// Runs a rollback the command admitted. Never fails: a failure is recorded on the thread.
    /// As T3's effect worker: up to [`ROLLBACK_ATTEMPTS`] attempts, 100 ms after the first
    /// failure and twice as long after each next one (at most 30 s); only the last failure is
    /// recorded. The effect holds its thread's lane meanwhile, so no turn starts in between.
    pub(crate) async fn rollback(self: &Arc<Self>, request: RollbackRequest) {
        let mut attempt = 1;
        let mut progress = RollbackProgress {
            provider: request.resume_snapshot.clone().map(|row| (row, None)),
            ..RollbackProgress::default()
        };
        let outcome = loop {
            match self.try_rollback(&request, &mut progress).await {
                Ok(()) => break Ok(()),
                Err(RollbackFailure::Fenced) => {
                    eprintln!(
                        "conn-engine: rollback {} of {} is no longer this engine's",
                        request.checkpoint_id, request.thread_id
                    );
                    return;
                }
                Err(failure) if attempt < ROLLBACK_ATTEMPTS => {
                    eprintln!(
                        "conn-engine: rollback {} of {} failed (attempt {attempt}), retrying: {}",
                        request.checkpoint_id,
                        request.thread_id,
                        failure.detail()
                    );
                    tokio::time::sleep(retry_delay(attempt)).await;
                    attempt += 1;
                }
                Err(failure) => break Err(failure),
            }
        };
        if let Err(failure) = outcome {
            let detail = failure.detail();
            eprintln!(
                "conn-engine: rollback {} of {} failed: {detail}",
                request.checkpoint_id, request.thread_id
            );
            // `rollbackFailureClientMessage`: only a held index lock gets its own words; other
            // causes carry ids or raw git output, so the client sees the generic message.
            let message = match failure {
                RollbackFailure::Failed(detail) if detail.contains("index.lock") => {
                    "Git's index is locked. Wait for other Git operations to finish, then try again."
                }
                RollbackFailure::Invalid(_)
                | RollbackFailure::Shared
                | RollbackFailure::Failed(_)
                | RollbackFailure::Fenced => ROLLBACK_FAILED_MESSAGE,
            };
            self.record_rollback_failure(&request, message).await;
        }
    }

    /// Records the failure and settles the row in one write. That write owns the row's
    /// settlement (the worker leaves rollback rows alone), so it is tried again, with the
    /// rollback's backoff, until it lands or another engine owns the store; that engine goes
    /// on by the row's phase.
    async fn record_rollback_failure(&self, request: &RollbackRequest, message: &str) {
        let mut attempt = 1;
        loop {
            let (tid, request_id, message) = (
                request.thread_id.clone(),
                request.command_id.clone(),
                message.to_owned(),
            );
            let written = match self.failure_write_fault() {
                Some(fault) => Err(fault),
                None => {
                    self.write(move |tx| write_rollback_failure(tx, &tid, &request_id, &message))
                        .await
                }
            };
            let Err(e) = written else { return };
            eprintln!("conn-engine: could not record a rollback failure (attempt {attempt}): {e}");
            // Another engine took the store (`NOT_OWNER`, or the durable epoch moved): it owns
            // the rollback's row now.
            if e == crate::store::NOT_OWNER || !self.still_owns().await {
                return;
            }
            tokio::time::sleep(retry_delay(attempt)).await;
            attempt += 1;
        }
    }

    /// Test hook: an injected failure of the next failure write.
    fn failure_write_fault(&self) -> Option<String> {
        #[cfg(test)]
        {
            let mut hooks = crate::lock(&self.worker_hooks);
            if hooks.rollback_result_faults > 0 {
                hooks.rollback_result_faults -= 1;
                return Some("injected".into());
            }
        }
        None
    }

    async fn try_rollback(
        self: &Arc<Self>,
        request: &RollbackRequest,
        progress: &mut RollbackProgress,
    ) -> Result<(), RollbackFailure> {
        let req = request.clone();
        let context = self
            .db(
                move |store| -> StoreResult<Result<RollbackContext, RollbackFailure>> {
                    let tx = store.tx()?;
                    let context = read_context(&tx, &req);
                    tx.rollback();
                    context
                },
            )
            .await
            .map_err(RollbackFailure::Failed)??;
        let target_ordinal = context.checkpoint["appRunOrdinal"].as_u64().unwrap_or(0);
        let target = if target_ordinal == 0 {
            RollbackTarget::ThreadStart {
                checkpoint_id: request.checkpoint_id.clone(),
            }
        } else {
            let Some(turn) = &context.target_turn else {
                return Err(RollbackFailure::Invalid("provider-turn-unavailable"));
            };
            if turn["providerThreadId"] != context.provider_thread["id"] {
                return Err(RollbackFailure::Invalid("provider-turn-unavailable"));
            }
            RollbackTarget::ProviderTurn {
                checkpoint_id: request.checkpoint_id.clone(),
                app_run_ordinal: u32::try_from(target_ordinal).unwrap_or(u32::MAX),
                provider_turn: from_json(turn.clone())
                    .map_err(|e| RollbackFailure::Failed(e.to_string()))?,
            }
        };
        let restore_files = request.restore_files != Some(false);
        if restore_files && !context.isolated {
            return Err(RollbackFailure::Shared);
        }
        if restore_files && context.captured_elsewhere {
            return Err(RollbackFailure::Invalid("checkpoint-in-another-checkout"));
        }

        let snapshot_thread = if context.runs.is_empty() {
            context.provider_thread.clone()
        } else if let Some((row, _)) = &progress.provider {
            // An earlier attempt rolled the provider back; only a later step failed.
            row.clone()
        } else {
            let live = self.rollback_session(&context).await?;
            live.touch(self.clock.now_millis());
            // From here a restart cannot tell whether the provider rolled back. Exactly one
            // engine moves the rollback on, once; any other stops before the provider.
            let (tid, id) = (request.thread_id.clone(), request.command_id.clone());
            let from = if progress.provider_sent {
                "provider"
            } else {
                "admitted"
            };
            let moved = self
                .db(move |store| store.advance_rollback(&tid, &id, from, "provider", None))
                .await
                .map_err(RollbackFailure::Failed)?;
            if !moved {
                return Err(RollbackFailure::Fenced);
            }
            progress.provider_sent = true;
            let snapshot = live
                .session()
                .rollback_thread(RollbackThreadInput {
                    provider_thread: from_json(context.provider_thread.clone())
                        .map_err(|e| RollbackFailure::Failed(e.to_string()))?,
                    target,
                    provider_thread_turns: context
                        .provider_thread_turns
                        .iter()
                        .filter_map(|t| from_json(t.clone()).ok())
                        .collect(),
                })
                .await
                .map_err(|e| RollbackFailure::Failed(e.to_string()))?;
            let row = to_json(&snapshot.provider_thread);
            let (tid, id, stored) = (
                request.thread_id.clone(),
                request.command_id.clone(),
                row.clone(),
            );
            let kept = self
                .db(move |store| {
                    store.advance_rollback(&tid, &id, "provider", "provider_done", Some(&stored))
                })
                .await;
            match kept {
                Ok(true) => {}
                // Another engine owns the rollback now, and records how it ended.
                Ok(false) => return Err(RollbackFailure::Fenced),
                // A restart then records a failure instead of finishing the rollback.
                Err(e) => {
                    eprintln!("conn-engine: could not keep a provider rollback's answer: {e}")
                }
            }
            progress.provider = Some((row.clone(), Some((live, snapshot.provider_thread))));
            row
        };

        let cwd = context.scope["cwd"].as_str().unwrap_or_default().to_owned();
        if let Some(checkpoints) = &self.checkpoints {
            let _held = checkpoints.workspace(&cwd).await;
            // The store stays locked until the files and refs are done, even if the engine
            // drops meanwhile. A dropped engine's rollback touches nothing.
            let Some(_store) = self.store_lock.upgrade() else {
                return Err(RollbackFailure::Fenced);
            };
            // The lock may have waited: an engine replaced meanwhile touches no file.
            let owned = self
                .db(|store| store.owns_store())
                .await
                .map_err(RollbackFailure::Failed)?;
            if !owned {
                return Err(RollbackFailure::Fenced);
            }
            #[cfg(test)]
            {
                let pause = crate::lock(&self.worker_hooks).restore_pause.take();
                if let Some((paused, release)) = pause {
                    let _ = paused.send(());
                    let _ = release.await;
                }
            }
            let path = PathBuf::from(&cwd);
            if restore_files && !progress.files_restored {
                let reference = context.checkpoint["ref"].as_str().unwrap_or_default();
                match git::restore(&path, reference).await {
                    Ok(true) => {}
                    Ok(false) => {
                        return Err(RollbackFailure::Failed(
                            "Checkpoint ref is unavailable.".into(),
                        ));
                    }
                    Err(e) => return Err(RollbackFailure::Failed(e.to_string())),
                }
                progress.files_restored = true;
            }
            if !context.stale.is_empty() && !progress.refs_deleted {
                let refs: Vec<String> = context
                    .stale
                    .iter()
                    .filter_map(|c| c["ref"].as_str().map(str::to_owned))
                    .collect();
                git::delete_refs(&path, &refs)
                    .await
                    .map_err(|e| RollbackFailure::Failed(e.to_string()))?;
                progress.refs_deleted = true;
            }
        } else if restore_files {
            return Err(RollbackFailure::Failed("checkpoints are off".into()));
        }

        // The provider has rolled back, so the live session goes on from there now. The
        // result commit below frees the thread's lane, and a queued turn may start at once.
        if let Some((_, Some((live, thread)))) = &progress.provider {
            live.set_provider_thread(thread.clone());
        }
        let (tid, command_id) = (request.thread_id.clone(), request.command_id.clone());
        let instance = context.provider_thread["providerInstanceId"].clone();
        self.write(move |tx| {
            tx.settle_rollback(&tid, &command_id, Settled::Succeeded, None)?;
            commit_rollback(
                tx,
                &tid,
                &context,
                snapshot_thread,
                &instance,
                target_ordinal,
            )
        })
        .await
        .map_err(RollbackFailure::Failed)?;
        #[cfg(test)]
        {
            let pause = crate::lock(&self.worker_hooks).rollback_committed.take();
            if let Some((paused, release)) = pause {
                let _ = paused.send(());
                let _ = release.await;
            }
        }
        Ok(())
    }

    /// The thread's live session, or one opened for the rollback on the provider thread's own
    /// session id (`sessions.open`).
    async fn rollback_session(
        self: &Arc<Self>,
        context: &RollbackContext,
    ) -> Result<Arc<crate::runner::LiveThread>, RollbackFailure> {
        let thread_id = context.thread["id"].as_str().unwrap_or_default();
        let instance = context.provider_thread["providerInstanceId"]
            .as_str()
            .unwrap_or_default();
        if let Some(live) = self.live_thread(thread_id)
            && live.instance() == instance
        {
            return Ok(live);
        }
        let selection = from_json(context.thread["modelSelection"].clone())
            .map_err(|e| RollbackFailure::Failed(e.to_string()))?;
        let mut policy: conn_provider::RuntimePolicy = from_json(json!({
            "runtimeMode": context.thread["runtimeMode"],
            "interactionMode": context.thread["interactionMode"],
            "cwd": context.scope["cwd"],
        }))
        .map_err(|e| RollbackFailure::Failed(e.to_string()))?;
        // As a turn start does (`RuntimePolicy.layerWithOverride`).
        if let Some(policy_override) = &self.policy_override {
            policy_override.apply(&mut policy);
        }
        let session_id = context.provider_thread["providerSessionId"]
            .as_str()
            .unwrap_or_default();
        self.open_live(
            thread_id,
            instance,
            session_id,
            &selection,
            &policy,
            &context.thread,
        )
        .await
        .map_err(RollbackFailure::Failed)?
        .ok_or_else(|| RollbackFailure::Failed("the server is stopping".into()))
    }
}

/// The rollback's one commit (the end of `CheckpointRollbackService.execute`).
fn commit_rollback(
    tx: &mut Tx<'_>,
    thread_id: &str,
    context: &RollbackContext,
    mut provider_thread: Value,
    instance: &Value,
    target_ordinal: u64,
) -> StoreResult<()> {
    let now = tx.now().to_owned();
    if provider_thread.is_object() {
        provider_thread["providerInstanceId"] = instance.clone();
        provider_thread["lastRunOrdinal"] = if target_ordinal == 0 {
            Value::Null
        } else {
            json!(target_ordinal)
        };
        provider_thread["updatedAt"] = json!(now);
    }
    let instance = provider_thread["providerInstanceId"]
        .as_str()
        .map(str::to_owned);
    tx.append(
        Draft::new(thread_id, "provider-thread.updated", provider_thread).payload_instance(),
    )?;
    for checkpoint in &context.stale {
        let mut stale = checkpoint.clone();
        stale["status"] = json!("stale");
        let draft =
            Draft::new(thread_id, "checkpoint.captured", stale).node(checkpoint["nodeId"].as_str());
        tx.append(
            draft
                .run(checkpoint["runId"].as_str())
                .provider_instance(instance.as_deref()),
        )?;
    }
    for run in &context.runs {
        let run_id = run["id"].as_str();
        let root = context
            .root_nodes
            .iter()
            .find(|n| n["id"] == run["rootNodeId"]);
        let mut rolled = run.clone();
        rolled["status"] = json!("rolled_back");
        rolled["completedAt"] = json!(now);
        tx.append(
            Draft::new(thread_id, "run.updated", rolled)
                .run(run_id)
                .node(root.and_then(|n| n["id"].as_str())),
        )?;
        if let Some(node) = root {
            let mut node = node.clone();
            node["status"] = json!("rolled_back");
            node["completedAt"] = json!(now);
            let id = node["id"].as_str().map(str::to_owned);
            tx.append(
                Draft::new(thread_id, "node.updated", node)
                    .run(run_id)
                    .node(id.as_deref()),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::retry_delay;
    use std::time::Duration;

    #[test]
    fn the_retry_delay_doubles_from_100_ms_up_to_30_s() {
        let delays: Vec<Duration> = (1..=4).map(retry_delay).collect();
        assert_eq!(
            delays,
            [100, 200, 400, 800].map(Duration::from_millis).to_vec()
        );
        assert_eq!(retry_delay(20), Duration::from_secs(30));
    }
}
