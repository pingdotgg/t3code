//! The RPC methods behind [`crate::Engine::call`] and [`crate::Engine::open_stream`]: one
//! line per tag in [`METHODS`] and one arm in [`call`] or [`open_stream`].

use std::sync::Arc;

use serde_json::{Value, json};

use crate::engine::Inner;
use crate::projects::ProjectFailure;
use crate::{EngineError, Subscription};

pub(crate) const METHODS: &[&str] = &[
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
    let not_empty = failure
        .cause
        .as_ref()
        .is_some_and(|c| c["_tag"] == "ProjectNotEmptyError");
    let mut error = json!({
        "_tag": "ProjectMutationError",
        "commandId": command_id,
        "message": if not_empty { failure.message.clone() } else { "Failed to mutate project.".to_owned() },
    });
    error["cause"] = failure
        .cause
        .unwrap_or_else(|| json!({"message": failure.message}));
    EngineError::Rejected(error)
}

pub(crate) async fn call(inner: Arc<Inner>, method: String, input: Value) -> CallResult {
    match method.as_str() {
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
    _inner: Arc<Inner>,
    method: String,
    _input: Value,
) -> Result<Subscription<Value, Value>, EngineError<Value>> {
    Err(EngineError::Internal(format!(
        "this engine does not support {method}"
    )))
}
