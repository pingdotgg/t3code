//! The provider interface: what the engine needs from an agent runtime (Claude, Codex, ...).
//!
//! Shaped from `ProviderAdapterV2` in `packages/provider-core/src/server/ProviderAdapter.ts`,
//! which Claude and Codex both implement. A [`Provider`] opens a [`Session`] (one native
//! process or connection). A session owns provider threads, runs turns on them, and reports
//! everything that happens as [`ProviderEvent`]s on one channel.
//!
//! Kept from the TS interface: plan a selection transition; open session (with its MCP
//! servers and a host handle, returning the session row); ensure/resume/fork/roll back a
//! thread; start/steer/interrupt a turn; apply a model selection; stop and await background
//! tasks; respond to runtime requests; the event stream; the error tags that change what
//! the engine does, condensed into [`ProviderError`]. Added: [`Session::apply_runtime_policy`], so
//! a permission mode change reaches a running process (Claude `setPermissionMode`); TS passes
//! the policy per turn only; [`ProviderEvent::ContinuationRequested`], where TS uses a
//! separate service. Left out until needed: compact, thread unload, subagent stop,
//! feedback upload, prompt suggestions, context-window hooks.
//!
//! To add a provider: make a crate that depends on this one and implements both traits.

pub mod goal;
pub mod manifest;
pub mod mcp_apps;
mod set;
pub mod tool_output;

use std::{future::Future, pin::Pin};

use conn_contract::{
    AppThread, ApprovalDecision, ChatAttachment, ConversationMessage, ExecutionNode,
    InteractionMode, MessageId, ModelSelection, NodeId, OrchestrationV2Actor,
    OrchestrationV2CreationSource, PlanArtifact, ProviderCapabilities, ProviderFailure,
    ProviderInstanceId, ProviderRetry, ProviderSession, ProviderSessionId, ProviderThread,
    ProviderThreadId, ProviderTurn, ProviderTurnId, RunAttemptId, RunId, RuntimeMode,
    RuntimeRequest, RuntimeRequestId, Subagent, ThreadId, TurnItem, TurnItemId, UserInputAnswers,
};

pub use conn_contract::AppThread as ProviderAppThread;
pub use manifest::{LiveManifest, StatusNotifier};
use serde::{Deserialize, Serialize};
pub use set::ProviderSet;
use tokio::sync::mpsc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type ProviderResult<T> = Result<T, ProviderError>;

/// A configured provider instance, such as the user's Claude install.
pub trait Provider: Send + Sync {
    fn instance_id(&self) -> &ProviderInstanceId;

    /// The contract's `ProviderDriverKind`, such as `claudeAgent` or `codex`.
    fn driver(&self) -> &str;

    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>>;

    /// Starts or resumes a native session. Events flow on the returned channel until the
    /// session closes; the engine is its only reader.
    fn open_session(&self, input: OpenSessionInput)
    -> BoxFuture<'_, ProviderResult<OpenedSession>>;

    /// `planSelectionTransition`: how a model selection change on this instance takes effect,
    /// given the live session's negotiated capabilities. Claude and Codex carry the selection
    /// per turn (`turnScopedSelectionTransition`); ACP rejects a model change its session
    /// cannot switch (`acpSelectionTransition`).
    fn plan_selection_transition(
        &self,
        _input: &SelectionTransitionInput,
    ) -> SelectionTransitionPlan {
        SelectionTransitionPlan::ApplyOnNextTurn
    }

    /// The `ServerProvider` entry (`packages/contracts/src/server.ts`) for
    /// `ServerConfig.providers`, or `None` when the server builds it another way.
    /// `checked_at` is ISO-8601.
    fn server_provider_entry(&self, _checked_at: &str) -> Option<serde_json::Value> {
        None
    }

    /// `ProviderTextGeneration` through this provider's own CLI or SDK, outside any session:
    /// one prompt with a JSON output schema, answered with one JSON object (T3's text
    /// generation runner, `TextGenerationOperations.Request`; the caller builds the prompt
    /// and checks the object's fields). Thread titles use it when the title model is this
    /// provider's instance. `Unsupported` when the provider has no text generation.
    fn generate_text(
        &self,
        _request: TextGenerationRequest,
    ) -> BoxFuture<'_, ProviderResult<serde_json::Value>> {
        unsupported("generate_text")
    }

    /// Probes the provider again (`ManagedServerProvider.refresh`) with the instance's
    /// `providerInstances[id]` settings entry (`None`: no entry), so the next
    /// [`Provider::server_provider_entry`] reports it. Providers with a fixed entry do nothing.
    fn refresh_status(&self, _instance: Option<serde_json::Value>) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }

    /// T3's `ProviderInstance.refreshModels`, for `server.refreshProviders` with
    /// `refreshModels`: list the models again even when the last check listed them. `None`:
    /// this provider has no such refresh. An error's `Failed` detail is shown to the user.
    fn refresh_models(&self) -> Option<BoxFuture<'_, ProviderResult<()>>> {
        None
    }

    /// Whether [`Provider::credential_check`] is served: the only in-app sign-in this server
    /// serves (`provider.auth.start`). Account sign-ins through a browser are not served;
    /// providers sign in through Orbit's AI router.
    fn has_credential_check(&self) -> bool {
        false
    }

    /// A check of the credentials the instance's settings hold, as T3's Antigravity sign-in
    /// does without a browser. It reports its steps through `check.on_step`. When
    /// `check.abort` fires, it stops its process and removes its files before it returns.
    /// An error's `Failed` detail is shown to the user.
    fn credential_check(&self, _check: CredentialCheck) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async {
            Err(ProviderError::Unsupported {
                operation: "credential_check",
            })
        })
    }

    /// The periodic probe (`ManagedServerProvider` `refreshOnInterval` with `deferFailure`):
    /// a disabled instance is not probed, and a failed check over a ready entry keeps that
    /// entry. `true` asks for a recheck after 30 s (`FAILED_CHECK_RECHECK_DELAY`); `defer`
    /// `false` is that recheck, which publishes whatever it finds.
    fn refresh_status_on_interval(
        &self,
        instance: Option<serde_json::Value>,
        _defer: bool,
    ) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            self.refresh_status(instance).await;
            false
        })
    }
}

/// One text generation request (`TextGenerationOperations.Request`).
#[derive(Clone, Debug)]
pub struct TextGenerationRequest {
    /// T3's operation name, such as `generateThreadTitle`; it names the request in errors.
    pub operation: String,
    /// The folder the CLI runs in.
    pub cwd: String,
    pub prompt: String,
    /// The JSON Schema of the answer as the text T3 writes for it
    /// (`JSON.stringify(toJsonSchemaObject(schema))`, key order kept).
    pub output_schema: String,
    /// The text generation model selection, on this provider's instance.
    pub model_selection: ModelSelection,
    /// Image attachments, as absolute paths to readable files.
    pub image_paths: Vec<std::path::PathBuf>,
    /// The request's deadline when the caller sets one (`investigate.timeoutMs`); else the
    /// provider's own.
    pub timeout: Option<std::time::Duration>,
    /// `investigate`: the model reads the checkout in `cwd` with read-only tools across turns
    /// (review guides). A provider that cannot keep that read-only refuses the request.
    pub investigate: bool,
}

/// `ProviderSelectionTransitionInput`.
#[derive(Clone, Debug)]
pub struct SelectionTransitionInput {
    pub current: ModelSelection,
    pub target: ModelSelection,
    /// The live session's `capabilities` (`OrchestrationV2ProviderCapabilities`).
    pub session_capabilities: serde_json::Value,
}

/// `ProviderSelectionTransitionPlan`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelectionTransitionPlan {
    ApplyOnNextTurn,
    /// The live session must end; the next turn resumes the thread in a new one.
    RestartSession,
    /// A new native thread with the history handed over.
    CreateWithHandoff,
    Reject {
        reason: String,
    },
}

/// What `open_session` gives the engine (`ProviderAdapterV2SessionRuntime`).
pub struct OpenedSession {
    pub session: Box<dyn Session>,
    pub events: mpsc::Receiver<ProviderEvent>,
    /// The session's row (`providerSession`), which the engine stores before any event.
    pub provider_session: ProviderSession,
    /// `backgroundTasksEndWithProcess`: every background task of the session ends with its
    /// process, so releasing the session clears its provider threads' rosters.
    pub background_tasks_end_with_process: bool,
}

impl std::fmt::Debug for OpenedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenedSession").finish_non_exhaustive()
    }
}

/// What [`Session::close`] left running. T3 revokes a session's MCP credential when its
/// process ends (`releaseEntry` in `ProviderSessionManager.ts`), and keeps it while a shared
/// process still runs: that process's MCP client may still use it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Closed {
    /// The session's process ended with it.
    RuntimeStopped,
    /// The process keeps serving other sessions (Codex's shared `app-server`).
    RuntimeShared,
}

/// One live native session. Methods return once the provider accepted the request; results
/// arrive as events.
pub trait Session: Send + Sync {
    fn provider_session_id(&self) -> &ProviderSessionId;

    /// Creates the native thread for an app thread, or returns `existing` when it is usable.
    fn ensure_thread(
        &self,
        input: EnsureThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>>;

    /// Loads an existing native thread, for example after a server restart.
    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>>;

    /// Sends one user message and starts a turn. Ends with [`ProviderEvent::TurnTerminal`].
    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>>;

    /// Adds a message to the running turn.
    fn steer_turn(&self, _input: SteerInput) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("steer_turn")
    }

    /// Whether [`Session::inject_history`] can add history to a native thread
    /// (`injectHistory` on T3's session). Without it, the engine sends the history inline,
    /// ahead of the user's text.
    fn injects_history(&self) -> bool {
        false
    }

    /// `injectHistory`: adds context handoff history to the native thread before a turn.
    /// `Ok(false)` when the provider turns the request down before it changes the history
    /// (Codex: an unknown method); the engine then sends the history inline.
    fn inject_history(&self, _input: InjectHistoryInput) -> BoxFuture<'_, ProviderResult<bool>> {
        Box::pin(async { Ok(false) })
    }

    /// Stops the running turn. Its `TurnTerminal` reports `interrupted`.
    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>>;

    /// Stop arrived before the provider accepted this run's turn: the engine already ended the
    /// run, as T3's `dispatchRunInterrupt` does "before provider start", and T3's effect
    /// worker interrupts the running `provider-turn.start`. A [`Session::start_turn`] for the
    /// run that is in flight, or that begins after this call, should stop and close what it
    /// opened as T3's interruption does, then return an error. It may be called while
    /// `start_turn` runs, so it must not wait for it. The default changes nothing: the start
    /// runs to its end, and the engine interrupts a turn the provider then reports.
    fn abandon_turn_start(&self, _input: AbandonTurnStartInput) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }

    /// `interruptTurn` with `requestRuntimeRestart` on a settled turn: Stop on a thread whose
    /// latest run ended while its background work still runs (`ProviderTurnControlService`
    /// calls it for settled turns too). A provider that holds such work ends it (Claude
    /// closes its idle query); the default changes nothing.
    fn stop_background_work(&self, _input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async { Ok(()) })
    }

    /// Applies a new model to the running process. `Unsupported` means it applies next turn.
    fn apply_model_selection(
        &self,
        _thread: ProviderThread,
        _selection: ModelSelection,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("apply_model_selection")
    }

    /// Applies a new permission mode to the running process. `Unsupported` means next turn.
    fn apply_runtime_policy(
        &self,
        _thread: ProviderThread,
        _policy: RuntimePolicy,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("apply_runtime_policy")
    }

    /// Answers a permission prompt or user question the provider raised as a
    /// [`ProviderEvent::RuntimeRequestUpdated`].
    fn respond_to_runtime_request(
        &self,
        input: RuntimeRequestResponse,
    ) -> BoxFuture<'_, ProviderResult<()>>;

    /// Ends the session. The event channel closes after it. The answer says whether the
    /// native process ended with it, or keeps serving other sessions.
    fn close(&self) -> BoxFuture<'_, Closed>;

    /// Requests use the existing provider process; they never open a session or a turn.
    fn mcp_app_request(
        &self,
        _input: mcp_apps::Request,
    ) -> BoxFuture<'_, ProviderResult<serde_json::Value>> {
        unsupported("mcp_app_request")
    }

    /// Reads a resource just matched against native tool metadata, during a capture.
    fn read_mcp_app_document(
        &self,
        input: mcp_apps::Request,
    ) -> BoxFuture<'_, ProviderResult<serde_json::Value>> {
        self.mcp_app_request(input)
    }

    /// Resolves a completed native MCP tool to its UI resource, if one was advertised.
    fn mcp_app_source(
        &self,
        _item: serde_json::Value,
    ) -> BoxFuture<'_, ProviderResult<Option<mcp_apps::Source>>> {
        Box::pin(async { Ok(None) })
    }

    /// Sets the MCP servers every later turn of this session can use, replacing the previous
    /// list. A running process picks them up when the provider supports a live change.
    fn set_mcp_servers(&self, _servers: Vec<McpServer>) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("set_mcp_servers")
    }

    /// `ProviderAdapterV2SessionRuntime.rollbackThread`: the next turn continues from `target`.
    fn rollback_thread(
        &self,
        _input: RollbackThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ThreadSnapshot>> {
        unsupported("rollback_thread")
    }

    /// `forkThread`: a new native thread with the source's history, up to a turn if given.
    fn fork_thread(
        &self,
        _input: ForkThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        unsupported("fork_thread")
    }

    /// `readThreadSnapshot`: the native thread's history as app rows.
    fn read_thread_snapshot(
        &self,
        _provider_thread: ProviderThread,
    ) -> BoxFuture<'_, ProviderResult<ThreadSnapshot>> {
        unsupported("read_thread_snapshot")
    }

    /// `hasPendingBackgroundWork`: work still runs after the turn ended (a background
    /// subagent), so an idle session should not be released yet.
    fn has_pending_background_work(&self) -> bool {
        false
    }

    /// `normalizeThreadLoadModelSelection`: the part of a model selection that the loaded
    /// native thread depends on. The engine resumes the thread at a turn start when the
    /// native thread, this selection or the runtime policy differ from the last load
    /// (`providerThreadLoadKey` in T3's `ProviderSessionManager`). The default keeps all of it.
    fn thread_load_model_selection(&self, selection: &ModelSelection) -> ModelSelection {
        selection.clone()
    }

    /// `stopTask`: stops one background task the agent started on this thread (Claude: a
    /// workflow task). Errors when no such task runs.
    fn stop_task(&self, _input: StopTaskInput) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("stop_task")
    }

    /// `awaitBackgroundTasks`: marks (or unmarks) background tasks the agent resumes from, by
    /// the ids the agent saw. Returns the ids that run on this thread; others change nothing.
    fn await_background_tasks(
        &self,
        _input: AwaitBackgroundTasksInput,
    ) -> BoxFuture<'_, ProviderResult<Vec<String>>> {
        unsupported("await_background_tasks")
    }

    /// `uploadFeedback`: sends this provider thread and the provider's logs to the vendor
    /// through the official binary, and answers the vendor's feedback id. Only Codex has it in
    /// T3; `Unsupported` means "does not support feedback uploads".
    fn upload_feedback(
        &self,
        _input: UploadFeedbackInput,
    ) -> BoxFuture<'_, ProviderResult<String>> {
        unsupported("upload_feedback")
    }
}

/// [`Session::upload_feedback`]'s input: the provider thread and the user's optional reason.
#[derive(Clone, Debug)]
pub struct UploadFeedbackInput {
    pub provider_thread: ProviderThread,
    pub reason: Option<String>,
}

/// One MCP server a session passes to its agent (`McpServerConfig`, HTTP transport).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// The session may use the device tools (T3's `device` MCP capability): the agent then
    /// gets T3's device text.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub device_tools: bool,
}

impl std::fmt::Debug for McpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Header values carry the agent's bearer token.
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(name, _)| (name.as_str(), "<redacted>"))
            .collect();
        f.debug_struct("McpServer")
            .field("name", &self.name)
            .field("url", &self.url)
            .field("headers", &headers)
            .finish()
    }
}

/// `ProviderAdapterV2SessionRuntime.stopTask` input.
#[derive(Clone, Debug)]
pub struct StopTaskInput {
    pub provider_thread: ProviderThread,
    pub task_id: String,
}

/// `ProviderAdapterV2SessionRuntime.awaitBackgroundTasks` input.
#[derive(Clone, Debug)]
pub struct AwaitBackgroundTasksInput {
    pub provider_thread: ProviderThread,
    pub task_ids: Vec<String>,
    pub awaited: bool,
}

/// `ProviderAdapterV2RollbackTarget`.
#[expect(clippy::large_enum_variant, reason = "built once per rollback")]
#[derive(Clone, Debug)]
pub enum RollbackTarget {
    ThreadStart {
        checkpoint_id: String,
    },
    ProviderTurn {
        checkpoint_id: String,
        app_run_ordinal: u32,
        provider_turn: ProviderTurn,
    },
}

/// `ProviderAdapterV2RollbackThreadInput`.
#[derive(Clone, Debug)]
pub struct RollbackThreadInput {
    pub provider_thread: ProviderThread,
    pub target: RollbackTarget,
    pub provider_thread_turns: Vec<ProviderTurn>,
}

/// `ProviderAdapterV2ForkThreadInput`.
#[derive(Clone, Debug)]
pub struct ForkThreadInput {
    pub source_provider_thread: ProviderThread,
    pub source_provider_turns: Vec<ProviderTurn>,
    pub provider_turn_id: Option<ProviderTurnId>,
    pub target_thread_id: ThreadId,
    pub owner_node_id: Option<NodeId>,
    /// The fork's run selection (T3 passes `run.modelSelection`). Codex sends its model.
    pub model_selection: Option<ModelSelection>,
    /// The fork's resolved runtime policy. Codex sends its `cwd`.
    pub runtime_policy: Option<RuntimePolicy>,
}

/// `ProviderAdapterV2ThreadSnapshot`.
#[derive(Clone, Debug)]
pub struct ThreadSnapshot {
    pub provider_thread: ProviderThread,
    pub provider_turns: Vec<ProviderTurn>,
    pub messages: Vec<ConversationMessage>,
    pub runtime_requests: Vec<RuntimeRequest>,
}

/// What [`ProviderEvent::ContinuationRequested`] carries (`ProviderContinuationRequest`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationRequest {
    pub thread_id: ThreadId,
    pub provider_thread_id: ProviderThreadId,
    pub detail: Option<String>,
    /// The notice the client shows for the wake (`OrchestrationV2Notification`:
    /// `source`, `outcome`, `summary`). Absent: the engine's default notice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<serde_json::Value>,
    /// `delivery`: `Some("message_text")` when the detail is the whole wake and the provider
    /// buffered nothing for it (Codex). The continuation message is then created by the
    /// server (`creationSource: "server"`), else by the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<String>,
}

/// `ProviderAdapterV2Event` `steer.updated` status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SteerStatus {
    Pending,
    Completed,
    Cancelled,
}

fn unsupported<T: Send + 'static>(
    operation: &'static str,
) -> BoxFuture<'static, ProviderResult<T>> {
    Box::pin(async move { Err(ProviderError::Unsupported { operation }) })
}

/// `ProviderAdapterV2RuntimePolicy`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePolicy {
    pub runtime_mode: RuntimeMode,
    pub interaction_mode: InteractionMode,
    pub cwd: Option<String>,
    /// A native approval policy that replaces the runtime mode's default (a managed policy's
    /// override). Passed to the provider as is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<serde_json::Value>,
    /// A native sandbox policy that replaces the runtime mode's default. Passed as is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<serde_json::Value>,
}

/// `ProviderAdapterV2OpenSessionInput`, plus what this server hands a session at open: its
/// MCP servers (ACP declares them in `session/new`, load, resume and fork; vendor SDKs take
/// them at open) and the host handle for agents that call back for files and terminals.
#[derive(Clone, Debug)]
pub struct OpenSessionInput {
    pub thread_id: ThreadId,
    pub provider_session_id: ProviderSessionId,
    pub model_selection: ModelSelection,
    pub runtime_policy: RuntimePolicy,
    pub resume_from_session: Option<ProviderSession>,
    /// The MCP servers the session starts with. [`Session::set_mcp_servers`] changes them on
    /// a live session.
    pub mcp_servers: Vec<McpServer>,
    /// The server's side of an agent's client callbacks; `None` when the server offers none.
    pub host: Option<HostHandle>,
}

/// A shared [`ProviderHost`].
#[derive(Clone)]
pub struct HostHandle(pub std::sync::Arc<dyn ProviderHost>);

impl std::fmt::Debug for HostHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HostHandle")
    }
}

/// What an agent may ask of the server through its provider: read and write files and run
/// terminals, as ACP clients serve them (`fs/read_text_file`, `fs/write_text_file`,
/// `terminal/*`; T3: `AntigravityClientFiles.ts`, `clientTerminals.ts`). The server decides
/// which roots a session may touch; a request outside them is [`HostError::InvalidParams`].
///
/// Only the trait and a file host for tests exist; no provider calls it yet.
pub trait ProviderHost: Send + Sync {
    /// `fs/read_text_file`: UTF-8 text; `line` (1-based) and `limit` (lines) cut it.
    fn read_text_file(&self, request: ReadTextFile) -> BoxFuture<'_, HostResult<String>>;
    /// `fs/write_text_file`: replaces the file's content.
    fn write_text_file(&self, request: WriteTextFile) -> BoxFuture<'_, HostResult<()>>;
    /// `terminal/create`: starts a command; returns the terminal id.
    fn create_terminal(&self, _request: CreateTerminal) -> BoxFuture<'_, HostResult<String>> {
        host_unsupported()
    }
    /// `terminal/output`: the output so far (truncated from the start at the byte limit).
    fn terminal_output(&self, _terminal_id: String) -> BoxFuture<'_, HostResult<TerminalOutput>> {
        host_unsupported()
    }
    /// `terminal/wait_for_exit`.
    fn wait_for_terminal_exit(
        &self,
        _terminal_id: String,
    ) -> BoxFuture<'_, HostResult<TerminalExitStatus>> {
        host_unsupported()
    }
    /// `terminal/kill`: stops the command; the terminal stays readable.
    fn kill_terminal(&self, _terminal_id: String) -> BoxFuture<'_, HostResult<()>> {
        host_unsupported()
    }
    /// `terminal/release`: kills the command if it runs and frees the terminal.
    fn release_terminal(&self, _terminal_id: String) -> BoxFuture<'_, HostResult<()>> {
        host_unsupported()
    }
}

fn host_unsupported<T: Send + 'static>() -> BoxFuture<'static, HostResult<T>> {
    Box::pin(async { Err(HostError::MethodNotFound) })
}

pub type HostResult<T> = Result<T, HostError>;

/// A host callback failure, as the ACP error a provider answers the agent with.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HostError {
    /// JSON-RPC -32601: the server does not offer this callback.
    #[error("method not found")]
    MethodNotFound,
    /// -32602: a path outside the session's roots, not a text file, too large.
    #[error("{0}")]
    InvalidParams(String),
    /// ACP -32002: the file does not exist.
    #[error("{0}")]
    ResourceNotFound(String),
    /// -32603.
    #[error("{0}")]
    Internal(String),
}

impl HostError {
    /// The JSON-RPC error code.
    pub fn code(&self) -> i64 {
        match self {
            Self::MethodNotFound => -32601,
            Self::InvalidParams(_) => -32602,
            Self::ResourceNotFound(_) => -32002,
            Self::Internal(_) => -32603,
        }
    }
}

/// `ReadTextFileRequest`.
#[derive(Clone, Debug)]
pub struct ReadTextFile {
    pub path: std::path::PathBuf,
    pub line: Option<u32>,
    pub limit: Option<u32>,
}

/// `WriteTextFileRequest`.
#[derive(Clone, Debug)]
pub struct WriteTextFile {
    pub path: std::path::PathBuf,
    pub content: String,
}

/// `CreateTerminalRequest`.
#[derive(Clone, Debug)]
pub struct CreateTerminal {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<std::path::PathBuf>,
    pub output_byte_limit: Option<u64>,
}

/// `TerminalOutputResponse`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalOutput {
    pub output: String,
    pub truncated: bool,
    pub exit_status: Option<TerminalExitStatus>,
}

/// `TerminalExitStatus`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalExitStatus {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// `ProviderAdapterV2EnsureThreadInput`.
#[derive(Clone, Debug)]
pub struct EnsureThreadInput {
    pub thread_id: ThreadId,
    pub title: Option<String>,
    pub model_selection: ModelSelection,
    pub runtime_policy: RuntimePolicy,
    pub existing_provider_thread: Option<ProviderThread>,
}

#[derive(Clone, Debug)]
pub struct ResumeThreadInput {
    pub provider_thread: ProviderThread,
    pub thread_id: Option<ThreadId>,
    pub model_selection: Option<ModelSelection>,
    pub runtime_policy: Option<RuntimePolicy>,
}

/// `ProviderAdapterV2TurnMessage`.
#[derive(Clone, Debug)]
pub struct TurnMessage {
    pub message_id: MessageId,
    pub text: String,
    pub attachments: Vec<ChatAttachment>,
    /// Who wrote the message. With `creation_source` `provider` and `created_by` `agent` it
    /// is the provider's own continuation (`isClaudeProviderContinuationTurn`).
    pub created_by: OrchestrationV2Actor,
    pub creation_source: OrchestrationV2CreationSource,
    pub scheduled_task_id: Option<String>,
    pub sender_thread_id: Option<String>,
}

impl TurnMessage {
    /// A message a person sent from the web client.
    pub fn user(message_id: MessageId, text: String, attachments: Vec<ChatAttachment>) -> Self {
        Self {
            message_id,
            text,
            attachments,
            created_by: OrchestrationV2Actor::User,
            creation_source: OrchestrationV2CreationSource::Web,
            scheduled_task_id: None,
            sender_thread_id: None,
        }
    }

    /// The provider's own continuation: `createdBy: agent`, `creationSource: provider`.
    pub fn is_provider_continuation(&self) -> bool {
        self.created_by == OrchestrationV2Actor::Agent
            && self.creation_source == OrchestrationV2CreationSource::Provider
    }
}

/// An `appContext` entry: text an MCP app wrote for the model, keyed by its item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppContextEntry {
    pub key: String,
    pub text: String,
}

/// `ProviderAdapterV2TurnInput`.
#[derive(Clone, Debug)]
pub struct TurnInput {
    pub app_thread: AppThread,
    pub thread_id: ThreadId,
    pub run_id: RunId,
    pub run_ordinal: u32,
    /// Whether the native thread already holds turns (`nativeThreadHasTurns`); `None` leaves
    /// it to the provider (Claude: `providerTurnOrdinal > 1`).
    pub native_thread_has_turns: Option<bool>,
    pub provider_turn_ordinal: u32,
    /// The run a server restart cut short, when this turn continues it
    /// (`restartContinuationOfRunId`). Codex then starts the native turn without input.
    pub restart_continuation_of_run_id: Option<RunId>,
    pub attempt_id: RunAttemptId,
    pub root_node_id: NodeId,
    pub provider_thread: ProviderThread,
    pub message: TurnMessage,
    pub model_selection: ModelSelection,
    pub runtime_policy: RuntimePolicy,
    /// `appContext`: MCP app text for the model (Codex: untrusted `additionalContext`).
    pub app_context: Vec<AppContextEntry>,
}

/// `ProviderAdapterV2SteerInput`.
#[derive(Clone, Debug)]
pub struct SteerInput {
    pub thread_id: ThreadId,
    pub run_id: RunId,
    pub provider_thread: ProviderThread,
    pub provider_turn_id: ProviderTurnId,
    pub message: TurnMessage,
    pub model_selection: Option<ModelSelection>,
    /// `appContext`: the thread's MCP app notes; a steer sends those the native thread has
    /// not seen with their current text.
    pub app_context: Vec<AppContextEntry>,
}

/// `ProviderAdapterV2HistoricalContext` for one native thread: the history items as Codex's
/// `thread/inject_items` takes them (`historyResponseItems`).
#[derive(Clone, Debug)]
pub struct InjectHistoryInput {
    pub provider_thread: ProviderThread,
    pub items: serde_json::Value,
}

/// `ProviderAdapterV2InterruptInput`.
#[derive(Clone, Debug)]
pub struct InterruptInput {
    pub provider_thread: ProviderThread,
    pub provider_turn_id: ProviderTurnId,
}

/// The run whose turn start Stop abandoned ([`Session::abandon_turn_start`]).
#[derive(Clone, Debug)]
pub struct AbandonTurnStartInput {
    pub thread_id: ThreadId,
    pub run_id: RunId,
}

/// `ProviderAdapterV2RuntimeRequestResponseInput`.
#[derive(Clone, Debug)]
pub struct RuntimeRequestResponse {
    pub request_id: RuntimeRequestId,
    pub decision: Option<ApprovalDecision>,
    pub feedback: Option<String>,
    pub answers: Option<UserInputAnswers>,
}

/// `ProviderAdapterV2Event` without the `driver` field (the session knows its driver).
/// Serializes like the TS event (`type` tag, camelCase fields) for recorded-session tests.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
#[expect(
    clippy::large_enum_variant,
    reason = "each event moves once into the channel"
)]
pub enum ProviderEvent {
    #[serde(rename = "provider_session.updated")]
    ProviderSessionUpdated { provider_session: ProviderSession },
    #[serde(rename = "provider_thread.updated")]
    ProviderThreadUpdated { provider_thread: ProviderThread },
    #[serde(rename = "provider_turn.updated")]
    ProviderTurnUpdated {
        thread_id: Option<ThreadId>,
        provider_turn: ProviderTurn,
    },
    #[serde(rename = "node.updated")]
    NodeUpdated { node: ExecutionNode },
    #[serde(rename = "subagent.updated")]
    SubagentUpdated { subagent: Subagent },
    #[serde(rename = "message.updated")]
    MessageUpdated { message: ConversationMessage },
    #[serde(rename = "turn_item.updated")]
    TurnItemUpdated { turn_item: TurnItem },
    #[serde(rename = "mcp_app.capture")]
    McpAppCapture {
        turn_item: TurnItem,
        source: mcp_apps::Source,
    },
    /// Not persisted; goes only to clients that show the row.
    #[serde(rename = "command_output.delta")]
    CommandOutputDelta {
        thread_id: ThreadId,
        item_id: TurnItemId,
        chunk: String,
    },
    /// A permission prompt or user question, or its resolution.
    #[serde(rename = "runtime_request.updated")]
    RuntimeRequestUpdated {
        thread_id: Option<ThreadId>,
        runtime_request: RuntimeRequest,
    },
    #[serde(rename = "plan.updated")]
    PlanUpdated { plan: PlanArtifact },
    /// Work of this provider turn goes on after its terminal (`pending: true`, sent before the
    /// terminal), or has ended. Not persisted; the engine holds the session while any is
    /// pending.
    #[serde(rename = "background_work.updated")]
    BackgroundWorkUpdated {
        provider_turn_id: ProviderTurnId,
        pending: bool,
    },
    #[serde(rename = "turn.terminal")]
    TurnTerminal(TurnTerminal),
    /// A provider-made thread, such as a subagent's child thread. `create_only`: create it
    /// if missing, never overwrite.
    #[serde(rename = "app_thread.created")]
    AppThreadCreated {
        app_thread: AppThread,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        create_only: Option<bool>,
    },
    /// A message sent into a running turn was taken (`completed`) or dropped (`cancelled`).
    #[serde(rename = "steer.updated")]
    SteerUpdated {
        thread_id: ThreadId,
        run_id: RunId,
        message_id: MessageId,
        status: SteerStatus,
    },
    /// Not in `ProviderAdapterV2Event` (TS uses a separate service): the provider produced
    /// output with no turn running and asks the engine for a turn. The engine queues an agent
    /// message with `creationSource: provider`; its turn reaches [`Session::start_turn`], which
    /// shows the held output instead of sending a prompt.
    #[serde(rename = "continuation.requested")]
    ContinuationRequested(ContinuationRequest),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTerminal {
    pub provider_thread_id: ProviderThreadId,
    pub provider_turn_id: ProviderTurnId,
    pub run_ordinal: u32,
    pub status: TurnStatus,
    /// Set when `status` is `failed`.
    pub failure: Option<ProviderFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<ProviderRetry>,
    pub thread_disposition: ThreadDisposition,
    /// A failed root whose native children keep running: they settle without it, so the
    /// run's end leaves them open (`childTurnsContinue`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub child_turns_continue: bool,
    /// What ended the turn. The adapter sets [`TerminalCause::SessionClosed`] on every terminal
    /// it produces once [`Session::close`] began, so the engine never takes a close's own end
    /// for a Stop the provider confirmed.
    #[serde(default, skip_serializing_if = "TerminalCause::is_provider")]
    pub cause: TerminalCause,
    /// Why the provider stopped a turn it reports as completed (a Codex hook that stopped
    /// it); the engine keeps it as a warning on the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// What ended a turn: the provider's own report, or the session's close.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCause {
    #[default]
    Provider,
    /// The session's close ended the turn; the run detaches.
    SessionClosed,
}

impl TerminalCause {
    fn is_provider(&self) -> bool {
        *self == Self::Provider
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Completed,
    Interrupted,
    Cancelled,
    Failed,
}

/// Whether the native thread can take another turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadDisposition {
    Reusable,
    Broken,
}

/// The controls of one [`Provider::credential_check`].
pub struct CredentialCheck {
    /// Fires to end the check early (cancel, timeout, or the instance went away).
    pub abort: BoxFuture<'static, ()>,
    /// Called as the check passes each step, in order.
    pub on_step: Box<dyn Fn(CheckStep) + Send + Sync>,
}

impl std::fmt::Debug for CredentialCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialCheck").finish_non_exhaustive()
    }
}

/// The steps of T3's `runSignIn` that its auth flow shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckStep {
    /// The agent answered `initialize`.
    Initialized,
    /// The agent signed in and opened a session; the models load next.
    Verifying,
}

/// A provider failure, condensed from the `ProviderAdapterV2Error` union.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderError {
    /// This provider does not implement the operation.
    Unsupported { operation: &'static str },
    /// No running session owns the thread.
    SessionStopped,
    /// The provider needs the user to sign in.
    SignInRequired,
    /// The native protocol sent something unexpected.
    Protocol { detail: String },
    /// `ProviderAdapterThreadInUseError`: another process owns the native thread's writes
    /// (Codex: "already has an active writer"). Starting a replacement would split the
    /// conversation, so the engine must not fall back to a new native thread; `detail` is
    /// T3's text and is shown as the failure message.
    ThreadInUse { detail: String },
    /// `ProviderAdapterInterruptTimeoutError`: the provider did not confirm a stop in time and
    /// its turn stays open, so the agent may still run. The engine marks the Stop unresponsive
    /// and leaves the run to the provider's own terminal or to Force stop.
    InterruptTimeout { timeout_ms: u64 },
    /// An operation failed; `detail` is safe to show the user.
    Failed {
        operation: &'static str,
        detail: String,
    },
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported { operation } => write!(f, "provider does not support {operation}"),
            Self::SessionStopped => f.write_str("no running provider session owns this thread"),
            Self::SignInRequired => f.write_str("provider requires sign-in"),
            Self::Protocol { detail } => write!(f, "provider protocol error: {detail}"),
            Self::ThreadInUse { detail } => f.write_str(detail),
            Self::InterruptTimeout { timeout_ms } => write!(
                f,
                "the provider did not confirm stopping the turn within {timeout_ms} ms"
            ),
            Self::Failed { operation, detail } => {
                write!(f, "provider {operation} failed: {detail}")
            }
        }
    }
}

impl std::error::Error for ProviderError {}

/// Helpers for tests of providers and of the engine's fake provider.
#[doc(hidden)]
pub mod testing {
    use serde_json::{Value, json};

    /// A whole `OrchestrationV2ProviderCapabilities` (Claude's), for test session rows.
    pub fn session_capabilities() -> Value {
        json!({
            "sessions": {
                "supportsMultipleProviderThreadsPerSession": false,
                "supportsModelSwitchInSession": true,
                "supportsProviderSwitchingViaHandoff": true,
                "supportsRuntimeModeSwitchInSession": false,
                "pendingRequestsSurviveRestart": false,
            },
            "threads": {
                "canCreateEmptyThread": true,
                "canReadThreadSnapshot": false,
                "canRollbackThread": true,
                "canForkThread": true,
                "canForkFromTurn": true,
                "canForkFromSubagentThread": false,
                "exposesNativeThreadId": true,
            },
            "turns": {
                "exposesNativeTurnId": false,
                "emitsTurnStarted": true,
                "emitsTurnCompleted": true,
                "supportsInterrupt": true,
                "supportsActiveSteering": true,
                "activeSteeringInterruptsTools": true,
                "supportsSteeringByInterruptRestart": false,
                "supportsQueuedMessages": false,
                "terminalStatusQuality": "strong",
            },
            "streaming": {
                "streamsAssistantText": true,
                "streamsReasoning": true,
                "streamsToolOutput": false,
                "streamsPlanText": false,
                "emitsMessageCompleted": true,
            },
            "tools": {
                "exposesToolItemIds": true,
                "emitsToolStarted": true,
                "emitsToolCompleted": true,
                "emitsToolOutput": true,
                "supportsMcpTools": true,
                "supportsDynamicToolCallbacks": false,
            },
            "approvals": {
                "supportsCommandApproval": true,
                "supportsFileReadApproval": true,
                "supportsFileChangeApproval": true,
                "supportsApplyPatchApproval": false,
                "approvalsHaveNativeRequestIds": true,
                "approvalCallbacksAreLiveOnly": true,
                "approvalsCanOriginateFromSubagents": false,
            },
            "planning": {
                "emitsPlanUpdated": true,
                "emitsTodoList": true,
                "emitsProposedPlan": true,
                "supportsStructuredQuestions": true,
                "planDeltasHaveItemIds": false,
            },
            "subagents": {
                "supportsSubagents": true,
                "exposesSubagentThreadIds": false,
                "emitsSubagentLifecycle": true,
                "canWaitForSubagents": false,
                "canCloseSubagents": false,
                "canForkSubagentThread": false,
            },
            "context": {
                "acceptsSystemContext": false,
                "acceptsDeveloperContext": false,
                "acceptsSyntheticUserContext": true,
                "canGenerateSummaries": false,
                "canConsumeHandoffSummaries": true,
                "supportsDeltaHandoff": true,
                "supportsFullThreadHandoff": true,
                "maxRecommendedHandoffChars": null,
            },
            "checkpointing": {
                "appCanCheckpointFilesystem": true,
                "supportsNestedCheckpointScopes": false,
                "providerCanRollbackConversation": true,
                "providerRollbackReturnsSnapshot": true,
                "providerCanReadConversationSnapshot": false,
            },
            "identity": {
                "nativeThreadIds": "strong",
                "nativeTurnIds": "weak",
                "nativeItemIds": "strong",
                "nativeRequestIds": "strong",
            },
            "runtimePolicy": {"enforcement": "native"},
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_contract::{from_json, to_json};
    use serde_json::json;

    const NOW: &str = "2026-11-13T00:00:00.000Z";

    /// A provider that answers every turn with one assistant message and a terminal.
    struct EchoProvider {
        id: ProviderInstanceId,
    }

    struct EchoSession {
        id: ProviderSessionId,
        events: mpsc::Sender<ProviderEvent>,
    }

    impl Provider for EchoProvider {
        fn instance_id(&self) -> &ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            "echo"
        }
        fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
            Box::pin(async { Ok(from_json(json!({})).unwrap()) })
        }
        fn open_session(
            &self,
            input: OpenSessionInput,
        ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
            Box::pin(async move {
                let (tx, rx) = mpsc::channel(16);
                Ok(OpenedSession {
                    provider_session: from_json(json!({
                        "id": input.provider_session_id, "driver": "echo",
                        "providerInstanceId": "claude", "status": "ready", "cwd": "/tmp",
                        "model": null, "capabilities": crate::testing::session_capabilities(),
                        "createdAt": NOW, "updatedAt": NOW,
                        "lastError": null,
                    }))
                    .unwrap(),
                    background_tasks_end_with_process: false,
                    session: Box::new(EchoSession {
                        id: input.provider_session_id,
                        events: tx,
                    }),
                    events: rx,
                })
            })
        }
    }

    impl Session for EchoSession {
        fn provider_session_id(&self) -> &ProviderSessionId {
            &self.id
        }
        fn ensure_thread(
            &self,
            input: EnsureThreadInput,
        ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
            Box::pin(async move {
                Ok(from_json(json!({
                    "id": format!("native-{}", input.thread_id), "driver": "echo",
                    "providerInstanceId": "claude", "providerSessionId": self.id,
                    "appThreadId": input.thread_id, "ownerNodeId": null,
                    "nativeThreadRef": null, "nativeConversationHeadRef": null,
                    "status": "active", "firstRunOrdinal": null, "lastRunOrdinal": null,
                    "handoffIds": [], "forkedFrom": null, "createdAt": NOW, "updatedAt": NOW,
                }))
                .unwrap())
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
                let message = json!({
                    "createdBy": "agent", "creationSource": "provider", "id": "m1",
                    "threadId": input.thread_id, "runId": input.run_id, "nodeId": null,
                    "role": "assistant", "text": input.message.text, "attachments": [],
                    "streaming": false, "createdAt": NOW, "updatedAt": NOW,
                });
                let send = |event| self.events.send(event);
                send(ProviderEvent::MessageUpdated {
                    message: from_json(message).unwrap(),
                })
                .await
                .map_err(|_| ProviderError::SessionStopped)?;
                send(ProviderEvent::TurnTerminal(TurnTerminal {
                    provider_thread_id: "native-t1".into(),
                    provider_turn_id: "turn-1".into(),
                    run_ordinal: input.run_ordinal,
                    status: TurnStatus::Completed,
                    failure: None,
                    retry: None,
                    thread_disposition: ThreadDisposition::Reusable,
                    child_turns_continue: false,
                    cause: TerminalCause::Provider,
                    reason: None,
                }))
                .await
                .map_err(|_| ProviderError::SessionStopped)
            })
        }
        fn interrupt_turn(&self, _input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn respond_to_runtime_request(
            &self,
            _input: RuntimeRequestResponse,
        ) -> BoxFuture<'_, ProviderResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn close(&self) -> BoxFuture<'_, Closed> {
            Box::pin(async { Closed::RuntimeStopped })
        }
    }

    fn policy() -> RuntimePolicy {
        from_json(json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": null}))
            .unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_turn_streams_events_through_dyn_provider() {
        let provider: Box<dyn Provider> = Box::new(EchoProvider {
            id: "claude".into(),
        });
        let model: ModelSelection = from_json(json!({"provider": "claude", "model": "x"})).unwrap();
        let OpenedSession {
            session,
            mut events,
            ..
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: model.clone(),
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
                model_selection: model.clone(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        session
            .start_turn(TurnInput {
                native_thread_has_turns: None,
                restart_continuation_of_run_id: None,
                app_context: vec![],
                app_thread: from_json(json!({
                    "createdBy": "user", "creationSource": "web", "id": "t1", "projectId": "p1",
                    "title": "T", "providerInstanceId": "claude",
                    "modelSelection": to_json(&model), "runtimeMode": "full-access",
                    "interactionMode": "default", "branch": null, "worktreePath": null,
                    "activeProviderThreadId": null,
                    "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "t1"},
                    "forkedFrom": null, "createdAt": NOW, "updatedAt": NOW, "archivedAt": null,
                }))
                .unwrap(),
                thread_id: "t1".into(),
                run_id: "r1".into(),
                run_ordinal: 1,
                provider_turn_ordinal: 1,
                attempt_id: "a1".into(),
                root_node_id: "n1".into(),
                provider_thread: thread.clone(),
                message: TurnMessage {
                    created_by: conn_contract::OrchestrationV2Actor::User,
                    creation_source: conn_contract::OrchestrationV2CreationSource::Web,
                    scheduled_task_id: None,
                    sender_thread_id: None,
                    message_id: "u1".into(),
                    text: "hi".into(),
                    attachments: vec![],
                },
                model_selection: model.clone(),
                runtime_policy: policy(),
            })
            .await
            .unwrap();

        let ProviderEvent::MessageUpdated { message } = events.recv().await.unwrap() else {
            panic!("expected a message")
        };
        assert_eq!(to_json(&message)["text"], "hi");
        let terminal = events.recv().await.unwrap();
        assert_eq!(
            serde_json::to_value(&terminal).unwrap()["type"],
            "turn.terminal"
        );

        assert_eq!(
            session.apply_model_selection(thread, model).await,
            Err(ProviderError::Unsupported {
                operation: "apply_model_selection"
            })
        );
    }

    #[test]
    fn events_use_the_ts_wire_names() {
        let event: ProviderEvent = serde_json::from_value(json!({
            "type": "command_output.delta", "threadId": "t1", "itemId": "i1", "chunk": "ok"
        }))
        .unwrap();
        assert_eq!(
            event,
            ProviderEvent::CommandOutputDelta {
                thread_id: "t1".into(),
                item_id: "i1".into(),
                chunk: "ok".into()
            }
        );
    }
}
