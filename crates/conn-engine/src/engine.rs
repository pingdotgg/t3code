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
use tokio::sync::watch;

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
    /// `claude` child holds about 140 MiB). Default 10 minutes; `None` keeps sessions open.
    pub idle_session: Option<Duration>,
    /// Generates thread titles. Without one, a new thread keeps the title the client sent.
    pub title_generator: Option<Arc<dyn crate::TitleGenerator>>,
    /// Sees every turn start and end (checkpoints). None by default.
    pub turn_observer: Option<Arc<dyn crate::TurnObserver>>,
}

impl EngineConfig {
    pub fn new(database: impl Into<PathBuf>) -> Self {
        Self {
            database: database.into(),
            home: None,
            projects: vec![],
            providers: vec![],
            stream_flush: Duration::from_millis(100),
            idle_session: Some(Duration::from_secs(600)),
            title_generator: None,
            turn_observer: None,
        }
    }
}

pub struct SqliteEngine {
    inner: Arc<Inner>,
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
                stream_flush: config.stream_flush,
                home,
                titles: config.title_generator.clone(),
                observer: config.turn_observer.clone(),
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

    /// The project id the engine gives a configured folder.
    pub fn project_id_for(workspace_root: &str) -> String {
        project_id(workspace_root)
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
            let mut guard = store
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
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

    pub(crate) fn spawn_effect(self: &Arc<Self>, effect: Effect) {
        let inner = self.clone();
        tokio::spawn(async move { inner.run_effect(effect).await });
    }

    async fn run_effect(self: Arc<Self>, effect: Effect) {
        match effect {
            Effect::StartTurn { thread_id, run_id } => self.start_turn(thread_id, run_id).await,
            Effect::Steer {
                thread_id,
                run_id,
                message_id,
            } => self.steer(thread_id, run_id, message_id).await,
            Effect::Interrupt { thread_id, run_id } => self.interrupt(thread_id, run_id).await,
            Effect::Respond { thread_id, request } => self.respond(thread_id, request).await,
            Effect::CloseSession { thread_id } => self.close_session(&thread_id).await,
            Effect::GenerateTitle {
                thread_id,
                request_id,
                regenerate,
            } => self.generate_title(thread_id, request_id, regenerate).await,
        }
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
                    "createdBy": "user",
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
                "createdBy": "user",
                "creationSource": creation_source,
            });
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

fn projection_error(thread_id: &str, message: impl Into<String>) -> GetThreadProjectionError {
    from_json(json!({
        "_tag": "OrchestrationV2GetThreadProjectionError",
        "threadId": thread_id,
        "message": message.into(),
    }))
    .expect("error shape")
}

impl Engine for SqliteEngine {
    fn dispatch(
        &self,
        command: Command,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>> {
        Box::pin(async move {
            let command = to_json(&command);
            let rejected = |message: String| -> DispatchCommandError {
                from_json(json!({
                    "_tag": "OrchestrationV2DispatchCommandError",
                    "commandId": command["commandId"].as_str().unwrap_or(""),
                    "commandType": command["type"].as_str().unwrap_or(""),
                    "message": message,
                }))
                .expect("error shape")
            };
            match self.inner.dispatch_value(command.clone()).await {
                Ok((sequence, _)) => from_json(json!({"sequence": sequence}))
                    .map_err(|e| EngineError::Internal(e.to_string())),
                Err(DispatchError::Rejected(message)) => {
                    Err(EngineError::Rejected(rejected(message)))
                }
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
                Ok(None) => Err(EngineError::Rejected(projection_error(
                    thread_id.as_str(),
                    format!("Thread {thread_id} does not exist."),
                ))),
                Err(e) => Err(EngineError::Internal(e)),
            }
        })
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
        self.live.lock().map_or(0, |live| live.len())
    }
}

#[cfg(test)]
impl SqliteEngine {
    pub(crate) fn inner(&self) -> &Arc<Inner> {
        &self.inner
    }
}
