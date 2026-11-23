//! [`ConnCore`] lifecycle, event pump, thread actions, and [`CoreListener`] foreign callback trait.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use conn_client::commands::{SECRETS_ANSWER_REQUEST, WorkspaceStrategyChoice};
use conn_client::{ClientEvent, Connection, ServerConfig};
use conn_contract::{
    OrchestrationV2Command, OrchestrationV2ThreadLaunchResult, OrchestrationV2ThreadProjection,
    OrchestrationV2ThreadStreamItem,
};
use conn_state::{ShellState, ThreadActivity, ThreadState};
use serde_json::json;
use tokio::sync::{mpsc, oneshot, watch};
use tracing::warn;

use crate::coalesce::SnapshotCoalescer;
use crate::types::{
    FfiApprovalDecision, FfiConnectionStatus, FfiCredential, FfiError, FfiSendMode,
    FfiShellSnapshot, FfiThreadSnapshot, FfiUserInputSubmission, ThreadSnapshotMeta,
    build_shell_snapshot, build_thread_snapshot,
};

const TAG_SUBSCRIBE_SHELL: &str = "orchestration.subscribeShell";
const TAG_SUBSCRIBE_THREAD: &str = "orchestration.subscribeThread";
const TAG_LAUNCH_THREAD: &str = "orchestration.launchThread";
const TAG_ENSURE_SCRATCH: &str = "projects.ensureScratch";
/// Maximum time `Drop` waits for worker threads to wind down when dropped off-runtime.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

/// Foreign callback listener implemented in Swift to receive state updates from [`ConnCore`].
///
/// Every method is called with no internal locks held. Shell and thread snapshot callbacks are
/// coalesced to at most one call per 50 ms window per channel, always flushing the latest state.
#[uniffi::export(with_foreign)]
pub trait CoreListener: Send + Sync {
    fn on_status(&self, status: FfiConnectionStatus);
    fn on_bearer_issued(&self, token: String);
    fn on_shell(&self, snapshot: FfiShellSnapshot);
    fn on_thread(&self, snapshot: FfiThreadSnapshot);
    fn on_error(&self, message: String);
}

#[derive(Clone, Debug, Default)]
struct ThreadRunMeta {
    working: bool,
    active_run_id: Option<String>,
}

struct LaunchDefaults {
    model_selection: serde_json::Value,
    runtime_mode: String,
    interaction_mode: String,
}

enum PumpControl {
    OpenThread(String),
    CloseThread(String),
    ResolveLaunchDefaults {
        project_id: String,
        reply: oneshot::Sender<LaunchDefaults>,
    },
    ApplyLaunchedThread {
        thread_id: String,
        projection: Box<Option<OrchestrationV2ThreadProjection>>,
        sequence: Option<i64>,
        reply: oneshot::Sender<()>,
    },
    Shutdown,
}

/// UniFFI handle to a running `conn-server` connection, state reducer, and Tokio runtime.
#[derive(uniffi::Object)]
pub struct ConnCore {
    runtime: Option<tokio::runtime::Runtime>,
    runtime_handle: tokio::runtime::Handle,
    server_url: String,
    connection: Connection,
    ctrl_tx: mpsc::UnboundedSender<PumpControl>,
    /// Tracks whether each known thread currently has an active run and its `active_run_id`,
    /// so [`Self::send_message`] chooses `start_immediately` / `queue_after_active` /
    /// `steer_active` without blocking the pump task.
    thread_runs: Arc<RwLock<HashMap<String, ThreadRunMeta>>>,
    shell_watch: watch::Receiver<Option<FfiShellSnapshot>>,
    status_watch: watch::Receiver<FfiConnectionStatus>,
    disconnected: AtomicBool,
}

impl fmt::Debug for ConnCore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnCore")
            .field("connection", &self.connection)
            .field("disconnected", &self.disconnected.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl Drop for ConnCore {
    fn drop(&mut self) {
        self.disconnect();
        if let Some(runtime) = self.runtime.take() {
            if tokio::runtime::Handle::try_current().is_ok() {
                // Dropping a Tokio Runtime inside a Tokio worker panics; shut down in background.
                runtime.shutdown_background();
            } else {
                runtime.shutdown_timeout(SHUTDOWN_TIMEOUT);
            }
        }
    }
}

impl ConnCore {
    fn thread_run_meta(&self, thread_id: &str) -> ThreadRunMeta {
        self.thread_runs
            .read()
            .ok()
            .and_then(|map| map.get(thread_id).cloned())
            .unwrap_or_default()
    }

    fn ensure_connected(&self) -> Result<(), FfiError> {
        if self.disconnected.load(Ordering::Acquire) {
            Err(FfiError::Closed)
        } else {
            Ok(())
        }
    }

    async fn dispatch_command(&self, command: OrchestrationV2Command) -> Result<(), FfiError> {
        self.ensure_connected()?;
        let connection = self.connection.clone();
        self.runtime_handle
            .spawn(async move { connection.dispatch_command(command).await })
            .await
            .map_err(|_| FfiError::Closed)?
            .map(|_| ())
            .map_err(FfiError::from)
    }

    async fn call_json(
        &self,
        tag: &'static str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, FfiError> {
        self.ensure_connected()?;
        let connection = self.connection.clone();
        self.runtime_handle
            .spawn(async move { connection.call_json(tag, payload).await })
            .await
            .map_err(|_| FfiError::Closed)?
            .map_err(FfiError::from)
    }

    /// Waits for `orchestration.subscribeShell` to synchronize and returns the project id whose
    /// `workspace_root` matches `preferred_workspace_root` (e.g. `"/srv/workspace"`), falling back
    /// to the first non-archived project if any exist.
    pub(crate) async fn wait_for_project(
        &self,
        preferred_workspace_root: &str,
        timeout: Duration,
    ) -> Result<String, FfiError> {
        self.ensure_connected()?;
        let mut shell_rx = self.shell_watch.clone();
        let mut status_rx = self.status_watch.clone();
        let preferred = preferred_workspace_root.trim_end_matches('/').to_owned();

        self.runtime_handle
            .spawn(async move {
                let deadline = tokio::time::Instant::now() + timeout;
                loop {
                    if let FfiConnectionStatus::Failed { message } = status_rx.borrow().clone() {
                        return Err(FfiError::Connection { message });
                    }
                    if let Some(shell) = shell_rx.borrow().clone()
                        && shell.synchronized
                    {
                        if let Some(project) = shell.projects.iter().find(|p| {
                            p.workspace_root.trim_end_matches('/') == preferred
                        }) {
                            return Ok(project.id.clone());
                        }
                        if let Some(first) = shell.projects.first() {
                            return Ok(first.id.clone());
                        }
                    }

                    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                    if remaining.is_zero() {
                        return Err(FfiError::Connection {
                            message: "timed out waiting for server project catalog".to_owned(),
                        });
                    }

                    tokio::select! {
                        res = tokio::time::timeout(remaining, shell_rx.changed()) => {
                            match res {
                                Ok(Ok(())) => {}
                                Ok(Err(_)) => return Err(FfiError::Closed),
                                Err(_) => {
                                    return Err(FfiError::Connection {
                                        message: "timed out waiting for server project catalog".to_owned(),
                                    });
                                }
                            }
                        }
                        res = status_rx.changed() => {
                            if res.is_err() {
                                return Err(FfiError::Closed);
                            }
                        }
                    }
                }
            })
            .await
            .map_err(|_| FfiError::Closed)?
    }
}

fn map_build_error(what: &str, err: serde_json::Error) -> FfiError {
    FfiError::Rpc {
        message: format!("failed to build {what} command: {err}"),
    }
}

#[uniffi::export]
impl ConnCore {
    /// Connects to `server_url` with `credential`, subscribes to `orchestration.subscribeShell`,
    /// and starts pumping state snapshots to `listener`.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::InvalidUrl`] if `server_url` is not a valid `http` or `https` URL,
    /// or [`FfiError::Connection`] if the background Tokio runtime cannot be created.
    #[uniffi::constructor]
    pub fn connect(
        server_url: String,
        credential: FfiCredential,
        listener: Arc<dyn CoreListener>,
    ) -> Result<Arc<Self>, FfiError> {
        let http_base_url = parse_server_url(&server_url)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("conn-ffi")
            .enable_all()
            .build()
            .map_err(|err| FfiError::Connection {
                message: format!("failed to build tokio runtime: {err}"),
            })?;

        let runtime_handle = runtime.handle().clone();
        let normalized_url = http_base_url.to_string();
        let config = ServerConfig {
            http_base_url,
            credential: credential.into(),
        };
        let (connection, events_rx) = Connection::start(config, &runtime_handle);
        connection.subscribe_shell();

        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
        let thread_runs = Arc::new(RwLock::new(HashMap::new()));
        let (shell_watch_tx, shell_watch) = watch::channel(None);
        let (status_watch_tx, status_watch) = watch::channel(FfiConnectionStatus::Connecting);

        runtime_handle.spawn(run_pump(
            connection.clone(),
            events_rx,
            ctrl_rx,
            listener,
            Arc::clone(&thread_runs),
            shell_watch_tx,
            status_watch_tx,
        ));

        Ok(Arc::new(Self {
            runtime: Some(runtime),
            runtime_handle,
            server_url: normalized_url,
            connection,
            ctrl_tx,
            thread_runs,
            shell_watch,
            status_watch,
            disconnected: AtomicBool::new(false),
        }))
    }

    /// Returns the normalized HTTP base URL this connection targets.
    #[must_use]
    pub fn server_url(&self) -> String {
        self.server_url.clone()
    }

    /// Loads and subscribes to `thread_id`, emitting snapshots to [`CoreListener::on_thread`].
    pub fn open_thread(&self, thread_id: String) {
        if self.disconnected.load(Ordering::Acquire) {
            return;
        }
        let _ = self.ctrl_tx.send(PumpControl::OpenThread(thread_id));
    }

    /// Unsubscribes from `thread_id` while retaining its cached timeline for fast re-open.
    pub fn close_thread(&self, thread_id: String) {
        if self.disconnected.load(Ordering::Acquire) {
            return;
        }
        let _ = self.ctrl_tx.send(PumpControl::CloseThread(thread_id));
    }

    /// Dispatches a user message to `thread_id` via `orchestration.dispatchCommand`.
    ///
    /// Mirrors desktop `SendDispatch`: when the thread is idle, starts immediately; while working,
    /// [`FfiSendMode::Steer`] steers the active run (`steer_active`), and [`FfiSendMode::Auto`] /
    /// [`FfiSendMode::Queue`] queue after the active run (`queue_after_active`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn send_message(
        &self,
        thread_id: String,
        text: String,
        mode: FfiSendMode,
    ) -> Result<(), FfiError> {
        self.ensure_connected()?;
        let meta = self.thread_run_meta(&thread_id);
        let steer_target = if meta.working && mode == FfiSendMode::Steer {
            meta.active_run_id.as_deref()
        } else {
            None
        };
        let command =
            conn_client::commands::send_message(&thread_id, &text, &[], meta.working, steer_target)
                .map_err(|err| map_build_error("message.dispatch", err))?;
        self.dispatch_command(command).await
    }

    /// Answers a pending approval request (`runtime-request.respond`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn respond_approval(
        &self,
        thread_id: String,
        request_id: String,
        decision: FfiApprovalDecision,
    ) -> Result<(), FfiError> {
        let command =
            conn_client::commands::respond_approval(&thread_id, &request_id, decision.as_wire())
                .map_err(|err| map_build_error("runtime-request.respond", err))?;
        self.dispatch_command(command).await
    }

    /// Submits answers for a pending `user_input_request` (`runtime-request.respond`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn respond_user_input(
        &self,
        thread_id: String,
        request_id: String,
        answers: Vec<FfiUserInputSubmission>,
    ) -> Result<(), FfiError> {
        let map: serde_json::Map<String, serde_json::Value> = answers
            .into_iter()
            .map(|entry| (entry.question_id, entry.value.to_json()))
            .collect();
        let command = conn_client::commands::respond_user_input(&thread_id, &request_id, &map)
            .map_err(|err| map_build_error("runtime-request.respond", err))?;
        self.dispatch_command(command).await
    }

    /// Dismisses a message-mode `user_input_request` without answering it
    /// (`thread.user-input.dismiss`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn dismiss_user_input(
        &self,
        thread_id: String,
        request_id: String,
    ) -> Result<(), FfiError> {
        let command = conn_client::commands::dismiss_user_input(&thread_id, &request_id)
            .map_err(|err| map_build_error("thread.user-input.dismiss", err))?;
        self.dispatch_command(command).await
    }

    /// Saves or declines a pending secret request (`secrets.answerRequest`).
    ///
    /// Pass `Some(secret)` to save (trimmed; blank strings are rejected) or `None` to decline.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::InvalidInput`] if a saved secret is blank, [`FfiError::Closed`] if
    /// disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn answer_secret_request(
        &self,
        thread_id: String,
        turn_item_id: String,
        secret: Option<String>,
    ) -> Result<(), FfiError> {
        let payload = conn_client::commands::secret_answer_payload(
            &thread_id,
            &turn_item_id,
            secret.as_deref(),
        )
        .ok_or_else(|| FfiError::InvalidInput {
            message: "secret value must not be empty".to_owned(),
        })?;
        self.call_json(SECRETS_ANSWER_REQUEST, payload)
            .await
            .map(|_| ())
    }

    /// Stops the running turn on `thread_id` (`thread.stop`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn stop_thread(&self, thread_id: String) -> Result<(), FfiError> {
        let command = conn_client::commands::stop_thread(&thread_id)
            .map_err(|err| map_build_error("thread.stop", err))?;
        self.dispatch_command(command).await
    }

    /// Moves `thread_id` into (`settled = true`) or out of (`settled = false`) the Settled shelf
    /// (`thread.settle` / `thread.unsettle`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn settle_thread(&self, thread_id: String, settled: bool) -> Result<(), FfiError> {
        let command = conn_client::commands::settle_thread(&thread_id, settled)
            .map_err(|err| map_build_error("thread.settle", err))?;
        self.dispatch_command(command).await
    }

    /// Pins (`pinned = true`) or unpins (`pinned = false`) `thread_id` (`thread.pin` /
    /// `thread.unpin`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn pin_thread(&self, thread_id: String, pinned: bool) -> Result<(), FfiError> {
        let command = conn_client::commands::pin_thread(&thread_id, pinned)
            .map_err(|err| map_build_error("thread.pin", err))?;
        self.dispatch_command(command).await
    }

    /// Renames `thread_id` to `title` (`thread.metadata.update`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn rename_thread(&self, thread_id: String, title: String) -> Result<(), FfiError> {
        let command = conn_client::commands::rename_thread(&thread_id, &title)
            .map_err(|err| map_build_error("thread.metadata.update", err))?;
        self.dispatch_command(command).await
    }

    /// Permanently deletes `thread_id` (`thread.delete`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn delete_thread(&self, thread_id: String) -> Result<(), FfiError> {
        let command = conn_client::commands::delete_thread(&thread_id)
            .map_err(|err| map_build_error("thread.delete", err))?;
        self.dispatch_command(command).await
    }

    /// Marks `thread_id` unread so it appears as unseen (`thread.mark-unread`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn mark_thread_unread(&self, thread_id: String) -> Result<(), FfiError> {
        let command = conn_client::commands::mark_thread_unread(&thread_id)
            .map_err(|err| map_build_error("thread.mark-unread", err))?;
        self.dispatch_command(command).await
    }

    /// Creates a new thread in `project_id` with `text` as its first message via
    /// `orchestration.launchThread`, applies the returned projection, subscribes to the new
    /// thread, and returns the created thread id.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn launch_thread(
        &self,
        project_id: String,
        text: String,
    ) -> Result<String, FfiError> {
        self.ensure_connected()?;

        let (defaults_tx, defaults_rx) = oneshot::channel();
        self.ctrl_tx
            .send(PumpControl::ResolveLaunchDefaults {
                project_id: project_id.clone(),
                reply: defaults_tx,
            })
            .map_err(|_| FfiError::Closed)?;
        let defaults = defaults_rx.await.map_err(|_| FfiError::Closed)?;

        let thread_id = conn_client::commands::new_thread_id();
        let payload = conn_client::commands::launch_thread_payload(
            &thread_id,
            &project_id,
            &text,
            &[],
            defaults.model_selection,
            &defaults.runtime_mode,
            &defaults.interaction_mode,
            WorkspaceStrategyChoice::Local,
        );

        let value = self.call_json(TAG_LAUNCH_THREAD, payload).await?;
        let parsed = conn_contract::from_json::<OrchestrationV2ThreadLaunchResult>(value.clone());
        let (final_thread_id, projection, sequence) = match parsed {
            Ok(res) => (res.thread_id, Some(res.projection), res.sequence),
            Err(_) => {
                let fallback_id = value
                    .get("threadId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&thread_id)
                    .to_owned();
                (fallback_id, None, None)
            }
        };

        let (apply_tx, apply_rx) = oneshot::channel();
        self.ctrl_tx
            .send(PumpControl::ApplyLaunchedThread {
                thread_id: final_thread_id.clone(),
                projection: Box::new(projection),
                sequence,
                reply: apply_tx,
            })
            .map_err(|_| FfiError::Closed)?;
        let _ = apply_rx.await;

        Ok(final_thread_id)
    }

    /// Ensures the server's General / scratch project (`projects.ensureScratch`, `"No project"`)
    /// exists and returns its `project_id`.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn ensure_scratch_project(&self) -> Result<String, FfiError> {
        let value = self.call_json(TAG_ENSURE_SCRATCH, json!({})).await?;
        value
            .get("projectId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| FfiError::Rpc {
                message: "projects.ensureScratch did not return a projectId".to_owned(),
            })
    }

    /// Launches a General (project-unbound) thread on this server by ensuring the scratch project
    /// (`projects.ensureScratch`) and calling [`Self::launch_thread`].
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn launch_general_thread(&self, text: String) -> Result<String, FfiError> {
        let project_id = self.ensure_scratch_project().await?;
        self.launch_thread(project_id, text).await
    }

    /// Drops the active socket or reconnect backoff and reconnects immediately (e.g. when the
    /// iOS app returns to the foreground).
    pub fn reconnect(&self) {
        if self.disconnected.load(Ordering::Acquire) {
            return;
        }
        self.connection.reconnect();
    }

    /// Closes the connection and stops the background event pump. Safe to call more than once.
    pub fn disconnect(&self) {
        if self.disconnected.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.ctrl_tx.send(PumpControl::Shutdown);
        self.connection.close();
    }
}

fn parse_server_url(raw: &str) -> Result<url::Url, FfiError> {
    let url = url::Url::parse(raw.trim()).map_err(|err| FfiError::InvalidUrl {
        message: err.to_string(),
    })?;
    match url.scheme() {
        "http" | "https" if url.has_host() => Ok(url),
        _ => Err(FfiError::InvalidUrl {
            message: format!("expected http:// or https:// URL with host, got `{raw}`"),
        }),
    }
}

struct PumpState {
    connection: Connection,
    listener: Arc<dyn CoreListener>,
    shell: ShellState,
    threads: HashMap<String, ThreadState>,
    thread_projection_meta: HashMap<String, ThreadSnapshotMeta>,
    open_threads: HashSet<String>,
    ended_threads: HashSet<String>,
    shell_snapshot_required: bool,
    coalescer: SnapshotCoalescer,
    thread_runs: Arc<RwLock<HashMap<String, ThreadRunMeta>>>,
    shell_watch: watch::Sender<Option<FfiShellSnapshot>>,
    status_watch: watch::Sender<FfiConnectionStatus>,
}

impl PumpState {
    fn resolve_thread_meta(&self, thread_id: &str) -> Option<ThreadSnapshotMeta> {
        self.shell
            .find_thread(thread_id)
            .map(ThreadSnapshotMeta::from_shell)
            .or_else(|| self.thread_projection_meta.get(thread_id).cloned())
    }

    fn resolve_launch_defaults(&self, project_id: &str) -> LaunchDefaults {
        let template = self.shell.threads_for_project(project_id).next();
        let model_selection = self
            .shell
            .project(project_id)
            .and_then(|p| p.default_model_selection.as_ref())
            .or_else(|| template.map(|t| &t.model_selection))
            .or_else(|| self.shell.threads.first().map(|t| &t.model_selection))
            .or_else(|| {
                self.shell
                    .archived_threads
                    .first()
                    .map(|t| &t.model_selection)
            })
            .map(conn_contract::to_json)
            .unwrap_or_else(|| json!({ "instanceId": "claudeAgent", "model": "haiku" }));

        let runtime_mode = template
            .map(|t| conn_contract::to_json(&t.runtime_mode))
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "full-access".to_owned());

        let interaction_mode = template
            .map(|t| conn_contract::to_json(&t.interaction_mode))
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "default".to_owned());

        LaunchDefaults {
            model_selection,
            runtime_mode,
            interaction_mode,
        }
    }

    fn update_thread_run_meta(&self, thread_id: &str, state: &ThreadState) {
        if let Ok(mut guard) = self.thread_runs.write() {
            guard.insert(
                thread_id.to_owned(),
                ThreadRunMeta {
                    working: state.working,
                    active_run_id: state.active_run_id().map(str::to_owned),
                },
            );
        }
    }

    fn sync_shell_run_meta(&self) {
        if let Ok(mut guard) = self.thread_runs.write() {
            for thread in &self.shell.threads {
                // Keep live ThreadState authoritative for subscribed threads.
                if self.threads.contains_key(&thread.id) {
                    continue;
                }
                guard.insert(
                    thread.id.clone(),
                    ThreadRunMeta {
                        working: self.shell.activity(&thread.id) == ThreadActivity::Working,
                        active_run_id: thread.active_run_id.clone(),
                    },
                );
            }
        }
    }

    fn handle_control(&mut self, ctrl: PumpControl) -> bool {
        match ctrl {
            PumpControl::OpenThread(thread_id) => {
                let is_newly_opened = self.open_threads.insert(thread_id.clone());
                self.ended_threads.remove(&thread_id);
                let meta = self.resolve_thread_meta(&thread_id);
                let cached_snapshot = self
                    .threads
                    .get(&thread_id)
                    .filter(|state| state.synchronized || !state.entries.is_empty())
                    .map(|state| build_thread_snapshot(state, meta.as_ref()));
                self.threads
                    .entry(thread_id.clone())
                    .or_insert_with(|| ThreadState::new(thread_id.clone()));
                if is_newly_opened {
                    self.connection.subscribe_thread(&thread_id);
                }
                if let Some(snapshot) = cached_snapshot {
                    self.emit_or_buffer_thread(snapshot);
                }
                true
            }
            PumpControl::CloseThread(thread_id) => {
                let was_open = self.open_threads.remove(&thread_id);
                self.ended_threads.remove(&thread_id);
                self.coalescer.cancel_thread(&thread_id);
                if was_open {
                    self.connection.unsubscribe_thread(&thread_id);
                }
                true
            }
            PumpControl::ResolveLaunchDefaults { project_id, reply } => {
                let defaults = self.resolve_launch_defaults(&project_id);
                let _ = reply.send(defaults);
                true
            }
            PumpControl::ApplyLaunchedThread {
                thread_id,
                projection,
                sequence,
                reply,
            } => {
                if let Some(projection) = *projection {
                    self.thread_projection_meta.insert(
                        thread_id.clone(),
                        ThreadSnapshotMeta::from_app_thread(&projection.thread),
                    );
                    let mut state = ThreadState::new(thread_id.clone());
                    state.apply_projection(projection, sequence);
                    self.update_thread_run_meta(&thread_id, &state);
                    let meta = self.resolve_thread_meta(&thread_id);
                    let snapshot = build_thread_snapshot(&state, meta.as_ref());
                    self.threads.insert(thread_id.clone(), state);
                    self.open_threads.insert(thread_id.clone());
                    self.ended_threads.remove(&thread_id);
                    self.connection.subscribe_thread(&thread_id);
                    self.emit_or_buffer_thread(snapshot);
                } else {
                    self.threads
                        .entry(thread_id.clone())
                        .or_insert_with(|| ThreadState::new(thread_id.clone()));
                    self.open_threads.insert(thread_id.clone());
                    self.ended_threads.remove(&thread_id);
                    self.connection.subscribe_thread(&thread_id);
                }
                let _ = reply.send(());
                true
            }
            PumpControl::Shutdown => false,
        }
    }

    fn handle_event(&mut self, event: ClientEvent) {
        match event {
            ClientEvent::Status(status) => {
                let ffi_status: FfiConnectionStatus = status.into();
                self.status_watch.send_replace(ffi_status.clone());
                self.listener.on_status(ffi_status);
            }
            ClientEvent::BearerIssued(token) => {
                self.listener.on_bearer_issued(token);
            }
            ClientEvent::Shell(item) => {
                let change = self.shell.apply(item);
                self.sync_shell_run_meta();
                if !change.threads_changed.is_empty() {
                    self.resubscribe_ended_threads();
                }
                if change.snapshot_required {
                    self.shell_snapshot_required = true;
                    self.connection.subscribe_shell();
                }
                let snapshot = build_shell_snapshot(&self.shell);
                self.shell_watch.send_replace(Some(snapshot.clone()));
                self.emit_or_buffer_shell(snapshot);

                // Refresh header metadata (title/branch/model) on open threads updated by shell.
                for thread_id in change.threads_changed {
                    if self.open_threads.contains(&thread_id)
                        && let Some(state) = self.threads.get(&thread_id)
                        && (state.synchronized || !state.entries.is_empty())
                    {
                        let meta = self.resolve_thread_meta(&thread_id);
                        let thread_snapshot = build_thread_snapshot(state, meta.as_ref());
                        self.emit_or_buffer_thread(thread_snapshot);
                    }
                }
            }
            ClientEvent::Thread { thread_id, item } => {
                let force_emit = matches!(
                    item,
                    OrchestrationV2ThreadStreamItem::Snapshot(_)
                        | OrchestrationV2ThreadStreamItem::Synchronized(_)
                );
                if let OrchestrationV2ThreadStreamItem::Snapshot(ref snap) = item {
                    self.thread_projection_meta.insert(
                        thread_id.clone(),
                        ThreadSnapshotMeta::from_app_thread(&snap.projection.thread),
                    );
                }
                let meta = self.resolve_thread_meta(&thread_id);
                let state = self
                    .threads
                    .entry(thread_id.clone())
                    .or_insert_with(|| ThreadState::new(thread_id.clone()));
                let changed = state.apply(item);
                let working = state.working;
                let active_run_id = state.active_run_id().map(str::to_owned);
                let snapshot = if self.open_threads.contains(&thread_id) && (changed || force_emit)
                {
                    Some(build_thread_snapshot(state, meta.as_ref()))
                } else {
                    None
                };
                if let Ok(mut guard) = self.thread_runs.write() {
                    guard.insert(
                        thread_id,
                        ThreadRunMeta {
                            working,
                            active_run_id,
                        },
                    );
                }
                if let Some(snapshot) = snapshot {
                    self.emit_or_buffer_thread(snapshot);
                }
            }
            ClientEvent::StreamEnded { tag, key, error } => {
                if let Some(ref err) = error {
                    warn!("conn-ffi stream ended ({tag}, key={key}): {err}");
                    self.listener.on_error(err.clone());
                }
                if tag == TAG_SUBSCRIBE_SHELL {
                    if self.shell_snapshot_required || error.is_none() {
                        self.shell_snapshot_required = false;
                        self.connection.subscribe_shell();
                    }
                } else if tag == TAG_SUBSCRIBE_THREAD && self.open_threads.contains(&key) {
                    self.ended_threads.insert(key);
                    if error.is_none() {
                        self.resubscribe_ended_threads();
                    }
                }
            }
            ClientEvent::PanelRequest(_) | ClientEvent::Annotations { .. } => {}
        }
    }

    fn resubscribe_ended_threads(&mut self) {
        let ready: Vec<String> = self
            .ended_threads
            .iter()
            .filter(|id| self.open_threads.contains(*id) && self.shell.find_thread(id).is_some())
            .cloned()
            .collect();
        for id in ready {
            self.ended_threads.remove(&id);
            self.connection.subscribe_thread(&id);
        }
    }

    fn emit_or_buffer_shell(&mut self, snapshot: FfiShellSnapshot) {
        if let Some(ready) = self.coalescer.push_shell(snapshot, Instant::now()) {
            self.listener.on_shell(ready);
        }
    }

    fn emit_or_buffer_thread(&mut self, snapshot: FfiThreadSnapshot) {
        if let Some(ready) = self.coalescer.push_thread(snapshot, Instant::now()) {
            self.listener.on_thread(ready);
        }
    }

    fn flush_due(&mut self) {
        let (shell, threads) = self.coalescer.drain_due(Instant::now());
        if let Some(snapshot) = shell {
            self.listener.on_shell(snapshot);
        }
        for snapshot in threads {
            self.listener.on_thread(snapshot);
        }
    }
}

async fn run_pump(
    connection: Connection,
    mut events_rx: mpsc::Receiver<ClientEvent>,
    mut ctrl_rx: mpsc::UnboundedReceiver<PumpControl>,
    listener: Arc<dyn CoreListener>,
    thread_runs: Arc<RwLock<HashMap<String, ThreadRunMeta>>>,
    shell_watch: watch::Sender<Option<FfiShellSnapshot>>,
    status_watch: watch::Sender<FfiConnectionStatus>,
) {
    let mut state = PumpState {
        connection,
        listener,
        shell: ShellState::default(),
        threads: HashMap::new(),
        thread_projection_meta: HashMap::new(),
        open_threads: HashSet::new(),
        ended_threads: HashSet::new(),
        shell_snapshot_required: false,
        coalescer: SnapshotCoalescer::default(),
        thread_runs,
        shell_watch,
        status_watch,
    };

    loop {
        if let Some(deadline) = state.coalescer.next_deadline() {
            let sleep_until = tokio::time::Instant::from_std(deadline);
            tokio::select! {
                biased;
                maybe_ctrl = ctrl_rx.recv() => {
                    let Some(ctrl) = maybe_ctrl else { break };
                    if !state.handle_control(ctrl) {
                        break;
                    }
                }
                () = tokio::time::sleep_until(sleep_until) => {
                    state.flush_due();
                }
                maybe_event = events_rx.recv() => {
                    let Some(first) = maybe_event else { break };
                    state.handle_event(first);
                    while let Ok(more) = events_rx.try_recv() {
                        state.handle_event(more);
                    }
                    state.flush_due();
                }
            }
        } else {
            tokio::select! {
                biased;
                maybe_ctrl = ctrl_rx.recv() => {
                    let Some(ctrl) = maybe_ctrl else { break };
                    if !state.handle_control(ctrl) {
                        break;
                    }
                }
                maybe_event = events_rx.recv() => {
                    let Some(first) = maybe_event else { break };
                    state.handle_event(first);
                    while let Ok(more) = events_rx.try_recv() {
                        state.handle_event(more);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;

    use conn_wire::{Exit, FromClient, FromServer, encode_server_frame};
    use futures::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;
    use crate::types::{FfiTimelineEntry, FfiUserInputAnswerValue};

    #[derive(Default)]
    struct RecordedState {
        statuses: Vec<FfiConnectionStatus>,
        bearers: Vec<String>,
        shells: Vec<FfiShellSnapshot>,
        threads: Vec<FfiThreadSnapshot>,
        errors: Vec<String>,
    }

    #[derive(Default)]
    struct RecordingListener {
        inner: Mutex<RecordedState>,
        notify: Condvar,
    }

    impl RecordingListener {
        fn wait_for<F>(&self, timeout: Duration, mut pred: F) -> bool
        where
            F: FnMut(&RecordedState) -> bool,
        {
            let deadline = Instant::now() + timeout;
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            while !pred(&guard) {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    return false;
                };
                let (next, wait_res) = self
                    .notify
                    .wait_timeout(guard, remaining)
                    .expect("listener condvar not poisoned");
                guard = next;
                if wait_res.timed_out() {
                    return pred(&guard);
                }
            }
            true
        }
    }

    impl CoreListener for RecordingListener {
        fn on_status(&self, status: FfiConnectionStatus) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.statuses.push(status);
            self.notify.notify_all();
        }

        fn on_bearer_issued(&self, token: String) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.bearers.push(token);
            self.notify.notify_all();
        }

        fn on_shell(&self, snapshot: FfiShellSnapshot) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.shells.push(snapshot);
            self.notify.notify_all();
        }

        fn on_thread(&self, snapshot: FfiThreadSnapshot) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.threads.push(snapshot);
            self.notify.notify_all();
        }

        fn on_error(&self, message: String) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.errors.push(message);
            self.notify.notify_all();
        }
    }

    #[test]
    fn rejects_invalid_server_urls() {
        let listener = Arc::new(RecordingListener::default());
        let err = ConnCore::connect(
            "not-a-url".to_owned(),
            FfiCredential::Bearer {
                token: "tok".to_owned(),
            },
            listener.clone(),
        )
        .expect_err("invalid url must fail");
        assert!(
            matches!(err, FfiError::InvalidUrl { .. }),
            "expected InvalidUrl, got {err:?}"
        );

        let err = ConnCore::connect(
            "ftp://example.com".to_owned(),
            FfiCredential::Bearer {
                token: "tok".to_owned(),
            },
            listener,
        )
        .expect_err("non-http scheme must fail");
        assert!(
            matches!(err, FfiError::InvalidUrl { .. }),
            "expected InvalidUrl for ftp scheme, got {err:?}"
        );
    }

    struct MockRpcCall {
        tag: String,
        payload: serde_json::Value,
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    fn end_to_end_mock_server_streams_shell_thread_and_dispatches_all_commands()
    -> Result<(), Box<dyn std::error::Error>> {
        let server_rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let snapshot_raw = conn_state::testkit::synthetic_thread_snapshot_json(
            conn_state::testkit::SyntheticThread {
                turns: 1,
                commands_per_turn: 1,
                command_output_bytes: 24,
                assistant_bytes: 32,
            },
        );
        let mut snapshot_val: serde_json::Value = serde_json::from_str(&snapshot_raw)?;
        snapshot_val["projection"]["thread"]["id"] = json!("thread-1");
        snapshot_val["projection"]["thread"]["title"] = json!("Synthetic Title");
        snapshot_val["projection"]["thread"]["branch"] = json!("feat/ios");
        snapshot_val["projection"]["thread"]["modelSelection"] =
            json!({ "instanceId": "claudeAgent", "model": "claude-sonnet-4-5" });
        // Mark the existing synthetic run as active so Steer/Queue dispatch modes and
        // active_run_id are exercised against a contract-valid OrchestrationV2Run object.
        if let Some(run) = snapshot_val["projection"]["runs"]
            .as_array_mut()
            .and_then(|runs| runs.first_mut())
        {
            run["id"] = json!("run-active-1");
            run["status"] = json!("running");
            run["completedAt"] = serde_json::Value::Null;
        }

        let launch_projection = snapshot_val["projection"].clone();

        let (addr, calls_rx) = server_rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let addr = listener.local_addr()?;
            let (calls_tx, calls_rx) = mpsc::unbounded_channel::<MockRpcCall>();
            tokio::spawn(async move {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                    return;
                };
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let Ok(frames) = conn_wire::decode_client_message(&text) else {
                        continue;
                    };
                    for frame in frames {
                        let FromClient::Request(req) = frame else {
                            continue;
                        };
                        match req.tag.as_str() {
                            "orchestration.subscribeShell" => {
                                let chunk = FromServer::Chunk {
                                    request_id: req.id,
                                    values: vec![
                                        json!({
                                            "kind": "snapshot",
                                            "snapshot": {
                                                "schemaVersion": 1,
                                                "snapshotSequence": 1,
                                                "projects": [{
                                                    "id": "p1",
                                                    "title": "Demo",
                                                    "workspaceRoot": "/tmp/demo",
                                                    "defaultModelSelection": {
                                                        "instanceId": "claudeAgent",
                                                        "model": "claude-sonnet-4-5"
                                                    },
                                                    "scripts": [],
                                                    "createdAt": "2026-11-22T10:00:00Z",
                                                    "updatedAt": "2026-11-22T10:00:00Z",
                                                    "archivedAt": null
                                                }],
                                                "threads": [],
                                                "archivedThreads": []
                                            }
                                        }),
                                        json!({ "kind": "synchronized" }),
                                    ],
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&chunk).into()))
                                    .await;
                            }
                            "orchestration.subscribeThread" => {
                                let req_tid = req.payload["threadId"]
                                    .as_str()
                                    .unwrap_or("thread-1")
                                    .to_owned();
                                let mut snap = snapshot_val.clone();
                                snap["projection"]["thread"]["id"] = json!(req_tid);
                                let chunk = FromServer::Chunk {
                                    request_id: req.id,
                                    values: vec![snap, json!({ "kind": "synchronized" })],
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&chunk).into()))
                                    .await;
                            }
                            "orchestration.launchThread" => {
                                let _ = calls_tx.send(MockRpcCall {
                                    tag: req.tag.clone(),
                                    payload: req.payload.clone(),
                                });
                                let new_id = req.payload["threadId"]
                                    .as_str()
                                    .unwrap_or("launched-1")
                                    .to_owned();
                                let mut proj = launch_projection.clone();
                                proj["thread"]["id"] = json!(new_id);
                                proj["thread"]["title"] = req.payload["title"].clone();
                                let reply = FromServer::Exit {
                                    request_id: req.id,
                                    exit: Exit::success(json!({
                                        "threadId": new_id,
                                        "projection": proj,
                                        "resumed": false,
                                        "sequence": 42
                                    })),
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&reply).into()))
                                    .await;
                            }
                            "orchestration.dispatchCommand" | "secrets.answerRequest" => {
                                let _ = calls_tx.send(MockRpcCall {
                                    tag: req.tag.clone(),
                                    payload: req.payload.clone(),
                                });
                                let reply = FromServer::Exit {
                                    request_id: req.id,
                                    exit: Exit::success(json!({ "ok": true })),
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&reply).into()))
                                    .await;
                            }
                            _ => {}
                        }
                    }
                }
            });
            Ok::<_, std::io::Error>((addr, calls_rx))
        })?;

        // Drive server_rt in a background thread so the current thread stays non-Tokio.
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let server_thread = std::thread::spawn(move || {
            server_rt.block_on(async {
                let _ = stop_rx.await;
            });
        });

        let listener = Arc::new(RecordingListener::default());
        let core = ConnCore::connect(
            format!("http://{addr}"),
            FfiCredential::Bearer {
                token: "test-bearer".to_owned(),
            },
            listener.clone(),
        )?;

        assert!(
            listener.wait_for(Duration::from_secs(5), |s| {
                s.shells
                    .last()
                    .is_some_and(|sh| sh.synchronized && sh.projects.len() == 1)
            }),
            "must receive synchronized shell snapshot"
        );

        core.open_thread("thread-1".to_owned());
        assert!(
            listener.wait_for(Duration::from_secs(5), |s| {
                s.threads.last().is_some_and(|th| {
                    th.thread_id == "thread-1" && th.entries.len() == 3 && th.working
                })
            }),
            "open_thread must emit thread snapshot with 3 entries and active run"
        );
        {
            let guard = listener.inner.lock().expect("listener lock");
            let latest = guard.threads.last().expect("thread snapshot present");
            assert!(
                matches!(latest.entries[0], FfiTimelineEntry::User { .. }),
                "first timeline entry is User"
            );
            assert_eq!(latest.active_run_id.as_deref(), Some("run-active-1"));
            assert_eq!(latest.title.as_deref(), Some("Synthetic Title"));
            assert_eq!(latest.branch.as_deref(), Some("feat/ios"));
            assert_eq!(latest.model_label.as_deref(), Some("claude-sonnet-4-5"));
        }

        // All async actions must work from a non-Tokio executor (just like Swift concurrency).
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "test thread must have no ambient Tokio runtime"
        );

        let mut calls_rx = calls_rx;
        let mut next_call = || {
            calls_rx
                .try_recv()
                .expect("server must receive expected RPC call")
        };

        // 1. send_message Auto while working -> queue_after_active (matches desktop default).
        futures::executor::block_on(core.send_message(
            "thread-1".to_owned(),
            "Auto while working".to_owned(),
            FfiSendMode::Auto,
        ))?;
        let call = next_call();
        assert_eq!(call.tag, "orchestration.dispatchCommand");
        assert_eq!(call.payload["type"], json!("message.dispatch"));
        assert_eq!(
            call.payload["dispatchMode"]["type"],
            json!("queue_after_active")
        );

        // 2. send_message Steer while working -> steer_active with active_run_id.
        futures::executor::block_on(core.send_message(
            "thread-1".to_owned(),
            "Steer now".to_owned(),
            FfiSendMode::Steer,
        ))?;
        let call = next_call();
        assert_eq!(call.payload["dispatchMode"]["type"], json!("steer_active"));
        assert_eq!(
            call.payload["dispatchMode"]["targetRunId"],
            json!("run-active-1")
        );

        // 3. send_message Queue while working -> queue_after_active.
        futures::executor::block_on(core.send_message(
            "thread-1".to_owned(),
            "Queue explicit".to_owned(),
            FfiSendMode::Queue,
        ))?;
        let call = next_call();
        assert_eq!(
            call.payload["dispatchMode"]["type"],
            json!("queue_after_active")
        );

        // 4. send_message on idle unknown thread -> start_immediately.
        futures::executor::block_on(core.send_message(
            "thread-idle".to_owned(),
            "Start now".to_owned(),
            FfiSendMode::Auto,
        ))?;
        let call = next_call();
        assert_eq!(
            call.payload["dispatchMode"]["type"],
            json!("start_immediately")
        );

        // 5. respond_approval
        futures::executor::block_on(core.respond_approval(
            "thread-1".to_owned(),
            "req-ap-1".to_owned(),
            FfiApprovalDecision::AcceptForSession,
        ))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("runtime-request.respond"));
        assert_eq!(call.payload["requestId"], json!("req-ap-1"));
        assert_eq!(call.payload["decision"], json!("acceptForSession"));

        // 6. respond_user_input (single + multi answers)
        futures::executor::block_on(core.respond_user_input(
            "thread-1".to_owned(),
            "req-ui-1".to_owned(),
            vec![
                FfiUserInputSubmission {
                    question_id: "q1".to_owned(),
                    value: FfiUserInputAnswerValue::Single {
                        value: "swiftui".to_owned(),
                    },
                },
                FfiUserInputSubmission {
                    question_id: "q2".to_owned(),
                    value: FfiUserInputAnswerValue::Multi {
                        values: vec!["fmt".to_owned(), "clippy".to_owned()],
                    },
                },
            ],
        ))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("runtime-request.respond"));
        assert_eq!(call.payload["requestId"], json!("req-ui-1"));
        assert_eq!(call.payload["answers"]["q1"], json!("swiftui"));
        assert_eq!(call.payload["answers"]["q2"], json!(["fmt", "clippy"]));

        // 7. dismiss_user_input
        futures::executor::block_on(
            core.dismiss_user_input("thread-1".to_owned(), "req-ui-2".to_owned()),
        )?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.user-input.dismiss"));
        assert_eq!(call.payload["requestId"], json!("req-ui-2"));

        // 8. answer_secret_request (save + blank reject + decline)
        let blank_err = futures::executor::block_on(core.answer_secret_request(
            "thread-1".to_owned(),
            "item-sec-1".to_owned(),
            Some("   ".to_owned()),
        ))
        .expect_err("blank secret must be rejected");
        assert!(matches!(blank_err, FfiError::InvalidInput { .. }));

        futures::executor::block_on(core.answer_secret_request(
            "thread-1".to_owned(),
            "item-sec-1".to_owned(),
            Some("  tok-123 ".to_owned()),
        ))?;
        let call = next_call();
        assert_eq!(call.tag, "secrets.answerRequest");
        assert_eq!(call.payload["turnItemId"], json!("item-sec-1"));
        assert_eq!(
            call.payload["answer"],
            json!({ "type": "save", "secret": "tok-123" })
        );

        futures::executor::block_on(core.answer_secret_request(
            "thread-1".to_owned(),
            "item-sec-2".to_owned(),
            None,
        ))?;
        let call = next_call();
        assert_eq!(call.tag, "secrets.answerRequest");
        assert_eq!(call.payload["answer"], json!({ "type": "decline" }));

        // 9. stop_thread
        futures::executor::block_on(core.stop_thread("thread-1".to_owned()))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.stop"));
        assert_eq!(call.payload["threadId"], json!("thread-1"));

        // 10. settle_thread (true and false)
        futures::executor::block_on(core.settle_thread("thread-1".to_owned(), true))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.settle"));

        futures::executor::block_on(core.settle_thread("thread-1".to_owned(), false))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.unsettle"));
        assert_eq!(call.payload["reason"], json!("user"));

        // 11. pin_thread (true and false)
        futures::executor::block_on(core.pin_thread("thread-1".to_owned(), true))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.pin"));

        futures::executor::block_on(core.pin_thread("thread-1".to_owned(), false))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.unpin"));

        // 12. rename_thread
        futures::executor::block_on(
            core.rename_thread("thread-1".to_owned(), "Renamed".to_owned()),
        )?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.metadata.update"));
        assert_eq!(call.payload["title"], json!("Renamed"));

        // 13. mark_thread_unread
        futures::executor::block_on(core.mark_thread_unread("thread-1".to_owned()))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.mark-unread"));

        // 14. delete_thread
        futures::executor::block_on(core.delete_thread("thread-1".to_owned()))?;
        let call = next_call();
        assert_eq!(call.payload["type"], json!("thread.delete"));

        // 15. launch_thread: uses project's default model, applies projection, subscribes & emits.
        let launched_id = futures::executor::block_on(
            core.launch_thread("p1".to_owned(), "Build the iOS theme bridge".to_owned()),
        )?;
        let call = next_call();
        assert_eq!(call.tag, "orchestration.launchThread");
        assert_eq!(call.payload["projectId"], json!("p1"));
        assert_eq!(call.payload["threadId"], json!(launched_id));
        assert_eq!(
            call.payload["modelSelection"]["model"],
            json!("claude-sonnet-4-5")
        );
        assert_eq!(call.payload["runtimeMode"], json!("full-access"));
        assert_eq!(call.payload["interactionMode"], json!("default"));
        assert_eq!(call.payload["workspaceStrategy"], json!({ "type": "root" }));
        assert_eq!(
            call.payload["initialMessage"]["text"],
            json!("Build the iOS theme bridge")
        );
        assert!(
            listener.wait_for(Duration::from_secs(5), |s| {
                s.threads
                    .iter()
                    .any(|th| th.thread_id == launched_id && !th.entries.is_empty())
            }),
            "launch_thread must apply projection and emit thread snapshot"
        );

        core.close_thread("thread-1".to_owned());
        core.close_thread(launched_id);
        core.disconnect();
        let _ = stop_tx.send(());
        let _ = server_thread.join();
        Ok(())
    }
}
