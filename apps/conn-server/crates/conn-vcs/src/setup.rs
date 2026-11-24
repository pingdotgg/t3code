//! Worktree setup: the progress that `subscribeWorktreeSetup` streams while a thread launches
//! into a new worktree, and [`provision`], which does the git part of that launch.
//!
//! Follows `WorktreeSetupTracker.ts` and `ThreadLaunchService.prepareInBackground`:
//! in memory only; a finished setup stays 30 s, then the stream sends `null`; a running
//! setup is never evicted; slow subscribers get only the newest snapshot. State is one entry
//! per thread with a running or recent setup or a live subscriber.
//!
//! The engine owns launch. It calls [`provision`] for the `fetch`, `checkout`, `submodules`
//! and `setup-script` stages, then [`WorktreeSetups::agent_started`] when the agent starts.
//! The setup script runs through a [`SetupRunner`]; the server's runs it in the thread's
//! terminal, as T3 does.

use std::{
    collections::HashMap,
    hash::{BuildHasher, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use conn_contract::{
    ProjectClonePhase as Phase, WorktreeSetupSnapshot, WorktreeSetupSnapshotSetupScript,
    WorktreeSetupStage, WorktreeSetupStageId as StageId, WorktreeSetupStageStatus as StageStatus,
};
use tokio::sync::{Notify, watch};

use crate::{
    error::{VcsError, VcsResult},
    process::ProcessError,
    repo::{self, git},
    worktree::{self, CreateWorktree},
};

pub const FINISHED_RETENTION: Duration = Duration::from_secs(30);
pub const TAIL_LINES: usize = 4;
pub const TAIL_LINE_MAX: usize = 400;
pub const DETAIL_MAX: usize = 200;
pub const ERROR_MAX: usize = 1000;
pub const STAGE_ORDER: [StageId; 5] = [
    StageId::Fetch,
    StageId::Checkout,
    StageId::Submodules,
    StageId::SetupScript,
    StageId::Agent,
];

fn clamp(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// The setup-script stage's detail.
fn exited(code: Option<i64>) -> String {
    match code {
        Some(code) => format!("exited with {code}"),
        None => "exited with no exit code".into(),
    }
}

struct Entry {
    tx: watch::Sender<Option<WorktreeSetupSnapshot>>,
    cancel: Option<Arc<Notify>>,
    /// Bumped by each `begin` and `finish`, so an old retention timer leaves a new setup alone.
    generation: u64,
}

#[derive(Clone, Default)]
pub struct WorktreeSetups {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

/// Raised to the caller of a stage when the user cancels the setup.
#[derive(Debug, PartialEq, Eq)]
pub struct Cancelled;

impl WorktreeSetups {
    pub fn new() -> Self {
        Self::default()
    }

    fn with<R>(&self, f: impl FnOnce(&mut HashMap<String, Entry>) -> R) -> R {
        f(&mut crate::lock(&self.entries))
    }

    fn sweep(entries: &mut HashMap<String, Entry>) {
        entries.retain(|_, e| e.tx.borrow().is_some() || e.tx.receiver_count() > 0);
    }

    /// The stream for `subscribeWorktreeSetup`: the current snapshot (or `None`) first, then
    /// each change. Dropping the receiver unsubscribes.
    pub fn subscribe(&self, thread_id: &str) -> watch::Receiver<Option<WorktreeSetupSnapshot>> {
        self.with(|entries| {
            Self::sweep(entries);
            entries
                .entry(thread_id.to_owned())
                .or_insert_with(|| Entry {
                    tx: watch::channel(None).0,
                    cancel: None,
                    generation: 0,
                })
                .tx
                .subscribe()
        })
    }

    pub fn get(&self, thread_id: &str) -> Option<WorktreeSetupSnapshot> {
        self.with(|e| e.get(thread_id).and_then(|e| e.tx.borrow().clone()))
    }

    /// Starts tracking a setup with `stages` (kept in canonical order). Returns the handle
    /// [`WorktreeSetups::cancel`] notifies.
    pub fn begin(
        &self,
        thread_id: &str,
        branch: Option<String>,
        base_ref: Option<String>,
        stages: &[StageId],
    ) -> Arc<Notify> {
        let cancel = Arc::new(Notify::new());
        self.with(|entries| {
            Self::sweep(entries);
            let entry = entries
                .entry(thread_id.to_owned())
                .or_insert_with(|| Entry {
                    tx: watch::channel(None).0,
                    cancel: None,
                    generation: 0,
                });
            entry.generation += 1;
            entry.cancel = Some(cancel.clone());
            let sequence = entry.tx.borrow().as_ref().map_or(0, |s| s.sequence + 1);
            entry.tx.send_replace(Some(WorktreeSetupSnapshot {
                thread_id: thread_id.to_owned(),
                phase: Phase::Running,
                started_at: conn_support::time::now_iso(),
                ended_at: None,
                branch,
                base_ref,
                worktree_path: None,
                setup_script: None,
                stages: STAGE_ORDER
                    .iter()
                    .filter(|id| stages.contains(id))
                    .map(|id| WorktreeSetupStage {
                        id: *id,
                        status: StageStatus::Pending,
                        started_at: None,
                        ended_at: None,
                        percent: None,
                        detail: None,
                        tail: Vec::new(),
                    })
                    .collect(),
                error: None,
                sequence,
            }));
        });
        cancel
    }

    /// Applies `f` to the running snapshot and publishes it with the next sequence.
    pub fn update(&self, thread_id: &str, f: impl FnOnce(&mut WorktreeSetupSnapshot)) {
        self.with(|entries| {
            if let Some(entry) = entries.get(thread_id) {
                entry.tx.send_if_modified(|current| {
                    let Some(snapshot) = current else {
                        return false;
                    };
                    f(snapshot);
                    snapshot.sequence += 1;
                    true
                });
            }
        });
    }

    pub fn stage_status(
        &self,
        thread_id: &str,
        id: StageId,
        status: StageStatus,
        detail: Option<&str>,
    ) {
        let now = conn_support::time::now_iso();
        self.update(thread_id, |s| {
            if let Some(stage) = s.stages.iter_mut().find(|st| st.id == id) {
                if stage.started_at.is_none() && status != StageStatus::Pending {
                    stage.started_at = Some(now.clone());
                }
                stage.ended_at = match status {
                    StageStatus::Running | StageStatus::Pending => None,
                    _ => stage.ended_at.take().or(Some(now)),
                };
                stage.status = status;
                if let Some(detail) = detail {
                    stage.detail = Some(clamp(detail, DETAIL_MAX));
                }
            }
        });
    }

    pub fn append_tail(&self, thread_id: &str, id: StageId, line: &str) {
        let line = clamp(line, TAIL_LINE_MAX);
        self.update(thread_id, |s| {
            if let Some(stage) = s.stages.iter_mut().find(|st| st.id == id) {
                stage.tail.push(line);
                let excess = stage.tail.len().saturating_sub(TAIL_LINES);
                stage.tail.drain(..excess);
            }
        });
    }

    /// Ends the setup. Running stages become done, skipped or failed with the phase. The
    /// snapshot stays 30 s, then subscribers get `null`.
    pub fn finish(&self, thread_id: &str, phase: Phase, error: Option<&str>) {
        let now = conn_support::time::now_iso();
        let stage_end = match phase {
            Phase::Done => StageStatus::Done,
            Phase::Cancelled => StageStatus::Skipped,
            _ => StageStatus::Failed,
        };
        self.update(thread_id, |s| {
            s.phase = phase;
            s.ended_at = Some(now.clone());
            s.error = error.map(|e| clamp(e, ERROR_MAX));
            for stage in &mut s.stages {
                if stage.status == StageStatus::Running {
                    stage.status = stage_end;
                    stage.ended_at = Some(now.clone());
                }
            }
        });
        let generation = self.with(|entries| {
            entries.get_mut(thread_id).map(|e| {
                e.cancel = None;
                e.generation += 1;
                e.generation
            })
        });
        let Some(generation) = generation else {
            return;
        };
        let setups = self.clone();
        let thread_id = thread_id.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(FINISHED_RETENTION).await;
            setups.with(|entries| {
                if let Some(entry) = entries.get(&thread_id)
                    && entry.generation == generation
                {
                    entry.tx.send_replace(None);
                }
                Self::sweep(entries);
            });
        });
    }

    /// The agent started (`markUncancellable`, then the `agent` stage). The setup ends now,
    /// unless an async setup script still runs: its end finishes it (`awaitAsyncSetup`).
    pub fn agent_started(&self, thread_id: &str) {
        self.mark_uncancellable(thread_id);
        self.stage_status(thread_id, StageId::Agent, StageStatus::Done, None);
        let script_runs = self.get(thread_id).is_some_and(|s| {
            s.stages
                .iter()
                .any(|st| st.id == StageId::SetupScript && st.status == StageStatus::Running)
        });
        if !script_runs {
            self.finish(thread_id, Phase::Done, None);
        }
    }

    /// An async setup script ended: its stage records the exit code, and a setup whose agent
    /// already started finishes.
    pub fn setup_script_ended(&self, thread_id: &str, code: Option<i64>) {
        let Some(snapshot) = self.get(thread_id) else {
            return;
        };
        if snapshot.phase != Phase::Running {
            return;
        }
        let status = if code == Some(0) {
            StageStatus::Done
        } else {
            StageStatus::Failed
        };
        self.stage_status(thread_id, StageId::SetupScript, status, Some(&exited(code)));
        let agent_done = snapshot
            .stages
            .iter()
            .any(|st| st.id == StageId::Agent && st.status == StageStatus::Done);
        if agent_done {
            self.finish(thread_id, Phase::Done, None);
        }
    }

    /// After this, `cancel` returns false (the agent stage has begun).
    pub fn mark_uncancellable(&self, thread_id: &str) {
        self.with(|e| {
            if let Some(entry) = e.get_mut(thread_id) {
                entry.cancel = None;
            }
        });
    }

    /// `worktreeSetup.cancel`: true when a running, cancellable setup was asked to stop.
    pub fn cancel(&self, thread_id: &str) -> bool {
        self.with(|entries| {
            let Some(entry) = entries.get(thread_id) else {
                return false;
            };
            let running = entry
                .tx
                .borrow()
                .as_ref()
                .is_some_and(|s| s.phase == Phase::Running);
            match (&entry.cancel, running) {
                (Some(cancel), true) => {
                    cancel.notify_one();
                    true
                }
                _ => false,
            }
        })
    }

    /// Entries held: running or recent setups plus threads with a live subscriber.
    pub fn len(&self) -> usize {
        self.with(|e| e.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A boxed future, as [`SetupRunner`] returns.
pub type SetupFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Runs the project's `runOnWorktreeCreate` script in a new checkout
/// (`ProjectSetupScriptRunner.runForThread` with `observeCompletion`). The server's runner
/// types it into the thread's `setup-<id>` terminal and hands each output line to
/// [`WorktreeSetups::append_tail`].
pub trait SetupRunner: Send + Sync {
    /// Starts the script; `Ok(None)` when the project has none.
    fn start<'a>(
        &'a self,
        thread: &'a str,
        worktree: &'a Path,
    ) -> SetupFuture<'a, Result<Option<StartedSetup>, String>>;

    /// Closes a started script's terminal when its launch failed or was cancelled.
    fn discard(&self, thread: &str, terminal_id: &str);
}

/// A started setup script.
pub struct StartedSetup {
    pub name: String,
    pub command: String,
    pub terminal_id: String,
    /// The script's `async` flag: the agent starts without waiting for it.
    pub background: bool,
    /// The exit code, or `None` when the terminal ended first.
    pub completion: SetupFuture<'static, Option<i64>>,
}

impl std::fmt::Debug for StartedSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartedSetup")
            .field("name", &self.name)
            .field("terminal_id", &self.terminal_id)
            .field("background", &self.background)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct ProvisionRequest {
    pub thread_id: String,
    /// The project's workspace root.
    pub project_root: PathBuf,
    /// The ref to start from, such as `main` or `origin/main`.
    pub base_ref: String,
    /// The branch to create. `None` creates a temporary `t3/<8 hex>` branch.
    pub branch: Option<String>,
    /// Fetch the base from its remote first, as `startFromOrigin` does.
    pub start_from_origin: bool,
    /// Runs the setup script; `None` skips the stage.
    pub setup: Option<Arc<dyn SetupRunner>>,
    pub worktrees_dir: PathBuf,
    /// `worktreeSubmodules` for the project; `None` follows `t3.json`.
    pub submodules: Option<String>,
    pub missing_base: MissingBase,
}

impl std::fmt::Debug for ProvisionRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProvisionRequest")
            .field("thread_id", &self.thread_id)
            .field("project_root", &self.project_root)
            .field("base_ref", &self.base_ref)
            .field("branch", &self.branch)
            .field("start_from_origin", &self.start_from_origin)
            .field("setup", &self.setup.is_some())
            .field("worktrees_dir", &self.worktrees_dir)
            .field("submodules", &self.submodules)
            .field("missing_base", &self.missing_base)
            .finish()
    }
}

/// What provisioning does when `base_ref` names no commit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MissingBase {
    /// Git refuses it and the launch fails: someone named this base just now.
    #[default]
    Fail,
    /// A saved strategy (a scheduled task's) outlived its base: start from the remote's
    /// default branch, else the checked-out commit (`worktreeFallbackBase`).
    FallBack,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvisionedWorktree {
    pub path: PathBuf,
    pub branch: String,
    /// The ref or commit the branch starts at.
    pub base_ref: String,
}

/// Clients show these texts; keep them as they are.
#[derive(Debug, thiserror::Error)]
pub enum ProvisionError {
    #[error("Worktree setup cancelled.")]
    Cancelled,
    #[error("Workspace preparation failed: {0}")]
    Failed(#[source] VcsError),
    #[error("{0}")]
    SetupScript(String),
}

/// `t3/<8 hex>`, the name of a branch the user did not choose.
pub fn temporary_branch_name() -> String {
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(conn_support::time::now_ms() as u128);
    format!("t3/{:08x}", hasher.finish() as u32)
}

async fn cancellable<T>(
    cancel: &Notify,
    work: impl std::future::Future<Output = VcsResult<T>>,
) -> Result<T, ProvisionError> {
    tokio::select! {
        result = work => result.map_err(ProvisionError::Failed),
        () = cancel.notified() => Err(ProvisionError::Cancelled),
    }
}

/// Creates the worktree for a launching thread and runs its setup script, reporting each
/// stage to `setups`. On failure or cancel it removes what it created and finishes the
/// setup; on success the caller runs the `agent` stage and calls `finish(Done)`.
pub async fn provision(
    setups: &WorktreeSetups,
    request: ProvisionRequest,
) -> Result<ProvisionedWorktree, ProvisionError> {
    let thread = request.thread_id.as_str();
    let cancel = setups.begin(
        thread,
        request.branch.clone(),
        Some(request.base_ref.clone()),
        &STAGE_ORDER,
    );
    let mut created: Option<(worktree::Claim, String)> = None;
    let mut started: Option<String> = None;
    let mut dropped = FinishOnDrop {
        setups,
        thread,
        armed: true,
    };
    let result = provision_stages(setups, &request, &cancel, &mut created, &mut started).await;
    dropped.armed = false;
    if let Err(error) = &result {
        if let (Some(runner), Some(terminal)) = (&request.setup, &started) {
            runner.discard(thread, terminal);
        }
        let left = match created {
            Some((claim, branch)) => {
                worktree::discard_claim(request.project_root.as_path(), &claim, &branch)
                    .await
                    .err()
                    .map(|e| {
                        format!(
                            "The worktree at {} could not be removed: {e}",
                            claim.path.display()
                        )
                    })
            }
            None => None,
        };
        match (error, left) {
            (ProvisionError::Cancelled, left) => {
                setups.finish(thread, Phase::Cancelled, left.as_deref());
            }
            (other, None) => setups.finish(thread, Phase::Failed, Some(&other.to_string())),
            (other, Some(left)) => {
                setups.finish(thread, Phase::Failed, Some(&format!("{other} {left}")));
            }
        }
    }
    result
}

async fn provision_stages(
    setups: &WorktreeSetups,
    request: &ProvisionRequest,
    cancel: &Notify,
    created: &mut Option<(worktree::Claim, String)>,
    started: &mut Option<String>,
) -> Result<ProvisionedWorktree, ProvisionError> {
    let thread = request.thread_id.as_str();
    let root = request.project_root.as_path();
    let branch = request.branch.clone().unwrap_or_else(temporary_branch_name);

    let mut start = request.base_ref.clone();
    let mut base_name = request.base_ref.clone();
    let mut fetched = false;
    if request.start_from_origin {
        setups.stage_status(thread, StageId::Fetch, StageStatus::Running, None);
        match cancellable(cancel, fetch_base(root, &request.base_ref)).await? {
            Some((sha, _)) => {
                start = sha;
                fetched = true;
                setups.stage_status(thread, StageId::Fetch, StageStatus::Done, None);
            }
            None => setups.stage_status(thread, StageId::Fetch, StageStatus::Skipped, None),
        }
    } else {
        setups.stage_status(thread, StageId::Fetch, StageStatus::Skipped, None);
    }
    if request.missing_base == MissingBase::FallBack && !fetched {
        let fallback = cancellable(cancel, async {
            // A failed lookup keeps the recorded base, so Git names what is missing.
            Ok(fallback_base(root, &start, request.start_from_origin)
                .await
                .unwrap_or(None))
        })
        .await?;
        if let Some((fallback_start, fallback_name)) = fallback {
            start = fallback_start;
            base_name = fallback_name;
            setups.update(thread, |s| s.base_ref = Some(base_name.clone()));
        }
    }

    setups.stage_status(thread, StageId::Checkout, StageStatus::Running, None);
    let mut claimed = None;
    let made = cancellable(
        cancel,
        worktree::create_worktree_claiming(
            &CreateWorktree {
                cwd: root.to_owned(),
                ref_name: start.clone(),
                new_ref_name: Some(branch.clone()),
                base_ref_name: Some(base_name),
                worktrees_dir: request.worktrees_dir.clone(),
            },
            &mut claimed,
        ),
    )
    .await;
    // A cancel during the checkout removes what it started. A failed checkout (a failing
    // `post-checkout` hook) keeps it, as Git does: the hook may have written files.
    let worktree = match made {
        Err(ProvisionError::Cancelled) => {
            *created = claimed.map(|claim| (claim, branch.clone()));
            return Err(ProvisionError::Cancelled);
        }
        made => made?,
    };
    *created = Some((
        worktree::Claim {
            path: worktree.path.clone(),
            lock_reason: None,
        },
        branch.clone(),
    ));
    let path_text = worktree.path.to_string_lossy().into_owned();
    setups.update(thread, |s| {
        s.worktree_path = Some(path_text.clone());
        s.branch = Some(branch.clone());
    });
    setups.stage_status(thread, StageId::Checkout, StageStatus::Done, None);

    match worktree::submodule_mode(&worktree.path, request.submodules.as_deref()).await {
        None => setups.stage_status(
            thread,
            StageId::Submodules,
            StageStatus::Skipped,
            Some("none"),
        ),
        Some((worktree::Submodules::None, origin)) => setups.stage_status(
            thread,
            StageId::Submodules,
            StageStatus::Skipped,
            Some(format!("disabled in {}", origin.label()).as_str()),
        ),
        Some((mode, _)) => {
            setups.stage_status(thread, StageId::Submodules, StageStatus::Running, None);
            match cancellable(cancel, async {
                worktree::update_submodules(&worktree.path, mode).await?;
                Ok(())
            })
            .await
            {
                Ok(()) => setups.stage_status(thread, StageId::Submodules, StageStatus::Done, None),
                Err(ProvisionError::Cancelled) => return Err(ProvisionError::Cancelled),
                Err(_) => setups.stage_status(
                    thread,
                    StageId::Submodules,
                    StageStatus::Warning,
                    Some("submodule checkout failed"),
                ),
            }
        }
    }

    match &request.setup {
        None => setups.stage_status(thread, StageId::SetupScript, StageStatus::Skipped, None),
        Some(runner) => {
            setups.stage_status(thread, StageId::SetupScript, StageStatus::Running, None);
            // A terminal being opened is not dropped half-made: the start runs to its end, so
            // its id is known and the cancel below discards it (`provision`).
            let run = runner.start(thread, &worktree.path).await;
            if let Ok(Some(script)) = &run {
                *started = Some(script.terminal_id.clone());
            }
            // `cancel` stores its permit, so one sent during the start is seen here.
            tokio::select! {
                biased;
                () = cancel.notified() => return Err(ProvisionError::Cancelled),
                () = std::future::ready(()) => {}
            }
            match run.map_err(ProvisionError::SetupScript)? {
                None => {
                    setups.stage_status(thread, StageId::SetupScript, StageStatus::Skipped, None)
                }
                Some(script) => {
                    setups.update(thread, |s| {
                        s.setup_script = Some(WorktreeSetupSnapshotSetupScript {
                            name: script.name.clone(),
                            command: script.command.clone(),
                            terminal_id: script.terminal_id.clone(),
                        });
                    });
                    if script.background {
                        // Record the result when the script ends, not after the agent starts.
                        let (setups, thread) = (setups.clone(), thread.to_owned());
                        tokio::spawn(async move {
                            let code = script.completion.await;
                            setups.setup_script_ended(&thread, code);
                        });
                    } else {
                        let code = tokio::select! {
                            code = script.completion => code,
                            () = cancel.notified() => return Err(ProvisionError::Cancelled),
                        };
                        setups.stage_status(
                            thread,
                            StageId::SetupScript,
                            if code == Some(0) {
                                StageStatus::Done
                            } else {
                                StageStatus::Failed
                            },
                            Some(&exited(code)),
                        );
                        if code != Some(0) {
                            return Err(ProvisionError::SetupScript(match code {
                                Some(code) => format!("Setup script exited with {code}."),
                                None => "Setup script exited with no exit code.".into(),
                            }));
                        }
                    }
                }
            }
        }
    }
    Ok(ProvisionedWorktree {
        path: worktree.path,
        branch,
        base_ref: start,
    })
}

/// `worktreeFallbackBase`, for a recorded `base` that names no commit: the remote's default
/// branch, fetched first, then the checked-out branch, then HEAD, as `(start, base name)`.
/// `None` when `base` still resolves or nothing does.
async fn fallback_base(
    root: &Path,
    base: &str,
    start_from_origin: bool,
) -> VcsResult<Option<(String, String)>> {
    // `:/text` is a commit search, not a ref; `git worktree add` reads `-` as `@{-1}`.
    let probe = if base == "-" { "@{-1}" } else { base };
    if base.starts_with(':') || repo::resolve_commit(root, probe).await?.is_some() {
        return Ok(None);
    }
    let remote = if start_from_origin {
        base_remote(root, base).await?.map(|(remote, _)| remote)
    } else {
        None
    };
    let remote = match remote {
        Some(remote) => Some(remote),
        None => repo::primary_remote(root).await?,
    };
    if let Some(remote) = remote
        && let Some(default) = repo::remote_default_branch(root, &remote).await?
    {
        match fetch_remote_branch(root, &remote, &default).await {
            Ok(Some((sha, remote_ref))) => {
                return Ok(Some((sha, format!("refs/remotes/{remote_ref}"))));
            }
            // A completed fetch that found no branch: the tracking ref is stale.
            Ok(None) => {}
            Err(_) => {
                let tracking = format!("refs/remotes/{remote}/{default}");
                if repo::resolve_commit(root, &tracking).await?.is_some() {
                    return Ok(Some((tracking.clone(), tracking)));
                }
            }
        }
    }
    if let Some(branch) = repo::current_branch(root).await? {
        return Ok(Some((branch.clone(), branch)));
    }
    Ok(repo::has_head_commit(root)
        .await?
        .then(|| ("HEAD".to_owned(), "HEAD".to_owned())))
}

/// `(remote, branch)` to fetch for `base_ref`: its upstream when it is a local branch, else
/// the remote it names, else `origin`. `None` when that remote does not exist.
async fn base_remote(root: &Path, base_ref: &str) -> VcsResult<Option<(String, String)>> {
    let mut remotes = repo::remote_names(root).await?;
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let full = format!("refs/heads/{base_ref}");
    let upstream = repo::optional_text(git(
        "GitVcsDriver.resolveWorktreeBaseRemote",
        root,
        [
            "for-each-ref",
            "--format=%(refname)\t%(upstream:remotename)\t%(upstream:remoteref)",
            full.as_str(),
        ],
    ))
    .await?
    .unwrap_or_default();
    let local = upstream.lines().find_map(|line| {
        let mut fields = line.split('\t');
        (fields.next() == Some(full.as_str())).then(|| {
            (
                fields.next().unwrap_or_default(),
                fields.next().unwrap_or_default(),
            )
        })
    });
    let target = if let Some((remote, merge)) = local {
        match merge.strip_prefix("refs/heads/") {
            Some(branch) if remotes.iter().any(|r| r == remote) => {
                Some((remote.to_owned(), branch.to_owned()))
            }
            _ => None,
        }
    } else {
        remotes.iter().find_map(|r| {
            base_ref
                .strip_prefix(&format!("{r}/"))
                .map(|b| (r.clone(), b.to_owned()))
        })
    };
    Ok(target
        .or_else(|| Some(("origin".into(), base_ref.to_owned())))
        .filter(|(remote, _)| remotes.iter().any(|r| r == remote)))
}

/// Fetches a worktree base as `(commit, remote ref)`, or `None` without a matching remote.
pub async fn fetch_base(root: &Path, base_ref: &str) -> VcsResult<Option<(String, String)>> {
    let Some((remote, branch)) = base_remote(root, base_ref).await? else {
        return Ok(None);
    };
    fetch_remote_branch(root, &remote, &branch).await
}

pub async fn fetch_remote_branch(
    root: &Path,
    remote: &str,
    branch: &str,
) -> VcsResult<Option<(String, String)>> {
    if branch == "HEAD"
        || branch.starts_with('-')
        || branch.contains("..")
        || branch.contains("@{")
        || branch
            .bytes()
            .any(|b| b <= b' ' || b == 0x7f || b"~^:?*[\\".contains(&b))
    {
        return Ok(None);
    }
    let refspec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
    let fetch = || {
        git(
            "GitVcsDriver.fetchRemote",
            root,
            [
                "fetch",
                "--quiet",
                "--no-tags",
                "--",
                remote,
                refspec.as_str(),
            ],
        )
        .timeout(Duration::from_secs(300))
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("LC_ALL", "C")
    };
    let fetched = match fetch().run().await {
        Err(ProcessError::Exit { ref stderr, .. }) if stderr.contains("cannot lock ref") => {
            fetch().run().await
        }
        result => result,
    };
    match fetched {
        Err(ProcessError::Exit { stderr, .. })
            if stderr.lines().any(|line| {
                line == format!("fatal: couldn't find remote ref refs/heads/{branch}")
            }) =>
        {
            return Ok(None);
        }
        result => {
            result?;
        }
    }
    let remote_ref = format!("{remote}/{branch}");
    let full = format!("refs/remotes/{remote_ref}^{{commit}}");
    Ok(repo::optional_text(git(
        "GitVcsDriver.fetchWorktreeBaseCommit",
        root,
        [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            full.as_str(),
        ],
    ))
    .await?
    .filter(|sha| !sha.is_empty())
    .map(|sha| (sha, remote_ref)))
}

/// Ends a setup entry as cancelled if [`provision`] is dropped before it returns, so a
/// dropped launch never leaves an entry running forever.
struct FinishOnDrop<'a> {
    setups: &'a WorktreeSetups,
    thread: &'a str,
    armed: bool,
}

impl Drop for FinishOnDrop<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.setups.finish(self.thread, Phase::Cancelled, None);
        }
    }
}

impl std::fmt::Debug for WorktreeSetups {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorktreeSetups")
            .field("entries", &self.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn tracks_stages_and_forgets_after_retention() {
        let setups = WorktreeSetups::new();
        let mut rx = setups.subscribe("t1");
        assert!(rx.borrow_and_update().is_none());
        setups.begin(
            "t1",
            None,
            Some("main".into()),
            &[StageId::Agent, StageId::Fetch],
        );
        let snapshot = rx.borrow_and_update().clone().unwrap();
        assert_eq!(
            snapshot.stages.iter().map(|s| s.id).collect::<Vec<_>>(),
            [StageId::Fetch, StageId::Agent]
        );
        setups.stage_status("t1", StageId::Fetch, StageStatus::Running, None);
        for n in 0..6 {
            setups.append_tail("t1", StageId::Fetch, &format!("line {n}"));
        }
        let snapshot = setups.get("t1").unwrap();
        assert_eq!(
            snapshot.stages[0].tail,
            ["line 2", "line 3", "line 4", "line 5"]
        );
        assert!(snapshot.sequence > 0);
        assert!(setups.cancel("t1"));
        setups.finish("t1", Phase::Cancelled, None);
        assert!(!setups.cancel("t1"));
        let finished = setups.get("t1").unwrap();
        assert_eq!(finished.stages[0].status, StageStatus::Skipped);

        tokio::time::sleep(FINISHED_RETENTION + Duration::from_secs(1)).await;
        assert!(rx.borrow_and_update().is_none());
        drop(rx);
        let _ = setups.subscribe("other");
        assert_eq!(
            setups.len(),
            1,
            "t1 is gone; only the new subscriber's entry stays"
        );
    }

    #[test]
    fn clamps_long_text() {
        assert_eq!(clamp("abcdef", 4), "abc…");
    }
}
