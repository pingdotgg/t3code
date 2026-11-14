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
    /// How long streamed assistant text may wait before it is written. Default 100 ms.
    pub stream_flush: Duration,
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
            .field("stream_flush", &self.stream_flush)
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
            stream_flush: Duration::from_millis(100),
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
    pub(crate) providers: Vec<Arc<dyn Provider>>,
    /// Threads with an open provider session. The only per-thread state kept in memory.
    pub(crate) live: Mutex<HashMap<String, Arc<LiveThread>>>,
    pub(crate) stream_flush: Duration,
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
        let mut tx = store.tx()?;
        for project in &config.projects {
            tx.ensure_project(
                &project_id(&project.workspace_root),
                &project.title,
                &project.workspace_root,
            )?;
        }
        let mut effects = vec![];
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
                providers: config.providers,
                live: Mutex::new(HashMap::new()),
                command_output: crate::output::CommandOutputHub::default(),
                shutting_down: std::sync::atomic::AtomicBool::new(false),
                stream_flush: config.stream_flush,
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
}

pub(crate) enum DispatchError {
    Rejected(String),
    Internal(String),
}

impl Inner {
    /// Runs `f` on the store on the blocking pool, so SQLite never stalls the event loop.
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
        let (command, claimed) = self.claim_attachments(command).await?;
        let command = self.plan_selection(command).await?;
        let result = self.dispatch_claimed(command).await;
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
                let provider = self
                    .providers
                    .iter()
                    .find(|p| p.instance_id().as_str() == instance);
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

    /// A new message's pending uploads become the thread's files before the message is
    /// written (`AttachmentStore` claim). A retried command keeps what it claimed first.
    async fn claim_attachments(
        &self,
        mut command: Value,
    ) -> Result<(Value, Option<Value>), DispatchError> {
        let Some(host) = &self.host else {
            return Ok((command, None));
        };
        if command["type"] != "message.dispatch"
            || command["attachments"].as_array().is_none_or(Vec::is_empty)
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
        let claimed = host
            .claim_attachments(thread_id, command["attachments"].take())
            .await
            .map_err(DispatchError::Rejected)?;
        command["attachments"] = claimed.clone();
        Ok((command, Some(claimed)))
    }

    async fn dispatch_claimed(
        self: &Arc<Self>,
        command: Value,
    ) -> Result<(u64, bool), DispatchError> {
        let command_type = command["type"].as_str().unwrap_or_default().to_owned();
        let Some(command_id) = command["commandId"].as_str().map(str::to_owned) else {
            return Err(DispatchError::Rejected(
                "The command has no commandId.".into(),
            ));
        };
        let Some(handler) = commands::handler(&command_type) else {
            return Err(DispatchError::Rejected(
                commands::refusal(&command_type).to_owned(),
            ));
        };
        let outcome = self
            .db(move |store| {
                if let Some(seq) = store.receipt(&command_id).map_err(CommandError::Store)? {
                    return Ok((vec![], seq, true));
                }
                let mut tx = store.tx().map_err(CommandError::Store)?;
                match handler(&mut tx, command) {
                    Ok(effects) => {
                        let seq = tx
                            .commit(Some((&command_id, &command_type)))
                            .map_err(CommandError::Store)?;
                        Ok((effects, seq, false))
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
            self.spawn_effect(effect);
        }
        Ok((seq, replayed))
    }

    /// Runs an effect after every earlier effect of its thread. Title generation has its own
    /// lane in T3 and runs at once here.
    pub(crate) fn spawn_effect(self: &Arc<Self>, effect: Effect) {
        let inner = self.clone();
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
        tokio::spawn(async move {
            if let Some(previous) = previous {
                // Ends when the earlier effect ends, or its task is gone.
                let _ = previous.await;
            }
            inner.clone().run_effect(effect).await;
            drop(done);
            if let Some(thread_id) = lane {
                let mut lanes = crate::lock(&inner.effect_lanes);
                if lanes.get(&thread_id).is_some_and(|(last, _)| *last == seq) {
                    lanes.remove(&thread_id);
                }
            }
        });
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
            Effect::Respond { thread_id, request } => self.respond(thread_id, request).await,
            Effect::CloseSession { thread_id } => self.close_session(&thread_id).await,
            Effect::ApplyModelSelection {
                thread_id,
                selection,
            } => self.apply_model_selection(&thread_id, selection).await,
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
    fn dispatch(
        &self,
        command: Command,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>> {
        Box::pin(async move {
            let command = to_json(&command);
            let refusal = |message: String| -> Result<DispatchCommandError, String> {
                contract_error(json!({
                    "_tag": "OrchestrationV2DispatchCommandError",
                    "commandId": command["commandId"].as_str().unwrap_or(""),
                    "commandType": command["type"].as_str().unwrap_or(""),
                    "message": message,
                }))
            };
            match self.inner.dispatch_value(command.clone()).await {
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
