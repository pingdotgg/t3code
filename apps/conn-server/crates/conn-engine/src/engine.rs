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
use serde_json::{Value, json};
use tokio::sync::{oneshot, watch};

use crate::commands::{self, CommandError, Effect};
use crate::runner::LiveThread;
use crate::store::{Store, StoreResult, Tx};
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
            host: None,
            title_generator: None,
            turn_observer: None,
            checkpoints: false,
            runtime_policy_override: None,
            command_output_tap: None,
            clock: Arc::new(crate::SystemClock),
        }
    }
}

pub struct SqliteEngine {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for SqliteEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteEngine").finish_non_exhaustive()
    }
}

pub(crate) struct Inner {
    store: Arc<Mutex<Store>>,
    /// The latest committed sequence. Stream tasks wake on it and read from the store.
    pub(crate) notify: watch::Sender<u64>,
    pub(crate) providers: conn_provider::ProviderSet,
    /// Threads with an open provider session. The only per-thread state kept in memory.
    pub(crate) live: Mutex<HashMap<String, Arc<LiveThread>>>,
    pub(crate) home: PathBuf,
    pub(crate) titles: Option<Arc<dyn crate::TitleGenerator>>,
    pub(crate) observer: Option<Arc<dyn crate::TurnObserver>>,
    pub(crate) host: Option<Arc<dyn crate::EngineHost>>,
    pub(crate) idle_max_hold: Duration,
    /// Live output of running commands for `subscribeCommandOutput`; bounded, never stored.
    pub(crate) command_output: crate::output::CommandOutputHub,
    /// Set when shutdown begins; no provider session opens after it.
    pub(crate) shutting_down: std::sync::atomic::AtomicBool,
    /// Git checkpoints per turn (`checkpoint.rs`); `None` when off.
    pub(crate) checkpoints: Option<crate::checkpoint::Checkpoints>,
    /// [`EngineConfig::runtime_policy_override`].
    pub(crate) policy_override: Option<RuntimePolicyOverride>,
    /// [`EngineConfig::command_output_tap`].
    pub(crate) output_tap: Option<CommandOutputTap>,
    /// [`EngineConfig::clock`].
    pub(crate) clock: Arc<dyn crate::Clock>,
    /// [`EngineConfig::idle_session`].
    pub(crate) idle_session: Option<Duration>,
    /// One lane per thread with effects not yet done: the newest effect's number and the
    /// signal it gives when it ends. A thread's effects run one at a time, in the order they
    /// were made, as T3's effect outbox claims them (`EffectOutbox.ts`: none while one of the
    /// thread runs or an older one waits). The entry goes when its last effect ends.
    pub(crate) effect_lanes: Mutex<HashMap<String, (u64, oneshot::Receiver<()>)>>,
    /// Numbers the effects, so a lane's last effect knows it is still the last.
    pub(crate) effect_seq: std::sync::atomic::AtomicU64,
    thread_gates: crate::thread_locks::ThreadLocks,
}

/// An effect with its place in its thread's lane. Dropped without [`Self::start`] (its commit
/// failed), it gives its place up only after the effect before it ended, so the lane keeps its
/// order.
pub(crate) struct ReservedEffect {
    inner: Arc<Inner>,
    effect: Option<Effect>,
    lane: Option<String>,
    seq: u64,
    previous: Option<oneshot::Receiver<()>>,
    done: Option<oneshot::Sender<()>>,
}

impl ReservedEffect {
    /// Runs the effect once every earlier effect of its thread ended.
    pub(crate) fn start(mut self) {
        let effect = self.effect.take();
        self.spawn(effect);
    }

    fn spawn(&mut self, effect: Option<Effect>) {
        let (inner, lane, seq) = (self.inner.clone(), self.lane.take(), self.seq);
        let (previous, done) = (self.previous.take(), self.done.take());
        let task = async move {
            if let Some(previous) = previous {
                // Ends when the earlier effect ends, or its task is gone.
                let _ = previous.await;
            }
            if let Some(effect) = effect {
                inner.clone().run_effect(effect).await;
            }
            drop(done);
            if let Some(thread_id) = lane {
                let mut lanes = crate::lock(&inner.effect_lanes);
                if lanes.get(&thread_id).is_some_and(|(last, _)| *last == seq) {
                    lanes.remove(&thread_id);
                }
            }
        };
        // No runtime (a store opened outside one): nothing can run, and nothing waits.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(task);
        }
    }
}

impl Drop for ReservedEffect {
    fn drop(&mut self) {
        if self.done.is_some() {
            self.spawn(None);
        }
    }
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
    /// Opens the store, adds the configured projects, and recovers every run a previous process
    /// left active (see `restart.rs`): a turn the provider had continues in a new run.
    pub fn open(config: EngineConfig) -> Result<Self, String> {
        let home = config.home.clone().unwrap_or_else(|| {
            config
                .database
                .parent()
                .map(PathBuf::from)
                .unwrap_or_default()
        });
        let mut store = Store::open(&config.database)?;
        store.set_clock(config.clock.clone());
        store.generates_titles = config.title_generator.is_some();
        let unfinished = store.unfinished_runs()?;
        let pending_rollbacks = store.pending_rollbacks()?;
        let mut tx = store.tx()?;
        for project in &config.projects {
            tx.ensure_project(
                &project_id(&project.workspace_root),
                &project.title,
                &project.workspace_root,
            )?;
        }
        // A rollback a previous process left pending goes first: it was admitted before the
        // restart, and its lane holds the thread's next turn until it ends.
        let mut effects = vec![];
        for pending in pending_rollbacks {
            effects.extend(crate::rollback::recover_pending(&mut tx, pending)?);
        }
        for (thread_id, run) in unfinished
            .iter()
            .filter(|(_, run)| commands::is_active(run))
        {
            effects.extend(crate::restart::recover(&mut tx, thread_id, run)?);
        }
        tx.commit(None)?;
        let high = store.high_water();
        let engine = Self {
            inner: Arc::new(Inner {
                store: Arc::new(Mutex::new(store)),
                notify: watch::Sender::new(high),
                providers: config
                    .provider_set
                    .unwrap_or_else(|| config.providers.into()),
                live: Mutex::new(HashMap::new()),
                thread_gates: Default::default(),
                command_output: crate::output::CommandOutputHub::default(),
                shutting_down: std::sync::atomic::AtomicBool::new(false),
                home,
                titles: config.title_generator.clone(),
                observer: config.turn_observer.clone(),
                host: config.host.clone(),
                idle_max_hold: config.idle_max_hold,
                checkpoints: config
                    .checkpoints
                    .then(crate::checkpoint::Checkpoints::default),
                policy_override: config.runtime_policy_override.clone(),
                output_tap: config.command_output_tap.clone(),
                clock: config.clock.clone(),
                idle_session: config.idle_session,
                effect_lanes: Mutex::new(HashMap::new()),
                effect_seq: std::sync::atomic::AtomicU64::new(0),
            }),
        };
        // Continuations and the reaper start on the caller's runtime; `open` never blocks.
        if tokio::runtime::Handle::try_current().is_ok() {
            effects
                .into_iter()
                .for_each(|e| engine.inner.spawn_effect(e));
            if let Some(idle) = config.idle_session {
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
        } else if !effects.is_empty() {
            eprintln!("conn-engine: no runtime, so restarted turns do not continue");
        }
        Ok(engine)
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

    /// One atomic write. Wakes the streams when it commits.
    pub(crate) async fn write<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Tx<'_>) -> StoreResult<T> + Send + 'static,
    ) -> StoreResult<T> {
        let result = self
            .db(move |store| {
                let mut tx = store.tx()?;
                match f(&mut tx) {
                    Ok(value) => tx.commit(None).map(|seq| (value, seq)),
                    Err(e) => {
                        tx.rollback();
                        Err(e)
                    }
                }
            })
            .await;
        result.map(|(value, seq)| {
            self.notify.send_replace(seq);
            value
        })
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
        let (command, claimed) = self.claim_attachments(command).await?;
        let command = self.plan_selection(command).await?;
        let command = self.rollback_capabilities(command).await?;
        // A paused commit committed nothing: wait for access, then check everything again
        // (ownership included) in a fresh transaction.
        // Only a guarded commit can pause and retry: the ordinary path passes the command by
        // value, with no copy of its body.
        if commit_gate.is_none() {
            let result = self.dispatch_claimed(command, guard, None).await;
            if let (Err(_), Some(claimed), Some(host)) = (&result, claimed, &self.host) {
                host.release_attachments(claimed).await;
            }
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
        if let (Err(_), Some(claimed), Some(host)) = (&result, claimed, &self.host) {
            host.release_attachments(claimed).await;
        }
        result
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
        let claimed = host
            .claim_attachments(thread_id, attachments)
            .await
            .map_err(DispatchError::Rejected)?;
        if initial {
            command["initialMessage"]["attachments"] = claimed.clone();
        } else {
            command["attachments"] = claimed.clone();
        }
        Ok((command, Some(claimed)))
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
        let inner = self.clone();
        let outcome = self
            .db(move |store| {
                if let Some(seq) = store.receipt(&command_id).map_err(CommandError::Store)? {
                    if guard.is_some() {
                        // A guarded caller never gets a second accept for one command.
                        return Err(CommandError::Rejected(
                            "The command was already accepted.".into(),
                        ));
                    }
                    return Ok((vec![], seq, true));
                }
                let mut tx = store.tx().map_err(CommandError::Store)?;
                if let Some(guard) = &guard
                    && let Err(error) = crate::guard::check(&tx, guard, &command)
                {
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
                        let seq = match &commit_gate {
                            None => tx
                                .commit(Some((&command_id, &command_type)))
                                .map_err(CommandError::Store)?,
                            Some(commit_gate) => {
                                // The access decision and the commit are one step.
                                let mut pending = Some(tx);
                                let mut committed = None;
                                let decision = commit_gate.commit_if_open(&mut || {
                                    if let Some(tx) = pending.take() {
                                        committed =
                                            Some(tx.commit(Some((&command_id, &command_type))));
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
                        // Lane slots are taken under the store lock, so a thread's effects
                        // run in the order their commands committed.
                        let reserved = effects
                            .into_iter()
                            .map(|effect| inner.reserve_effect(effect))
                            .collect::<Vec<_>>();
                        Ok((reserved, seq, false))
                    }
                    Err(e) => {
                        tx.rollback();
                        Err(e)
                    }
                }
            })
            .await;
        let (effects, seq, replayed) = outcome.map_err(|e| match e {
            CommandError::Rejected(message) => DispatchError::Rejected(message),
            CommandError::Store(message) => DispatchError::Internal(message),
        })?;
        if !replayed {
            self.notify.send_replace(seq);
        }
        for effect in effects {
            effect.start();
        }
        Ok((seq, replayed))
    }

    /// Runs an effect after every earlier effect of its thread. Title generation has its own
    /// lane in T3 and runs at once here.
    pub(crate) fn spawn_effect(self: &Arc<Self>, effect: Effect) {
        self.reserve_effect(effect).start();
    }

    /// Takes the effect's place at the end of its thread's lane now; it runs once
    /// [`ReservedEffect::start`] is called and every earlier effect of the thread ended. Call it
    /// inside the store closure that commits the effect's cause, so lane order is commit order.
    pub(crate) fn reserve_effect(self: &Arc<Self>, effect: Effect) -> ReservedEffect {
        let lane = effect.lane().map(str::to_owned);
        let seq = self
            .effect_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (done, ended) = oneshot::channel::<()>();
        // The lane's tail changes now, before any later command's effect is made.
        let previous = lane.as_ref().and_then(|thread_id| {
            crate::lock(&self.effect_lanes)
                .insert(thread_id.clone(), (seq, ended))
                .map(|(_, previous)| previous)
        });
        ReservedEffect {
            inner: self.clone(),
            effect: Some(effect),
            lane,
            seq,
            previous,
            done: Some(done),
        }
    }

    async fn run_effect(self: Arc<Self>, effect: Effect) {
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
            Effect::DetachWorkspace { thread_id } => self.close_workspace_session(&thread_id).await,
            Effect::ApplyModelSelection {
                thread_id,
                selection,
            } => self.apply_model_selection(&thread_id, selection).await,
            Effect::CleanupHtmlAttachments { ids, .. } => {
                if let Some(host) = &self.host {
                    host.cleanup_html_attachments(ids).await;
                }
            }
            Effect::ThreadClosed { thread_id, reason } => {
                if let Some(host) = &self.host {
                    host.thread_closed(&thread_id, reason);
                }
            }
            Effect::GenerateTitle {
                thread_id,
                request_id,
                regenerate,
            } => self.generate_title(thread_id, request_id, regenerate).await,
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
    ) -> Result<crate::ProvisionedWorktree, (String, bool)> {
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
        host.provision_worktree(crate::WorktreeRequest {
            thread_id: thread_id.to_owned(),
            project_root: root,
            base_ref: strategy["baseRef"].as_str().unwrap_or("HEAD").to_owned(),
            branch: strategy["branch"].as_str().map(str::to_owned),
            start_from_origin: strategy["startFromOrigin"] == true,
        })
        .await
        .map_err(|e| (e, false))
    }

    async fn launch(self: &Arc<Self>, input: Value) -> Result<Value, (String, bool)> {
        let command_id = input["commandId"].as_str().unwrap_or_default().to_owned();
        let thread_id = input["threadId"]
            .as_str()
            .map_or_else(|| format!("thread:{command_id}"), str::to_owned);
        let strategy = &input["workspaceStrategy"];
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
                    let made = self.provision_worktree(&thread_id, &input).await?;
                    (json!(made.branch), json!(made.path))
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
        let creation_source = input["creationSource"].as_str().unwrap_or("web").to_owned();
        // `ThreadLaunchService` records the launch's own actor (a scheduled task's creator).
        let created_by = input["createdBy"].as_str().unwrap_or("user").to_owned();
        let to_err = |e: DispatchError| match e {
            DispatchError::Rejected(message) => (message, false),
            DispatchError::Internal(message) => (message, true),
        };
        let mut resumed = false;
        if input["reuseExistingThread"] == true {
            let id = thread_id.clone();
            let exists = self
                .db(move |store| store.thread_exists(&id))
                .await
                .map_err(|e| (e, true))?;
            if !exists {
                return Err((format!("Thread {thread_id} does not exist."), false));
            }
        } else {
            let (_, replayed) = self
                .dispatch_value(json!({
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
                }))
                .await
                .map_err(to_err)?;
            resumed = replayed;
        }
        let mut sequence = None;
        if let Some(message) = input.get("initialMessage").filter(|m| m.is_object()) {
            let message_command = format!("{command_id}:initial-message");
            let mut command = json!({
                "type": "message.dispatch",
                "commandId": message_command,
                "threadId": thread_id,
                "messageId": message["messageId"].as_str().map_or_else(|| format!("message:{command_id}"), str::to_owned),
                "text": message["text"],
                "attachments": message["attachments"],
                "modelSelection": input["modelSelection"],
                "dispatchMode": {"type": "start_immediately"},
                "createdBy": created_by,
                "creationSource": creation_source,
            });
            if let Some(task) = message["scheduledTaskId"].as_str() {
                command["scheduledTaskId"] = json!(task);
            }
            if message["context"].is_object() {
                command["context"] = message["context"].clone();
            }
            if input["generateTitle"] == true {
                command["titleSeed"] = input["title"].clone();
            }
            let (seq, replayed) = self.dispatch_value(command).await.map_err(to_err)?;
            sequence = Some(seq);
            resumed = replayed;
        }
        let id = thread_id.clone();
        let projection = self
            .db(move |store| store.thread_projection(&id))
            .await
            .map_err(|e| (e, true))?
            .ok_or_else(|| (format!("Thread {thread_id} does not exist."), false))?;
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
    fn provider_instance_enabled(&self, project_id: &str, instance_id: &str) -> bool {
        self.inner
            .host
            .as_ref()
            .is_none_or(|host| host.provider_instance_enabled(Some(project_id), instance_id))
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
            match self.inner.dispatch_value(command.clone()).await {
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

    fn launch_thread(&self, input: Value) -> BoxFuture<'_, Result<Value, EngineError<Value>>> {
        Box::pin(async move {
            // `ThreadLaunchService` asks `assertProviderInstanceEnabled` before it makes the
            // thread, so a refused launch leaves no thread behind.
            if let Some(host) = &self.inner.host
                && let (Some(project), Some(instance)) = (
                    input["projectId"].as_str(),
                    input["modelSelection"]["instanceId"].as_str(),
                )
                && !host.provider_instance_enabled(Some(project), instance)
            {
                return Err(EngineError::Rejected(json!({
                    "_tag": "OrchestrationV2ThreadLaunchError",
                    "commandId": input["commandId"],
                    "projectId": input["projectId"],
                    "message": format!(
                        "Provider instance \"{instance}\" is disabled for project {project}."
                    ),
                })));
            }
            self.inner
                .launch(input.clone())
                .await
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
        Box::pin(self.inner.close_all_sessions())
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
    tx: &crate::store::Tx<'_>,
    command: &Value,
) -> crate::store::StoreResult<Option<(Option<String>, String)>> {
    let text = |v: &Value| v.as_str().map(str::to_owned);
    let thread_id = match command["type"].as_str().unwrap_or("") {
        "delegated_task.request" => &command["parentThreadId"],
        "thread.metadata.update" if command.get("continuation").is_none() => return Ok(None),
        "message.dispatch"
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
        "thread.metadata.update" => text(&thread["modelSelection"]["instanceId"]),
        _ => match command["runId"].as_str() {
            Some(run_id) => tx
                .entity(thread_id, "runs", run_id)?
                .and_then(|run| text(&run["providerInstanceId"])),
            None => None,
        },
    };
    Ok(instance.map(|instance| (project, instance)))
}

#[cfg(test)]
impl Inner {
    pub(crate) fn live_count(&self) -> usize {
        crate::lock(&self.live).len()
    }
}

#[cfg(test)]
impl SqliteEngine {
    pub(crate) fn inner(&self) -> &Arc<Inner> {
        &self.inner
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
