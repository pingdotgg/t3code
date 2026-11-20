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
    BoxFuture, Closed, EnsureThreadInput, InterruptInput, McpServer, ProviderError, ProviderEvent,
    ProviderResult, ResumeThreadInput, RuntimeRequestResponse, Session, TurnInput,
};
use conn_provider_support::ids::{Env, SystemEnv};
use conn_provider_support::process::ProcEvent;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};

use crate::connection::{CallError, Connection, Incoming};
use crate::flavor::{Completion, Flavor, ModelSwitch, StopStyle};
use crate::mapper::{self, Disposition, Mapper, Out, PromptOutcome};
use crate::ordered::{J, obj};
use crate::policy;
use crate::prompt::{self, InstructionState};
use crate::protocol::RequestId;

pub(crate) const EVENT_CAPACITY: usize = 256;
/// `ACP_TEXT_FLUSH_INTERVAL`.
pub(crate) const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
/// `ACP_SUBAGENT_TEXT_FLUSH_INTERVAL`: the server's paragraph throttle cadence.
const SUBAGENT_FLUSH_INTERVAL: Duration = Duration::from_millis(400);
/// `ACP_DEFERRED_FINALIZE_DEBOUNCE`.
pub(crate) const FINALIZE_DEBOUNCE: Duration = Duration::from_secs(3);
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
    /// `ACP_DEFERRED_FINALIZE_DEBOUNCE` (3 s); the replay shortens it, as T3's test clock
    /// skips it.
    pub finalize_debounce: Duration,
    pub flavor: &'static Flavor,
    pub instance_id: String,
    pub provider_session_id: String,
    pub cwd: String,
    pub runtime_mode: String,
    /// The session's runtime policy as JSON, until a turn brings its own.
    pub policy: Value,
    pub model: String,
    /// The selection's `reasoningEffort` option.
    pub effort: Option<String>,
    pub mcp_servers: Vec<McpServer>,
    pub client_version: String,
    /// This server's executable: the stdio MCP bridge runs as `<it> acp-mcp-bridge`.
    pub self_command: String,
    /// Where attachments are saved (`resolveAttachmentPath`); `None`: paths unavailable.
    pub attachments_dir: Option<std::path::PathBuf>,
    /// `authMethodId`, sent eagerly when the flavor says so.
    pub auth_method: Option<String>,
    /// The installed agent version when known before `initialize` (`runtimeVersion`).
    pub runtime_version: Option<String>,
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
    /// What the running prompt delivers once it succeeds.
    delivery: Option<Delivery>,
    flush_armed: bool,
    subagent_flush_armed: bool,
    restart_required: bool,
    closed: bool,
    runtime_mode: String,
    /// The model the session was configured for (`activeSelection`).
    active_model: Option<String>,
    /// The running turn's `ProviderAdapterV2RuntimePolicy` (or the session's), as JSON.
    policy: Value,
}

/// What a prompt carried (`promptParts`): recorded only when the prompt succeeds, as T3
/// records `promptInstructionStates` and `promptRuntimeInstructions` in the reply callback.
#[derive(Debug)]
struct Delivery {
    instruction_state: Option<InstructionState>,
    notes: Option<String>,
    /// The compaction marker the prompt saw when it was built.
    compaction_marker: Option<u64>,
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
    /// The run whose start Stop abandoned (`abandon_turn_start`). Outside `state`, which a
    /// start holds across awaits; one is enough, as a stale id matches no later run.
    abandoned_run: std::sync::Mutex<Option<String>>,
}

impl Inner {
    /// Fails when Stop abandoned this run's start: the start sends nothing more.
    fn check_abandoned(&self, run_id: &str) -> ProviderResult<()> {
        let abandoned = self
            .abandoned_run
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_deref()
            == Some(run_id);
        if abandoned {
            return Err(ProviderError::Failed {
                operation: "start_turn",
                detail: "Stop ended the turn before the agent started it.".into(),
            });
        }
        Ok(())
    }
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

/// The `initialize` params of `AcpSessionRuntime.initializeOnce` and effect-acp's negotiating
/// request: the v2 fields, then the v1 ones. The provider probe sends the same with its own
/// client name (`t3-code-provider-probe`) and no elicitation handler, so without the
/// elicitation capability.
pub(crate) fn initialize_params(
    flavor: &Flavor,
    client_name: &str,
    client_version: &str,
    elicitation: bool,
) -> J {
    // Only a session's runtime serves files; the probe (no elicitation) serves nothing.
    let file_reads = flavor.client_file_reads && elicitation;
    let client_info = || {
        obj()
            .with("name", client_name.to_owned())
            .with("version", client_version.to_owned())
    };
    let capabilities = obj()
        .with(
            "fs",
            obj()
                .with("readTextFile", file_reads)
                .with("writeTextFile", false),
        )
        .with("terminal", false)
        .with(
            "session",
            obj().with("notices", obj()).with("compaction", obj()),
        )
        .with_opt(
            "elicitation",
            elicitation.then(|| obj().with("form", obj())),
        );
    let v2_capabilities = obj().with_opt(
        "elicitation",
        elicitation.then(|| obj().with("form", obj())),
    );
    obj()
        .with("protocolVersion", 2)
        .with("info", client_info())
        .with("capabilities", v2_capabilities)
        .with_opt("_meta", flavor.initialize_meta.map(|meta| meta()))
        .with("clientCapabilities", capabilities)
        .with("clientInfo", client_info())
}

impl AcpSession {
    async fn start_turn_checked(&self, input: TurnInput) -> ProviderResult<()> {
        let inner = &self.inner;
        let flavor = inner.config.flavor;
        let run_id = input.run_id.as_str();
        inner.check_abandoned(run_id)?;
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
            // `resumeMethod: "resume"` (Antigravity): `session/resume` when the agent offers it.
            let method = if inner.config.flavor.resume
                && !initialize["agentCapabilities"]["sessionCapabilities"]["resume"].is_null()
            {
                "session/resume"
            } else {
                "session/load"
            };
            let setup = connection
                .call(
                    method,
                    inner.session_setup_params(&initialize, Some(&session_id)),
                )
                .await
                .map_err(|e| failed(method, &e))?;
            let mut state = inner.state.lock().await;
            state.initialize = initialize;
            state.setup = setup;
            state.restart_required = false;
            state.active_model = None;
        }
        // The step it was in has ended; an abandoned start sends nothing more.
        inner.check_abandoned(run_id)?;
        let model = to_json(&input.model_selection)["model"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let attachments: Vec<Value> = input.message.attachments.iter().map(to_json).collect();
        let image_blocks = inner.image_blocks(&attachments).await?;
        inner.check_abandoned(run_id)?;
        // `compactThread`: T3's orchestrator sends `/compact` in any case as exactly
        // `/compact` to a flavor that compacts.
        let user_text = if flavor.supports_compaction
            && attachments.is_empty()
            && input.message.text.trim().eq_ignore_ascii_case("/compact")
        {
            "/compact".to_owned()
        } else {
            input.message.text.clone()
        };
        // The attachment paths check the disk: off the runtime thread.
        let message_text = {
            let (text, attachments, dir) = (
                user_text.clone(),
                attachments.clone(),
                inner.config.attachments_dir.clone(),
            );
            tokio::task::spawn_blocking(move || {
                conn_provider_support::attachments::prompt_text(&text, &attachments, dir.as_deref())
            })
            .await
            .map_err(|_| protocol_error("attachment paths"))?
        };
        let live = inner
            .state
            .lock()
            .await
            .runtime
            .as_ref()
            .map(|r| r.connection.clone());
        if let Some(connection) = live {
            let effort = crate::grok::selection_effort(&to_json(&input.model_selection));
            inner
                .configure(&connection, &model, effort.as_deref())
                .await?;
        }
        inner.check_abandoned(run_id)?;
        {
            let mut state = inner.state.lock().await;
            if state.closed {
                return Err(ProviderError::SessionStopped);
            }
            inner.check_abandoned(run_id)?;
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
            // A provider continuation sends no prompt: it replays the buffered wake turn.
            if flavor.background.is_some() && input.message.is_provider_continuation() {
                let outs = state
                    .mapper
                    .begin_turn(&input, &session_id, &input.message.text);
                inner.deliver(&mut state, outs).await;
                return Ok(());
            }
            let instruction_state = InstructionState {
                plan_mode: serde_json::to_value(input.runtime_policy.interaction_mode)
                    .ok()
                    .is_some_and(|v| v == "plan"),
                has_t3_mcp: inner.has_t3_mcp(),
                has_device_tools: false,
            };
            // A compacted session gets T3's instructions and notes again.
            let compaction_marker = state.mapper.compaction_marker();
            let previous = if compaction_marker.is_some() {
                None
            } else {
                state.instruction_state
            };
            let text = prompt::wrap(&message_text, instruction_state, previous);
            let model = to_json(&input.model_selection)["model"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let linking = !flavor
                .session_setup
                .is_some_and(|s| (s.carries_linking)(&state.initialize));
            let notes = prompt::runtime_instructions(flavor.harness, &model, linking);
            let slash = user_text.trim_start().starts_with('/');
            let send_notes = !slash
                && (compaction_marker.is_some()
                    || state.delivered_notes.as_deref() != Some(notes.as_str()));
            let mut blocks = Vec::new();
            if !text.is_empty() {
                blocks.push(obj().with("type", "text").with("text", text.clone()));
            }
            if !image_blocks.is_empty()
                && !flavor.supports_image_prompts
                && state.initialize["agentCapabilities"]["promptCapabilities"]["image"] != true
            {
                return Err(protocol_error(
                    "ACP driver did not negotiate image prompt support",
                ));
            }
            // Antigravity (`buildAntigravityPrompt`): without `promptCapabilities.image` an
            // image goes as its path only, which the text already carries.
            let images_as_paths = flavor.client_file_reads
                && state.initialize["agentCapabilities"]["promptCapabilities"]["image"] != true;
            if !images_as_paths {
                blocks.extend(image_blocks);
            }
            if blocks.is_empty() {
                return Err(protocol_error(
                    "ACP turn requires non-empty text or attachments",
                ));
            }
            if send_notes {
                blocks.push(obj().with("type", "text").with("text", notes.clone()));
            }
            state.delivery = Some(Delivery {
                instruction_state: (text != message_text).then_some(instruction_state),
                notes: send_notes.then_some(notes),
                compaction_marker,
            });
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
            let outs = state.mapper.begin_turn(&input, &session_id, &user_text);
            inner.deliver(&mut state, outs).await;
            // The reply comes back through the driver, in order with the turn's updates.
            state.prompt_request = connection.send("session/prompt", params).await;
        }
        Ok(())
    }

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
                delivery: None,
                flush_armed: false,
                subagent_flush_armed: false,
                restart_required: false,
                closed: false,
                runtime_mode,
                policy: config.policy.clone(),
                active_model: None,
            }),
            config,
            abandoned_run: std::sync::Mutex::new(None),
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
            state.mapper.set_root_session(&session_id);
            state.initialize = initialize;
            state.setup = setup;
        }
        let model = inner.config.model.clone();
        let effort = inner.config.effort.clone();
        inner
            .configure(&connection, &model, effort.as_deref())
            .await?;
        let session = Self {
            id: inner.config.provider_session_id.as_str().into(),
            inner,
        };
        Ok((session, json!({"sessionId": session_id})))
    }

    /// The agent's `initialize` result and the session setup result, as last seen.
    pub(crate) async fn handshake(&self) -> (Value, Value) {
        let state = self.inner.state.lock().await;
        (state.initialize.clone(), state.setup.clone())
    }

    #[cfg(test)]
    pub(crate) async fn pending_requests(&self) -> usize {
        self.inner.state.lock().await.mapper.pending_len()
    }

    #[cfg(test)]
    pub(crate) async fn has_turn(&self) -> bool {
        self.inner.state.lock().await.mapper.has_turn()
    }

    #[cfg(test)]
    pub(crate) async fn background_state_empty(&self) -> bool {
        self.inner
            .state
            .lock()
            .await
            .mapper
            .background_state_empty()
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
            state.delivery = None;
            state.mapper.reset_compaction();
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
        let (name, version) = match flavor.client_info {
            Some(info) => info(self.config.runtime_version.as_deref()),
            None => ("t3-code".to_owned(), self.config.client_version.clone()),
        };
        let params = initialize_params(flavor, &name, &version, true);
        let initialize = connection
            .call("initialize", params)
            .await
            .map_err(|e| failed("initialize", &e))?;
        if flavor.authenticate_eagerly {
            // The configured method is authoritative: Antigravity accepts methods it does not
            // list. effect-acp names it by the protocol generation of the reply's shape.
            let method = if initialize.get("info").is_some() {
                "auth/login"
            } else {
                "authenticate"
            };
            connection
                .call(
                    method,
                    obj().with(
                        "methodId",
                        self.config.auth_method.clone().unwrap_or_default(),
                    ),
                )
                .await
                .map_err(|e| failed("authenticate", &e))?;
        }
        Ok(initialize)
    }

    /// `configureSession`'s model part: switch the session's model (and Grok's reasoning
    /// effort) when the flavor says so. A rejected effort is dropped and the switch sent
    /// again without it, as T3 does.
    async fn configure(
        &self,
        connection: &Connection,
        model: &str,
        effort: Option<&str>,
    ) -> ProviderResult<()> {
        let key = format!("{model}\u{0}{}", effort.unwrap_or(""));
        if self.config.flavor.model_switch == ModelSwitch::ConfigOption {
            return self.configure_option(connection, model, key).await;
        }
        let (session_id, switch, current) = {
            let state = self.state.lock().await;
            if state.active_model.as_deref() == Some(key.as_str()) {
                return Ok(());
            }
            let switch =
                (self.config.flavor.select_model)(&state.setup, &state.initialize, model, effort);
            let current = state.setup["models"]["currentModelId"]
                .as_str()
                .map(str::to_owned);
            (
                state.session_id.clone().unwrap_or_default(),
                switch,
                current,
            )
        };
        let mut sent = None;
        if let Some((model_id, effort)) = &switch {
            let call = |effort: Option<&String>| {
                let meta = effort.map(|e| obj().with("reasoningEffort", e.clone()));
                connection.call(
                    "session/set_model",
                    obj()
                        .with("sessionId", session_id.clone())
                        .with("modelId", model_id.clone())
                        .with_opt("_meta", meta),
                )
            };
            match call(effort.as_ref()).await {
                Ok(_) => sent = Some(model_id.clone()),
                Err(CallError::Rpc(_)) if effort.is_some() => {
                    // `skipEffort`, then the selection without it.
                    let retry = crate::grok::apply_selection(current.as_deref(), model, None);
                    if let Some((model_id, _)) = retry {
                        let meta: Option<J> = None;
                        connection
                            .call(
                                "session/set_model",
                                obj()
                                    .with("sessionId", session_id.clone())
                                    .with("modelId", model_id.clone())
                                    .with_opt("_meta", meta),
                            )
                            .await
                            .map_err(|e| failed("session/set_model", &e))?;
                        sent = Some(model_id);
                    }
                }
                Err(e) => return Err(failed("session/set_model", &e)),
            }
        }
        let mut state = self.state.lock().await;
        if let Some(model_id) = sent {
            state.setup["models"]["currentModelId"] = json!(model_id);
        }
        state.active_model = Some(key);
        Ok(())
    }

    /// The model through the session's `model` config option (`applyAntigravityAcpModelSelection`,
    /// `runtime.setModel` / `setConfigOption`).
    async fn configure_option(
        &self,
        connection: &Connection,
        model: &str,
        key: String,
    ) -> ProviderResult<()> {
        let (session_id, switch) = {
            let state = self.state.lock().await;
            if state.active_model.as_deref() == Some(key.as_str()) {
                return Ok(());
            }
            (
                state.session_id.clone().unwrap_or_default(),
                crate::antigravity::model_switch(&state.setup, model),
            )
        };
        let switch = switch.map_err(|detail| ProviderError::Failed {
            operation: "session/set_config_option",
            detail,
        })?;
        if let Some((config_id, value)) = switch {
            let reply = connection
                .call(
                    "session/set_config_option",
                    obj()
                        .with("sessionId", session_id)
                        .with("configId", config_id.clone())
                        .with("value", value.clone()),
                )
                .await
                .map_err(|e| failed("session/set_config_option", &e))?;
            let mut state = self.state.lock().await;
            match reply.get("configOptions") {
                Some(options) if options.is_array() => {
                    state.setup["configOptions"] = options.clone();
                }
                _ => crate::antigravity::set_current(&mut state.setup, &config_id, &value),
            }
        }
        self.state.lock().await.active_model = Some(key);
        Ok(())
    }

    /// `session/new` (or load) params: `cwd`, then `mcpServers` (`sessionMcpServers`).
    fn session_setup_params(&self, initialize: &Value, load: Option<&str>) -> J {
        let params = match load {
            Some(session_id) => obj().with("sessionId", session_id),
            None => obj(),
        };
        let setup = self.config.flavor.session_setup;
        let directories = setup
            .filter(|s| s.attachments_directory)
            .and(self.config.attachments_dir.as_ref())
            .map(|dir| J::Arr(vec![J::from(dir.display().to_string())]));
        params
            .with("cwd", self.config.cwd.clone())
            .with_opt("additionalDirectories", directories)
            .with("mcpServers", J::Arr(self.session_mcp_servers(initialize)))
            .with_opt("_meta", setup.and_then(|s| (s.meta)(initialize)))
    }

    /// `sessionMcpServers` over `acpMcpContext`: the HTTP entry when the agent offers HTTP
    /// and the flavor sets `mcpOverHttp`; otherwise the stdio bridge, which every ACP agent
    /// must accept. T3's `acp` entry (MCP over ACP) is not built: an agent that offers `acp`
    /// gets the same as one that does not (no built flavor offers it).
    fn session_mcp_servers(&self, initialize: &Value) -> Vec<J> {
        mcp_entries(
            self.config.flavor,
            &self.config.mcp_servers,
            &self.config.self_command,
            initialize,
        )
    }

    /// `resolvePromptParts`' image blocks: each native image attachment read from the
    /// attachments folder, as `{type: image, data, mimeType}` after the text.
    async fn image_blocks(&self, attachments: &[Value]) -> ProviderResult<Vec<J>> {
        use conn_provider_support::attachments::{is_native_image, saved_path};
        let mut blocks = Vec::new();
        for attachment in attachments.iter().filter(|a| is_native_image(a)) {
            let id = attachment["id"].as_str().unwrap_or("").to_owned();
            let Some(path) = saved_path(self.config.attachments_dir.as_deref(), attachment) else {
                return Err(protocol_error(format!("Invalid attachment id '{id}'")));
            };
            let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
                .await
                .ok()
                .and_then(Result::ok)
                .ok_or_else(|| protocol_error(format!("Failed to read attachment '{id}'")))?;
            blocks.push(
                obj()
                    .with("type", "image")
                    .with("data", conn_support::base64::encode(&bytes))
                    .with(
                        "mimeType",
                        attachment["mimeType"].as_str().unwrap_or("").to_owned(),
                    ),
            );
        }
        Ok(blocks)
    }

    fn has_t3_mcp(&self) -> bool {
        self.config.mcp_servers.iter().any(|s| s.name == "t3-code")
    }

    /// Applies outs: events to the engine, replies to the agent, a flush timer. Runs under
    /// the state lock, so order holds.
    async fn deliver(self: &Arc<Self>, state: &mut State<DynEnv>, outs: Vec<Out>) {
        let mut arm = false;
        let mut arm_subagent = false;
        for out in outs {
            match out {
                Out::ScheduleFlush => arm = true,
                Out::ScheduleSubagentFlush => arm_subagent = true,
                Out::Timer(timer) => self.run_timer(timer),
                other => deliver_one(state, other).await,
            }
        }
        // `None` (replays) holds both flushes, as T3's paused test clock does.
        let Some(interval) = self.config.flush_interval else {
            return;
        };
        if arm_subagent && !state.subagent_flush_armed {
            state.subagent_flush_armed = true;
            let weak = Arc::downgrade(self);
            tokio::spawn(async move {
                tokio::time::sleep(SUBAGENT_FLUSH_INTERVAL).await;
                let Some(inner) = weak.upgrade() else { return };
                let mut state = inner.state.lock().await;
                state.subagent_flush_armed = false;
                for out in state.mapper.flush_subagent_text() {
                    deliver_one(&mut state, out).await;
                }
            });
        }
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

    /// Runs a mapper timer; when it fires, the mapper decides under the state lock.
    fn run_timer(self: &Arc<Self>, timer: mapper::Timer) {
        let delay = match &timer {
            mapper::Timer::Finalize { .. } => self.config.finalize_debounce,
            mapper::Timer::Hydration { .. } => mapper::HYDRATION_WAIT,
            mapper::Timer::InjectedReport { .. } => mapper::INJECTED_REPORT_WAIT,
        };
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let Some(inner) = weak.upgrade() else { return };
            let mut state = inner.state.lock().await;
            let outs = state.mapper.timer_fired(timer);
            Box::pin(inner.deliver(&mut state, outs)).await;
        });
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
        if state.active_prompt.take().is_none() {
            return;
        }
        let delivery = state.delivery.take();
        // Grok cancels locally, refusals discard the prompt, and errors need a retry.
        if let Some(delivery) = delivery
            && matches!(&outcome, PromptOutcome::Stopped(reason) if reason != "cancelled" && reason != "refusal" && reason != "error")
        {
            if let Some(instruction_state) = delivery.instruction_state {
                state.instruction_state = Some(instruction_state);
                state
                    .mapper
                    .clear_compaction_marker(delivery.compaction_marker);
            }
            if let Some(notes) = delivery.notes {
                state.delivered_notes = Some(notes);
            }
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
        Out::ScheduleFlush | Out::ScheduleSubagentFlush | Out::Timer(_) => {}
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
                if method == "fs/read_text_file" && inner.config.flavor.client_file_reads {
                    handle_read_text_file(&inner, generation, id, params).await;
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

/// `clientFileSystem.readTextFile`: a file under the turn's workspace or the attachments
/// folder, read off the runtime thread.
async fn handle_read_text_file(inner: &Arc<Inner>, generation: u64, id: RequestId, params: Value) {
    let (connection, cwd) = {
        let state = inner.state.lock().await;
        if state.generation != generation {
            return;
        }
        let Some(runtime) = &state.runtime else {
            return;
        };
        let cwd = state.policy["cwd"]
            .as_str()
            .map_or_else(|| inner.config.cwd.clone(), str::to_owned);
        (runtime.connection.clone(), cwd)
    };
    use conn_provider::{ProviderHost, ReadTextFile};
    let mut roots = vec![std::path::PathBuf::from(cwd)];
    roots.extend(inner.config.attachments_dir.clone());
    let request = ReadTextFile {
        path: params["path"].as_str().unwrap_or("").into(),
        line: params["line"].as_u64().and_then(|n| u32::try_from(n).ok()),
        limit: params["limit"].as_u64().and_then(|n| u32::try_from(n).ok()),
    };
    let read = conn_provider_support::host_files::RootedFiles::new(roots)
        .read_text_file(request)
        .await;
    match read {
        Ok(content) => {
            connection.reply(&id, obj().with("content", content)).await;
        }
        Err(error) => {
            connection
                .reply_error(&id, error.code(), &error.to_string())
                .await;
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
    if let Some(hooks) = inner.config.flavor.background
        && let Some(life) = (hooks.lifecycle)(method, params)
    {
        let mut state = inner.state.lock().await;
        if state.generation != generation {
            return;
        }
        let outs = state.mapper.apply_background_task_mutation(life);
        inner.deliver(&mut state, outs).await;
        return;
    }
    if inner.config.flavor.background.is_some()
        && let Some((child, status, result)) = xai_subagent_finished(method, params)
    {
        let mut state = inner.state.lock().await;
        if state.generation != generation {
            return;
        }
        let session_id = params["sessionId"].as_str().unwrap_or("");
        let outs = state
            .mapper
            .finish_subagent(session_id, &child, status, result);
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

/// `xAiSubagentFinishedNotice`: Grok's `subagent_finished` session notification (child
/// session, status, result text).
fn xai_subagent_finished(
    method: &str,
    params: &Value,
) -> Option<(String, &'static str, Option<String>)> {
    if !matches!(
        method,
        "x.ai/session_notification" | "_x.ai/session_notification" | "_x.ai/session/update"
    ) {
        return None;
    }
    let update = &params["update"];
    if update["sessionUpdate"] != "subagent_finished" {
        return None;
    }
    let child = update["child_session_id"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_owned();
    let status = match update["status"].as_str()? {
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => return None,
    };
    let text = if status == "completed" {
        &update["output"]
    } else {
        &update["error"]
    };
    let result = text
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    Some((child, status, result))
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

/// `acpMcpContext` + `sessionMcpServers` for each `/mcp` server (see
/// `Inner::session_mcp_servers`).
fn mcp_entries(
    flavor: &Flavor,
    servers: &[McpServer],
    self_command: &str,
    initialize: &Value,
) -> Vec<J> {
    let http = initialize["agentCapabilities"]["mcpCapabilities"]["http"] == true
        || !initialize["capabilities"]["session"]["mcp"]["http"].is_null();
    servers
        .iter()
        .map(|server| {
            let authorization = server
                .headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
            if flavor.mcp_over_http && http {
                return obj()
                    .with("type", "http")
                    .with("name", server.name.clone())
                    .with("url", server.url.clone())
                    .with(
                        "headers",
                        J::Arr(vec![
                            obj()
                                .with("name", "Authorization")
                                .with("value", authorization),
                        ]),
                    );
            }
            let env = |name: &str, value: String| obj().with("name", name).with("value", value);
            obj()
                .with("name", server.name.clone())
                .with("command", self_command.to_owned())
                .with("args", J::Arr(vec![J::from("acp-mcp-bridge")]))
                .with(
                    "env",
                    J::Arr(vec![
                        // T3 sets it so an Electron executable runs as Node; this server's
                        // binary ignores it. Kept so the agent sees T3's environment list.
                        env("ELECTRON_RUN_AS_NODE", "1".into()),
                        env("T3_ACP_MCP_ENDPOINT", server.url.clone()),
                        env("T3_ACP_MCP_AUTHORIZATION", authorization),
                    ]),
                )
        })
        .collect()
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
            let run_id = input.run_id.as_str().to_owned();
            let result = self.start_turn_checked(input).await;
            let mut abandoned = self
                .inner
                .abandoned_run
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if abandoned.as_deref() == Some(run_id.as_str()) {
                *abandoned = None;
            }
            result
        })
    }

    /// Stop ended the run before the agent accepted the turn: the start finishes the step it
    /// is in (an agent restart is not cut short, so no half-started process is left) and
    /// sends nothing more, no prompt, as T3's interrupted `startTurn` sends none.
    fn abandon_turn_start(&self, input: conn_provider::AbandonTurnStartInput) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            *self
                .inner
                .abandoned_run
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some(input.run_id.as_str().to_owned());
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

    fn close(&self) -> BoxFuture<'_, Closed> {
        Box::pin(async move {
            let inner = &self.inner;
            let (connection, session_id, can_close, stop) = {
                let mut state = inner.state.lock().await;
                if state.closed {
                    return Closed::RuntimeStopped;
                }
                state.closed = true;
                state.mapper.close_background();
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
            // One agent process per session.
            Closed::RuntimeStopped
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

#[cfg(test)]
mod mcp_tests {
    use serde_json::json;

    /// The `t3-code` entry as `acpMcpContext` builds it for a flavor without `mcpOverHttp`:
    /// the stdio bridge, also for an agent that offers neither `http` nor `acp`.
    #[test]
    fn grok_gets_t3s_stdio_bridge() {
        let server = conn_provider::McpServer {
            device_tools: false,
            name: "t3-code".into(),
            url: "http://127.0.0.1:1/mcp".into(),
            headers: vec![("Authorization".into(), "Bearer t".into())],
        };
        for initialize in [
            json!({"agentCapabilities": {"mcpCapabilities": {"http": true, "sse": true}}}),
            json!({"agentCapabilities": {}}),
        ] {
            let entries = super::mcp_entries(
                &crate::flavor::GROK,
                std::slice::from_ref(&server),
                "/bin/conn-server",
                &initialize,
            );
            let entry: serde_json::Value = serde_json::from_str(&entries[0].to_line()).unwrap();
            assert_eq!(
                entry,
                json!({"name": "t3-code", "command": "/bin/conn-server", "args": ["acp-mcp-bridge"], "env": [
                    {"name": "ELECTRON_RUN_AS_NODE", "value": "1"},
                    {"name": "T3_ACP_MCP_ENDPOINT", "value": "http://127.0.0.1:1/mcp"},
                    {"name": "T3_ACP_MCP_AUTHORIZATION", "value": "Bearer t"}
                ]})
            );
        }
    }
}
