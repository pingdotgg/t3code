//! [`CodexSession`]: one engine session on the shared app-server. It owns one native thread,
//! a [`Mapper`], and a driver task that feeds the mapper the frames routed to it, flushes
//! streamed text on a timer, and delivers events and replies in order. State sits behind one
//! `std` mutex that is never held across an `.await`.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_contract::{ProviderInstanceId, ProviderSessionId, ProviderThread, from_json, to_json};
use conn_provider::{
    BoxFuture, Closed, EnsureThreadInput, ForkThreadInput, InjectHistoryInput, InterruptInput,
    McpServer, ProviderError, ProviderEvent, ProviderResult, ResumeThreadInput, RollbackTarget,
    RollbackThreadInput, RuntimeRequestResponse, Session, SteerInput, ThreadSnapshot, TurnInput,
    UploadFeedbackInput,
};
use conn_provider_support::ids::{self, Env, SystemEnv, iso_from_ms};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use crate::client::{AppServer, CallError, ChildRead, Claim, SessionMsg};
use crate::context::ToolAvailability;
use crate::launch;
use crate::mapper::{self, DRIVER, GoalCommand, Mapper, Out};

pub const EVENT_CAPACITY: usize = 256;
/// `CODEX_THREAD_IN_USE_MESSAGE`.
const CODEX_THREAD_IN_USE_MESSAGE: &str = "This conversation is open in another Codex client, such as the Codex app, the Codex CLI, or an IDE extension. Codex lets one client write to a conversation at a time. Quit that client, then send your message again.";
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const PLAN_FLUSH_INTERVAL: Duration = Duration::from_millis(400);
/// T3 gives up on a child's model read after this (`Effect.timeout("5 seconds")`).
const CHILD_METADATA_TIMEOUT: Duration = Duration::from_secs(5);
/// T3's wait on a late child's `turn/interrupt`.
const CHILD_INTERRUPT_TIMEOUT: Duration = Duration::from_secs(10);
/// How many times a closed session's silent subagent is checked with Codex before one that
/// Codex does not report running ends interrupted: an hour at the default interval.
const MAX_CHILD_CHECKS: u32 = 60;
/// T3's wait on the pause that ends a goal Codex did not continue (`pauseClaimedGoal`).
const GOAL_PAUSE_TIMEOUT: Duration = Duration::from_secs(10);
/// T3's first prompt for a new goal (`runGoalCommand`): a bare objective gets echoed back,
/// and "start this goal" gets a `create_goal` call Codex rejects.
const GOAL_START_PROMPT: &str =
    "This thread's goal is already set. Do not call create_goal. Start working on it now: ";

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
    /// `CodexConfig::abandoned_start_timeout`.
    abandoned_start_timeout: Duration,
    /// `CodexConfig::child_check_interval`.
    child_check_interval: Duration,
    /// `CodexConfig::goal_continuation_grace`.
    goal_continuation_grace: Duration,
    /// The model and working folder the session opened with: TS resumes a thread for a
    /// rollback, and forks one, with the session's own selection and policy.
    open_model: Option<String>,
    open_cwd: Option<String>,
    server: Arc<AppServer>,
    inbox: mpsc::Sender<SessionMsg>,
    state: Mutex<State>,
    /// Signalled after every batch the driver delivers, so waiters can re-check the mapper.
    progressed: Notify,
    /// Wakes a start the engine abandoned ([`State::abandoned_run`]).
    abandon: Notify,
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
    /// After a close on a shared app-server: the session itself, held while its subagents may
    /// still report (`Inner::settle_closed`, bounded by `watch_children`).
    lingering: Option<Arc<Inner>>,
    /// `close` has delivered its own events; from here on the session only waits.
    released: bool,
    /// The run whose start Stop abandoned (`abandon_turn_start`); one is enough, as a stale id
    /// matches no later run.
    abandoned_run: Option<String>,
    logged: HashSet<String>,
    /// MCP app notes sent to the native thread, by key (T3's `additionalContextByThread`):
    /// a turn's `additionalContext`, then what steers added. Bounded by the thread's notes.
    sent_app_notes: Option<(String, HashMap<String, String>)>,
    /// The goal grace timers and expiry pauses running; close cancels them. Finished ones are
    /// dropped at each spawn, and a session holds one goal run at a time.
    goal_tasks: Vec<tokio::task::AbortHandle>,
}

impl CodexSession {
    async fn start_turn_inner(&self, input: TurnInput) -> ProviderResult<()> {
        let inner = &self.inner;
        if inner.lock().closed {
            return Err(ProviderError::SessionStopped);
        }
        if inner.start_abandoned(input.run_id.as_str()) {
            return Err(failed(
                "start_turn",
                "Stop ended the turn before Codex started it.",
            ));
        }
        // A `/goal` runs Codex's native goal operations, never as chat (`startTurn`).
        let goal = input
            .restart_continuation_of_run_id
            .is_none()
            .then(|| {
                mapper::parse_command(&input.message.text, !input.message.attachments.is_empty())
            })
            .flatten();
        if let Some(GoalCommand::Set(objective)) = &goal
            && let Some(detail) = mapper::objective_too_long(objective)
        {
            return Err(failed("start_turn", detail));
        }
        let run_id = input.run_id.as_str();
        // A start that Stop abandoned may have reached Codex: its turn is stopped and must
        // end before the next one starts on the thread.
        inner
            .unless_abandoned(run_id, async {
                inner.settle_abandoned_start().await;
                Ok(())
            })
            .await?;
        let model = launch::selection_model(&input.model_selection);
        if inner.lock().thread.is_none() {
            let native = native_thread_id(&input.provider_thread)
                .ok_or_else(|| failed("start_turn", "provider thread has no native Codex id"))?;
            let mut state = inner.lock();
            state.thread = Some((native, None));
            state.app_thread_id = Some(input.thread_id.as_str().to_owned());
        }
        let native = inner
            .unless_abandoned(
                run_id,
                inner.loaded_thread(Some(&input.runtime_policy), Some(&model)),
            )
            .await?;
        inner.check_open()?;
        if inner.lock().mapper.thread_busy(&native) {
            return Err(failed("start_turn", "the previous turn is still running"));
        }
        if let Some(command) = goal {
            return self.run_goal_command(&native, &input, command).await;
        }
        // A restart continuation starts the native turn without input: Codex resumes on
        // its own (`startTurn`, `restartContinuationOfRunId`).
        let codex_input = if input.restart_continuation_of_run_id.is_some() {
            json!([])
        } else {
            launch::user_input(
                &input.message.text,
                &input.message.attachments,
                inner.attachments_dir.as_deref(),
            )
            .map_err(|detail| ProviderError::Protocol { detail })?
        };
        self.start_native_turn(&native, &input, codex_input).await
    }

    /// `startNativeTurn`: `turn/start` with this input on the loaded thread.
    async fn start_native_turn(
        &self,
        native: &str,
        input: &TurnInput,
        codex_input: Value,
    ) -> ProviderResult<()> {
        let inner = &self.inner;
        let run_id = input.run_id.as_str();
        let config = inner.server.request(
            "config/read",
            json!({"cwd": input.runtime_policy.cwd, "includeLayers": false}),
        );
        let summary = inner
            .unless_abandoned(run_id, async { Ok(config.await) })
            .await?
            .ok()
            .and_then(|r| {
                r["config"]["model_reasoning_summary"]
                    .as_str()
                    .map(str::to_owned)
            });
        inner.check_open()?;
        // TS: `hasT3Mcp` when the thread has an MCP session; the engine passes it as the
        // `conn` server, with the session's `device` capability. Browser tools on: the
        // session carries no finer answer (TS reads `browserToolsAvailable`).
        let t3_tools = inner
            .lock()
            .mcp_servers
            .iter()
            .find(|s| s.name == "conn")
            .map(|s| ToolAvailability {
                device: s.device_tools,
                ..ToolAvailability::default()
            });
        let params = launch::turn_start_params(
            native,
            codex_input,
            &input.runtime_policy,
            &input.model_selection,
            summary.as_deref(),
            t3_tools,
            &input.app_context,
        );
        {
            let mut state = inner.lock();
            state.mapper.begin_turn(native, input);
            state.sent_app_notes = Some((
                native.to_owned(),
                input
                    .app_context
                    .iter()
                    .map(|e| (e.key.clone(), e.text.clone()))
                    .collect(),
            ));
        }
        // Written first, then awaited, so a Stop knows whether the request went out.
        let sent = inner
            .unless_abandoned(run_id, async {
                Ok(inner.server.send("turn/start", params).await)
            })
            .await;
        let reply = match sent {
            Ok(Ok(reply)) => reply,
            Ok(Err(e)) => {
                inner.lock().mapper.abandon_turn(native);
                return Err(call_failed("start_turn")(e));
            }
            Err(abandoned) => {
                // Not written: Codex never sees it.
                inner.lock().mapper.abandon_turn(native);
                return Err(abandoned);
            }
        };
        let mut answer = Box::pin(reply.wait());
        let started = inner
            .unless_abandoned(run_id, async { Ok((&mut answer).await) })
            .await;
        let started = match started {
            Ok(started) => started,
            Err(abandoned) => {
                // A `turn/started` already gave the run its turn: the start is accepted, and
                // the engine stops the turn as one Codex accepted after Stop.
                if inner.lock().mapper.run_registered(run_id) {
                    return Ok(());
                }
                // Codex may have the turn. Its answer goes to a watcher that stops the turn
                // (`turn/interrupt`); T3 leaves it running (see the crate README).
                let id = inner.lock().mapper.abandon_turn_start(native);
                if let Some(id) = id {
                    tokio::spawn(watch_abandoned_start(
                        Arc::downgrade(&self.inner),
                        Arc::clone(&inner.server),
                        id,
                        native.to_owned(),
                        answer,
                        inner.abandoned_start_timeout,
                    ));
                }
                return Err(abandoned);
            }
        };
        match started {
            Ok(result) => {
                let outs = inner.lock().mapper.turn_start_result(native, &result);
                inner.deliver(outs).await;
                Ok(())
            }
            Err(e) => {
                inner.lock().mapper.abandon_turn(native);
                Err(call_failed("start_turn")(e))
            }
        }
    }

    /// `turn/interrupt` for the turn and its lineage, then the wait for Codex to end it.
    /// Stops the requested turn's lineage, and that of `earlier` (roots a goal Stop took
    /// before its pause, whose turns may have ended meanwhile).
    async fn interrupt_native(
        &self,
        input: InterruptInput,
        earlier: Vec<String>,
    ) -> ProviderResult<()> {
        let (native_turn, roots) = {
            let state = self.inner.lock();
            let turn = state.mapper.native_turn(input.provider_turn_id.as_str());
            let mut roots = turn
                .as_deref()
                .map(|turn| state.mapper.lineage_roots(turn))
                .unwrap_or_default();
            roots.extend(earlier);
            (turn, roots)
        };
        if roots.is_empty() {
            return Ok(());
        }
        self.interrupt_lineage(native_turn.as_deref(), &roots).await
    }

    /// Stops the lineage of `roots` (provider turn ids): `turn/interrupt` for each running turn,
    /// the requested one (`native_turn`) first, and `thread/backgroundTerminals/terminate` for
    /// each terminal they or the roots' completed turns left running, as in T3.
    async fn interrupt_lineage(
        &self,
        native_turn: Option<&str>,
        roots: &[String],
    ) -> ProviderResult<()> {
        let inner = &self.inner;
        let (targets, settled) = {
            let mut state = inner.lock();
            let mut targets: Vec<(String, String, Vec<String>)> = state
                .mapper
                .lineage(roots)
                .into_iter()
                .map(|(thread, native)| {
                    let processes = state.mapper.running_processes(&native);
                    (thread, native, processes)
                })
                .collect();
            if let Some(first) = targets
                .iter()
                .position(|(_, native, _)| Some(native.as_str()) == native_turn)
            {
                targets.swap(0, first);
            }
            for (_, native, _) in &targets {
                state.mapper.mark_interrupting(native);
            }
            (targets, state.mapper.settled_processes(roots))
        };
        let mut sent = Ok(Value::Null);
        for (thread, native, _) in &targets {
            if !inner.lock().mapper.is_active(native) {
                continue;
            }
            let result = inner
                .server
                .request(
                    "turn/interrupt",
                    json!({"threadId": thread, "turnId": native}),
                )
                .await;
            if Some(native.as_str()) == native_turn {
                sent = result;
            }
        }
        let mut terminals: Vec<(&str, &str)> = Vec::new();
        for (thread, _, processes) in &targets {
            terminals.extend(processes.iter().map(|p| (thread.as_str(), p.as_str())));
        }
        terminals.extend(settled.iter().map(|(t, p)| (t.as_str(), p.as_str())));
        for (thread, process) in terminals {
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
                let open = {
                    let state = inner.lock();
                    targets
                        .iter()
                        .any(|(_, native, _)| state.mapper.is_active(native))
                };
                if !open {
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
        // `deferToActiveRoots`: past the deadline, a root Codex already ended no longer
        // waits for silent descendants; the rest of the lineage settles now.
        let root_ended = native_turn.is_none_or(|turn| !inner.lock().mapper.is_active(turn));
        if confirmed || root_ended {
            settle_lineage(inner, roots, &targets).await;
        } else if let Some(turn) = native_turn
            && !inner.lock().closed
        {
            // The Stop stays pending: when Codex ends the root later, the rest of its
            // lineage settles then (T3 forks the same wait on the roots' completion).
            tokio::spawn(settle_when_root_ends(
                Arc::downgrade(inner),
                turn.to_owned(),
                roots.to_vec(),
                targets.clone(),
            ));
        }
        // Codex may still be working: the turn stays open and marked interrupting, and
        // whatever ends it later (Codex's `turn/completed`, a close, Force stop) settles it
        // (T3 since b5b470542a, `deferToActiveRoots`).
        if confirmed || root_ended || inner.lock().closed {
            Ok(())
        } else {
            Err(ProviderError::InterruptTimeout {
                timeout_ms: u64::try_from(inner.stop_confirm_timeout.as_millis())
                    .unwrap_or(u64::MAX),
            })
        }
    }

    /// `runGoalCommand`: the goal's native operations. Setting or resuming a goal starts its
    /// first turn with this run's settings; the other commands settle the run with no model
    /// turn. Updates held while a goal is set show once, with the result.
    async fn run_goal_command(
        &self,
        native: &str,
        input: &TurnInput,
        command: GoalCommand,
    ) -> ProviderResult<()> {
        let result = self.goal_command(native, input, command).await;
        let outs = self.inner.lock().mapper.release_goal_updates(native);
        self.inner.deliver(outs).await;
        result
    }

    async fn goal_command(
        &self,
        native: &str,
        input: &TurnInput,
        command: GoalCommand,
    ) -> ProviderResult<()> {
        let inner = &self.inner;
        let run_id = input.run_id.as_str();
        // Each request goes out only while the start stands, and its wait ends with it (T3
        // interrupts `startTurn`): an abandoned command changes no goal.
        let request = |method: &'static str, params: Value| async move {
            inner.ensure_not_abandoned(run_id)?;
            let result = inner
                .unless_abandoned(run_id, async {
                    inner
                        .server
                        .request(method, params)
                        .await
                        .map_err(call_failed("start_turn"))
                })
                .await;
            inner.check_open()?;
            result
        };
        // A goal answer loses to a notification for the thread that came after it went out.
        let set = |params: Value| async move {
            let version = inner.lock().mapper.goal_version();
            let answer = request("thread/goal/set", params).await?;
            inner
                .lock()
                .mapper
                .store_goal_answer(native, &answer["goal"], version);
            Ok::<_, ProviderError>(())
        };
        inner
            .lock()
            .mapper
            .remember_root_thread(native, to_json(&input.provider_thread), false);
        let current = request("thread/goal/get", json!({ "threadId": native })).await?;
        inner.lock().mapper.store_goal(native, &current["goal"]);
        let current = mapper::provider_goal(&current["goal"]);
        let none = || Some("No goal is set.".to_owned());
        let reply = match command {
            GoalCommand::Show => {
                if current.is_null() {
                    none()
                } else {
                    Some(mapper::describe_goal(&current))
                }
            }
            GoalCommand::Clear => {
                let cleared = request("thread/goal/clear", json!({ "threadId": native })).await?;
                inner.lock().mapper.store_goal(native, &Value::Null);
                if cleared["cleared"] == true {
                    None
                } else {
                    none()
                }
            }
            GoalCommand::Pause | GoalCommand::Resume if current.is_null() => none(),
            GoalCommand::Pause => {
                set(json!({"threadId": native, "status": "paused"})).await?;
                None
            }
            GoalCommand::Set(objective) => {
                inner.lock().mapper.hold_goal_updates(native);
                if !current.is_null() {
                    request("thread/goal/clear", json!({ "threadId": native })).await?;
                }
                // Paused until our turn starts, so Codex cannot start one first.
                set(json!({"threadId": native, "objective": objective, "status": "paused"}))
                    .await?;
                let codex_input = launch::user_input(
                    &format!("{GOAL_START_PROMPT}{objective}"),
                    &input.message.attachments,
                    inner.attachments_dir.as_deref(),
                )
                .map_err(|detail| ProviderError::Protocol { detail })?;
                return self.activate_goal(native, input, codex_input).await;
            }
            GoalCommand::Resume => return self.activate_goal(native, input, json!([])).await,
        };
        // The goal row still shows what the command changed; the run is no longer ours.
        if let Err(abandoned) = inner.ensure_not_abandoned(run_id) {
            let outs = inner.lock().mapper.remember_root_thread(
                native,
                to_json(&input.provider_thread),
                true,
            );
            inner.deliver(outs).await;
            return Err(abandoned);
        }
        let outs = inner
            .lock()
            .mapper
            .goal_command_turn(native, input, reply.as_deref());
        inner.deliver(outs).await;
        Ok(())
    }

    /// `activateGoal`: starts the turn, then makes its paused goal active. A Stop in between
    /// leaves the goal paused. A start Stop abandoned after its turn started sets nothing more
    /// and stops that turn.
    async fn activate_goal(
        &self,
        native: &str,
        input: &TurnInput,
        codex_input: Value,
    ) -> ProviderResult<()> {
        let inner = &self.inner;
        let run_id = input.run_id.as_str();
        inner.lock().mapper.begin_goal_activation(native);
        let mut started = false;
        let result = async {
            self.start_native_turn(native, input, codex_input).await?;
            started = true;
            let set = |status: &'static str| async move {
                inner.ensure_not_abandoned(run_id)?;
                let version = inner.lock().mapper.goal_version();
                let answer = inner
                    .unless_abandoned(run_id, async {
                        inner
                            .server
                            .request(
                                "thread/goal/set",
                                json!({"threadId": native, "status": status}),
                            )
                            .await
                            .map_err(call_failed("start_turn"))
                    })
                    .await?;
                inner
                    .lock()
                    .mapper
                    .store_goal_answer(native, &answer["goal"], version);
                Ok::<_, ProviderError>(())
            };
            if inner.lock().mapper.goal_activation_stopped(native) {
                return Ok(());
            }
            set("active").await?;
            if inner.lock().mapper.goal_activation_stopped(native) {
                set("paused").await?;
            }
            Ok(())
        }
        .await;
        if started
            && result.is_err()
            && inner.start_abandoned(run_id)
            && let Some(turn) = inner.lock().mapper.run_native_turn(run_id)
        {
            tokio::spawn(interrupt(
                Arc::clone(&inner.server),
                native.to_owned(),
                turn,
            ));
        }
        // The goal row shows before the run can settle.
        let outs = {
            let mut state = inner.lock();
            let mut outs = state.mapper.release_goal_updates(native);
            outs.extend(state.mapper.end_goal_activation(native));
            outs
        };
        inner.deliver(outs).await;
        result
    }

    pub(crate) fn open(
        id: ProviderSessionId,
        instance_id: &ProviderInstanceId,
        server: Arc<AppServer>,
        events: mpsc::Sender<ProviderEvent>,
        config: &crate::CodexConfig,
        open: (Option<String>, Option<String>),
        mcp_servers: Vec<McpServer>,
    ) -> Self {
        let (inbox, rx) = mpsc::channel(EVENT_CAPACITY);
        server.add_session(id.as_str(), inbox.clone());
        let inner = Arc::new(Inner {
            id: id.as_str().to_owned(),
            instance_id: instance_id.as_str().to_owned(),
            attachments_dir: config.attachments_dir.clone(),
            stop_confirm_timeout: config.stop_confirm_timeout,
            abandoned_start_timeout: config.abandoned_start_timeout,
            child_check_interval: config.child_check_interval,
            goal_continuation_grace: config.goal_continuation_grace,
            open_model: open.0,
            open_cwd: open.1,
            server,
            inbox,
            state: Mutex::new(State {
                mapper: Mapper::new(SystemEnv),
                events: Some(events),
                thread: None,
                app_thread_id: None,
                // Codex reads them from each thread's config (`thread/start`, resume, fork).
                mcp_servers,
                closed: false,
                lingering: None,
                released: false,
                abandoned_run: None,
                logged: HashSet::new(),
                sent_app_notes: None,
                goal_tasks: Vec::new(),
            }),
            progressed: Notify::new(),
            abandon: Notify::new(),
        });
        tokio::spawn(drive(Arc::downgrade(&inner), rx));
        Self { id, inner }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        crate::lock(&self.state)
    }

    /// After a close: while subagent turns that may outlive it are open, the session keeps
    /// itself, its routes and its events; once none is open, it lets go of all three.
    fn settle_closed(self: &Arc<Self>) {
        let (done, held, watch) = {
            let mut state = self.lock();
            if !state.released {
                return;
            }
            if state.mapper.open_child_threads().is_empty() {
                state.events = None;
                (true, state.lingering.take(), false)
            } else if state.lingering.is_none() {
                state.lingering = Some(Arc::clone(self));
                (false, None, true)
            } else {
                (false, None, false)
            }
        };
        if done {
            self.server.unroute_inbox(&self.inbox);
            self.server.forget_detached(&self.id);
        }
        if watch {
            tokio::spawn(watch_children(
                Arc::downgrade(self),
                self.child_check_interval,
            ));
        }
        drop(held);
    }

    fn start_abandoned(&self, run_id: &str) -> bool {
        self.lock().abandoned_run.as_deref() == Some(run_id)
    }

    /// Runs `work` unless the engine abandons `run_id`'s start first. Then `work` is dropped,
    /// as T3's worker interrupts the start: a request already written is not awaited, and
    /// nothing more is sent.
    async fn unless_abandoned<T>(
        &self,
        run_id: &str,
        work: impl std::future::Future<Output = ProviderResult<T>>,
    ) -> ProviderResult<T> {
        let abandoned = async {
            loop {
                let notified = self.abandon.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.start_abandoned(run_id) {
                    return;
                }
                notified.await;
            }
        };
        tokio::select! {
            result = work => result,
            () = abandoned => Err(abandoned_start()),
        }
    }

    /// Fails once Stop abandoned `run_id`'s start; checked before each later request.
    fn ensure_not_abandoned(&self, run_id: &str) -> ProviderResult<()> {
        if self.start_abandoned(run_id) {
            Err(abandoned_start())
        } else {
            Ok(())
        }
    }

    /// Fails once the session closed; checked after each await of a multi-step call.
    fn check_open(&self) -> ProviderResult<()> {
        if self.lock().closed {
            Err(ProviderError::SessionStopped)
        } else {
            Ok(())
        }
    }

    /// Waits until a start that Stop abandoned has settled: its answer named no turn, or
    /// its turn ended. Bounded by the answer's limit plus the Stop confirmation's; past that
    /// the next start goes ahead.
    async fn settle_abandoned_start(&self) {
        let wait = async {
            loop {
                let progressed = self.progressed.notified();
                tokio::pin!(progressed);
                progressed.as_mut().enable();
                if !self.lock().mapper.abandoned_start_open() {
                    return;
                }
                progressed.await;
            }
        };
        let bound = self.abandoned_start_timeout + self.stop_confirm_timeout;
        if tokio::time::timeout(bound, wait).await.is_err() {
            eprintln!("conn-provider-codex: a turn Stop abandoned did not end; starting the next");
            self.lock().mapper.forget_abandoned_start();
        }
    }

    /// Sends events and replies in order. Holds no lock across a send. Wakes the waiters on
    /// [`Self::progressed`] even with nothing to send: a frame can change state silently.
    async fn deliver(&self, outs: Vec<Out>) {
        if outs.is_empty() {
            self.progressed.notify_waiters();
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
                Out::ChildMetadata(thread) => {
                    let server = Arc::clone(&self.server);
                    let inbox = self.inbox.clone();
                    tokio::spawn(async move {
                        let response = tokio::time::timeout(
                            CHILD_METADATA_TIMEOUT,
                            child_metadata(&server, &thread),
                        )
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or(Value::Null);
                        let _ = inbox
                            .send(SessionMsg::ChildMetadata { thread, response })
                            .await;
                    });
                }
                Out::InterruptChild { thread, turn } => {
                    tokio::spawn(interrupt(Arc::clone(&self.server), thread, turn));
                }
                Out::InterruptAbandoned { thread, turn } => {
                    tokio::spawn(interrupt(Arc::clone(&self.server), thread, turn));
                }
                Out::GoalHeld { thread, seq } => {
                    let inbox = self.inbox.clone();
                    let grace = self.goal_continuation_grace;
                    self.spawn_goal_task(async move {
                        tokio::time::sleep(grace).await;
                        let _ = inbox.send(SessionMsg::GoalGrace { thread, seq }).await;
                    });
                }
                Out::PauseGoal { thread } => {
                    let server = Arc::clone(&self.server);
                    let inbox = self.inbox.clone();
                    self.spawn_goal_task(async move {
                        let pause = server.request(
                            "thread/goal/set",
                            json!({"threadId": thread, "status": "paused"}),
                        );
                        // No answer in time: the claimed run settles all the same.
                        let response = tokio::time::timeout(GOAL_PAUSE_TIMEOUT, pause)
                            .await
                            .ok()
                            .and_then(Result::ok);
                        let _ = inbox
                            .send(SessionMsg::GoalPaused { thread, response })
                            .await;
                    });
                }
                Out::StopOrphanGoalTurn { thread, turn } => {
                    let server = Arc::clone(&self.server);
                    tokio::spawn(async move {
                        // A failed pause still stops the turn.
                        let _ = server
                            .request(
                                "thread/goal/set",
                                json!({"threadId": thread, "status": "paused"}),
                            )
                            .await;
                        interrupt(server, thread, turn).await;
                    });
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

    /// Runs a goal timer or expiry pause that close cancels; none starts once close began.
    fn spawn_goal_task(&self, task: impl std::future::Future<Output = ()> + Send + 'static) {
        let mut state = self.lock();
        if state.closed {
            return;
        }
        state.goal_tasks.retain(|t| !t.is_finished());
        state.goal_tasks.push(tokio::spawn(task).abort_handle());
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
        // Another session that owns the thread (a closed one waiting for its subagent) keeps
        // its frames until Codex accepts the resume: a completion sent before a refusal reaches
        // it.
        let claim = self.server.claim_route(native, &self.inbox);
        if !force && self.server.is_loaded(native) {
            self.server.route(native, self.inbox.clone());
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
                match self
                    .server
                    .request("thread/unarchive", json!({ "threadId": native }))
                    .await
                {
                    Ok(_) => self.server.request("thread/resume", params).await,
                    Err(e) => Err(e),
                }
            }
            other => other,
        };
        match (&result, claim) {
            (Ok(_), Claim::Elsewhere) => self.server.route(native, self.inbox.clone()),
            (Err(_), Claim::Taken) => self.server.unroute_from(native, &self.inbox),
            _ => {}
        }
        let result = result.map_err(|e| match &e {
            // `isCodexActiveWriterError`.
            CallError::Rpc(rpc)
                if rpc.code == -32600 && rpc.message.contains("already has an active writer") =>
            {
                ProviderError::ThreadInUse {
                    detail: CODEX_THREAD_IN_USE_MESSAGE.to_owned(),
                }
            }
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
                SessionMsg::ChildMetadata { thread, response } => {
                    state.mapper.child_metadata(&thread, &response)
                }
                SessionMsg::ChildRead { thread, read } => {
                    apply_child_read(&mut state.mapper, &thread, &read)
                }
                // A closing session pauses no goal; its close settles the held run.
                SessionMsg::GoalGrace { .. } | SessionMsg::GoalPaused { .. } if state.closed => {
                    Vec::new()
                }
                SessionMsg::GoalGrace { thread, seq } => {
                    state.mapper.goal_grace_ended(&thread, seq)
                }
                SessionMsg::GoalPaused { thread, response } => {
                    state.mapper.goal_paused(&thread, response.as_ref())
                }
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
        inner.settle_closed();
    }
}

/// After a close on a shared app-server, the closed session's subagents may go silent. Every
/// `interval`, each open one is checked with Codex (`thread/read` with turns, as T3's
/// `readThreadSnapshot`): a turn Codex reports ended ends here, and a thread Codex does not
/// know (`thread not found:`) ends interrupted. Any other failed read is tried again. At the
/// last of [`MAX_CHILD_CHECKS`] checks, each open child turn that Codex's latest read did not
/// report `inProgress` gets `turn/interrupt` and is read once more. A turn Codex reports running
/// is only read: Stop or its own end settles it. A read that fails after that is tried again
/// once per `interval`, without another interrupt. Every answer goes through the session's
/// inbox, so the driver applies it in order with Codex's frames.
async fn watch_children(inner: std::sync::Weak<Inner>, interval: Duration) {
    // Past the last check: the threads whose read after the interrupt failed, read again once
    // per `interval` until Codex answers, without another interrupt.
    let mut inconclusive: Option<Vec<String>> = None;
    // The (thread, turn) pairs Codex's latest read of each thread reported `inProgress`.
    let mut running: Vec<(String, String)> = Vec::new();
    let mut check: u32 = 0;
    loop {
        check = check.saturating_add(1);
        tokio::time::sleep(interval).await;
        let Some(strong) = inner.upgrade() else {
            return;
        };
        if strong.lock().lingering.is_none() {
            return;
        }
        let last = check == MAX_CHILD_CHECKS;
        let (server, inbox, mut threads) = {
            let state = strong.lock();
            (
                Arc::clone(&strong.server),
                strong.inbox.clone(),
                state.mapper.open_child_threads(),
            )
        };
        drop(strong);
        if let Some(retry) = &inconclusive {
            threads.retain(|thread| retry.contains(thread));
        }
        let mut failed = Vec::new();
        for thread in threads {
            if last {
                let turns: Vec<String> = inner
                    .upgrade()
                    .map(|i| i.lock().mapper.open_child_turns())
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|(t, turn)| {
                        *t == thread && !running.contains(&(t.clone(), turn.clone()))
                    })
                    .map(|(_, turn)| turn)
                    .collect();
                for turn in turns {
                    interrupt(Arc::clone(&server), thread.clone(), turn).await;
                }
            }
            let answer = server
                .request(
                    "thread/read",
                    json!({"threadId": thread, "includeTurns": true}),
                )
                .await;
            let read = match answer {
                Err(CallError::Rpc(e))
                    if e.code == -32600 && e.message.starts_with("thread not found:") =>
                {
                    ChildRead::Missing
                }
                Ok(answer) => {
                    running.retain(|(t, _)| *t != thread);
                    running.extend(
                        answer["thread"]["turns"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|turn| turn["status"] == "inProgress")
                            .filter_map(|turn| turn["id"].as_str())
                            .map(|turn| (thread.clone(), turn.to_owned())),
                    );
                    ChildRead::Turns(answer)
                }
                // Tried again at the next check; the process's exit ends them if it stopped.
                Err(_) => {
                    failed.push(thread);
                    continue;
                }
            };
            if inbox
                .send(SessionMsg::ChildRead { thread, read })
                .await
                .is_err()
            {
                return;
            }
        }
        if check >= MAX_CHILD_CHECKS {
            if failed.is_empty() {
                return;
            }
            inconclusive = Some(failed);
        }
    }
}

/// Applies a [`ChildRead`] of `thread` to the mapper.
fn apply_child_read(mapper: &mut Mapper<SystemEnv>, thread: &str, read: &ChildRead) -> Vec<Out> {
    let ended = |status: &Value| match status.as_str() {
        Some("completed") => Some("completed"),
        Some("interrupted") => Some("interrupted"),
        Some("failed") => Some("failed"),
        _ => None,
    };
    let open: Vec<String> = mapper
        .open_child_turns()
        .into_iter()
        .filter(|(t, _)| t == thread)
        .map(|(_, turn)| turn)
        .collect();
    let answer = match read {
        ChildRead::Turns(answer) => Some(answer),
        ChildRead::Missing => None,
    };
    let turns = answer.and_then(|a| a["thread"]["turns"].as_array());
    let mut outs = Vec::new();
    for turn in &open {
        let status = turns
            .into_iter()
            .flatten()
            .find(|t| t["id"] == turn.as_str())
            .and_then(|t| ended(&t["status"]));
        if let Some(status) = status {
            outs.extend(mapper.end_turn(turn, status));
        }
    }
    // Announced, no turn here: its latest turn on Codex says how it ended.
    if open.is_empty()
        && let Some(status) = turns
            .and_then(|t| t.last())
            .and_then(|t| ended(&t["status"]))
    {
        outs.extend(mapper.end_idle_child(thread, status));
    }
    if matches!(read, ChildRead::Missing) {
        for turn in &open {
            outs.extend(mapper.end_interrupted(turn));
        }
        outs.extend(mapper.end_idle_child(thread, "interrupted"));
    }
    outs
}

/// `turn/interrupt` for a turn no run owns, at most [`CHILD_INTERRUPT_TIMEOUT`]. Starts no
/// process: once the last session is gone the request fails at once. A turn it does not stop
/// ends on its own.
async fn interrupt(server: Arc<AppServer>, thread: String, turn: String) {
    let request = server.request(
        "turn/interrupt",
        json!({"threadId": thread, "turnId": turn}),
    );
    let _ = tokio::time::timeout(CHILD_INTERRUPT_TIMEOUT, request).await;
}

/// The answer to a `turn/start` that Stop abandoned after it was written, at most `bound`.
/// A turn it names is stopped. With the session gone (dropped), the turn is stopped
/// directly; the process is gone too once no session is left, and then nothing is sent.
async fn watch_abandoned_start(
    inner: std::sync::Weak<Inner>,
    server: Arc<AppServer>,
    id: u64,
    native: String,
    answer: std::pin::Pin<Box<impl std::future::Future<Output = Result<Value, CallError>>>>,
    bound: Duration,
) {
    let answer = tokio::time::timeout(bound, answer).await;
    let turn = match &answer {
        Ok(Ok(result)) => result["turn"]["id"].as_str().map(str::to_owned),
        _ => None,
    };
    match inner.upgrade() {
        Some(inner) => {
            let outs = {
                let mut state = inner.lock();
                match &turn {
                    Some(turn) => state.mapper.abandoned_start_answered(id, &native, turn),
                    None => {
                        state.mapper.abandoned_start_settled(id);
                        Vec::new()
                    }
                }
            };
            inner.deliver(outs).await;
        }
        None => {
            if let Some(turn) = turn {
                interrupt(server, native, turn).await;
            }
        }
    }
}

/// A Stop that timed out while its root still ran: once the root ends, the rest of its lineage
/// settles. Ends with the session.
async fn settle_when_root_ends(
    inner: std::sync::Weak<Inner>,
    root: String,
    roots: Vec<String>,
    targets: Vec<(String, String, Vec<String>)>,
) {
    loop {
        let Some(strong) = inner.upgrade() else {
            return;
        };
        let progressed = strong.progressed.notified();
        tokio::pin!(progressed);
        progressed.as_mut().enable();
        let (closed, running) = {
            let state = strong.lock();
            (state.closed, state.mapper.is_active(&root))
        };
        if closed {
            return;
        }
        if !running {
            settle_lineage(&strong, &roots, &targets).await;
            return;
        }
        progressed.await;
    }
}

/// After a confirmed Stop: subagent turns of the lineage that started meanwhile get
/// `turn/interrupt` (`interruptLateDescendants`), and any still open end as interrupted
/// (`finalizeRemainingInterruptLineage`).
async fn settle_lineage(
    inner: &Inner,
    roots: &[String],
    targets: &[(String, String, Vec<String>)],
) {
    let late: Vec<(String, String)> = inner
        .lock()
        .mapper
        .lineage(roots)
        .into_iter()
        .filter(|(_, native)| !targets.iter().any(|(_, t, _)| t == native))
        .collect();
    for (thread, native) in &late {
        inner.lock().mapper.mark_interrupting(native);
        let request = inner.server.request(
            "turn/interrupt",
            json!({"threadId": thread, "turnId": native}),
        );
        let _ = tokio::time::timeout(CHILD_INTERRUPT_TIMEOUT, request).await;
    }
    let outs: Vec<Out> = {
        let mut state = inner.lock();
        let open = state.mapper.lineage(roots);
        open.into_iter()
            .flat_map(|(_, native)| state.mapper.end_interrupted(&native))
            .collect()
    };
    inner.deliver(outs).await;
    // `terminateTrackedTerminals`: the lineage's background processes that Codex reported
    // after the Stop's first snapshot, which already terminated its own.
    let pending: Vec<(String, String)> = {
        let mut state = inner.lock();
        let lineage = targets
            .iter()
            .map(|(thread, native, done)| (thread, native, done.as_slice()))
            .chain(
                late.iter()
                    .map(|(thread, native)| (thread, native, &[][..])),
            );
        let mut pending = Vec::new();
        for (thread, native, done) in lineage {
            for process in state.mapper.take_stop_processes(native) {
                if !done.contains(&process) {
                    pending.push((thread.clone(), process));
                }
            }
        }
        pending
    };
    for (thread, process) in pending {
        let request = inner.server.request(
            "thread/backgroundTerminals/terminate",
            json!({"threadId": thread, "processId": process}),
        );
        let _ = tokio::time::timeout(CHILD_INTERRUPT_TIMEOUT, request).await;
    }
}

/// T3's child model read: `thread/read` without turns; when that names no model,
/// `thread/resume` without turns. The answer as `{thread, model, reasoningEffort?,
/// serviceTier?}`, or `None`.
async fn child_metadata(server: &Arc<AppServer>, thread: &str) -> Option<Value> {
    let read = server
        .request(
            "thread/read",
            json!({"threadId": thread, "includeTurns": false}),
        )
        .await
        .ok();
    if let Some(read) = read
        && read["thread"]["id"] == thread
        && read["thread"]["model"]
            .as_str()
            .is_some_and(|m| !m.trim().is_empty())
    {
        let mut answer = json!({"thread": read["thread"], "model": read["thread"]["model"]});
        if let Some(effort) = read["thread"].get("reasoningEffort") {
            answer["reasoningEffort"] = effort.clone();
        }
        return Some(answer);
    }
    let resumed = server
        .request(
            "thread/resume",
            json!({"threadId": thread, "excludeTurns": true}),
        )
        .await
        .ok()?;
    // `CodexChildSelection`: the model is a string or null.
    (resumed["model"].is_string() || resumed["model"].is_null()).then_some(resumed)
}

fn failed(operation: &'static str, detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation,
        detail: detail.into(),
    }
}

/// A start Stop abandoned (`abandon_turn_start`) before Codex took it.
fn abandoned_start() -> ProviderError {
    failed("start_turn", "Stop ended the turn before Codex started it.")
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

    fn mcp_app_request(
        &self,
        input: conn_provider::mcp_apps::Request,
    ) -> BoxFuture<'_, ProviderResult<Value>> {
        Box::pin(async move {
            use conn_provider::mcp_apps::Operation;
            if self.inner.lock().closed {
                return Err(ProviderError::SessionStopped);
            }
            let native = native_thread_id(&input.provider_thread).ok_or_else(|| {
                ProviderError::Protocol {
                    detail: format!(
                        "Provider thread {} is missing a native Codex thread id.",
                        input.provider_thread.id
                    ),
                }
            })?;
            let (method, params) = match &input.operation {
                Operation::ListTools => (
                    "mcpServerStatus/list",
                    json!({"threadId":native,"serverName":input.server,"detail":"toolsAndAuthOnly"}),
                ),
                Operation::CallTool { tool, arguments } => (
                    "mcpServer/tool/call",
                    json!({"threadId":native,"server":input.server,"tool":tool,"arguments":arguments}),
                ),
                Operation::ReadResource { uri } => (
                    "mcpServer/resource/read",
                    json!({"threadId":native,"server":input.server,"uri":uri}),
                ),
            };
            let mut response = self.inner.server.request(method, params.clone()).await;
            if matches!(&response, Err(CallError::Rpc(e)) if e.code == -32600 && e.message.starts_with("thread not found:"))
            {
                self.inner
                    .resume(
                        &native,
                        input.provider_thread.app_thread_id.as_deref(),
                        self.inner.open_cwd.as_deref(),
                        self.inner.open_model.as_deref(),
                        true,
                    )
                    .await?;
                response = self.inner.server.request(method, params).await;
            }
            let response = response.map_err(call_failed("mcp_app_request"))?;
            Ok(match input.operation {
                Operation::ListTools => response
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|s| s.get("name").and_then(Value::as_str) == Some(input.server.as_str()))
                    .and_then(|s| s.get("tools"))
                    .and_then(Value::as_object)
                    .map_or_else(
                        || json!([]),
                        |tools| json!(tools.values().collect::<Vec<_>>()),
                    ),
                Operation::CallTool { .. } => conn_provider::mcp_apps::call_result(&response),
                Operation::ReadResource { .. } => {
                    json!({"contents":response.get("contents").cloned().unwrap_or_else(||json!([]))})
                }
            })
        })
    }

    fn thread_load_model_selection(
        &self,
        selection: &conn_contract::ModelSelection,
    ) -> conn_contract::ModelSelection {
        launch::thread_load_selection(selection)
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
            let run_id = input.run_id.as_str().to_owned();
            let result = self.start_turn_inner(input).await;
            let mut state = self.inner.lock();
            if state.abandoned_run.as_deref() == Some(run_id.as_str()) {
                state.abandoned_run = None;
            }
            result
        })
    }

    /// Stop ended the run before Codex accepted the turn: the start stops at its next wait
    /// (`thread/start` or `thread/resume`, `config/read`, `turn/start`) and sends nothing more,
    /// as T3's interrupted `startTurn`. A `turn/start` already written is different from T3:
    /// when its answer or a `turn/started` names the turn, it gets `turn/interrupt`, and the
    /// next start on the thread waits until that turn ended.
    fn abandon_turn_start(&self, input: conn_provider::AbandonTurnStartInput) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.inner.lock().abandoned_run = Some(input.run_id.as_str().to_owned());
            self.inner.abandon.notify_waiters();
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
            // `turn/steer` takes no `additionalContext`: notes the thread has not been sent go
            // as quoted user input before the message (T3's `steerTurn`).
            let unsent: Vec<&conn_provider::AppContextEntry> = {
                let state = inner.lock();
                let sent = state
                    .sent_app_notes
                    .as_ref()
                    .filter(|(native, _)| *native == thread)
                    .map(|(_, sent)| sent);
                input
                    .app_context
                    .iter()
                    .filter(|e| sent.and_then(|sent| sent.get(&e.key)) != Some(&e.text))
                    .collect()
            };
            let mut steer_input: Vec<Value> = unsent
                .iter()
                .map(|e| json!({"type": "text", "text": format!("<external_{0}>{1}</external_{0}>", e.key, e.text) }))
                .collect();
            match codex_input {
                Value::Array(items) => steer_input.extend(items),
                other => steer_input.push(other),
            }
            inner
                .server
                .request(
                    "turn/steer",
                    json!({"expectedTurnId": turn, "input": steer_input, "threadId": thread}),
                )
                .await
                .map_err(call_failed("steer_turn"))?;
            if !unsent.is_empty() {
                let mut state = inner.lock();
                if !state
                    .sent_app_notes
                    .as_ref()
                    .is_some_and(|(native, _)| *native == thread)
                {
                    state.sent_app_notes = Some((thread.clone(), HashMap::new()));
                }
                if let Some((_, sent)) = state.sent_app_notes.as_mut() {
                    sent.extend(unsent.iter().map(|e| (e.key.clone(), e.text.clone())));
                }
            }
            Ok(())
        })
    }

    fn injects_history(&self) -> bool {
        true
    }

    /// `injectHistory`: `thread/inject_items` on the thread's native id. Only an unknown
    /// method (-32601) is a refusal: it comes before the history changes. Any other failure
    /// leaves the delivery uncertain.
    fn inject_history(&self, input: InjectHistoryInput) -> BoxFuture<'_, ProviderResult<bool>> {
        Box::pin(async move {
            let Some(native) = native_thread_id(&input.provider_thread) else {
                return Err(failed("inject_history", "the thread has no native id"));
            };
            match self
                .inner
                .server
                .request(
                    "thread/inject_items",
                    json!({"threadId": native, "items": input.items}),
                )
                .await
            {
                Ok(_) => Ok(true),
                Err(CallError::Rpc(error)) if error.code == -32601 => Ok(false),
                Err(error) => Err(call_failed("inject_history")(error)),
            }
        })
    }

    /// `uploadFeedback`: `feedback/upload` as a bug with logs, on the thread's native id; the
    /// answer's `threadId` is the feedback id (T3's `CodexAdapterV2.uploadFeedback`).
    fn upload_feedback(&self, input: UploadFeedbackInput) -> BoxFuture<'_, ProviderResult<String>> {
        Box::pin(async move {
            let Some(native) = native_thread_id(&input.provider_thread) else {
                return Err(failed("upload_feedback", "the thread has no native id"));
            };
            let mut params = json!({"classification": "bug", "includeLogs": true});
            if let Some(reason) = input.reason {
                params["reason"] = json!(reason);
            }
            params["threadId"] = json!(native);
            let response = self
                .inner
                .server
                .request("feedback/upload", params)
                .await
                .map_err(call_failed("upload_feedback"))?;
            // The client's `feedbackId` is a `TrimmedNonEmptyString`: a blank id is a failure,
            // not an answer the client cannot decode.
            response["threadId"]
                .as_str()
                .map(|id| id.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| failed("upload_feedback", "feedback/upload answered no threadId"))
        })
    }

    /// `resolveGoalStopTarget` first: an active goal is paused, and a run held between goal
    /// turns ends interrupted with no `turn/interrupt`. A Stop that names an earlier turn of a
    /// goal run stops the turn Codex continued with.
    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            let Some(goal_thread) = native_thread_id(&input.provider_thread) else {
                return self.interrupt_native(input, Vec::new()).await;
            };
            // `turnsBefore`: the pause can let the run settle, which drops its turns.
            let earlier = {
                let mut state = inner.lock();
                state.mapper.goal_stop_begin(&goal_thread);
                state
                    .mapper
                    .stop_roots(&goal_thread, input.provider_turn_id.as_str())
            };
            let result = async {
                if inner.lock().mapper.goal_status(&goal_thread).as_deref() == Some("active") {
                    let version = inner.lock().mapper.goal_version();
                    let pause = inner.server.request(
                        "thread/goal/set",
                        json!({"threadId": goal_thread, "status": "paused"}),
                    );
                    // A failed pause still stops the turn (`codex-goal-pause-failed`).
                    if let Ok(result) = pause.await {
                        inner.lock().mapper.store_goal_answer(
                            &goal_thread,
                            &result["goal"],
                            version,
                        );
                    }
                }
                let held = inner
                    .lock()
                    .mapper
                    .stop_held_goal(&goal_thread, input.provider_turn_id.as_str());
                if let Some((outs, mut roots)) = held {
                    inner.deliver(outs).await;
                    roots.extend(earlier);
                    return self.interrupt_lineage(None, &roots).await;
                }
                self.interrupt_native(input, earlier).await
            }
            .await;
            inner.lock().mapper.goal_stop_end(&goal_thread);
            result
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

    fn close(&self) -> BoxFuture<'_, Closed> {
        Box::pin(async move {
            let inner = &self.inner;
            let thread = {
                let mut state = inner.lock();
                state.closed = true;
                state.mapper.begin_close();
                for task in state.goal_tasks.drain(..) {
                    task.abort();
                }
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
            // Whether the process outlives this session decides whether its subagents ended,
            // so it is known before the mapper ends anything. Their threads keep their routes.
            let kept = inner.lock().mapper.open_child_threads();
            let shared = inner.server.remove_session(&inner.id, &kept).await;
            let outs = inner.lock().mapper.on_close(shared);
            inner.deliver(outs).await;
            inner.lock().released = true;
            inner.settle_closed();
            if shared {
                Closed::RuntimeShared
            } else {
                Closed::RuntimeStopped
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
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
    *'"method":"mcpServerStatus/list"'*) emit "{\"id\":$id,\"result\":{\"data\":[{\"name\":\"apps-stub\",\"tools\":{\"refresh\":{\"name\":\"refresh\",\"annotations\":{\"readOnlyHint\":true}}}}]}}" ;;
    *'"method":"mcpServer/tool/call"'*) emit "{\"id\":$id,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"structuredContent\":{\"ok\":true},\"isError\":false,\"_meta\":{\"stub\":true}}}" ;;
    *'"method":"mcpServer/resource/read"'*'ui://unloaded'*)
      if [ "${mcp_loaded:-0}" = 0 ]; then emit "{\"id\":$id,\"error\":{\"code\":-32600,\"message\":\"thread not found: th1\"}}"; else emit "{\"id\":$id,\"result\":{\"contents\":[]}}"; fi ;;
    *'"method":"thread/resume"'*'th1'*) mcp_loaded=1; emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"th1\"}}}" ;;
    *'"method":"mcpServer/resource/read"'*) emit "{\"id\":$id,\"result\":{\"contents\":[{\"uri\":\"ui://stub\",\"text\":\"<h1>Stub</h1>\",\"mimeType\":\"text/html;profile=mcp-app\"}]}}" ;;
    *'"method":"config/read"'*) emit "{\"id\":$id,\"result\":{\"config\":{}}}" ;;
    *'"method":"turn/start"'*'stop late root'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu8\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu8","item":{"type":"subAgentActivity","id":"a8","kind":"started","agentThreadId":"ch8","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch8","turn":{"id":"ct8","status":"inProgress","startedAt":1}}}' ;;
    *'"method":"turn/interrupt"'*'"tu8"'*)
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"turn/interrupt"'*'"ct8"'*)
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"test/finishRoot8"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu8","status":"interrupted","completedAt":5}}}' ;;
    *'"method":"turn/start"'*'odd error child'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a9","kind":"started","agentThreadId":"ch9","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch9","turn":{"id":"ct9","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"completed","completedAt":5}}}' ;;
    *'"method":"thread/read"'*'"includeTurns":true'*'ch9'*)
      emit "{\"id\":$id,\"error\":{\"code\":-32600,\"message\":\"rollout for thread ch9 not found\"}}"
      if [ "${int9:-0}" = 1 ]; then sleep 0.3; emit '{"method":"turn/completed","params":{"threadId":"ch9","turn":{"id":"ct9","status":"completed","completedAt":5}}}'; fi ;;
    *'"method":"turn/interrupt"'*'"ct9"'*)
      int9=1
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"turn/start"'*'busy child'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"ab","kind":"started","agentThreadId":"chb","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"chb","turn":{"id":"ctb","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"completed","completedAt":5}}}' ;;
    *'"method":"thread/read"'*'"includeTurns":true'*'chb'*)
      readsb=$((${readsb:-0} + 1))
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"chb\",\"model\":\"gpt-6-luna\",\"turns\":[{\"id\":\"ctb\",\"status\":\"inProgress\"}]}}}"
      if [ "$readsb" = 60 ]; then emit '{"method":"turn/completed","params":{"threadId":"chb","turn":{"id":"ctb","status":"completed","completedAt":5}}}'; fi ;;
    *'"method":"turn/interrupt"'*'"ctb"'*)
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"turn/start"'*'stop quiet child'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu6\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu6","item":{"type":"subAgentActivity","id":"a4","kind":"started","agentThreadId":"ch4","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch4","turn":{"id":"ct4","status":"inProgress","startedAt":1}}}' ;;
    *'"method":"turn/interrupt"'*'"tu6"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu6","status":"interrupted","completedAt":3}}}' ;;
    *'"method":"turn/interrupt"'*'"ct4"'*)
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"turn/start"'*'twin children'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a5","kind":"started","agentThreadId":"ch5","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch5","turn":{"id":"ct5","status":"inProgress","startedAt":1}}}'
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a6","kind":"started","agentThreadId":"ch6","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch6","turn":{"id":"ct6","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"completed","completedAt":3}}}' ;;
    *'"method":"thread/read"'*'"includeTurns":true'*'ch5'*)
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"ch5\",\"model\":\"gpt-6-luna\",\"turns\":[{\"id\":\"ct5\",\"status\":\"completed\"}]}}}" ;;
    *'"method":"thread/read"'*'"includeTurns":true'*'ch6'*)
      emit '{"method":"turn/completed","params":{"threadId":"ch6","turn":{"id":"ct6","status":"completed","completedAt":4}}}'
      sleep 0.5
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"ch6\",\"model\":\"gpt-6-luna\",\"turns\":[{\"id\":\"ct6\",\"status\":\"inProgress\"}]}}}" ;;
    *'"method":"turn/start"'*'flaky last read'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"ar","kind":"started","agentThreadId":"chr","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"chr","turn":{"id":"ctr","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"completed","completedAt":3}}}' ;;
    *'"method":"thread/read"'*'"includeTurns":true'*'chr'*)
      if [ "${intr:-0}" = 1 ] && [ "${rr:-0}" = 1 ]; then
        emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"chr\",\"model\":\"gpt-6-luna\",\"turns\":[{\"id\":\"ctr\",\"status\":\"interrupted\"}]}}}"
      else
        if [ "${intr:-0}" = 1 ]; then rr=1; fi
        emit "{\"id\":$id,\"error\":{\"code\":-32603,\"message\":\"temporary failure\"}}"
      fi ;;
    *'"method":"turn/interrupt"'*'"ctr"'*)
      intr=1
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"turn/start"'*'stop late process'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tup\",\"startedAt\":null}}}"
      emit '{"method":"turn/started","params":{"threadId":"th1","turn":{"id":"tup","status":"inProgress","startedAt":1}}}' ;;
    *'"method":"turn/interrupt"'*'"tup"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tup","item":{"type":"commandExecution","id":"cmdp","command":"sleep 100","status":"inProgress","processId":"proc-late"}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tup","status":"interrupted","completedAt":3}}}' ;;
    *'"method":"thread/backgroundTerminals/terminate"'*)
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"turn/start"'*'flaky child'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a7","kind":"started","agentThreadId":"ch7","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch7","turn":{"id":"ct7","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"completed","completedAt":3}}}' ;;
    *'"method":"thread/read"'*'"includeTurns":true'*'ch7'*)
      emit "{\"id\":$id,\"error\":{\"code\":-32603,\"message\":\"temporary failure\"}}" ;;
    *'"method":"turn/interrupt"'*'"ct7"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"turn/completed","params":{"threadId":"ch7","turn":{"id":"ct7","status":"interrupted","completedAt":5}}}' ;;
    *'"method":"turn/start"'*'late first turn'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a1","kind":"started","agentThreadId":"ch1","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"completed","completedAt":3}}}' ;;
    *'"method":"turn/start"'*'failed parent'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a1","kind":"started","agentThreadId":"ch1","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch1","turn":{"id":"ct","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"failed","completedAt":3}}}' ;;
    *'"method":"turn/start"'*'root interrupt first'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a1","kind":"started","agentThreadId":"ch1","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch1","turn":{"id":"ct","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"interrupted","completedAt":3}}}' ;;
    *'"method":"turn/start"'*'silent child'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a1","kind":"started","agentThreadId":"ch3","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch3","turn":{"id":"ct3","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"completed","completedAt":3}}}' ;;
    *'"method":"test/startAndFinishChild"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"turn/started","params":{"threadId":"ch1","turn":{"id":"ct","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"ch1","turn":{"id":"ct","status":"completed","completedAt":4}}}' ;;
    *'"method":"thread/read"'*'"includeTurns":true'*'ch3'*)
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"ch3\",\"model\":\"gpt-6-luna\",\"turns\":[{\"id\":\"ct3\",\"status\":\"completed\",\"completedAt\":9}]}}}" ;;
    *'"method":"thread/read"'*'ch3'*)
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"ch3\",\"model\":\"gpt-6-luna\"}}}" ;;
    *'"method":"thread/read"'*'"includeTurns":false'*)
      tid=$(printf '%s' "$line" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"$tid\",\"model\":\"gpt-6-luna\"}}}" ;;
    *'"method":"thread/resume"'*'ch1'*)
      emit '{"method":"turn/completed","params":{"threadId":"ch1","turn":{"id":"ct","status":"completed","completedAt":4}}}'
      emit "{\"id\":$id,\"error\":{\"code\":-32600,\"message\":\"thread ch1 already has an active writer\"}}" ;;
    *'"method":"turn/start"'*'spawn child'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu5\",\"startedAt\":null}}}"
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"tu5","item":{"type":"subAgentActivity","id":"a1","kind":"started","agentThreadId":"ch1","agentPath":"/root/helper"}}}'
      emit '{"method":"turn/started","params":{"threadId":"ch1","turn":{"id":"ct","status":"inProgress","startedAt":1}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu5","status":"completed","completedAt":3}}}' ;;
    *'"method":"test/finishChild"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"turn/completed","params":{"threadId":"ch1","turn":{"id":"ct","status":"completed","completedAt":4}}}' ;;
    *'"method":"thread/read"'*'ch1'*)
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"ch1\",\"model\":\"gpt-6-luna\"}}}" ;;
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
    *'"method":"turn/steer"'*'reject me'*) emit "{\"id\":$id,\"error\":{\"code\":-32600,\"message\":\"no active turn\"}}" ;;
    *'"method":"turn/steer"'*) emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"thread/unsubscribe"'*) emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"thread/resume"'*'th-busy'*)
      emit "{\"id\":$id,\"error\":{\"code\":-32600,\"message\":\"thread th-busy already has an active writer\"}}" ;;
    *'"method":"thread/fork"'*) emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"th9\",\"createdAt\":1,\"updatedAt\":2}}}" ;;
  esac
done
"#;

    /// Where the fake app-server logs every line it reads.
    fn fake_stdin() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("conn-codex-fake-{}", std::process::id()))
            .join("codex.stdin")
    }

    fn provider() -> CodexProvider {
        provider_with(CodexConfig::default())
    }

    fn provider_with(config: CodexConfig) -> CodexProvider {
        // Written once: a test rewriting it while another runs it fails on Linux with
        // ETXTBSY ("Text file busy").
        static SCRIPT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        let script = SCRIPT
            .get_or_init(|| {
                let dir =
                    std::env::temp_dir().join(format!("conn-codex-fake-{}", std::process::id()));
                std::fs::create_dir_all(&dir).unwrap();
                let script = dir.join("codex");
                conn_support::test_util::executable(&script, &format!("#!/bin/sh\n{FAKE}"))
                    .unwrap();
                script
            })
            .clone();
        CodexProvider::new(
            "codex".into(),
            CodexConfig {
                home_path: script.parent().map(std::path::Path::to_path_buf),
                binary: script,
                ..config
            },
        )
    }

    pub(crate) fn policy() -> RuntimePolicy {
        from_json(json!({"runtimeMode": "approval-required", "interactionMode": "default", "cwd": "/tmp"})).unwrap()
    }

    pub(crate) fn turn(thread: &ProviderThread, n: u32, text: &str) -> TurnInput {
        let selection: conn_contract::ModelSelection =
            from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"})).unwrap();
        TurnInput {
            native_thread_has_turns: None,
            restart_continuation_of_run_id: None,
            app_context: vec![],
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
            message: TurnMessage::user("m".into(), text.into(), vec![]),
            model_selection: selection,
            runtime_policy: policy(),
        }
    }

    pub(crate) async fn until(
        events: &mut mpsc::Receiver<ProviderEvent>,
        kind: &str,
    ) -> Vec<Value> {
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

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_apps_forward_through_the_existing_app_server() {
        use conn_provider::mcp_apps::{Operation, Request};
        let provider = provider();
        let opened = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "apps-session".into(),
                model_selection: from_json(json!({"instanceId":"codex","model":"gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
            })
            .await
            .unwrap();
        let session = opened.session;
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: from_json(json!({"instanceId":"codex","model":"gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        let request = |operation| Request {
            provider_thread: thread.clone(),
            server: "apps-stub".into(),
            operation,
        };
        let tools = session
            .mcp_app_request(request(Operation::ListTools))
            .await
            .unwrap();
        assert_eq!(tools[0]["name"], "refresh");
        let result = session
            .mcp_app_request(request(Operation::CallTool {
                tool: "refresh".into(),
                arguments: json!({"city":"Amsterdam"}),
            }))
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({"content":[{"type":"text","text":"ok"}],"structuredContent":{"ok":true},"_meta":{"stub":true}})
        );
        let result = session
            .mcp_app_request(request(Operation::ReadResource {
                uri: "ui://stub".into(),
            }))
            .await
            .unwrap();
        assert_eq!(result["contents"][0]["uri"], "ui://stub");
        let resumed = session
            .mcp_app_request(request(Operation::ReadResource {
                uri: "ui://unloaded".into(),
            }))
            .await
            .unwrap();
        assert_eq!(resumed, json!({"contents":[]}));
        let mut missing_native = conn_contract::to_json(&thread);
        missing_native["nativeThreadRef"] = Value::Null;
        let error = session
            .mcp_app_request(Request {
                provider_thread: from_json(missing_native).unwrap(),
                server: "apps-stub".into(),
                operation: Operation::ListTools,
            })
            .await
            .unwrap_err();
        assert!(
            matches!(error,ProviderError::Protocol {ref detail} if detail == &format!("Provider thread {} is missing a native Codex thread id.",thread.id)),
            "{error}"
        );
        let transcript =
            std::fs::read_to_string(provider.config.binary.with_extension("stdin")).unwrap();
        let calls: Vec<Value> = transcript
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|call| {
                call["params"]["server"] == "apps-stub"
                    || call["params"]["serverName"] == "apps-stub"
            })
            .collect();
        assert!(calls.iter().any(|call| call["method"] == "mcpServerStatus/list" && call["params"] == json!({"threadId":"th1","serverName":"apps-stub","detail":"toolsAndAuthOnly"})));
        assert!(calls.iter().any(|call| call["method"] == "mcpServer/tool/call" && call["params"] == json!({"threadId":"th1","server":"apps-stub","tool":"refresh","arguments":{"city":"Amsterdam"}})));
        session.close().await;
        assert!(matches!(
            session.mcp_app_request(request(Operation::ListTools)).await,
            Err(ProviderError::SessionStopped)
        ));
    }

    /// A session dropped without `close` (a task ended early) still leaves the app-server, and
    /// the process stops when it was the last session.
    /// `close` tells the engine whether the shared app-server outlived the session: T3 keeps
    /// the MCP credential the live process holds, and revokes it once the process ends.
    #[tokio::test(flavor = "current_thread")]
    async fn close_reports_whether_the_app_server_keeps_running() {
        let provider = provider();
        let mut sessions = Vec::new();
        for (thread, id) in [("t1", "s1"), ("t2", "s2")] {
            let opened = provider
                .open_session(OpenSessionInput {
                    thread_id: thread.into(),
                    provider_session_id: id.into(),
                    model_selection: from_json(
                        json!({"instanceId": "codex", "model": "gpt-6-luna"}),
                    )
                    .unwrap(),
                    runtime_policy: policy(),
                    resume_from_session: None,
                    mcp_servers: vec![],
                    host: None,
                })
                .await
                .unwrap();
            opened
                .session
                .ensure_thread(EnsureThreadInput {
                    thread_id: thread.into(),
                    title: None,
                    model_selection: from_json(
                        json!({"instanceId": "codex", "model": "gpt-6-luna"}),
                    )
                    .unwrap(),
                    runtime_policy: policy(),
                    existing_provider_thread: None,
                })
                .await
                .unwrap();
            sessions.push(opened.session);
        }
        let pid = provider.server.pid().expect("the app-server runs");
        assert_eq!(sessions[0].close().await, Closed::RuntimeShared);
        assert_eq!(
            provider.server.pid(),
            Some(pid),
            "the other thread keeps it"
        );
        assert_eq!(sessions[1].close().await, Closed::RuntimeStopped);
        assert_eq!(provider.server.pid(), None, "the last session stopped it");
    }

    /// A subagent that outlives its session's close on a shared app-server still reports its
    /// end, as T3 keeps the child's turn context after a release: from its own
    /// `turn/completed`, or as interrupted once the last session stops the process. Then the
    /// closed session's events end.
    #[tokio::test(flavor = "current_thread")]
    async fn a_shared_close_still_reports_the_subagents_end() {
        tokio::time::timeout(Duration::from_secs(30), async {
            for finish in [true, false] {
                shared_close_child_end(finish).await;
            }
        })
        .await
        .expect("both cases finished within 30 s");
    }

    /// Two sessions on one fake app-server ([`shared_pair_until`]).
    struct Pair {
        session: Box<dyn Session>,
        events: mpsc::Receiver<ProviderEvent>,
        other: Box<dyn Session>,
        /// The first session's events read so far.
        seen: Vec<Value>,
        thread: ProviderThread,
    }

    /// [`shared_pair_until`] up to the root's `turn.terminal`.
    async fn shared_pair(provider: &CodexProvider, text: &str) -> Pair {
        shared_pair_until(provider, text, |e| e["type"] == "turn.terminal").await
    }

    async fn rest(events: &mut mpsc::Receiver<ProviderEvent>) -> Vec<Value> {
        let mut rest = Vec::new();
        while let Some(event) = events.recv().await {
            rest.push(serde_json::to_value(event).unwrap());
        }
        rest
    }

    /// The child's turn `native` ended with `status`: its provider turn and its subagent node.
    fn assert_child_ended(events: &[Value], native: &str, status: &str) {
        assert!(
            events.iter().any(|e| e["type"] == "provider_turn.updated"
                && e["providerTurn"]["nativeTurnRef"]["nativeId"] == native
                && e["providerTurn"]["status"] == status),
            "{native} {status}: {events:?}"
        );
        assert!(
            events.iter().any(|e| e["type"] == "node.updated"
                && e["node"]["kind"] == "subagent"
                && e["node"]["status"] == status),
            "{native} {status}: {events:?}"
        );
    }

    async fn shared_close_child_end(finish: bool) {
        let provider = provider();
        let Pair {
            session,
            mut events,
            other,
            seen: root,
            ..
        } = shared_pair(&provider, "spawn child").await;
        assert_eq!(root.last().unwrap()["status"], "completed");
        assert_eq!(session.close().await, Closed::RuntimeShared);
        if finish {
            provider
                .server
                .request("test/finishChild", json!({}))
                .await
                .unwrap();
        } else {
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        }
        let rest = rest(&mut events).await;
        assert_child_ended(
            &rest,
            "ct",
            if finish { "completed" } else { "interrupted" },
        );
        if finish {
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        }
    }

    /// Codex may announce a subagent before its first `turn/started`. A shared close in that
    /// gap keeps the announced child's route, so its later turn and end still arrive.
    #[tokio::test(flavor = "current_thread")]
    async fn a_shared_close_keeps_a_child_announced_before_its_first_turn() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider();
            let Pair {
                session,
                mut events,
                other,
                ..
            } = shared_pair(&provider, "late first turn").await;
            assert_eq!(session.close().await, Closed::RuntimeShared);
            provider
                .server
                .request("test/startAndFinishChild", json!({}))
                .await
                .unwrap();
            let rest = rest(&mut events).await;
            assert_child_ended(&rest, "ct", "completed");
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        })
        .await
        .expect("finished within 30 s");
    }

    /// `emitOrDeferRootTerminal`: a root that fails while a descendant still runs settles
    /// without it (`childTurnsContinue`); the child keeps working. Ports T3's "handles a late
    /// native child after the capacity retry failed" assertion.
    #[tokio::test(flavor = "current_thread")]
    async fn a_failed_root_with_a_running_child_says_the_child_continues() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider();
            let Pair {
                session,
                events: _events,
                other,
                seen: root,
                ..
            } = shared_pair(&provider, "failed parent").await;
            let terminal = root.last().unwrap();
            assert_eq!(terminal["status"], "failed");
            assert_eq!(terminal["childTurnsContinue"], true, "{terminal}");
            session.close().await;
            other.close().await;
        })
        .await
        .expect("finished within 30 s");
    }

    /// `emitOrDeferRootTerminal`: Stop interrupts the whole lineage, so an interrupted root's
    /// terminal waits until its descendants settle. Ports T3's "handles a late native child
    /// after the capacity retry interrupted" (no terminal until the child ends).
    #[tokio::test(flavor = "current_thread")]
    async fn an_interrupted_root_ends_after_its_running_child() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider();
            let Pair {
                session,
                mut events,
                other,
                ..
            } = shared_pair_until(&provider, "root interrupt first", |e| {
                e["type"] == "provider_turn.updated"
                    && e["providerTurn"]["nativeTurnRef"]["nativeId"] == "tu5"
                    && e["providerTurn"]["status"] == "interrupted"
            })
            .await;
            provider
                .server
                .request("test/finishChild", json!({}))
                .await
                .unwrap();
            let seen = until(&mut events, "turn.terminal").await;
            assert_eq!(seen.last().unwrap()["status"], "interrupted");
            assert!(
                seen.iter()
                    .any(|e| e["type"] == "subagent.updated"
                        && e["subagent"]["status"] == "completed"),
                "the child ends before the root: {seen:?}"
            );
            session.close().await;
            other.close().await;
        })
        .await
        .expect("finished within 30 s");
    }

    /// Two sessions on one fake app-server: `s1` (thread `t1`) runs a turn with `text` and
    /// reads its events up to the first that `stop` takes; `s2` only keeps the process shared.
    async fn shared_pair_until(
        provider: &CodexProvider,
        text: &str,
        stop: impl Fn(&Value) -> bool,
    ) -> Pair {
        let open = |thread: &str, id: &str| {
            provider.open_session(OpenSessionInput {
                thread_id: thread.into(),
                provider_session_id: id.into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
            })
        };
        let OpenedSession {
            session,
            mut events,
            ..
        } = open("t1", "s1").await.unwrap();
        let other = open("t2", "s2").await.unwrap().session;
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
        session.start_turn(turn(&thread, 5, text)).await.unwrap();
        let mut seen = Vec::new();
        loop {
            let event = serde_json::to_value(events.recv().await.expect("events ended")).unwrap();
            let done = stop(&event);
            seen.push(event);
            if done {
                return Pair {
                    session,
                    events,
                    other,
                    seen,
                    thread,
                };
            }
        }
    }

    /// Another session's resume of the lingering child takes nothing over until Codex accepts
    /// it: a completion Codex sends before it refuses reaches the closed session, while the
    /// process keeps running.
    #[tokio::test(flavor = "current_thread")]
    async fn a_refused_resume_leaves_the_childs_completion_with_its_owner() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider();
            let Pair {
                session,
                mut events,
                other,
                seen: root,
                ..
            } = shared_pair(&provider, "spawn child").await;
            assert_eq!(session.close().await, Closed::RuntimeShared);
            drop(session);
            let child = root
                .iter()
                .find_map(|e| {
                    let row = &e["providerThread"];
                    (row["nativeThreadRef"]["nativeId"] == "ch1")
                        .then(|| from_json(row.clone()).unwrap())
                })
                .expect("the child's provider thread");
            let attempt = other
                .resume_thread(ResumeThreadInput {
                    provider_thread: child,
                    thread_id: None,
                    model_selection: None,
                    runtime_policy: None,
                })
                .await;
            assert!(attempt.is_err(), "the fake refuses the resume");
            let rest = tokio::time::timeout(Duration::from_secs(5), rest(&mut events))
                .await
                .expect("the child's completion ends the closed session's events");
            assert_child_ended(&rest, "ct", "completed");
            assert!(provider.server.pid().is_some(), "the process still runs");
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        })
        .await
        .expect("finished within 30 s");
    }

    /// `deferToActiveRoots`: Codex confirms the root's interruption, but a subagent stays
    /// silent. At the deadline no root runs, so the rest of the lineage settles and Stop
    /// succeeds; T3 reports a timeout only while a root still runs.
    #[tokio::test(flavor = "current_thread")]
    async fn a_stop_settles_a_silent_child_once_the_root_ended() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider_with(CodexConfig {
                stop_confirm_timeout: Duration::from_millis(300),
                ..CodexConfig::default()
            });
            let Pair {
                session,
                mut events,
                other,
                seen,
                thread,
            } = shared_pair_until(&provider, "stop quiet child", |e| {
                e["type"] == "provider_turn.updated"
                    && e["providerTurn"]["nativeTurnRef"]["nativeId"] == "ct4"
            })
            .await;
            let root_turn = seen
                .iter()
                .find(|e| {
                    e["type"] == "provider_turn.updated"
                        && e["providerTurn"]["nativeTurnRef"]["nativeId"] == "tu6"
                })
                .and_then(|e| e["providerTurn"]["id"].as_str())
                .expect("the root's provider turn")
                .to_owned();
            let stopped = session
                .interrupt_turn(InterruptInput {
                    provider_thread: thread,
                    provider_turn_id: root_turn.as_str().into(),
                })
                .await;
            assert_eq!(stopped, Ok(()));
            let ended = until(&mut events, "turn.terminal").await;
            assert_eq!(ended.last().unwrap()["status"], "interrupted");
            assert_child_ended(&ended, "ct4", "interrupted");
            session.close().await;
            other.close().await;
        })
        .await
        .expect("finished within 30 s");
    }

    /// A Stop whose root Codex ends only after the deadline stays pending: the root's own end
    /// settles the rest of its lineage then (T3 forks this wait on the roots' completion).
    #[tokio::test(flavor = "current_thread")]
    async fn a_late_root_end_settles_a_timed_out_stop() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider_with(CodexConfig {
                stop_confirm_timeout: Duration::from_millis(300),
                ..CodexConfig::default()
            });
            let Pair {
                session,
                mut events,
                other,
                seen,
                thread,
            } = shared_pair_until(&provider, "stop late root", |e| {
                e["type"] == "provider_turn.updated"
                    && e["providerTurn"]["nativeTurnRef"]["nativeId"] == "ct8"
            })
            .await;
            let root_turn = seen
                .iter()
                .find(|e| {
                    e["type"] == "provider_turn.updated"
                        && e["providerTurn"]["nativeTurnRef"]["nativeId"] == "tu8"
                })
                .and_then(|e| e["providerTurn"]["id"].as_str())
                .expect("the root's provider turn")
                .to_owned();
            let stopped = session
                .interrupt_turn(InterruptInput {
                    provider_thread: thread,
                    provider_turn_id: root_turn.as_str().into(),
                })
                .await;
            assert_eq!(
                stopped,
                Err(ProviderError::InterruptTimeout { timeout_ms: 300 })
            );
            provider
                .server
                .request("test/finishRoot8", json!({}))
                .await
                .unwrap();
            let ended = until(&mut events, "turn.terminal").await;
            assert_eq!(ended.last().unwrap()["status"], "interrupted");
            assert_child_ended(&ended, "ct8", "interrupted");
            session.close().await;
            other.close().await;
        })
        .await
        .expect("finished within 30 s");
    }

    /// Only T3's missing thread (`-32600`, `thread not found:`) ends a silent child; another
    /// error that says "not found" is tried again, and the child's own end settles it.
    #[tokio::test(flavor = "current_thread")]
    async fn only_codexs_missing_thread_error_ends_a_silent_child() {
        silent_child_keeps_running("odd error child", "ct9").await;
    }

    /// Every check finds the child running, so none interrupts it, the last one included: it
    /// keeps its route, and its own end, which Codex sends after the 60th read, settles it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_child_codex_reports_running_is_never_interrupted() {
        silent_child_keeps_running("busy child", "ctb").await;
        let stdin = std::fs::read_to_string(fake_stdin()).unwrap();
        assert!(
            !stdin
                .lines()
                .any(|line| line.contains("\"method\":\"turn/interrupt\"")
                    && line.contains("\"ctb\"")),
            "a running child gets no turn/interrupt"
        );
    }

    async fn silent_child_keeps_running(text: &str, child_turn: &str) {
        tokio::time::timeout(Duration::from_secs(60), async {
            let provider = provider_with(CodexConfig {
                child_check_interval: Duration::from_millis(50),
                ..CodexConfig::default()
            });
            let Pair {
                session,
                mut events,
                other,
                ..
            } = shared_pair(&provider, text).await;
            assert_eq!(session.close().await, Closed::RuntimeShared);
            let rest = rest(&mut events).await;
            assert_child_ended(&rest, child_turn, "completed");
            assert!(
                !rest.iter().any(|e| e["type"] == "provider_turn.updated"
                    && e["providerTurn"]["nativeTurnRef"]["nativeId"] == child_turn
                    && e["providerTurn"]["status"] == "interrupted"),
                "{rest:?}"
            );
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        })
        .await
        .expect("finished within 60 s");
    }

    /// Two silent children are checked one after the other. The first one's end that the
    /// check found is published even when the second one's own completion arrives while its
    /// check is still waiting for Codex.
    #[tokio::test(flavor = "current_thread")]
    async fn a_checked_childs_end_survives_another_childs_live_completion() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider_with(CodexConfig {
                child_check_interval: Duration::from_millis(100),
                ..CodexConfig::default()
            });
            let Pair {
                session,
                mut events,
                other,
                ..
            } = shared_pair(&provider, "twin children").await;
            assert_eq!(session.close().await, Closed::RuntimeShared);
            let rest = rest(&mut events).await;
            assert_child_ended(&rest, "ct5", "completed");
            assert_child_ended(&rest, "ct6", "completed");
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        })
        .await
        .expect("finished within 30 s");
    }

    /// A read that fails for a reason other than a missing thread is tried again; nothing
    /// ends then. At the last check the child's turn gets `turn/interrupt`, and the end Codex
    /// reports for it is what the session publishes.
    #[tokio::test(flavor = "current_thread")]
    async fn a_failed_child_read_is_retried_and_the_last_check_interrupts_the_turn() {
        tokio::time::timeout(Duration::from_secs(60), async {
            let provider = provider_with(CodexConfig {
                child_check_interval: Duration::from_millis(50),
                ..CodexConfig::default()
            });
            let Pair {
                session,
                mut events,
                other,
                ..
            } = shared_pair(&provider, "flaky child").await;
            assert_eq!(session.close().await, Closed::RuntimeShared);
            let rest = rest(&mut events).await;
            assert_child_ended(&rest, "ct7", "interrupted");
            let stdin = std::fs::read_to_string(fake_stdin()).unwrap();
            assert!(
                stdin
                    .lines()
                    .any(|line| line.contains("\"method\":\"turn/interrupt\"")
                        && line.contains("\"ct7\"")),
                "the last check interrupts the child's turn"
            );
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        })
        .await
        .expect("finished within 60 s");
    }

    /// The read after the last check's interrupt fails for a passing reason: it is read again
    /// at the next interval, without a second interrupt, and the end Codex reports settles it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_failed_last_read_is_read_again_without_another_interrupt() {
        tokio::time::timeout(Duration::from_secs(60), async {
            let provider = provider_with(CodexConfig {
                child_check_interval: Duration::from_millis(50),
                ..CodexConfig::default()
            });
            let Pair {
                session,
                mut events,
                other,
                ..
            } = shared_pair(&provider, "flaky last read").await;
            assert_eq!(session.close().await, Closed::RuntimeShared);
            let rest = rest(&mut events).await;
            assert_child_ended(&rest, "ctr", "interrupted");
            let stdin = std::fs::read_to_string(fake_stdin()).unwrap();
            let interrupts = stdin
                .lines()
                .filter(|line| {
                    line.contains("\"method\":\"turn/interrupt\"") && line.contains("\"ctr\"")
                })
                .count();
            assert_eq!(interrupts, 1, "one interrupt at the last check");
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        })
        .await
        .expect("finished within 60 s");
    }

    /// A background process Codex reports after the Stop took its snapshot still gets
    /// `thread/backgroundTerminals/terminate` when the Stop settles (T3's
    /// `terminateTrackedTerminals` in `settleInterruptedLineage`).
    #[tokio::test(flavor = "current_thread")]
    async fn a_stop_terminates_a_process_reported_after_its_snapshot() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider();
            let Pair {
                session,
                mut events,
                other,
                seen,
                thread,
            } = shared_pair_until(&provider, "stop late process", |e| {
                e["type"] == "provider_turn.updated"
                    && e["providerTurn"]["nativeTurnRef"]["nativeId"] == "tup"
            })
            .await;
            let root_turn = seen
                .last()
                .and_then(|e| e["providerTurn"]["id"].as_str())
                .expect("the root's provider turn")
                .to_owned();
            let stopped = session
                .interrupt_turn(InterruptInput {
                    provider_thread: thread,
                    provider_turn_id: root_turn.as_str().into(),
                })
                .await;
            assert_eq!(stopped, Ok(()));
            let ended = until(&mut events, "turn.terminal").await;
            assert_eq!(ended.last().unwrap()["status"], "interrupted");
            let stdin = std::fs::read_to_string(fake_stdin()).unwrap();
            assert!(
                stdin.lines().any(|line| line
                    .contains("\"method\":\"thread/backgroundTerminals/terminate\"")
                    && line.contains("\"proc-late\"")),
                "the late process is terminated"
            );
            session.close().await;
            other.close().await;
        })
        .await
        .expect("finished within 30 s");
    }

    /// A child announced before its first turn ends when the process stops in that gap, and
    /// the closed session's events end with it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_process_exit_ends_a_child_announced_before_its_first_turn() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider();
            let Pair {
                session,
                mut events,
                other,
                ..
            } = shared_pair(&provider, "late first turn").await;
            assert_eq!(session.close().await, Closed::RuntimeShared);
            assert_eq!(other.close().await, Closed::RuntimeStopped);
            let rest = tokio::time::timeout(Duration::from_secs(5), rest(&mut events))
                .await
                .expect("the exit ends the closed session's events");
            assert!(
                rest.iter().any(|e| e["type"] == "node.updated"
                    && e["node"]["kind"] == "subagent"
                    && e["node"]["status"] == "interrupted"),
                "{rest:?}"
            );
        })
        .await
        .expect("finished within 30 s");
    }

    /// A child that goes silent after a shared close is checked with Codex: one whose turn
    /// Codex reports ended ends here too, and the closed session lets go.
    #[tokio::test(flavor = "current_thread")]
    async fn a_silent_child_is_reconciled_with_codex() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let provider = provider_with(CodexConfig {
                child_check_interval: Duration::from_millis(100),
                ..CodexConfig::default()
            });
            let Pair {
                session,
                mut events,
                other,
                ..
            } = shared_pair(&provider, "silent child").await;
            assert_eq!(session.close().await, Closed::RuntimeShared);
            let rest = rest(&mut events).await;
            assert_child_ended(&rest, "ct3", "completed");
            assert_eq!(other.close().await, Closed::RuntimeStopped);
        })
        .await
        .expect("finished within 30 s");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_dropped_session_leaves_the_app_server() {
        let provider = provider();
        let OpenedSession {
            session,
            provider_session,
            ..
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
            })
            .await
            .unwrap();
        assert_eq!(to_json(&provider_session)["id"], "s1");
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
            ..
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
            })
            .await
            .unwrap();
        // The session row comes back from `open_session`, not as an event.
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
            ..
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
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

    /// A steer carries the MCP app notes Codex has not been sent, as quoted user input before
    /// the message, once: `turn/steer` takes no `additionalContext` (T3's "steers carry MCP
    /// app notes"). A refused steer sends them again on the retry.
    #[tokio::test(flavor = "current_thread")]
    async fn a_steer_carries_a_changed_app_note_once() {
        let dir =
            std::env::temp_dir().join(format!("conn-codex-steer-notes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("codex");
        conn_support::test_util::executable(&script, &format!("#!/bin/sh\n{FAKE}")).unwrap();
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
        let selection = || -> conn_contract::ModelSelection {
            from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"})).unwrap()
        };
        let OpenedSession {
            session,
            mut events,
            ..
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: selection(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
            })
            .await
            .unwrap();
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: selection(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        let note = |text: &str| conn_provider::AppContextEntry {
            key: "mcp_app_item-1".into(),
            text: text.into(),
        };
        let mut first = turn(&thread, 1, "stuck");
        first.app_context = vec![note("Created PROJ-42")];
        session.start_turn(first).await.unwrap();
        let running = until(&mut events, "provider_turn.updated").await;
        let provider_turn = running.last().unwrap()["providerTurn"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let steer = |text: &str, notes: Vec<conn_provider::AppContextEntry>| SteerInput {
            thread_id: "t1".into(),
            run_id: "r1".into(),
            provider_thread: thread.clone(),
            provider_turn_id: provider_turn.as_str().into(),
            message: TurnMessage {
                created_by: conn_contract::OrchestrationV2Actor::User,
                creation_source: conn_contract::OrchestrationV2CreationSource::Web,
                scheduled_task_id: None,
                sender_thread_id: None,
                message_id: "m-steer".into(),
                text: text.into(),
                attachments: vec![],
            },
            model_selection: None,
            app_context: notes,
        };
        let steered = |text: &str| -> Value {
            let lines = std::fs::read_to_string(&log).unwrap();
            let line = lines
                .lines()
                .rfind(|l| l.contains("\"method\":\"turn/steer\"") && l.contains(text))
                .unwrap()
                .to_owned();
            serde_json::from_str::<Value>(&line).unwrap()["params"]["input"].clone()
        };
        let quoted = json!({"type": "text",
            "text": "<external_mcp_app_item-1>Created PROJ-44</external_mcp_app_item-1>"});

        // The note the turn started with needs no resend.
        session
            .steer_turn(steer("unchanged", vec![note("Created PROJ-42")]))
            .await
            .unwrap();
        assert_eq!(
            steered("unchanged"),
            json!([{"type": "text", "text": "unchanged"}])
        );
        // A changed note goes once, before the message.
        session
            .steer_turn(steer("changed", vec![note("Created PROJ-44")]))
            .await
            .unwrap();
        assert_eq!(
            steered("changed"),
            json!([quoted, {"type": "text", "text": "changed"}])
        );
        session
            .steer_turn(steer("again", vec![note("Created PROJ-44")]))
            .await
            .unwrap();
        assert_eq!(steered("again"), json!([{"type": "text", "text": "again"}]));
        // A refused steer delivered nothing, so the retry still carries the change.
        let changed = || vec![note("Created PROJ-45")];
        assert!(
            session
                .steer_turn(steer("reject me", changed()))
                .await
                .is_err()
        );
        session.steer_turn(steer("retry", changed())).await.unwrap();
        assert!(steered("retry").to_string().contains("PROJ-45"));
        session.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `forkThread` sends the fork's own model and cwd (`codexThreadRuntimeParams`), and
    /// leaves both out when the input has none, as T3 does.
    #[tokio::test(flavor = "current_thread")]
    async fn a_fork_sends_its_own_model_and_cwd() {
        let dir = std::env::temp_dir().join(format!("conn-codex-fork-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("codex");
        conn_support::test_util::executable(&script, &format!("#!/bin/sh\n{FAKE}")).unwrap();
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
                mcp_servers: vec![],
                host: None,
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

    /// `isCodexActiveWriterError` on resume becomes `ProviderAdapterThreadInUseError` with T3's
    /// text, which the engine shows as the failure message.
    #[tokio::test(flavor = "current_thread")]
    async fn an_active_writer_on_resume_is_thread_in_use() {
        let provider = provider();
        let OpenedSession { session, .. } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
            })
            .await
            .unwrap();
        let stored: ProviderThread = from_json(json!({
            "id": "provider-thread:codex:th-busy", "driver": "codex",
            "providerInstanceId": "codex", "providerSessionId": "s0", "appThreadId": "t1",
            "ownerNodeId": null,
            "nativeThreadRef": {"driver": "codex", "nativeId": "th-busy", "strength": "strong"},
            "nativeConversationHeadRef": null, "status": "idle", "firstRunOrdinal": 1,
            "lastRunOrdinal": 1, "handoffIds": [], "forkedFrom": null,
            "createdAt": "2026-11-14T00:00:00.000Z", "updatedAt": "2026-11-14T00:00:00.000Z",
        }))
        .unwrap();
        let resumed = session
            .resume_thread(conn_provider::ResumeThreadInput {
                provider_thread: stored,
                thread_id: Some("t1".into()),
                model_selection: None,
                runtime_policy: Some(policy()),
            })
            .await;
        let Err(ProviderError::ThreadInUse { detail }) = resumed else {
            panic!("expected ThreadInUse, got {resumed:?}")
        };
        assert_eq!(detail, CODEX_THREAD_IN_USE_MESSAGE);
        assert_eq!(
            ProviderError::ThreadInUse {
                detail: detail.clone()
            }
            .to_string(),
            detail,
            "the engine's failure message is T3's text alone"
        );
        session.close().await;
    }

    /// A restart continuation (`restartContinuationOfRunId`) starts the native turn with no
    /// input: Codex continues on its own, as T3's `startTurn` does.
    #[tokio::test(flavor = "current_thread")]
    async fn a_restart_continuation_starts_the_turn_without_input() {
        let dir = std::env::temp_dir().join(format!("conn-codex-restart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("codex");
        conn_support::test_util::executable(&script, &format!("#!/bin/sh\n{FAKE}")).unwrap();
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
        let OpenedSession {
            session,
            mut events,
            ..
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
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
        let mut input = turn(&thread, 2, "Continue where you left off.");
        input.restart_continuation_of_run_id = Some("r1".into());
        session.start_turn(input).await.unwrap();
        until(&mut events, "turn.terminal").await;
        session.close().await;
        let starts: Vec<Value> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|f| f["method"] == "turn/start")
            .map(|f| f["params"].clone())
            .collect();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["input"], json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
