//! The engine API: the three calls a Conn client makes to work with threads.
//!
//! | RPC method                        | Engine call             |
//! |-----------------------------------|-------------------------|
//! | `orchestration.dispatchCommand`   | [`Engine::dispatch`]     |
//! | `orchestration.subscribeShell`    | [`Engine::subscribe_shell`]  |
//! | `orchestration.subscribeThread`   | [`Engine::subscribe_thread`] |
//!
//! Commands, stream items and errors are the contract types from `conn-contract`, so the
//! server passes them through without knowing their shape. The engine owns the event store,
//! the projections, and the providers it drives (`conn-provider`).
//!
//! [`SqliteEngine`] implements it on SQLite. The three stream and dispatch signatures are
//! fixed; the other methods back `orchestration.launchThread`, `getThreadProjection` and the
//! HTTP snapshots, and use JSON until `conn-contract` has their types.

#![recursion_limit = "256"]

use std::{future::Future, pin::Pin};

mod background;
mod background_wait;
mod calls;
mod checkpoint;
mod clock;
mod commands;
mod engine;
mod guard;
mod mcp_apps;
mod thread_locks;

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-engine lock poisoned")
}

#[cfg(test)]
mod engine_tests;
#[cfg(any(test, feature = "fake-provider"))]
pub mod fake;
mod families;
mod fork;
mod fresh;
mod html_cleanup;
mod output;
mod projects;
mod pull_requests;
mod push;
mod reads;
mod restart;
mod rollback;
mod runner;
mod secret_requests;
mod shell;
mod store;
mod streaming;
mod streams;
mod time;
mod titles;
pub use conn_provider::tool_output;
mod visibility;

pub use background_wait::{BackgroundWait, BackgroundWaitError};
pub use clock::{Clock, ManualClock, SystemClock};
pub use engine::{
    CommandOutputTap, DEFAULT_IDLE_SESSION, EngineConfig, ProjectConfig, RuntimePolicyOverride,
    SqliteEngine,
};
pub use guard::{
    CommitDecision, CommitGate, DispatchGuard, GuardRule, OwnedMessage, is_frozen_message,
};
pub use streaming::ResponseStreamingMode;

/// What a [`TitleGenerator`] titles: the first message of a new thread, or a whole thread whose
/// title the user asked to regenerate.
#[derive(Clone, Debug, PartialEq)]
pub struct TitleRequest {
    pub thread_id: String,
    /// The thread's project, whose settings may choose another model.
    pub project_id: Option<String>,
    /// The folder the thread works in, for a generator that reads linked files.
    pub cwd: Option<String>,
    /// The project's title, which a good thread title does not repeat.
    pub project_title: Option<String>,
    pub kind: TitleKind,
}

/// One finished message: its role, text and attachments (`ChatAttachment` objects).
#[derive(Clone, Debug, PartialEq)]
pub struct TitleMessage {
    pub role: String,
    pub text: String,
    pub attachments: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TitleKind {
    /// The thread's first user message.
    Initial { message: TitleMessage },
    /// The current title and the thread's finished user and assistant messages, oldest
    /// first. The generator chooses what fits (`formatThreadTitleContext`).
    Regenerate {
        previous_title: String,
        messages: Vec<TitleMessage>,
    },
}

/// Where a turn starts or ends, for a [`TurnObserver`].
#[derive(Clone, Debug, PartialEq)]
pub struct TurnPoint {
    pub thread_id: String,
    pub run_id: String,
    /// 1 for the thread's first run; checkpoint `n` is the workspace after run `n`.
    pub run_ordinal: u64,
    pub root_node_id: String,
    /// The folder the turn works in: the thread's worktree, else its project root.
    pub cwd: Option<String>,
}

/// Watches turns start and end; the hook for per-turn git checkpoints (`getTurnDiff`,
/// `getFullThreadDiff`, restore).
///
/// [`TurnObserver::turn_started`] runs after the run is `running` and before the provider
/// gets the message, and the turn waits for it: a baseline taken there holds no change of this
/// turn. [`TurnObserver::turn_ended`] runs after the run's final status is committed, once per
/// run that started (`completed`, `interrupted`, `failed` or `cancelled`), off the turn's path.
/// A failing observer must log and return; it cannot fail the turn. Wire one with
/// [`EngineConfig::turn_observer`].
pub trait TurnObserver: Send + Sync {
    fn turn_started(&self, point: TurnPoint) -> BoxFuture<'_, ()>;
    fn turn_ended(&self, point: TurnPoint, status: String) -> BoxFuture<'_, ()>;
}

/// The server's services the engine calls out to. Every method has a no-op default, so a test
/// or a server without the service passes nothing. Wire one with [`EngineConfig::host`].
pub trait EngineHost: Send + Sync {
    /// MCP servers for a provider session about to open, and the key that revokes them.
    fn agent_tools(&self, _session: AgentSession) -> Option<AgentTools> {
        None
    }

    /// A provider session closed: revoke what [`EngineHost::agent_tools`] issued under `key`.
    fn session_closed(&self, _key: &str) {}

    /// The host handle a new provider session gets for its agent's file and terminal
    /// callbacks (`ProviderHost`). `None`: the server offers none (today's server).
    fn provider_host(&self, _session: AgentSession) -> Option<conn_provider::HostHandle> {
        None
    }

    /// `resolveProjectProviderInstanceEnabled` from the server's settings: whether a command
    /// may start work on `instance_id` in `project_id`. A disabled one refuses the command at
    /// dispatch, as T3's `assertDispatchTargetEnabled` does. The default allows all.
    fn provider_instance_enabled(&self, _project_id: Option<&str>, _instance_id: &str) -> bool {
        true
    }

    /// `responseStreamingMode` of `project_id` (`resolveProjectSettings`): how streamed
    /// assistant text is stored. The default is T3's default, `paragraph`.
    fn response_streaming_mode(&self, _project_id: Option<&str>) -> ResponseStreamingMode {
        ResponseStreamingMode::Paragraph
    }

    /// Copies a message's pending uploads to the thread before the message is written. The
    /// result replaces the command's `attachments`; an error refuses the command.
    fn claim_attachments(
        &self,
        _thread_id: String,
        attachments: Value,
    ) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(std::future::ready(Ok(attachments)))
    }

    /// The message that claimed `attachments` was refused: remove the copies.
    fn release_attachments(&self, _attachments: Value) -> BoxFuture<'_, ()> {
        Box::pin(std::future::ready(()))
    }

    /// Stores a bounded, sandboxed MCP App document as a thread attachment.
    fn snapshot_mcp_app(
        &self,
        _thread: String,
        _source: conn_provider::mcp_apps::Source,
        _contents: Value,
    ) -> BoxFuture<'_, Result<Option<Value>, String>> {
        Box::pin(async { Ok(None) })
    }

    /// Creates a git worktree for `launchThread` with a `worktree` strategy.
    fn provision_worktree(
        &self,
        _request: WorktreeRequest,
    ) -> BoxFuture<'_, Result<ProvisionedWorktree, String>> {
        Box::pin(std::future::ready(Err(
            "This server cannot create worktrees.".to_owned(),
        )))
    }

    /// The branch checked out in `cwd` (`GitWorkflowService.currentBranch`): `None` when HEAD
    /// is detached, the folder is no checkout, or git fails. A project-folder launch that
    /// names no branch records it. The default knows none.
    fn current_branch(&self, _cwd: &str) -> BoxFuture<'_, Option<String>> {
        Box::pin(std::future::ready(None))
    }

    /// Removes HTML pages whose owning thread and visible forks no longer use them.
    fn cleanup_html_attachments(&self, _ids: Vec<(String, String)>) -> BoxFuture<'_, ()> {
        Box::pin(std::future::ready(()))
    }

    /// A thread was archived, deleted or settled; end what it holds open (terminals).
    fn thread_closed(&self, _thread_id: &str, _reason: ThreadClose) {}
}

/// A provider session asking for agent tools.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentSession {
    pub thread_id: String,
    pub project_id: Option<String>,
    pub provider_instance_id: String,
    /// The thread is a delegated child (`lineage.relationshipToParent: subagent`).
    pub subagent: bool,
}

/// What [`EngineHost::agent_tools`] grants one provider session.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentTools {
    pub servers: Vec<conn_provider::McpServer>,
    /// Passed back to [`EngineHost::session_closed`].
    pub key: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorktreeRequest {
    pub thread_id: String,
    pub project_root: String,
    pub base_ref: String,
    pub branch: Option<String>,
    pub start_from_origin: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProvisionedWorktree {
    pub path: String,
    pub branch: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadClose {
    Archived,
    Deleted,
    Settled,
}

/// Asks a small model for a thread title (`generateTitle`, `regenerateTitle`). The engine
/// keeps the seed title when this fails. Wire one with [`EngineConfig::title_generator`].
pub trait TitleGenerator: Send + Sync {
    fn generate(&self, request: TitleRequest) -> BoxFuture<'_, Result<String, String>>;
}

use conn_contract::{
    Command, DispatchCommandError, DispatchCommandResult, GetShellSnapshotError,
    GetThreadProjectionError, ShellStreamItem, SubscribeShellInput, SubscribeThreadInput, ThreadId,
    ThreadStreamItem,
};
use serde_json::Value;
use tokio::sync::mpsc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A live stream for one client subscription.
///
/// Items arrive in order. An `Err` item ends the stream with that typed error; a closed
/// channel ends it successfully. Dropping the receiver unsubscribes. Use a small bound
/// (16 is plenty): the server forwards items only as fast as the client acknowledges them.
pub type Subscription<T, E> = mpsc::Receiver<Result<T, E>>;

/// Why an engine call failed.
#[derive(Clone, Debug, PartialEq)]
pub enum EngineError<E> {
    /// A typed contract error. The client receives it as a `Fail` exit.
    Rejected(E),
    /// A bug or broken invariant. The client receives it as a `Die` exit.
    Internal(String),
}

pub trait Engine: Send + Sync {
    /// The project's provider policy, before selecting an instance by driver.
    fn provider_instance_enabled(&self, _project_id: &str, _instance_id: &str) -> bool {
        true
    }
    /// Whether a command already committed; retries must use its recorded target.
    fn has_receipt<'a>(&'a self, _command_id: &'a str) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(std::future::ready(Ok(false)))
    }

    /// The status in a command's original run.created event, including a replayed receipt.
    fn created_run_status<'a>(
        &'a self,
        _command_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(std::future::ready(Ok(None)))
    }

    /// Decides, persists and applies one command. Resolves once its events are committed,
    /// with the sequence of the last event, so a client can wait for it on its streams.
    fn dispatch(
        &self,
        command: Command,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>>;

    /// [`Engine::dispatch`] with an ownership check that runs atomically with the command
    /// ([`DispatchGuard`]). A replay of an accepted command ID is refused. An engine that
    /// cannot check refuses every guarded command.
    fn dispatch_guarded(
        &self,
        _command: Command,
        _guard: DispatchGuard,
        _commit_gate: Option<std::sync::Arc<dyn CommitGate>>,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>> {
        Box::pin(std::future::ready(Err(EngineError::Internal(
            "this engine cannot check command ownership".into(),
        ))))
    }

    /// Whether a thread with this ID was ever deleted, so its ID may carry an earlier
    /// thread's rows. An engine that cannot tell answers `true`.
    fn thread_ever_deleted(&self, _thread_id: &str) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(std::future::ready(Ok(true)))
    }

    /// The shell stream: projects and thread summaries. Starts with a `snapshot` item (or
    /// replays from `afterSequence`), then `synchronized`, then live updates.
    fn subscribe_shell(
        &self,
        input: SubscribeShellInput,
    ) -> BoxFuture<
        '_,
        Result<
            Subscription<ShellStreamItem, GetShellSnapshotError>,
            EngineError<GetShellSnapshotError>,
        >,
    >;

    /// One thread's stream: a `snapshot` of its projection (or a replay from
    /// `afterSequence`), then `synchronized`, then live `event` items.
    fn subscribe_thread(
        &self,
        input: SubscribeThreadInput,
    ) -> BoxFuture<
        '_,
        Result<
            Subscription<ThreadStreamItem, GetThreadProjectionError>,
            EngineError<GetThreadProjectionError>,
        >,
    >;

    /// `orchestration.launchThread`: creates a thread and sends its first message in one call,
    /// which is how a client starts a new thread. Input `OrchestrationV2ThreadLaunchInput`,
    /// result `OrchestrationV2ThreadLaunchResult`, error `OrchestrationV2ThreadLaunchError`.
    fn launch_thread(&self, _input: Value) -> BoxFuture<'_, Result<Value, EngineError<Value>>> {
        unsupported("orchestration.launchThread")
    }

    /// `orchestration.getThreadProjection`: `OrchestrationV2ThreadProjection`.
    fn get_thread_projection(
        &self,
        _thread_id: ThreadId,
    ) -> BoxFuture<'_, Result<Value, EngineError<GetThreadProjectionError>>> {
        unsupported("orchestration.getThreadProjection")
    }

    /// `GET /api/orchestration/shell`: `OrchestrationV2ShellSnapshot`.
    fn shell_snapshot(&self) -> BoxFuture<'_, Result<Value, EngineError<GetShellSnapshotError>>> {
        unsupported("the shell snapshot")
    }

    /// Live project summaries, without loading thread projections.
    fn projects_snapshot(
        &self,
    ) -> BoxFuture<'_, Result<Vec<Value>, EngineError<GetShellSnapshotError>>> {
        Box::pin(async move {
            let shell = self.shell_snapshot().await?;
            Ok(shell
                .get("projects")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default())
        })
    }

    /// The unary and stream RPC methods [`Engine::call`] and [`Engine::open_stream`] serve, by
    /// tag. The server registers each one; the rest answer "not supported".
    fn methods(&self) -> &'static [&'static str] {
        &[]
    }

    /// A unary method from [`Engine::methods`] (`projects.mutate`, `orchestration.searchThreads`,
    /// ...). Input and output are the contract's JSON for that tag; `Rejected` holds the
    /// method's typed error.
    fn call(
        &self,
        method: &str,
        _input: Value,
    ) -> BoxFuture<'_, Result<Value, EngineError<Value>>> {
        let method = method.to_owned();
        Box::pin(async move {
            Err(EngineError::Internal(format!(
                "this engine does not support {method}"
            )))
        })
    }

    /// A stream method from [`Engine::methods`], with the same JSON rules as [`Engine::call`].
    fn open_stream(
        &self,
        method: &str,
        _input: Value,
    ) -> BoxFuture<'_, Result<Subscription<Value, Value>, EngineError<Value>>> {
        let method = method.to_owned();
        Box::pin(async move {
            Err(EngineError::Internal(format!(
                "this engine does not support {method}"
            )))
        })
    }

    /// `thread.pull-request-watch.sync`: what the server's watch loop read, and its wake. Not a
    /// client command, so it never goes through [`Engine::dispatch`].
    fn sync_pull_request_watch(&self, _command: Value) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(std::future::ready(Err(
            "Pull request watches are not supported.".into(),
        )))
    }

    /// Records a secret card without exposing an internal command through client dispatch.
    fn record_secret_request(&self, _input: Value) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(std::future::ready(Err(
            "Secret requests are not supported.".into(),
        )))
    }

    /// Closes every provider session before the server exits, so no provider process, nor a
    /// tool it started, outlives the server.
    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(std::future::ready(()))
    }

    /// Marks that shutdown began, at the signal, before the server drains its connections and
    /// calls [`Engine::shutdown`]. From then on a provider session that ends ends no run: under
    /// systemd the stop signal reaches the provider processes too, and a run they leave open
    /// is continued by the next start, as T3 does.
    fn begin_shutdown(&self) {}

    /// `GET /api/orchestration/threads/:threadId`: `OrchestrationV2ThreadDetailSnapshot`, or
    /// `None` for an unknown thread (404).
    fn thread_snapshot(
        &self,
        _thread_id: ThreadId,
    ) -> BoxFuture<'_, Result<Option<Value>, EngineError<GetThreadProjectionError>>> {
        unsupported("the thread snapshot")
    }

    /// `ThreadManagementService.awaitBackgroundTasks`: the live session of the thread's
    /// active provider thread marks (`awaited`) or clears these background task ids. Answers
    /// the matched and unmatched ids; see [`BackgroundWaitError`] for the refusals.
    fn await_background_tasks(
        &self,
        _thread_id: ThreadId,
        _task_ids: Vec<String>,
        _awaited: bool,
    ) -> BoxFuture<'_, Result<BackgroundWait, BackgroundWaitError>> {
        Box::pin(std::future::ready(Err(BackgroundWaitError::Unavailable)))
    }
}

fn unsupported<T: Send + 'static, E: Send + 'static>(
    what: &'static str,
) -> BoxFuture<'static, Result<T, EngineError<E>>> {
    Box::pin(async move {
        Err(EngineError::Internal(format!(
            "this engine does not support {what}"
        )))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_contract::{from_json, to_json};
    use serde_json::json;
    use std::sync::Mutex;
    use tokio::sync::broadcast;

    /// A toy engine: every command becomes one shell update.
    struct ToyEngine {
        sequence: Mutex<u64>,
        live: broadcast::Sender<ShellStreamItem>,
    }

    impl Engine for ToyEngine {
        fn dispatch(
            &self,
            command: Command,
        ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>>
        {
            Box::pin(async move {
                if to_json(&command)["type"] != "thread.create" {
                    return Err(EngineError::Rejected(
                        from_json(json!({"_tag": "OrchestrationV2DispatchCommandError",
                            "commandId": "c", "commandType": "x", "message": "toy"}))
                        .unwrap(),
                    ));
                }
                let sequence = {
                    let mut s = self.sequence.lock().unwrap();
                    *s += 1;
                    *s
                };
                // A real engine sends `thread.updated` with the full summary.
                let item = json!({"kind": "thread.removed", "sequence": sequence,
                                  "location": "active", "threadId": to_json(&command)["threadId"]});
                let _ = self.live.send(from_json(item).unwrap());
                Ok(from_json(json!({ "sequence": sequence })).unwrap())
            })
        }

        fn subscribe_shell(
            &self,
            _input: SubscribeShellInput,
        ) -> BoxFuture<
            '_,
            Result<
                Subscription<ShellStreamItem, GetShellSnapshotError>,
                EngineError<GetShellSnapshotError>,
            >,
        > {
            Box::pin(async move {
                let (tx, rx) = mpsc::channel(16);
                let mut live = self.live.subscribe();
                tokio::spawn(async move {
                    for item in [
                        json!({"kind": "snapshot-required"}),
                        json!({"kind": "synchronized"}),
                    ] {
                        if tx.send(Ok(from_json(item).unwrap())).await.is_err() {
                            return;
                        }
                    }
                    while let Ok(item) = live.recv().await {
                        if tx.send(Ok(item)).await.is_err() {
                            return;
                        }
                    }
                });
                Ok(rx)
            })
        }

        fn subscribe_thread(
            &self,
            _input: SubscribeThreadInput,
        ) -> BoxFuture<
            '_,
            Result<
                Subscription<ThreadStreamItem, GetThreadProjectionError>,
                EngineError<GetThreadProjectionError>,
            >,
        > {
            Box::pin(async {
                Err(EngineError::Rejected(
                    from_json(json!({"_tag": "OrchestrationV2GetThreadProjectionError",
                                "threadId": "t", "message": "toy"}))
                    .unwrap(),
                ))
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shell_stream_shows_a_dispatched_thread() {
        let engine: Box<dyn Engine> = Box::new(ToyEngine {
            sequence: Mutex::new(0),
            live: broadcast::channel(16).0,
        });
        let mut shell = engine
            .subscribe_shell(from_json(json!({})).unwrap())
            .await
            .unwrap();
        let kind = |item: Result<ShellStreamItem, _>| to_json(&item.unwrap())["kind"].clone();
        assert_eq!(kind(shell.recv().await.unwrap()), "snapshot-required");
        assert_eq!(kind(shell.recv().await.unwrap()), "synchronized");

        let command = json!({
            "type": "thread.create", "commandId": "c1", "threadId": "t1", "projectId": "p1",
            "title": "T", "modelSelection": {"instanceId": "claudeAgent", "model": "m"},
            "runtimeMode": "full-access", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdBy": "user", "creationSource": "web",
        });
        let result = engine.dispatch(from_json(command).unwrap()).await.unwrap();
        assert_eq!(to_json(&result), json!({"sequence": 1}));
        let update = to_json(&shell.recv().await.unwrap().unwrap());
        assert_eq!(update["threadId"], "t1");

        let bad = json!({"type": "thread.stop", "commandId": "c2", "threadId": "t1"});
        assert!(matches!(
            engine.dispatch(from_json(bad).unwrap()).await,
            Err(EngineError::Rejected(_))
        ));
    }
}

mod workflows;
