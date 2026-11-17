//! Workflow Stop uses the same engine operation as the client RPC.
use super::{Args, Cx, ToolResult, fail};
use serde_json::json;

pub(super) async fn stop(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let thread = args.get("threadId").and_then(serde_json::Value::as_str);
    let limit = cx.writes_threads(&[thread]).await?;
    let mut request = json!(args);
    if cx.caller_thread_id() != thread {
        request["modeLimit"] =
            json!({"runtimeMode":limit.runtime_mode,"interactionMode":limit.interaction_mode});
    }
    match cx
        .engine()
        .call("orchestration.stopWorkflow", request)
        .await
    {
        Ok(_) => Ok(json!({})),
        Err(conn_engine::EngineError::Rejected(error)) => {
            if error["_tag"] == "OrchestratorMcpFailure" {
                let code = if error["code"] == "runtime_mode_escalation_denied" {
                    "runtime_mode_escalation_denied"
                } else {
                    "interaction_mode_escalation_denied"
                };
                return Err(fail(code, error["message"].as_str().unwrap_or_default()));
            }
            let reason = error["reason"].as_str().unwrap_or("unavailable");
            let message = match reason {
                "not-running" => "This workflow is no longer running.",
                "unsupported" => "This provider cannot stop a workflow.",
                "stop-failed" => "Failed to stop the workflow.",
                _ => "This workflow has no live provider task.",
            };
            Err(fail(
                if matches!(reason, "not-running" | "unsupported") {
                    "invalid_request"
                } else {
                    "orchestration_error"
                },
                message,
            ))
        }
        Err(conn_engine::EngineError::Internal(message)) => Err(super::internal(message)),
    }
}
