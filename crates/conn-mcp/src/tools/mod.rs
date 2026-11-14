//! The tool handlers and what they share: the caller's limits, engine reads, stable ids.
//! Behaviour follows `apps/server/src/mcp/OrchestratorMcpService.ts` and the toolkit handlers;
//! `README.md` lists where it differs.

use std::sync::Arc;

use conn_contract::{Command, ThreadId, from_json};
use conn_engine::EngineError;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{Caller, McpConfig, McpService};

mod projects;
mod tasks;
mod threads;

pub(crate) type Args = Map<String, Value>;

#[derive(Debug, thiserror::Error)]
pub(crate) enum ToolError {
    /// `OrchestratorMcpFailure`: a tool result with `isError: true`.
    #[error("{code}: {message}")]
    Failure { code: &'static str, message: String },
    /// Arguments the schema allows but the call cannot use: JSON-RPC -32602, as TS decoding.
    #[error("invalid params: {0}")]
    InvalidParams(String),
}

pub(crate) type ToolResult = Result<Value, ToolError>;

pub(crate) fn fail(code: &'static str, message: impl Into<String>) -> ToolError {
    ToolError::Failure {
        code,
        message: message.into(),
    }
}

/// Every name in `tools.implemented` has an arm here; a test checks both ways.
#[cfg(test)]
pub(crate) const HANDLED: [&str; 16] = [
    "orchestrator_capabilities",
    "delegate_task",
    "task_status",
    "task_cancel",
    "t3_thread_list",
    "t3_thread_read",
    "t3_thread_update",
    "t3_thread_send",
    "t3_thread_wait",
    "t3_thread_interrupt",
    "t3_thread_search",
    "t3_pending_request",
    "t3_thread_launch",
    "t3_project_list",
    "t3_project_read",
    "t3_environment_read",
];

pub(crate) async fn call(
    service: &Arc<McpService>,
    caller: &Caller,
    name: &str,
    mut args: Args,
) -> ToolResult {
    // Linked environments are not served: only this environment's own id is accepted.
    if let Some(environment) = args.remove("environmentId")
        && environment != service.config.environment_id.as_str()
    {
        return Err(fail(
            "capability_denied",
            "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs.",
        ));
    }
    let cx = Cx { service, caller };
    match name {
        "orchestrator_capabilities" => projects::capabilities(&cx, &args).await,
        "t3_project_list" => projects::list(&cx, &args).await,
        "t3_project_read" => projects::read(&cx, &args).await,
        "t3_environment_read" => Ok(projects::environment(&cx)),
        "t3_thread_list" => threads::list(&cx, &args).await,
        "t3_thread_read" => threads::read(&cx, &args).await,
        "t3_thread_search" => threads::search(&cx, &args).await,
        "t3_thread_launch" => threads::launch(&cx, &args).await,
        "t3_thread_send" => threads::send(&cx, &args).await,
        "t3_thread_wait" => threads::wait(&cx, &args).await,
        "t3_thread_interrupt" => threads::interrupt(&cx, &args).await,
        "t3_thread_update" => threads::update(&cx, &args).await,
        "t3_pending_request" => threads::pending_request(&cx, &args).await,
        "delegate_task" => tasks::delegate(&cx, &args).await,
        "task_status" => tasks::status(&cx, &args).await,
        "task_cancel" => tasks::cancel(&cx, &args).await,
        other => Err(fail(
            "capability_denied",
            format!("conn-server does not serve `{other}` yet."),
        )),
    }
}

/// One call's context.
pub(crate) struct Cx<'a> {
    service: &'a Arc<McpService>,
    caller: &'a Caller,
}

pub(crate) const RUNTIME_MODES: [&str; 4] = [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
];

pub(crate) fn runtime_rank(mode: &str) -> usize {
    RUNTIME_MODES.iter().position(|m| *m == mode).unwrap_or(0)
}

pub(crate) fn interaction_rank(mode: &str) -> usize {
    usize::from(mode != "plan")
}

/// The broadest modes the caller may start or drive threads in.
pub(crate) struct Limits {
    pub runtime_mode: String,
    pub interaction_mode: String,
}

impl Cx<'_> {
    fn config(&self) -> &McpConfig {
        &self.service.config
    }

    fn engine(&self) -> &dyn conn_engine::Engine {
        self.service.config.engine.as_ref()
    }

    fn caller_thread_id(&self) -> Option<&str> {
        match self.caller {
            Caller::Thread(thread) => Some(&thread.thread_id),
            Caller::Client(_) => None,
        }
    }

    fn link(&self, thread_id: &str, title: &str) -> String {
        crate::links::thread_link(self.config(), self.caller, thread_id, title)
    }

    /// TS refuses writes from a client approved read-only before anything else runs.
    fn require_write(&self) -> Result<(), ToolError> {
        match self.caller {
            Caller::Client(client) if client.max_runtime_mode.is_none() => Err(fail(
                "capability_denied",
                "This tool changes the environment, and this MCP client was approved for read-only access.",
            )),
            _ => Ok(()),
        }
    }

    /// Tools that act as the calling thread.
    fn require_thread(&self, operation: &str) -> Result<&crate::ThreadCaller, ToolError> {
        match self.caller {
            Caller::Thread(thread) => Ok(thread),
            Caller::Client(_) => Err(fail(
                "thread_credential_required",
                format!(
                    "{operation} acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread."
                ),
            )),
        }
    }

    pub(crate) async fn projection(&self, thread_id: &str) -> ToolResult {
        match self
            .engine()
            .get_thread_projection(ThreadId::from(thread_id))
            .await
        {
            Ok(projection) if projection["thread"]["deletedAt"].is_null() => Ok(projection),
            Ok(_) | Err(EngineError::Rejected(_)) => Err(fail(
                "thread_not_found",
                format!("Thread {thread_id} is no longer available."),
            )),
            Err(EngineError::Internal(message)) => Err(internal(message)),
        }
    }

    /// The caller's own thread, for thread callers.
    async fn caller_projection(&self) -> Result<Option<Value>, ToolError> {
        match self.caller_thread_id() {
            Some(id) => self.projection(id).await.map(Some),
            None => Ok(None),
        }
    }

    async fn shell(&self) -> ToolResult {
        self.engine()
            .shell_snapshot()
            .await
            .map_err(|error| match error {
                EngineError::Rejected(_) => internal("The shell snapshot was refused."),
                EngineError::Internal(message) => internal(message),
            })
    }

    async fn limits(&self) -> Result<Limits, ToolError> {
        match self.caller {
            Caller::Thread(_) => {
                let own = self.caller_projection().await?.unwrap_or(Value::Null);
                let thread = &own["thread"];
                Ok(Limits {
                    runtime_mode: thread["runtimeMode"]
                        .as_str()
                        .unwrap_or("approval-required")
                        .to_owned(),
                    interaction_mode: thread["interactionMode"]
                        .as_str()
                        .unwrap_or("default")
                        .to_owned(),
                })
            }
            Caller::Client(client) => Ok(Limits {
                runtime_mode: client
                    .max_runtime_mode
                    .unwrap_or("approval-required")
                    .to_owned(),
                interaction_mode: "default".to_owned(),
            }),
        }
    }

    /// TS `writingCaller`: refuses a read-only client, then a thread caller that no longer
    /// owns a live run (`loadCaller`, `assertLiveCaller`). Returns the caller's limits.
    async fn writing_caller(&self) -> Result<Limits, ToolError> {
        self.require_write()?;
        let Caller::Thread(caller) = self.caller else {
            return self.limits().await;
        };
        let own = match self.projection(&caller.thread_id).await {
            Ok(projection) => projection,
            Err(ToolError::Failure {
                code: "thread_not_found",
                ..
            }) => {
                return Err(fail(
                    "thread_not_found",
                    "The calling thread was not found.",
                ));
            }
            Err(other) => return Err(other),
        };
        if !is_live_caller(&own, &caller.provider_instance_id) {
            return Err(fail(
                "parent_not_active",
                "The calling provider no longer owns an active thread run.",
            ));
        }
        let thread = &own["thread"];
        Ok(Limits {
            runtime_mode: thread["runtimeMode"]
                .as_str()
                .unwrap_or("approval-required")
                .to_owned(),
            interaction_mode: thread["interactionMode"]
                .as_str()
                .unwrap_or("default")
                .to_owned(),
        })
    }

    /// TS `writesThreads`: the writing caller's checks, then each named thread other than the
    /// caller's own may not run in broader modes than the caller. A thread that does not
    /// exist is left to the handler, which reports it.
    async fn writes_threads(&self, targets: &[Option<&str>]) -> Result<Limits, ToolError> {
        let limits = self.writing_caller().await?;
        for target in targets.iter().flatten() {
            if Some(*target) == self.caller_thread_id() {
                continue;
            }
            match self.projection(target).await {
                Ok(projection) => self.within_limits(&limits, &projection["thread"])?,
                Err(ToolError::Failure {
                    code: "thread_not_found",
                    ..
                }) => {}
                Err(other) => return Err(other),
            }
        }
        Ok(limits)
    }

    /// A target thread may not run with broader modes than the caller's.
    fn within_limits(&self, limits: &Limits, thread: &Value) -> Result<(), ToolError> {
        let runtime = thread["runtimeMode"]
            .as_str()
            .unwrap_or("approval-required");
        if runtime_rank(runtime) > runtime_rank(&limits.runtime_mode) {
            return Err(fail(
                "runtime_mode_escalation_denied",
                format!(
                    "Child runtime mode {runtime} is broader than parent mode {}.",
                    limits.runtime_mode
                ),
            ));
        }
        let interaction = thread["interactionMode"].as_str().unwrap_or("default");
        if interaction_rank(interaction) > interaction_rank(&limits.interaction_mode) {
            return Err(fail(
                "interaction_mode_escalation_denied",
                format!(
                    "Child interaction mode {interaction} is broader than parent mode {}.",
                    limits.interaction_mode
                ),
            ));
        }
        Ok(())
    }

    /// Dispatches one contract command; returns the sequence of its last event.
    async fn dispatch(&self, command: Value) -> Result<u64, ToolError> {
        let command: Command =
            from_json(command).map_err(|e| internal(format!("bad command: {e}")))?;
        match self.engine().dispatch(command).await {
            Ok(result) => Ok(conn_contract::to_json(&result)["sequence"]
                .as_u64()
                .unwrap_or(0)),
            Err(EngineError::Rejected(error)) => Err(fail(
                "orchestration_error",
                conn_contract::to_json(&error)["message"]
                    .as_str()
                    .unwrap_or("The command was refused.")
                    .to_owned(),
            )),
            Err(EngineError::Internal(message)) => Err(internal(message)),
        }
    }

    /// `clientRequestId`, or a fresh key: retries with the same id replay the first call.
    fn request_key(args: &Args) -> String {
        args.get("clientRequestId")
            .and_then(Value::as_str)
            .map_or_else(crate::uuid_v4, str::to_owned)
    }

    /// TS `stableCommandId`: `command:mcp:<namespace>:<operation>:<key>`, each part encoded.
    fn stable_id(&self, prefix: &str, operation: &str, key: &str) -> String {
        format!(
            "{prefix}:mcp:{}:{}:{}",
            encode(&self.caller.namespace()),
            encode(operation),
            encode(key)
        )
    }

    /// A fixed-length id from the caller and a key (TS `launchCommandId`).
    fn hashed_id(&self, prefix: &str, key: &str) -> String {
        let pair = json!([self.caller.namespace(), key]).to_string();
        let digest = Sha256::digest(pair.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        format!("{prefix}{hex}")
    }
}

/// Run statuses that make a run the thread's `activeRunId` (the engine's shell rule).
const ACTIVE_RUN_STATUSES: [&str; 4] = ["preparing", "starting", "running", "waiting"];

/// The thread shell's `activeRunId`, from a projection: the latest run that started (queued
/// runs and runs cancelled before they started do not count), if it is still active.
fn has_active_run(projection: &Value) -> bool {
    let Some(runs) = projection["runs"].as_array() else {
        return false;
    };
    runs.iter()
        .filter(|run| {
            let status = run["status"].as_str().unwrap_or_default();
            let never_started = status == "cancelled"
                && run["startedAt"].is_null()
                && run["activeAttemptId"].is_null();
            status != "queued" && !never_started
        })
        .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
        .is_some_and(|run| ACTIVE_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or("")))
}

/// TS `isLiveCallerShell`: an unarchived thread on the caller's provider instance with an
/// active run, or with a background subagent of that instance still pending (background
/// subagents keep their credential until the provider exits).
fn is_live_caller(projection: &Value, provider_instance_id: &str) -> bool {
    let thread = &projection["thread"];
    let background = thread["pendingBackgroundTasks"]
        .as_array()
        .is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task["kind"] == "subagent" && task["providerInstanceId"] == provider_instance_id
            })
        });
    thread["archivedAt"].is_null()
        && thread["providerInstanceId"] == provider_instance_id
        && (has_active_run(projection) || background)
}

/// `encodeURIComponent`.
fn encode(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for byte in part.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn internal(message: impl std::fmt::Display) -> ToolError {
    eprintln!("mcp: {message}");
    fail(
        "orchestration_error",
        "T3 Code could not complete this request.",
    )
}

fn str_arg<'a>(args: &'a Args, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn u64_arg(args: &Args, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn bool_arg(args: &Args, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}
