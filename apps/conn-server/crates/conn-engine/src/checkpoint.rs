//! Git checkpoints per turn, as the T3 server takes them (`CheckpointService.ts`,
//! `CheckpointCaptureService.ts`, `RunExecutionService.ts` `captureBaseline`,
//! `checkpointing/CheckpointDiffQuery.ts`). The git side is `conn_vcs::checkpoint`.
//!
//! - **Scope.** A thread has one root scope, `checkpoint-scope:thread:<id>:name:root`, made
//!   when its first run starts (`checkpoint-scope.created`) in the run's folder; the run's root
//!   node names it (`checkpointScopeId`). A run in another folder or on another provider
//!   thread rebuilds it from that run. Earlier checkpoints keep their refs: a moved thread's
//!   next turn diff compares with the previous checkout's state, as on T3.
//! - **Baseline.** Before the provider gets the message, the workspace is captured as ordinal
//!   `run - 1` unless that ref exists (5 s budget; a failure starts the turn without one).
//! - **Capture.** A provider turn that completes leaves the run `waiting`; the capture then
//!   records the baselines it has not recorded (`runId: null`), the run's checkpoint (ordinal
//!   = run ordinal) with the files it changed, a `checkpoint` turn item, and completes the run.
//!   An interrupted or cancelled run is captured too, as the next message's rollback point.
//!   A folder that is no git repository records `missing` checkpoints.
//! - **Diffs.** `getTurnDiff` and `getFullThreadDiff` compare two checkpoints, at most 10 MB.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use conn_support::ids::join_id;
use conn_vcs::checkpoint as git;
use serde_json::{Value, json};

use crate::EngineError;
use crate::commands::{self, Effect};
use crate::engine::Inner;
use crate::store::{Draft, StoreResult, Tx};

/// `BASELINE_CAPTURE_BUDGET`.
const BASELINE_BUDGET: Duration = Duration::from_secs(5);
/// `MAX_WIRE_CHECKPOINT_FILES` (`WireProjection.ts`). T3 caps the files on the wire; this
/// server stores the capped list, so a checkpoint never holds more.
const MAX_WIRE_FILES: usize = 200;
/// `MAX_PATHSPEC_CHARS` (`CheckpointDiffQuery.ts`).
const MAX_PATHSPEC_CHARS: usize = 24_000;

pub(crate) use conn_vcs::locks::WorkspaceLocks as Checkpoints;

pub(crate) fn scope_id(thread_id: &str) -> String {
    join_id("checkpoint-scope", &["thread", thread_id, "name", "root"])
}

pub(crate) fn checkpoint_id(scope_id: &str, ordinal: u64) -> String {
    join_id(
        "checkpoint",
        &["scope", scope_id, "name", &ordinal.to_string()],
    )
}

/// Where the run's checkpoints go: the scope id and folder, naming the scope on the node.
/// Runs in the write that starts the run. A scope that names another provider thread or
/// folder is rebuilt from this run, as T3 builds it for every run
/// (`CheckpointService.makeRootRunScope`), so a thread moved to another checkout captures there.
pub(crate) fn ensure_scope(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run: &Value,
    node: &mut Value,
    provider_thread_id: &Value,
    cwd: &str,
) -> StoreResult<(String, String)> {
    let id = scope_id(thread_id);
    // An imported scope has no event yet: record its folder before this run captures.
    let current = tx
        .entity(thread_id, "checkpointScopes", &id)?
        .is_some_and(|scope| {
            scope["providerThreadId"] == *provider_thread_id && scope["cwd"] == cwd
        })
        && tx.has_scope_event(thread_id)?;
    if !current {
        let scope = json!({
            "id": id, "threadId": thread_id, "runId": run["id"], "nodeId": run["rootNodeId"],
            "parentScopeId": null, "providerThreadId": provider_thread_id,
            "kind": "root_run", "ordinalWithinParent": 0, "advancesAppRunCount": true,
            "cwd": cwd, "createdAt": tx.now(),
        });
        tx.append(
            Draft::new(thread_id, "checkpoint-scope.created", scope)
                .run(run["id"].as_str())
                .node(run["rootNodeId"].as_str()),
        )?;
    }
    node["checkpointScopeId"] = json!(id);
    Ok((id, cwd.to_owned()))
}

/// The status a folder gives a checkpoint before any ref is read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Probe {
    Repository,
    Missing,
    Error,
}

impl Probe {
    fn status(self) -> &'static str {
        match self {
            Probe::Repository => "ready",
            Probe::Missing => "missing",
            Probe::Error => "error",
        }
    }
}

async fn probe(cwd: &Path) -> Probe {
    match git::is_repository(cwd).await {
        Ok(true) => Probe::Repository,
        Ok(false) => Probe::Missing,
        Err(e) => {
            eprintln!("conn-engine: checkpoint repository probe failed: {e}");
            Probe::Error
        }
    }
}

/// What a capture needs from the store.
struct CaptureContext {
    run: Value,
    root: Value,
    scope: Value,
    driver: String,
    preserved: BTreeSet<u64>,
    side_chat: bool,
}

/// `files` capped as on the T3 wire, with `filesTotal` when cut.
fn capped(files: Vec<Value>) -> (Vec<Value>, Option<Value>) {
    if files.len() <= MAX_WIRE_FILES {
        return (files, None);
    }
    let (additions, deletions) = files.iter().fold((0u64, 0u64), |(a, d), f| {
        (
            a + f["additions"].as_u64().unwrap_or(0),
            d + f["deletions"].as_u64().unwrap_or(0),
        )
    });
    let total = json!({"count": files.len(), "additions": additions, "deletions": deletions});
    (
        files.into_iter().take(MAX_WIRE_FILES).collect(),
        Some(total),
    )
}

#[derive(Clone, Copy)]
enum Attribution {
    /// A baseline the capture materializes: no run, no app ordinal.
    Baseline,
    Run,
}

fn checkpoint_json(
    ctx: &CaptureContext,
    ordinal: u64,
    attribution: Attribution,
    status: &str,
    files: Vec<Value>,
    captured_at: &Value,
) -> Value {
    let scope_id = ctx.scope["id"].as_str().unwrap_or_default();
    let (files, total) = capped(files);
    let (run_id, parent, app_ordinal) = match attribution {
        Attribution::Baseline => (Value::Null, Value::Null, Value::Null),
        Attribution::Run => (
            ctx.run["id"].clone(),
            if ordinal > 0 {
                json!(checkpoint_id(scope_id, ordinal - 1))
            } else {
                Value::Null
            },
            json!(ordinal),
        ),
    };
    let mut checkpoint = json!({
        "id": checkpoint_id(scope_id, ordinal), "threadId": ctx.run["threadId"],
        "scopeId": scope_id, "runId": run_id, "nodeId": ctx.root["id"],
        "parentCheckpointId": parent, "ordinalWithinScope": ordinal,
        "appRunOrdinal": app_ordinal, "ref": git::checkpoint_ref(scope_id, ordinal),
        "status": status, "files": files, "capturedAt": captured_at,
    });
    if let Some(total) = total {
        checkpoint["filesTotal"] = total;
    }
    checkpoint
}

fn read_capture_context(
    tx: &Tx<'_>,
    thread_id: &str,
    run_id: &str,
) -> StoreResult<Option<CaptureContext>> {
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(None);
    };
    let Some(run) = tx.entity(thread_id, "runs", run_id)? else {
        return Ok(None);
    };
    let Some(root) = tx.entity(thread_id, "nodes", run["rootNodeId"].as_str().unwrap_or(""))?
    else {
        return Ok(None);
    };
    let Some(scope_id) = root["checkpointScopeId"].as_str() else {
        return Ok(None);
    };
    let Some(scope) = tx.entity(thread_id, "checkpointScopes", scope_id)? else {
        return Ok(None);
    };
    let Some(provider_thread) = run["providerThreadId"]
        .as_str()
        .map(|id| tx.entity(thread_id, "providerThreads", id))
        .transpose()?
        .flatten()
    else {
        return Ok(None);
    };
    let preserved = tx
        .entities_where(thread_id, "checkpoints", "scopeId", scope_id)?
        .iter()
        .filter(|c| c["status"] == "ready" || (c["status"] == "missing" && !c["runId"].is_null()))
        .filter_map(|c| c["ordinalWithinScope"].as_u64())
        .collect();
    Ok(Some(CaptureContext {
        driver: provider_thread["driver"]
            .as_str()
            .unwrap_or("claudeAgent")
            .to_owned(),
        side_chat: thread["lineage"]["sideChat"] == true,
        run,
        root,
        scope,
        preserved,
    }))
}

fn checkpoint_item(ctx: &CaptureContext, checkpoint: &Value, now: &str) -> Value {
    let id = checkpoint["id"].as_str().unwrap_or_default();
    let mut item = json!({
        "id": join_id("turn-item", &["provider", &ctx.driver, "native-item", &format!("checkpoint:{id}")]),
        "threadId": ctx.run["threadId"], "runId": ctx.run["id"], "nodeId": ctx.root["id"],
        "providerThreadId": ctx.run["providerThreadId"], "providerTurnId": ctx.root["providerTurnId"],
        "nativeItemRef": null, "parentItemId": null,
        "ordinal": ctx.run["ordinal"].as_u64().unwrap_or(0) * 100 + 99,
        "status": "completed", "title": null, "startedAt": now, "completedAt": now,
        "updatedAt": now, "type": "checkpoint", "checkpointId": id,
        "scopeId": checkpoint["scopeId"], "files": checkpoint["files"],
    });
    if let Some(total) = checkpoint.get("filesTotal") {
        item["filesTotal"] = total.clone();
    }
    item
}

/// The run's own row needs the checkpoint (`CheckpointCaptureService.execute`'s guard).
fn needs_capture(run: &Value) -> bool {
    let status = run["status"].as_str().unwrap_or_default();
    let stopped = matches!(status, "interrupted" | "cancelled");
    if run["checkpointId"].is_string() && (status == "completed" || stopped) {
        return false;
    }
    status == "waiting" || stopped
}

impl Inner {
    /// The baseline before a provider turn (`captureRunBaseline`). Never fails the turn. The
    /// turn start holds the folder's lease.
    pub(crate) async fn capture_baseline(&self, scope_id: &str, cwd: &str, run_ordinal: u64) {
        if self.checkpoints.is_none() {
            return;
        }
        let path = PathBuf::from(cwd);
        if probe(&path).await != Probe::Repository {
            return;
        }
        let reference = git::checkpoint_ref(scope_id, run_ordinal.saturating_sub(1));
        match git::has_ref(&path, &reference).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(e) => {
                eprintln!("conn-engine: checkpoint baseline lookup failed: {e}");
                return;
            }
        }
        match tokio::time::timeout(BASELINE_BUDGET, git::capture(&path, &reference)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => eprintln!("conn-engine: checkpoint baseline capture failed: {e}"),
            Err(_) => eprintln!(
                "conn-engine: checkpoint baseline took over 5 s; the turn starts without one"
            ),
        }
    }

    /// Captures the run's checkpoint and finishes the run (`CheckpointCaptureService`), then
    /// what a run's end starts: the parent's wake, the next queued run. A run that cannot be
    /// captured still completes.
    pub(crate) async fn capture_run(self: &Arc<Self>, thread_id: String, run_id: String) {
        let (tid, rid) = (thread_id.clone(), run_id.clone());
        let context = self
            .db(move |store| -> StoreResult<Option<CaptureContext>> {
                let tx = store.tx()?;
                let context = read_capture_context(&tx, &tid, &rid);
                tx.rollback();
                context
            })
            .await;
        let context = match context {
            Ok(Some(ctx)) if needs_capture(&ctx.run) => Some(ctx),
            Ok(_) => None,
            Err(e) => {
                eprintln!("conn-engine: checkpoint capture could not read the run: {e}");
                None
            }
        };
        let captured = match (&self.checkpoints, context) {
            (Some(checkpoints), Some(ctx)) => Some(self.capture_git(checkpoints, ctx).await),
            _ => None,
        };
        self.events_stored(&thread_id).await;
        let (tid, rid) = (thread_id.clone(), run_id.clone());
        let effects = self
            .write(move |tx| {
                // The run's end (the parent's wake) is written once, by the first capture to
                // commit, whatever the run ended as. A capture that runs again after a restart
                // finds its row marked.
                // A capture row of an older build has no mark: a terminal run whose checkpoint
                // committed had its end written by that capture.
                let ended = tx.entity(&tid, "runs", &rid)?.is_some_and(|run| {
                    run["status"] != "waiting" && !run["checkpointId"].is_null()
                });
                let first = !ended && !tx.run_end_recorded(&rid)?;
                if let Some((ctx, events)) = captured {
                    commit_capture(tx, &tid, &rid, &ctx, events)?;
                }
                complete_waiting(tx, &tid, &rid)?;
                let mut effects = if first {
                    tx.record_run_end(&rid)?;
                    let effects = crate::families::on_run_end(tx, &tid, &rid)?;
                    if tx
                        .entity(&tid, "runs", &rid)?
                        .is_some_and(|run| run["status"] == "completed")
                    {
                        commands::release_unattended_holds(tx, &tid, &rid)?;
                    }
                    effects
                } else {
                    vec![]
                };
                effects.extend(commands::start_next_queued(tx, &tid, None)?);
                tx.enqueue(None, &effects)
            })
            .await;
        if let Err(e) = effects {
            eprintln!("conn-engine: could not record a checkpoint: {e}");
        }
        if let Some(observer) = &self.observer {
            self.observe_end(observer.clone(), thread_id, run_id).await;
        }
    }

    /// The git half of a capture: baselines and the run's checkpoint, as JSON rows.
    async fn capture_git(
        &self,
        checkpoints: &Checkpoints,
        ctx: CaptureContext,
    ) -> (CaptureContext, Vec<Value>) {
        let cwd = ctx.scope["cwd"].as_str().unwrap_or_default().to_owned();
        let path = PathBuf::from(&cwd);
        let scope_id = ctx.scope["id"].as_str().unwrap_or_default().to_owned();
        let ordinal = ctx.run["ordinal"].as_u64().unwrap_or(1);
        let baseline_ordinal = ordinal.saturating_sub(1);
        let _held = checkpoints.workspace(&cwd).await;
        // Side chats share the parent's worktree: a snapshot would hold the parent's edits.
        let folder = if ctx.side_chat {
            Probe::Missing
        } else {
            probe(&path).await
        };
        let requested_at = ctx.run["requestedAt"].clone();
        let mut rows = vec![];
        let mut baselines = vec![];
        if baseline_ordinal != 0 && !ctx.preserved.contains(&0) {
            baselines.push(0);
        }
        if !ctx.preserved.contains(&baseline_ordinal) {
            baselines.push(baseline_ordinal);
        }
        for n in baselines {
            let status = match folder {
                Probe::Repository => {
                    match git::has_ref(&path, &git::checkpoint_ref(&scope_id, n)).await {
                        Ok(true) => "ready",
                        Ok(false) => "missing",
                        Err(_) => "error",
                    }
                }
                other => other.status(),
            };
            rows.push(checkpoint_json(
                &ctx,
                n,
                Attribution::Baseline,
                status,
                vec![],
                &requested_at,
            ));
        }
        let now = json!(conn_support::time::iso_from_ms(self.clock.now_millis()));
        let reference = git::checkpoint_ref(&scope_id, ordinal);
        let status = match folder {
            Probe::Repository => match git::capture(&path, &reference).await {
                Ok(git::Captured::Ready) => "ready",
                Ok(git::Captured::Unsupported) => "missing",
                Err(e) => {
                    eprintln!("conn-engine: checkpoint capture failed: {e}");
                    "error"
                }
            },
            other => other.status(),
        };
        let files = if status == "ready" {
            changed_files(&path, &scope_id, ordinal).await
        } else {
            vec![]
        };
        rows.push(checkpoint_json(
            &ctx,
            ordinal,
            Attribution::Run,
            status,
            files,
            &now,
        ));
        (ctx, rows)
    }
}

/// The files a turn changed, without the ones a pull brought (`isGitImport`).
async fn changed_files(cwd: &Path, scope_id: &str, ordinal: u64) -> Vec<Value> {
    let previous = git::checkpoint_ref(scope_id, ordinal.saturating_sub(1));
    let current = git::checkpoint_ref(scope_id, ordinal);
    if !git::has_ref(cwd, &previous).await.unwrap_or(false) {
        return vec![];
    }
    let numstat = git::diff(git::DiffRequest {
        cwd,
        from_ref: &previous,
        to_ref: &current,
        ignore_whitespace: false,
        format: git::DiffFormat::Numstat,
        max_output_bytes: git::DIFF_MAX_OUTPUT_BYTES,
        file_paths: None,
    })
    .await;
    let authored = git::authored_paths(cwd, &previous, &current)
        .await
        .unwrap_or_else(|e| {
            eprintln!("conn-engine: checkpoint authored paths failed: {e}");
            None
        });
    match numstat {
        Ok(numstat) => git::parse_numstat(&numstat)
            .into_iter()
            .filter(|f| !git::is_git_import(f, authored.as_ref()))
            .map(|f| {
                json!({"path": f.path, "kind": "modified",
                    "additions": f.additions, "deletions": f.deletions})
            })
            .collect(),
        Err(e) => {
            eprintln!("conn-engine: checkpoint diff summary failed: {e}");
            vec![]
        }
    }
}

/// The capture command's events (`checkpoint.capture`), when the run still needs them.
fn commit_capture(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
    ctx: &CaptureContext,
    rows: Vec<Value>,
) -> StoreResult<()> {
    let Some(mut run) = tx.entity(thread_id, "runs", run_id)? else {
        return Ok(());
    };
    if !needs_capture(&run) {
        return Ok(());
    }
    let stopped = run["status"] != "waiting";
    let now = tx.now().to_owned();
    let root = ctx.root["id"].as_str().map(str::to_owned);
    let mut checkpoint = Value::Null;
    for row in rows {
        let draft = Draft::new(thread_id, "checkpoint.captured", row.clone())
            .node(root.as_deref())
            .instance_of(&run);
        let draft = if row["runId"].is_null() {
            draft
        } else {
            draft.run(Some(run_id))
        };
        tx.append(draft)?;
        checkpoint = row;
    }
    let draft = |event_type, payload| {
        Draft::new(thread_id, event_type, payload)
            .run(Some(run_id))
            .node(root.as_deref())
    };
    tx.append(draft(
        "turn-item.updated",
        checkpoint_item(ctx, &checkpoint, &now),
    ))?;
    run["checkpointId"] = checkpoint["id"].clone();
    if !stopped {
        run["status"] = json!("completed");
        run["completedAt"] = json!(now);
    }
    tx.append(draft("run.updated", run))?;
    if !stopped
        && let Some(root) = &root
        && let Some(mut node) = tx.entity(thread_id, "nodes", root)?
    {
        node["status"] = json!("completed");
        node["completedAt"] = json!(now);
        node["checkpointScopeId"] = ctx.scope["id"].clone();
        tx.append(draft("node.updated", node))?;
    }
    Ok(())
}

/// A run still `waiting` (no checkpoint could be taken) completes without one.
fn complete_waiting(tx: &mut Tx<'_>, thread_id: &str, run_id: &str) -> StoreResult<()> {
    let Some(mut run) = tx.entity(thread_id, "runs", run_id)? else {
        return Ok(());
    };
    if run["status"] != "waiting" {
        return Ok(());
    }
    let now = tx.now().to_owned();
    let root = run["rootNodeId"].as_str().map(str::to_owned);
    run["status"] = json!("completed");
    run["completedAt"] = json!(now);
    tx.append(
        Draft::new(thread_id, "run.updated", run)
            .run(Some(run_id))
            .node(root.as_deref()),
    )?;
    if let Some(root) = &root
        && let Some(mut node) = tx.entity(thread_id, "nodes", root)?
        && node["status"] == "waiting"
    {
        node["status"] = json!("completed");
        node["completedAt"] = json!(now);
        tx.append(
            Draft::new(thread_id, "node.updated", node)
                .run(Some(run_id))
                .node(Some(root)),
        )?;
    }
    Ok(())
}

/// The restart effect for a run a kill left `waiting`.
pub(crate) fn resume_capture(thread_id: &str, run: &Value) -> Effect {
    Effect::CaptureCheckpoint {
        thread_id: thread_id.to_owned(),
        run_id: run["id"].as_str().unwrap_or_default().to_owned(),
    }
}

// ---------------------------------------------------------------------------------------
// Diffs

/// Which RPC asks: their errors differ in tag and message only.
#[derive(Clone, Copy)]
pub(crate) enum DiffMethod {
    Turn,
    FullThread,
}

impl DiffMethod {
    fn error(self, cause: Value) -> EngineError<Value> {
        let (tag, message) = match self {
            DiffMethod::Turn => ("OrchestrationGetTurnDiffError", "Failed to load turn diff"),
            DiffMethod::FullThread => (
                "OrchestrationGetFullThreadDiffError",
                "Failed to load full thread diff",
            ),
        };
        EngineError::Rejected(json!({"_tag": tag, "message": message, "cause": cause}))
    }
}

const TURN_DIFF: &str = "CheckpointDiffQuery.getTurnDiff";

fn cause(tag: &str, message: String) -> Value {
    json!({"_tag": tag, "message": message})
}

/// What a diff reads from the store.
struct DiffContext {
    checkpoints: Vec<Value>,
    scopes: Vec<Value>,
    completed_runs: BTreeSet<String>,
}

fn diff_result(thread_id: &str, from: u64, to: u64, diff: String) -> Value {
    json!({"threadId": thread_id, "fromTurnCount": from, "toTurnCount": to, "diff": diff})
}

/// Paths in batches that fit a command line (`batchFilePaths`).
fn batch_paths(files: &[git::FileSummary]) -> Vec<Vec<String>> {
    let mut batches = vec![];
    let mut batch: Vec<String> = vec![];
    let mut length = 0;
    for file in files {
        let paths: Vec<String> = match &file.previous_path {
            Some(previous) => vec![previous.clone(), file.path.clone()],
            None => vec![file.path.clone()],
        };
        let size: usize = paths.iter().map(|p| p.len() + 16).sum();
        if !batch.is_empty() && length + size > MAX_PATHSPEC_CHARS {
            batches.push(std::mem::take(&mut batch));
            length = 0;
        }
        batch.extend(paths);
        length += size;
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

/// The first `limit` bytes as text, without a character cut in half at the end.
fn cut_utf8(bytes: &[u8], limit: usize) -> String {
    let mut end = limit.min(bytes.len());
    // Step back over an incomplete final character: at most 3 continuation bytes.
    let mut back = end;
    while back > 0 && end - back < 4 {
        back -= 1;
        let Some(&byte) = bytes.get(back) else { break };
        if byte & 0xC0 != 0x80 {
            let width = match byte {
                b if b < 0x80 => 1,
                b if b >= 0xF0 => 4,
                b if b >= 0xE0 => 3,
                b if b >= 0xC0 => 2,
                _ => 1,
            };
            if back + width > end {
                end = back;
            }
            break;
        }
    }
    String::from_utf8_lossy(bytes.get(..end).unwrap_or_default()).into_owned()
}

impl Inner {
    /// `orchestration.getTurnDiff` and `orchestration.getFullThreadDiff`.
    pub(crate) async fn checkpoint_diff(
        &self,
        method: DiffMethod,
        input: Value,
    ) -> Result<Value, EngineError<Value>> {
        let thread_id = input["threadId"].as_str().unwrap_or_default().to_owned();
        let ignore_whitespace = input["ignoreWhitespace"].as_bool().unwrap_or(true);
        let to = input["toTurnCount"].as_u64().unwrap_or(0);
        let from = match method {
            DiffMethod::Turn => input["fromTurnCount"].as_u64().unwrap_or(0),
            DiffMethod::FullThread => 0,
        };
        if from == to {
            return Ok(diff_result(&thread_id, from, to, String::new()));
        }
        self.turn_diff(&thread_id, from, to, ignore_whitespace)
            .await
            .map_err(|cause| method.error(cause))
    }

    async fn turn_diff(
        &self,
        thread_id: &str,
        from: u64,
        to: u64,
        ignore_whitespace: bool,
    ) -> Result<Value, Value> {
        let tid = thread_id.to_owned();
        let context = self
            .db(move |store| -> StoreResult<Option<DiffContext>> {
                let tx = store.tx()?;
                let read = (|| {
                    if tx.thread(&tid)?.is_none() {
                        return Ok(None);
                    }
                    Ok(Some(DiffContext {
                        checkpoints: tx.entities(&tid, "checkpoints")?,
                        scopes: tx.entities(&tid, "checkpointScopes")?,
                        completed_runs: tx
                            .entities_where(&tid, "runs", "status", "completed")?
                            .iter()
                            .filter_map(|r| r["id"].as_str().map(str::to_owned))
                            .collect(),
                    }))
                })();
                tx.rollback();
                read
            })
            .await
            .map_err(|e| cause("ProjectionRepositoryError", e))?;
        let Some(ctx) = context else {
            return Err(cause(
                "CheckpointThreadNotFoundError",
                format!(
                    "Checkpoint invariant violation in {TURN_DIFF}: Thread '{thread_id}' not found."
                ),
            ));
        };
        let ready: Vec<&Value> = ctx
            .checkpoints
            .iter()
            .filter(|c| {
                c["status"] == "ready"
                    && c["appRunOrdinal"].is_u64()
                    && c["runId"]
                        .as_str()
                        .is_some_and(|r| ctx.completed_runs.contains(r))
            })
            .collect();
        let max = ready
            .iter()
            .filter_map(|c| c["appRunOrdinal"].as_u64())
            .max()
            .unwrap_or(0);
        if to > max {
            return Err(cause(
                "CheckpointTurnRangeUnavailableError",
                format!(
                    "Checkpoint unavailable for thread {thread_id} turn {to}: Turn diff range exceeds current turn count: requested {to}, current {max}."
                ),
            ));
        }
        let unavailable = |n: u64| {
            cause(
                "CheckpointRefUnavailableError",
                format!(
                    "Checkpoint unavailable for thread {thread_id} turn {n}: Checkpoint ref is unavailable for turn {n}."
                ),
            )
        };
        let Some(to_checkpoint) = ready.iter().find(|c| c["appRunOrdinal"] == to) else {
            return Err(unavailable(to));
        };
        let Some(scope) = ctx
            .scopes
            .iter()
            .find(|s| s["id"] == to_checkpoint["scopeId"])
        else {
            return Err(cause(
                "CheckpointWorkspacePathMissingError",
                format!(
                    "Checkpoint invariant violation in {TURN_DIFF}: Workspace path missing for thread '{thread_id}' when computing turn diff."
                ),
            ));
        };
        // Capture compares with the scope's previous ordinal, even a stopped run's.
        let parent = (from + 1 == to)
            .then(|| {
                let ordinal = to_checkpoint["ordinalWithinScope"].as_u64().unwrap_or(0);
                ctx.checkpoints.iter().find(|c| {
                    c["status"] == "ready"
                        && c["scopeId"] == to_checkpoint["scopeId"]
                        && ordinal
                            .checked_sub(1)
                            .is_some_and(|p| c["ordinalWithinScope"] == p)
                })
            })
            .flatten();
        let from_ref = if from == 0 {
            ctx.scopes
                .iter()
                .find(|s| s["kind"] == "root_run")
                .and_then(|s| s["id"].as_str())
                .map(|id| git::checkpoint_ref(id, 0))
        } else {
            parent
                .or_else(|| ready.iter().find(|c| c["appRunOrdinal"] == from).copied())
                .and_then(|c| c["ref"].as_str())
                .map(str::to_owned)
        };
        let Some(from_ref) = from_ref else {
            return Err(unavailable(from));
        };
        let to_ref = to_checkpoint["ref"].as_str().unwrap_or_default().to_owned();
        let cwd = PathBuf::from(scope["cwd"].as_str().unwrap_or_default());
        let diff = patch(&cwd, &from_ref, &to_ref, ignore_whitespace)
            .await
            .map_err(|e| cause("VcsProcessExitError", e.to_string()))?;
        Ok(diff_result(thread_id, from, to, diff))
    }
}

/// The patch between two checkpoints, without imported files, cut at 10 MB.
async fn patch(
    cwd: &Path,
    from_ref: &str,
    to_ref: &str,
    ignore_whitespace: bool,
) -> conn_vcs::VcsResult<String> {
    let request = |format, max_output_bytes, file_paths| git::DiffRequest {
        cwd,
        from_ref,
        to_ref,
        ignore_whitespace,
        format,
        max_output_bytes,
        file_paths,
    };
    let authored = git::authored_paths(cwd, from_ref, to_ref)
        .await
        .unwrap_or(None);
    let files = match &authored {
        None => vec![],
        Some(_) => git::diff(request(
            git::DiffFormat::Numstat,
            git::DIFF_MAX_OUTPUT_BYTES,
            None,
        ))
        .await
        .map(|n| git::parse_numstat(&n))
        .unwrap_or_default(),
    };
    let retained: Vec<git::FileSummary> = files
        .iter()
        .filter(|f| !git::is_git_import(f, authored.as_ref()))
        .cloned()
        .collect();
    let batches: Vec<Option<Vec<String>>> = if retained.len() == files.len() {
        vec![None]
    } else {
        batch_paths(&retained).into_iter().map(Some).collect()
    };
    let mut out: Vec<u8> = vec![];
    let mut remaining = git::DIFF_MAX_OUTPUT_BYTES;
    for file_paths in batches {
        // One extra byte tells an exact fit from a cut patch.
        let part = git::diff(request(git::DiffFormat::Patch, remaining + 1, file_paths)).await?;
        let over = part.len() > remaining;
        out.extend_from_slice(&part);
        if over {
            let limit = git::DIFF_MAX_OUTPUT_BYTES - git::TRUNCATED_MARKER.len();
            let mut text = cut_utf8(&out, limit);
            text.push_str(git::TRUNCATED_MARKER);
            return Ok(text);
        }
        remaining -= part.len();
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_never_splits_a_character() {
        let text = "aé€😀".as_bytes();
        for limit in 0..=text.len() {
            let cut = cut_utf8(text, limit);
            assert!(!cut.contains('\u{FFFD}'), "limit {limit}: {cut:?}");
            assert!(cut.len() <= limit, "limit {limit}");
        }
        assert_eq!(cut_utf8(text, 3), "aé", "whole characters");
    }

    #[test]
    fn files_are_capped_as_on_the_t3_wire() {
        let files: Vec<Value> = (0..201)
            .map(|i| json!({"path": format!("f{i}"), "kind": "modified", "additions": 2, "deletions": 1}))
            .collect();
        let (kept, total) = capped(files);
        assert_eq!(kept.len(), 200, "first 200");
        assert_eq!(
            total,
            Some(json!({"count": 201, "additions": 402, "deletions": 201})),
            "totals"
        );
    }

    #[test]
    fn path_batches_fit_a_command_line() {
        let files: Vec<git::FileSummary> = (0..2000)
            .map(|i| git::FileSummary {
                path: format!("dir/file-{i:05}.txt"),
                previous_path: None,
                additions: 1,
                deletions: 0,
            })
            .collect();
        let batches = batch_paths(&files);
        assert!(batches.len() > 1, "split");
        for batch in &batches {
            let size: usize = batch.iter().map(|p| p.len() + 16).sum();
            assert!(size <= MAX_PATHSPEC_CHARS, "{size}");
        }
        assert_eq!(
            batches.iter().map(Vec::len).sum::<usize>(),
            2000,
            "every path"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn workspace_locks_are_dropped_when_free() {
        let locks = Checkpoints::default();
        {
            let _a = locks.workspace("/x").await;
            assert_eq!(locks.held(), 1, "held");
        }
        assert_eq!(locks.held(), 0, "released");
    }
}
