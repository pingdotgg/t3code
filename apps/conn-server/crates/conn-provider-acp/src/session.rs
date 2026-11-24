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
use crate::protocol::{RequestId, RpcError};

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

impl Spawned {
    /// Stops an agent that has no reader: its input and output go first, so a full event
    /// channel cannot hold up the exit report the stop waits for.
    fn stop_unread(self, kind: StopKind) -> BoxFuture<'static, ()> {
        let Self {
            writer,
            events,
            stop,
        } = self;
        drop((writer, events));
        stop(kind)
    }
}

/// How a runtime ends (T3 `AcpSessionRuntime`, owned detached process group).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopKind {
    /// The scope finalizer: SIGKILL to the process group, no end of input first.
    Kill,
    /// `terminateProcessGroup`: SIGTERM to the group, 1 s grace, then SIGKILL.
    Terminate,
    /// The agent exited and was reaped: only its files go. Its PID and group are no longer
    /// ours to signal.
    Exited,
}

/// What [`AcpSession::open_with`] adds to a plain open.
#[derive(Default)]
pub(crate) struct OpenControl {
    /// Ends the open early; the agent is stopped before `open_with` returns.
    pub abort: Option<BoxFuture<'static, ()>>,
    /// Told when the agent has answered `initialize`, and when the session is open.
    pub on_step: Option<Box<dyn Fn(conn_provider::CheckStep) + Send + Sync>>,
    /// Kept up to date with what became of `session/new`, also when the open fails.
    pub session_new: Option<Arc<std::sync::Mutex<SessionNew>>>,
}

/// What became of an open's `session/new`: whether the agent may have stored a session, and
/// its id once the agent named it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum SessionNew {
    #[default]
    NotSent,
    /// Sent; no reply named the session.
    Sent,
    Created(String),
}

/// Starts the agent for this session (the real process, or a replay agent in tests). It may
/// block (folders, `fork`/`exec`): the session runs it on a blocking thread.
pub(crate) type Spawner = Arc<dyn Fn() -> Result<Spawned, SpawnError> + Send + Sync>;

/// Why a [`Spawner`] started no agent.
#[derive(Debug)]
pub(crate) enum SpawnError {
    /// A step the server owns before the spawn failed: T3's `ProviderSetupError`, whose text
    /// the user sees.
    Setup(&'static str),
    /// The process did not start (T3's spawn error, shown as a fixed text).
    Io(std::io::Error),
}

impl From<std::io::Error> for SpawnError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

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
    /// The catalog's default model, used when the selection asks for the default
    /// (`applyAntigravityAcpModelSelection`'s `defaultModel`).
    pub default_model: Option<String>,
    /// Told about the session's config options and commands as the agent reports them.
    pub observer: Option<Observer>,
}

/// What the agent reported about the session's catalog (T3's `ConfigOptionsUpdated` and
/// `AvailableCommandsUpdated` events).
#[derive(Debug)]
pub(crate) enum CatalogUpdate<'a> {
    ConfigOptions(&'a Value),
    AvailableCommands(&'a Value),
}

/// Receives [`CatalogUpdate`]s, in the order the agent sent them.
pub(crate) type Observer = Arc<dyn Fn(CatalogUpdate<'_>) + Send + Sync>;

fn notify_observer(observer: &Observer, update: &HeldUpdate) {
    observer(match update {
        HeldUpdate::ConfigOptions(options) => CatalogUpdate::ConfigOptions(options),
        HeldUpdate::AvailableCommands(commands) => CatalogUpdate::AvailableCommands(commands),
    });
}

struct Runtime {
    connection: Connection,
    stopper: Arc<Stopper>,
    generation: u64,
}

type StopFn = Box<dyn FnOnce(StopKind) -> BoxFuture<'static, ()> + Send>;

/// Ends one agent and removes its files, once, whoever comes first: an explicit stop, or the
/// drive task when the agent exited on its own. A later caller waits until the first is done,
/// as T3's scope finalizer runs once whatever ended the scope.
struct Stopper {
    stop: std::sync::Mutex<Option<StopFn>>,
    done: tokio::sync::OnceCell<()>,
}

impl Stopper {
    fn new(stop: StopFn) -> Arc<Self> {
        Arc::new(Self {
            stop: std::sync::Mutex::new(Some(stop)),
            done: tokio::sync::OnceCell::new(),
        })
    }

    async fn stop(&self, kind: StopKind) {
        self.done
            .get_or_init(|| async {
                let stop = self
                    .stop
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                if let Some(stop) = stop {
                    stop(kind).await;
                }
            })
            .await;
    }
}

struct State<E: Env> {
    mapper: Mapper<E>,
    events: Option<mpsc::Sender<ProviderEvent>>,
    runtime: Option<Runtime>,
    /// The latest agent's [`Stopper`]; it stays after the drive task took `runtime`.
    stopper: Option<Arc<Stopper>>,
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
    /// Requests whose reply the driver hands over in order with the agent's updates
    /// ([`AcpSession::set_config_option_in_order`]); one per caller in flight.
    ordered_calls: Vec<(i64, OrderedReply)>,
    /// `config_option_update`s seen: a write's reply older than one of them stays out.
    config_updates: u64,
    /// T3's `startupMetadata`: metadata updates that arrived before the root session was
    /// known, the latest per session and kind; the root's are applied once it is.
    startup_updates: Vec<Value>,
    /// Catalog updates for the observer, held until the driver publishes the session
    /// ([`AcpSession::release_catalog_updates`]), the latest per kind in arrival order.
    /// `None` once released.
    held_updates: Option<Vec<HeldUpdate>>,
}

/// A [`CatalogUpdate`] kept for later.
#[derive(Debug)]
enum HeldUpdate {
    ConfigOptions(Value),
    AvailableCommands(Value),
}

/// `maxStartupMetadataUpdates`.
const MAX_STARTUP_UPDATES: usize = 32;

/// `isStartupMetadataUpdate`.
fn is_startup_metadata(params: &Value) -> bool {
    matches!(
        params["update"]["sessionUpdate"].as_str(),
        Some("current_mode_update" | "config_option_update" | "available_commands_update")
    )
}

type OrderedReply = tokio::sync::oneshot::Sender<Result<Value, CallError>>;

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
    /// The spawn in flight. A start cancelled meanwhile leaves it here, and the stop that
    /// follows claims and stops what it started (`stop_cancelled_spawn`).
    spawning: Mutex<Option<tokio::task::JoinHandle<Result<Spawned, SpawnError>>>>,
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

/// Why [`AcpSession::open_with`] opened no session. The agent is stopped in every case.
#[derive(Debug)]
pub(crate) enum OpenError {
    /// [`OpenControl::abort`] fired.
    Aborted,
    /// The agent answered `method` with a JSON-RPC error (T3's `AcpRequestError`), with
    /// what the flavor recognised in it (`Flavor::rpc_failure`).
    Rpc {
        method: &'static str,
        error: RpcError,
        recognised: Option<ProviderError>,
    },
    Other(ProviderError),
}

impl From<ProviderError> for OpenError {
    fn from(error: ProviderError) -> Self {
        Self::Other(error)
    }
}

impl From<OpenError> for ProviderError {
    fn from(error: OpenError) -> Self {
        match error {
            OpenError::Aborted => Self::Failed {
                operation: "start",
                detail: "The agent start was stopped.".into(),
            },
            OpenError::Rpc {
                method,
                error,
                recognised,
            } => recognised.unwrap_or_else(|| plain_failed(method, &CallError::Rpc(error))),
            OpenError::Other(error) => error,
        }
    }
}

fn call_failed(flavor: &Flavor, method: &'static str, error: CallError) -> OpenError {
    match error {
        CallError::Rpc(error) => OpenError::Rpc {
            method,
            recognised: (flavor.rpc_failure)(&error),
            error,
        },
        error => OpenError::Other(failed(flavor, method, &error)),
    }
}

fn failed(flavor: &Flavor, operation: &'static str, error: &CallError) -> ProviderError {
    if let CallError::Provider(error) = error {
        return error.clone();
    }
    if let CallError::Rpc(rpc) = error
        && let Some(recognised) = (flavor.rpc_failure)(rpc)
    {
        return recognised;
    }
    plain_failed(operation, error)
}

fn plain_failed(operation: &'static str, error: &CallError) -> ProviderError {
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
            let initialize = match inner.initialize(&connection).await {
                Ok(initialize) => initialize,
                Err(error) => {
                    inner.end_runtime().await;
                    return Err(error);
                }
            };
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
            let setup = match connection
                .call(
                    method,
                    inner.session_setup_params(&initialize, Some(&session_id)),
                )
                .await
            {
                Ok(setup) => setup,
                Err(error) => {
                    inner.end_runtime().await;
                    return Err(failed(inner.config.flavor, method, &error));
                }
            };
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
            let selection = to_json(&input.model_selection);
            let effort = crate::grok::selection_effort(&selection);
            let options = selection["options"].as_array().cloned().unwrap_or_default();
            inner
                .configure(&connection, &model, effort.as_deref(), &options)
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
        Self::open_with(config, spawner, env, events, OpenControl::default())
            .await
            .map_err(ProviderError::from)
    }

    /// [`Self::open`] with an abort and step reports. On any failure the agent is stopped
    /// and its files are removed before this returns, as T3's scoped runtime does.
    pub(crate) async fn open_with(
        config: Config,
        spawner: Spawner,
        env: Box<dyn Env + Sync>,
        events: mpsc::Sender<ProviderEvent>,
        control: OpenControl,
    ) -> Result<(Self, Value), OpenError> {
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
                stopper: None,
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
                ordered_calls: Vec::new(),
                config_updates: 0,
                startup_updates: Vec::new(),
                held_updates: Some(Vec::new()),
            }),
            config,
            abandoned_run: std::sync::Mutex::new(None),
            spawning: Mutex::new(None),
        });
        let OpenControl {
            abort,
            on_step,
            session_new,
        } = control;
        let steps = Self::open_steps(&inner, on_step.as_deref(), session_new.as_deref());
        let outcome = match abort {
            Some(abort) => tokio::select! {
                outcome = steps => outcome,
                () = abort => Err(OpenError::Aborted),
            },
            None => steps.await,
        };
        match outcome {
            Ok(session_id) => {
                let session = Self {
                    id: inner.config.provider_session_id.as_str().into(),
                    inner,
                };
                Ok((session, json!({"sessionId": session_id})))
            }
            Err(error) => {
                inner.stop_runtime().await;
                Err(error)
            }
        }
    }

    async fn open_steps(
        inner: &Arc<Inner>,
        on_step: Option<&(dyn Fn(conn_provider::CheckStep) + Send + Sync)>,
        session_new: Option<&std::sync::Mutex<SessionNew>>,
    ) -> Result<String, OpenError> {
        let step = |step: conn_provider::CheckStep| {
            if let Some(on_step) = on_step {
                on_step(step);
            }
        };
        let connection = inner.start_runtime().await?;
        inner.start_session(&connection, &step, session_new).await
    }

    /// The agent's `initialize` result and the session setup result, as last seen.
    pub(crate) async fn handshake(&self) -> (Value, Value) {
        let state = self.inner.state.lock().await;
        (state.initialize.clone(), state.setup.clone())
    }

    /// `setConfigOption`, then `drainEvents`: sets a session config option and waits until
    /// the driver has applied every update the agent sent before its reply. Returns the
    /// session's config options after it.
    pub(crate) async fn set_config_option_in_order(
        &self,
        config_id: &str,
        value: &str,
    ) -> ProviderResult<Value> {
        let (reply_tx, reply) = tokio::sync::oneshot::channel();
        let before = {
            // Held across the send, so the driver sees the waiter before the reply.
            let mut state = self.inner.state.lock().await;
            let Some(runtime) = &state.runtime else {
                return Err(ProviderError::SessionStopped);
            };
            let connection = runtime.connection.clone();
            let params = obj()
                .with("sessionId", state.session_id.clone().unwrap_or_default())
                .with("configId", config_id)
                .with("value", value);
            let Some(id) = connection.send("session/set_config_option", params).await else {
                return Err(ProviderError::SessionStopped);
            };
            state.ordered_calls.push((id, reply_tx));
            state.config_updates
        };
        let reply = reply
            .await
            .map_err(|_| ProviderError::SessionStopped)?
            .map_err(|e| failed(self.inner.config.flavor, "session/set_config_option", &e))?;
        let mut state = self.inner.state.lock().await;
        self.inner
            .apply_config_reply(&mut state, before, config_id, value, &reply);
        Ok(state.setup["configOptions"].clone())
    }

    /// The driver published the session (T3's `onSessionStarted`): the catalog updates held
    /// since the start reach the observer now, in order, and later ones as they come.
    pub(crate) async fn release_catalog_updates(&self) {
        let mut state = self.inner.state.lock().await;
        let held = state.held_updates.take().unwrap_or_default();
        if let Some(observer) = &self.inner.config.observer {
            for update in &held {
                notify_observer(observer, update);
            }
        }
    }

    /// `drainEvents`: waits until the driver has handled everything the agent sent so far.
    pub(crate) async fn drain(&self) {
        let connection = {
            let state = self.inner.state.lock().await;
            state.runtime.as_ref().map(|r| r.connection.clone())
        };
        if let Some(connection) = connection {
            connection.barrier().await;
        }
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
    /// Spawns the agent and the task that reads it. The spawn slot stays locked until the
    /// agent is installed or stopped, so a close waits for either ([`Self::stop_cancelled_spawn`]).
    async fn start_runtime(self: &Arc<Self>) -> ProviderResult<Connection> {
        let mut spawning = self.spawning.lock().await;
        let spawner = self.spawner.clone();
        let task = spawning.insert(tokio::task::spawn_blocking(move || spawner()));
        let joined = task.await;
        *spawning = None;
        let spawned =
            joined.unwrap_or_else(|error| Err(SpawnError::Io(std::io::Error::other(error))));
        let spawned = spawned.map_err(|error| match error {
            SpawnError::Setup(detail) => ProviderError::Failed {
                operation: "start",
                detail: detail.to_owned(),
            },
            SpawnError::Io(error) => ProviderError::Failed {
                operation: "spawn",
                detail: format!("could not start {}: {error}", self.config.flavor.driver),
            },
        })?;
        let (connection, incoming, generation) = {
            let mut state = self.state.lock().await;
            if state.closed {
                drop(state);
                spawned.stop_unread(StopKind::Kill).await;
                return Err(ProviderError::SessionStopped);
            }
            let Spawned {
                writer,
                events,
                stop,
            } = spawned;
            let (connection, incoming) = Connection::start_with_signal(
                writer,
                events,
                EVENT_CAPACITY,
                self.config.flavor.stdout_signal,
            );
            state.generation += 1;
            state.prompt_seq = 0;
            state.instruction_state = None;
            state.delivered_notes = None;
            state.delivery = None;
            state.mapper.reset_compaction();
            let stopper = Stopper::new(stop);
            state.stopper = Some(stopper.clone());
            state.runtime = Some(Runtime {
                connection: connection.clone(),
                stopper,
                generation: state.generation,
            });
            (connection, incoming, state.generation)
        };
        drop(spawning);
        tokio::spawn(drive(Arc::downgrade(self), incoming, generation));
        Ok(connection)
    }

    /// `initialize`, `session/new` and the model (T3's `start`): returns the root session id.
    /// Startup metadata the agent sent for that session before its reply is applied then.
    /// `step` hears T3's check steps; `session_new` follows what became of `session/new`.
    async fn start_session(
        self: &Arc<Self>,
        connection: &Connection,
        step: &(dyn Fn(conn_provider::CheckStep) + Sync),
        session_new: Option<&std::sync::Mutex<SessionNew>>,
    ) -> Result<String, OpenError> {
        let record = |state: SessionNew| {
            if let Some(slot) = session_new {
                *crate::lock(slot) = state;
            }
        };
        let initialize = self.send_initialize(connection).await?;
        step(conn_provider::CheckStep::Initialized);
        self.authenticate(connection, &initialize).await?;
        record(SessionNew::Sent);
        let setup = connection
            .call("session/new", self.session_setup_params(&initialize, None))
            .await
            .map_err(|e| call_failed(self.config.flavor, "session/new", e))?;
        let session_id = setup["sessionId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| protocol_error("session/new returned no session id"))?
            .to_owned();
        record(SessionNew::Created(session_id.clone()));
        {
            let mut state = self.state.lock().await;
            state.session_id = Some(session_id.clone());
            state.mapper.set_root_session(&session_id);
            state.initialize = initialize;
            state.setup = setup;
            let buffered = std::mem::take(&mut state.startup_updates);
            for params in buffered
                .iter()
                .filter(|p| p["sessionId"] == session_id.as_str())
            {
                self.root_update(&mut state, params).await;
            }
        }
        step(conn_provider::CheckStep::Verifying);
        let model = self.config.model.clone();
        let effort = self.config.effort.clone();
        self.configure(connection, &model, effort.as_deref(), &[])
            .await?;
        // T3's start commits only when no termination was recorded (Antigravity's sign-in
        // URL right behind the last reply).
        if let Some(failure) = connection.failure() {
            return Err(failure.into());
        }
        Ok(session_id)
    }

    /// Ends the current runtime as a close does, and keeps the session: a failed restart
    /// leaves no agent, no `run-*` folder and (on Linux) no process tree behind. The driver
    /// ignores its exit; when it is ending the agent already, this waits for it.
    async fn end_runtime(&self) {
        let stopper = {
            let mut state = self.state.lock().await;
            state.generation += 1;
            state.runtime = None;
            state.stopper.clone()
        };
        if let Some(stopper) = stopper {
            stopper.stop(StopKind::Kill).await;
        }
    }

    /// One `session/update` of the root session: its config options and commands, then the
    /// mapper.
    async fn root_update(self: &Arc<Self>, state: &mut State<DynEnv>, params: &Value) {
        // `ConfigOptionsUpdated` and `AvailableCommandsUpdated`: the session's options follow
        // the agent, and the observer hears both.
        let update = &params["update"];
        if update["sessionUpdate"] == "config_option_update"
            && let Some(options) = update.get("configOptions").filter(|o| o.is_array())
        {
            state.setup["configOptions"] = options.clone();
            state.config_updates += 1;
            self.observe(state, HeldUpdate::ConfigOptions(options.clone()));
        }
        if update["sessionUpdate"] == "available_commands_update"
            && let Some(commands) = update.get("availableCommands").filter(|c| c.is_array())
        {
            self.observe(state, HeldUpdate::AvailableCommands(commands.clone()));
        }
        let outs = state.mapper.session_update(params);
        self.deliver(state, outs).await;
    }

    /// `initialize`, as `AcpSessionRuntime.initializeOnce` and effect-acp's negotiating
    /// request send it: the v2 fields, then the v1 ones.
    async fn initialize(&self, connection: &Connection) -> ProviderResult<Value> {
        let initialize = self.send_initialize(connection).await?;
        self.authenticate(connection, &initialize).await?;
        Ok(initialize)
    }

    /// The `initialize` request alone (T3's `runtime.initialize()`).
    async fn send_initialize(&self, connection: &Connection) -> Result<Value, OpenError> {
        let flavor = self.config.flavor;
        let (name, version) = match flavor.client_info {
            Some(info) => info(self.config.runtime_version.as_deref()),
            None => ("t3-code".to_owned(), self.config.client_version.clone()),
        };
        let params = initialize_params(flavor, &name, &version, true);
        connection
            .call("initialize", params)
            .await
            .map_err(|e| call_failed(flavor, "initialize", e))
    }

    /// The eager `authenticate` that T3's `start` sends first, for a flavor that wants it.
    async fn authenticate(
        &self,
        connection: &Connection,
        initialize: &Value,
    ) -> Result<(), OpenError> {
        if !self.config.flavor.authenticate_eagerly {
            return Ok(());
        }
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
            .map(drop)
            .map_err(|e| call_failed(self.config.flavor, "authenticate", e))
    }

    /// Ends the agent of a session that did not open, and waits until it is gone and its
    /// files are removed, also when it exited first and the drive task is ending it.
    async fn stop_runtime(&self) {
        {
            let mut state = self.state.lock().await;
            state.closed = true;
            state.events = None;
        }
        self.stop_cancelled_spawn().await;
        self.end_runtime().await;
    }

    /// Waits until a start in flight has installed or stopped its agent, and stops the agent
    /// of a start that was cancelled while its spawn ran.
    async fn stop_cancelled_spawn(&self) {
        let task = self.spawning.lock().await.take();
        if let Some(task) = task
            && let Ok(Ok(spawned)) = task.await
        {
            spawned.stop_unread(StopKind::Kill).await;
        }
    }

    /// `configureSession`'s model part: switch the session's model (and Grok's reasoning
    /// effort) when the flavor says so. A rejected effort is dropped and the switch sent
    /// again without it, as T3 does. A config-option flavor then applies the chosen
    /// thinking level from `options` (the selection's).
    async fn configure(
        &self,
        connection: &Connection,
        model: &str,
        effort: Option<&str>,
        options: &[Value],
    ) -> ProviderResult<()> {
        let key = format!("{model}\u{0}{}", effort.unwrap_or(""));
        if self.config.flavor.model_switch == ModelSwitch::ConfigOption {
            self.configure_option(connection, model, key).await?;
            return self.configure_thinking(connection, options).await;
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
                            .map_err(|e| failed(self.config.flavor, "session/set_model", &e))?;
                        sent = Some(model_id);
                    }
                }
                Err(e) => return Err(failed(self.config.flavor, "session/set_model", &e)),
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
        let (session_id, switch, before) = {
            let state = self.state.lock().await;
            if state.active_model.as_deref() == Some(key.as_str()) {
                return Ok(());
            }
            (
                state.session_id.clone().unwrap_or_default(),
                crate::antigravity::model_switch(
                    &state.setup,
                    model,
                    self.config.default_model.as_deref(),
                ),
                state.config_updates,
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
                .map_err(|e| failed(self.config.flavor, "session/set_config_option", &e))?;
            let mut state = self.state.lock().await;
            self.apply_config_reply(&mut state, before, &config_id, &value, &reply);
        }
        self.state.lock().await.active_model = Some(key);
        Ok(())
    }

    /// The chosen thinking level, after the model: T3 writes each chosen option the live
    /// session offers, and skips a value the agent rejects as invalid (`-32602`).
    async fn configure_thinking(
        &self,
        connection: &Connection,
        options: &[Value],
    ) -> ProviderResult<()> {
        let (session_id, write, before) = {
            let state = self.state.lock().await;
            (
                state.session_id.clone().unwrap_or_default(),
                crate::antigravity::thinking_write(&state.setup["configOptions"], options),
                state.config_updates,
            )
        };
        let Some((config_id, value)) = write else {
            return Ok(());
        };
        let params = obj()
            .with("sessionId", session_id)
            .with("configId", config_id.clone())
            .with("value", value.clone());
        match connection.call("session/set_config_option", params).await {
            Ok(reply) => {
                let mut state = self.state.lock().await;
                self.apply_config_reply(&mut state, before, &config_id, &value, &reply);
                Ok(())
            }
            Err(CallError::Rpc(error)) if error.code == -32602 => Ok(()),
            Err(e) => Err(failed(self.config.flavor, "session/set_config_option", &e)),
        }
    }

    /// A `session/set_config_option` reply: its options, or the value written, unless the
    /// agent pushed an update while the write was in flight; that update is newer (T3's
    /// `configOptionUpdates` check). The observer hears the options it applied.
    fn apply_config_reply(
        &self,
        state: &mut State<DynEnv>,
        before: u64,
        config_id: &str,
        value: &str,
        reply: &Value,
    ) {
        if state.config_updates != before {
            return;
        }
        match reply.get("configOptions") {
            Some(options) if options.is_array() => {
                state.setup["configOptions"] = options.clone();
            }
            _ => crate::antigravity::set_current(&mut state.setup, config_id, value),
        }
        let options = state.setup["configOptions"].clone();
        self.observe(state, HeldUpdate::ConfigOptions(options));
    }

    /// Tells the observer about `update`, or holds it until the session is published.
    fn observe(&self, state: &mut State<DynEnv>, update: HeldUpdate) {
        let Some(observer) = &self.config.observer else {
            return;
        };
        match &mut state.held_updates {
            Some(held) => {
                held.retain(|h| std::mem::discriminant(h) != std::mem::discriminant(&update));
                held.push(update);
            }
            None => notify_observer(observer, &update),
        }
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
        self.config.mcp_servers.iter().any(|s| s.name == "conn")
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
            Incoming::Barrier(done) => {
                let _ = done.send(());
            }
            Incoming::Reply { id, result } => {
                let waiter = {
                    let mut state = inner.state.lock().await;
                    let at = state.ordered_calls.iter().position(|(call, _)| *call == id);
                    at.map(|at| state.ordered_calls.swap_remove(at).1)
                };
                if let Some(waiter) = waiter {
                    let _ = waiter.send(result);
                    continue;
                }
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
                    Err(CallError::Closed | CallError::Provider(_)) => continue,
                };
                inner.settle(generation, None, outcome).await;
            }
            Incoming::Closed { exit, failure } => {
                let kind = if exit.is_some() {
                    StopKind::Exited
                } else {
                    StopKind::Kill
                };
                let stopper = {
                    let mut state = inner.state.lock().await;
                    if state.generation != generation {
                        return;
                    }
                    let stopper = state.runtime.take().map(|runtime| runtime.stopper);
                    state.active_prompt = None;
                    state.ordered_calls.clear();
                    state.restart_required = true;
                    let detail = match (failure, exit) {
                        (Some(ProviderError::Failed { detail, .. }), _) => detail,
                        (Some(failure), _) => failure.to_string(),
                        (None, Some(exit)) => format!("the agent exited ({})", exit.describe()),
                        (None, None) => "the agent closed its output".to_owned(),
                    };
                    let outs = state.mapper.agent_exited(&detail);
                    inner.deliver(&mut state, outs).await;
                    stopper
                };
                // The agent's own folder goes; the process tree too while it still runs.
                if let Some(stopper) = stopper {
                    stopper.stop(kind).await;
                }
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
        let Some(root) = state.session_id.clone() else {
            // Starting: keep the latest metadata per session and kind until the root is known.
            if is_startup_metadata(params) {
                let kind = &params["update"]["sessionUpdate"];
                state.startup_updates.retain(|p| {
                    p["sessionId"] != params["sessionId"] || p["update"]["sessionUpdate"] != *kind
                });
                state.startup_updates.push(params.clone());
                if state.startup_updates.len() > MAX_STARTUP_UPDATES {
                    state.startup_updates.remove(0);
                }
            }
            return;
        };
        if params["sessionId"] != root.as_str() {
            // One runtime projects one root session. Only a flavor with subagents routes a
            // child session's updates, through its mapper, never into the root's metadata.
            if inner.config.flavor.background.is_some() {
                let outs = state.mapper.session_update(params);
                inner.deliver(&mut state, outs).await;
            }
            return;
        }
        inner.root_update(&mut state, params).await;
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
                    let stopper = state.runtime.take().map(|r| r.stopper);
                    drop(state);
                    if let Some(stopper) = stopper {
                        stopper.stop(StopKind::Terminate).await;
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
                    Some(runtime) => (Some(runtime.connection.clone()), Some(runtime.stopper)),
                    None => (None, state.stopper.clone()),
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
            inner.stop_cancelled_spawn().await;
            if let Some(stop) = stop {
                stop.stop(StopKind::Kill).await;
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
mod spawn_tests {
    use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

    use super::*;

    fn config() -> Config {
        Config {
            flush_interval: None,
            finalize_debounce: FINALIZE_DEBOUNCE,
            flavor: &crate::flavor::GROK,
            instance_id: "grok".into(),
            provider_session_id: "s".into(),
            cwd: "/tmp".into(),
            runtime_mode: "full-access".into(),
            policy: json!({}),
            effort: None,
            model: String::new(),
            mcp_servers: Vec::new(),
            client_version: "0.0.0".into(),
            attachments_dir: None,
            auth_method: None,
            runtime_version: None,
            self_command: "/conn-server".into(),
            default_model: None,
            observer: None,
        }
    }

    /// The spawner may block (folders, `fork` and `exec`): it runs off the runtime thread.
    #[tokio::test(flavor = "current_thread")]
    async fn the_spawner_runs_off_the_runtime_thread() {
        let runtime_thread = std::thread::current().id();
        let seen = Arc::new(std::sync::Mutex::new(None));
        let record = seen.clone();
        let spawner: Spawner = Arc::new(move || {
            *crate::lock(&record) = Some(std::thread::current().id());
            Err(SpawnError::Setup("no agent"))
        });
        let (tx, _events) = mpsc::channel(8);
        let opened =
            AcpSession::open_with(config(), spawner, system_env(), tx, OpenControl::default())
                .await;
        assert!(opened.is_err());
        let spawned_on = *crate::lock(&seen);
        assert!(spawned_on.is_some(), "the spawner did not run");
        assert_ne!(spawned_on, Some(runtime_thread));
    }

    /// An open aborted while its spawn runs still owns what the spawn starts: it returns
    /// only after that agent is stopped.
    #[tokio::test(flavor = "current_thread")]
    async fn a_spawn_aborted_meanwhile_is_stopped_before_the_open_returns() {
        let (abort_tx, abort_rx) = tokio::sync::oneshot::channel::<()>();
        let abort_tx = std::sync::Mutex::new(Some(abort_tx));
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = std::sync::Mutex::new(release_rx);
        let stopped = Arc::new(AtomicBool::new(false));
        let released = Arc::new(AtomicBool::new(false));
        let (stop_flag, release_flag) = (stopped.clone(), released.clone());
        let spawner: Spawner = Arc::new(move || {
            if let Some(abort) = crate::lock(&abort_tx).take() {
                let _ = abort.send(());
            }
            // Only the abort releases the spawn; on the runtime thread it never could.
            let release = crate::lock(&release_rx).recv_timeout(Duration::from_secs(5));
            release_flag.store(release.is_ok(), SeqCst);
            let (writer, _) = mpsc::channel(1);
            let (_, events) = mpsc::channel(1);
            let stop_flag = stop_flag.clone();
            Ok(Spawned {
                writer,
                events,
                stop: Box::new(move |_| Box::pin(async move { stop_flag.store(true, SeqCst) })),
            })
        });
        let control = OpenControl {
            abort: Some(Box::pin(async move {
                let _ = abort_rx.await;
                let _ = release_tx.send(());
            })),
            ..OpenControl::default()
        };
        let (tx, _events) = mpsc::channel(8);
        let opened = AcpSession::open_with(config(), spawner, system_env(), tx, control).await;
        assert!(matches!(opened, Err(OpenError::Aborted)));
        assert!(
            released.load(SeqCst),
            "the abort did not run during the spawn"
        );
        assert!(stopped.load(SeqCst), "the spawned agent was not stopped");
    }

    /// An agent whose startup output filled the event channel still stops when its open is
    /// aborted: nothing reads that channel, so the stop must not wait on it.
    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn an_aborted_spawn_with_a_full_event_channel_still_stops() {
        use conn_provider_support::process::{LaunchSpec, Process, wait_gone};
        let (abort_tx, abort_rx) = tokio::sync::oneshot::channel::<()>();
        let abort_tx = std::sync::Mutex::new(Some(abort_tx));
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = std::sync::Mutex::new(release_rx);
        let pid = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let spawned_pid = pid.clone();
        let spawner: Spawner = Arc::new(move || {
            let lines = EVENT_CAPACITY + 64;
            let spec = LaunchSpec {
                program: "sh".into(),
                args: vec![
                    "-c".into(),
                    format!(
                        "i=0; while [ $i -lt {lines} ]; do echo '{{}}'; i=$((i+1)); done; exec sleep 30"
                    ),
                ],
                ..LaunchSpec::default()
            };
            let (events_tx, events) = mpsc::channel(EVENT_CAPACITY);
            let process = Process::spawn(&spec, 1024, events_tx)?;
            spawned_pid.store(process.pid, SeqCst);
            // The output fills all the slots before the abort.
            std::thread::sleep(Duration::from_millis(300));
            if let Some(abort) = crate::lock(&abort_tx).take() {
                let _ = abort.send(());
            }
            // Only the abort releases the spawn, so the open is aborted while it runs.
            let _ = crate::lock(&release_rx).recv_timeout(Duration::from_secs(5));
            let writer = process.writer();
            Ok(Spawned {
                writer,
                events,
                stop: Box::new(move |kind| Box::pin(crate::stop_process(process, kind))),
            })
        });
        let control = OpenControl {
            abort: Some(Box::pin(async move {
                let _ = abort_rx.await;
                let _ = release_tx.send(());
            })),
            ..OpenControl::default()
        };
        let (tx, _events) = mpsc::channel(8);
        let opened = tokio::time::timeout(
            Duration::from_secs(10),
            AcpSession::open_with(config(), spawner, system_env(), tx, control),
        )
        .await;
        assert!(
            matches!(opened, Ok(Err(OpenError::Aborted))),
            "the stop did not complete"
        );
        let pid = pid.load(SeqCst);
        assert!(pid > 0 && wait_gone(pid, Duration::from_secs(5)).await);
    }

    /// `close` during a restart's spawn returns only after the new agent is stopped.
    #[tokio::test(flavor = "current_thread")]
    async fn close_waits_for_a_restart_spawn_in_flight() {
        let script = crate::replay_agent::Script::new(
            vec![
                json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "initialize", "params": "<any>"}}),
                json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "initialize",
                    "result": {"protocolVersion": 1, "agentCapabilities": {}}}}),
                json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "session/new", "params": "<any>"}}),
                json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "session/new",
                    "result": {"sessionId": "s1"}}}),
            ],
            "/tmp",
        );
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let started_tx = std::sync::Mutex::new(Some(started_tx));
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = std::sync::Mutex::new(release_rx);
        let stopped = Arc::new(AtomicBool::new(false));
        let stop_flag = stopped.clone();
        let starts = std::sync::atomic::AtomicUsize::new(0);
        let spawner: Spawner = Arc::new(move || {
            if starts.fetch_add(1, SeqCst) == 0 {
                // The first start: the agent that opens the session.
                let (writer, events) = crate::replay_agent::spawn(script.clone());
                return Ok(Spawned {
                    writer,
                    events,
                    stop: Box::new(|_| Box::pin(async {})),
                });
            }
            if let Some(started) = crate::lock(&started_tx).take() {
                let _ = started.send(());
            }
            let _ = crate::lock(&release_rx).recv_timeout(Duration::from_secs(5));
            let (writer, _) = mpsc::channel(1);
            let (_, events) = mpsc::channel(1);
            let stop_flag = stop_flag.clone();
            Ok(Spawned {
                writer,
                events,
                stop: Box::new(move |_| {
                    Box::pin(async move {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        stop_flag.store(true, SeqCst);
                    })
                }),
            })
        });
        let (tx, _events) = mpsc::channel(64);
        let (session, _) =
            AcpSession::open_with(config(), spawner, system_env(), tx, OpenControl::default())
                .await
                .unwrap();
        let inner = session.inner.clone();
        inner.state.lock().await.restart_required = true;
        let restart = tokio::spawn(async move { inner.start_runtime().await.map(drop) });
        started_rx.await.unwrap();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = release_tx.send(());
        });
        session.close().await;
        assert!(
            stopped.load(SeqCst),
            "close returned before the restarted agent stopped"
        );
        assert!(matches!(
            restart.await.unwrap(),
            Err(ProviderError::SessionStopped)
        ));
    }
}

#[cfg(test)]
mod mcp_tests {
    use serde_json::json;

    /// The `conn` entry as `acpMcpContext` builds it for a flavor without `mcpOverHttp`:
    /// the stdio bridge, also for an agent that offers neither `http` nor `acp`.
    #[test]
    fn grok_gets_t3s_stdio_bridge() {
        let server = conn_provider::McpServer {
            device_tools: false,
            name: "conn".into(),
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
                json!({"name": "conn", "command": "/bin/conn-server", "args": ["acp-mcp-bridge"], "env": [
                    {"name": "ELECTRON_RUN_AS_NODE", "value": "1"},
                    {"name": "T3_ACP_MCP_ENDPOINT", "value": "http://127.0.0.1:1/mcp"},
                    {"name": "T3_ACP_MCP_AUTHORIZATION", "value": "Bearer t"}
                ]})
            );
        }
    }
}
