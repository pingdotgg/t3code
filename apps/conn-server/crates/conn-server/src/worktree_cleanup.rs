//! Worktree cleanup, as T3's storage cleanup removes managed worktrees
//! (`apps/server/src/storageCleanup.ts`, `cleanWorktrees`).
//!
//! The rules come from `storageCleanup` and the per-project `worktreeCleanup` override: after N
//! days without activity, N days after the thread settled, once its pull request merged, when
//! the thread is deleted, or when a finished thread's branch has nothing beyond the default
//! branch. Every rule is off by default. A worktree is kept when any of these holds:
//!
//! - a thread that shares it is running or has pending work, or a provider session or
//!   terminal is open in it;
//! - it is not a linked worktree in a managed worktree folder, or it holds a project checkout
//!   or a nested repository;
//! - its branch changed, or it has local changes ([`KeepWhen`]), changes git status hides, or
//!   submodule commits on no remote-tracking ref;
//! - Git locked it, or its HEAD log holds commits nothing else keeps.
//!
//! Commits on the thread's branch are never lost: `git worktree remove` keeps the branch, and a
//! detached or switched checkout is kept. The checks run again under the checkout's lease right
//! before removal; turn starts and terminal starts take the same lease. A sweep runs at start,
//! every hour, when the rules change, and when a thread is deleted; a session that stops sweeps
//! again when a deleted thread's worktree waited for it, or when a sweep was running.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use conn_contract::TerminalSessionStatus;
use conn_engine::{BoxFuture, SqliteEngine};
use conn_terminal::TerminalManager;
use conn_vcs::{
    cleanup::{self, KeepWhen},
    worktree::{Removal, remove_worktree},
};
use serde_json::{Map, Value};

use crate::environment::Environment;

const DAY_MS: i64 = 86_400_000;
/// Settle scripts get this long to open the terminals that protect their worktree.
const SETTLE_SCRIPT_GRACE_MS: i64 = 60_000;
/// `QUEUED_TURN_START_GRACE_MS`: a prompt this new may not have its run yet.
const QUEUED_TURN_START_GRACE_MS: i64 = 2 * 60 * 1_000;
/// `MAX_OVERDUE_ARM_MS`: the recovery worker skips a reset this overdue.
const MAX_OVERDUE_ARM_MS: i64 = 24 * 60 * 60 * 1_000;
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// `WorktreeCleanupRules`, resolved for one project.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rules {
    pub keep_when: KeepWhen,
    pub after_days: Option<i64>,
    pub settled_after_days: Option<i64>,
    pub on_merge: bool,
    pub on_delete: bool,
    pub unchanged: bool,
}

impl Rules {
    /// `worktreeCleanupEnabled`.
    pub fn enabled(&self) -> bool {
        self.after_days.is_some()
            || self.settled_after_days.is_some()
            || self.on_merge
            || self.on_delete
            || self.unchanged
    }

    fn from_object(rules: &Value, keep_when: KeepWhen) -> Self {
        let days = |key: &str, min: i64| rules[key].as_i64().filter(|d| (min..=3650).contains(d));
        Self {
            keep_when: match rules["worktreeKeepWhen"].as_str() {
                Some(text) => KeepWhen::from_setting(Some(text)),
                None => keep_when,
            },
            after_days: days("worktreeAfterDays", 1),
            settled_after_days: days("worktreeSettledAfterDays", 0),
            on_merge: rules["worktreeOnMerge"] == true,
            on_delete: rules["worktreeOnDelete"] == true,
            unchanged: rules["worktreeUnchanged"] == true,
        }
    }
}

/// `resolveWorktreeCleanup`: the project's `worktreeCleanup` override, else the machine-wide
/// one; `custom` uses its rules, `off` turns every rule off, and none uses `storageCleanup`.
pub fn rules(settings: &Map<String, Value>, project_id: Option<&str>) -> Rules {
    let storage = settings.get("storageCleanup").unwrap_or(&Value::Null);
    let keep_when = KeepWhen::from_setting(storage["worktreeKeepWhen"].as_str());
    let project = project_id.and_then(|id| {
        settings
            .get("projectSettingsOverrides")?
            .get(id)?
            .get("worktreeCleanup")
    });
    let policy = project
        .or_else(|| settings.get("worktreeCleanup"))
        .unwrap_or(&Value::Null);
    match policy["mode"].as_str() {
        Some("custom") => Rules::from_object(&policy["rules"], KeepWhen::default()),
        Some("off") => Rules {
            keep_when,
            ..Rules::default()
        },
        _ => Rules::from_object(storage, keep_when),
    }
}

/// `anyWorktreePolicy`: the machine-wide rules or any project's.
fn any_policy(settings: &Map<String, Value>, wanted: impl Fn(&Rules) -> bool) -> bool {
    wanted(&rules(settings, None))
        || settings
            .get("projectSettingsOverrides")
            .and_then(Value::as_object)
            .is_some_and(|projects| projects.keys().any(|id| wanted(&rules(settings, Some(id)))))
}

/// The settings a sweep reads; a change to them starts one.
fn policy_fingerprint(settings: &Map<String, Value>) -> String {
    let projects: Vec<(&String, &Value)> = settings
        .get("projectSettingsOverrides")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, o)| Some((id, o.get("worktreeCleanup")?)))
        .collect();
    serde_json::json!([
        settings.get("storageCleanup"),
        settings.get("worktreeCleanup"),
        projects,
        settings.get("worktreesDirectory"),
        settings.get("previousWorktreesDirectories"),
    ])
    .to_string()
}

/// The usage-limit recovery settings `threadIdle` reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Recovery {
    pub auto_resume: bool,
    pub snooze: bool,
}

impl Recovery {
    fn from_settings(settings: &Map<String, Value>) -> Self {
        Self {
            auto_resume: settings.get("autoResumeLimitedThreads") == Some(&Value::Bool(true)),
            snooze: settings.get("snoozeLimitedThreads") == Some(&Value::Bool(true)),
        }
    }
}

fn millis(value: &Value) -> Option<i64> {
    value.as_str().and_then(conn_support::time::millis_from_iso)
}

fn text(value: &Value) -> Option<&str> {
    value.as_str()
}

/// `threadIdle`: no run, no pending work, no prompt waiting for its run, and no run held for
/// a usage-limit reset.
pub fn thread_idle(thread: &Value, now: i64, recovery: Recovery) -> bool {
    let status = thread["status"].as_str().unwrap_or_default();
    thread["activeRunId"].is_null()
        && matches!(
            status,
            "idle" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back"
        )
        && thread["pendingBackgroundTasks"]
            .as_array()
            .is_none_or(Vec::is_empty)
        && thread["pendingRuntimeRequest"].is_null()
        && !queued_turn_start(thread, now)
        && !held_for_limit_recovery(thread, now, recovery)
}

/// `storageCleanupThreadIdle`: a thread with a worktree that is idle.
pub fn storage_idle(thread: &Value, now: i64, recovery: Recovery) -> bool {
    !thread["worktreePath"].is_null() && thread_idle(thread, now, recovery)
}

/// `threadHasQueuedTurnStart`.
fn queued_turn_start(thread: &Value, now: i64) -> bool {
    let Some(message) = millis(&thread["latestUserMessageAt"]) else {
        return false;
    };
    if thread["status"] == "failed"
        || now.saturating_sub(message).saturating_abs() > QUEUED_TURN_START_GRACE_MS
    {
        return false;
    }
    if thread["latestRunId"].is_null() {
        return true;
    }
    [
        "latestRunRequestedAt",
        "latestRunStartedAt",
        "latestRunCompletedAt",
    ]
    .iter()
    .all(|key| millis(&thread[*key]).is_none_or(|at| at < message))
}

/// `heldForLimitRecovery`: a run held for its usage-limit reset still has its work ahead.
fn held_for_limit_recovery(thread: &Value, now: i64, recovery: Recovery) -> bool {
    let Some(reset_text) = text(&thread["usageLimitResetAt"]) else {
        return false;
    };
    if thread["status"] != "failed"
        || thread["lastErrorClass"] != "usage_limit"
        || !thread["archivedAt"].is_null()
        || thread["settledOverride"] == "settled"
    {
        return false;
    }
    let reset = conn_support::time::millis_from_iso(reset_text);
    let armed = &thread["limitRecovery"];
    if !armed.is_null()
        && armed["runId"] == thread["latestRunId"]
        && armed["resetAt"].as_str() == Some(reset_text)
    {
        // An auto-resume holds until its continuation replaces the failed run.
        return armed["autoResume"] == true
            || (armed["snooze"] == true && reset.is_some_and(|r| r > now));
    }
    let Some(reset) = reset else {
        return false;
    };
    let ended = millis(&thread["latestRunCompletedAt"]).or_else(|| millis(&thread["updatedAt"]));
    if ended.is_some_and(|ended| reset <= ended) || now.saturating_sub(reset) > MAX_OVERDUE_ARM_MS {
        return false;
    }
    recovery.auto_resume || (recovery.snooze && reset > now)
}

/// `storageCleanupActivityAt`: the newest of creation, the last prompt and the last run's
/// times. Pull request refreshes do not count.
pub fn activity_at(thread: &Value) -> i64 {
    [
        "createdAt",
        "latestUserMessageAt",
        "latestRunRequestedAt",
        "latestRunStartedAt",
        "latestRunCompletedAt",
    ]
    .iter()
    .filter_map(|key| millis(&thread[*key]))
    .max()
    .unwrap_or(i64::MIN)
}

/// `worktreeOwner`: the one thread that owns a worktree several threads store. Only a
/// complete chain of subagents or side chats inside this worktree shares ownership.
pub fn worktree_owner<'a>(threads: &[&'a Value]) -> Option<&'a Value> {
    if let [only] = threads {
        return Some(only);
    }
    let by_id: HashMap<&str, &Value> = threads
        .iter()
        .filter_map(|t| Some((t["id"].as_str()?, *t)))
        .collect();
    let parent = |t: &Value| {
        t["lineage"]["parentThreadId"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };
    let tops: Vec<&Value> = threads
        .iter()
        .copied()
        .filter(|t| !by_id.contains_key(parent(t).as_str()))
        .collect();
    let [owner] = tops.as_slice() else {
        return None;
    };
    for thread in threads {
        let mut current: &Value = thread;
        let mut seen: HashSet<&str> = HashSet::new();
        while current["id"] != owner["id"] {
            let lineage = &current["lineage"];
            let id = current["id"].as_str().unwrap_or_default();
            if !seen.insert(id)
                || (lineage["relationshipToParent"] != "subagent" && lineage["sideChat"] != true)
                || lineage["rootThreadId"] != owner["lineage"]["rootThreadId"]
            {
                return None;
            }
            current = by_id.get(parent(current).as_str())?;
        }
    }
    Some(owner)
}

/// `worktreeSettlementChain`: an unsettled subagent follows its idle parents in the same
/// project and tree up to the first settled one. Empty when the chain breaks.
fn settlement_chain<'a>(
    thread: &'a Value,
    by_id: &HashMap<&str, &'a Value>,
    now: i64,
    recovery: Recovery,
) -> Vec<&'a Value> {
    let mut chain = vec![thread];
    let mut current = thread;
    while current["settledAt"].is_null() {
        if current["lineage"]["relationshipToParent"] != "subagent"
            || current["settledOverride"] == "active"
            || !current["pinnedAt"].is_null()
        {
            return Vec::new();
        }
        let parent_id = current["lineage"]["parentThreadId"]
            .as_str()
            .unwrap_or_default();
        let Some(parent) = by_id.get(parent_id).copied() else {
            return Vec::new();
        };
        if chain.iter().any(|m| m["id"] == parent["id"])
            || parent["projectId"] != thread["projectId"]
            || parent["lineage"]["rootThreadId"] != thread["lineage"]["rootThreadId"]
            || !thread_idle(parent, now, recovery)
        {
            return Vec::new();
        }
        chain.push(parent);
        current = parent;
    }
    chain
}

/// A branch's pull request as the merge rule reads it (`GitBranchPullRequest`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullRequestHead {
    /// `open`, `closed` or `merged`.
    pub state: String,
    pub head_ref: String,
    pub base_ref: String,
    pub head_sha: Option<String>,
}

/// The worktree side of [`pull_request_merged`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeTarget {
    pub branch: String,
    pub default_branch: String,
    pub head_sha: String,
    /// The checkout's `HEAD` is already on the default branch.
    pub integrated: bool,
}

/// `storageCleanupPullRequestMerged`: a merged pull request whose head reached the default
/// branch, or (for squash and rebase merges) one that names this exact head commit.
pub fn pull_request_merged(pull_request: Option<&PullRequestHead>, worktree: &MergeTarget) -> bool {
    pull_request.is_some_and(|pr| {
        pr.state == "merged"
            && (worktree.integrated
                || (pr.head_ref == worktree.branch
                    && pr.base_ref == worktree.default_branch
                    && pr.head_sha.as_deref() == Some(worktree.head_sha.as_str())))
    })
}

/// Finds a branch's pull request with a fresh read from its host (`branchPullRequest` with
/// `refresh`).
pub trait MergeLookup: Send + Sync {
    fn branch_pull_request<'a>(
        &'a self,
        project_id: &'a str,
        cwd: &'a Path,
        branch: &'a str,
    ) -> BoxFuture<'a, Option<PullRequestHead>>;
}

/// What one sweep did with one worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Removed,
    Kept,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub outcome: Outcome,
    /// T3's report text, starting with a capital.
    pub reason: String,
    pub path: PathBuf,
    pub thread_id: String,
}

fn sentence(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Removes managed worktrees by the cleanup rules. Cheap to clone.
#[derive(Clone)]
pub struct WorktreeCleanup {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for WorktreeCleanup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorktreeCleanup").finish_non_exhaustive()
    }
}

struct Inner {
    engine: Arc<SqliteEngine>,
    environment: Arc<Environment>,
    terminals: TerminalManager,
    merges: Option<Arc<dyn MergeLookup>>,
    wake: tokio::sync::Notify,
    /// A deleted thread's worktree waits for a session or terminal to stop.
    waiting: AtomicBool,
    /// One sweep at a time; a request during a sweep runs one more.
    sweeping: tokio::sync::Mutex<()>,
    /// The server is stopping: no removal starts.
    stopping: AtomicBool,
    /// A test holds the next removal here, after its final read under the lease.
    #[cfg(test)]
    pause: std::sync::Mutex<Option<Pause>>,
}

/// Where a test holds a removal: `reached` fires after the final read, and the removal goes on
/// at `resume`.
#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct Pause {
    pub reached: Arc<tokio::sync::Notify>,
    pub resume: Arc<tokio::sync::Notify>,
}

/// The threads of one pass, and lookups built from them.
struct Pass {
    threads: Vec<Value>,
    deleted: Vec<Value>,
    projects: Vec<Value>,
}

impl WorktreeCleanup {
    pub fn new(
        engine: Arc<SqliteEngine>,
        environment: Arc<Environment>,
        terminals: TerminalManager,
        merges: Option<Arc<dyn MergeLookup>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                engine,
                environment,
                terminals,
                merges,
                wake: tokio::sync::Notify::new(),
                waiting: AtomicBool::new(true),
                sweeping: tokio::sync::Mutex::new(()),
                stopping: AtomicBool::new(false),
                #[cfg(test)]
                pause: std::sync::Mutex::new(None),
            }),
        }
    }

    /// Holds the next removal after its final read, until the test resumes it.
    #[cfg(test)]
    pub(crate) fn pause_after_final_check(&self) -> Pause {
        let pause = Pause::default();
        *self.inner.pause.lock().unwrap_or_else(|e| e.into_inner()) = Some(pause.clone());
        pause
    }

    /// A sweep was asked for and has not started.
    #[cfg(test)]
    pub(crate) async fn wake_pending(&self) -> bool {
        tokio::time::timeout(Duration::ZERO, self.inner.wake.notified())
            .await
            .is_ok()
    }

    /// Sweeps at start, every hour, and on each [`Self::request`], until [`Running::stop`].
    pub fn start(&self) -> Running {
        let this = self.clone();
        let worker = tokio::spawn(async move {
            while !this.stopping() {
                this.sweep().await;
                tokio::select! {
                    () = this.inner.wake.notified() => {}
                    () = tokio::time::sleep(SWEEP_INTERVAL) => {}
                }
            }
        });
        let this = self.clone();
        let mut changes = self.inner.environment.settings.subscribe();
        let watcher = tokio::spawn(async move {
            let mut last = policy_fingerprint(&this.inner.environment.settings.raw());
            while changes.changed().await.is_ok() {
                let next = policy_fingerprint(&this.inner.environment.settings.raw());
                if next != last {
                    last = next;
                    this.request();
                }
            }
        });
        Running {
            cleanup: self.clone(),
            worker,
            watcher,
        }
    }

    fn stopping(&self) -> bool {
        self.inner.stopping.load(Ordering::SeqCst)
    }

    /// Asks for a sweep; requests during a sweep make one more.
    pub fn request(&self) {
        self.inner.wake.notify_one();
    }

    /// A deleted thread: its worktree may go now (`thread.deleted`).
    pub fn thread_deleted(&self) {
        self.request();
    }

    /// A provider session stopped: a deleted thread's worktree that waited for it may go. A
    /// sweep under way may have passed that worktree already, so it runs again too.
    pub fn session_closed(&self) {
        let sweeping = self.inner.sweeping.try_lock().is_err();
        if (sweeping || self.inner.waiting.load(Ordering::Relaxed))
            && any_policy(&self.inner.environment.settings.raw(), |r| r.on_delete)
        {
            self.request();
        }
    }

    /// One pass over every worktree a thread stores. What it did, for logs and tests.
    pub async fn sweep(&self) -> Vec<Entry> {
        let _one = self.inner.sweeping.lock().await;
        let settings = self.inner.environment.settings.raw();
        if self.stopping() {
            return Vec::new();
        }
        if !any_policy(&settings, Rules::enabled) {
            self.inner.waiting.store(false, Ordering::Relaxed);
            return Vec::new();
        }
        let pass = match self.inner.engine.cleanup_threads().await {
            Ok(found) => Pass {
                threads: found.threads,
                deleted: found.deleted,
                projects: found.projects,
            },
            Err(error) => {
                eprintln!("conn-server: worktree cleanup: {error}");
                return Vec::new();
            }
        };
        let mut sweep = Sweep {
            inner: &self.inner,
            settings,
            now: i64::try_from(self.inner.engine.now_millis()).unwrap_or(i64::MAX),
            roots: managed_roots(&self.inner.environment).await,
            entries: Vec::new(),
            waiting: false,
            default_branches: HashMap::new(),
            fetched: HashSet::new(),
        };
        sweep.run(&pass).await;
        self.inner.waiting.store(sweep.waiting, Ordering::Relaxed);
        for entry in &sweep.entries {
            if entry.outcome != Outcome::Kept {
                eprintln!(
                    "conn-server: worktree cleanup {:?} {} (thread {}): {}",
                    entry.outcome,
                    entry.path.display(),
                    entry.thread_id,
                    entry.reason
                );
            }
        }
        sweep.entries
    }
}

/// The tracking side of [`Running::stop`]: the sweep worker and the settings watcher.
#[derive(Debug)]
#[must_use = "the server stops cleanup before it drains terminals and sessions"]
pub struct Running {
    cleanup: WorktreeCleanup,
    worker: tokio::task::JoinHandle<()>,
    watcher: tokio::task::JoinHandle<()>,
}

impl Running {
    /// Starts no new removal, lets one under way finish, and joins both tasks.
    pub async fn stop(self) {
        self.cleanup.inner.stopping.store(true, Ordering::SeqCst);
        self.cleanup.request();
        self.watcher.abort();
        let _ = self.watcher.await;
        let _ = self.worker.await;
    }
}

/// `managedWorktreesDirectories`: `<state>/worktrees`, the `worktreesDirectory` setting and
/// the folders it named before, as real paths; never a filesystem root. A dev home is seeded
/// from real data, so its settings can name the developer's real folders: it manages only its
/// own `worktrees` folder.
async fn managed_roots(environment: &Environment) -> Vec<PathBuf> {
    let mut folders = crate::host::managed_worktree_dirs(environment);
    let state_dir = environment.state_dir.clone();
    blocking(move || {
        if in_dev_home(&state_dir) {
            folders.truncate(1);
        }
        let mut roots: Vec<PathBuf> = Vec::new();
        for folder in folders {
            if let Ok(real) = std::fs::canonicalize(&folder)
                && real.parent().is_some()
                && !roots.contains(&real)
            {
                roots.push(real);
            }
        }
        roots
    })
    .await
    .unwrap_or_default()
}

/// `resolveWorktreeT3Home`: the state folder lies in `<linked git worktree>/.conn`. Blocking.
fn in_dev_home(state_dir: &Path) -> bool {
    let start = canonical(state_dir);
    let Some(checkout) = start.ancestors().find(|dir| dir.join(".git").exists()) else {
        return false;
    };
    let linked = std::fs::read_to_string(checkout.join(".git")).is_ok_and(|text| {
        text.lines()
            .find_map(|line| line.trim().strip_prefix("gitdir:"))
            .map(|dir| Path::new(dir.trim()))
            .and_then(|dir| dir.parent()?.file_name())
            .is_some_and(|name| name == "worktrees")
    });
    linked && start.starts_with(checkout.join(".conn"))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(work).await.ok()
}

/// `realPath` with the stored spelling as the fallback (a missing folder cannot resolve).
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned())
}

/// `path` is `root` or below it.
fn within(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// A keep decision and whether a session or terminal stop can clear it (`waitForStop`).
struct Keep {
    reason: String,
    clears_on_stop: bool,
}

impl Keep {
    fn because(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            clears_on_stop: false,
        }
    }

    fn until_stop(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            clears_on_stop: true,
        }
    }
}

struct Sweep<'a> {
    inner: &'a Inner,
    settings: Map<String, Value>,
    now: i64,
    roots: Vec<PathBuf>,
    entries: Vec<Entry>,
    waiting: bool,
    /// The default branch per project root and remote, read once per sweep.
    default_branches: HashMap<(PathBuf, String), Option<String>>,
    /// Remote-tracking refs fetched once per sweep.
    fetched: HashSet<(PathBuf, String)>,
}

/// One worktree and the threads that store it.
struct Candidate<'a> {
    thread: &'a Value,
    deleted: bool,
    path: PathBuf,
    key: PathBuf,
    group: Vec<&'a Value>,
}

impl Candidate<'_> {
    /// Any of `folders` is at or below the worktree, by its stored or real spelling. A folder
    /// that is gone cannot resolve, so the stored spellings are compared too.
    async fn occupied_by(&self, folders: Vec<PathBuf>) -> bool {
        if folders.is_empty() {
            return false;
        }
        let spellings = [self.path.clone(), self.key.clone()];
        blocking(move || {
            folders.iter().any(|folder| {
                let real = canonical(folder);
                spellings
                    .iter()
                    .any(|root| within(root, folder) || within(root, &real))
            })
        })
        .await
        .unwrap_or(true)
    }
}

impl Sweep<'_> {
    async fn run(&mut self, pass: &Pass) {
        let recovery = Recovery::from_settings(&self.settings);
        // Threads can store one checkout through different symlinked spellings.
        let stored: Vec<PathBuf> = pass
            .threads
            .iter()
            .chain(&pass.deleted)
            .map(|t| PathBuf::from(t["worktreePath"].as_str().unwrap_or_default()))
            .collect();
        let keys = blocking(move || stored.iter().map(|p| canonical(p)).collect::<Vec<_>>())
            .await
            .unwrap_or_default();
        let (live_keys, deleted_keys) = keys.split_at(pass.threads.len().min(keys.len()));
        // Groups keep the order threads were read in, as T3's `Map.groupBy`.
        let mut groups: Vec<(PathBuf, Vec<&Value>)> = Vec::new();
        let mut group_of: HashMap<&PathBuf, usize> = HashMap::new();
        for (thread, key) in pass.threads.iter().zip(live_keys) {
            if thread["worktreePath"].as_str().is_none() {
                continue;
            }
            match group_of.get(key) {
                Some(&index) => {
                    if let Some((_, group)) = groups.get_mut(index) {
                        group.push(thread);
                    }
                }
                None => {
                    group_of.insert(key, groups.len());
                    groups.push((key.clone(), vec![thread]));
                }
            }
        }
        let mut deleted_by_key: HashMap<&PathBuf, Vec<&Value>> = HashMap::new();
        for (thread, key) in pass.deleted.iter().zip(deleted_keys) {
            deleted_by_key.entry(key).or_default().push(thread);
        }
        let settings = self.settings.clone();
        let rules_for = |thread: &Value| rules(&settings, thread["projectId"].as_str());
        let mut candidates: Vec<Candidate<'_>> = Vec::new();
        for (key, group) in &groups {
            // A deleted thread still owns the worktree its remaining subagents share, but only
            // deletion cleanup acts on it; otherwise the live rules apply.
            let deleted_owner = deleted_by_key.get(key).into_iter().flatten().find(|d| {
                let mut members = vec![**d];
                members.extend(group.iter().copied());
                rules_for(d).on_delete
                    && worktree_owner(&members).is_some_and(|o| o["id"] == d["id"])
            });
            let (thread, deleted) = match deleted_owner {
                Some(d) => (*d, true),
                None => match worktree_owner(group).or_else(|| group.first().copied()) {
                    Some(owner) => (owner, false),
                    None => continue,
                },
            };
            candidates.push(Candidate {
                thread,
                deleted,
                path: PathBuf::from(thread["worktreePath"].as_str().unwrap_or_default()),
                key: key.clone(),
                group: group.clone(),
            });
        }
        for (thread, key) in pass.deleted.iter().zip(deleted_keys) {
            if !group_of.contains_key(key) {
                candidates.push(Candidate {
                    thread,
                    deleted: true,
                    path: PathBuf::from(thread["worktreePath"].as_str().unwrap_or_default()),
                    key: key.clone(),
                    group: Vec::new(),
                });
            }
        }
        let by_id: HashMap<&str, &Value> = pass
            .threads
            .iter()
            .filter_map(|t| Some((t["id"].as_str()?, t)))
            .collect();
        for candidate in &candidates {
            if self.inner.stopping.load(Ordering::SeqCst) {
                break;
            }
            let rules = rules_for(candidate.thread);
            if !rules.enabled() {
                continue;
            }
            let exists = {
                let path = candidate.path.clone();
                blocking(move || path.exists()).await.unwrap_or(false)
            };
            if !exists {
                continue;
            }
            let outcome = self
                .evaluate(candidate, rules, pass, &by_id, recovery)
                .await;
            let (outcome, reason) = match outcome {
                Ok(Ok(removed)) => (Outcome::Removed, removed),
                Ok(Err(keep)) => {
                    if keep.clears_on_stop && candidate.deleted && rules.on_delete {
                        self.waiting = true;
                    }
                    (Outcome::Kept, keep.reason)
                }
                Err(failure) => (Outcome::Failed, failure),
            };
            self.entries.push(Entry {
                outcome,
                reason: sentence(&reason),
                path: candidate.path.clone(),
                thread_id: candidate.thread["id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            });
        }
    }

    /// `Ok(Ok(reason))` when removed, `Ok(Err(keep))` when kept, `Err` when a step failed.
    async fn evaluate(
        &mut self,
        c: &Candidate<'_>,
        rules: Rules,
        pass: &Pass,
        by_id: &HashMap<&str, &Value>,
        recovery: Recovery,
    ) -> Result<Result<String, Keep>, String> {
        let thread = c.thread;
        let now = self.now;
        if c.deleted && !rules.on_delete {
            return Ok(Err(Keep::because("no rules apply")));
        }
        let mut members: Vec<&Value> = Vec::new();
        if c.deleted {
            members.push(thread);
        }
        members.extend(c.group.iter().copied());
        if members.len() > 1 && worktree_owner(&members).is_none() {
            return Ok(Err(Keep::because(format!(
                "shared by {} threads",
                members.len()
            ))));
        }
        let project_root = if c.deleted {
            thread["workspaceRoot"].as_str().map(PathBuf::from)
        } else {
            pass.projects
                .iter()
                .find(|p| p["id"] == thread["projectId"])
                .and_then(|p| p["workspaceRoot"].as_str())
                .map(PathBuf::from)
        };
        let Some(project_root) = project_root else {
            return Ok(Err(Keep::because("project is unavailable")));
        };
        if !c.group.iter().all(|m| storage_idle(m, now, recovery)) {
            return Ok(Err(Keep::until_stop(
                "thread is running or has pending work",
            )));
        }
        let Some(branch) = thread["branch"].as_str() else {
            return Ok(Err(Keep::because("thread has no branch")));
        };
        if c.group.iter().any(|m| m["branch"].as_str() != Some(branch)) {
            return Ok(Err(Keep::because(
                "a subagent thread's branch differs from this worktree's branch",
            )));
        }
        if self.has_terminal(c).await {
            return Ok(Err(Keep::until_stop("open terminal")));
        }
        let activity = c
            .group
            .iter()
            .map(|m| activity_at(m))
            .max()
            .unwrap_or(i64::MIN);
        let chain = if c.deleted {
            Vec::new()
        } else {
            settlement_chain(thread, by_id, now, recovery)
        };
        let settled_moments_ago = c.group.iter().chain(chain.iter().skip(1)).any(|m| {
            !m["settledAt"].is_null()
                && now.saturating_sub(millis(&m["updatedAt"]).unwrap_or(i64::MIN).max(activity))
                    < SETTLE_SCRIPT_GRACE_MS
        });
        if settled_moments_ago {
            return Ok(Err(Keep::until_stop("settled moments ago")));
        }
        // A deleted thread alone in its worktree has no activity time; the times saturate.
        let idle_days = now.saturating_sub(activity) / DAY_MS;
        let old = !c.deleted
            && rules
                .after_days
                .is_some_and(|d| activity < now.saturating_sub(d.saturating_mul(DAY_MS)));
        let settled_thread = chain.last().copied();
        let settled_for = settled_thread
            .and_then(|t| millis(&t["settledAt"]))
            .map(|at| now.saturating_sub(at.max(activity)));
        let settled_days = settled_for.map(|f| f / DAY_MS);
        let settled = settled_for
            .zip(rules.settled_after_days)
            .is_some_and(|(f, d)| f >= d.saturating_mul(DAY_MS));
        // A worktree is unchanged before its first commit, so only finished threads qualify.
        let unchanged_applies =
            rules.unchanged && (settled_thread.is_some() || !thread["archivedAt"].is_null());
        let mut eligible = c.deleted || old || settled;
        let mut removal = if c.deleted {
            "thread was deleted".to_owned()
        } else if old {
            format!("inactive for {idle_days} days")
        } else {
            format!("settled for {} days", settled_days.unwrap_or_default())
        };
        let not_due = if let (false, Some(days)) = (c.deleted, rules.after_days) {
            format!("inactive for {idle_days} of {days} days")
        } else if let Some(days) = rules.settled_after_days {
            match settled_days {
                None => "not settled".to_owned(),
                Some(settled) => format!("settled for {settled} of {days} days"),
            }
        } else if rules.on_merge {
            "not merged".to_owned()
        } else if unchanged_applies {
            "has commits beyond the default branch".to_owned()
        } else if rules.unchanged {
            "not settled".to_owned()
        } else {
            "no rules apply".to_owned()
        };
        // Only Git-based rules can make a worktree that is not due eligible.
        if !eligible && !unchanged_applies && !rules.on_merge {
            return Ok(Err(Keep::because(not_due)));
        }
        if let Some(reason) = self.path_reason(&c.path).await {
            return Ok(Err(Keep::because(reason)));
        }
        if contains_project_root(c, &pass.projects, &project_root).await {
            return Ok(Err(Keep::because("contains a project checkout")));
        }
        let failed = |e: conn_vcs::VcsError| e.to_string();
        if cleanup::branch_changed(&c.path, Some(branch))
            .await
            .map_err(failed)?
        {
            return Ok(Err(Keep::because("repository or branch changed")));
        }
        if let Some(changes) = cleanup::local_changes(&c.path, rules.keep_when)
            .await
            .map_err(failed)?
        {
            return Ok(Err(Keep::because(changes)));
        }
        let head = cleanup::commit_of(&c.path, "HEAD")
            .await
            .map_err(failed)?
            .ok_or("HEAD does not name a commit")?;
        if !eligible {
            match self
                .git_rules(c, rules, &project_root, branch, &head, unchanged_applies)
                .await
                .map_err(failed)?
            {
                GitRule::Removed(reason) => {
                    eligible = true;
                    removal = reason;
                }
                GitRule::Keep(reason) => return Ok(Err(Keep::because(reason))),
                GitRule::NotDue => {}
            }
        }
        if !eligible {
            return Ok(Err(Keep::because(not_due)));
        }
        if let Some(keep) = self.blocked_since_check(c, &project_root, &chain).await? {
            return Ok(Err(keep));
        }
        // A first walk before the lease keeps most refusals off the lease turn starts wait on.
        if let Some(reason) = nested_reason(&c.path).await.map_err(failed)? {
            return Ok(Err(Keep::because(reason)));
        }
        let path_text = c.path.to_string_lossy().into_owned();
        let Some(locks) = self.inner.engine.workspace_locks() else {
            return Ok(Err(Keep::because("checkout lease is unavailable")));
        };
        let _lease = locks.workspace(&path_text).await;
        if self.inner.stopping.load(Ordering::SeqCst) {
            return Ok(Err(Keep::because("server is stopping")));
        }
        if let Some(reason) = self.path_reason(&c.path).await {
            return Ok(Err(Keep::because(reason)));
        }
        if let Some(keep) = self.blocked_since_check(c, &project_root, &chain).await? {
            return Ok(Err(keep));
        }
        #[cfg(test)]
        self.inner.paused().await;
        if cleanup::branch_changed(&c.path, Some(branch))
            .await
            .map_err(failed)?
        {
            return Ok(Err(Keep::because(
                "repository or branch changed since check",
            )));
        }
        let now_head = cleanup::commit_of(&c.path, "HEAD").await.map_err(failed)?;
        if now_head.as_deref() != Some(head.as_str()) {
            return Ok(Err(Keep::because("commit changed since check")));
        }
        if let Some(changes) = cleanup::local_changes(&c.path, rules.keep_when)
            .await
            .map_err(failed)?
        {
            return Ok(Err(Keep::because(changes)));
        }
        let current = self.inner.environment.settings.raw();
        if self::rules(&current, thread["projectId"].as_str()) != rules
            || Recovery::from_settings(&current) != recovery
        {
            return Ok(Err(Keep::because("settings changed since check")));
        }
        // Git refuses a locked worktree; find it before anything changes a file.
        if cleanup::is_locked(&c.path).await.map_err(failed)? {
            return Ok(Err(Keep::because("worktree is locked")));
        }
        let repository = cleanup::owning_repository(&c.path).await.map_err(failed)?;
        if cleanup::head_log_holds_lost_commits(&c.path, &repository)
            .await
            .map_err(failed)?
        {
            return Ok(Err(Keep::because(
                "has commits that only its HEAD log holds",
            )));
        }
        // A repository made while cleanup waited for the lease would go with the folder.
        if let Some(reason) = nested_reason(&c.path).await.map_err(failed)? {
            return Ok(Err(Keep::because(reason)));
        }
        let submodules = cleanup::submodule_removal(&c.path, rules.keep_when).await;
        if let Some(reason) = submodules.reason {
            return Ok(Err(Keep::because(reason)));
        }
        if submodules.force
            && let Some(changes) = cleanup::local_changes(&c.path, rules.keep_when)
                .await
                .map_err(failed)?
        {
            return Ok(Err(Keep::because(changes)));
        }
        // Git requires force for submodules, and for the untracked and ignored files that
        // tracked-changes mode lets go. One `--force` never removes a locked worktree.
        let removal_mode = if submodules.force || rules.keep_when == KeepWhen::TrackedChanges {
            Removal::Force
        } else {
            Removal::Safe
        };
        remove_worktree(&repository, &c.path, removal_mode)
            .await
            .map_err(failed)?;
        Ok(Ok(removal))
    }

    /// `worktreePathReason`: never a symlinked worktree folder, never outside the managed
    /// folders, only a linked worktree.
    async fn path_reason(&self, path: &Path) -> Option<&'static str> {
        let (owned, roots) = (path.to_owned(), self.roots.clone());
        let reason = blocking(move || {
            let real = std::fs::canonicalize(&owned).ok()?;
            let parent = owned.parent().and_then(|p| std::fs::canonicalize(p).ok())?;
            if Some(real.as_path()) != owned.file_name().map(|n| parent.join(n)).as_deref() {
                return Some("worktree is a symbolic link");
            }
            if !roots
                .iter()
                .any(|root| real.starts_with(root) && real != *root)
            {
                return Some("outside the managed worktree folder");
            }
            None
        })
        .await
        .unwrap_or(Some("worktree could not be fully inspected"));
        if reason.is_some() {
            return reason;
        }
        if !cleanup::is_linked_worktree(path).await {
            return Some("not a linked worktree");
        }
        None
    }

    /// A starting or running terminal works in the worktree.
    async fn has_terminal(&self, c: &Candidate<'_>) -> bool {
        let folders: Vec<PathBuf> = self
            .inner
            .terminals
            .list()
            .into_iter()
            .filter(|t| {
                matches!(
                    t.status,
                    TerminalSessionStatus::Starting | TerminalSessionStatus::Running
                )
            })
            .flat_map(|t| t.worktree_path.into_iter().chain([t.cwd]))
            .map(PathBuf::from)
            .collect();
        c.occupied_by(folders).await
    }

    /// The unchanged and merge rules, which read Git.
    async fn git_rules(
        &mut self,
        c: &Candidate<'_>,
        rules: Rules,
        root: &Path,
        branch: &str,
        head: &str,
        unchanged_applies: bool,
    ) -> conn_vcs::VcsResult<GitRule> {
        let remote = conn_vcs::repo::primary_remote(root).await?;
        let (default_branch, default_ref) = match &remote {
            None => {
                if !unchanged_applies {
                    return Ok(if rules.unchanged {
                        GitRule::NotDue
                    } else {
                        GitRule::Keep("no remote is configured for merged-worktree cleanup")
                    });
                }
                let Some(project_ref) = cleanup::project_branch_ref(root).await? else {
                    return Ok(GitRule::Keep("project branch is unavailable"));
                };
                let name = project_ref
                    .strip_prefix("refs/heads/")
                    .unwrap_or(&project_ref)
                    .to_owned();
                (name, project_ref)
            }
            Some(remote) => {
                let key = (root.to_owned(), remote.clone());
                let default = match self.default_branches.get(&key) {
                    Some(found) => found.clone(),
                    None => {
                        let found = cleanup::remote_default_branch(root, remote).await?;
                        self.default_branches.insert(key, found.clone());
                        found
                    }
                };
                let Some(default) = default else {
                    return Ok(GitRule::Keep("default branch is unavailable"));
                };
                let tracking = format!("refs/remotes/{remote}/{default}");
                let key = (root.to_owned(), tracking.clone());
                if !self.fetched.contains(&key) {
                    cleanup::fetch_tracking_branch(root, remote, &default).await?;
                    self.fetched.insert(key);
                }
                (default, tracking)
            }
        };
        let Some(base) = cleanup::commit_of(&c.path, &default_ref).await? else {
            return Ok(GitRule::Keep("default branch is unavailable"));
        };
        let integrated = cleanup::is_ancestor(&c.path, head, &base).await?;
        if integrated && unchanged_applies {
            return Ok(GitRule::Removed(
                if remote.is_none() {
                    "no commits beyond the project branch"
                } else {
                    "no commits beyond the default branch"
                }
                .into(),
            ));
        }
        if remote.is_some()
            && rules.on_merge
            && let Some(lookup) = &self.inner.merges
        {
            let project_id = c.thread["projectId"].as_str().unwrap_or_default();
            let pull_request = lookup
                .branch_pull_request(project_id, &c.path, branch)
                .await;
            let target = MergeTarget {
                branch: branch.to_owned(),
                default_branch,
                head_sha: head.to_owned(),
                integrated,
            };
            if pull_request_merged(pull_request.as_ref(), &target) {
                return Ok(GitRule::Removed("pull request was merged".into()));
            }
        }
        if remote.is_none() {
            return Ok(if integrated {
                GitRule::NotDue
            } else {
                GitRule::Keep("has commits beyond the project branch")
            });
        }
        Ok(GitRule::NotDue)
    }

    /// `blockedSinceCheck`: read this worktree's threads and sessions again, so activity since
    /// the first check cancels the removal.
    async fn blocked_since_check(
        &self,
        c: &Candidate<'_>,
        project_root: &Path,
        chain: &[&Value],
    ) -> Result<Option<Keep>, String> {
        // T3 reads every binding, then only this worktree's shells.
        let (bindings, projects) = self.inner.engine.worktree_bindings().await?;
        if contains_project_root(c, &projects, project_root).await {
            return Ok(Some(Keep::because("contains a project checkout")));
        }
        let key = c.key.clone();
        let ids = blocking(move || {
            bindings
                .into_iter()
                .filter(|(_, path)| canonical(Path::new(path)) == key)
                .map(|(id, _)| id)
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let mut wanted = ids.clone();
        // The settlement chain's parents are read again too.
        wanted.extend(
            chain
                .iter()
                .skip(1)
                .filter_map(|t| t["id"].as_str().map(str::to_owned)),
        );
        let fresh = self.inner.engine.cleanup_shells(wanted).await?;
        let latest: Vec<&Value> = fresh
            .iter()
            .filter(|t| {
                t["id"]
                    .as_str()
                    .is_some_and(|id| ids.iter().any(|i| i == id))
            })
            .collect();
        if self.has_terminal(c).await {
            return Ok(Some(Keep::until_stop("open terminal")));
        }
        let thread = c.thread;
        if c.deleted && !rules_for_now(&self.inner.environment, thread).on_delete {
            return Ok(Some(Keep::because(
                "thread or cleanup settings changed since check",
            )));
        }
        let recovery = Recovery::from_settings(&self.settings);
        let mut owners: Vec<&Value> = Vec::new();
        if c.deleted {
            owners.push(thread);
        }
        owners.extend(latest.iter().copied());
        let owner = worktree_owner(&owners);
        let changed = latest.len() != c.group.len()
            || owner.is_none_or(|o| o["id"] != thread["id"] || o["branch"] != thread["branch"])
            || latest.iter().any(|shell| {
                let Some(previous) = c.group.iter().find(|m| m["id"] == shell["id"]) else {
                    return true;
                };
                shell["branch"] != thread["branch"]
                    || shell["settledAt"] != previous["settledAt"]
                    || (!shell["settledAt"].is_null()
                        && shell["updatedAt"] != previous["updatedAt"])
                    || !storage_idle(shell, self.now, recovery)
                    || activity_at(shell) != activity_at(previous)
            });
        if changed {
            return Ok(Some(Keep::until_stop(
                "thread activity or shared worktree changed since check",
            )));
        }
        if chain.len() > 1 {
            let by_id: HashMap<&str, &Value> = fresh
                .iter()
                .filter_map(|t| Some((t["id"].as_str()?, t)))
                .collect();
            let now_chain = by_id
                .get(thread["id"].as_str().unwrap_or_default())
                .map(|t| settlement_chain(t, &by_id, self.now, recovery))
                .unwrap_or_default();
            let (before, after) = (chain.last(), now_chain.last());
            let same = match (before, after) {
                (Some(b), Some(a)) => {
                    b["id"] == a["id"]
                        && b["settledAt"] == a["settledAt"]
                        && b["updatedAt"] == a["updatedAt"]
                }
                _ => false,
            };
            if !same {
                return Ok(Some(Keep::because("parent settlement changed since check")));
            }
        }
        // Sessions can outlive their run and be shared across threads.
        let sessions = self.inner.engine.open_session_cwds().await?;
        if c.occupied_by(sessions.into_iter().map(PathBuf::from).collect())
            .await
        {
            return Ok(Some(Keep::until_stop("provider session is still open")));
        }
        Ok(None)
    }
}

#[cfg(test)]
impl Inner {
    async fn paused(&self) {
        let pause = self.pause.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(pause) = pause {
            pause.reached.notify_one();
            pause.resume.notified().await;
        }
    }
}

fn rules_for_now(environment: &Environment, thread: &Value) -> Rules {
    rules(&environment.settings.raw(), thread["projectId"].as_str())
}

enum GitRule {
    Removed(String),
    Keep(&'static str),
    NotDue,
}

/// The part of `measureWorktree` that guards removal: a repository below the worktree that is
/// not a registered submodule ([`cleanup::nested_repository`]).
async fn nested_reason(path: &Path) -> conn_vcs::VcsResult<Option<&'static str>> {
    const INCOMPLETE: &str = "worktree could not be fully inspected";
    let Some(submodules) = cleanup::submodule_paths(path).await? else {
        return Ok(Some(INCOMPLETE));
    };
    let path = path.to_owned();
    Ok(
        blocking(move || cleanup::nested_repository(&path, &submodules))
            .await
            .unwrap_or(Some(INCOMPLETE)),
    )
}

/// `containsProjectRoot`: a project checkout at or below the worktree.
async fn contains_project_root(c: &Candidate<'_>, projects: &[Value], own: &Path) -> bool {
    let mut roots: Vec<PathBuf> = vec![own.to_owned()];
    roots.extend(
        projects
            .iter()
            .filter_map(|p| p["workspaceRoot"].as_str())
            .map(PathBuf::from),
    );
    let spellings = [c.path.clone(), c.key.clone()];
    blocking(move || {
        roots.iter().any(|root| {
            let real = canonical(root);
            spellings
                .iter()
                .any(|w| within(w, root) || within(w, &real))
        })
    })
    .await
    .unwrap_or(true)
}

#[cfg(test)]
#[path = "worktree_cleanup_tests.rs"]
mod tests;
