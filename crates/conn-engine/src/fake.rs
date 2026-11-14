//! A scripted provider for tests and the client check. The user's text picks the script:
//! - `hang`: the turn starts and waits for an interrupt.
//! - `stuck`: the turn starts and never confirms a Stop (`InterruptTimeout`), as a Codex turn
//!   that ignores `turn/interrupt`.
//! - `ask`: the turn asks for a command approval, then answers once approved.
//! - `fail`: the turn fails.
//! - `subagent`: a subagent's child thread with one message, then the turn completes.
//! - `background`: the turn completes with background work left, then asks for a
//!   continuation turn, which answers `continued` and ends the work.
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

use crate::time::now_iso;

pub struct FakeProvider {
    id: ProviderInstanceId,
    /// Sessions opened so far.
    pub sessions: Arc<AtomicUsize>,
    /// The MCP servers the newest session was given.
    pub mcp_servers: Arc<Mutex<Vec<McpServer>>>,
    /// Sessions closed so far.
    pub closed: Arc<AtomicUsize>,
    /// Model selections sent to a running turn (`apply_model_selection`), as JSON.
    pub applied_selections: Arc<Mutex<Vec<Value>>>,
    steering: bool,
    close_delay: std::time::Duration,
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
            applied_selections: Arc::new(Mutex::new(vec![])),
            steering: true,
            close_delay: std::time::Duration::ZERO,
        }
    }

    /// A provider whose sessions take `delay` to close, as a process given time to exit.
    pub fn with_close_delay(mut self, delay: std::time::Duration) -> Self {
        self.close_delay = delay;
        self
    }

    /// A provider whose sessions decline every steer, as one without live steering does.
    pub fn without_steering(mut self) -> Self {
        self.steering = false;
        self
    }
}

struct Turn {
    thread_id: String,
    run_id: String,
    root: String,
    provider_thread_id: String,
    ordinal: u32,
}

struct FakeSession {
    id: ProviderSessionId,
    instance: String,
    driver: String,
    events: mpsc::Sender<ProviderEvent>,
    turn: Arc<Mutex<Option<Turn>>>,
    steering: bool,
    background: Arc<AtomicBool>,
    /// The running turn ignores Stop.
    stuck: Arc<AtomicBool>,
    mcp_servers: Arc<Mutex<Vec<McpServer>>>,
    closed: Arc<AtomicUsize>,
    applied_selections: Arc<Mutex<Vec<Value>>>,
    close_delay: std::time::Duration,
}

impl Provider for FakeProvider {
    fn instance_id(&self) -> &ProviderInstanceId {
        &self.id
    }
    fn driver(&self) -> &str {
        "claudeAgent"
    }
    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
        Box::pin(async { Ok(from_json(json!({})).expect("placeholder")) })
    }
    fn open_session(
        &self,
        input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async move {
            self.sessions.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = mpsc::channel(64);
            Ok(OpenedSession {
                session: Box::new(FakeSession {
                    id: input.provider_session_id,
                    instance: self.id.as_str().to_owned(),
                    driver: self.driver().to_owned(),
                    events: tx,
                    turn: Arc::new(Mutex::new(None)),
                    steering: self.steering,
                    background: Arc::new(AtomicBool::new(false)),
                    stuck: Arc::new(AtomicBool::new(false)),
                    mcp_servers: self.mcp_servers.clone(),
                    closed: self.closed.clone(),
                    applied_selections: self.applied_selections.clone(),
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
            let id = if self.instance == "claudeAgent" {
                format!("provider-thread:{}", input.thread_id)
            } else {
                format!("provider-thread:{}:{}", self.instance, input.thread_id)
            };
            Ok(from_json(json!({
                "id": id, "driver": self.driver,
                "providerInstanceId": self.instance, "providerSessionId": self.id,
                "appThreadId": input.thread_id, "ownerNodeId": null,
                "nativeThreadRef": {"driver": self.driver, "nativeId": "native-1", "strength": "strong"},
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
        Box::pin(async move { Ok(input.provider_thread) })
    }

    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
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
            let text = input.message.text.clone();
            let tx = self.events.clone();
            let mut started = vec![provider_turn(&turn, "running")];
            self.stuck.store(text == "stuck", Ordering::SeqCst);
            match text.as_str() {
                "hang" | "stuck" => {}
                "ask" => started.push(event(json!({"type": "runtime_request.updated",
                    "threadId": turn.thread_id, "runtimeRequest": {
                    "id": "request:1", "nodeId": turn.root, "providerTurnId": format!("turn:{}", turn.run_id),
                    "nativeRequestRef": null, "kind": "command", "status": "pending",
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
                "background" => {
                    self.background.store(true, Ordering::SeqCst);
                    started.extend(assistant(&turn, &format!("{}:a", turn.run_id), "started work", false));
                    started.push(provider_turn(&turn, "completed"));
                    started.push(terminal(&turn, TurnStatus::Completed, None));
                    started.push(event(json!({"type": "continuation.requested",
                        "threadId": turn.thread_id, "providerThreadId": turn.provider_thread_id,
                        "detail": null})));
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
            tokio::spawn(async move { emit(&tx, started).await });
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

    fn interrupt_turn(&self, _input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            if self.stuck.load(Ordering::SeqCst) {
                return Err(ProviderError::InterruptTimeout { timeout_ms: 10_000 });
            }
            let event = {
                let turn = crate::lock(&self.turn);
                let turn = turn.as_ref().ok_or(ProviderError::SessionStopped)?;
                vec![
                    provider_turn(turn, "interrupted"),
                    terminal(turn, TurnStatus::Interrupted, None),
                ]
            };
            emit(&self.events, event).await;
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
                    "nativeRequestRef": null, "kind": "command", "status": "resolved",
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

    fn start_continuation_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
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

    fn apply_model_selection(
        &self,
        _thread: ProviderThread,
        selection: conn_contract::ModelSelection,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        crate::lock(&self.applied_selections).push(conn_contract::to_json(&selection));
        Box::pin(async { Ok(()) })
    }

    fn set_mcp_servers(&self, servers: Vec<McpServer>) -> BoxFuture<'_, ProviderResult<()>> {
        *crate::lock(&self.mcp_servers) = servers;
        Box::pin(async { Ok(()) })
    }

    fn has_pending_background_work(&self) -> bool {
        self.background.load(Ordering::SeqCst)
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
