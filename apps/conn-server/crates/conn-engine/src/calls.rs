//! The RPC methods behind [`crate::Engine::call`] and [`crate::Engine::open_stream`]: one
//! line per tag in [`METHODS`] and one arm in [`call`] or [`open_stream`].

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::engine::Inner;
use crate::projects::ProjectFailure;
use crate::{EngineError, Subscription};

pub(crate) const METHODS: &[&str] = &[
    "mcpApps.callTool",
    "mcpApps.toolInfo",
    "mcpApps.readResource",
    "mcpApps.updateModelContext",
    "orchestration.getArchivedShellSnapshot",
    "orchestration.getOlderSettledThreads",
    "orchestration.getThreadTitles",
    "orchestration.getThreadLinkMetadata",
    "orchestration.getThreadFamily",
    "orchestration.getTurnItem",
    "orchestration.getTurnDiff",
    "orchestration.getFullThreadDiff",
    "orchestration.getWorktreeThreadIds",
    "orchestration.getNativeChildWork",
    "orchestration.searchThread",
    "orchestration.searchThreads",
    "orchestration.forceStopThread",
    "orchestration.stopWorkflow",
    "orchestration.searchThreadStream",
    "orchestration.subscribeCommandOutput",
    "orchestration.subscribePromptSuggestion",
    "projects.mutate",
    "projects.ensureScratch",
    "projects.createNew",
    "projects.createFromThread",
];

type CallResult = Result<Value, EngineError<Value>>;

/// `OrchestrationDispatchCommandError`, the error of the `projects.create*` methods.
fn dispatch_error(failure: ProjectFailure) -> EngineError<Value> {
    if failure.internal {
        return EngineError::Internal(failure.message);
    }
    let mut error =
        json!({"_tag": "OrchestrationDispatchCommandError", "message": failure.message});
    if let Some(cause) = failure.cause {
        error["cause"] = cause;
    }
    EngineError::Rejected(error)
}

/// `ProjectMutationError`: the cause's message only for a non-empty project, as in `ws.ts`.
fn mutation_error(command_id: &Value, failure: ProjectFailure) -> EngineError<Value> {
    if failure.internal {
        return EngineError::Internal(failure.message);
    }
    let generic = || "Failed to mutate project.".to_owned();
    let (message, cause) = match failure.cause {
        Some(cause) if cause["_tag"] == "ProjectNotEmptyError" => (failure.message, cause),
        Some(cause) => (generic(), cause),
        None => (generic(), json!({"message": failure.message})),
    };
    let mut error = json!({
        "_tag": "ProjectMutationError",
        "commandId": command_id,
        "message": message,
    });
    error["cause"] = cause;
    EngineError::Rejected(error)
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn tagged(tag: &str, message: String) -> EngineError<Value> {
    EngineError::Rejected(json!({"_tag": tag, "message": message}))
}

/// A read on the database thread. A store failure becomes the method's typed error `tag`.
async fn read(
    inner: &Arc<Inner>,
    tag: &'static str,
    f: impl FnOnce(&crate::store::Store) -> Result<Value, String> + Send + 'static,
) -> CallResult {
    inner
        .db(move |store| f(store))
        .await
        .map_err(|e| tagged(tag, e))
}

const SHELL_ERROR: &str = "OrchestrationV2GetShellSnapshotError";

pub(crate) async fn call(inner: Arc<Inner>, method: String, input: Value) -> CallResult {
    match method.as_str() {
        "mcpApps.callTool"
        | "mcpApps.toolInfo"
        | "mcpApps.readResource"
        | "mcpApps.updateModelContext" => inner.mcp_app_request(&method, input).await,
        "orchestration.getArchivedShellSnapshot" => {
            read(&inner, SHELL_ERROR, |s| s.archived_shell_snapshot()).await
        }
        "orchestration.getOlderSettledThreads" => {
            read(&inner, SHELL_ERROR, move |s| {
                s.older_settled_threads(&input)
            })
            .await
        }
        "orchestration.getThreadTitles" => {
            let ids = strings(&input["threadIds"]);
            read(&inner, SHELL_ERROR, move |s| s.thread_titles(&ids)).await
        }
        "orchestration.getThreadLinkMetadata" => {
            let ids = strings(&input["threadIds"]);
            read(&inner, SHELL_ERROR, move |s| s.thread_link_metadata(&ids)).await
        }
        "orchestration.getThreadFamily" => {
            let id = input["threadId"].as_str().unwrap_or_default().to_owned();
            read(&inner, SHELL_ERROR, move |s| s.thread_family(&id)).await
        }
        "orchestration.getWorktreeThreadIds" => {
            let path = input["worktreePath"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            read(&inner, SHELL_ERROR, move |s| s.worktree_thread_ids(&path)).await
        }
        "orchestration.getTurnItem" => {
            let thread_id = input["threadId"].as_str().unwrap_or_default().to_owned();
            let item_id = input["itemId"].as_str().unwrap_or_default().to_owned();
            let tid = thread_id.clone();
            inner
                .db(move |s| s.turn_item(&tid, &item_id))
                .await
                .map(|item| json!({"item": item}))
                .map_err(|_| {
                    EngineError::Rejected(json!({"_tag": "OrchestrationV2GetThreadProjectionError",
                        "threadId": thread_id, "message": "Failed to load turn item"}))
                })
        }
        "orchestration.getTurnDiff" => {
            inner
                .checkpoint_diff(crate::checkpoint::DiffMethod::Turn, input)
                .await
        }
        "orchestration.getFullThreadDiff" => {
            inner
                .checkpoint_diff(crate::checkpoint::DiffMethod::FullThread, input)
                .await
        }
        // Native child work is an Antigravity profile read; no provider here has one.
        "orchestration.getNativeChildWork" => Ok(json!({"children": []})),
        "orchestration.searchThread" => {
            inner
                .db(move |s| s.search_thread(&input))
                .await
                .map_err(|e| {
                    EngineError::Rejected(
                        json!({"_tag": "OrchestrationV2SearchThreadError", "cause": e}),
                    )
                })
        }
        "orchestration.searchThreads" => {
            read(&inner, "OrchestrationSearchThreadsError", move |s| {
                s.search_threads(&input)
            })
            .await
        }
        "orchestration.stopWorkflow" => inner.stop_workflow(input).await,
        "orchestration.forceStopThread" => inner.force_stop(input).await,
        "projects.mutate" => {
            let command_id = input["commandId"].clone();
            inner
                .project_mutate(input)
                .await
                .map_err(|f| mutation_error(&command_id, f))
        }
        "projects.ensureScratch" => inner.project_ensure_scratch().await.map_err(dispatch_error),
        "projects.createNew" => inner
            .project_create_new(input)
            .await
            .map_err(dispatch_error),
        "projects.createFromThread" => inner
            .project_create_from_thread(input)
            .await
            .map_err(dispatch_error),
        other => Err(EngineError::Internal(format!(
            "this engine does not support {other}"
        ))),
    }
}

pub(crate) async fn open_stream(
    inner: Arc<Inner>,
    method: String,
    input: Value,
) -> Result<Subscription<Value, Value>, EngineError<Value>> {
    let (tx, rx) = mpsc::channel(4);
    match method.as_str() {
        // One complete result: the search is fast enough not to need partial ones.
        "orchestration.searchThreadStream" => {
            let result = inner.db(move |s| s.search_thread(&input)).await;
            let item =
                result.map_err(|e| json!({"_tag": "OrchestrationV2SearchThreadError", "cause": e}));
            let _ = tx.try_send(item);
        }
        // No provider here makes prompt suggestions: say "none" once and stay open, as a
        // stream that ends would make the client subscribe again.
        "orchestration.subscribePromptSuggestion" => {
            let _ = tx.try_send(Ok(Value::Null));
            tokio::spawn(async move { tx.closed().await });
        }
        "orchestration.subscribeCommandOutput" => {
            crate::output::spawn(inner, input, tx).await?;
        }
        other => {
            return Err(EngineError::Internal(format!(
                "this engine does not support {other}"
            )));
        }
    }
    Ok(rx)
}
