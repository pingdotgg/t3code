//! [`SqliteEngine`]: the [`Engine`] on top of the SQLite store.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use conn_contract::{
    Command, DispatchCommandError, DispatchCommandResult, GetShellSnapshotError,
    GetThreadProjectionError, ShellStreamItem, SubscribeShellInput, SubscribeThreadInput, ThreadId,
    ThreadStreamItem, from_json, to_json,
};
use conn_provider::Provider;
use conn_vcs::setup::MissingBase;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::commands::{self, CommandError, Effect};
use crate::runner::LiveThread;
use crate::store::{Receipt, ReceiptKey, ReceiptOwner, Store, StoreResult, StoredOwner, Tx};
use crate::{BoxFuture, Engine, EngineError, Subscription, streams};

/// A folder the engine offers as a project at start. Clients add more at runtime.
#[derive(Clone, Debug)]
pub struct ProjectConfig {
    pub title: String,
    pub workspace_root: String,
}

/// T3's `DEFAULT_IDLE_TIMEOUT_MS`.
pub const DEFAULT_IDLE_SESSION: Duration = Duration::from_secs(30 * 60);

pub struct EngineConfig {
    /// The SQLite file. Created when missing.
    pub database: PathBuf,
    /// Where managed folders live: `scratch/` (No project) and `projects/` (`projects.createNew`).
    /// Defaults to the database's folder.
    pub home: Option<PathBuf>,
    pub projects: Vec<ProjectConfig>,
    pub providers: Vec<Arc<dyn Provider>>,
    /// The server's shared, changing list of instances. When set, it replaces `providers`.
    pub provider_set: Option<conn_provider::ProviderSet>,
    /// A provider session with no turn for this long is closed, ending its process (a
    /// `claude` child holds about 140 MiB). Default 30 minutes, as T3's session manager;
    /// `None` keeps sessions open.
    pub idle_session: Option<Duration>,
    /// How long background work (a background subagent) may keep an idle session open past
    /// `idle_session`. Default 4 hours, as T3.
    pub idle_max_hold: Duration,
    /// How long shutdown lets an admitted launch commit or clean up after it cancels the
    /// launch's preparation. A launch still running then is left; the next start removes the
    /// worktree it made. Default 10 seconds.
    pub launch_grace: Duration,
    /// The server's services: agent tools, attachments, worktrees, thread close.
    pub host: Option<Arc<dyn crate::EngineHost>>,
    /// Generates thread titles. Without one, a new thread keeps the title the client sent.
    pub title_generator: Option<Arc<dyn crate::TitleGenerator>>,
    /// Sees every turn start and end. None by default.
    pub turn_observer: Option<Arc<dyn crate::TurnObserver>>,
    /// Captures a git checkpoint of the thread's workspace at each turn, as the T3 server
    /// does (`checkpoint.rs`). Off by default; the server turns it on.
    pub checkpoints: bool,
    /// Laid over every turn's runtime policy, as T3's `RuntimePolicy.layerWithOverride`. The
    /// server sets none; the T3 fixture replay sets the fixture's policy.
    pub runtime_policy_override: Option<RuntimePolicyOverride>,
    /// Sees every live command output chunk as `(turn item id, chunk)`, as T3's test kit taps
    /// `CommandOutputHub.append`. The server sets none.
    pub command_output_tap: Option<CommandOutputTap>,
    /// Every stored timestamp and the idle release read it. Default: the system clock. A
    /// replay sets a [`crate::ManualClock`], as T3's tests run on Effect's `TestClock`.
    pub clock: Arc<dyn crate::Clock>,
    /// The zone a command time without one is read in, as V8 reads the host's zone once at
    /// start. Default: the system's.
    pub zone: jiff::tz::TimeZone,
    /// Recover the runs and rollbacks a previous process left active (`restart.rs`), as the
    /// T3 server does at start. Default on. Off for an inert rehearsal copy
    /// (`CONN_SERVER_INERT`): its runs stay as imported, so nothing continues or touches a
    /// workspace the original still owns. The server holds the effects they replay until
    /// `/mcp` listens ([`Self::hold_effects`]).
    pub recover_runs: bool,
    /// Write attention events for iOS push to the outbox (`attention.rs`). Off by default:
    /// with it off, nothing is written. The server's sender drains them.
    pub attention: bool,
    /// Effects wait in the outbox until [`SqliteEngine::start_effects`]: a server whose host
    /// services start after the engine sets it, so an effect a restart replays finds them
    /// ready (T3 starts its worker once its layers are built).
    pub hold_effects: bool,
    /// `continueThreadsAfterServerUpdate`, resolved per project by the server.
    pub restart_policy: crate::RestartPolicy,
    /// Test hook: [`SqliteEngine::open`] stops before it takes the store's lease.
    #[cfg(test)]
    pub(crate) open_pause: Option<OpenPause>,
}

/// Test hook: `open` sends on `paused` and waits on `release` before its lease, then sends on
/// `finished` when it returns, whatever it returns.
#[cfg(test)]
pub(crate) struct OpenPause {
    pub(crate) paused: std::sync::mpsc::Sender<()>,
    pub(crate) release: std::sync::mpsc::Receiver<()>,
    pub(crate) finished: std::sync::mpsc::Sender<()>,
}

/// See [`EngineConfig::command_output_tap`].
pub type CommandOutputTap = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// `RuntimePolicyV2Override` in T3's `RuntimePolicy.ts`: fields that replace the policy the
/// engine derives from the thread.
#[derive(Clone, Debug, Default)]
pub struct RuntimePolicyOverride {
    pub cwd: Option<String>,
    pub approval_policy: Option<Value>,
    pub sandbox_policy: Option<Value>,
}

impl RuntimePolicyOverride {
    pub(crate) fn apply(&self, policy: &mut conn_provider::RuntimePolicy) {
        if let Some(cwd) = &self.cwd {
            policy.cwd = Some(cwd.clone());
        }
        if let Some(approval) = &self.approval_policy {
            policy.approval_policy = Some(approval.clone());
        }
        if let Some(sandbox) = &self.sandbox_policy {
            policy.sandbox_policy = Some(sandbox.clone());
        }
    }
}

impl std::fmt::Debug for EngineConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineConfig")
            .field("database", &self.database)
            .field("home", &self.home)
            .field("projects", &self.projects)
            .field("providers", &self.providers.len())
            .field("idle_session", &self.idle_session)
            .field("idle_max_hold", &self.idle_max_hold)
            .finish_non_exhaustive()
    }
}

impl EngineConfig {
    pub fn new(database: impl Into<PathBuf>) -> Self {
        Self {
            database: database.into(),
            home: None,
            projects: vec![],
            providers: vec![],
            provider_set: None,
            idle_session: Some(DEFAULT_IDLE_SESSION),
            idle_max_hold: Duration::from_secs(4 * 60 * 60),
            launch_grace: Duration::from_secs(10),
            host: None,
            title_generator: None,
            turn_observer: None,
            checkpoints: false,
            runtime_policy_override: None,
            command_output_tap: None,
            clock: Arc::new(crate::SystemClock),
            zone: jiff::tz::TimeZone::system(),
            recover_runs: true,
            attention: false,
            hold_effects: false,
            restart_policy: crate::RestartPolicy::default(),
            #[cfg(test)]
            open_pause: None,
        }
    }
}

pub struct SqliteEngine {
    inner: Arc<Inner>,
    /// The store's lock ([`lock_store`]): one engine per store. The engine holds it while it
    /// lives, and a task that changes the workspace holds it too ([`Inner::store_lock`]).
    _lock: Arc<std::fs::File>,
}

/// T3's `maxAttempts` for an effect, here for the host's cleanup of a closed thread.
const CLOSE_ATTEMPTS: u32 = 5;

/// What a second open of a store that a live engine holds gets.
pub const STORE_IN_USE: &str = "store in use: another engine has this database open";

/// Takes the exclusive advisory lock on `<database>.lock`, as the server's state-directory
/// lock does for its folder. A second engine on the store, in this process or another, gets
/// [`STORE_IN_USE`] before it reads or writes anything. Dropping the file releases it.
fn lock_store(database: &std::path::Path) -> Result<std::fs::File, String> {
    let mut path = resolved(database)
        .map_err(|e| format!("cannot resolve the store {}: {e}", database.display()))?
        .into_os_string();
    path.push(".lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| format!("cannot open the store lock {}: {e}", path.display()))?;
    // A child process forked elsewhere in this process holds a copy of the lock's file until
    // its exec closes it, so a lock released a moment ago can still look held: try for a while.
    let deadline = std::time::Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(std::fs::TryLockError::WouldBlock) => return Err(STORE_IN_USE.to_owned()),
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(format!("cannot lock the store {}: {e}", path.display()));
            }
        }
    }
}

/// The database's real path, so every spelling of one file (a symlink, `..`) shares one lock.
/// A file not created yet resolves through its folder, after any symlink that names it.
fn resolved(database: &std::path::Path) -> std::io::Result<PathBuf> {
    let mut path = database.to_path_buf();
    // A symlink to a file not created yet: follow it by hand, as the kernel's 40-hop limit.
    for _ in 0..40 {
        match std::fs::canonicalize(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            other => return other,
        }
        let Ok(target) = std::fs::read_link(&path) else {
            let name = path
                .file_name()
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?;
            let parent = match path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent,
                _ => std::path::Path::new("."),
            };
            return Ok(std::fs::canonicalize(parent)?.join(name));
        };
        path = match path.parent() {
            Some(parent) => parent.join(target),
            None => target,
        };
    }
    Err(std::io::Error::other("too many levels of symbolic links"))
}

/// How long an open waits for a store lock that looks held.
const LOCK_WAIT: Duration = Duration::from_secs(2);

impl Drop for SqliteEngine {
    /// The engine's owner let go: it never writes again, and the store's lock is free for the
    /// next engine. In the server that happens only as the process ends. Its worker claims
    /// nothing more, and an effect still running (only a test outlives its engine) fails its
    /// next write (`Store::take_ownership`).
    fn drop(&mut self) {
        self.inner
            .engine_dropped
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.inner.effects_wake.notify_one();
    }
}

/// What worktree cleanup reads in one pass ([`SqliteEngine::cleanup_threads`]): thread shell
/// JSON as clients see it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CleanupThreads {
    /// Live and archived threads, with the fields cleanup reads.
    pub threads: Vec<Value>,
    /// Deleted threads that had a worktree and a branch, with their project's
    /// `workspaceRoot`.
    pub deleted: Vec<Value>,
    /// The live projects (`OrchestrationV2ProjectShell`).
    pub projects: Vec<Value>,
}

impl std::fmt::Debug for SqliteEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteEngine").finish_non_exhaustive()
    }
}

pub(crate) struct Inner {
    store: Arc<Mutex<Store>>,
    /// Raised after a commit wrote an attention event; `None` when they are off.
    attention: Option<Arc<tokio::sync::Notify>>,
    /// The latest committed sequence. Stream tasks wake on it and read from the store. Each
    /// commit sends it (`Tx::commit`).
    pub(crate) notify: Arc<watch::Sender<u64>>,
    pub(crate) providers: conn_provider::ProviderSet,
    /// Threads with an open provider session. The only per-thread state kept in memory.
    pub(crate) live: Mutex<HashMap<String, Arc<LiveThread>>>,
    /// Sessions a fresh run moved aside while they still ran background work; the idle
    /// reaper closes each once its work ends or its hold runs out.
    pub(crate) detached: Mutex<Vec<(String, Arc<LiveThread>)>>,
    /// Agent tools of closed sessions whose shared process still runs, by thread, for the
    /// thread's next session on that instance (T3 reuses the credential). Bounded by
    /// [`crate::runner::MAX_KEPT_TOOLS`].
    pub(crate) kept_tools: Mutex<HashMap<String, crate::runner::KeptTools>>,
    pub(crate) home: PathBuf,
    pub(crate) titles: Option<Arc<dyn crate::TitleGenerator>>,
    pub(crate) observer: Option<Arc<dyn crate::TurnObserver>>,
    pub(crate) host: Option<Arc<dyn crate::EngineHost>>,
    pub(crate) idle_max_hold: Duration,
    /// [`EngineConfig::launch_grace`].
    launch_grace: Duration,
    /// Threads whose launch is making a worktree now; shutdown cancels their setup.
    preparing: Mutex<std::collections::HashSet<String>>,
    /// Live output of running commands for `subscribeCommandOutput`; bounded, never stored.
    pub(crate) command_output: crate::output::CommandOutputHub,
    /// Set when shutdown begins; no provider session opens after it.
    pub(crate) shutting_down: std::sync::atomic::AtomicBool,
    /// Git checkpoints per turn (`checkpoint.rs`); `None` when off.
    pub(crate) checkpoints: Option<Arc<crate::checkpoint::Checkpoints>>,
    /// [`EngineConfig::runtime_policy_override`].
    pub(crate) policy_override: Option<RuntimePolicyOverride>,
    /// [`EngineConfig::command_output_tap`].
    pub(crate) output_tap: Option<CommandOutputTap>,
    /// [`EngineConfig::clock`].
    pub(crate) clock: Arc<dyn crate::Clock>,
    /// [`EngineConfig::idle_session`].
    pub(crate) idle_session: Option<Duration>,
    /// Raised when outbox rows may be claimable (`outbox.rs`); the effect worker waits on it.
    pub(crate) effects_wake: Arc<tokio::sync::Notify>,
    /// The effect worker started ([`Inner::ensure_effect_worker`]).
    pub(crate) effect_worker: std::sync::atomic::AtomicBool,
    /// [`EngineConfig::hold_effects`], until [`SqliteEngine::start_effects`].
    pub(crate) effects_held: std::sync::atomic::AtomicBool,
    /// The [`SqliteEngine`] was dropped: the worker stops, and the store refuses its writes.
    pub(crate) engine_dropped: Arc<std::sync::atomic::AtomicBool>,
    /// The store's lock while the engine lives. A task that changes the workspace upgrades it
    /// first and holds it until it is done, so a dropped engine's restore keeps the store from
    /// a replacement. A failed upgrade means the engine is gone: the task touches nothing.
    /// Not an `Arc`: session pumps hold `Inner` for as long as their sessions run.
    pub(crate) store_lock: std::sync::Weak<std::fs::File>,
    /// Test hook: pauses one command inside its transaction, before it commits.
    #[cfg(test)]
    pub(crate) commit_pause: Mutex<Option<CommitPause>>,
    /// Test hooks of the effect worker (`effect_worker.rs`).
    #[cfg(test)]
    pub(crate) worker_hooks: Mutex<crate::effect_worker::TestHooks>,
    thread_gates: crate::thread_locks::ThreadLocks,
    /// Each running launch holds a read guard; shutdown takes the write side, so it waits
    /// (up to `launch_grace`) for admitted launches to commit or remove what they made.
    launches: tokio::sync::RwLock<()>,
    /// Points where a test holds a launch (`SqliteEngine::test_pause_at`).
    #[cfg(test)]
    pub(crate) pauses: Mutex<HashMap<&'static str, Arc<TestPause>>>,
}

/// A launch held at a named point until the test resumes it.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct TestPause {
    pub(crate) reached: tokio::sync::Notify,
    pub(crate) resume: tokio::sync::Notify,
}

/// A delegated child's checkout, made before its command commits.
struct DelegatedWorktree {
    thread_id: String,
    project_root: String,
    worktree: crate::ProvisionedWorktree,
}

/// Test hook: the command with this id stops inside its transaction, before the commit. It
/// sends on `paused`, then waits on `release`.
#[cfg(test)]
pub(crate) struct CommitPause {
    pub(crate) command_id: String,
    pub(crate) paused: std::sync::mpsc::Sender<()>,
    pub(crate) release: std::sync::mpsc::Receiver<()>,
}

/// Stable project id for a folder, so a fresh database gives clients the same ids.
pub(crate) fn project_id(workspace_root: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in workspace_root.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("project:{hash:016x}")
}

impl SqliteEngine {
    /// Opens the store, adds the configured projects, and, with [`EngineConfig::recover_runs`],
    /// recovers every run a previous process left active (see `restart.rs`): a turn the
    /// provider had continues in a new run.
    pub fn open(config: EngineConfig) -> Result<Self, String> {
        Self::open_unless(config, None)
    }

    /// [`Self::open`], unless `abandoned` is set before the store's lease is taken.
    fn open_unless(
        mut config: EngineConfig,
        abandoned: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<Self, String> {
        #[cfg(test)]
        let _finished = config.open_pause.take().map(|pause| {
            let _ = pause.paused.send(());
            let _ = pause.release.recv();
            struct Finished(std::sync::mpsc::Sender<()>);
            impl Drop for Finished {
                fn drop(&mut self) {
                    let _ = self.0.send(());
                }
            }
            Finished(pause.finished)
        });
        let home = config.home.clone().unwrap_or_else(|| {
            config
                .database
                .parent()
                .map(PathBuf::from)
                .unwrap_or_default()
        });
        // Before anything reads or migrates the store.
        let lock = Arc::new(lock_store(&config.database)?);
        let mut store = Store::open(&config.database)?;
        // From here every older engine on this database is fenced.
        let engine_dropped = store.take_ownership(abandoned)?;
        store.set_clock(config.clock.clone());
        store.zone = config.zone.clone();
        store.host = config.host.clone();
        store.generates_titles = config.title_generator.is_some();
        let providers = config
            .provider_set
            .take()
            .unwrap_or_else(|| std::mem::take(&mut config.providers).into());
        store.providers = providers.clone();
        let attention = config
            .attention
            .then(|| Arc::new(tokio::sync::Notify::new()));
        store.attention = attention.clone();
        // T3's `reconcileAfterProcessLoss`: what the previous process left unsettled is
        // cancelled when it was process-bound and runs again when it is replay-safe. An inert
        // copy cancels everything.
        store.reconcile_after_process_loss(config.recover_runs)?;
        let effects_wake = store.effects_wake.clone();
        let (unfinished, pending_rollbacks, orphaned) = if config.recover_runs {
            (
                store.unfinished_runs()?,
                store.unsettled_rollbacks()?,
                store.threads_with_live_native_subagents()?,
            )
        } else {
            Default::default()
        };
        let mut tx = store.tx()?;
        for project in &config.projects {
            tx.ensure_project(
                &project_id(&project.workspace_root),
                &project.title,
                &project.workspace_root,
            )?;
        }
        // A rollback a previous process left unsettled keeps its row, ahead of what the
        // restart writes below, so it still runs before the thread's next turn.
        for pending in &pending_rollbacks {
            crate::rollback::recover_pending(
                &mut tx,
                &pending.thread_id,
                &pending.command_id,
                &pending.phase,
                pending.snapshot.as_ref(),
            )?;
        }
        // No provider process survives a restart: open native subagents never report an end.
        for thread_id in &orphaned {
            crate::families::end_orphaned_native_subagents(&mut tx, thread_id, "cancelled", None)?;
        }
        let mut effects = vec![];
        // T3 holds the prompts queued in a thread the previous process left unfinished, also
        // one whose only unfinished run is queued: the user decides when they go. Before any
        // replayed effect runs, so a replayed capture cannot start one. A buffered provider
        // notification is cancelled instead: its output went with the old process.
        let mut held = std::collections::HashSet::new();
        for (thread_id, _) in &unfinished {
            if held.insert(thread_id.as_str()) {
                commands::cancel_buffered_notifications(&mut tx, thread_id)?;
                commands::hold_queue(&mut tx, thread_id)?;
            }
        }
        for (thread_id, run) in unfinished
            .iter()
            .filter(|(_, run)| commands::is_active(run))
        {
            effects.extend(crate::restart::recover(
                &mut tx,
                thread_id,
                run,
                &config.restart_policy,
            )?);
        }
        // `recoverDelegatedTasks`: once recovery decided which runs continue, a delegated
        // child's tasks whose work ended with a cancelled run are published. So are those an
        // orphaned native subagent held: it was just cancelled, though no run is unfinished.
        let recovered: std::collections::BTreeSet<&str> = unfinished
            .iter()
            .map(|(id, _)| id.as_str())
            .chain(orphaned.iter().map(String::as_str))
            .collect();
        for thread_id in recovered {
            effects.extend(crate::families::finalize_tasks(&mut tx, thread_id)?);
        }
        tx.enqueue(None, &effects)?;
        tx.commit(None)?;
        let notify = store.published.clone();
        let engine = Self {
            inner: Arc::new(Inner {
                store: Arc::new(Mutex::new(store)),
                attention,
                notify,
                providers,
                live: Mutex::new(HashMap::new()),
                detached: Mutex::new(Vec::new()),
                kept_tools: Mutex::new(HashMap::new()),
                thread_gates: Default::default(),
                command_output: crate::output::CommandOutputHub::default(),
                shutting_down: std::sync::atomic::AtomicBool::new(false),
                home,
                titles: config.title_generator.clone(),
                observer: config.turn_observer.clone(),
                host: config.host.clone(),
                idle_max_hold: config.idle_max_hold,
                launch_grace: config.launch_grace,
                preparing: Mutex::new(std::collections::HashSet::new()),
                checkpoints: config
                    .checkpoints
                    .then(Arc::<crate::checkpoint::Checkpoints>::default),
                policy_override: config.runtime_policy_override.clone(),
                output_tap: config.command_output_tap.clone(),
                clock: config.clock.clone(),
                idle_session: config.idle_session,
                effects_wake,
                effect_worker: std::sync::atomic::AtomicBool::new(false),
                effects_held: std::sync::atomic::AtomicBool::new(config.hold_effects),
                engine_dropped,
                store_lock: Arc::downgrade(&lock),
                #[cfg(test)]
                commit_pause: Mutex::new(None),
                #[cfg(test)]
                worker_hooks: Mutex::default(),
                launches: tokio::sync::RwLock::new(()),
                #[cfg(test)]
                pauses: Mutex::new(HashMap::new()),
            }),
            _lock: lock,
        };
        // The reaper starts on the caller's runtime; `open` never blocks.
        if tokio::runtime::Handle::try_current().is_ok()
            && let Some(idle) = config.idle_session
        {
            let inner = Arc::downgrade(&engine.inner);
            tokio::spawn(async move {
                let every = (idle / 2).max(Duration::from_millis(10));
                loop {
                    tokio::time::sleep(every).await;
                    // The engine is gone: stop.
                    let Some(inner) = inner.upgrade() else { return };
                    inner.reap_idle(idle).await;
                }
            });
        }
        engine.inner.ensure_effect_worker();
        Ok(engine)
    }

    /// [`Self::open`] for a caller on the runtime: the store is opened, migrated and recovered
    /// on the blocking pool (AGENTS rule 2), and the effect worker starts once recovery
    /// committed.
    ///
    /// The open goes on when the caller drops this future; it then takes no lease, so an engine
    /// opened after the drop keeps the store.
    pub async fn start(config: EngineConfig) -> Result<Self, String> {
        struct AbandonOnDrop(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for AbandonOnDrop {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let abandoned = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _guard = AbandonOnDrop(abandoned.clone());
        tokio::task::spawn_blocking(move || Self::open_unless(config, Some(&abandoned)))
            .await
            .map_err(|e| format!("the engine's open stopped: {e}"))?
    }

    /// Puts a completed run back to `waiting` with no checkpoint, as a kill between the
    /// provider's end and the capture leaves it.
    /// Holds a workspace's checkpoint lock, so a capture or a rollback there waits.
    #[cfg(test)]
    pub(crate) async fn test_hold_workspace(
        &self,
        cwd: &str,
    ) -> conn_vcs::locks::WorkspaceLock<'_> {
        self.inner
            .checkpoints
            .as_ref()
            .expect("checkpoints on")
            .workspace(cwd)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn test_force_waiting(&self, thread_id: &str, run_id: &str) {
        let (tid, rid) = (thread_id.to_owned(), run_id.to_owned());
        self.inner
            .write(move |tx| {
                if let Some(mut run) = tx.entity(&tid, "runs", &rid)? {
                    run["status"] = serde_json::json!("waiting");
                    run["completedAt"] = Value::Null;
                    run["checkpointId"] = Value::Null;
                    tx.append(crate::store::Draft::new(&tid, "run.updated", run).run(Some(&rid)))?;
                }
                Ok(())
            })
            .await
            .expect("force waiting");
    }

    /// Holds `thread_id`'s effect lane with a running row, as an effect that has not ended.
    /// Returns the row for [`Self::test_release_lane`].
    #[cfg(test)]
    pub(crate) async fn test_hold_lane(&self, thread_id: &str) -> i64 {
        let tid = thread_id.to_owned();
        self.inner
            .db(move |store| {
                store
                    .raw()
                    .execute(
                        "INSERT INTO effect_outbox (thread_id, lane, effect_type, payload, status,
                           created_at, updated_at)
                         VALUES (?1, 'thread', 'test.hold', '{}', 'running', '', '')",
                        [&tid],
                    )
                    .expect("hold lane");
                store.raw().last_insert_rowid()
            })
            .await
    }

    /// Ends a hold from [`Self::test_hold_lane`]: the thread's next effect may run.
    #[cfg(test)]
    pub(crate) async fn test_release_lane(&self, id: i64) {
        self.inner
            .db(move |store| store.settle_effect(id, crate::outbox::Settled::Succeeded, None))
            .await
            .expect("release lane");
        self.inner.effects_wake.notify_one();
    }

    /// Every stored event of a thread as `(type, payload)`, oldest first.
    #[cfg(test)]
    pub(crate) async fn test_events(&self, thread_id: &str) -> Vec<(String, Value)> {
        let tid = thread_id.to_owned();
        self.inner
            .db(move |store| store.thread_events_after(&tid, 0, 100_000))
            .await
            .expect("events")
            .into_iter()
            .map(|(_, e)| {
                (
                    e["type"].as_str().unwrap_or_default().to_owned(),
                    e["payload"].clone(),
                )
            })
            .collect()
    }

    /// Starts the effect worker of an engine opened with [`EngineConfig::hold_effects`], on the
    /// caller's runtime.
    pub fn start_effects(&self) {
        self.inner
            .effects_held
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.inner.ensure_effect_worker();
    }

    /// Raised after each commit that wrote an attention event; `None` when they are off
    /// ([`EngineConfig::attention`]).
    pub fn attention_signal(&self) -> Option<Arc<tokio::sync::Notify>> {
        self.inner.attention.clone()
    }

    /// Every live thread's stored worktree path, `(thread id, path)`, with the live projects:
    /// what worktree cleanup reads again before a removal, without parsing every shell.
    pub async fn worktree_bindings(&self) -> Result<(Vec<(String, String)>, Vec<Value>), String> {
        self.inner
            .db(|store| Ok((store.worktree_bindings()?, store.projects_snapshot()?)))
            .await
    }

    /// The shells of `ids`, as [`CleanupThreads::threads`] holds them.
    pub async fn cleanup_shells(&self, ids: Vec<String>) -> Result<Vec<Value>, String> {
        self.inner.db(move |store| store.cleanup_shells(&ids)).await
    }

    /// The threads worktree cleanup weighs, with the live projects (see [`CleanupThreads`]).
    pub async fn cleanup_threads(&self) -> Result<CleanupThreads, String> {
        self.inner
            .db(|store| {
                let (threads, deleted) = store.cleanup_threads()?;
                let projects = store.projects_snapshot()?;
                Ok(CleanupThreads {
                    threads,
                    deleted,
                    projects,
                })
            })
            .await
    }

    /// The folders open provider sessions work in. A session can outlive its run, so a
    /// worktree it works in is still in use (`ProviderSessionManager.isLive`).
    pub async fn open_session_cwds(&self) -> Result<Vec<String>, String> {
        let threads: Vec<String> = crate::lock(&self.inner.live).keys().cloned().collect();
        // A session a fresh run moved aside still runs in its folder (T3 checks each provider
        // session, `storageCleanup.ts`). Its folder comes from memory: archiving deletes the
        // thread's session rows and closes only the current session.
        let detached: Vec<String> = crate::lock(&self.inner.detached)
            .iter()
            .filter_map(|(_, live)| live.cwd.clone())
            .collect();
        if threads.is_empty() {
            return Ok(detached);
        }
        self.inner
            .db(move |store| {
                let mut cwds = detached;
                for thread in threads {
                    let tx = store.tx()?;
                    let sessions = tx.entities(&thread, "providerSessions");
                    tx.rollback();
                    cwds.extend(sessions?.into_iter().filter_map(|session| {
                        (session["status"] != "stopped")
                            .then(|| session["cwd"].as_str().map(str::to_owned))
                            .flatten()
                    }));
                }
                Ok(cwds)
            })
            .await
    }

    /// The per-checkout lease (T3's `withWorkspaceLease`): turn starts, checkpoint captures and
    /// rollbacks take it, and so do terminal starts and worktree removal. `None` when
    /// checkpoints are off.
    pub fn workspace_locks(&self) -> Option<Arc<conn_vcs::locks::WorkspaceLocks>> {
        self.inner.checkpoints.clone()
    }

    /// Now, by the engine's clock, in milliseconds since the epoch.
    pub fn now_millis(&self) -> u64 {
        self.inner.clock.now_millis()
    }

    /// Up to `limit` attention events due at `now_ms`, oldest due first.
    pub async fn attention_due(
        &self,
        now_ms: u64,
        limit: usize,
    ) -> Result<Vec<crate::AttentionOutboxRow>, String> {
        self.inner
            .db(move |store| crate::attention::due(store.raw(), now_ms, limit))
            .await
    }

    /// When the next attention event is due, if one waits.
    pub async fn attention_next_due(&self) -> Result<Option<u64>, String> {
        self.inner
            .db(|store| crate::attention::next_due(store.raw()))
            .await
    }

    /// Removes an event the Gateway took.
    pub async fn attention_delivered(&self, outbox_id: i64) -> Result<(), String> {
        self.inner
            .db(move |store| crate::attention::delivered(store.raw(), outbox_id))
            .await
    }

    /// Holds an event until `at_ms`, after `attempts` failed sends.
    pub async fn attention_retry(
        &self,
        outbox_id: i64,
        attempts: u32,
        at_ms: u64,
    ) -> Result<(), String> {
        self.inner
            .db(move |store| crate::attention::retry(store.raw(), outbox_id, attempts, at_ms))
            .await
    }

    /// Drops the events written before `before_ms`. Returns how many.
    pub async fn attention_drop_older(&self, before_ms: u64) -> Result<usize, String> {
        self.inner
            .db(move |store| crate::attention::drop_older(store.raw(), before_ms))
            .await
    }

    /// The project id the engine gives a configured folder.
    pub fn project_id_for(workspace_root: &str) -> String {
        project_id(workspace_root)
    }

    /// Closes the provider sessions that are idle now, by the engine's clock. The server's
    /// reaper does this on its own every half `idle_session`; a replay on a
    /// [`crate::ManualClock`] calls it after it moves the clock, as T3's `TestClock.adjust`
    /// wakes T3's idle release.
    pub async fn release_idle_sessions(&self) {
        if let Some(idle) = self.inner.idle_session {
            self.inner.reap_idle(idle).await;
        }
    }

    /// One page of the whole event log after `after`, oldest first, as
    /// `OrchestrationV2StoredEvent` rows. The log is never pruned: every event since the store
    /// was made is there. For tools that check the log against T3's own assertions (the
    /// `t3_fixture_replay` example); clients read the streams.
    pub async fn stored_events(&self, after: u64, limit: usize) -> Result<Vec<Value>, String> {
        self.inner
            .db(move |store| store.stored_events_after(after, limit))
            .await
    }

    /// Whether the provider accepted the run's turn start (`Session::start_turn` returned).
    /// The fixture replay waits for it where T3's harness waits for a running provider turn,
    /// which T3 stores only after the start was accepted.
    pub async fn run_start_accepted(&self, run_id: &str) -> bool {
        let run_id = run_id.to_owned();
        self.inner
            .db(move |store| -> Result<bool, String> {
                let tx = store.tx()?;
                let accepted = tx.start_accepted(&run_id);
                tx.rollback();
                Ok(accepted)
            })
            .await
            .unwrap_or(false)
    }
}

pub(crate) enum DispatchError {
    Rejected(String),
    Internal(String),
}

impl Inner {
    pub(crate) async fn lock_thread(&self, thread_id: &str) -> crate::thread_locks::Guard<'_> {
        self.thread_gates.lock(thread_id).await
    }

    /// Runs `f` on the blocking pool, so SQLite never stalls the event loop.
    pub(crate) async fn db<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Store) -> T + Send + 'static,
    ) -> T {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = crate::lock(&store);
            f(&mut guard)
        })
        .await
        .expect("store task panicked")
    }

    /// One atomic write. Its commit wakes the streams.
    pub(crate) async fn write<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Tx<'_>) -> StoreResult<T> + Send + 'static,
    ) -> StoreResult<T> {
        self.db(move |store| {
            let mut tx = store.tx()?;
            match f(&mut tx) {
                Ok(value) => tx.commit(None).map(|_| value),
                Err(e) => {
                    tx.rollback();
                    Err(e)
                }
            }
        })
        .await
    }

    /// Decides, commits and starts the effects of one command. Returns the sequence to wait
    /// for and whether the command had already been accepted (a retry).
    pub(crate) async fn dispatch_value(
        self: &Arc<Self>,
        command: Value,
    ) -> Result<(u64, bool), DispatchError> {
        self.dispatch_value_guarded(command, None, None).await
    }

    /// [`Self::dispatch_value`] with an ownership check that runs in the command's own
    /// transaction (`guard.rs`).
    pub(crate) async fn dispatch_value_guarded(
        self: &Arc<Self>,
        command: Value,
        guard: Option<crate::guard::DispatchGuard>,
        commit_gate: Option<Arc<dyn crate::guard::CommitGate>>,
    ) -> Result<(u64, bool), DispatchError> {
        if let Some(host) = &self.host {
            host.refresh_settings().await;
        }
        let (command, claimed) = self.claim_attachments(command).await?;
        let command = self.plan_selection(command).await?;
        let command = self.rollback_capabilities(command).await?;
        let command = self.target_capabilities(command).await?;
        let (command, worktree) = match self.delegated_worktree(command).await {
            Ok(prepared) => prepared,
            Err(error) => {
                if let (Some(claimed), Some(host)) = (claimed, &self.host) {
                    host.release_attachments(claimed).await;
                }
                return Err(error);
            }
        };
        // A paused commit committed nothing: wait for access, then check everything again
        // (ownership included) in a fresh transaction.
        // Only a guarded commit can pause and retry: the ordinary path passes the command by
        // value, with no copy of its body.
        if commit_gate.is_none() {
            let result = self.dispatch_claimed(command, guard, None).await;
            // A refusal or a replay keeps none of this attempt's copies.
            if let (Err(_) | Ok((_, true)), Some(claimed), Some(host)) =
                (&result, claimed, &self.host)
            {
                host.release_attachments(claimed).await;
            }
            self.settle_delegated_worktree(worktree, &result).await;
            return result;
        }
        let result = loop {
            let result = self
                .dispatch_claimed(command.clone(), guard.clone(), commit_gate.clone())
                .await;
            match (&result, &commit_gate) {
                (Err(DispatchError::Rejected(message)), Some(gate))
                    if message == crate::guard::COMMIT_PAUSED =>
                {
                    if !gate.wait_until_open().await {
                        break Err(DispatchError::Rejected(
                            "The caller's access was revoked.".into(),
                        ));
                    }
                }
                _ => break result,
            }
        };
        if let (Err(_) | Ok((_, true)), Some(claimed), Some(host)) = (&result, claimed, &self.host)
        {
            host.release_attachments(claimed).await;
        }
        self.settle_delegated_worktree(worktree, &result).await;
        result
    }

    /// `delegate_task` with isolation `worktree` (`workspaceStrategy: {type: "worktree"}`): the
    /// child's checkout is made before the command commits, as a worktree launch makes its
    /// thread's, and the child thread records its branch and path. T3 prepares the same
    /// checkout after the command, through `prepared-run.*`, which this server refuses. A
    /// command already accepted makes nothing: its child keeps the first checkout.
    async fn delegated_worktree(
        &self,
        mut command: Value,
    ) -> Result<(Value, Option<DelegatedWorktree>), DispatchError> {
        if command["type"] != "delegated_task.request"
            || command["workspaceStrategy"]["type"] != "worktree"
        {
            return Ok((command, None));
        }
        let command_id = command["commandId"].as_str().unwrap_or_default().to_owned();
        let parent_id = command["parentThreadId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let parent_run_id = command["parentRunId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let id = command_id.clone();
        let (seen, found) = self
            .db(
                move |store| -> Result<(bool, Option<ChildCheckout>), String> {
                    let seen = store.receipt(&id)?.is_some();
                    let tx = store.tx()?;
                    let found = child_checkout(&tx, &parent_id, &parent_run_id);
                    tx.rollback();
                    Ok((seen, found?))
                },
            )
            .await
            .map_err(DispatchError::Internal)?;
        if seen {
            return Ok((command, None));
        }
        // The handler's refusals that need no write are checked first, so a command it would
        // refuse runs no setup script: no parent, project or running parent run, or no task.
        // It checks them again when it commits.
        let task_given = command["task"]
            .as_str()
            .is_some_and(|t| !t.trim().is_empty());
        let Some(ChildCheckout {
            project_id,
            root,
            link_origin,
        }) = found.filter(|_| task_given)
        else {
            return Ok((command, None));
        };
        let Some(host) = &self.host else {
            return Err(DispatchError::Rejected(
                "This server cannot create worktrees.".into(),
            ));
        };
        let thread_id = crate::families::child_thread_id(&command_id);
        let strategy = &command["workspaceStrategy"];
        let made = host
            .provision_worktree(crate::WorktreeRequest {
                thread_id: thread_id.clone(),
                project_id: Some(project_id),
                link_origin,
                project_root: root.clone(),
                base_ref: strategy["baseRef"].as_str().unwrap_or("HEAD").to_owned(),
                branch: strategy["branch"].as_str().map(str::to_owned),
                start_from_origin: strategy["startFromOrigin"] == true,
                missing_base: MissingBase::Fail,
            })
            .await
            .map_err(DispatchError::Rejected)?;
        command["branch"] = json!(made.branch);
        command["worktreePath"] = json!(made.path);
        Ok((
            command,
            Some(DelegatedWorktree {
                thread_id,
                project_root: root,
                worktree: made,
            }),
        ))
    }

    /// A child worktree whose command was refused, or replayed by a concurrent retry that
    /// committed first, is removed with its branch.
    async fn settle_delegated_worktree(
        &self,
        worktree: Option<DelegatedWorktree>,
        result: &Result<(u64, bool), DispatchError>,
    ) {
        let (Some(made), Some(host)) = (worktree, &self.host) else {
            return;
        };
        let refused = match result {
            Ok((_, false)) => return,
            Ok((_, true)) => None,
            Err(DispatchError::Rejected(message) | DispatchError::Internal(message)) => {
                Some(message.clone())
            }
        };
        let (thread_id, path) = (made.thread_id.clone(), made.worktree.path.clone());
        if let Err(error) = host
            .discard_worktree(made.thread_id, made.project_root, made.worktree, refused)
            .await
        {
            eprintln!(
                "conn-engine: the worktree {path} that thread {thread_id} made stays: {error}"
            );
        }
    }

    /// `ProviderSwitchService.plan` for a model change on the thread's instance: the provider
    /// classifies it (`planSelectionTransition`) against its live session's capabilities.
    /// Without a session row the change applies at the next turn, as in T3. The plan travels
    /// with the command to its handler as `selectionTransition`.
    async fn plan_selection(&self, mut command: Value) -> Result<Value, DispatchError> {
        if command["type"] != "thread.model-selection.set" {
            return Ok(command);
        }
        let target = commands::normalize_model_selection(&command["modelSelection"]);
        let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
        let instance = target["instanceId"].as_str().unwrap_or_default().to_owned();
        let tid = thread_id.clone();
        let inst = instance.clone();
        let (current, capabilities) = self
            .db(move |store| -> Result<(Value, Option<Value>), String> {
                let tx = store.tx()?;
                let current = tx
                    .thread(&tid)?
                    .map(|t| t["modelSelection"].clone())
                    .unwrap_or(Value::Null);
                let capabilities = tx
                    .entities_where(&tid, "providerSessions", "providerInstanceId", &inst)?
                    .into_iter()
                    .max_by_key(|s| s["updatedAt"].as_str().unwrap_or_default().to_owned())
                    .map(|s| s["capabilities"].clone());
                tx.rollback();
                Ok((current, capabilities))
            })
            .await
            .map_err(DispatchError::Internal)?;
        let current = commands::normalize_model_selection(&current);
        let same_instance = current["instanceId"] == target["instanceId"];
        let plan = match (same_instance && current != target, capabilities) {
            (true, Some(capabilities)) => {
                let provider = self.providers.get(&instance);
                let decoded = (from_json(current), from_json(target));
                match (provider, decoded) {
                    (Some(provider), (Ok(current), Ok(target))) => provider
                        .plan_selection_transition(&conn_provider::SelectionTransitionInput {
                            current,
                            target,
                            session_capabilities: capabilities,
                        }),
                    _ => conn_provider::SelectionTransitionPlan::ApplyOnNextTurn,
                }
            }
            _ => conn_provider::SelectionTransitionPlan::ApplyOnNextTurn,
        };
        command["selectionTransition"] = match plan {
            conn_provider::SelectionTransitionPlan::ApplyOnNextTurn => {
                json!({"type": "apply_on_next_turn"})
            }
            conn_provider::SelectionTransitionPlan::RestartSession => {
                json!({"type": "restart_session"})
            }
            conn_provider::SelectionTransitionPlan::CreateWithHandoff => {
                json!({"type": "create_with_handoff"})
            }
            conn_provider::SelectionTransitionPlan::Reject { reason } => {
                json!({"type": "reject", "reason": reason})
            }
        };
        Ok(command)
    }

    /// `checkpoint.rollback` asks the thread's provider instance for its capabilities, as T3's
    /// admission does (`providerAdapters.get(..).getCapabilities()`); the handler checks them
    /// (`providerCapabilities`: the instance and its capabilities, or why there are none).
    async fn rollback_capabilities(&self, mut command: Value) -> Result<Value, DispatchError> {
        if command["type"] != "checkpoint.rollback" {
            return Ok(command);
        }
        let tid = command["threadId"].as_str().unwrap_or_default().to_owned();
        let instance = self
            .db(move |store| -> Result<Option<String>, String> {
                let tx = store.tx()?;
                let thread = tx.thread(&tid)?;
                tx.rollback();
                Ok(thread.map(|t| {
                    t["modelSelection"]["instanceId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned()
                }))
            })
            .await
            .map_err(DispatchError::Internal)?;
        // No thread: the handler refuses the command.
        let Some(instance) = instance else {
            return Ok(command);
        };
        // As a turn start finds it: only a thread that names no instance may use the one
        // configured provider.
        let provider = self.providers.resolve(&instance);
        command["providerCapabilities"] = match provider {
            Some(provider) => match provider.capabilities().await {
                Ok(capabilities) => {
                    json!({"instanceId": instance, "capabilities": to_json(&capabilities)})
                }
                Err(e) => json!({"instanceId": instance, "error": e.to_string()}),
            },
            None => json!({"instanceId": instance,
                "error": format!("No provider instance `{instance}` is configured on this server.")}),
        };
        Ok(command)
    }

    /// A message's run may switch providers; the handler checks that the run's instance takes
    /// the history (`ensureContextHandoff`), as T3 asks `getCapabilities` of the target adapter.
    async fn target_capabilities(&self, mut command: Value) -> Result<Value, DispatchError> {
        if command["type"] != "message.dispatch" {
            return Ok(command);
        }
        let instance = match command["modelSelection"]["instanceId"].as_str() {
            Some(instance) => instance.to_owned(),
            None => {
                let tid = command["threadId"].as_str().unwrap_or_default().to_owned();
                let instance = self
                    .db(move |store| -> Result<Option<String>, String> {
                        let tx = store.tx()?;
                        let thread = tx.thread(&tid)?;
                        tx.rollback();
                        Ok(thread.and_then(|t| {
                            t["modelSelection"]["instanceId"]
                                .as_str()
                                .map(str::to_owned)
                        }))
                    })
                    .await
                    .map_err(DispatchError::Internal)?;
                // No thread: the handler refuses the command.
                let Some(instance) = instance else {
                    return Ok(command);
                };
                instance
            }
        };
        // An instance this server does not serve fails at the turn start, as before.
        if let Some(provider) = self.providers.resolve(&instance)
            && let Ok(capabilities) = provider.capabilities().await
        {
            command["targetCapabilities"] = to_json(&capabilities);
        }
        Ok(command)
    }

    /// A new message's pending uploads become the thread's files before the message is
    /// written (`AttachmentStore` claim). A retried command keeps what it claimed first.
    async fn claim_attachments(
        &self,
        mut command: Value,
    ) -> Result<(Value, Option<Value>), DispatchError> {
        let Some(host) = &self.host else {
            return Ok((command, None));
        };
        let initial = command["type"] == "thread.create";
        let attachments = if initial {
            &command["initialMessage"]["attachments"]
        } else {
            &command["attachments"]
        };
        if (!initial && command["type"] != "message.dispatch")
            || attachments.as_array().is_none_or(Vec::is_empty)
        {
            return Ok((command, None));
        }
        let command_id = command["commandId"].as_str().unwrap_or_default().to_owned();
        let seen = self
            .db(move |store| store.receipt(&command_id))
            .await
            .map_err(DispatchError::Internal)?;
        if seen.is_some() {
            return Ok((command, None));
        }
        let thread_id = command["threadId"].as_str().unwrap_or_default().to_owned();
        let attachments = if initial {
            command["initialMessage"]["attachments"].take()
        } else {
            command["attachments"].take()
        };
        let named: Vec<String> = attachments
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a["id"].as_str().map(str::to_owned))
            .collect();
        let claimed = host
            .claim_attachments(thread_id, attachments)
            .await
            .map_err(DispatchError::Rejected)?;
        // Only the copies this claim made are released on a refusal. An attachment named by a
        // stable id (already a thread's file) passed the claim unchanged and stays.
        let made: Vec<Value> = claimed
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| {
                a["id"]
                    .as_str()
                    .is_some_and(|id| !named.iter().any(|n| n == id))
            })
            .cloned()
            .collect();
        if initial {
            command["initialMessage"]["attachments"] = claimed;
        } else {
            command["attachments"] = claimed;
        }
        Ok((command, (!made.is_empty()).then_some(Value::Array(made))))
    }

    async fn dispatch_claimed(
        self: &Arc<Self>,
        command: Value,
        guard: Option<crate::guard::DispatchGuard>,
        commit_gate: Option<Arc<dyn crate::guard::CommitGate>>,
    ) -> Result<(u64, bool), DispatchError> {
        let _gate = self
            .lock_thread(command["threadId"].as_str().unwrap_or_default())
            .await;
        let command_type = command["type"].as_str().unwrap_or_default().to_owned();
        let Some(command_id) = command["commandId"].as_str().map(str::to_owned) else {
            return Err(DispatchError::Rejected(
                "The command has no commandId.".into(),
            ));
        };
        let handler = if command_type == "secret_request.record" {
            Some(crate::secret_requests::record as commands::Handler)
        } else if command_type == "link_request.record" {
            Some(crate::link_requests::record as commands::Handler)
        } else if command_type == "delegated_task.remote.request" {
            Some(crate::families::remote_request as commands::Handler)
        } else if command_type == "delegated_task.remote.complete" {
            Some(crate::families::remote_complete as commands::Handler)
        } else if command_type == "delegated_task.remote.stop" {
            Some(crate::families::remote_stop as commands::Handler)
        } else if command_type == "delegated_task.cancel" {
            Some(crate::families::cancel_task as commands::Handler)
        } else if command_type == "thread.pull-request-watch.sync" {
            Some(commands::pull_request_watch_sync as commands::Handler)
        } else if command_type == "thread.pull-request-watch.checks-reopen" {
            Some(commands::pull_request_watch_checks_reopen as commands::Handler)
        } else {
            commands::handler(&command_type)
        };
        let Some(handler) = handler else {
            return Err(DispatchError::Rejected(
                commands::refusal(&command_type).to_owned(),
            ));
        };
        let host = self.host.clone();
        self.ensure_effect_worker();
        #[cfg(test)]
        let inner = self.clone();
        let receipt_thread = receipt_thread_id(&command);
        let outcome = self
            .db(move |store| {
                let key = ReceiptKey {
                    command_id: &command_id,
                    command_type: &command_type,
                    owner: ReceiptOwner::Thread(&receipt_thread),
                };
                if let Some(receipt) = store.outcome(&command_id).map_err(CommandError::Store)? {
                    let seq = replay(&key, receipt, guard.is_some())?;
                    // T3's `replayCommandReceipt` checks the queue again for these two.
                    let only = command["runId"].as_str();
                    match command_type.as_str() {
                        "queue.resume" | "queued-run.start" => {
                            let mut tx = store.tx().map_err(CommandError::Store)?;
                            let started =
                                commands::start_next_queued(&mut tx, &receipt_thread, only)
                                    .map_err(CommandError::Store)?;
                            if let Err(e) = tx.enqueue(Some(&command_id), started.as_slice()) {
                                tx.rollback();
                                return Err(CommandError::Store(e));
                            }
                            tx.commit(None).map_err(CommandError::Store)?;
                        }
                        _ => {}
                    }
                    return Ok((seq, true));
                }
                let mut tx = store.tx().map_err(CommandError::Store)?;
                if let Some(guard) = &guard
                    && let Err(error) = crate::guard::check(&tx, guard, &command)
                {
                    tx.rollback();
                    return Err(error);
                }
                // A launch's admission, under the thread lock and before the decision: its
                // refusal is not recorded, so the launch id stays usable.
                if let Err(error) = commands::admit_launch(&tx, &command) {
                    tx.rollback();
                    return Err(error);
                }
                if let Some(host) = &host
                    && let Some((project, instance)) =
                        dispatch_target(&tx, &command).map_err(CommandError::Store)?
                    && !host.provider_instance_enabled(project.as_deref(), &instance)
                {
                    tx.rollback();
                    return Err(CommandError::Rejected(format!(
                        "Provider instance \"{instance}\" is disabled for project {}.",
                        project.unwrap_or_default()
                    )));
                }
                match handler(&mut tx, command) {
                    Ok(effects) => {
                        // The effects commit with the command (T3's `EventSink`), so a caller
                        // that goes away now cannot lose them.
                        #[cfg(test)]
                        inner.test_commit_pause(&command_id);
                        if let Err(e) = tx.enqueue(Some(&command_id), &effects) {
                            tx.rollback();
                            return Err(CommandError::Store(e));
                        }
                        let seq = match &commit_gate {
                            None => tx.commit(Some(&key)).map_err(CommandError::Store)?,
                            Some(commit_gate) => {
                                // The access decision and the commit are one step.
                                let mut pending = Some(tx);
                                let mut committed = None;
                                let decision = commit_gate.commit_if_open(&mut || {
                                    if let Some(tx) = pending.take() {
                                        committed = Some(tx.commit(Some(&key)));
                                    }
                                });
                                if let Some(tx) = pending.take() {
                                    tx.rollback();
                                }
                                match (decision, committed) {
                                    (crate::guard::CommitDecision::Committed, Some(result)) => {
                                        result.map_err(CommandError::Store)?
                                    }
                                    (crate::guard::CommitDecision::Paused, _) => {
                                        return Err(CommandError::Rejected(
                                            crate::guard::COMMIT_PAUSED.into(),
                                        ));
                                    }
                                    _ => {
                                        return Err(CommandError::Rejected(
                                            "The caller's access was revoked.".into(),
                                        ));
                                    }
                                }
                            }
                        };
                        Ok((seq, false))
                    }
                    Err(e) => {
                        tx.rollback();
                        // T3 records the refusal, so a retry gets it again instead of a second
                        // try. Refusals made before the decision (access, a disabled provider)
                        // stay open, as T3's mode-limit refusals do.
                        if let CommandError::Rejected(refusal) = &e {
                            store
                                .record_refusal(&key, refusal)
                                .map_err(CommandError::Store)?;
                        }
                        Err(e)
                    }
                }
            })
            .await;
        outcome.map_err(|e| match e {
            CommandError::Rejected(message) => DispatchError::Rejected(message),
            CommandError::Store(message) => DispatchError::Internal(message),
        })
    }

    #[cfg(test)]
    fn test_commit_pause(&self, command_id: &str) {
        let pause = {
            let mut slot = crate::lock(&self.commit_pause);
            if slot.as_ref().is_some_and(|p| p.command_id == command_id) {
                slot.take()
            } else {
                None
            }
        };
        if let Some(pause) = pause {
            let _ = pause.paused.send(());
            let _ = pause.release.recv();
        }
    }

    /// Runs one effect. An error is the effect's own failure, which its row records; most
    /// effects record their failures on the thread and return `Ok`.
    pub(crate) async fn run_effect(self: Arc<Self>, effect: Effect) -> Result<(), String> {
        match effect {
            Effect::StartTurn { thread_id, run_id } => self.start_turn(thread_id, run_id).await,
            Effect::Rollback(request) => self.rollback(request).await,
            Effect::CaptureCheckpoint { thread_id, run_id } => {
                self.capture_run(thread_id, run_id).await;
            }
            Effect::Steer {
                thread_id,
                run_id,
                message_id,
            } => self.steer(thread_id, run_id, message_id).await,
            Effect::Interrupt { thread_id, run_id } => self.interrupt(thread_id, run_id).await,
            Effect::AbandonStart { thread_id, run_id } => {
                self.abandon_start(&thread_id, &run_id).await;
            }
            Effect::StopBackgroundWork { thread_id, run_id } => {
                self.stop_background_work(thread_id, run_id).await;
            }
            Effect::Respond { thread_id, request } => self.respond(thread_id, request).await,
            Effect::CloseSession { thread_id } => self.close_session(&thread_id).await,
            Effect::CloseThreadSessions { thread_id } => {
                self.close_thread_sessions(&thread_id).await;
            }
            Effect::ApplyModelSelection {
                thread_id,
                selection,
            } => self.apply_model_selection(&thread_id, selection).await,
            Effect::CleanupHtmlAttachments { ids, .. } => {
                if let Some(host) = &self.host {
                    host.cleanup_html_attachments(ids).await;
                }
            }
            Effect::RemoteTaskChanged { thread_id, task_id } => {
                if let Some(host) = &self.host {
                    host.remote_task_changed(&thread_id, &task_id);
                }
            }
            Effect::ThreadClosed { thread_id, reason } => {
                // T3 revokes an archived or deleted thread's credentials
                // (`revokeMcpCredential`), also one a shared process still holds.
                if matches!(
                    reason,
                    crate::ThreadClose::Archived | crate::ThreadClose::Deleted
                ) {
                    self.drop_kept_tools(|thread, _| thread == thread_id);
                }
                return self.close_on_host(&thread_id, reason).await;
            }
            Effect::GenerateTitle {
                thread_id,
                request_id,
                regenerate,
            } => self.generate_title(thread_id, request_id, regenerate).await,
        }
        Ok(())
    }

    /// The host's cleanup of a closed thread, tried again with T3's effect backoff (100 ms,
    /// doubling) up to [`CLOSE_ATTEMPTS`] times (`maxAttempts`); the last error is the
    /// effect's.
    async fn close_on_host(
        &self,
        thread_id: &str,
        reason: crate::ThreadClose,
    ) -> Result<(), String> {
        let Some(host) = &self.host else {
            return Ok(());
        };
        let mut attempt = 1;
        loop {
            match host.thread_closed(thread_id, reason.clone()).await {
                Ok(()) => return Ok(()),
                Err(e) if attempt < CLOSE_ATTEMPTS => {
                    eprintln!("conn-engine: closing {thread_id} on the host failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100 << (attempt - 1))).await;
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// The branch checked out in the launch's project folder; `None` without a host, a
    /// project or a branch.
    async fn project_branch(&self, input: &Value) -> Option<String> {
        let host = self.host.as_ref()?;
        let project_id = input["projectId"].as_str()?.to_owned();
        let root = self
            .db(move |store| -> Result<Option<String>, String> {
                let tx = store.tx()?;
                let project = tx.project(&project_id);
                tx.rollback();
                Ok(project?.and_then(|p| p["workspaceRoot"].as_str().map(str::to_owned)))
            })
            .await
            .ok()??;
        host.current_branch(&root).await
    }

    async fn provision_worktree(
        &self,
        thread_id: &str,
        input: &Value,
        missing_base: MissingBase,
    ) -> Result<DelegatedWorktree, (String, bool)> {
        let Some(host) = &self.host else {
            return Err(("This server cannot create worktrees.".into(), false));
        };
        let project_id = input["projectId"].as_str().unwrap_or_default().to_owned();
        let root = self
            .db(move |store| -> Result<Option<String>, String> {
                let tx = store.tx()?;
                let project = tx.project(&project_id);
                tx.rollback();
                Ok(project?.and_then(|p| p["workspaceRoot"].as_str().map(str::to_owned)))
            })
            .await
            .map_err(|e| (e, true))?
            .ok_or_else(|| ("The project does not exist.".to_owned(), false))?;
        let strategy = &input["workspaceStrategy"];
        // Shutdown cancels the setup of every thread listed here. One listed after shutdown
        // began sees the flag instead; the setup starts in this same step, so no cancel falls
        // between the two.
        crate::lock(&self.preparing).insert(thread_id.to_owned());
        let made = if self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            Err("The server is shutting down.".to_owned())
        } else {
            host.provision_worktree(crate::WorktreeRequest {
                thread_id: thread_id.to_owned(),
                project_id: Some(input["projectId"].as_str().unwrap_or_default().to_owned()),
                // The origin `thread.create` stamps on the thread (`launch`).
                link_origin: input.get("linkOrigin").filter(|o| o.is_object()).cloned(),
                project_root: root.clone(),
                base_ref: strategy["baseRef"].as_str().unwrap_or("HEAD").to_owned(),
                branch: strategy["branch"].as_str().map(str::to_owned),
                start_from_origin: strategy["startFromOrigin"] == true,
                missing_base,
            })
            .await
        };
        crate::lock(&self.preparing).remove(thread_id);
        let worktree = made.map_err(|e| (e, false))?;
        Ok(DelegatedWorktree {
            thread_id: thread_id.to_owned(),
            project_root: root,
            worktree,
        })
    }

    /// T3's `replayCommandReceipt`, before the launch makes anything: a receipt proves
    /// execution only for the thread it was recorded against.
    async fn refuse_receipt_for_other_thread(
        &self,
        command_id: &str,
        thread_id: &str,
    ) -> Result<(), (String, bool)> {
        let id = command_id.to_owned();
        let receipt = self
            .db(move |store| store.outcome(&id))
            .await
            .map_err(|e| (e, true))?;
        let key = ReceiptKey {
            command_id,
            command_type: "",
            owner: ReceiptOwner::Thread(thread_id),
        };
        match receipt {
            Some(receipt) => replay(&key, receipt, false).map(drop).map_err(|e| match e {
                CommandError::Rejected(message) => (message, false),
                CommandError::Store(message) => (message, true),
            }),
            None => Ok(()),
        }
    }

    async fn launch(
        self: &Arc<Self>,
        input: Value,
        missing_base: MissingBase,
    ) -> Result<Value, (String, bool)> {
        let command_id = input["commandId"].as_str().unwrap_or_default().to_owned();
        let thread_id = input["threadId"]
            .as_str()
            .map_or_else(|| format!("thread:{command_id}"), str::to_owned);
        let message_command_id = format!("{command_id}:initial-message");
        // `assertProviderInstanceEnabled` before anything is made. It passes a launch already
        // accepted, so a replay never depends on the provider's state now; an older build's
        // reuse left only its message's receipt.
        // The settings read behind `provider_instance_enabled` is blocking I/O: it runs with
        // the receipt lookup, off the runtime thread.
        let ids = (
            command_id.clone(),
            message_command_id.clone(),
            thread_id.clone(),
        );
        let host = self.host.clone();
        let target = (
            input["projectId"].as_str().map(str::to_owned),
            input["modelSelection"]["instanceId"]
                .as_str()
                .map(str::to_owned),
        );
        let disabled = self
            .db(move |store| -> Result<Option<String>, String> {
                let accepted = store.receipt(&ids.0)?.is_some()
                    || store.accepted_first_message(&ids.1, &ids.2)?;
                Ok(match (accepted, host, target) {
                    (false, Some(host), (Some(project), Some(instance)))
                        if !host.provider_instance_enabled(Some(&project), &instance) =>
                    {
                        Some(format!(
                            "Provider instance \"{instance}\" is disabled for project {project}."
                        ))
                    }
                    _ => None,
                })
            })
            .await
            .map_err(|e| (e, true))?;
        if let Some(refusal) = disabled {
            return Err((refusal, false));
        }
        // T3 reads the `:initial-message` receipt only when the claim needs a separate first
        // message; its own dispatch replays it then.
        self.refuse_receipt_for_other_thread(&command_id, &thread_id)
            .await?;
        let strategy = &input["workspaceStrategy"];
        let mut provisioned = None;
        let (branch, worktree_path) = match strategy["type"].as_str() {
            // `launchBranch`: a project-folder launch that names no branch records the
            // folder's checkout, as the composer does.
            Some("root") if !strategy["branch"].is_string() => {
                (json!(self.project_branch(&input).await), Value::Null)
            }
            Some("root") => (strategy["branch"].clone(), Value::Null),
            Some("existing_worktree") => {
                (strategy["branch"].clone(), strategy["worktreePath"].clone())
            }
            // The worktree is made before the thread exists, so the launch answers once it is
            // ready; T3's `prepared-run.*` progress commands stay refused.
            Some("worktree") if input["reuseExistingThread"] != true => {
                let id = command_id.clone();
                let retried = self
                    .db(move |store| store.receipt(&id))
                    .await
                    .map_err(|e| (e, true))?
                    .is_some();
                if retried {
                    // `thread.create` answers from its receipt; these values are not read.
                    (Value::Null, Value::Null)
                } else {
                    let made = self
                        .provision_worktree(&thread_id, &input, missing_base)
                        .await?;
                    let values = (json!(made.worktree.branch), json!(made.worktree.path));
                    provisioned = Some(made);
                    values
                }
            }
            other => {
                return Err((
                    format!(
                        "Conn Server cannot prepare a `{}` workspace yet.",
                        other.unwrap_or("unknown")
                    ),
                    false,
                ));
            }
        };
        let made_worktree = provisioned.is_some();
        let creation_source = input["creationSource"].as_str().unwrap_or("web").to_owned();
        // `ThreadLaunchService` records the launch's own actor (a scheduled task's creator).
        let created_by = input["createdBy"].as_str().unwrap_or("user").to_owned();
        let to_err = |e: DispatchError| match e {
            DispatchError::Rejected(message) => (message, false),
            DispatchError::Internal(message) => (message, true),
        };
        let first_message = input
            .get("initialMessage")
            .filter(|m| m.is_object())
            .map(|message| {
                let mut first = json!({
                    "messageId": message["messageId"].as_str().map_or_else(|| format!("message:{command_id}"), str::to_owned),
                    "text": message["text"],
                    "attachments": message["attachments"],
                    "modelSelection": input["modelSelection"],
                });
                if let Some(task) = message["scheduledTaskId"].as_str() {
                    first["scheduledTaskId"] = json!(task);
                }
                if message["context"].is_object() {
                    first["context"] = message["context"].clone();
                }
                if input["generateTitle"] == true {
                    first["titleSeed"] = input["title"].clone();
                }
                first
            });
        let reuse = input["reuseExistingThread"] == true;
        let resumed;
        let mut sequence = None;
        // A new thread's claim carries its first message (`ThreadLaunchService`). A reused
        // thread, or a replayed claim that carried none, takes it in a command of its own.
        let mut separate_message = reuse;
        if reuse {
            let ids = (
                command_id.clone(),
                message_command_id.clone(),
                thread_id.clone(),
            );
            let (claimed_before, sent_before) = self
                .db(move |store| -> Result<(bool, bool), String> {
                    // Only an accepted first message of this thread, with its run, is a send.
                    let sent = store.accepted_first_message(&ids.1, &ids.2)?;
                    Ok((store.receipt(&ids.0)?.is_some(), sent))
                })
                .await
                .map_err(|e| (e, true))?;
            #[cfg(test)]
            self.test_pause("launch.receipts-read").await;
            if sent_before && !claimed_before {
                // An older build sent a reused thread's first message without a claim.
                resumed = true;
            } else {
                // `validateReusableThread` runs in the claim's own write, after its receipt
                // check: an identical retry that finished first makes this one replay, and a
                // thread archived or filled since is not claimed.
                let claim = json!({
                    "type": "thread.metadata.update",
                    "commandId": command_id,
                    "threadId": thread_id,
                    "expectedEmpty": true,
                    "reuseProjectId": input["projectId"],
                    // The launch's checkout, as T3 records it on the reused thread.
                    "branch": if branch.is_string() { branch.clone() } else { Value::Null },
                    "worktreePath": worktree_path.clone(),
                });
                #[cfg(test)]
                self.test_pause("launch.before-claim").await;
                let (_, replayed) = self.dispatch_value(claim).await.map_err(to_err)?;
                resumed = replayed;
            }
        } else {
            let mut create = json!({
                "type": "thread.create",
                "commandId": command_id,
                "threadId": thread_id,
                "projectId": input["projectId"],
                "title": input["title"],
                "modelSelection": input["modelSelection"],
                "runtimeMode": input["runtimeMode"],
                "interactionMode": input["interactionMode"],
                "branch": if branch.is_string() { branch } else { Value::Null },
                "worktreePath": worktree_path,
                "createdBy": created_by,
                "creationSource": creation_source,
            });
            // The link a linked caller acts for: the thread carries it (`startsThreads`).
            if let Some(origin) = input.get("linkOrigin").filter(|o| o.is_object()) {
                create["linkOrigin"] = origin.clone();
                if let Some(from) = input.get("delegatedFrom").filter(|d| d.is_object()) {
                    create["delegatedFrom"] = from.clone();
                }
            }
            if let Some(first) = &first_message {
                create["initialMessage"] = first.clone();
            }
            let created = self.dispatch_value(create).await;
            // T3 removes a worktree that no thread recorded.
            self.settle_delegated_worktree(provisioned, &created).await;
            let (seq, replayed) = created.map_err(to_err)?;
            if replayed {
                // The id's receipt must be a launch's own `thread.create`, or its run is no
                // launch's first message.
                let id = command_id.clone();
                let kind = self
                    .db(move |store| store.outcome(&id))
                    .await
                    .map_err(|e| (e, true))?
                    .map(|receipt| receipt.command_type)
                    .unwrap_or_default();
                if kind != "thread.create" {
                    return Err((
                        format!(
                            "Command {command_id} was already handled as {kind} and cannot be replayed as a launch."
                        ),
                        false,
                    ));
                }
            }
            resumed = replayed;
            if first_message.is_some() {
                sequence = Some(seq);
                if replayed {
                    // An older build wrote the first message as its own command; finish
                    // that launch, or replay its message.
                    let id = command_id.clone();
                    separate_message = self
                        .db(move |store| store.created_run_status(&id))
                        .await
                        .map_err(|e| (e, true))?
                        .is_none();
                }
            }
        }
        // The claimed thread must be the launch's project before its first message is sent.
        let id = thread_id.clone();
        let claimed_project = self
            .db(move |store| -> Result<Option<Value>, String> {
                let tx = store.tx()?;
                let thread = tx.thread(&id);
                tx.rollback();
                Ok(thread?.map(|t| t["projectId"].clone()))
            })
            .await
            .map_err(|e| (e, true))?;
        if claimed_project.as_ref() != Some(&input["projectId"]) {
            return Err(("Project identity changed.".into(), false));
        }
        let mut resumed = resumed;
        if let Some(mut command) = first_message.filter(|_| separate_message) {
            command["type"] = json!("message.dispatch");
            command["commandId"] = json!(message_command_id);
            command["threadId"] = json!(thread_id);
            command["dispatchMode"] = json!({"type": "start_immediately"});
            command["createdBy"] = json!(created_by);
            command["creationSource"] = json!(creation_source);
            // The project check above, again in the message's own write.
            command["launchProjectId"] = input["projectId"].clone();
            if reuse {
                command["reuseProjectId"] = input["projectId"].clone();
            }
            // The checkout the claim recorded, from the claim's own event: T3 carries the
            // workspace with the accepted message.
            // A message already accepted replays from its receipt and needs none.
            let ids = (
                command_id.clone(),
                message_command_id.clone(),
                thread_id.clone(),
            );
            let (checkout, sent) = self
                .db(move |store| -> Result<(Option<Value>, bool), String> {
                    Ok((
                        store.claimed_checkout(&ids.0, &ids.2)?,
                        store.accepted_first_message(&ids.1, &ids.2)?,
                    ))
                })
                .await
                .map_err(|e| (e, true))?;
            match checkout {
                Some(path) => command["launchCheckout"] = json!({"worktreePath": path}),
                None if !sent => {
                    return Err((
                        "The launch's checkout cannot be recovered.".to_owned(),
                        false,
                    ));
                }
                None => {}
            }
            // T3 limits an agent's message to the modes it launched with: a thread a replay
            // or another launch made with broader modes refuses it.
            if created_by == "agent" {
                command["modeLimit"] = json!({
                    "runtimeMode": input["runtimeMode"],
                    "interactionMode": input["interactionMode"],
                });
            }
            let (seq, replayed) = self.dispatch_value(command).await.map_err(to_err)?;
            let ids = (message_command_id.clone(), thread_id.clone());
            let ran = self
                .db(move |store| store.accepted_first_message(&ids.0, &ids.1))
                .await
                .map_err(|e| (e, true))?;
            if !ran {
                return Err((
                    "Initial message was accepted without a durable run.".into(),
                    false,
                ));
            }
            sequence = Some(seq);
            resumed = replayed;
        }
        // The first run is handed off (or there is none): setup's agent stage is done.
        if let (true, false, Some(host)) = (made_worktree, resumed, &self.host) {
            host.launch_committed(&thread_id);
        }
        #[cfg(test)]
        self.test_pause("launch.before-projection").await;
        let id = thread_id.clone();
        let projection = self
            .db(move |store| store.thread_projection(&id))
            .await
            .map_err(|e| (e, true))?
            .ok_or_else(|| (format!("Thread {thread_id} does not exist."), false))?;
        // The answer is for the launch's project; a thread moved since is not its thread.
        if projection["thread"]["projectId"] != input["projectId"] {
            return Err(("Project identity changed.".into(), false));
        }
        let mut result = json!({
            "threadId": thread_id,
            "projection": projection,
            "resumed": resumed,
        });
        if let Some(seq) = sequence {
            result["sequence"] = json!(seq);
        }
        Ok(result)
    }
}

/// What a `worktree` delegate's child checkout is made from.
struct ChildCheckout {
    project_id: String,
    root: String,
    /// The parent's `linkOrigin`, which the child thread inherits.
    link_origin: Option<Value>,
}

/// The parent's project and origin, when the parent and its run are there and running.
fn child_checkout(
    tx: &Tx<'_>,
    parent_id: &str,
    parent_run_id: &str,
) -> Result<Option<ChildCheckout>, String> {
    let Some(parent) = tx.thread(parent_id)? else {
        return Ok(None);
    };
    if !tx
        .entity(parent_id, "runs", parent_run_id)?
        .is_some_and(|run| commands::is_active(&run))
    {
        return Ok(None);
    }
    let Some(project_id) = parent["projectId"].as_str() else {
        return Ok(None);
    };
    let root = tx
        .project(project_id)?
        .and_then(|p| p["workspaceRoot"].as_str().map(str::to_owned));
    Ok(root.map(|root| ChildCheckout {
        project_id: project_id.to_owned(),
        root,
        link_origin: parent.get("linkOrigin").filter(|o| o.is_object()).cloned(),
    }))
}

/// A contract error the engine builds. When the contract no longer accepts its shape, the
/// caller gets an internal error with the reason instead of a stopped server.
pub(crate) fn contract_error<E: serde::de::DeserializeOwned>(value: Value) -> Result<E, String> {
    let message = value["message"].as_str().unwrap_or_default().to_owned();
    from_json(value)
        .map_err(|e| format!("conn-engine built an error the contract rejects ({e}): {message}"))
}

/// `Rejected` with a contract error, or `Internal` when it does not fit the contract.
pub(crate) fn rejected<E>(built: Result<E, String>) -> EngineError<E> {
    match built {
        Ok(error) => EngineError::Rejected(error),
        Err(message) => EngineError::Internal(message),
    }
}

/// T3's generic dispatch failure texts (`GENERIC_ERROR_PREFIXES` in `UserFacingErrors.ts`).
const GENERIC_DISPATCH_PREFIXES: [&str; 3] = [
    "Failed to dispatch orchestration V2 command",
    "Failed to dispatch orchestration command ",
    "Provider adapter failed while dispatching orchestration command ",
];

/// An `OrchestrationV2DispatchCommandError` as T3's `ws.ts` builds it: a user-facing reason
/// is both the `message` and the `detail`; without one, the generic message and no `detail`.
/// The thread a command's receipt is kept for: T3's `commandThreadId`.
fn receipt_thread_id(command: &Value) -> String {
    let field = match command["type"].as_str().unwrap_or_default() {
        "thread.fork" | "thread.merge_back" => "targetThreadId",
        "delegated_task.request"
        | "delegated_task.remote.request"
        | "delegated_task.remote.complete"
        | "delegated_task.remote.stop"
        | "delegated_task.wake-policy"
        | "delegated_task.completion-delivery.acknowledge"
        | "delegated_task.completion-delivery.dispose"
        | "thread.created.record" => "parentThreadId",
        _ => "threadId",
    };
    command[field].as_str().unwrap_or_default().to_owned()
}

/// A retried command's answer from its receipt (`replayCommandReceipt`): the refusal again,
/// or a conflict when the id was handled for something else, else the sequence it answered.
/// A receipt from before owners (schema 4) is refused, never run again.
fn replay(key: &ReceiptKey<'_>, receipt: Receipt, guarded: bool) -> Result<u64, CommandError> {
    if let Some(refusal) = receipt.refusal {
        return Err(CommandError::Rejected(format!(
            "Command {} was previously rejected: {refusal}",
            key.command_id
        )));
    }
    let ReceiptOwner::Thread(thread) = key.owner else {
        return Ok(receipt.sequence);
    };
    match receipt.owner {
        Some(StoredOwner::Thread(handled)) if handled == thread => {}
        Some(StoredOwner::Thread(handled)) => {
            return Err(CommandError::Rejected(format!(
                "Command {} was already handled for thread {handled} and cannot be replayed for {thread}.",
                key.command_id
            )));
        }
        Some(StoredOwner::Project(_)) => {
            return Err(CommandError::Rejected(
                "Conflicting receipt is not a thread command receipt.".into(),
            ));
        }
        None => {
            return Err(CommandError::Rejected(format!(
                "Command {} was handled before receipts named their owner; it cannot be replayed for {thread}.",
                key.command_id
            )));
        }
    }
    if guarded {
        // A guarded caller never gets a second accept for one command.
        return Err(CommandError::Rejected(
            "The command was already accepted.".into(),
        ));
    }
    Ok(receipt.sequence)
}

fn dispatch_error_body(command_id: &str, command_type: &str, reason: &str) -> Value {
    let reason = reason.trim();
    let user_facing = (!reason.is_empty()
        && !GENERIC_DISPATCH_PREFIXES
            .iter()
            .any(|prefix| reason.starts_with(prefix)))
    .then_some(reason);
    let mut body = json!({
        "_tag": "OrchestrationV2DispatchCommandError",
        "commandId": command_id,
        "commandType": command_type,
        "message": user_facing.unwrap_or(GENERIC_DISPATCH_PREFIXES[0]),
    });
    if let Some(detail) = user_facing {
        body["detail"] = json!(detail);
    }
    body
}

fn projection_error(
    thread_id: &str,
    message: impl Into<String>,
) -> Result<GetThreadProjectionError, String> {
    contract_error(json!({
        "_tag": "OrchestrationV2GetThreadProjectionError",
        "threadId": thread_id,
        "message": message.into(),
    }))
}

impl Engine for SqliteEngine {
    fn thread_worktree(
        &self,
        thread_id: &str,
    ) -> BoxFuture<'_, Result<Option<crate::ThreadWorktree>, String>> {
        let id = thread_id.to_owned();
        Box::pin(async move {
            self.inner
                .db(move |store| -> StoreResult<Option<crate::ThreadWorktree>> {
                    let tx = store.tx()?;
                    let read = (|| {
                        let Some(thread) = tx.thread(&id)? else {
                            return Ok(None);
                        };
                        let Some(worktree_path) = thread["worktreePath"].as_str() else {
                            return Ok(None);
                        };
                        let project_root = match thread["projectId"].as_str() {
                            Some(project) => tx
                                .project(project)?
                                .and_then(|p| p["workspaceRoot"].as_str().map(str::to_owned)),
                            None => None,
                        };
                        Ok(Some(crate::ThreadWorktree {
                            worktree_path: worktree_path.to_owned(),
                            branch: thread["branch"].as_str().map(str::to_owned),
                            project_root,
                        }))
                    })();
                    tx.rollback();
                    read
                })
                .await
        })
    }

    fn workspace_lease<'a>(
        &'a self,
        root: &'a str,
    ) -> BoxFuture<'a, Option<conn_vcs::locks::WorkspaceLock<'a>>> {
        Box::pin(async move {
            match &self.inner.checkpoints {
                Some(locks) => Some(locks.workspace(root).await),
                None => None,
            }
        })
    }

    fn provider_instance_enabled(&self, project_id: &str, instance_id: &str) -> bool {
        self.inner
            .host
            .as_ref()
            .is_none_or(|host| host.provider_instance_enabled(Some(project_id), instance_id))
    }
    fn claim_settle_script<'a>(
        &'a self,
        thread_id: &'a str,
        settled_at: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>> {
        let (thread_id, settled_at) = (thread_id.to_owned(), settled_at.to_owned());
        Box::pin(async move {
            self.inner
                .db(move |store| store.claim_settle_script(&thread_id, &settled_at))
                .await
        })
    }

    fn has_receipt<'a>(&'a self, command_id: &'a str) -> BoxFuture<'a, Result<bool, String>> {
        let command_id = command_id.to_owned();
        Box::pin(async move {
            self.inner
                .db(move |store| store.receipt(&command_id).map(|r| r.is_some()))
                .await
        })
    }

    fn created_run_status<'a>(
        &'a self,
        command_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, String>> {
        let command_id = command_id.to_owned();
        Box::pin(async move {
            self.inner
                .db(move |store| store.created_run_status(&command_id))
                .await
        })
    }

    fn record_link_request(&self, mut input: Value) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let Some(fields) = input.as_object_mut() else {
                return Err("Invalid link request.".into());
            };
            fields.insert("type".into(), json!("link_request.record"));
            self.inner
                .dispatch_value(input)
                .await
                .map(|_| ())
                .map_err(|e| match e {
                    DispatchError::Rejected(e) | DispatchError::Internal(e) => e,
                })
        })
    }

    fn sync_pull_request_watch(&self, mut command: Value) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let Some(fields) = command.as_object_mut() else {
                return Err("Invalid pull request watch sync.".into());
            };
            fields.insert("type".into(), json!("thread.pull-request-watch.sync"));
            self.inner
                .dispatch_value(command)
                .await
                .map(|_| ())
                .map_err(|e| match e {
                    DispatchError::Rejected(e) | DispatchError::Internal(e) => e,
                })
        })
    }

    fn remote_task(&self, command: Value) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if !matches!(
                command["type"].as_str(),
                Some(
                    "delegated_task.remote.request"
                        | "delegated_task.remote.complete"
                        | "delegated_task.remote.stop"
                )
            ) {
                return Err("Not a remote task command.".into());
            }
            self.inner
                .dispatch_value(command)
                .await
                .map(|_| ())
                .map_err(|e| match e {
                    DispatchError::Rejected(e) | DispatchError::Internal(e) => e,
                })
        })
    }

    fn cancel_delegated_task(
        &self,
        mut command: Value,
    ) -> BoxFuture<'_, Result<(), EngineError<Value>>> {
        Box::pin(async move {
            command["type"] = json!("delegated_task.cancel");
            self.inner
                .dispatch_value(command)
                .await
                .map(|_| ())
                .map_err(|e| match e {
                    DispatchError::Rejected(message) => {
                        let refusal = crate::families::MODE_REFUSALS.iter().find_map(|code| {
                            let text = message.strip_prefix(code)?.strip_prefix(": ")?;
                            Some(json!({"code": code, "message": text}))
                        });
                        EngineError::Rejected(
                            refusal.unwrap_or_else(|| json!({"code": null, "message": message})),
                        )
                    }
                    DispatchError::Internal(message) => EngineError::Internal(message),
                })
        })
    }

    fn subagent_rows(&self, thread_id: &str) -> BoxFuture<'_, Result<Vec<Value>, String>> {
        let thread_id = thread_id.to_owned();
        Box::pin(async move {
            self.inner
                .db(move |store| -> Result<Vec<Value>, String> {
                    let tx = store.tx()?;
                    let rows = tx.entities(&thread_id, "subagents");
                    tx.rollback();
                    rows
                })
                .await
        })
    }

    fn open_remote_tasks(
        &self,
        limit: usize,
    ) -> BoxFuture<'_, Result<Vec<(String, String)>, String>> {
        Box::pin(async move {
            self.inner
                .db(move |store| -> Result<Vec<(String, String)>, String> {
                    let tx = store.tx()?;
                    let open = tx.open_remote_tasks(limit);
                    tx.rollback();
                    open
                })
                .await
        })
    }

    fn record_secret_request(&self, mut input: Value) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let Some(fields) = input.as_object_mut() else {
                return Err("Invalid secret request.".into());
            };
            fields.insert("type".into(), json!("secret_request.record"));
            self.inner
                .dispatch_value(input)
                .await
                .map(|_| ())
                .map_err(|e| match e {
                    DispatchError::Rejected(e) | DispatchError::Internal(e) => e,
                })
        })
    }

    fn dispatch(
        &self,
        command: Command,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>> {
        Box::pin(async move {
            let command = to_json(&command);
            let refusal = |message: String| -> Result<DispatchCommandError, String> {
                contract_error(dispatch_error_body(
                    command["commandId"].as_str().unwrap_or(""),
                    command["type"].as_str().unwrap_or(""),
                    &message,
                ))
            };
            // A worktree delegate makes a checkout before its command commits: that runs on its
            // own task, so a caller that goes away cannot leave the checkout behind.
            let outcome = if command["type"] == "delegated_task.request"
                && command["workspaceStrategy"]["type"] == "worktree"
            {
                let inner = self.inner.clone();
                let detached = command.clone();
                tokio::spawn(async move { inner.dispatch_value(detached).await })
                    .await
                    .map_err(|e| DispatchError::Internal(format!("dispatch ended: {e}")))
                    .and_then(|outcome| outcome)
            } else {
                self.inner.dispatch_value(command.clone()).await
            };
            match outcome {
                Ok((sequence, _)) => from_json(json!({"sequence": sequence}))
                    .map_err(|e| EngineError::Internal(e.to_string())),
                Err(DispatchError::Rejected(message)) => Err(rejected(refusal(message))),
                Err(DispatchError::Internal(message)) => Err(EngineError::Internal(message)),
            }
        })
    }

    fn thread_ever_deleted(&self, thread_id: &str) -> BoxFuture<'_, Result<bool, String>> {
        let thread_id = thread_id.to_owned();
        Box::pin(async move {
            self.inner
                .db(move |store| -> Result<bool, String> {
                    let tx = store.tx()?;
                    let deleted = tx.thread_ever_deleted(&thread_id);
                    tx.rollback();
                    deleted
                })
                .await
        })
    }

    fn dispatch_guarded(
        &self,
        command: Command,
        guard: crate::guard::DispatchGuard,
        commit_gate: Option<Arc<dyn crate::guard::CommitGate>>,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>> {
        Box::pin(async move {
            let command = to_json(&command);
            let refusal = |message: String| -> Result<DispatchCommandError, String> {
                contract_error(dispatch_error_body(
                    command["commandId"].as_str().unwrap_or(""),
                    command["type"].as_str().unwrap_or(""),
                    &message,
                ))
            };
            // The dispatch runs on its own task: once the store committed, its effects start
            // even if the caller is gone (a dropped socket aborts the caller's task).
            let inner = self.inner.clone();
            let detached = command.clone();
            let outcome = tokio::spawn(async move {
                inner
                    .dispatch_value_guarded(detached, Some(guard), commit_gate)
                    .await
            })
            .await
            .map_err(|e| DispatchError::Internal(format!("guarded dispatch ended: {e}")))
            .and_then(|outcome| outcome);
            match outcome {
                Ok((sequence, _)) => from_json(json!({"sequence": sequence}))
                    .map_err(|e| EngineError::Internal(e.to_string())),
                Err(DispatchError::Rejected(message)) => Err(rejected(refusal(message))),
                Err(DispatchError::Internal(message)) => Err(EngineError::Internal(message)),
            }
        })
    }

    fn subscribe_shell(
        &self,
        input: SubscribeShellInput,
    ) -> BoxFuture<
        '_,
        Result<
            Subscription<ShellStreamItem, GetShellSnapshotError>,
            EngineError<GetShellSnapshotError>,
        >,
    > {
        Box::pin(streams::subscribe_shell(
            self.inner.clone(),
            to_json(&input),
        ))
    }

    fn subscribe_command_events(
        &self,
    ) -> BoxFuture<'_, Result<tokio::sync::mpsc::Receiver<(String, Value)>, String>> {
        Box::pin(streams::subscribe_command_events(self.inner.clone()))
    }

    fn subscribe_thread(
        &self,
        input: SubscribeThreadInput,
    ) -> BoxFuture<
        '_,
        Result<
            Subscription<ThreadStreamItem, GetThreadProjectionError>,
            EngineError<GetThreadProjectionError>,
        >,
    > {
        Box::pin(streams::subscribe_thread(
            self.inner.clone(),
            to_json(&input),
        ))
    }

    fn launch_thread_with(
        &self,
        input: Value,
        missing_base: MissingBase,
    ) -> BoxFuture<'_, Result<Value, EngineError<Value>>> {
        Box::pin(async move {
            // A failed settings load is retried before admission; the provider check runs in
            // the launch's own write, so a replay still succeeds after the provider is off.
            if let Some(host) = &self.inner.host {
                host.refresh_settings().await;
            }
            // The launch runs on its own task, as a worktree delegate's dispatch does: once it
            // made a worktree or began a claim, a caller that goes away cannot skip its commit
            // or its cleanup (T3 runs those parts uninterruptibly).
            let inner = self.inner.clone();
            let detached = input.clone();
            tokio::spawn(async move {
                let _admitted = inner.launches.read().await;
                if inner
                    .shutting_down
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    return Err(("The server is shutting down.".to_owned(), false));
                }
                inner.launch(detached, missing_base).await
            })
            .await
            .unwrap_or_else(|e| Err((format!("launch ended: {e}"), true)))
            .map_err(|(message, internal)| {
                if internal {
                    EngineError::Internal(message)
                } else {
                    EngineError::Rejected(json!({
                        "_tag": "OrchestrationV2ThreadLaunchError",
                        "commandId": input["commandId"],
                        "projectId": input["projectId"],
                        "message": message,
                    }))
                }
            })
        })
    }

    fn get_thread_projection(
        &self,
        thread_id: ThreadId,
    ) -> BoxFuture<'_, Result<Value, EngineError<GetThreadProjectionError>>> {
        Box::pin(async move {
            let id = thread_id.0.clone();
            match self
                .inner
                .db(move |store| store.thread_projection(&id))
                .await
            {
                Ok(Some(projection)) => Ok(projection),
                Ok(None) => Err(rejected(projection_error(
                    thread_id.as_str(),
                    format!("Thread {thread_id} does not exist."),
                ))),
                Err(e) => Err(EngineError::Internal(e)),
            }
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.inner
                .shutting_down
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // No launch starts after the flag. Admitted ones get their worktree setup
            // cancelled (conn-vcs removes what it made) and a grace to commit or clean up, as
            // T3 closes its preparation scope. A worktree a crash leaves stays on disk, as
            // with T3.
            let preparing: Vec<String> =
                crate::lock(&self.inner.preparing).iter().cloned().collect();
            if let Some(host) = &self.inner.host {
                for thread_id in &preparing {
                    host.cancel_preparation(thread_id);
                }
            }
            if tokio::time::timeout(self.inner.launch_grace, self.inner.launches.write())
                .await
                .is_err()
            {
                eprintln!(
                    "conn-engine: a launch was still running when shutdown's grace ended; its worktree may stay"
                );
            }
            self.inner.close_all_sessions().await;
        })
    }

    fn begin_shutdown(&self) {
        self.inner
            .shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn await_background_tasks(
        &self,
        thread_id: ThreadId,
        task_ids: Vec<String>,
        awaited: bool,
    ) -> BoxFuture<'_, Result<crate::BackgroundWait, crate::BackgroundWaitError>> {
        Box::pin(
            self.inner
                .await_background_tasks(thread_id.0, task_ids, awaited),
        )
    }

    fn methods(&self) -> &'static [&'static str] {
        crate::calls::METHODS
    }

    fn call(&self, method: &str, input: Value) -> BoxFuture<'_, Result<Value, EngineError<Value>>> {
        Box::pin(crate::calls::call(
            self.inner.clone(),
            method.to_owned(),
            input,
        ))
    }

    fn open_stream(
        &self,
        method: &str,
        input: Value,
    ) -> BoxFuture<'_, Result<Subscription<Value, Value>, EngineError<Value>>> {
        Box::pin(crate::calls::open_stream(
            self.inner.clone(),
            method.to_owned(),
            input,
        ))
    }

    fn shell_snapshot(&self) -> BoxFuture<'_, Result<Value, EngineError<GetShellSnapshotError>>> {
        Box::pin(async move {
            self.inner
                .db(|store| store.shell_snapshot())
                .await
                .map_err(EngineError::Internal)
        })
    }

    fn http_shell_snapshot(
        &self,
        options: crate::HttpShellQuery,
    ) -> BoxFuture<'_, Result<Option<Value>, EngineError<GetShellSnapshotError>>> {
        Box::pin(async move {
            self.inner
                .db(move |store| -> Result<Option<Value>, String> {
                    if let Some(after) = options.resume_from
                        && store.shell_resumable(after)?
                    {
                        return Ok(None);
                    }
                    store
                        .shell_snapshot_trimmed(
                            options.omit_idle_subagents,
                            options.omit_older_settled,
                        )
                        .map(Some)
                })
                .await
                .map_err(EngineError::Internal)
        })
    }

    fn projects_snapshot(
        &self,
    ) -> BoxFuture<'_, Result<Vec<Value>, EngineError<GetShellSnapshotError>>> {
        Box::pin(async move {
            self.inner
                .db(|store| store.projects_snapshot())
                .await
                .map_err(EngineError::Internal)
        })
    }

    fn thread_transcript(
        &self,
        thread_id: ThreadId,
        environment_id: String,
        limit: u64,
    ) -> BoxFuture<'_, Result<crate::ThreadTranscript, EngineError<GetThreadProjectionError>>> {
        Box::pin(async move {
            self.inner
                .db(move |store| {
                    store.thread_transcript(thread_id.as_str(), &environment_id, limit)
                })
                .await
                .map_err(EngineError::Internal)
        })
    }

    fn thread_history_page(
        &self,
        thread_id: ThreadId,
        cursor: String,
        through_entry_id: Option<String>,
        conversation_only: bool,
    ) -> BoxFuture<'_, Result<crate::ThreadHistory, EngineError<GetThreadProjectionError>>> {
        Box::pin(async move {
            let Ok(cursor) = crate::history::decode_cursor(&cursor) else {
                return Ok(crate::ThreadHistory::InvalidCursor);
            };
            self.inner
                .db(move |store| {
                    let high = store.high_water();
                    Ok(store
                        .history_page(
                            thread_id.as_str(),
                            high,
                            &cursor,
                            through_entry_id.as_deref(),
                            conversation_only,
                        )?
                        .map_or(crate::ThreadHistory::NotFound, crate::ThreadHistory::Page))
                })
                .await
                .map_err(EngineError::Internal)
        })
    }

    fn thread_snapshot(
        &self,
        thread_id: ThreadId,
    ) -> BoxFuture<'_, Result<Option<Value>, EngineError<GetThreadProjectionError>>> {
        Box::pin(async move {
            self.inner
                .db(move |store| {
                    let high = store.high_water();
                    Ok(store.thread_projection(thread_id.as_str())?.map(
                        |projection| json!({"snapshotSequence": high, "projection": projection}),
                    ))
                })
                .await
                .map_err(EngineError::Internal)
        })
    }
}

/// The project and provider instance a command would start work on (T3's
/// `assertDispatchTargetEnabled`), or `None` when it starts none or names no known thread.
fn dispatch_target(
    tx: &Tx<'_>,
    command: &Value,
) -> crate::store::StoreResult<Option<(Option<String>, String)>> {
    let text = |v: &Value| v.as_str().map(str::to_owned);
    // A launch's thread and first message: the run starts in this commit, on the project the
    // command names (the thread does not exist yet).
    if command["type"] == "thread.create" && command["initialMessage"].is_object() {
        let instance = text(&command["initialMessage"]["modelSelection"]["instanceId"])
            .or_else(|| text(&command["modelSelection"]["instanceId"]));
        return Ok(instance.map(|instance| (text(&command["projectId"]), instance)));
    }
    let thread_id = match command["type"].as_str().unwrap_or("") {
        "delegated_task.request" => &command["parentThreadId"],
        "thread.metadata.update" if command.get("continuation").is_none() => return Ok(None),
        "runtime-request.respond"
            if !answers_with_message(tx, command)?
                || matches!(command["decision"].as_str(), Some("decline" | "cancel")) =>
        {
            return Ok(None);
        }
        "message.dispatch"
        | "runtime-request.respond"
        | "thread.metadata.update"
        | "prepared-run.release"
        | "prepared-run.retry" => &command["threadId"],
        _ => return Ok(None),
    };
    let Some(thread_id) = thread_id.as_str() else {
        return Ok(None);
    };
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(None);
    };
    let project = text(&thread["projectId"]);
    let instance = match command["type"].as_str().unwrap_or("") {
        "message.dispatch" => text(&command["modelSelection"]["instanceId"])
            .or_else(|| text(&thread["modelSelection"]["instanceId"])),
        "delegated_task.request" => text(&command["modelSelection"]["instanceId"]),
        "thread.metadata.update" | "runtime-request.respond" => {
            text(&thread["modelSelection"]["instanceId"])
        }
        _ => match command["runId"].as_str() {
            Some(run_id) => tx
                .entity(thread_id, "runs", run_id)?
                .and_then(|run| text(&run["providerInstanceId"])),
            None => None,
        },
    };
    Ok(instance.map(|instance| (project, instance)))
}

/// Whether a `runtime-request.respond` answers with a user message, which starts a turn.
fn answers_with_message(
    tx: &crate::store::Tx<'_>,
    command: &Value,
) -> crate::store::StoreResult<bool> {
    let (Some(thread_id), Some(request_id)) =
        (command["threadId"].as_str(), command["requestId"].as_str())
    else {
        return Ok(false);
    };
    Ok(tx
        .entity(thread_id, "runtimeRequests", request_id)?
        .is_some_and(|request| request["responseCapability"]["type"] == "message"))
}

#[cfg(test)]
impl Inner {
    pub(crate) fn live_count(&self) -> usize {
        crate::lock(&self.live).len()
    }

    /// Holds the first launch or event pump that reaches `point` until the test resumes it.
    pub(crate) async fn test_pause(&self, point: &'static str) {
        let pause = crate::lock(&self.pauses).remove(point);
        if let Some(pause) = pause {
            pause.reached.notify_one();
            pause.resume.notified().await;
        }
    }
}

#[cfg(test)]
impl SqliteEngine {
    pub(crate) fn inner(&self) -> &Arc<Inner> {
        &self.inner
    }

    /// Holds the next launch or pump that reaches `point`: `launch.receipts-read`,
    /// `launch.before-claim`, `launch.before-projection`, or `pump.event` (an event received,
    /// not stored yet).
    pub(crate) fn test_pause_at(&self, point: &'static str) -> Arc<TestPause> {
        let pause = Arc::new(TestPause::default());
        crate::lock(&self.inner.pauses).insert(point, pause.clone());
        pause
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An error shape the contract rejects becomes an internal error, never a panic.
    #[test]
    fn a_rejected_error_shape_falls_back_to_internal() {
        let built: Result<GetThreadProjectionError, String> = contract_error(
            json!({"_tag": "SomethingElse", "message": "Thread t9 does not exist."}),
        );
        match rejected(built) {
            EngineError::Internal(reason) => assert!(reason.contains("Thread t9"), "{reason}"),
            EngineError::Rejected(_) => panic!("a wrong shape is not a contract error"),
        }
        assert!(matches!(
            rejected(projection_error("t1", "gone")),
            EngineError::Rejected(_)
        ));
    }
}

#[cfg(test)]
mod dispatch_error_tests {
    use super::dispatch_error_body;

    #[test]
    fn a_reason_is_message_and_detail_as_t3_sends_it() {
        let body = dispatch_error_body(
            "c",
            "message.dispatch",
            " Provider instance \"grok\" is disabled for project p. ",
        );
        assert_eq!(
            body["message"],
            "Provider instance \"grok\" is disabled for project p."
        );
        assert_eq!(body["detail"], body["message"]);
    }

    #[test]
    fn a_generic_or_empty_reason_has_no_detail() {
        for reason in [
            "",
            "  ",
            "Failed to dispatch orchestration V2 command: boom",
        ] {
            let body = dispatch_error_body("c", "x", reason);
            assert_eq!(
                body["message"],
                "Failed to dispatch orchestration V2 command"
            );
            assert!(body.get("detail").is_none());
        }
    }
}
