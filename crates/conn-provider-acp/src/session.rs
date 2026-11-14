//! [`AcpSession`]: one engine session = one agent process and one ACP session, as T3 runs one
//! `AcpSessionRuntime` per adapter session.
//!
//! All mapper changes and the deliveries they cause happen under one async mutex, so events
//! reach the engine in the order the agent produced them and a slow engine slows the reader
//! (bounded channels end to end). The mutex is never held across a request to the agent.

use std::sync::{Arc, Weak};
use std::time::Duration;

use conn_contract::{ProviderSessionId, ProviderThread, from_json, to_json};
use conn_provider::{
    BoxFuture, EnsureThreadInput, InterruptInput, McpServer, ProviderError, ProviderEvent,
    ProviderResult, ResumeThreadInput, RuntimeRequestResponse, Session, TurnInput,
};
use conn_provider_support::ids::{Env, SystemEnv};
use conn_provider_support::process::ProcEvent;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};

use crate::connection::{CallError, Connection, Incoming};
use crate::flavor::{Completion, Flavor, StopStyle};
use crate::mapper::{self, Disposition, Mapper, Out, PromptOutcome};
use crate::ordered::{J, obj};
use crate::policy;
use crate::prompt::{self, InstructionState};
use crate::protocol::RequestId;

pub(crate) const EVENT_CAPACITY: usize = 256;
/// `ACP_TEXT_FLUSH_INTERVAL`.
pub(crate) const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
/// `ACP_STOP_CONFIRM_TIMEOUT_MS`.
const STOP_CONFIRM_TIMEOUT: Duration = Duration::from_secs(10);

/// A started agent: its stdin, its stdout events, and what stops it.
pub(crate) struct Spawned {
    pub writer: mpsc::Sender<String>,
    pub events: mpsc::Receiver<ProcEvent>,
    /// Ends the agent. `Kill` at session close, `Terminate` for Stop's hard restart.
    pub stop: Box<dyn FnOnce(StopKind) -> BoxFuture<'static, ()> + Send>,
}

/// How a runtime ends (T3 `AcpSessionRuntime`, owned detached process group).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopKind {
    /// The scope finalizer: SIGKILL to the process group, no end of input first.
    Kill,
    /// `terminateProcessGroup`: SIGTERM to the group, 1 s grace, then SIGKILL.
    Terminate,
}

/// Starts the agent for this session (the real process, or a replay agent in tests).
pub(crate) type Spawner = Arc<dyn Fn() -> std::io::Result<Spawned> + Send + Sync>;

pub(crate) struct Config {
    /// `None` holds streamed text until the segment closes, as T3's paused test clock does.
    pub flush_interval: Option<Duration>,
    pub flavor: &'static Flavor,
    pub instance_id: String,
    pub provider_session_id: String,
    pub cwd: String,
    pub runtime_mode: String,
    /// The session's runtime policy as JSON, until a turn brings its own.
    pub policy: Value,
    pub model: String,
    pub mcp_servers: Vec<McpServer>,
    pub client_version: String,
}

struct Runtime {
    connection: Connection,
    stop: Option<Box<dyn FnOnce(StopKind) -> BoxFuture<'static, ()> + Send>>,
    generation: u64,
}

struct State<E: Env> {
    mapper: Mapper<E>,
    events: Option<mpsc::Sender<ProviderEvent>>,
    runtime: Option<Runtime>,
    generation: u64,
    /// The ACP session id (`activeSessionId`).
    session_id: Option<String>,
    initialize: Value,
    setup: Value,
    /// Grok's `t3-xai-prompt-N` counter, per runtime.
    prompt_seq: u64,
    /// The request id of the running `session/prompt`.
    prompt_request: Option<i64>,
    /// The prompt id of the running turn, for Grok's `prompt_complete`.
    active_prompt: Option<(u64, String)>,
    instruction_state: Option<InstructionState>,
    delivered_notes: Option<String>,
    flush_armed: bool,
    restart_required: bool,
    closed: bool,
    runtime_mode: String,
    /// The model the session was configured for (`activeSelection`).
    active_model: Option<String>,
    /// The running turn's `ProviderAdapterV2RuntimePolicy` (or the session's), as JSON.
    policy: Value,
}

pub struct AcpSession {
    id: ProviderSessionId,
    inner: Arc<Inner>,
}

impl std::fmt::Debug for AcpSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpSession")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

struct Inner {
    config: Config,
    spawner: Spawner,
    state: Mutex<State<DynEnv>>,
}

/// A boxed clock, so one session type serves real runs and replays.
pub(crate) struct DynEnv(pub Box<dyn Env + Sync>);

impl Env for DynEnv {
    fn now(&mut self) -> String {
        self.0.now()
    }
    fn now_ms(&mut self) -> u64 {
        self.0.now_ms()
    }
    fn uuid(&mut self) -> String {
        self.0.uuid()
    }
}

fn protocol_error(detail: impl Into<String>) -> ProviderError {
    ProviderError::Protocol {
        detail: detail.into(),
    }
}

fn failed(operation: &'static str, error: &CallError) -> ProviderError {
    ProviderError::Failed {
        operation,
        detail: conn_provider_support::redact::redact(&error.detail()),
    }
}

impl AcpSession {
    /// Starts the agent, `initialize`, then `session/new` (T3's `openSession` start).
    pub(crate) async fn open(
        config: Config,
        spawner: Spawner,
        env: Box<dyn Env + Sync>,
        events: mpsc::Sender<ProviderEvent>,
    ) -> ProviderResult<(Self, Value)> {
        let mapper = Mapper::new(
            DynEnv(env),
            config.flavor,
            &config.instance_id,
            &config.provider_session_id,
        );
        let runtime_mode = config.runtime_mode.clone();
        let inner = Arc::new(Inner {
            spawner,
            state: Mutex::new(State {
                mapper,
                events: Some(events),
                runtime: None,
                generation: 0,
                session_id: None,
                initialize: Value::Null,
                setup: Value::Null,
                prompt_seq: 0,
                active_prompt: None,
                prompt_request: None,
                instruction_state: None,
                delivered_notes: None,
                flush_armed: false,
                restart_required: false,
                closed: false,
                runtime_mode,
                policy: config.policy.clone(),
                active_model: None,
            }),
            config,
        });
        let connection = inner.start_runtime().await?;
        let initialize = inner.initialize(&connection).await?;
        let setup = connection
            .call("session/new", inner.session_setup_params(&initialize, None))
            .await
            .map_err(|e| failed("session/new", &e))?;
        let session_id = setup["sessionId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| protocol_error("session/new returned no session id"))?
            .to_owned();
        {
            let mut state = inner.state.lock().await;
            state.session_id = Some(session_id.clone());
            state.initialize = initialize;
            state.setup = setup;
        }
        let model = inner.config.model.clone();
        inner.configure(&connection, &model).await?;
        let session = Self {
            id: inner.config.provider_session_id.as_str().into(),
            inner,
        };
        Ok((session, json!({"sessionId": session_id})))
    }

    #[cfg(test)]
    pub(crate) async fn pending_requests(&self) -> usize {
        self.inner.state.lock().await.mapper.pending_len()
    }

    #[cfg(test)]
    pub(crate) async fn has_turn(&self) -> bool {
        self.inner.state.lock().await.mapper.has_turn()
    }
}

impl Inner {
    /// Spawns the agent and the task that reads it.
    async fn start_runtime(self: &Arc<Self>) -> ProviderResult<Connection> {
        let spawned = (self.spawner)().map_err(|error| ProviderError::Failed {
            operation: "start",
            detail: format!("could not start {}: {error}", self.config.flavor.driver),
        })?;
        let (connection, incoming) =
            Connection::start(spawned.writer, spawned.events, EVENT_CAPACITY);
        let generation = {
            let mut state = self.state.lock().await;
            state.generation += 1;
            state.prompt_seq = 0;
            state.instruction_state = None;
            state.delivered_notes = None;
            state.runtime = Some(Runtime {
                connection: connection.clone(),
                stop: Some(spawned.stop),
                generation: state.generation,
            });
            state.generation
        };
        tokio::spawn(drive(Arc::downgrade(self), incoming, generation));
        Ok(connection)
    }

    /// `initialize`, as `AcpSessionRuntime.initializeOnce` and effect-acp's negotiating
    /// request send it: the v2 fields, then the v1 ones.
    async fn initialize(&self, connection: &Connection) -> ProviderResult<Value> {
        let flavor = self.config.flavor;
        let client_info = || {
            obj()
                .with("name", "t3-code")
                .with("version", self.config.client_version.clone())
        };
        let capabilities = obj()
            .with(
                "fs",
                obj()
                    .with("readTextFile", false)
                    .with("writeTextFile", false),
            )
            .with("terminal", false)
            .with(
                "session",
                obj().with("notices", obj()).with("compaction", obj()),
            )
            .with("elicitation", obj().with("form", obj()));
        let v2_capabilities = obj().with("elicitation", obj().with("form", obj()));
        let params = obj()
            .with("protocolVersion", 2)
            .with("info", client_info())
            .with("capabilities", v2_capabilities)
            .with_opt("_meta", flavor.initialize_meta.map(|meta| meta()))
            .with("clientCapabilities", capabilities)
            .with("clientInfo", client_info());
        connection
            .call("initialize", params)
            .await
            .map_err(|e| failed("initialize", &e))
    }

    /// `configureSession`'s model part: switch the session's model when the flavor says so.
    async fn configure(&self, connection: &Connection, model: &str) -> ProviderResult<()> {
        let (session_id, switch) = {
            let state = self.state.lock().await;
            if state.active_model.as_deref() == Some(model) {
                return Ok(());
            }
            let switch = (self.config.flavor.select_model)(&state.setup, &state.initialize, model);
            (state.session_id.clone().unwrap_or_default(), switch)
        };
        if let Some(model_id) = &switch {
            connection
                .call(
                    "session/set_model",
                    obj()
                        .with("sessionId", session_id)
                        .with("modelId", model_id.clone()),
                )
                .await
                .map_err(|e| failed("session/set_model", &e))?;
        }
        let mut state = self.state.lock().await;
        if let Some(model_id) = switch {
            state.setup["models"]["currentModelId"] = json!(model_id);
        }
        state.active_model = Some(model.to_owned());
        Ok(())
    }

    /// `session/new` (or load) params: `cwd`, then `mcpServers`.
    fn session_setup_params(&self, initialize: &Value, load: Option<&str>) -> J {
        let http = initialize["agentCapabilities"]["mcpCapabilities"]["http"] == true
            || !initialize["capabilities"]["session"]["mcp"]["http"].is_null();
        let servers: Vec<J> = if http {
            self.config
                .mcp_servers
                .iter()
                .map(|server| {
                    obj()
                        .with("type", "http")
                        .with("name", server.name.clone())
                        .with("url", server.url.clone())
                        .with(
                            "headers",
                            J::Arr(
                                server
                                    .headers
                                    .iter()
                                    .map(|(name, value)| {
                                        obj()
                                            .with("name", name.clone())
                                            .with("value", value.clone())
                                    })
                                    .collect(),
                            ),
                        )
                })
                .collect()
        } else {
            Vec::new()
        };
        let params = match load {
            Some(session_id) => obj().with("sessionId", session_id),
            None => obj(),
        };
        params
            .with("cwd", self.config.cwd.clone())
            .with("mcpServers", J::Arr(servers))
    }

    fn has_t3_mcp(&self) -> bool {
        self.config.mcp_servers.iter().any(|s| s.name == "t3-code")
    }

    /// Applies outs: events to the engine, replies to the agent, a flush timer. Runs under
    /// the state lock, so order holds.
    async fn deliver(self: &Arc<Self>, state: &mut State<DynEnv>, outs: Vec<Out>) {
        let mut arm = false;
        for out in outs {
            match out {
                Out::ScheduleFlush => arm = true,
                other => deliver_one(state, other).await,
            }
        }
        let Some(interval) = self.config.flush_interval else {
            return;
        };
        if arm && !state.flush_armed {
            state.flush_armed = true;
            let weak = Arc::downgrade(self);
            tokio::spawn(async move {
                tokio::time::sleep(interval).await;
                let Some(inner) = weak.upgrade() else { return };
                let mut state = inner.state.lock().await;
                state.flush_armed = false;
                // A flush emits text only; it schedules nothing.
                for out in state.mapper.flush_text() {
                    deliver_one(&mut state, out).await;
                }
            });
        }
    }

    /// Settles the running prompt once (reply, or Grok's completion notification).
    async fn settle(
        self: &Arc<Self>,
        generation: u64,
        prompt_id: Option<&str>,
        outcome: PromptOutcome,
    ) {
        let mut state = self.state.lock().await;
        if state.generation != generation {
            return;
        }
        if let Some(prompt_id) = prompt_id
            && state.active_prompt.as_ref().map(|(_, id)| id.as_str()) != Some(prompt_id)
        {
            return;
        }
        let Some((_, active_id)) = state.active_prompt.take() else {
            return;
        };
        if matches!(&outcome, PromptOutcome::Stopped(reason) if reason != "cancelled" && reason != "refusal" && reason != "error")
        {
            // Delivered: later prompts skip the notes until they change.
            let _ = active_id;
        } else {
            state.delivered_notes = None;
            state.instruction_state = None;
        }
        let outs = state.mapper.prompt_settled(outcome);
        self.deliver(&mut state, outs).await;
    }
}

async fn deliver_one(state: &mut State<DynEnv>, out: Out) {
    match out {
        Out::Event(event) => {
            if let Some(events) = &state.events
                && events.send(event).await.is_err()
            {
                state.events = None;
            }
        }
        Out::Reply { id, result } => {
            if let Some(runtime) = &state.runtime {
                runtime.connection.reply(&id, result).await;
            }
        }
        Out::ScheduleFlush => {}
    }
}

/// Reads one runtime's agent frames until it exits.
async fn drive(inner: Weak<Inner>, mut incoming: mpsc::Receiver<Incoming>, generation: u64) {
    while let Some(message) = incoming.recv().await {
        let Some(inner) = inner.upgrade() else { return };
        match message {
            Incoming::Notification { method, params } => {
                handle_notification(&inner, generation, &method, &params).await;
            }
            Incoming::Request { id, method, params } => {
                if method == "session/request_permission" {
                    handle_permission(&inner, generation, id, &params).await;
                    continue;
                }
                let mut state = inner.state.lock().await;
                if state.generation != generation {
                    continue;
                }
                let question = (inner.config.flavor.completion == Completion::XAiPromptComplete
                    && matches!(
                        method.as_str(),
                        "x.ai/ask_user_question" | "_x.ai/ask_user_question"
                    ))
                .then(|| crate::grok::question_request(&params))
                .flatten();
                let outs = match question {
                    Some((native_request_id, native_item_id, questions))
                        if state.mapper.has_turn() =>
                    {
                        state.mapper.user_input_request(
                            id,
                            &native_item_id,
                            &native_request_id,
                            questions,
                            mapper::Pending::XAiQuestion(params.clone()),
                        )
                    }
                    _ => {
                        let label = format!("agent request {method}");
                        state.mapper.skip(&label);
                        if let Some(runtime) = &state.runtime {
                            runtime
                                .connection
                                .reply_error(&id, -32601, &format!("Method not found: {method}"))
                                .await;
                        }
                        Vec::new()
                    }
                };
                inner.deliver(&mut state, outs).await;
            }
            Incoming::Reply { id, result } => {
                let is_prompt = {
                    let state = inner.state.lock().await;
                    state.generation == generation && state.prompt_request == Some(id)
                };
                if !is_prompt {
                    continue;
                }
                let outcome = match result {
                    Ok(reply) => PromptOutcome::Stopped(
                        reply["stopReason"]
                            .as_str()
                            .unwrap_or("end_turn")
                            .to_owned(),
                    ),
                    Err(CallError::Rpc(error)) => PromptOutcome::Failed {
                        message: error.message,
                        code: Some(error.code),
                    },
                    Err(CallError::Closed) => continue,
                };
                inner.settle(generation, None, outcome).await;
            }
            Incoming::Closed(exit) => {
                let mut state = inner.state.lock().await;
                if state.generation != generation {
                    return;
                }
                state.runtime = None;
                state.active_prompt = None;
                state.restart_required = true;
                let detail = exit.map_or_else(
                    || "the agent closed its output".to_owned(),
                    |exit| format!("the agent exited ({})", exit.describe()),
                );
                let outs = state.mapper.agent_exited(&detail);
                inner.deliver(&mut state, outs).await;
                return;
            }
        }
    }
}

/// `handleRequestPermission`: an immediate allow or deny under the policy, or a request the
/// user answers.
async fn handle_permission(inner: &Arc<Inner>, generation: u64, id: RequestId, params: &Value) {
    let (params, policy, kind) = {
        let state = inner.state.lock().await;
        if state.generation != generation {
            return;
        }
        let params = state.mapper.with_tracked_tool(params);
        let tool_call_id = params["toolCall"]["toolCallId"].as_str().unwrap_or("");
        let kind = params["toolCall"]["kind"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| state.mapper.tracked_tool_kind(tool_call_id));
        (params, state.policy.clone(), kind)
    };
    let locations: Vec<String> = params["toolCall"]["locations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l["path"].as_str().map(str::to_owned))
        .collect();
    let flavor = inner.config.flavor;
    let disposition = match (flavor.permission_override)(&policy) {
        Some(disposition) => disposition,
        None => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || {
                policy::disposition(&policy, kind.as_deref(), &locations)
            })
            .await
            .unwrap_or(Disposition::Ask)
        }
    };
    let mut state = inner.state.lock().await;
    if state.generation != generation {
        return;
    }
    let outs = match disposition {
        Disposition::Ask => state.mapper.permission_request(id, &params),
        immediate => vec![Out::Reply {
            id,
            result: mapper::immediate_reply(&mapper::permission_options(&params), immediate),
        }],
    };
    inner.deliver(&mut state, outs).await;
}

async fn handle_notification(inner: &Arc<Inner>, generation: u64, method: &str, params: &Value) {
    if method == "session/update" {
        let mut state = inner.state.lock().await;
        if state.generation != generation {
            return;
        }
        let outs = state.mapper.session_update(params);
        inner.deliver(&mut state, outs).await;
        return;
    }
    if inner.config.flavor.completion == Completion::XAiPromptComplete
        && let Some((prompt_id, outcome)) = xai_prompt_complete(method, params)
    {
        inner.settle(generation, Some(&prompt_id), outcome).await;
        return;
    }
    let mut state = inner.state.lock().await;
    let label = format!("notification {method}");
    state.mapper.skip(&label);
}

/// Grok's prompt completion (`makeXAiPromptCompletionRuntime`): `prompt_complete`, or a
/// `turn_completed` session notification that names the prompt. The outcome follows
/// `promptResponseFromXAi` and `xAiPromptFailure`.
fn xai_prompt_complete(method: &str, params: &Value) -> Option<(String, PromptOutcome)> {
    let (prompt_id, stop_reason, agent_result) = match method {
        "x.ai/session/prompt_complete" | "_x.ai/session/prompt_complete" => (
            params["promptId"].as_str()?.to_owned(),
            params["stopReason"].as_str().map(str::to_owned),
            params.get("agentResult").cloned(),
        ),
        "x.ai/session_notification" | "_x.ai/session_notification" | "_x.ai/session/update" => {
            let update = &params["update"];
            if update["sessionUpdate"] != "turn_completed" {
                return None;
            }
            let id = update["prompt_id"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    update["promptId"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                })?;
            if id.starts_with("task-completed-") {
                return None;
            }
            let stop = update["stop_reason"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    update["stopReason"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                })
                .map(str::to_owned);
            (id.to_owned(), stop, update.get("agent_result").cloned())
        }
        _ => return None,
    };
    let outcome = match stop_reason.as_deref() {
        Some("rate_limit") => PromptOutcome::Failed {
            message: "Grok usage limit reached. Try again later.".into(),
            code: Some(-32003),
        },
        Some("error") => PromptOutcome::Failed {
            message: agent_result
                .as_ref()
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map_or_else(
                    || "Grok ended the turn with an error.".to_owned(),
                    str::to_owned,
                ),
            code: Some(-32603),
        },
        // `normalizeXAiStopReason`.
        Some(r @ ("cancelled" | "end_turn" | "max_tokens" | "max_turn_requests" | "refusal")) => {
            PromptOutcome::Stopped(r.to_owned())
        }
        _ => PromptOutcome::Stopped("end_turn".into()),
    };
    Some((prompt_id, outcome))
}

impl Session for AcpSession {
    fn provider_session_id(&self) -> &ProviderSessionId {
        &self.id
    }

    fn ensure_thread(
        &self,
        input: EnsureThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let mut state = self.inner.state.lock().await;
            let Some(session_id) = state.session_id.clone() else {
                return Err(protocol_error("ACP runtime did not produce a session id"));
            };
            let thread = state
                .mapper
                .make_provider_thread(input.thread_id.as_str(), &session_id);
            from_json(thread).map_err(|e| protocol_error(format!("provider thread: {e}")))
        })
    }

    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let mut thread = to_json(&input.provider_thread);
            thread["providerSessionId"] = json!(self.inner.config.provider_session_id);
            thread["status"] = json!("idle");
            from_json(thread).map_err(|e| protocol_error(format!("provider thread: {e}")))
        })
    }

    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            let flavor = inner.config.flavor;
            if inner.state.lock().await.restart_required {
                // A new agent loads the session (T3 `restartRuntimeAfterTeardownIfRequired`).
                let connection = inner.start_runtime().await?;
                let initialize = inner.initialize(&connection).await?;
                let session_id = inner
                    .state
                    .lock()
                    .await
                    .session_id
                    .clone()
                    .unwrap_or_default();
                let setup = connection
                    .call(
                        "session/load",
                        inner.session_setup_params(&initialize, Some(&session_id)),
                    )
                    .await
                    .map_err(|e| failed("session/load", &e))?;
                let mut state = inner.state.lock().await;
                state.initialize = initialize;
                state.setup = setup;
                state.restart_required = false;
                state.active_model = None;
            }
            let model = to_json(&input.model_selection)["model"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let live = inner
                .state
                .lock()
                .await
                .runtime
                .as_ref()
                .map(|r| r.connection.clone());
            if let Some(connection) = live {
                inner.configure(&connection, &model).await?;
            }
            {
                let mut state = inner.state.lock().await;
                if state.closed {
                    return Err(ProviderError::SessionStopped);
                }
                if state.mapper.has_turn() {
                    return Err(protocol_error(format!(
                        "ACP provider turn {} is still active",
                        state.mapper.current_provider_turn_id().unwrap_or("")
                    )));
                }
                state.policy = to_json(&input.runtime_policy);
                state.runtime_mode = serde_json::to_value(input.runtime_policy.runtime_mode)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default();
                let Some(runtime) = &state.runtime else {
                    return Err(ProviderError::SessionStopped);
                };
                let connection = runtime.connection.clone();
                let generation = runtime.generation;
                let session_id = state.session_id.clone().unwrap_or_default();
                let attachments: Vec<Value> =
                    input.message.attachments.iter().map(to_json).collect();
                let message_text = conn_provider_support::attachments::prompt_text(
                    &input.message.text,
                    &attachments,
                    None,
                );
                let instruction_state = InstructionState {
                    plan_mode: serde_json::to_value(input.runtime_policy.interaction_mode)
                        .ok()
                        .is_some_and(|v| v == "plan"),
                    has_t3_mcp: inner.has_t3_mcp(),
                    has_device_tools: false,
                };
                let text = prompt::wrap(&message_text, instruction_state, state.instruction_state);
                let model = to_json(&input.model_selection)["model"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let notes = prompt::runtime_instructions(flavor.harness, &model);
                let slash = message_text.trim_start().starts_with('/');
                let send_notes = !slash && state.delivered_notes.as_deref() != Some(notes.as_str());
                let mut blocks = Vec::new();
                if !text.is_empty() {
                    blocks.push(obj().with("type", "text").with("text", text.clone()));
                }
                if blocks.is_empty() {
                    return Err(protocol_error(
                        "ACP turn requires non-empty text or attachments",
                    ));
                }
                if send_notes {
                    blocks.push(obj().with("type", "text").with("text", notes.clone()));
                }
                if text != message_text {
                    state.instruction_state = Some(instruction_state);
                }
                if send_notes {
                    state.delivered_notes = Some(notes);
                }
                let mut params = obj()
                    .with("sessionId", session_id.clone())
                    .with("prompt", J::Arr(blocks));
                let prompt_id = if flavor.completion == Completion::XAiPromptComplete {
                    state.prompt_seq += 1;
                    let id = format!("t3-xai-prompt-{}", state.prompt_seq);
                    params = params.with(
                        "_meta",
                        obj()
                            .with("promptId", id.clone())
                            .with("requestId", id.clone()),
                    );
                    Some(id)
                } else {
                    None
                };
                state.active_prompt = Some((generation, prompt_id.unwrap_or_default()));
                let outs = state.mapper.begin_turn(&input, &session_id);
                inner.deliver(&mut state, outs).await;
                // The reply comes back through the driver, in order with the turn's updates.
                state.prompt_request = connection.send("session/prompt", params).await;
            }
            Ok(())
        })
    }

    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            let mut state = inner.state.lock().await;
            if state.mapper.current_provider_turn_id() != Some(input.provider_turn_id.as_str()) {
                return Ok(());
            }
            let outs = state.mapper.interrupt();
            inner.deliver(&mut state, outs).await;
            match inner.config.flavor.stop {
                StopStyle::KillProcessGroup => {
                    // Finalize before the kill, as T3 does for a hard restart.
                    let outs = state.mapper.finalize("interrupted", None);
                    inner.deliver(&mut state, outs).await;
                    state.active_prompt = None;
                    state.restart_required = true;
                    state.generation += 1;
                    let stop = state.runtime.take().and_then(|mut r| r.stop.take());
                    drop(state);
                    if let Some(stop) = stop {
                        stop(StopKind::Terminate).await;
                    }
                    Ok(())
                }
                StopStyle::Cancel => {
                    let session_id = state.session_id.clone().unwrap_or_default();
                    let connection = state.runtime.as_ref().map(|r| r.connection.clone());
                    drop(state);
                    if let Some(connection) = connection {
                        let params = obj()
                            .with("sessionId", session_id)
                            .with_opt("_meta", inner.config.flavor.cancel_meta.map(|m| m()));
                        connection.notify("session/cancel", params).await;
                    }
                    let deadline = tokio::time::Instant::now() + STOP_CONFIRM_TIMEOUT;
                    loop {
                        if !inner.state.lock().await.mapper.has_turn() {
                            return Ok(());
                        }
                        if tokio::time::Instant::now() >= deadline {
                            return Err(ProviderError::InterruptTimeout {
                                timeout_ms: STOP_CONFIRM_TIMEOUT
                                    .as_millis()
                                    .try_into()
                                    .unwrap_or(u64::MAX),
                            });
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
        })
    }

    fn respond_to_runtime_request(
        &self,
        input: RuntimeRequestResponse,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            let mut state = inner.state.lock().await;
            let decision = input
                .decision
                .and_then(|d| serde_json::to_value(d).ok())
                .and_then(|v| v.as_str().map(str::to_owned));
            let answers = input.answers.as_ref().map(to_json);
            let outs = state
                .mapper
                .respond(
                    input.request_id.as_str(),
                    decision.as_deref(),
                    answers.as_ref(),
                )
                .ok_or_else(|| {
                    protocol_error(format!(
                        "No pending ACP runtime request {} (or it needs a decision)",
                        input.request_id.as_str()
                    ))
                })?;
            inner.deliver(&mut state, outs).await;
            Ok(())
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let inner = &self.inner;
            let (connection, session_id, can_close, stop) = {
                let mut state = inner.state.lock().await;
                if state.closed {
                    return;
                }
                state.closed = true;
                let can_close =
                    !state.initialize["agentCapabilities"]["sessionCapabilities"]["close"]
                        .is_null()
                        || !state.initialize["capabilities"]["session"].is_null();
                let runtime = state.runtime.take();
                state.generation += 1;
                let (connection, stop) = match runtime {
                    Some(mut runtime) => (Some(runtime.connection.clone()), runtime.stop.take()),
                    None => (None, None),
                };
                (connection, state.session_id.clone(), can_close, stop)
            };
            if let (Some(connection), Some(session_id), true) = (connection, session_id, can_close)
            {
                let _ = tokio::time::timeout(
                    STOP_CONFIRM_TIMEOUT,
                    connection.call("session/close", obj().with("sessionId", session_id)),
                )
                .await;
            }
            if let Some(stop) = stop {
                stop(StopKind::Kill).await;
            }
            let mut state = inner.state.lock().await;
            state.events = None;
        })
    }

    fn set_mcp_servers(&self, _servers: Vec<McpServer>) -> BoxFuture<'_, ProviderResult<()>> {
        // ACP declares MCP servers at session setup; T3 passes them at open only.
        Box::pin(async {
            Err(ProviderError::Unsupported {
                operation: "set_mcp_servers",
            })
        })
    }
}

impl Drop for AcpSession {
    fn drop(&mut self) {
        // A session dropped without `close`: its runtime's `Process` (inside `stop`) kills the
        // agent when the boxed closure drops with the state.
    }
}

/// A clock for real sessions.
pub(crate) fn system_env() -> Box<dyn Env + Sync> {
    Box::new(SystemEnv)
}
