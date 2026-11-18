//! `orchestration.*` methods, backed by [`conn_engine::Engine`]. Owner: track (d), engine.

use std::sync::Arc;

use conn_contract::{Command, SubscribeShellInput, SubscribeThreadInput, ThreadId, to_json};
use conn_engine::{Engine, EngineError, Subscription};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
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
pub(crate) fn forward<T: Serialize + Send + 'static, E: Serialize + Send + 'static>(
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

/// Registers a unary method the engine serves through [`Engine::call`]. The payload decodes
/// into the contract's `P` first; the engine's answer must decode into `S` (or its error into
/// `E`), else the client gets a defect instead of a value it cannot read.
pub(super) fn engine_unary<P, S, E>(
    table: &mut MethodTable,
    engine: &Arc<dyn Engine>,
    tag: &'static str,
) where
    P: DeserializeOwned + Serialize + Send + 'static,
    S: DeserializeOwned + Serialize + 'static,
    E: DeserializeOwned + Serialize + 'static,
{
    let engine = engine.clone();
    table.unary(tag, move |_, input: P| {
        let engine = engine.clone();
        async move {
            match engine.call(tag, to_json(&input)).await {
                Ok(value) => conn_contract::from_json::<S>(value)
                    .map_err(|e| Failure::die(format!("{tag} built an invalid result: {e}"))),
                Err(EngineError::Rejected(error)) => match conn_contract::from_json::<E>(error) {
                    Ok(error) => Err(Failure::fail(&error)),
                    Err(e) => Err(Failure::die(format!("{tag} built an invalid error: {e}"))),
                },
                Err(EngineError::Internal(message)) => Err(Failure::die(message)),
            }
        }
    });
}

/// Registers a stream method the engine serves through [`Engine::open_stream`]; items decode
/// into `T` and a failure into `E`, as [`engine_unary`] does.
pub(super) fn engine_stream<P, T, E>(
    table: &mut MethodTable,
    engine: &Arc<dyn Engine>,
    tag: &'static str,
) where
    P: DeserializeOwned + Serialize + Send + 'static,
    T: DeserializeOwned + Serialize + Send + 'static,
    E: DeserializeOwned + Serialize + Send + 'static,
{
    let engine = engine.clone();
    table.stream(tag, move |_, input: P| {
        let engine = engine.clone();
        async move {
            let mut items = match engine.open_stream(tag, to_json(&input)).await {
                Ok(items) => items,
                Err(EngineError::Rejected(error)) => {
                    return Err(match conn_contract::from_json::<E>(error) {
                        Ok(error) => Failure::fail(&error),
                        Err(e) => Failure::die(format!("{tag} built an invalid error: {e}")),
                    });
                }
                Err(EngineError::Internal(message)) => return Err(Failure::die(message)),
            };
            let (tx, rx) = mpsc::channel(16);
            tokio::spawn(async move {
                loop {
                    let item = tokio::select! {
                        _ = tx.closed() => return,
                        item = items.recv() => item,
                    };
                    let Some(item) = item else { return };
                    let out = match item {
                        Ok(value) => conn_contract::from_json::<T>(value)
                            .map(|v| to_json(&v))
                            .map_err(|e| Failure::die(format!("{tag} built an invalid item: {e}"))),
                        Err(error) => Err(match conn_contract::from_json::<E>(error) {
                            Ok(error) => Failure::fail(&error),
                            Err(e) => Failure::die(format!("{tag} built an invalid error: {e}")),
                        }),
                    };
                    let ended = out.is_err();
                    if tx.send(out).await.is_err() || ended {
                        return;
                    }
                }
            });
            Ok(rx)
        }
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadIdInput {
    thread_id: ThreadId,
}

/// Registers one engine-served method with its contract types: `unary!(table, engine, name)`
/// for `orchestration.<camelName>` with module `rpc::orchestration::<name>`.
macro_rules! unary {
    ($table:expr, $engine:expr, $module:ident, $tag:literal) => {{
        use conn_contract::rpc::orchestration::$module as m;
        engine_unary::<m::Payload, m::Success, m::Error>($table, $engine, $tag);
    }};
}
macro_rules! stream {
    ($table:expr, $engine:expr, $module:ident, $tag:literal) => {{
        use conn_contract::rpc::orchestration::$module as m;
        engine_stream::<m::Payload, m::Item, m::Error>($table, $engine, $tag);
    }};
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(engine) = deps.engine.clone() else {
        return;
    };
    unary!(
        table,
        &engine,
        get_archived_shell_snapshot,
        "orchestration.getArchivedShellSnapshot"
    );
    unary!(
        table,
        &engine,
        get_older_settled_threads,
        "orchestration.getOlderSettledThreads"
    );
    unary!(
        table,
        &engine,
        get_thread_titles,
        "orchestration.getThreadTitles"
    );
    unary!(
        table,
        &engine,
        get_thread_link_metadata,
        "orchestration.getThreadLinkMetadata"
    );
    unary!(
        table,
        &engine,
        get_thread_family,
        "orchestration.getThreadFamily"
    );
    unary!(table, &engine, stop_workflow, "orchestration.stopWorkflow");
    table.unary(
        "orchestration.getWorkflowScript",
        |_, input: conn_contract::rpc::orchestration::get_workflow_script::Payload| async move {
            crate::workflow_script::get(input.script_path)
                .await
                .map_err(|error| Failure::fail(&error))
        },
    );
    unary!(table, &engine, get_turn_item, "orchestration.getTurnItem");
    unary!(table, &engine, get_turn_diff, "orchestration.getTurnDiff");
    unary!(
        table,
        &engine,
        get_full_thread_diff,
        "orchestration.getFullThreadDiff"
    );
    unary!(
        table,
        &engine,
        get_worktree_thread_ids,
        "orchestration.getWorktreeThreadIds"
    );
    unary!(
        table,
        &engine,
        get_native_child_work,
        "orchestration.getNativeChildWork"
    );
    unary!(table, &engine, search_thread, "orchestration.searchThread");
    unary!(
        table,
        &engine,
        search_threads,
        "orchestration.searchThreads"
    );
    unary!(
        table,
        &engine,
        force_stop_thread,
        "orchestration.forceStopThread"
    );
    stream!(
        table,
        &engine,
        search_thread_stream,
        "orchestration.searchThreadStream"
    );
    stream!(
        table,
        &engine,
        subscribe_command_output,
        "orchestration.subscribeCommandOutput"
    );
    stream!(
        table,
        &engine,
        subscribe_prompt_suggestion,
        "orchestration.subscribePromptSuggestion"
    );
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
            providers: conn_provider::ProviderSet::default(),
            ..Deps::default()
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
            json!({"type": "thread.stop", "commandId": "c2", "threadId": "nope"}),
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

        // Every engine read answers in its contract type (a mismatch would be a defect).
        for (tag, input) in [
            ("orchestration.getArchivedShellSnapshot", json!({})),
            (
                "orchestration.getOlderSettledThreads",
                json!({"before": {"settledAt": "2030-01-01T00:00:00.000Z"}, "limit": 5}),
            ),
            (
                "orchestration.getThreadTitles",
                json!({"threadIds": ["t1"]}),
            ),
            (
                "orchestration.getThreadLinkMetadata",
                json!({"threadIds": ["t1"]}),
            ),
            ("orchestration.getThreadFamily", json!({"threadId": "t1"})),
            (
                "orchestration.getTurnItem",
                json!({"threadId": "t1", "itemId": "x"}),
            ),
            (
                "orchestration.getWorktreeThreadIds",
                json!({"worktreePath": "/tmp/p"}),
            ),
            (
                "orchestration.getNativeChildWork",
                json!({"threadId": "t1"}),
            ),
            (
                "orchestration.searchThread",
                json!({"threadId": "t1", "query": "T"}),
            ),
            ("orchestration.searchThreads", json!({"query": "TT"})),
            ("orchestration.forceStopThread", json!({"threadId": "t1"})),
        ] {
            let Some(Handler::Unary(read)) = table.get(tag) else {
                panic!("{tag} is registered")
            };
            if let Err(e) = read(CallContext::default(), input).await {
                panic!("{tag}: {e:?}");
            }
        }
        let family = {
            let Some(Handler::Unary(read)) = table.get("orchestration.getThreadFamily") else {
                panic!()
            };
            read(CallContext::default(), json!({"threadId": "t1"}))
                .await
                .unwrap()
        };
        assert_eq!(family["threads"][0]["id"], "t1");
        for (tag, input) in [
            (
                "orchestration.searchThreadStream",
                json!({"threadId": "t1", "query": "T"}),
            ),
            (
                "orchestration.subscribePromptSuggestion",
                json!({"threadId": "t1"}),
            ),
        ] {
            let Some(Handler::Stream(open)) = table.get(tag) else {
                panic!("{tag} is registered")
            };
            let mut items = open(CallContext::default(), input).await.unwrap();
            assert!(items.recv().await.unwrap().is_ok(), "{tag}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
