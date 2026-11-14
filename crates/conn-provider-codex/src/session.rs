//! [`CodexSession`]: one engine session on the shared app-server. It owns one native thread,
//! a [`Mapper`], and a driver task that feeds the mapper the frames routed to it, flushes
//! streamed text on a timer, and delivers events and replies in order. State sits behind one
//! `std` mutex that is never held across an `.await`.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_contract::{ProviderInstanceId, ProviderSessionId, ProviderThread, from_json, to_json};
use conn_provider::{
    BoxFuture, EnsureThreadInput, ForkThreadInput, InterruptInput, McpServer, ProviderError,
    ProviderEvent, ProviderResult, ResumeThreadInput, RollbackTarget, RollbackThreadInput,
    RuntimeRequestResponse, Session, SteerInput, ThreadSnapshot, TurnInput,
};
use conn_provider_support::ids::{self, Env, SystemEnv, iso_from_ms};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use crate::client::{AppServer, CallError, SessionMsg};
use crate::context::ToolAvailability;
use crate::launch;
use crate::mapper::{DRIVER, Mapper, Out};

pub const EVENT_CAPACITY: usize = 256;
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const PLAN_FLUSH_INTERVAL: Duration = Duration::from_millis(400);

pub struct CodexSession {
    id: ProviderSessionId,
    inner: Arc<Inner>,
}

impl std::fmt::Debug for CodexSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexSession")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// Best-effort cleanup for a session dropped without [`Session::close`]: it leaves the
/// app-server, and stops the process when it was the last session. After `close` this finds
/// nothing to do.
impl Drop for CodexSession {
    fn drop(&mut self) {
        let Some(process) = self.inner.server.detach_session(&self.inner.id) else {
            return;
        };
        // Stopping takes a grace period, so it runs as its own task. Without a runtime, the
        // process's own `Drop` kills it.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(process.terminate(crate::client::FORCE_KILL_AFTER));
        }
    }
}

struct Inner {
    id: String,
    instance_id: String,
    /// Where chat attachments are read from (`CodexConfig::attachments_dir`).
    attachments_dir: Option<std::path::PathBuf>,
    /// `CodexConfig::stop_confirm_timeout`.
    stop_confirm_timeout: Duration,
    /// The model and working folder the session opened with: TS resumes a thread for a
    /// rollback, and forks one, with the session's own selection and policy.
    open_model: Option<String>,
    open_cwd: Option<String>,
    server: Arc<AppServer>,
    inbox: mpsc::Sender<SessionMsg>,
    state: Mutex<State>,
    /// Signalled after every batch the driver delivers, so waiters can re-check the mapper.
    progressed: Notify,
}

struct State {
    mapper: Mapper<SystemEnv>,
    events: Option<mpsc::Sender<ProviderEvent>>,
    /// The native thread and the app-server generation it is loaded on.
    thread: Option<(String, Option<u64>)>,
    app_thread_id: Option<String>,
    /// Passed to each `thread/start` and `thread/resume` (`set_mcp_servers`).
    mcp_servers: Vec<McpServer>,
    closed: bool,
    logged: HashSet<String>,
}

impl CodexSession {
    pub(crate) fn open(
        id: ProviderSessionId,
        instance_id: &ProviderInstanceId,
        server: Arc<AppServer>,
        events: mpsc::Sender<ProviderEvent>,
        config: &crate::CodexConfig,
        open: (Option<String>, Option<String>),
    ) -> Self {
        let (inbox, rx) = mpsc::channel(EVENT_CAPACITY);
        server.add_session(id.as_str(), inbox.clone());
        let inner = Arc::new(Inner {
            id: id.as_str().to_owned(),
            instance_id: instance_id.as_str().to_owned(),
            attachments_dir: config.attachments_dir.clone(),
            stop_confirm_timeout: config.stop_confirm_timeout,
            open_model: open.0,
            open_cwd: open.1,
            server,
            inbox,
            state: Mutex::new(State {
                mapper: Mapper::new(SystemEnv),
                events: Some(events),
                thread: None,
                app_thread_id: None,
                mcp_servers: Vec::new(),
                closed: false,
                logged: HashSet::new(),
            }),
            progressed: Notify::new(),
        });
        tokio::spawn(drive(Arc::downgrade(&inner), rx));
        Self { id, inner }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        crate::lock(&self.state)
    }

    /// Fails once the session closed; checked after each await of a multi-step call.
    fn check_open(&self) -> ProviderResult<()> {
        if self.lock().closed {
            Err(ProviderError::SessionStopped)
        } else {
            Ok(())
        }
    }

    /// Sends events and replies in order. Holds no lock across a send.
    async fn deliver(&self, outs: Vec<Out>) {
        if outs.is_empty() {
            return;
        }
        let (events, generation) = {
            let state = self.lock();
            (
                state.events.clone(),
                state.thread.as_ref().and_then(|(_, g)| *g),
            )
        };
        for out in outs {
            match out {
                Out::Event(event) => {
                    if let Some(events) = &events {
                        let _ = events.send(event).await;
                    }
                }
                Out::Write(line) => {
                    if let Some(generation) = generation.or_else(|| self.server.generation()) {
                        let _ = self.server.write(generation, line).await;
                    }
                }
                Out::Skipped(kind) => {
                    let key: String = kind.chars().take(80).collect();
                    // At most 64 kinds are remembered, as in the Claude crate; past that a
                    // kind may be logged again.
                    let first = {
                        let mut state = self.lock();
                        if state.logged.len() >= 64 {
                            state.logged.clear();
                        }
                        state.logged.insert(key)
                    };
                    if first {
                        eprintln!("conn-provider-codex: skipped {kind}");
                    }
                }
            }
        }
        self.progressed.notify_waiters();
    }

    /// The native thread loaded on the running app-server, resuming it after a restart.
    async fn loaded_thread(
        &self,
        policy: Option<&conn_provider::RuntimePolicy>,
        model: Option<&str>,
    ) -> ProviderResult<String> {
        let (native, loaded_on) = self
            .lock()
            .thread
            .clone()
            .ok_or_else(|| failed("start_turn", "the session has no Codex thread"))?;
        let generation = self
            .server
            .ensure_started()
            .await
            .map_err(call_failed("start_turn"))?;
        if loaded_on == Some(generation) {
            return Ok(native);
        }
        let app_thread = self.lock().app_thread_id.clone();
        let cwd = policy.and_then(|p| p.cwd.clone());
        self.resume(&native, app_thread.as_deref(), cwd.as_deref(), model, false)
            .await?;
        Ok(native)
    }

    /// `thread/resume`, unarchiving the thread once when Codex reports it archived. Without
    /// `force`, a thread the app-server already holds (started, resumed or forked on it) is
    /// used as is: TS starts a turn on a thread it forked without resuming it, but its
    /// `resumeThread` always sends `thread/resume`.
    async fn resume(
        &self,
        native: &str,
        app_thread: Option<&str>,
        cwd: Option<&str>,
        model: Option<&str>,
        force: bool,
    ) -> ProviderResult<Value> {
        self.server.route(native, self.inbox.clone());
        if !force && self.server.is_loaded(native) {
            let generation = self.server.generation();
            if let Some(thread) = &mut self.lock().thread {
                thread.1 = generation;
            }
            return Ok(json!({ "thread": { "id": native } }));
        }
        let mcp = self.lock().mcp_servers.clone();
        let mut params = launch::thread_params(app_thread, cwd, model, &mcp);
        params["threadId"] = json!(native);
        params["excludeTurns"] = json!(true);
        let result = match self.server.request("thread/resume", params.clone()).await {
            Err(CallError::Rpc(e))
                if e.message.contains("is archived") || e.message.contains("codex unarchive") =>
            {
                self.server
                    .request("thread/unarchive", json!({ "threadId": native }))
                    .await
                    .map_err(call_failed("resume_thread"))?;
                self.server.request("thread/resume", params).await
            }
            other => other,
        };
        let result = result.map_err(|e| match &e {
            CallError::Rpc(rpc) if rpc.message.contains("already has an active writer") => failed(
                "resume_thread",
                "This conversation is open in another Codex client, such as the Codex app, the Codex CLI, or an IDE extension. Codex lets one client write to a conversation at a time. Quit that client, then send your message again.",
            ),
            _ => call_failed("resume_thread")(e),
        })?;
        self.server.mark_loaded(native);
        let generation = self.server.generation();
        if let Some(thread) = &mut self.lock().thread {
            thread.1 = generation;
        }
        Ok(result)
    }
}

/// The driver: reads routed frames until the session closes; flushes streamed text.
async fn drive(inner: std::sync::Weak<Inner>, mut rx: mpsc::Receiver<SessionMsg>) {
    let mut last_plan_flush = tokio::time::Instant::now();
    loop {
        let Some(strong) = inner.upgrade() else {
            return;
        };
        let dirty = strong.lock().mapper.has_dirty(true);
        drop(strong);
        let msg = if dirty {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep(FLUSH_INTERVAL) => {
                    let Some(inner) = inner.upgrade() else { return };
                    let plans = last_plan_flush.elapsed() >= PLAN_FLUSH_INTERVAL;
                    if plans {
                        last_plan_flush = tokio::time::Instant::now();
                    }
                    let outs = inner.lock().mapper.flush(plans);
                    inner.deliver(outs).await;
                    continue;
                }
            }
        } else {
            rx.recv().await
        };
        let Some(msg) = msg else { return };
        let Some(inner) = inner.upgrade() else { return };
        let outs = {
            let mut state = inner.lock();
            match msg {
                SessionMsg::Frame(frame) => state.mapper.handle(frame),
                SessionMsg::Exited(detail) => {
                    if let Some(thread) = &mut state.thread {
                        thread.1 = None;
                    }
                    let expected = state.closed;
                    state.mapper.on_exit(expected, &detail)
                }
            }
        };
        inner.deliver(outs).await;
    }
}

fn failed(operation: &'static str, detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation,
        detail: detail.into(),
    }
}

fn call_failed(operation: &'static str) -> impl Fn(CallError) -> ProviderError {
    move |e| match e {
        CallError::Stopped => ProviderError::SessionStopped,
        other => failed(operation, other.to_string()),
    }
}

fn native_thread_id(thread: &ProviderThread) -> Option<String> {
    to_json(thread)["nativeThreadRef"]["nativeId"]
        .as_str()
        .map(str::to_owned)
}

/// `codexTimestamp` for thread rows.
fn codex_time(seconds: &Value) -> String {
    match seconds.as_f64() {
        Some(s) => iso_from_ms((s * 1000.0) as u64),
        None => SystemEnv.now(),
    }
}

/// `isTerminalProviderTurn`: a turn that reached Codex and ended (goal control turns have no
/// native turn and never count).
fn is_terminal_turn(turn: &Value) -> bool {
    !turn["nativeTurnRef"].is_null()
        && matches!(
            turn["status"].as_str(),
            Some("completed" | "interrupted" | "failed" | "cancelled")
        )
}

/// `countTerminalTurnsAfterBoundary`: ended turns after the boundary turn, or `None` when the
/// boundary is not among `turns`.
fn turns_after(turns: &[Value], boundary_id: &str) -> Option<usize> {
    let boundary = turns.iter().find(|t| t["id"] == boundary_id)?;
    let ordinal = boundary["ordinal"].as_f64()?;
    Some(
        turns
            .iter()
            .filter(|t| t["ordinal"].as_f64().is_some_and(|o| o > ordinal) && is_terminal_turn(t))
            .count(),
    )
}

impl Inner {
    /// `readCodexThreadHistoryMetadata`: the history mode and whether this app-server has
    /// the thread loaded.
    async fn history(
        &self,
        operation: &'static str,
        native: &str,
    ) -> ProviderResult<(Option<String>, bool)> {
        let read = self
            .server
            .request(
                "thread/read",
                json!({"threadId": native, "includeTurns": false}),
            )
            .await
            .map_err(call_failed(operation))?;
        let thread = &read["thread"];
        Ok((
            thread["historyMode"].as_str().map(str::to_owned),
            thread["status"]["type"] != "notLoaded",
        ))
    }

    /// `revertCodexThread`: drops the newest `turns` turns. Pages `thread/turns/list` from the
    /// newest turn to find the oldest turn to drop, then `thread/revert` before it. Answers
    /// with `thread/read` when the thread has no turns.
    async fn revert(
        &self,
        operation: &'static str,
        native: &str,
        turns: usize,
    ) -> ProviderResult<Value> {
        let mut remaining = turns;
        let mut before: Option<String> = None;
        let mut cursor = Value::Null;
        let mut visited: Vec<Value> = Vec::new();
        while remaining > 0 {
            if visited.contains(&cursor) {
                return Err(failed(
                    operation,
                    "Thread history pagination repeated a cursor.",
                ));
            }
            visited.push(cursor.clone());
            let page = self
                .server
                .request(
                    "thread/turns/list",
                    json!({
                        "threadId": native, "cursor": cursor, "limit": remaining.min(100),
                        "sortDirection": "desc", "itemsView": "summary",
                    }),
                )
                .await
                .map_err(call_failed(operation))?;
            for turn in page["data"].as_array().into_iter().flatten() {
                before = turn["id"].as_str().map(str::to_owned);
                remaining -= 1;
                if remaining == 0 {
                    break;
                }
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        let (method, params) = match before {
            Some(turn) => (
                "thread/revert",
                json!({"threadId": native, "beforeTurnId": turn}),
            ),
            None => (
                "thread/read",
                json!({"threadId": native, "includeTurns": false}),
            ),
        };
        self.server
            .request(method, params)
            .await
            .map_err(call_failed(operation))
    }
}

impl Session for CodexSession {
    fn provider_session_id(&self) -> &ProviderSessionId {
        &self.id
    }

    fn ensure_thread(
        &self,
        input: EnsureThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let inner = &self.inner;
            if let Some(existing) = input.existing_provider_thread
                && native_thread_id(&existing).is_some()
            {
                return self
                    .resume_thread(ResumeThreadInput {
                        provider_thread: existing,
                        thread_id: Some(input.thread_id),
                        model_selection: Some(input.model_selection),
                        runtime_policy: Some(input.runtime_policy),
                    })
                    .await;
            }
            let model = launch::selection_model(&input.model_selection);
            let mcp = inner.lock().mcp_servers.clone();
            let params = launch::thread_params(
                Some(input.thread_id.as_str()),
                input.runtime_policy.cwd.as_deref(),
                Some(&model),
                &mcp,
            );
            let result = inner
                .server
                .request("thread/start", params)
                .await
                .map_err(call_failed("ensure_thread"))?;
            let thread = &result["thread"];
            let native = thread["id"]
                .as_str()
                .ok_or_else(|| ProviderError::Protocol {
                    detail: "thread/start answered without a thread id".into(),
                })?
                .to_owned();
            inner.server.route(&native, inner.inbox.clone());
            inner.server.mark_loaded(&native);
            {
                let mut state = inner.lock();
                state.thread = Some((native.clone(), inner.server.generation()));
                state.app_thread_id = Some(input.thread_id.as_str().to_owned());
            }
            let row = json!({
                "id": ids::provider_thread_id(DRIVER, &native),
                "driver": DRIVER,
                "providerInstanceId": inner.instance_id,
                "providerSessionId": inner.id,
                "appThreadId": input.thread_id.as_str(),
                "ownerNodeId": null,
                "nativeThreadRef": {"driver": DRIVER, "nativeId": native, "strength": "strong"},
                "nativeConversationHeadRef": null,
                "status": "idle",
                "firstRunOrdinal": null,
                "lastRunOrdinal": null,
                "handoffIds": [],
                "forkedFrom": null,
                "createdAt": codex_time(&thread["createdAt"]),
                "updatedAt": codex_time(&thread["updatedAt"]),
            });
            from_json(row).map_err(|e| failed("ensure_thread", e.to_string()))
        })
    }

    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let inner = &self.inner;
            let native = native_thread_id(&input.provider_thread)
                .ok_or_else(|| failed("resume_thread", "provider thread has no native Codex id"))?;
            let row = to_json(&input.provider_thread);
            let app_thread = input
                .thread_id
                .as_ref()
                .map(|t| t.as_str().to_owned())
                .or_else(|| row["appThreadId"].as_str().map(str::to_owned));
            {
                let mut state = inner.lock();
                state.thread = Some((native.clone(), None));
                state.app_thread_id = app_thread.clone();
            }
            let model = input.model_selection.as_ref().map(launch::selection_model);
            let cwd = input.runtime_policy.as_ref().and_then(|p| p.cwd.clone());
            let result = inner
                .resume(
                    &native,
                    app_thread.as_deref(),
                    cwd.as_deref(),
                    model.as_deref(),
                    true,
                )
                .await?;
            let mut row = row;
            row["providerSessionId"] = json!(inner.id);
            row["providerInstanceId"] = json!(inner.instance_id);
            row["status"] = json!("idle");
            row["nativeThreadRef"] = json!({"driver": DRIVER, "nativeId": result["thread"]["id"].as_str().unwrap_or(&native), "strength": "strong"});
            row["updatedAt"] = json!(codex_time(&result["thread"]["updatedAt"]));
            from_json(row).map_err(|e| failed("resume_thread", e.to_string()))
        })
    }

    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            if inner.lock().closed {
                return Err(ProviderError::SessionStopped);
            }
            let model = launch::selection_model(&input.model_selection);
            if inner.lock().thread.is_none() {
                let native = native_thread_id(&input.provider_thread).ok_or_else(|| {
                    failed("start_turn", "provider thread has no native Codex id")
                })?;
                let mut state = inner.lock();
                state.thread = Some((native, None));
                state.app_thread_id = Some(input.thread_id.as_str().to_owned());
            }
            let native = inner
                .loaded_thread(Some(&input.runtime_policy), Some(&model))
                .await?;
            inner.check_open()?;
            if inner.lock().mapper.thread_busy(&native) {
                return Err(failed("start_turn", "the previous turn is still running"));
            }
            let summary = inner
                .server
                .request(
                    "config/read",
                    json!({"cwd": input.runtime_policy.cwd, "includeLayers": false}),
                )
                .await
                .ok()
                .and_then(|r| {
                    r["config"]["model_reasoning_summary"]
                        .as_str()
                        .map(str::to_owned)
                });
            inner.check_open()?;
            let codex_input = launch::user_input(
                &input.message.text,
                &input.message.attachments,
                inner.attachments_dir.as_deref(),
            )
            .map_err(|detail| ProviderError::Protocol { detail })?;
            // TS: `hasT3Mcp` when the thread has an MCP session; the engine passes it as the
            // `t3-code` server. Browser tools on, device tools off: the session carries no
            // finer answer (TS reads `browserToolsAvailable` and the `device` capability).
            let t3_tools = inner
                .lock()
                .mcp_servers
                .iter()
                .any(|s| s.name == "t3-code")
                .then(ToolAvailability::default);
            let params = launch::turn_start_params(
                &native,
                codex_input,
                &input.runtime_policy,
                &input.model_selection,
                summary.as_deref(),
                t3_tools,
            );
            inner.lock().mapper.begin_turn(&native, &input);
            match inner.server.request("turn/start", params).await {
                Ok(result) => {
                    let outs = inner.lock().mapper.turn_start_result(&native, &result);
                    inner.deliver(outs).await;
                    Ok(())
                }
                Err(e) => {
                    inner.lock().mapper.abandon_turn(&native);
                    Err(call_failed("start_turn")(e))
                }
            }
        })
    }

    fn steer_turn(&self, input: SteerInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            let (native_turn, native_thread) = {
                let state = inner.lock();
                (
                    state.mapper.native_turn(input.provider_turn_id.as_str()),
                    state.thread.as_ref().map(|(t, _)| t.clone()),
                )
            };
            let (Some(turn), Some(thread)) = (native_turn, native_thread) else {
                return Err(failed("steer_turn", "that turn is not running"));
            };
            let codex_input = launch::user_input(
                &input.message.text,
                &input.message.attachments,
                inner.attachments_dir.as_deref(),
            )
            .map_err(|detail| ProviderError::Protocol { detail })?;
            inner
                .server
                .request(
                    "turn/steer",
                    json!({"expectedTurnId": turn, "input": codex_input, "threadId": thread}),
                )
                .await
                .map(|_| ())
                .map_err(call_failed("steer_turn"))
        })
    }

    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            let (native_turn, thread, processes) = {
                let mut state = inner.lock();
                let Some(turn) = state.mapper.native_turn(input.provider_turn_id.as_str()) else {
                    return Ok(());
                };
                state.mapper.mark_interrupting(&turn);
                let processes = state.mapper.running_processes(&turn);
                let thread = state
                    .thread
                    .as_ref()
                    .map(|(t, _)| t.clone())
                    .unwrap_or_default();
                (turn, thread, processes)
            };
            let sent = inner
                .server
                .request(
                    "turn/interrupt",
                    json!({"threadId": thread, "turnId": native_turn}),
                )
                .await;
            for process in processes {
                let _ = inner
                    .server
                    .request(
                        "thread/backgroundTerminals/terminate",
                        json!({"threadId": thread, "processId": process}),
                    )
                    .await;
            }
            let wait = async {
                loop {
                    let progressed = inner.progressed.notified();
                    if !inner.lock().mapper.is_active(&native_turn) {
                        return;
                    }
                    progressed.await;
                }
            };
            let confirmed = tokio::time::timeout(inner.stop_confirm_timeout, wait)
                .await
                .is_ok();
            match sent {
                Ok(_) | Err(CallError::Stopped) => {}
                Err(e) => return Err(failed("interrupt_turn", e.to_string())),
            }
            // Codex may still be working: the turn stays open and marked interrupting, and
            // whatever ends it later (Codex's `turn/completed`, a close, Force stop) settles it
            // (T3 since b5b470542a, `deferToActiveRoots`).
            if confirmed || inner.lock().closed {
                Ok(())
            } else {
                Err(ProviderError::InterruptTimeout {
                    timeout_ms: u64::try_from(inner.stop_confirm_timeout.as_millis())
                        .unwrap_or(u64::MAX),
                })
            }
        })
    }

    fn respond_to_runtime_request(
        &self,
        input: RuntimeRequestResponse,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let outs = self.inner.lock().mapper.respond(&input)?;
            self.inner.deliver(outs).await;
            Ok(())
        })
    }

    /// Codex reads MCP servers from the thread config, so they apply from the next
    /// `thread/start` or `thread/resume` of this session.
    fn set_mcp_servers(&self, servers: Vec<McpServer>) -> BoxFuture<'_, ProviderResult<()>> {
        self.inner.lock().mcp_servers = servers;
        Box::pin(std::future::ready(Ok(())))
    }

    /// `rollbackThread`: count the ended turns after the target, revert that many on the
    /// native thread (resuming it first when this app-server does not hold it).
    fn rollback_thread(
        &self,
        input: RollbackThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ThreadSnapshot>> {
        Box::pin(async move {
            const OP: &str = "rollback_thread";
            let inner = &self.inner;
            let native = native_thread_id(&input.provider_thread)
                .ok_or_else(|| failed(OP, "provider thread has no native Codex id"))?;
            let thread_row = to_json(&input.provider_thread);
            let turns: Vec<Value> = input.provider_thread_turns.iter().map(to_json).collect();
            let (count, head) = match &input.target {
                RollbackTarget::ThreadStart { .. } => (
                    turns.iter().filter(|t| is_terminal_turn(t)).count(),
                    Value::Null,
                ),
                RollbackTarget::ProviderTurn { provider_turn, .. } => {
                    let target = to_json(provider_turn);
                    if target["providerThreadId"] != thread_row["id"] {
                        return Err(failed(
                            OP,
                            format!(
                                "Cannot roll back Codex thread {} to provider turn {}: target turn belongs to provider thread {}.",
                                thread_row["id"].as_str().unwrap_or_default(),
                                target["id"].as_str().unwrap_or_default(),
                                target["providerThreadId"].as_str().unwrap_or_default(),
                            ),
                        ));
                    }
                    let id = target["id"].as_str().unwrap_or_default();
                    let count = turns_after(&turns, id).ok_or_else(|| failed(OP, format!(
                        "Cannot roll back Codex thread {} to provider turn {id}: target turn was not found in durable provider turn history.",
                        thread_row["id"].as_str().unwrap_or_default(),
                    )))?;
                    (count, target["nativeTurnRef"].clone())
                }
            };
            let mut row = thread_row.clone();
            row["nativeConversationHeadRef"] = head;
            row["status"] = json!("idle");
            if count > 0 {
                let (history, loaded) = inner.history(OP, &native).await?;
                if history.as_deref() != Some("paginated") {
                    return Err(failed(
                        OP,
                        format!(
                            "Cannot roll back Codex thread {native}: the thread uses legacy history, which Codex 0.156 cannot revert."
                        ),
                    ));
                }
                if !loaded {
                    let app_thread = thread_row["appThreadId"].as_str().map(str::to_owned);
                    inner
                        .resume(
                            &native,
                            app_thread.as_deref(),
                            inner.open_cwd.as_deref(),
                            inner.open_model.as_deref(),
                            true,
                        )
                        .await?;
                }
                let response = inner.revert(OP, &native, count).await?;
                inner.lock().mapper.forget_usage(&native);
                let id = response["thread"]["id"]
                    .as_str()
                    .unwrap_or(&native)
                    .to_owned();
                row["nativeThreadRef"] =
                    json!({"driver": DRIVER, "nativeId": id, "strength": "strong"});
                row["updatedAt"] = json!(codex_time(&response["thread"]["updatedAt"]));
            }
            Ok(ThreadSnapshot {
                provider_thread: from_json(row).map_err(|e| failed(OP, e.to_string()))?,
                provider_turns: Vec::new(),
                messages: Vec::new(),
                runtime_requests: Vec::new(),
            })
        })
    }

    /// `forkThread`: `thread/fork` (inclusive `lastTurnId` when the boundary turn has a native
    /// id), or a fork of the whole thread reverted to the boundary.
    fn fork_thread(&self, input: ForkThreadInput) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            const OP: &str = "fork_thread";
            let inner = &self.inner;
            let source = to_json(&input.source_provider_thread);
            let native = native_thread_id(&input.source_provider_thread)
                .ok_or_else(|| failed(OP, "provider thread has no native Codex id"))?;
            let turns: Vec<Value> = input
                .source_provider_turns
                .iter()
                .map(to_json)
                .filter(|t| t["providerThreadId"] == source["id"])
                .collect();
            let (last_turn, rollback) = match &input.provider_turn_id {
                None => (None, 0),
                Some(turn_id) => {
                    let count = turns_after(&turns, turn_id.as_str()).ok_or_else(|| failed(OP, format!(
                        "Cannot fork Codex thread from provider turn {}: source turn was not found in provider thread {}.",
                        turn_id.as_str(),
                        source["id"].as_str().unwrap_or_default(),
                    )))?;
                    let native_turn = turns
                        .iter()
                        .find(|t| t["id"] == turn_id.as_str())
                        .and_then(|t| t["nativeTurnRef"]["nativeId"].as_str())
                        .map(str::to_owned);
                    match native_turn {
                        Some(turn) => (Some(turn), 0),
                        None => (None, count),
                    }
                }
            };
            let mcp = inner.lock().mcp_servers.clone();
            // `codexThreadRuntimeParams`: the fork's own model and cwd, left out when absent.
            let model = input.model_selection.as_ref().map(launch::selection_model);
            let cwd = input.runtime_policy.as_ref().and_then(|p| p.cwd.clone());
            let mut params = launch::thread_params(
                Some(input.target_thread_id.as_str()),
                cwd.as_deref(),
                model.as_deref(),
                &mcp,
            );
            params["threadId"] = json!(native);
            params["excludeTurns"] = json!(true);
            if let Some(turn) = &last_turn {
                params["lastTurnId"] = json!(turn);
            }
            let response = match inner.server.request("thread/fork", params.clone()).await {
                Err(CallError::Rpc(e))
                    if e.message.contains("is archived")
                        || e.message.contains("codex unarchive") =>
                {
                    inner
                        .server
                        .request("thread/unarchive", json!({ "threadId": native }))
                        .await
                        .map_err(call_failed(OP))?;
                    inner.server.request("thread/fork", params).await
                }
                other => other,
            }
            .map_err(call_failed(OP))?;
            let mut thread = response["thread"].clone();
            let forked = thread["id"]
                .as_str()
                .ok_or_else(|| ProviderError::Protocol {
                    detail: "thread/fork answered without a thread id".into(),
                })?
                .to_owned();
            if rollback > 0 {
                let (history, _) = inner.history(OP, &forked).await?;
                if history.as_deref() != Some("paginated") {
                    return Err(failed(
                        OP,
                        format!(
                            "Cannot fork Codex thread {native} at provider turn {}: the source turn has no native Codex turn reference, and the forked thread uses legacy history which Codex 0.156 cannot revert.",
                            input
                                .provider_turn_id
                                .as_ref()
                                .map(|t| t.as_str())
                                .unwrap_or_default(),
                        ),
                    ));
                }
                thread = inner.revert(OP, &forked, rollback).await?["thread"].clone();
            }
            let id = thread["id"].as_str().unwrap_or(&forked).to_owned();
            inner.server.mark_loaded(&id);
            let mut forked_from = json!({"providerThreadId": source["id"]});
            if let Some(turn) = &input.provider_turn_id {
                forked_from["providerTurnId"] = json!(turn.as_str());
            }
            let row = json!({
                "id": ids::provider_thread_id(DRIVER, &id),
                "driver": DRIVER,
                "providerInstanceId": inner.instance_id,
                "providerSessionId": inner.id,
                "appThreadId": input.target_thread_id.as_str(),
                "ownerNodeId": input.owner_node_id.as_ref().map(|n| n.as_str()),
                "nativeThreadRef": {"driver": DRIVER, "nativeId": id, "strength": "strong"},
                "nativeConversationHeadRef": null,
                "status": "idle",
                "firstRunOrdinal": null,
                "lastRunOrdinal": null,
                "handoffIds": [],
                "forkedFrom": forked_from,
                "createdAt": codex_time(&thread["createdAt"]),
                "updatedAt": codex_time(&thread["updatedAt"]),
            });
            from_json(row).map_err(|e| failed(OP, e.to_string()))
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let inner = &self.inner;
            let thread = {
                let mut state = inner.lock();
                state.closed = true;
                state.thread.clone()
            };
            if let Some((native, Some(generation))) = thread {
                // TS unloads a thread (`thread/unsubscribe`) only while the shared process
                // keeps serving other threads; the last session just stops the process.
                if inner.server.generation() == Some(generation) && inner.server.session_count() > 1
                {
                    let _ = inner
                        .server
                        .request("thread/unsubscribe", json!({ "threadId": native }))
                        .await;
                    inner.server.forget_loaded(&native);
                }
                inner.server.unroute(&native);
            }
            let outs = inner.lock().mapper.on_exit(true, "The session closed.");
            inner.deliver(outs).await;
            inner.lock().events = None;
            inner.server.remove_session(&inner.id).await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CodexConfig, CodexProvider};
    use conn_provider::{OpenSessionInput, OpenedSession, Provider, RuntimePolicy, TurnMessage};

    /// A scripted app-server: answers by method, echoing the request id.
    const FAKE: &str = r#"
emit() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$0.stdin"
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) emit "{\"id\":$id,\"result\":{\"userAgent\":\"t3code_desktop/0.167.0 (x)\"}}" ;;
    *'"method":"model/list"'*) emit "{\"id\":$id,\"result\":{\"data\":[],\"nextCursor\":null}}" ;;
    *'"method":"thread/start"'*) emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"th1\",\"createdAt\":1,\"updatedAt\":2}}}" ;;
    *'"method":"config/read"'*) emit "{\"id\":$id,\"result\":{\"config\":{}}}" ;;
    *'"method":"turn/start"'*'approve me'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu1\",\"startedAt\":null}}}"
      emit '{"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"th1","turnId":"tu1","itemId":"c1","command":"ls"}}' ;;
    *'"method":"turn/start"'*'stop me'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu2\",\"startedAt\":null}}}" ;;
    *'"method":"turn/start"'*'stuck'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu3\",\"startedAt\":null}}}" ;;
    *'"method":"turn/interrupt"'*'"tu3"'*)
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"turn/start"'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu0\",\"startedAt\":null}}}"
      emit '{"method":"item/completed","params":{"threadId":"th1","turnId":"tu0","item":{"type":"agentMessage","id":"m1","text":"pong","phase":"final_answer"},"completedAtMs":5}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu0","status":"completed","completedAt":3}}}' ;;
    '{"id":0,"result":{"decision":"accept"}}')
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu1","status":"completed","completedAt":3}}}' ;;
    *'"method":"turn/interrupt"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu2","status":"interrupted","completedAt":3}}}' ;;
    *'"method":"thread/unsubscribe"'*) emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"thread/fork"'*) emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"th9\",\"createdAt\":1,\"updatedAt\":2}}}" ;;
  esac
done
"#;

    fn provider() -> CodexProvider {
        provider_with(CodexConfig::default())
    }

    fn provider_with(config: CodexConfig) -> CodexProvider {
        let dir = std::env::temp_dir().join(format!("conn-codex-fake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("codex");
        std::fs::write(&script, format!("#!/bin/sh\n{FAKE}")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        CodexProvider::new(
            "codex".into(),
            CodexConfig {
                binary: script,
                home_path: Some(dir),
                ..config
            },
        )
    }

    fn policy() -> RuntimePolicy {
        from_json(json!({"runtimeMode": "approval-required", "interactionMode": "default", "cwd": "/tmp"})).unwrap()
    }

    fn turn(thread: &ProviderThread, n: u32, text: &str) -> TurnInput {
        let selection: conn_contract::ModelSelection =
            from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"})).unwrap();
        TurnInput {
            app_thread: from_json(json!({
                "createdBy": "user", "creationSource": "web", "id": "t1", "projectId": "p1",
                "title": "T", "providerInstanceId": "codex", "modelSelection": to_json(&selection),
                "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
                "worktreePath": null, "activeProviderThreadId": null,
                "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "t1"},
                "forkedFrom": null, "createdAt": "x", "updatedAt": "x", "archivedAt": null,
            }))
            .unwrap(),
            thread_id: "t1".into(),
            run_id: format!("r{n}").as_str().into(),
            run_ordinal: n,
            provider_turn_ordinal: n,
            attempt_id: format!("a{n}").as_str().into(),
            root_node_id: format!("n{n}").as_str().into(),
            provider_thread: thread.clone(),
            message: TurnMessage { message_id: "m".into(), text: text.into(), attachments: vec![] },
            model_selection: selection,
            runtime_policy: policy(),
        }
    }

    async fn until(events: &mut mpsc::Receiver<ProviderEvent>, kind: &str) -> Vec<Value> {
        let mut seen = Vec::new();
        loop {
            let event = serde_json::to_value(events.recv().await.expect("events ended")).unwrap();
            let done = event["type"] == kind;
            seen.push(event);
            if done {
                return seen;
            }
        }
    }

    /// A session dropped without `close` (a task ended early) still leaves the app-server, and
    /// the process stops when it was the last session.
    #[tokio::test(flavor = "current_thread")]
    async fn a_dropped_session_leaves_the_app_server() {
        let provider = provider();
        let OpenedSession {
            session,
            mut events,
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
            })
            .await
            .unwrap();
        until(&mut events, "provider_session.updated").await;
        session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        let pid = provider.server.pid().expect("the app-server runs");
        assert_eq!(provider.server.session_count(), 1);

        drop(session);
        assert_eq!(provider.server.session_count(), 0, "the session left");
        assert_eq!(
            provider.server.pid(),
            None,
            "the server let go of the process"
        );
        let alive = || {
            std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            while alive() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the app-server process stopped within 10 s");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn turns_approvals_and_interrupts_through_a_fake_app_server() {
        tokio::time::timeout(Duration::from_secs(30), scripted_session())
            .await
            .expect("the scripted session finished within 30 s");
    }

    async fn scripted_session() {
        let provider = provider();
        let OpenedSession {
            session,
            mut events,
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
            })
            .await
            .unwrap();
        assert_eq!(
            until(&mut events, "provider_session.updated").await.len(),
            1
        );
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        assert_eq!(to_json(&thread)["nativeThreadRef"]["nativeId"], "th1");

        session.start_turn(turn(&thread, 1, "ping")).await.unwrap();
        let seen = until(&mut events, "turn.terminal").await;
        assert!(
            seen.iter()
                .any(|e| e["type"] == "message.updated" && e["message"]["text"] == "pong")
        );
        assert_eq!(seen.last().unwrap()["status"], "completed");

        session
            .start_turn(turn(&thread, 2, "approve me"))
            .await
            .unwrap();
        let seen = until(&mut events, "runtime_request.updated").await;
        let request = seen.last().unwrap()["runtimeRequest"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        session
            .respond_to_runtime_request(RuntimeRequestResponse {
                request_id: request.as_str().into(),
                decision: Some(from_json(json!("accept")).unwrap()),
                feedback: None,
                answers: None,
            })
            .await
            .unwrap();
        assert_eq!(
            until(&mut events, "turn.terminal").await.last().unwrap()["status"],
            "completed"
        );

        session
            .start_turn(turn(&thread, 3, "stop me"))
            .await
            .unwrap();
        let running = until(&mut events, "provider_turn.updated").await;
        let provider_turn = running.last().unwrap()["providerTurn"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        session
            .interrupt_turn(InterruptInput {
                provider_thread: thread.clone(),
                provider_turn_id: provider_turn.as_str().into(),
            })
            .await
            .unwrap();
        assert_eq!(
            until(&mut events, "turn.terminal").await.last().unwrap()["status"],
            "interrupted"
        );

        let pid = provider.app_server_pid().unwrap();
        session.close().await;
        assert!(
            events.recv().await.is_none(),
            "the event channel closes after close"
        );
        assert!(provider.app_server_pid().is_none());
        let alive = conn_provider_support::process::pid_alive(pid);
        assert!(!alive, "the app-server outlived its last session");
    }

    /// T3 since b5b470542a: a Stop that Codex does not confirm in time leaves the turn open and
    /// returns `ProviderAdapterInterruptTimeoutError`; no terminal is invented. Closing the
    /// session (Force stop) then ends the turn as interrupted.
    #[tokio::test(flavor = "current_thread")]
    async fn an_unconfirmed_stop_times_out_and_keeps_the_turn_open() {
        let provider = provider_with(CodexConfig {
            stop_confirm_timeout: Duration::from_millis(300),
            ..CodexConfig::default()
        });
        let OpenedSession {
            session,
            mut events,
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
            })
            .await
            .unwrap();
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        session.start_turn(turn(&thread, 1, "stuck")).await.unwrap();
        let running = until(&mut events, "provider_turn.updated").await;
        let provider_turn = running.last().unwrap()["providerTurn"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let stopped = session
            .interrupt_turn(InterruptInput {
                provider_thread: thread.clone(),
                provider_turn_id: provider_turn.as_str().into(),
            })
            .await;
        assert_eq!(
            stopped,
            Err(ProviderError::InterruptTimeout { timeout_ms: 300 })
        );
        // No terminal: the turn is still open.
        let quiet = tokio::time::timeout(Duration::from_millis(300), async {
            loop {
                let event = serde_json::to_value(events.recv().await?).unwrap();
                if event["type"] == "turn.terminal" {
                    return Some(event);
                }
            }
        })
        .await;
        assert!(quiet.is_err(), "no terminal after the timeout: {quiet:?}");

        session.close().await;
        let ended = until(&mut events, "turn.terminal").await;
        assert_eq!(ended.last().unwrap()["status"], "interrupted");
    }

    /// `forkThread` sends the fork's own model and cwd (`codexThreadRuntimeParams`), and
    /// leaves both out when the input has none, as T3 does.
    #[tokio::test(flavor = "current_thread")]
    async fn a_fork_sends_its_own_model_and_cwd() {
        let dir = std::env::temp_dir().join(format!("conn-codex-fork-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("codex");
        std::fs::write(&script, format!("#!/bin/sh\n{FAKE}")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log = dir.join("codex.stdin");
        let _ = std::fs::remove_file(&log);
        let provider = CodexProvider::new(
            "codex".into(),
            CodexConfig {
                binary: script,
                home_path: Some(dir.clone()),
                ..CodexConfig::default()
            },
        );
        let OpenedSession { session, .. } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
            })
            .await
            .unwrap();
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        let fork = |selection: Option<Value>, cwd: Option<&str>| ForkThreadInput {
            source_provider_thread: thread.clone(),
            source_provider_turns: vec![],
            provider_turn_id: None,
            target_thread_id: "t2".into(),
            owner_node_id: None,
            model_selection: selection.map(|s| from_json(s).unwrap()),
            runtime_policy: cwd.map(|cwd| {
                from_json(
                    json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": cwd}),
                )
                .unwrap()
            }),
        };
        session
            .fork_thread(fork(
                Some(json!({"instanceId": "codex", "model": "gpt-6-astra"})),
                Some("/work/fork"),
            ))
            .await
            .unwrap();
        session.fork_thread(fork(None, None)).await.unwrap();
        session.close().await;
        let forks: Vec<Value> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|f| f["method"] == "thread/fork")
            .map(|f| f["params"].clone())
            .collect();
        assert_eq!(forks.len(), 2, "{forks:?}");
        assert_eq!(forks[0]["model"], "gpt-6-astra");
        assert_eq!(forks[0]["cwd"], "/work/fork");
        assert!(forks[1].get("model").is_none(), "{:?}", forks[1]);
        assert!(forks[1].get("cwd").is_none(), "{:?}", forks[1]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
