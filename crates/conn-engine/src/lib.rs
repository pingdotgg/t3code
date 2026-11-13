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
//! Track (d) implements this trait in this crate. The trait itself is fixed: change it only
//! with the integrator.

use std::{future::Future, pin::Pin};

use conn_contract::{
    Command, DispatchCommandError, DispatchCommandResult, GetShellSnapshotError,
    GetThreadProjectionError, ShellStreamItem, SubscribeShellInput, SubscribeThreadInput,
    ThreadStreamItem,
};
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
                if command.0["type"] != "thread.create" {
                    return Err(EngineError::Rejected(
                        from_json(json!({"_tag": "OrchestrationV2DispatchCommandError"})).unwrap(),
                    ));
                }
                let sequence = {
                    let mut s = self.sequence.lock().unwrap();
                    *s += 1;
                    *s
                };
                let item = json!({"kind": "thread.updated", "sequence": sequence,
                                  "thread": {"id": command.0["threadId"]}});
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
                        json!({"kind": "snapshot", "snapshot": {}}),
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
                    from_json(json!({"_tag": "OrchestrationV2GetThreadProjectionError"})).unwrap(),
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
        assert_eq!(kind(shell.recv().await.unwrap()), "snapshot");
        assert_eq!(kind(shell.recv().await.unwrap()), "synchronized");

        let command = json!({"type": "thread.create", "commandId": "c1", "threadId": "t1"});
        let result = engine.dispatch(from_json(command).unwrap()).await.unwrap();
        assert_eq!(to_json(&result), json!({"sequence": 1}));
        let update = to_json(&shell.recv().await.unwrap().unwrap());
        assert_eq!(update["thread"]["id"], "t1");

        let bad = json!({"type": "thread.stop", "commandId": "c2", "threadId": "t1"});
        assert!(matches!(
            engine.dispatch(from_json(bad).unwrap()).await,
            Err(EngineError::Rejected(_))
        ));
    }
}
