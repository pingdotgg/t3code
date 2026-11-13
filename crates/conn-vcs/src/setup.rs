//! Worktree setup: the progress that `subscribeWorktreeSetup` streams while a thread launches
//! into a new worktree, and [`provision`], which does the git part of that launch.
//!
//! Follows `WorktreeSetupTracker.ts` and `ThreadLaunchService.prepareInBackground`:
//! in memory only; a finished setup stays 30 s, then the stream sends `null`; a running
//! setup is never evicted; slow subscribers get only the newest snapshot. State is one entry
//! per thread with a running or recent setup or a live subscriber.
//!
//! The engine owns launch. It calls [`provision`] for the `fetch`, `checkout`, `submodules`
//! and `setup-script` stages, then marks `agent` and calls [`WorktreeSetups::finish`].

use std::{
    collections::HashMap,
    hash::{BuildHasher, Hasher},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use conn_contract::{
    ProjectClonePhase as Phase, WorktreeSetupSnapshot, WorktreeSetupSnapshotSetupScript,
    WorktreeSetupStage, WorktreeSetupStageId as StageId, WorktreeSetupStageStatus as StageStatus,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::{Notify, watch},
};

use crate::{
    clock,
    error::{VcsError, VcsResult},
    repo::{self, git},
    worktree::{self, CreateWorktree, Removal},
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
        f(&mut self.entries.lock().expect("setup lock"))
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
                started_at: clock::now_iso(),
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
        let now = clock::now_iso();
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
        let now = clock::now_iso();
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

/// A project script that runs when a worktree is created (`runOnWorktreeCreate`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetupScript {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[derive(Clone, Debug)]
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
    pub setup_script: Option<SetupScript>,
    pub worktrees_dir: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvisionedWorktree {
    pub path: PathBuf,
    pub branch: String,
    /// The ref or commit the branch starts at.
    pub base_ref: String,
}

#[derive(Debug)]
pub enum ProvisionError {
    Cancelled,
    Failed(VcsError),
    SetupScript(String),
}

impl std::fmt::Display for ProvisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProvisionError::Cancelled => f.write_str("Worktree setup cancelled."),
            ProvisionError::Failed(e) => write!(f, "Workspace preparation failed: {e}"),
            ProvisionError::SetupScript(e) => f.write_str(e),
        }
    }
}

/// `t3/<8 hex>`, the name of a branch the user did not choose.
pub fn temporary_branch_name() -> String {
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(clock::now_ms() as u128);
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
    let mut created: Option<(PathBuf, String)> = None;
    let mut dropped = FinishOnDrop {
        setups,
        thread,
        armed: true,
    };
    let result = provision_stages(setups, &request, &cancel, &mut created).await;
    dropped.armed = false;
    if let Err(error) = &result {
        if let Some((path, branch)) = created {
            let root = request.project_root.as_path();
            let _ = worktree::remove_worktree(root, &path, Removal::Force).await;
            let _ = worktree::delete_branch(root, &branch, Removal::Force).await;
        }
        match error {
            ProvisionError::Cancelled => setups.finish(thread, Phase::Cancelled, None),
            other => setups.finish(thread, Phase::Failed, Some(&other.to_string())),
        }
    }
    result
}

async fn provision_stages(
    setups: &WorktreeSetups,
    request: &ProvisionRequest,
    cancel: &Notify,
    created: &mut Option<(PathBuf, String)>,
) -> Result<ProvisionedWorktree, ProvisionError> {
    let thread = request.thread_id.as_str();
    let root = request.project_root.as_path();
    let branch = request.branch.clone().unwrap_or_else(temporary_branch_name);

    let mut start = request.base_ref.clone();
    let remote = if request.start_from_origin {
        cancellable(cancel, base_remote(root, &request.base_ref)).await?
    } else {
        None
    };
    match remote {
        Some((remote, remote_branch)) => {
            setups.stage_status(thread, StageId::Fetch, StageStatus::Running, None);
            cancellable(cancel, async {
                git(
                    "GitVcsDriver.fetchWorktreeBaseCommit",
                    root,
                    ["fetch", "--quiet", "--", remote.as_str()],
                )
                .timeout(Duration::from_secs(300))
                .env("GCM_INTERACTIVE", "never")
                .env("GIT_ASKPASS", "")
                .env("SSH_ASKPASS", "")
                .env("SSH_ASKPASS_REQUIRE", "never")
                .run()
                .await?;
                Ok(())
            })
            .await?;
            let full = format!("refs/remotes/{remote}/{remote_branch}^{{commit}}");
            if let Ok(Some(sha)) = repo::optional_text(git(
                "GitVcsDriver.fetchWorktreeBaseCommit",
                root,
                ["rev-parse", "--verify", "--quiet", full.as_str()],
            ))
            .await
                && !sha.is_empty()
            {
                start = sha;
            }
            setups.stage_status(thread, StageId::Fetch, StageStatus::Done, None);
        }
        None => setups.stage_status(thread, StageId::Fetch, StageStatus::Skipped, None),
    }

    setups.stage_status(thread, StageId::Checkout, StageStatus::Running, None);
    let worktree = cancellable(
        cancel,
        worktree::create_worktree(&CreateWorktree {
            cwd: root.to_owned(),
            ref_name: start.clone(),
            new_ref_name: Some(branch.clone()),
            base_ref_name: Some(request.base_ref.clone()),
            worktrees_dir: request.worktrees_dir.clone(),
        }),
    )
    .await?;
    *created = Some((worktree.path.clone(), branch.clone()));
    let path_text = worktree.path.to_string_lossy().into_owned();
    setups.update(thread, |s| {
        s.worktree_path = Some(path_text.clone());
        s.branch = Some(branch.clone());
    });
    setups.stage_status(thread, StageId::Checkout, StageStatus::Done, None);

    if worktree.path.join(".gitmodules").exists() {
        setups.stage_status(thread, StageId::Submodules, StageStatus::Running, None);
        let result = cancellable(cancel, async {
            git(
                "GitVcsDriver.submodules",
                &worktree.path,
                ["submodule", "update", "--init", "--recursive"],
            )
            .timeout(Duration::from_secs(3600))
            .run()
            .await?;
            Ok(())
        })
        .await;
        match result {
            Ok(()) => setups.stage_status(thread, StageId::Submodules, StageStatus::Done, None),
            Err(ProvisionError::Cancelled) => return Err(ProvisionError::Cancelled),
            Err(_) => setups.stage_status(
                thread,
                StageId::Submodules,
                StageStatus::Warning,
                Some("submodule checkout failed"),
            ),
        }
    } else {
        setups.stage_status(
            thread,
            StageId::Submodules,
            StageStatus::Skipped,
            Some("none"),
        );
    }

    match &request.setup_script {
        None => setups.stage_status(thread, StageId::SetupScript, StageStatus::Skipped, None),
        Some(script) => {
            setups.stage_status(thread, StageId::SetupScript, StageStatus::Running, None);
            let terminal_id = format!("setup-{}", script.id);
            setups.update(thread, |s| {
                s.setup_script = Some(WorktreeSetupSnapshotSetupScript {
                    name: script.name.clone(),
                    command: script.command.clone(),
                    terminal_id,
                });
            });
            let code = tokio::select! {
                code = run_setup_script(setups, thread, script, root, &worktree.path) => code,
                () = cancel.notified() => return Err(ProvisionError::Cancelled),
            };
            let detail = match code {
                Some(code) => format!("exited with {code}"),
                None => "exited with no exit code".into(),
            };
            if code == Some(0) {
                setups.stage_status(
                    thread,
                    StageId::SetupScript,
                    StageStatus::Done,
                    Some(&detail),
                );
            } else {
                setups.stage_status(
                    thread,
                    StageId::SetupScript,
                    StageStatus::Failed,
                    Some(&detail),
                );
                return Err(ProvisionError::SetupScript(match code {
                    Some(code) => format!("Setup script exited with {code}."),
                    None => "Setup script exited with no exit code.".into(),
                }));
            }
        }
    }
    Ok(ProvisionedWorktree {
        path: worktree.path,
        branch,
        base_ref: start,
    })
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
            "--format=%(upstream:remotename)\t%(upstream:remoteref)",
            full.as_str(),
        ],
    ))
    .await?
    .unwrap_or_default();
    let target = if !upstream.is_empty() {
        let (remote, merge) = upstream.split_once('\t').unwrap_or((&upstream, ""));
        match merge.strip_prefix("refs/heads/") {
            Some(branch) if remotes.iter().any(|r| r == remote) => {
                Some((remote.to_owned(), branch.to_owned()))
            }
            _ => None,
        }
    } else {
        remotes
            .iter()
            .find_map(|r| {
                base_ref
                    .strip_prefix(&format!("{r}/"))
                    .map(|b| (r.clone(), b.to_owned()))
            })
            .or_else(|| Some(("origin".into(), base_ref.to_owned())))
    };
    Ok(target.filter(|(remote, _)| remotes.iter().any(|r| r == remote)))
}

/// Runs the script with `sh -c` in the worktree (the TypeScript server types it into a
/// terminal; this server has no terminal service in this crate). Keeps the last 4 output
/// lines in the stage's tail. Returns the exit code.
///
/// The script runs in its own process group. The group is killed when the script exits (jobs
/// it left behind would hold its pipes open), and when this future is dropped, which is how
/// a cancel or a dropped launch ends it.
async fn run_setup_script(
    setups: &WorktreeSetups,
    thread: &str,
    script: &SetupScript,
    project_root: &Path,
    worktree: &Path,
) -> Option<i32> {
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&script.command)
        .current_dir(worktree)
        .env("T3CODE_PROJECT_ROOT", project_root)
        .env("T3CODE_WORKTREE_PATH", worktree)
        .env("COLORTERM", "")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let group = GroupKill(
        child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .and_then(rustix::process::Pid::from_raw),
    );
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let wait = async move {
        let code = child.wait().await.ok().and_then(|status| status.code());
        drop(group);
        code
    };
    let (code, (), ()) = tokio::join!(
        wait,
        tail_pipe(setups, thread, stdout),
        tail_pipe(setups, thread, stderr)
    );
    code
}

async fn tail_pipe(setups: &WorktreeSetups, thread: &str, pipe: Option<impl AsyncRead + Unpin>) {
    if let Some(pipe) = pipe {
        tail_lines(setups, thread, pipe).await;
    }
}

/// Kills a process group with `SIGKILL` when dropped.
struct GroupKill(Option<rustix::process::Pid>);

impl Drop for GroupKill {
    fn drop(&mut self) {
        if let Some(group) = self.0.take() {
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        }
    }
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

/// Longest partial line kept; the rest of a longer line is skipped.
const PARTIAL_LINE_MAX: usize = 4096;

/// Feeds each output line to the stage's tail, with bounded memory.
async fn tail_lines(setups: &WorktreeSetups, thread: &str, mut reader: impl AsyncRead + Unpin) {
    let emit = |line: &[u8]| {
        let line = strip_ansi(String::from_utf8_lossy(line).trim());
        if !line.is_empty() {
            setups.append_tail(thread, StageId::SetupScript, &line);
        }
    };
    let mut chunk = [0u8; 4096];
    let mut line = Vec::new();
    let mut skipping = false;
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &chunk[..n] {
            if byte == b'\n' || byte == b'\r' {
                if !skipping {
                    emit(&line);
                }
                line.clear();
                skipping = false;
            } else if !skipping {
                line.push(byte);
                if line.len() >= PARTIAL_LINE_MAX {
                    emit(&line);
                    line.clear();
                    skipping = true;
                }
            }
        }
    }
    emit(&line);
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if !c.is_control() {
            out.push(c);
        }
    }
    out
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
    fn strips_escape_sequences() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m done"), "ok done");
        assert_eq!(clamp("abcdef", 4), "abc…");
    }
}
