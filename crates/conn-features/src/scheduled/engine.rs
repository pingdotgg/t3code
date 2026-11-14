//! [`TaskRunner`] on the engine: a launch through `launchThread`, a queued `message.dispatch`
//! for a bound thread, and thread reads from projections.

use std::sync::Arc;

use conn_contract::{Command, ThreadId, from_json, to_json};
use conn_engine::{BoxFuture, Engine, EngineError};
use serde_json::{Value, json};

use super::{LaunchRequest, RUN_OUTCOME_WAIT, SendError, SendRequest, TaskRunner, ThreadShell};

/// Run statuses after which a run never changes (`isTerminalRunStatus`).
const TERMINAL: [&str; 5] = [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "rolled_back",
];

/// `UNSUCCESSFUL_RUN_ERRORS`.
fn unsuccessful(status: &str) -> &'static str {
    match status {
        "interrupted" => "The run was stopped.",
        "cancelled" => "The run was cancelled.",
        "rolled_back" => "The run was rolled back.",
        _ => "The run failed.",
    }
}

/// The engine as scheduled runs use it.
#[derive(Clone)]
pub struct EngineRunner {
    engine: Arc<dyn Engine>,
}

impl std::fmt::Debug for EngineRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineRunner").finish_non_exhaustive()
    }
}

impl EngineRunner {
    pub fn new(engine: Arc<dyn Engine>) -> Self {
        Self { engine }
    }

    async fn projection(&self, thread_id: &str) -> Result<Option<Value>, String> {
        match self
            .engine
            .get_thread_projection(ThreadId::from(thread_id))
            .await
        {
            Ok(projection) => Ok(Some(projection)),
            Err(EngineError::Rejected(_)) => Ok(None),
            Err(EngineError::Internal(message)) => Err(message),
        }
    }
}

fn rejected_message(error: &Value, fallback: &str) -> String {
    error["message"].as_str().unwrap_or(fallback).to_owned()
}

/// `latestRootProviderFailure`: the newest failed error item on the run's root node.
fn root_failure(run: &Value, projection: &Value) -> Option<String> {
    if run["status"] != "failed" {
        return None;
    }
    projection["turnItems"]
        .as_array()?
        .iter()
        .filter(|item| {
            item["type"] == "error"
                && item["status"] == "failed"
                && item["runId"] == run["id"]
                && item["nodeId"] == run["rootNodeId"]
        })
        .max_by(|a, b| {
            let at = |item: &Value| {
                item["updatedAt"]
                    .as_str()
                    .and_then(conn_support::time::millis_from_iso)
                    .unwrap_or(0)
            };
            at(a)
                .cmp(&at(b))
                .then(a["ordinal"].as_u64().cmp(&b["ordinal"].as_u64()))
                .then(a["id"].as_str().cmp(&b["id"].as_str()))
        })
        .and_then(|item| item["failure"]["message"].as_str().map(str::to_owned))
}

/// What a finished run means for its task: `None` for success or a run the message left.
fn judge(projection: &Value, run: &Value, message_id: &str) -> Option<String> {
    let status = run["status"].as_str().unwrap_or_default();
    if status == "completed" {
        return None;
    }
    // A queued message promoted to a steer cancels its run and joins the active one.
    if status == "cancelled" {
        let message_run = projection["messages"]
            .as_array()
            .and_then(|messages| messages.iter().find(|m| m["id"] == message_id))
            .map(|m| m["runId"].clone());
        if message_run.as_ref() != Some(&run["id"]) {
            return None;
        }
    }
    Some(root_failure(run, projection).unwrap_or_else(|| unsuccessful(status).to_owned()))
}

fn run_of<'a>(projection: &'a Value, message_id: &str) -> Option<&'a Value> {
    projection["runs"]
        .as_array()?
        .iter()
        .find(|run| run["userMessageId"] == message_id)
}

impl TaskRunner for EngineRunner {
    fn launch(&self, request: LaunchRequest) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            let input = json!({
                "commandId": request.command_id,
                "projectId": request.project_id,
                "title": request.title,
                "modelSelection": request.model_selection,
                "runtimeMode": request.runtime_mode,
                "interactionMode": request.interaction_mode,
                "workspaceStrategy": request.workspace_strategy,
                "initialMessage": {
                    "messageId": request.message_id,
                    "scheduledTaskId": request.scheduled_task_id,
                    "text": request.text,
                    "attachments": [],
                },
                "createdBy": request.created_by,
                "creationSource": request.creation_source,
            });
            match self.engine.launch_thread(input).await {
                Ok(result) => result["threadId"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "The launch returned no thread.".to_owned()),
                Err(EngineError::Rejected(error)) => {
                    Err(rejected_message(&error, "The thread could not start."))
                }
                Err(EngineError::Internal(message)) => Err(message),
            }
        })
    }

    fn send(&self, request: SendRequest) -> BoxFuture<'_, Result<(), SendError>> {
        Box::pin(async move {
            let not_found = || SendError::ThreadNotFound {
                project_id: request.project_id.clone(),
                thread_id: request.thread_id.clone(),
            };
            // `sendToThread` addresses a thread in a project; the engine's dispatch does not
            // take one, so the project is checked here.
            let projection = self
                .projection(&request.thread_id)
                .await
                .map_err(SendError::Other)?
                .ok_or_else(not_found)?;
            let thread = &projection["thread"];
            if !thread["deletedAt"].is_null() || thread["projectId"] != request.project_id.as_str()
            {
                return Err(not_found());
            }
            let command = json!({
                "type": "message.dispatch",
                "commandId": request.command_id,
                "threadId": request.thread_id,
                "messageId": request.message_id,
                "scheduledTaskId": request.scheduled_task_id,
                "text": request.text,
                "attachments": [],
                "dispatchMode": {"type": "queue_after_active"},
                "createdBy": request.created_by,
                "creationSource": request.creation_source,
            });
            let command: Command =
                from_json(command).map_err(|e| SendError::Other(format!("bad command: {e}")))?;
            match self.engine.dispatch(command).await {
                Ok(_) => Ok(()),
                Err(EngineError::Rejected(error)) => Err(SendError::Other(rejected_message(
                    &to_json(&error),
                    "The message was refused.",
                ))),
                Err(EngineError::Internal(message)) => Err(SendError::Other(message)),
            }
        })
    }

    fn thread_shell(
        &self,
        thread_id: String,
    ) -> BoxFuture<'_, Result<Option<ThreadShell>, String>> {
        Box::pin(async move {
            Ok(self.projection(&thread_id).await?.map(|projection| {
                let thread = &projection["thread"];
                ThreadShell {
                    project_id: thread["projectId"].as_str().unwrap_or_default().to_owned(),
                    deleted: !thread["deletedAt"].is_null(),
                    archived: !thread["archivedAt"].is_null(),
                }
            }))
        })
    }

    fn has_queued_occurrence(
        &self,
        task_id: String,
        thread_id: String,
    ) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            let Some(projection) = self.projection(&thread_id).await? else {
                return Ok(false);
            };
            let queued: Vec<&Value> = projection["runs"]
                .as_array()
                .map(|runs| runs.iter().filter(|r| r["status"] == "queued").collect())
                .unwrap_or_default();
            Ok(projection["messages"].as_array().is_some_and(|messages| {
                messages.iter().any(|message| {
                    message["scheduledTaskId"] == task_id.as_str()
                        && queued
                            .iter()
                            .any(|run| run["userMessageId"] == message["id"])
                })
            }))
        })
    }

    fn run_outcome(&self, thread_id: String, message_id: String) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let deadline = tokio::time::Instant::now() + RUN_OUTCOME_WAIT;
            let input = from_json(json!({"threadId": thread_id})).ok()?;
            let mut stream = self.engine.subscribe_thread(input).await.ok()?;
            loop {
                let projection = self.projection(&thread_id).await.ok()??;
                let run = run_of(&projection, &message_id)?;
                if TERMINAL.contains(&run["status"].as_str().unwrap_or_default()) {
                    return judge(&projection, run, &message_id);
                }
                // Wait for the next run event; the projection is read again after it.
                loop {
                    let item = match tokio::time::timeout_at(deadline, stream.recv()).await {
                        Err(_) | Ok(None) | Ok(Some(Err(_))) => return None,
                        Ok(Some(Ok(item))) => to_json(&item),
                    };
                    if item["event"]["type"]
                        .as_str()
                        .is_some_and(|kind| kind.starts_with("run."))
                    {
                        break;
                    }
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{judge, root_failure};
    use serde_json::json;

    /// `a run that ends $status after its message was accepted records it`, at the level of
    /// what the follower decides.
    #[test]
    fn judges_finished_runs_as_t3_records_them() {
        let projection = |status: &str| {
            json!({
                "runs": [
                    {"id": "run:1", "status": "completed", "userMessageId": "message:earlier"},
                    {"id": "run:2", "status": status, "rootNodeId": "node:root", "userMessageId": "m"},
                ],
                "messages": [{"id": "m", "runId": "run:2"}],
                "turnItems": [{
                    "type": "error", "status": "failed", "runId": "run:2", "nodeId": "node:root",
                    "updatedAt": "2026-01-01T00:00:00.000Z", "ordinal": 1, "id": "e1",
                    "failure": {"message": "Weekly usage limit reached"},
                }],
            })
        };
        for (status, expected) in [
            ("failed", Some("Weekly usage limit reached")),
            ("interrupted", Some("The run was stopped.")),
            ("cancelled", Some("The run was cancelled.")),
            ("rolled_back", Some("The run was rolled back.")),
            ("completed", None),
        ] {
            let p = projection(status);
            let run = &p["runs"][1];
            assert_eq!(judge(&p, run, "m").as_deref(), expected, "{status}");
        }
        // A message promoted to a steer left its cancelled run.
        let mut p = projection("cancelled");
        p["messages"][0]["runId"] = json!("run:other");
        let run = p["runs"][1].clone();
        assert_eq!(judge(&p, &run, "m"), None, "promoted to a steer");
        // Only the root node's failure counts.
        let mut p = projection("failed");
        p["turnItems"][0]["nodeId"] = json!("node:child");
        let run = p["runs"][1].clone();
        assert_eq!(root_failure(&run, &p), None, "a child's failure");
        assert_eq!(
            judge(&p, &run, "m").as_deref(),
            Some("The run failed."),
            "fallback"
        );
    }
}
