//! A scripted provider for tests and the client check. The user's text picks the script:
//! - `hang`: the turn starts and waits for an interrupt.
//! - `stuck`: the turn starts and never confirms a Stop (`InterruptTimeout`), as a Codex turn
//!   that ignores `turn/interrupt`.
//! - `ask`: the turn asks for a command approval, then answers once approved.
//! - `question`: the turn asks the user a question (`user_input`) and waits for the answer.
//! - `fail`: the turn fails.
//! - `subagent`: a subagent's child thread with one message, then the turn completes.
//! - `background`: the turn completes with background work left, then asks for a
//!   continuation turn, which answers `continued` and ends the work.
//! - `background-text`: the turn completes, then asks for a continuation whose text is the
//!   whole wake (`delivery: message_text`, as Codex); that turn runs as an ordinary message.
//! - `background-task`: the turn completes with background task `bg-1` on its provider
//!   thread's roster, which `await_background_tasks` marks or clears. `background-task-hang`:
//!   the same roster, and the turn waits for an interrupt.
//! - `background-reported`: like `background-hold`, but the work shows only as
//!   `background_work.updated` (pending), and a running background command row.
//! - anything else: streams `echo: <text>` in three chunks and completes.
//!
//! A steer into a running turn reports `steer.updated` pending then completed, answers
//! `steered: <text>` and completes the turn, unless the provider was built with
//! [`FakeProvider::without_steering`].

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use conn_contract::{
    ProviderCapabilities, ProviderInstanceId, ProviderSessionId, ProviderThread, from_json,
};
use conn_provider::{
    BoxFuture, EnsureThreadInput, InterruptInput, McpServer, OpenSessionInput, OpenedSession,
    Provider, ProviderError, ProviderEvent, ProviderResult, ResumeThreadInput,
    RuntimeRequestResponse, Session, SteerInput, ThreadDisposition, TurnInput, TurnStatus,
    TurnTerminal,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use conn_support::time::now_iso;

pub struct FakeProvider {
    id: ProviderInstanceId,
    /// Sessions opened so far.
    pub sessions: Arc<AtomicUsize>,
    /// The MCP servers the newest session was given (at open or later).
    pub mcp_servers: Arc<Mutex<Vec<McpServer>>>,
    /// Sessions closed so far.
    pub closed: Arc<AtomicUsize>,
    /// The runtime policy each session was opened with, as JSON.
    pub opened_policies: Arc<Mutex<Vec<Value>>>,
    /// Model selections sent to a running turn (`apply_model_selection`), as JSON.
    pub applied_selections: Arc<Mutex<Vec<Value>>>,
    /// Rollback targets asked for: `start` or `turn <app run ordinal>`.
    pub rollbacks: Arc<Mutex<Vec<String>>>,
    /// Forks asked for: `<target thread> <provider turn id or "-">`.
    pub forks: Arc<Mutex<Vec<String>>>,
    /// Native threads loaded again (`resume_thread`): `<native id> <model>`.
    pub resumes: Arc<Mutex<Vec<String>>>,
    /// Session calls in order: `start <run>`, `interrupt <run>`, `interrupted <run>`,
    /// `rollback`, `rolled back`.
    pub calls: Arc<Mutex<Vec<String>>>,
    /// The `nativeConversationHeadRef` of the provider thread each turn starts on. A rollback
    /// sets it to `rolled-back:<target>`, so a test sees which row a turn continues.
    pub turn_heads: Arc<Mutex<Vec<Value>>>,
    /// Provider threads made per app thread (`ensure_thread`); the second and later get a
    /// numbered id, as a real provider gives each new conversation its own.
    ensured: Arc<Mutex<std::collections::HashMap<String, usize>>>,
    /// Rollbacks left to fail; `usize::MAX` fails every one.
    fail_rollbacks: Arc<AtomicUsize>,
    /// Stop and rollback take this long after their work, as a slow provider.
    control_delay: std::time::Duration,
    steering: bool,
    /// Sessions answer `await_background_tasks`; see [`Self::without_background_wait`].
    background_wait: bool,
    close_delay: std::time::Duration,
    selection_plan: Option<conn_provider::SelectionTransitionPlan>,
    /// What `capabilities` answers: the sessions' capabilities unless a test changes them.
    capabilities: Value,
    /// Set by [`Self::with_process_exit`]: a notify ends every open session's event stream,
    /// as a provider process that exits on its own (systemd's SIGTERM reaches it too).
    process_exit: Option<Arc<tokio::sync::Notify>>,
    #[cfg(test)]
    pub(crate) late_start_entered: Arc<tokio::sync::Notify>,
    #[cfg(test)]
    pub(crate) workflow_stop_entered: Arc<tokio::sync::Notify>,
}

impl std::fmt::Debug for FakeProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeProvider")
            .field("id", &self.id)
            .field("sessions", &self.sessions)
            .field("closed", &self.closed)
            .finish_non_exhaustive()
    }
}

impl FakeProvider {
    pub fn new(instance_id: &str) -> Self {
        Self {
            id: instance_id.into(),
            sessions: Arc::new(AtomicUsize::new(0)),
            mcp_servers: Arc::new(Mutex::new(vec![])),
            closed: Arc::new(AtomicUsize::new(0)),
            opened_policies: Arc::default(),
            applied_selections: Arc::new(Mutex::new(vec![])),
            rollbacks: Arc::new(Mutex::new(vec![])),
            forks: Arc::new(Mutex::new(vec![])),
            resumes: Arc::new(Mutex::new(vec![])),
            calls: Arc::new(Mutex::new(vec![])),
            turn_heads: Arc::default(),
            ensured: Arc::default(),
            fail_rollbacks: Arc::new(AtomicUsize::new(0)),
            control_delay: std::time::Duration::ZERO,
            steering: true,
            background_wait: true,
            close_delay: std::time::Duration::ZERO,
            selection_plan: None,
            capabilities: conn_provider::testing::session_capabilities(),
            process_exit: None,
            #[cfg(test)]
            late_start_entered: Arc::default(),
            #[cfg(test)]
            workflow_stop_entered: Arc::default(),
        }
    }

    /// A provider whose processes can exit on their own: `exit.notify_waiters()` ends the event
    /// stream of every session open at that moment.
    pub fn with_process_exit(mut self, exit: Arc<tokio::sync::Notify>) -> Self {
        self.process_exit = Some(exit);
        self
    }

    /// A provider whose `capabilities` say it cannot roll a conversation back; its sessions'
    /// rows still say it can.
    pub fn without_rollback(mut self) -> Self {
        self.capabilities["threads"]["canRollbackThread"] = json!(false);
        self
    }

    /// A provider whose `plan_selection_transition` answers `plan`.
    pub fn with_selection_plan(mut self, plan: conn_provider::SelectionTransitionPlan) -> Self {
        self.selection_plan = Some(plan);
        self
    }

    /// A provider whose sessions take `delay` to close, as a process given time to exit.
    pub fn with_close_delay(mut self, delay: std::time::Duration) -> Self {
        self.close_delay = delay;
        self
    }

    /// A provider whose `rollback_thread` fails.
    pub fn with_failing_rollback(self) -> Self {
        self.with_rollback_failures(usize::MAX)
    }

    /// A provider whose first `count` rollbacks fail.
    pub fn with_rollback_failures(self, count: usize) -> Self {
        self.fail_rollbacks.store(count, Ordering::SeqCst);
        self
    }

    /// A provider whose Stop and rollback take `delay` after their work.
    pub fn with_control_delay(mut self, delay: std::time::Duration) -> Self {
        self.control_delay = delay;
        self
    }

    /// A provider whose sessions decline every steer, as one without live steering does.
    pub fn without_steering(mut self) -> Self {
        self.steering = false;
        self
    }

    /// A provider whose sessions have no background roster to mark (`awaitBackgroundTasks`
    /// absent), as Codex and ACP.
    pub fn without_background_wait(mut self) -> Self {
        self.background_wait = false;
        self
    }
}

#[derive(Clone)]
struct Turn {
    thread_id: String,
    run_id: String,
    root: String,
    provider_thread_id: String,
    ordinal: u32,
}

struct FakeSession {
    #[cfg(test)]
    late_start_entered: Arc<tokio::sync::Notify>,
    #[cfg(test)]
    workflow_stop_entered: Arc<tokio::sync::Notify>,
    id: ProviderSessionId,
    /// The run whose start the engine abandoned (`abandon_turn_start`), and its wake-up.
    abandoned: Arc<(Mutex<Option<String>>, tokio::sync::Notify)>,
    instance: String,
    driver: String,
    events: mpsc::Sender<ProviderEvent>,
    turn: Arc<Mutex<Option<Turn>>>,
    steering: bool,
    background: Arc<AtomicBool>,
    background_wait: bool,
    /// The background roster of the `background-task` script: task id and whether it is
    /// awaited. At most one entry.
    roster: Arc<Mutex<Vec<(String, bool)>>>,
    /// The running turn ignores Stop.
    stuck: Arc<AtomicBool>,
    mcp_servers: Arc<Mutex<Vec<McpServer>>>,
    closed: Arc<AtomicUsize>,
    applied_selections: Arc<Mutex<Vec<Value>>>,
    rollbacks: Arc<Mutex<Vec<String>>>,
    forks: Arc<Mutex<Vec<String>>>,
    resumes: Arc<Mutex<Vec<String>>>,
    calls: Arc<Mutex<Vec<String>>>,
    turn_heads: Arc<Mutex<Vec<Value>>>,
    ensured: Arc<Mutex<std::collections::HashMap<String, usize>>>,
    fail_rollbacks: Arc<AtomicUsize>,
    control_delay: std::time::Duration,
    close_delay: std::time::Duration,
}

impl FakeSession {
    /// Waits `wait`, or until the engine abandons `run_id`'s start. True when abandoned.
    async fn wait_unless_abandoned(&self, run_id: &str, wait: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = self.abandoned.1.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if crate::lock(&self.abandoned.0).as_deref() == Some(run_id) {
                return true;
            }
            tokio::select! {
                () = &mut notified => {}
                () = tokio::time::sleep_until(deadline) => return false,
            }
        }
    }
}

impl Provider for FakeProvider {
    fn instance_id(&self) -> &ProviderInstanceId {
        &self.id
    }
    fn driver(&self) -> &str {
        "claudeAgent"
    }
    fn plan_selection_transition(
        &self,
        _input: &conn_provider::SelectionTransitionInput,
    ) -> conn_provider::SelectionTransitionPlan {
        self.selection_plan
            .clone()
            .unwrap_or(conn_provider::SelectionTransitionPlan::ApplyOnNextTurn)
    }
    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
        Box::pin(async {
            from_json(self.capabilities.clone()).map_err(|e| ProviderError::Protocol {
                detail: e.to_string(),
            })
        })
    }
    fn open_session(
        &self,
        input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async move {
            self.sessions.fetch_add(1, Ordering::SeqCst);
            crate::lock(&self.opened_policies).push(conn_contract::to_json(&input.runtime_policy));
            *crate::lock(&self.mcp_servers) = input.mcp_servers.clone();
            let (tx, mut rx) = mpsc::channel(64);
            if let Some(exit) = self.process_exit.clone() {
                // Events pass through a task that stops, and drops the engine's end, on exit.
                let (out, forwarded) = mpsc::channel(64);
                let mut inner = std::mem::replace(&mut rx, forwarded);
                tokio::spawn(async move {
                    let exited = exit.notified();
                    tokio::pin!(exited);
                    loop {
                        tokio::select! {
                            () = &mut exited => break,
                            event = inner.recv() => {
                                let Some(event) = event else { break };
                                if out.send(event).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
            Ok(OpenedSession {
                provider_session: from_json(json!({
                    "id": input.provider_session_id, "driver": "claudeAgent",
                    "providerInstanceId": self.id, "status": "ready",
                    "cwd": input.runtime_policy.cwd, "model": null, "capabilities": conn_provider::testing::session_capabilities(),
                    "createdAt": now_iso(), "updatedAt": now_iso(), "lastError": null,
                }))
                .map_err(|e| ProviderError::Protocol {
                    detail: e.to_string(),
                })?,
                background_tasks_end_with_process: true,
                session: Box::new(FakeSession {
                    #[cfg(test)]
                    late_start_entered: self.late_start_entered.clone(),
                    #[cfg(test)]
                    workflow_stop_entered: self.workflow_stop_entered.clone(),
                    id: input.provider_session_id,
                    abandoned: Arc::default(),
                    instance: self.id.as_str().to_owned(),
                    driver: self.driver().to_owned(),
                    events: tx,
                    turn: Arc::new(Mutex::new(None)),
                    steering: self.steering,
                    background: Arc::new(AtomicBool::new(false)),
                    background_wait: self.background_wait,
                    roster: Arc::default(),
                    stuck: Arc::new(AtomicBool::new(false)),
                    mcp_servers: self.mcp_servers.clone(),
                    closed: self.closed.clone(),
                    applied_selections: self.applied_selections.clone(),
                    rollbacks: self.rollbacks.clone(),
                    forks: self.forks.clone(),
                    resumes: self.resumes.clone(),
                    calls: self.calls.clone(),
                    turn_heads: self.turn_heads.clone(),
                    ensured: self.ensured.clone(),
                    fail_rollbacks: self.fail_rollbacks.clone(),
                    control_delay: self.control_delay,
                    close_delay: self.close_delay,
                }),
                events: rx,
            })
        })
    }
}

fn event(value: Value) -> ProviderEvent {
    serde_json::from_value(value).expect("fake provider event")
}

fn assistant(turn: &Turn, id: &str, text: &str, streaming: bool) -> [ProviderEvent; 2] {
    let now = now_iso();
    [
        event(json!({"type": "message.updated", "message": {
            "createdBy": "agent", "creationSource": "provider",
            "id": format!("message:{id}"), "threadId": turn.thread_id, "runId": turn.run_id,
            "nodeId": null, "role": "assistant", "text": text, "attachments": [],
            "streaming": streaming, "createdAt": now, "updatedAt": now,
        }})),
        event(json!({"type": "turn_item.updated", "turnItem": {
            "id": format!("turn-item:{id}"), "threadId": turn.thread_id, "runId": turn.run_id,
            "nodeId": null, "providerThreadId": turn.provider_thread_id,
            "providerTurnId": format!("turn:{}", turn.run_id), "nativeItemRef": null,
            "parentItemId": null, "ordinal": 0,
            "status": if streaming { "running" } else { "completed" }, "title": null,
            "startedAt": now, "completedAt": if streaming { Value::Null } else { json!(now) },
            "updatedAt": now, "type": "assistant_message", "messageId": format!("message:{id}"),
            "text": text, "streaming": streaming,
        }})),
    ]
}

fn provider_turn(turn: &Turn, status: &str) -> ProviderEvent {
    let now = now_iso();
    event(
        json!({"type": "provider_turn.updated", "threadId": turn.thread_id, "providerTurn": {
            "id": format!("turn:{}", turn.run_id), "providerThreadId": turn.provider_thread_id,
            "nodeId": turn.root, "runAttemptId": format!("{}:attempt:1", turn.run_id),
            "nativeTurnRef": null, "ordinal": turn.ordinal, "status": status,
            "startedAt": now, "completedAt": if status == "running" { Value::Null } else { json!(now) },
        }}),
    )
}

fn terminal(turn: &Turn, status: TurnStatus, failure: Option<Value>) -> ProviderEvent {
    ProviderEvent::TurnTerminal(TurnTerminal {
        provider_thread_id: turn.provider_thread_id.as_str().into(),
        provider_turn_id: format!("turn:{}", turn.run_id).as_str().into(),
        run_ordinal: turn.ordinal,
        status,
        failure: failure.map(|f| from_json(f).expect("failure")),
        retry: None,
        thread_disposition: ThreadDisposition::Reusable,
    })
}

async fn emit(tx: &mpsc::Sender<ProviderEvent>, events: impl IntoIterator<Item = ProviderEvent>) {
    for event in events {
        let _ = tx.send(event).await;
    }
}

impl FakeSession {
    /// `provider_thread.updated` with the roster on `pendingBackgroundTasks`, awaited tasks
    /// marked, as Claude's `emitRosterUpdate`.
    fn roster_update(&self, mut provider_thread: Value) -> ProviderEvent {
        let tasks: Vec<Value> = crate::lock(&self.roster)
            .iter()
            .map(|(id, awaited)| {
                let mut task = json!({"taskId": id, "kind": "command",
                    "description": "sleep 600", "providerInstanceId": self.instance});
                if *awaited {
                    task["awaited"] = json!(true);
                }
                task
            })
            .collect();
        provider_thread["pendingBackgroundTasks"] = json!(tasks);
        provider_thread["updatedAt"] = json!(now_iso());
        event(json!({"type": "provider_thread.updated", "providerThread": provider_thread}))
    }

    /// The run of a `continuation.requested` message: shows `continued` and ends the work.
    fn continuation(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let provider_thread_id = conn_contract::to_json(&input.provider_thread)["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let turn = Turn {
                thread_id: input.thread_id.0.clone(),
                run_id: input.run_id.0.clone(),
                root: input.root_node_id.0.clone(),
                provider_thread_id,
                ordinal: input.run_ordinal,
            };
            self.background.store(false, Ordering::SeqCst);
            let mut events = vec![provider_turn(&turn, "running")];
            events.extend(assistant(
                &turn,
                &format!("{}:a", turn.run_id),
                "continued",
                false,
            ));
            events.push(provider_turn(&turn, "completed"));
            events.push(terminal(&turn, TurnStatus::Completed, None));
            *crate::lock(&self.turn) = Some(turn);
            let tx = self.events.clone();
            tokio::spawn(async move { emit(&tx, events).await });
            Ok(())
        })
    }
}

impl Session for FakeSession {
    fn provider_session_id(&self) -> &ProviderSessionId {
        &self.id
    }

    fn ensure_thread(
        &self,
        input: EnsureThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let now = now_iso();
            // Each instance has its own provider thread; the default instance keeps the short id.
            let base = if self.instance == "claudeAgent" {
                format!("provider-thread:{}", input.thread_id)
            } else {
                format!("provider-thread:{}:{}", self.instance, input.thread_id)
            };
            let n = {
                let mut ensured = crate::lock(&self.ensured);
                let n = ensured
                    .entry(input.thread_id.as_str().to_owned())
                    .or_insert(0);
                *n += 1;
                *n
            };
            let id = if n == 1 { base } else { format!("{base}:{n}") };
            Ok(from_json(json!({
                "id": id, "driver": self.driver,
                "providerInstanceId": self.instance, "providerSessionId": self.id,
                "appThreadId": input.thread_id, "ownerNodeId": null,
                "nativeThreadRef": {"driver": self.driver, "nativeId": format!("native-{n}"), "strength": "strong"},
                "nativeConversationHeadRef": null, "status": "active", "firstRunOrdinal": null,
                "lastRunOrdinal": null, "handoffIds": [], "forkedFrom": null,
                "createdAt": now, "updatedAt": now,
            }))
            .expect("provider thread"))
        })
    }

    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let native =
                conn_contract::to_json(&input.provider_thread)["nativeThreadRef"]["nativeId"]
                    .as_str()
                    .unwrap_or("-")
                    .to_owned();
            let model = input
                .model_selection
                .as_ref()
                .map(|s| {
                    conn_contract::to_json(s)["model"]
                        .as_str()
                        .unwrap_or("-")
                        .to_owned()
                })
                .unwrap_or_else(|| "-".into());
            crate::lock(&self.resumes).push(format!("{native} {model}"));
            Ok(input.provider_thread)
        })
    }

    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        if input.message.is_provider_continuation() {
            return self.continuation(input);
        }
        Box::pin(async move {
            let provider_thread_id = conn_contract::to_json(&input.provider_thread)["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let turn = Turn {
                thread_id: input.thread_id.0.clone(),
                run_id: input.run_id.0.clone(),
                root: input.root_node_id.0.clone(),
                provider_thread_id,
                ordinal: input.run_ordinal,
            };
            crate::lock(&self.calls).push(format!("start {}", turn.run_id));
            crate::lock(&self.turn_heads).push(
                conn_contract::to_json(&input.provider_thread)["nativeConversationHeadRef"].clone(),
            );
            let text = input.message.text.clone();
            // `slowstart`: a slow cold start that fails when the session was closed meanwhile.
            if text.starts_with("slowstart") {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if self.closed.load(Ordering::SeqCst) > 0 {
                    return Err(ProviderError::SessionStopped);
                }
            }
            // `coldstart`: a start that takes 500 ms with its provider turn shown at once, as
            // Claude's cold start. Abandoned, it ends that turn interrupted and fails.
            if text.starts_with("coldstart") {
                emit(&self.events, [provider_turn(&turn, "running")]).await;
                *crate::lock(&self.turn) = Some(turn.clone());
                let wait = std::time::Duration::from_millis(500);
                if self.wait_unless_abandoned(&turn.run_id, wait).await {
                    crate::lock(&self.calls).push(format!("start abandoned {}", turn.run_id));
                    emit(
                        &self.events,
                        [
                            provider_turn(&turn, "interrupted"),
                            terminal(&turn, TurnStatus::Interrupted, None),
                        ],
                    )
                    .await;
                    return Err(ProviderError::Failed {
                        operation: "start_turn",
                        detail: "the turn start was abandoned".into(),
                    });
                }
                let done = [
                    provider_turn(&turn, "completed"),
                    terminal(&turn, TurnStatus::Completed, None),
                ];
                tokio::spawn({
                    let tx = self.events.clone();
                    async move { emit(&tx, done).await }
                });
                return Ok(());
            }
            // `latestart` accepts the turn after abandonment, then runs until interrupted.
            if text.starts_with("latestart") {
                #[cfg(test)]
                self.late_start_entered.notify_one();
                loop {
                    let notified = self.abandoned.1.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if crate::lock(&self.abandoned.0).as_deref() == Some(&turn.run_id) {
                        break;
                    }
                    notified.await;
                }
            }
            // `write <path> <text>`: writes `<text>\n` to `<path>` in the turn's folder, then
            // answers as any other message.
            if let (Some(rest), Some(cwd)) = (
                text.strip_prefix("write "),
                conn_contract::to_json(&input.runtime_policy)["cwd"]
                    .as_str()
                    .map(std::path::PathBuf::from),
            ) {
                let (path, body) = rest.split_once(' ').unwrap_or((rest, ""));
                let (file, body) = (cwd.join(path), format!("{body}\n"));
                let _ = tokio::task::spawn_blocking(move || {
                    if let Some(parent) = file.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    std::fs::write(file, body)
                })
                .await;
            }
            let tx = self.events.clone();
            let mut started = vec![provider_turn(&turn, "running")];
            self.stuck.store(text == "stuck", Ordering::SeqCst);
            match text.as_str() {
                "mcp-app" => {
                    let item = from_json(json!({"id":"app:item","threadId":turn.thread_id,"runId":turn.run_id,"providerThreadId":turn.provider_thread_id,"providerTurnId":null,"nodeId":null,"parentItemId":null,"ordinal":1,"status":"completed","startedAt":null,"completedAt":null,"updatedAt":now_iso(),"nativeItemRef":null,"title":null,"type":"dynamic_tool","toolName":"stub.show","input":{},"output":{"content":[{"type":"text","text":"Weather"}]}})).map_err(|e|ProviderError::Protocol {detail:e.to_string()})?;
                    started.push(ProviderEvent::McpAppCapture {turn_item:item,source:conn_provider::mcp_apps::Source {server:"stub".into(),tool:"show".into(),resource_uri:"ui://stub".into()}});
                    started.push(provider_turn(&turn,"completed"));
                    started.push(terminal(&turn,TurnStatus::Completed,None));
                }
                "hang" | "stuck" => {}
                t if t.starts_with("latestart") => {}
                "ask" => started.push(event(json!({"type": "runtime_request.updated",
                    "threadId": turn.thread_id, "runtimeRequest": {
                    "id": "request:1", "nodeId": turn.root, "providerTurnId": format!("turn:{}", turn.run_id),
                    "nativeRequestRef": null, "kind": "command", "status": "pending",
                    "responseCapability": {"type": "live", "providerSessionId": self.id},
                    "createdAt": now_iso(), "resolvedAt": null,
                }}))),
                "question" => started.push(event(json!({"type": "runtime_request.updated",
                    "threadId": turn.thread_id, "runtimeRequest": {
                    "id": format!("question:{}", turn.run_id), "nodeId": turn.root,
                    "providerTurnId": format!("turn:{}", turn.run_id),
                    "nativeRequestRef": null, "kind": "user_input", "status": "pending",
                    "responseCapability": {"type": "live", "providerSessionId": self.id},
                    "createdAt": now_iso(), "resolvedAt": null,
                }}))),
                "subagent" => {
                    let child = format!("child:{}", turn.run_id);
                    let now = now_iso();
                    let mut app_thread = conn_contract::to_json(&input.app_thread);
                    for (field, value) in [
                        ("id", json!(child)),
                        ("title", json!("Sub task")),
                        ("createdBy", json!("agent")),
                        ("creationSource", json!("provider")),
                        ("activeProviderThreadId", Value::Null),
                        ("lineage", json!({"parentThreadId": turn.thread_id,
                            "relationshipToParent": "subagent", "rootThreadId": turn.thread_id})),
                    ] {
                        app_thread[field] = value;
                    }
                    started.push(event(json!({"type": "app_thread.created", "appThread": app_thread})));
                    started.push(event(json!({"type": "message.updated", "message": {
                        "createdBy": "agent", "creationSource": "provider",
                        "id": format!("message:{child}:prompt"), "threadId": child, "runId": null,
                        "nodeId": null, "role": "user", "text": "do the sub task", "attachments": [],
                        "streaming": false, "createdAt": now, "updatedAt": now,
                    }})));
                    started.extend(assistant(&turn, &format!("{}:a", turn.run_id), "delegated", false));
                    started.push(provider_turn(&turn, "completed"));
                    started.push(terminal(&turn, TurnStatus::Completed, None));
                }
                "background-text" => {
                    // Codex's wake: the text is the whole message (`delivery: message_text`).
                    started.extend(assistant(&turn, &format!("{}:a", turn.run_id), "started work", false));
                    started.push(provider_turn(&turn, "completed"));
                    started.push(terminal(&turn, TurnStatus::Completed, None));
                    started.push(event(json!({"type": "continuation.requested",
                        "threadId": turn.thread_id, "providerThreadId": turn.provider_thread_id,
                        "detail": "Subagent completed: helper", "delivery": "message_text",
                        "notification": {"source": {"kind": "subagent"}, "outcome": "completed",
                            "summary": "Subagent \"helper\" finished"}})));
                }
                "background" => {
                    self.background.store(true, Ordering::SeqCst);
                    started.extend(assistant(&turn, &format!("{}:a", turn.run_id), "started work", false));
                    started.push(provider_turn(&turn, "completed"));
                    started.push(terminal(&turn, TurnStatus::Completed, None));
                    started.push(event(json!({"type": "continuation.requested",
                        "threadId": turn.thread_id, "providerThreadId": turn.provider_thread_id,
                        "detail": null})));
                }
                "background-reported" => {
                    let item = format!("turn-item:bg:{}", turn.run_id);
                    let now = now_iso();
                    started.push(event(json!({"type": "turn_item.updated", "turnItem": {
                        "id": item, "threadId": turn.thread_id, "runId": turn.run_id,
                        "nodeId": null, "providerThreadId": turn.provider_thread_id,
                        "providerTurnId": format!("turn:{}", turn.run_id),
                        "nativeItemRef": {"driver": "claudeAgent", "nativeId": "bg-1", "strength": "strong"},
                        "parentItemId": null, "ordinal": 1, "status": "running", "title": null,
                        "startedAt": now, "completedAt": null, "updatedAt": now,
                        "type": "command_execution", "input": "sleep 600",
                    }})));
                    started.push(event(json!({"type": "background_work.updated",
                        "providerTurnId": format!("turn:{}", turn.run_id), "pending": true})));
                    started.extend(assistant(&turn, &format!("{}:a", turn.run_id), "left running", false));
                    started.push(provider_turn(&turn, "completed"));
                    started.push(terminal(&turn, TurnStatus::Completed, None));
                }
                "workflow" => {
                    self.background.store(true,Ordering::SeqCst);
                    let now=now_iso();
                    started.push(event(json!({"type":"subagent.updated","subagent":{
                        "id":"workflow-coordinator","threadId":turn.thread_id,"runId":turn.run_id,
                        "parentNodeId":turn.root,"origin":"provider_native","createdBy":"agent","driver":self.driver,
                        "providerInstanceId":self.instance,"providerThreadId":null,"childThreadId":null,
                        "nativeTaskRef":{"driver":self.driver,"nativeId":"wf1","strength":"strong"},
                        "prompt":"workflow()","title":"Review","model":null,"workflow":{"name":"Review","phases":[],"agents":[]},
                        "status":"running","result":null,"startedAt":now,"completedAt":null,"updatedAt":now,
                    }})));
                }
                "background-task" | "background-task-hang" => {
                    self.background.store(true, Ordering::SeqCst);
                    *crate::lock(&self.roster) = vec![("bg-1".to_owned(), false)];
                    started.push(self.roster_update(conn_contract::to_json(&input.provider_thread)));
                    if text == "background-task" {
                        started.extend(assistant(&turn, &format!("{}:a", turn.run_id), "started bg-1", false));
                        started.push(provider_turn(&turn, "completed"));
                        started.push(terminal(&turn, TurnStatus::Completed, None));
                    }
                }
                "background-hold" => {
                    self.background.store(true, Ordering::SeqCst);
                    started.extend(assistant(&turn, &format!("{}:a", turn.run_id), "holding", false));
                    started.push(provider_turn(&turn, "completed"));
                    started.push(terminal(&turn, TurnStatus::Completed, None));
                }
                // Live output first, then the running command row; the turn stays open.
                "command" => {
                    let item = format!("turn-item:cmd:{}", turn.run_id);
                    for chunk in ["a\n", "b\n"] {
                        started.push(event(json!({"type": "command_output.delta",
                            "threadId": turn.thread_id, "itemId": item, "chunk": chunk})));
                    }
                    let now = now_iso();
                    started.push(event(json!({"type": "turn_item.updated", "turnItem": {
                        "id": item, "threadId": turn.thread_id, "runId": turn.run_id,
                        "nodeId": null, "providerThreadId": turn.provider_thread_id,
                        "providerTurnId": format!("turn:{}", turn.run_id), "nativeItemRef": null,
                        "parentItemId": null, "ordinal": 0, "status": "running", "title": null,
                        "startedAt": now, "completedAt": null, "updatedAt": now,
                        "type": "command_execution", "input": "ls",
                    }})));
                }
                // `thread-idle`: the provider reports its thread `idle` before the turn ends,
                // then answers.
                "thread-idle" => {
                    let mut row = conn_contract::to_json(&input.provider_thread);
                    row["status"] = json!("idle");
                    started.push(event(
                        json!({"type": "provider_thread.updated", "providerThread": row}),
                    ));
                    started.extend(assistant(&turn, &format!("{}:a", turn.run_id), "done", false));
                    started.push(provider_turn(&turn, "completed"));
                    started.push(terminal(&turn, TurnStatus::Completed, None));
                }
                // `long-stream`: 400 growing snapshots of one reply (about 40 KB at the end),
                // 2 ms apart, then the final text. For memory under a long streaming turn.
                "long-stream" => {
                    let id = format!("{}:a", turn.run_id);
                    let streamed = turn.clone();
                    tokio::spawn(async move {
                        let turn = streamed;
                        emit(&tx, started).await;
                        let mut reply = String::new();
                        for n in 0..400 {
                            reply.push_str(&format!(
                                "Paragraph {n}: the borrow checker keeps one writer or many readers.\n\n"
                            ));
                            emit(&tx, assistant(&turn, &id, &reply, true)).await;
                            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                        }
                        emit(&tx, assistant(&turn, &id, &reply, false)).await;
                        emit(&tx, [provider_turn(&turn, "completed"), terminal(&turn, TurnStatus::Completed, None)]).await;
                    });
                    *crate::lock(&self.turn) = Some(turn);
                    return Ok(());
                }
                "fail" => started.push(terminal(
                    &turn,
                    TurnStatus::Failed,
                    Some(json!({"class": "provider_error", "message": "The fake provider failed.", "code": null, "retryable": false})),
                )),
                _ => {
                    let reply = format!("echo: {text}");
                    let cut = |n: usize| reply.chars().take(n).collect::<String>();
                    let len = reply.chars().count();
                    for part in [len / 3, 2 * len / 3, len] {
                        started.extend(assistant(&turn, &format!("{}:a", turn.run_id), &cut(part), true));
                    }
                    started.extend(assistant(&turn, &format!("{}:a", turn.run_id), &reply, false));
                    started.push(provider_turn(&turn, "completed"));
                    started.push(terminal(&turn, TurnStatus::Completed, None));
                }
            }
            *crate::lock(&self.turn) = Some(turn);
            if text.starts_with("latestart") {
                emit(&tx, started).await;
            } else {
                tokio::spawn(async move { emit(&tx, started).await });
            }
            Ok(())
        })
    }

    fn steer_turn(&self, input: SteerInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            if !self.steering {
                return Err(ProviderError::Unsupported {
                    operation: "steer_turn",
                });
            }
            let events = {
                let turn = crate::lock(&self.turn);
                let turn = turn.as_ref().ok_or(ProviderError::SessionStopped)?;
                let steer = |status: &str| {
                    event(json!({"type": "steer.updated", "threadId": turn.thread_id,
                        "runId": turn.run_id, "messageId": input.message.message_id,
                        "status": status}))
                };
                let mut events = vec![steer("pending"), steer("completed")];
                events.extend(assistant(
                    turn,
                    &format!("{}:steer:{}", turn.run_id, input.message.message_id),
                    &format!("steered: {}", input.message.text),
                    false,
                ));
                events.push(provider_turn(turn, "completed"));
                events.push(terminal(turn, TurnStatus::Completed, None));
                events
            };
            emit(&self.events, events).await;
            Ok(())
        })
    }

    fn abandon_turn_start(&self, input: conn_provider::AbandonTurnStartInput) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            crate::lock(&self.calls).push(format!("abandon {}", input.run_id.as_str()));
            *crate::lock(&self.abandoned.0) = Some(input.run_id.as_str().to_owned());
            self.abandoned.1.notify_waiters();
        })
    }

    fn interrupt_turn(&self, _input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            if self.stuck.load(Ordering::SeqCst) {
                return Err(ProviderError::InterruptTimeout { timeout_ms: 10_000 });
            }
            let (run, event) = {
                let turn = crate::lock(&self.turn);
                let turn = turn.as_ref().ok_or(ProviderError::SessionStopped)?;
                (
                    turn.run_id.clone(),
                    vec![
                        provider_turn(turn, "interrupted"),
                        terminal(turn, TurnStatus::Interrupted, None),
                    ],
                )
            };
            crate::lock(&self.calls).push(format!("interrupt {run}"));
            emit(&self.events, event).await;
            tokio::time::sleep(self.control_delay).await;
            crate::lock(&self.calls).push(format!("interrupted {run}"));
            Ok(())
        })
    }

    fn stop_background_work(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            self.background.store(false, Ordering::SeqCst);
            crate::lock(&self.calls).push(format!(
                "stop background {}",
                input.provider_turn_id.as_str()
            ));
            Ok(())
        })
    }

    fn respond_to_runtime_request(
        &self,
        input: RuntimeRequestResponse,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let events = {
                let turn = crate::lock(&self.turn);
                let turn = turn.as_ref().ok_or(ProviderError::SessionStopped)?;
                let decision = conn_contract::to_json(&input.decision);
                let mut events = vec![event(json!({"type": "runtime_request.updated",
                    "threadId": turn.thread_id, "runtimeRequest": {
                    "id": input.request_id, "nodeId": turn.root, "providerTurnId": format!("turn:{}", turn.run_id),
                    "nativeRequestRef": null,
                    "kind": if input.request_id.as_str().starts_with("question:") { "user_input" } else { "command" },
                    "status": "resolved",
                    "responseCapability": {"type": "live", "providerSessionId": self.id},
                    "createdAt": now_iso(), "resolvedAt": now_iso(), "decision": decision,
                }}))];
                events.extend(assistant(
                    turn,
                    &format!("{}:a", turn.run_id),
                    &format!("approval: {}", decision.as_str().unwrap_or("none")),
                    false,
                ));
                events.push(provider_turn(turn, "completed"));
                events.push(terminal(turn, TurnStatus::Completed, None));
                events
            };
            emit(&self.events, events).await;
            Ok(())
        })
    }

    fn apply_model_selection(
        &self,
        _thread: ProviderThread,
        selection: conn_contract::ModelSelection,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        crate::lock(&self.applied_selections).push(conn_contract::to_json(&selection));
        Box::pin(async { Ok(()) })
    }

    fn mcp_app_request(
        &self,
        input: conn_provider::mcp_apps::Request,
    ) -> BoxFuture<'_, ProviderResult<Value>> {
        Box::pin(async move {
            use conn_provider::mcp_apps::Operation;
            Ok(match input.operation {
                Operation::ListTools => {
                    json!([{"name":"refresh","annotations":{"readOnlyHint":true,"title":"Refresh"}}, {"name":"hidden","_meta":{"ui":{"visibility":["model"]}}}])
                }
                Operation::CallTool { arguments, .. } => {
                    json!({"content":[{"type":"text","text":arguments.get("city")}]})
                }
                Operation::ReadResource { uri } => {
                    json!({"contents":[{"uri":uri,"mimeType":"text/html;profile=mcp-app","text":"<h1>App</h1>"}]})
                }
            })
        })
    }

    fn set_mcp_servers(&self, servers: Vec<McpServer>) -> BoxFuture<'_, ProviderResult<()>> {
        *crate::lock(&self.mcp_servers) = servers;
        Box::pin(async { Ok(()) })
    }

    fn stop_task(&self, input: conn_provider::StopTaskInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            if input.task_id != "wf1" {
                return Err(ProviderError::Protocol {
                    detail: "No running workflow task belongs to this provider thread".into(),
                });
            }
            crate::lock(&self.calls).push(format!("stop workflow {}", input.task_id));
            #[cfg(test)]
            self.workflow_stop_entered.notify_one();
            if !self.control_delay.is_zero() {
                tokio::time::sleep(self.control_delay).await;
            }
            Ok(())
        })
    }

    fn has_pending_background_work(&self) -> bool {
        self.background.load(Ordering::SeqCst)
    }

    /// Marks or clears roster tasks by id, as Claude's `awaitBackgroundTasks`: each id once,
    /// only ids on the roster; a change reports the roster.
    fn await_background_tasks(
        &self,
        input: conn_provider::AwaitBackgroundTasksInput,
    ) -> BoxFuture<'_, ProviderResult<Vec<String>>> {
        Box::pin(async move {
            if !self.background_wait {
                return Err(ProviderError::Unsupported {
                    operation: "await_background_tasks",
                });
            }
            let matched: Vec<String> = {
                let mut roster = crate::lock(&self.roster);
                let mut matched: Vec<String> = Vec::new();
                for id in &input.task_ids {
                    if matched.contains(id) {
                        continue;
                    }
                    if let Some(entry) = roster.iter_mut().find(|(task, _)| task == id) {
                        entry.1 = input.awaited;
                        matched.push(id.clone());
                    }
                }
                matched
            };
            crate::lock(&self.calls).push(format!(
                "await {} {}",
                input.task_ids.join(","),
                input.awaited
            ));
            if !matched.is_empty() {
                let update = self.roster_update(conn_contract::to_json(&input.provider_thread));
                emit(&self.events, [update]).await;
            }
            Ok(matched)
        })
    }

    fn rollback_thread(
        &self,
        input: conn_provider::RollbackThreadInput,
    ) -> BoxFuture<'_, ProviderResult<conn_provider::ThreadSnapshot>> {
        Box::pin(async move {
            let target = match &input.target {
                conn_provider::RollbackTarget::ThreadStart { .. } => "start".to_owned(),
                conn_provider::RollbackTarget::ProviderTurn {
                    app_run_ordinal, ..
                } => format!("turn {app_run_ordinal}"),
            };
            crate::lock(&self.rollbacks).push(target.clone());
            crate::lock(&self.calls).push("rollback".into());
            tokio::time::sleep(self.control_delay).await;
            let fail = self
                .fail_rollbacks
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| match left {
                    0 => None,
                    usize::MAX => Some(usize::MAX),
                    left => Some(left - 1),
                })
                .is_ok();
            if fail {
                return Err(ProviderError::Protocol {
                    detail: "the fake provider cannot roll back".into(),
                });
            }
            crate::lock(&self.calls).push("rolled back".into());
            let mut thread = conn_contract::to_json(&input.provider_thread);
            thread["nativeConversationHeadRef"] = json!({"driver": self.driver,
                "nativeId": format!("rolled-back:{target}"), "strength": "strong"});
            Ok(conn_provider::ThreadSnapshot {
                provider_thread: from_json(thread).map_err(|e| ProviderError::Protocol {
                    detail: e.to_string(),
                })?,
                provider_turns: vec![],
                messages: vec![],
                runtime_requests: vec![],
            })
        })
    }

    fn fork_thread(
        &self,
        input: conn_provider::ForkThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            crate::lock(&self.forks).push(format!(
                "{} {}",
                input.target_thread_id.as_str(),
                input
                    .provider_turn_id
                    .as_ref()
                    .map_or("-", |id| id.as_str())
            ));
            let mut thread = conn_contract::to_json(&input.source_provider_thread);
            let now = now_iso();
            thread["id"] = json!(format!(
                "provider-thread:{}",
                input.target_thread_id.as_str()
            ));
            thread["appThreadId"] = json!(input.target_thread_id.as_str());
            thread["nativeThreadRef"]["nativeId"] =
                json!(format!("native-fork-{}", input.target_thread_id.as_str()));
            let mut forked_from = json!({
                "providerThreadId": conn_contract::to_json(&input.source_provider_thread)["id"],
            });
            if let Some(turn) = &input.provider_turn_id {
                forked_from["providerTurnId"] = json!(turn.as_str());
            }
            thread["forkedFrom"] = forked_from;
            thread["firstRunOrdinal"] = Value::Null;
            thread["lastRunOrdinal"] = Value::Null;
            thread["createdAt"] = json!(now);
            thread["updatedAt"] = json!(now);
            from_json(thread).map_err(|e| ProviderError::Protocol {
                detail: e.to_string(),
            })
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        self.closed.fetch_add(1, Ordering::SeqCst);
        let delay = self.close_delay;
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
        })
    }
}
