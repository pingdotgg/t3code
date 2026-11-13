//! `orchestration.*` methods, backed by [`conn_engine::Engine`]. Owner: track (d), engine.

use std::sync::Arc;

use conn_contract::{Command, SubscribeShellInput, SubscribeThreadInput, ThreadId, to_json};
use conn_engine::{Engine, EngineError, Subscription};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use super::Deps;
use crate::table::{Failure, ItemStream, MethodTable};

fn failure<E: Serialize>(error: EngineError<E>) -> Failure {
    match error {
        EngineError::Rejected(error) => Failure::fail(&error),
        EngineError::Internal(message) => Failure::die(message),
    }
}

/// Re-encodes a typed engine subscription as the table's JSON item stream.
fn forward<T: Serialize + Send + 'static, E: Serialize + Send + 'static>(
    mut items: Subscription<T, E>,
) -> ItemStream {
    let (tx, rx) = mpsc::channel(16);
    tokio::spawn(async move {
        loop {
            let item = tokio::select! {
                _ = tx.closed() => return,
                item = items.recv() => item,
            };
            let Some(item) = item else { return };
            let ended = item.is_err();
            let item = item
                .map(|value| to_json(&value))
                .map_err(|e| Failure::fail(&e));
            if tx.send(item).await.is_err() || ended {
                return;
            }
        }
    });
    rx
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadIdInput {
    thread_id: ThreadId,
}

pub fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(engine) = deps.engine.clone() else {
        return;
    };
    let with = |engine: &Arc<dyn Engine>| engine.clone();

    let e = with(&engine);
    table.unary(
        "orchestration.dispatchCommand",
        move |_, command: Command| {
            let e = e.clone();
            async move { e.dispatch(command).await.map_err(failure) }
        },
    );
    let e = with(&engine);
    table.stream(
        "orchestration.subscribeShell",
        move |_, input: SubscribeShellInput| {
            let e = e.clone();
            async move { e.subscribe_shell(input).await.map(forward).map_err(failure) }
        },
    );
    let e = with(&engine);
    table.stream(
        "orchestration.subscribeThread",
        move |_, input: SubscribeThreadInput| {
            let e = e.clone();
            async move {
                e.subscribe_thread(input)
                    .await
                    .map(forward)
                    .map_err(failure)
            }
        },
    );
    let e = with(&engine);
    table.unary("orchestration.launchThread", move |_, input: Value| {
        let e = e.clone();
        async move { e.launch_thread(input).await.map_err(failure) }
    });
    let e = with(&engine);
    table.unary(
        "orchestration.getThreadProjection",
        move |_, input: ThreadIdInput| {
            let e = e.clone();
            async move {
                e.get_thread_projection(input.thread_id)
                    .await
                    .map_err(failure)
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::{CallContext, Handler};
    use conn_engine::{EngineConfig, ProjectConfig, SqliteEngine};
    use serde_json::json;

    #[tokio::test(flavor = "current_thread")]
    async fn serves_the_engine_over_json() {
        let dir = std::env::temp_dir().join(format!("conn-server-orch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![ProjectConfig {
            title: "P".into(),
            workspace_root: "/tmp/p".into(),
        }];
        let engine: Arc<dyn Engine> = Arc::new(SqliteEngine::open(config).unwrap());
        let deps = Deps {
            engine: Some(engine),
            providers: vec![],
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        for tag in [
            "orchestration.dispatchCommand",
            "orchestration.subscribeShell",
            "orchestration.subscribeThread",
            "orchestration.launchThread",
            "orchestration.getThreadProjection",
        ] {
            assert!(table.get(tag).is_some(), "{tag}");
        }

        let Some(Handler::Unary(dispatch)) = table.get("orchestration.dispatchCommand") else {
            panic!()
        };
        let create = json!({
            "type": "thread.create", "commandId": "c1", "threadId": "t1",
            "projectId": SqliteEngine::project_id_for("/tmp/p"), "title": "T",
            "modelSelection": {"instanceId": "claudeAgent", "model": "m"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
        });
        assert_eq!(
            dispatch(CallContext::default(), create).await,
            Ok(json!({"sequence": 2}))
        );
        let Err(Failure::Fail(error)) = dispatch(
            CallContext::default(),
            json!({"type": "thread.fork", "commandId": "c2"}),
        )
        .await
        else {
            panic!("expected a typed failure")
        };
        assert_eq!(error["_tag"], "OrchestrationV2DispatchCommandError");

        let Some(Handler::Stream(subscribe)) = table.get("orchestration.subscribeThread") else {
            panic!()
        };
        let mut items = subscribe(
            CallContext::default(),
            json!({"threadId": "t1", "requestCompletionMarker": true}),
        )
        .await
        .unwrap();
        assert_eq!(items.recv().await.unwrap().unwrap()["kind"], "snapshot");
        assert_eq!(
            items.recv().await.unwrap().unwrap(),
            json!({"kind": "synchronized"})
        );
        let missing = subscribe(CallContext::default(), json!({"threadId": "nope"})).await;
        assert!(matches!(missing, Err(Failure::Fail(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
