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

mod calls;
mod commands;
mod engine;
#[cfg(test)]
mod engine_tests;
#[cfg(any(test, feature = "fake-provider"))]
pub mod fake;
mod families;
mod output;
mod projects;
mod reads;
mod restart;
mod runner;
mod shell;
mod store;
mod streams;
mod time;

pub use engine::{EngineConfig, ProjectConfig, SqliteEngine};

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
    /// Decides, persists and applies one command. Resolves once its events are committed,
    /// with the sequence of the last event, so a client can wait for it on its streams.
    fn dispatch(
        &self,
        command: Command,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>>;

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

    /// `GET /api/orchestration/threads/:threadId`: `OrchestrationV2ThreadDetailSnapshot`, or
    /// `None` for an unknown thread (404).
    fn thread_snapshot(
        &self,
        _thread_id: ThreadId,
    ) -> BoxFuture<'_, Result<Option<Value>, EngineError<GetThreadProjectionError>>> {
        unsupported("the thread snapshot")
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
