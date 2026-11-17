//! A workflow Stop targets one live Claude task, never the thread's turn.

use conn_contract::{ProviderThread, from_json};
use conn_provider::{ProviderError, StopTaskInput};
use conn_support::modes::{interaction_rank, runtime_rank};
use serde_json::{Value, json};

use crate::{EngineError, engine::Inner};

fn failure(input: &Value, reason: &str) -> EngineError<Value> {
    EngineError::Rejected(json!({
        "_tag": "OrchestrationV2StopWorkflowError", "threadId": input["threadId"],
        "subagentId": input["subagentId"], "reason": reason,
    }))
}

fn target(
    input: &Value,
    thread: Option<Value>,
    tasks: Vec<Value>,
    runs: Vec<Value>,
    pts: Vec<Value>,
) -> Result<(Value, String), &'static str> {
    let thread = thread
        .filter(|t| t["deletedAt"].is_null())
        .ok_or("unavailable")?;
    let task = tasks
        .iter()
        .find(|t| t["id"] == input["subagentId"])
        .filter(|t| {
            t["threadId"] == thread["id"] && t["workflow"].is_object() && t["status"] == "running"
        })
        .ok_or("not-running")?;
    if task["origin"] != "provider_native" || task["driver"] != "claudeAgent" {
        return Err("unsupported");
    }
    let pt = task["providerThreadId"].as_str().or_else(|| {
        runs.iter()
            .find(|r| r["id"] == task["runId"])
            .and_then(|r| r["providerThreadId"].as_str())
    });
    let row = pts
        .into_iter()
        .find(|p| {
            Some(p["id"].as_str().unwrap_or_default()) == pt
                && p["appThreadId"] == thread["id"]
                && p["driver"] == task["driver"]
                && p["providerInstanceId"] == task["providerInstanceId"]
                && p["providerSessionId"].is_string()
        })
        .ok_or("unavailable")?;
    let task_id = task["nativeTaskRef"]["nativeId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("unavailable")?;
    Ok((row, task_id.to_owned()))
}

impl Inner {
    pub(crate) async fn stop_workflow(&self, input: Value) -> Result<Value, EngineError<Value>> {
        let tid = input["threadId"].as_str().unwrap_or_default().to_owned();
        let _gate = self.lock_thread(&tid).await;
        let request = input.clone();
        let result = self
            .db(move |store| {
                let tx = store.tx()?;
                if let (Some(limit), Some(thread)) = (
                    request.get("modeLimit"),
                    tx.thread(&tid)?.filter(|t| t["deletedAt"].is_null()),
                ) {
                    let exceeded = if runtime_rank(thread["runtimeMode"].as_str().unwrap_or_default())
                        > runtime_rank(limit["runtimeMode"].as_str().unwrap_or_default()) {
                        Some("runtime_mode_escalation_denied")
                    } else if interaction_rank(thread["interactionMode"].as_str().unwrap_or_default())
                        > interaction_rank(limit["interactionMode"].as_str().unwrap_or_default())
                    {
                        Some("interaction_mode_escalation_denied")
                    } else {
                        None
                    };
                    if let Some(code) = exceeded {
                        let runtime = thread["runtimeMode"].as_str().unwrap_or_default();
                        let interaction = thread["interactionMode"].as_str().unwrap_or_default();
                        let message = format!("Thread {tid} now runs in {runtime}/{interaction} mode, above this caller's. Its user changed it while this call ran.");
                        tx.rollback();
                        return Ok(Err(
                            json!({"_tag":"OrchestratorMcpFailure","code":code,"message":message}),
                        ));
                    }
                }
                let result = target(
                    &request,
                    tx.thread(&tid)?,
                    tx.entities(&tid, "subagents")?,
                    tx.entities(&tid, "runs")?,
                    tx.entities(&tid, "providerThreads")?,
                );
                tx.rollback();
                Ok::<_, String>(result.map_err(|reason| json!(reason)))
            })
            .await
            .map_err(|_| failure(&input, "unavailable"))?;
        let (row, task_id) = result.map_err(|reason| {
            if let Some(reason) = reason.as_str() {
                failure(&input, reason)
            } else {
                EngineError::Rejected(reason)
            }
        })?;
        let tid = input["threadId"].as_str().unwrap_or_default();
        let live = self
            .live_thread(tid)
            .filter(|l| {
                l.session().provider_session_id().as_str()
                    == row["providerSessionId"].as_str().unwrap_or_default()
            })
            .ok_or_else(|| failure(&input, "unavailable"))?;
        let provider_thread: ProviderThread =
            from_json(row).map_err(|_| failure(&input, "unavailable"))?;
        match tokio::time::timeout(
            std::time::Duration::from_secs(15),
            live.session().stop_task(StopTaskInput {
                provider_thread,
                task_id,
            }),
        )
        .await
        {
            Ok(Ok(())) => Ok(Value::Null),
            Ok(Err(ProviderError::Unsupported { .. })) => Err(failure(&input, "unsupported")),
            _ => Err(failure(&input, "stop-failed")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workflow_stop_finds_only_its_live_native_task() {
        let input = json!({"threadId":"t", "subagentId":"w"});
        let thread = json!({"id":"t", "deletedAt":null});
        let task = json!({"id":"w", "threadId":"t", "runId":"r", "workflow":{}, "status":"running", "origin":"provider_native", "driver":"claudeAgent", "providerInstanceId":"claude", "nativeTaskRef":{"nativeId":"wf"}});
        let run = json!({"id":"r", "providerThreadId":"pt"});
        let pt = json!({"id":"pt", "appThreadId":"t", "driver":"claudeAgent", "providerInstanceId":"claude", "providerSessionId":"s"});
        assert_eq!(
            target(
                &input,
                Some(thread.clone()),
                vec![task.clone()],
                vec![run.clone()],
                vec![pt.clone()]
            ),
            Ok((pt.clone(), "wf".into()))
        );
        for (key, value, reason) in [
            ("status", json!("completed"), "not-running"),
            ("workflow", Value::Null, "not-running"),
            ("driver", json!("codex"), "unsupported"),
            ("nativeTaskRef", json!({}), "unavailable"),
        ] {
            let mut changed = task.clone();
            changed[key] = value;
            assert_eq!(
                target(
                    &input,
                    Some(thread.clone()),
                    vec![changed],
                    vec![run.clone()],
                    vec![pt.clone()]
                ),
                Err(reason)
            );
        }
        assert_eq!(
            target(&input, None, vec![], vec![], vec![]),
            Err("unavailable")
        );
        assert_eq!(
            target(&input, Some(thread.clone()), vec![], vec![], vec![]),
            Err("not-running")
        );
        let mut wrong = pt;
        wrong["appThreadId"] = json!("other");
        assert_eq!(
            target(&input, Some(thread), vec![task], vec![run], vec![wrong]),
            Err("unavailable")
        );
    }
}
