//! Delegated tasks: `delegate_task`, `task_status`, `task_cancel`.
//!
//! A task is a child thread whose id derives from the parent thread and the task id, so no
//! table keeps tasks and they survive a restart: `task_status` from another thread finds no
//! child and answers `task_not_found`. The child is an ordinary thread to the engine (no
//! lineage yet; see README). An async task wakes its parent with a message when it ends,
//! as TS `ProviderContinuationService` does; that watcher lives in memory only.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    Args, Cx, ToolError, ToolResult, fail, projects, str_arg,
    threads::{self, MAX_WAIT_MS, Until},
};
use crate::{Caller, McpService, view};

const DEFAULT_TASK_WAIT_MS: u64 = 4 * 60 * 1000;
/// How long a watcher follows a child, and then waits for its parent to go idle.
const WATCH_CHILD: Duration = Duration::from_secs(24 * 60 * 60);
const WATCH_PARENT: Duration = Duration::from_secs(60 * 60);
pub const RUNNING_TASK_NEXT: &str =
    "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
const TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "interrupted"];

fn child_thread_id(parent: &str, task_id: &str) -> String {
    let digest = Sha256::digest(format!("{parent}\n{task_id}").as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("thread:task:{hex}")
}

/// TS `taskStatusForRun`.
fn task_status(run: Option<&Value>) -> &'static str {
    match run.and_then(|r| r["status"].as_str()) {
        Some("queued") => "queued",
        Some("waiting") => "waiting",
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("cancelled" | "rolled_back") => "cancelled",
        Some("interrupted") => "interrupted",
        _ => "running",
    }
}

/// TS `threadTitle`: the title, else the prompt, cut to 80 characters.
fn child_title(parent_title: &str, title: Option<&str>, prompt: &str) -> String {
    let detail = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(prompt.trim());
    if detail.is_empty() {
        return format!("{parent_title} thread 1");
    }
    if detail.chars().count() <= 80 {
        return detail.to_owned();
    }
    format!("{}...", detail.chars().take(77).collect::<String>())
}

fn options_array(options: Option<&Value>) -> Option<Value> {
    match options? {
        Value::Array(items) => Some(Value::Array(items.clone())),
        Value::Object(map) => Some(Value::Array(
            map.iter()
                .map(|(id, value)| json!({"id": id, "value": value}))
                .collect(),
        )),
        _ => None,
    }
}

pub async fn delegate(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let caller = cx.require_thread("delegate_task")?;
    let parent = cx.projection(&caller.thread_id).await?;
    let parent_thread = &parent["thread"];
    let target = args.get("target").cloned().unwrap_or(Value::Null);
    if let Some(environment) = target["environmentId"].as_str()
        && environment != cx.config().environment_id
    {
        return Err(fail(
            "capability_denied",
            "Linked environments is off on this machine. Leave out target.environmentId to run the task here.",
        ));
    }
    if let Some(project) = target["projectId"].as_str()
        && parent_thread["projectId"] != project
    {
        return Err(fail(
            "invalid_request",
            "A local task runs in this thread's project. Omit target.projectId, or pass target.environmentId to run it in that environment's project.",
        ));
    }
    let active = view::active_run(&parent)
        .filter(|run| run["providerInstanceId"] == caller.provider_instance_id.as_str());
    if active.is_none() {
        return Err(fail(
            "parent_not_active",
            "Delegated tasks require an active run owned by this MCP provider session.",
        ));
    }
    if str_arg(args, "isolation") == Some("worktree") {
        return Err(fail(
            "invalid_request",
            "Conn Server cannot prepare a worktree for a child yet. Use isolation \"shared\" to work in the parent's checkout.",
        ));
    }

    let inherited = &parent_thread["modelSelection"];
    let instance = target["providerInstanceId"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            let driver = target["driverKind"].as_str()?;
            (cx.config().providers)()
                .into_iter()
                .find(|p| p["driver"] == driver)
                .and_then(|p| p["instanceId"].as_str().map(str::to_owned))
        })
        .or_else(|| inherited["instanceId"].as_str().map(str::to_owned))
        .unwrap_or_default();
    let provider = projects::provider(cx, &instance).ok_or_else(|| {
        fail(
            "provider_unavailable",
            format!("Provider {instance} is not available here. orchestrator_capabilities lists providers."),
        )
    })?;
    let model = target["model"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            (inherited["instanceId"] == instance.as_str())
                .then(|| inherited["model"].as_str().map(str::to_owned))
                .flatten()
        })
        .or_else(|| provider["models"][0]["slug"].as_str().map(str::to_owned))
        .ok_or_else(|| {
            fail(
                "model_unavailable",
                format!("Provider {instance} lists no model."),
            )
        })?;
    let mut selection = json!({"instanceId": instance, "model": model});
    if let Some(options) = options_array(target.get("options")) {
        selection["options"] = options;
    } else if inherited["instanceId"] == instance.as_str() && inherited["options"].is_array() {
        selection["options"] = inherited["options"].clone();
    }
    let runtime_mode = threads::resolve_runtime_mode(
        parent_thread["runtimeMode"]
            .as_str()
            .unwrap_or("approval-required"),
        str_arg(args, "runtimeMode"),
    )?;
    let interaction_mode = threads::resolve_interaction_mode(
        parent_thread["interactionMode"]
            .as_str()
            .unwrap_or("default"),
        str_arg(args, "interactionMode"),
    )?;

    let key = Cx::request_key(args);
    let task_id = cx.hashed_id("task:", &key);
    let child = child_thread_id(&caller.thread_id, &task_id);
    let task = str_arg(args, "task").unwrap_or_default();
    let prompt = match str_arg(args, "role") {
        None | Some("general") => task.to_owned(),
        Some(role) => format!("Act as the {role} sub-agent for this task.\n\n{task}"),
    };
    let mut strategy = json!({"type": "root"});
    if let Some(path) = parent_thread["worktreePath"].as_str() {
        strategy = json!({"type": "existing_worktree", "worktreePath": path, "branch": parent_thread["branch"]});
    }
    threads::launch_thread(
        cx,
        json!({
            "commandId": format!("{task_id}:launch"),
            "threadId": child,
            "projectId": parent_thread["projectId"],
            "title": child_title(
                parent_thread["title"].as_str().unwrap_or_default(),
                str_arg(args, "title"),
                task,
            ),
            "modelSelection": selection,
            "runtimeMode": runtime_mode,
            "interactionMode": interaction_mode,
            "workspaceStrategy": strategy,
            "initialMessage": {"messageId": format!("message:{task_id}"), "text": prompt, "attachments": []},
            "createdBy": "agent",
            "creationSource": "mcp",
        }),
    )
    .await?;

    if str_arg(args, "mode") == Some("wait") {
        let timeout = args
            .get("timeoutMs")
            .and_then(Value::as_f64)
            .map_or(DEFAULT_TASK_WAIT_MS, |ms| {
                (ms.max(1.0) as u64).min(MAX_WAIT_MS)
            });
        let (_, timed_out) = threads::wait_for_run(
            cx,
            &child,
            None,
            Duration::from_millis(timeout),
            Until::EndedOrWaiting,
        )
        .await?;
        let result = read_task(cx, &caller.thread_id, &task_id, timed_out).await?;
        if timed_out {
            watch(cx.service.clone(), cx.caller.clone(), task_id);
        }
        return Ok(result);
    }
    watch(cx.service.clone(), cx.caller.clone(), task_id.clone());
    read_task(cx, &caller.thread_id, &task_id, false).await
}

pub async fn status(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let caller = cx.require_thread("task_status")?;
    read_task(
        cx,
        &caller.thread_id,
        str_arg(args, "taskId").unwrap_or_default(),
        false,
    )
    .await
}

pub async fn cancel(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let caller = cx.require_thread("task_cancel")?;
    let task_id = str_arg(args, "taskId").unwrap_or_default();
    let current = read_task(cx, &caller.thread_id, task_id, false).await?;
    if TERMINAL.contains(&current["status"].as_str().unwrap_or_default()) {
        return Ok(json!({"taskId": task_id, "status": current["status"]}));
    }
    let key = Cx::request_key(args);
    let reason = str_arg(args, "reason").unwrap_or("Cancelled by its parent agent.");
    cx.dispatch(json!({
        "type": "thread.stop",
        "commandId": cx.stable_id("command", "task-cancel", &key),
        "threadId": current["childThreadId"],
        "reason": reason,
    }))
    .await?;
    Ok(json!({"taskId": task_id, "status": "cancel_requested"}))
}

/// `OrchestratorMcpDelegateTaskResult` for a task of `parent`.
async fn read_task(cx: &Cx<'_>, parent: &str, task_id: &str, wait_timed_out: bool) -> ToolResult {
    let not_found = || {
        fail(
            "task_not_found",
            format!("Delegated task {task_id} does not belong to thread {parent}."),
        )
    };
    if !task_id.starts_with("task:") {
        return Err(not_found());
    }
    let child_id = child_thread_id(parent, task_id);
    let child = cx.projection(&child_id).await.map_err(|_| not_found())?;
    let mut runs: Vec<&Value> = child["runs"]
        .as_array()
        .map(|r| r.iter().collect())
        .unwrap_or_default();
    runs.sort_by_key(|run| run["ordinal"].as_u64().unwrap_or(0));
    let first = runs.first().copied();
    let latest = runs.last().copied();
    let status = task_status(latest);
    let terminal = TERMINAL.contains(&status);
    let terminal_run = runs.iter().rev().find(|run| !view::is_live(run)).copied();
    let summary = terminal
        .then(|| latest.and_then(|r| view::run_result_text(&child, r["id"].as_str()?)))
        .flatten();
    let requests: Vec<&Value> = child["runtimeRequests"]
        .as_array()
        .map(|r| r.iter().filter(|r| r["status"] == "pending").collect())
        .unwrap_or_default();
    let has_question = !terminal && requests.iter().any(|r| r["kind"] == "user_input");
    let approval = (!terminal)
        .then(|| requests.iter().find(|r| r["kind"] != "user_input"))
        .flatten()
        .map(|request| {
            let run_id = child["turnItems"]
                .as_array()
                .and_then(|items| items.iter().find(|i| i["requestId"] == request["id"]))
                .map_or_else(
                    || latest.map_or(Value::Null, |r| r["id"].clone()),
                    |i| i["runId"].clone(),
                );
            json!({"requestId": request["id"], "kind": request["kind"], "runId": run_id})
        });
    let selection = latest.map_or(&child["thread"]["modelSelection"], |r| &r["modelSelection"]);
    let title = child["thread"]["title"].as_str().unwrap_or_default();
    let pending_runs = runs.iter().any(|r| {
        view::is_live(r) && r["ordinal"].as_u64() > first.and_then(|f| f["ordinal"].as_u64())
    });
    let ends_wait = terminal || has_question || approval.is_some();
    let mut result = json!({
        "taskId": task_id,
        "childThreadId": child_id,
        "remoteChild": null,
        "link": crate::links::thread_link(
            cx.config(),
            &Caller::Thread(crate::ThreadCaller {
                thread_id: parent.to_owned(),
                provider_session_id: String::new(),
                provider_instance_id: String::new(),
                subagent: false,
            }),
            &child_id,
            title,
        ),
        "childRunId": first.map_or(Value::Null, |r| r["id"].clone()),
        "childNodeId": task_id,
        "status": status,
        "workState": if terminal { "result_available" } else { "working" },
        "hasPendingChildRuns": pending_runs,
        "latestTerminalRunId": terminal_run.map_or(Value::Null, |r| r["id"].clone()),
        "latestTerminalStatus": terminal_run
            .map(|r| task_status(Some(r)))
            .filter(|s| TERMINAL.contains(s)),
        "latestTerminalSummary": null,
        "latestTerminalResultContextTransferId": null,
        "providerInstanceId": selection["instanceId"],
        "model": selection["model"],
        "executedModel": latest.map_or(Value::Null, |r| view::executed_model(&child, r)),
        "options": selection.get("options").cloned().unwrap_or(json!([])),
        "summary": summary,
        "resultContextTransferId": null,
        "hasPendingQuestion": has_question,
        "pendingApproval": approval,
        "waitTimedOut": wait_timed_out,
    });
    if !ends_wait {
        result["next"] = json!(RUNNING_TASK_NEXT);
    }
    Ok(result)
}

/// Follows a task to its end, then wakes its parent with a message once the parent is idle.
fn watch(service: Arc<McpService>, caller: Caller, task_id: String) {
    tokio::spawn(async move {
        let Caller::Thread(thread) = &caller else {
            return;
        };
        let parent = thread.thread_id.clone();
        let cx = Cx {
            service: &service,
            caller: &caller,
        };
        let child = child_thread_id(&parent, &task_id);
        // A question leaves the child `waiting`; follow it until it ends.
        let Ok((Some(ended), false)) =
            threads::wait_for_run(&cx, &child, None, WATCH_CHILD, Until::Ended).await
        else {
            return;
        };
        let Ok((_, false)) =
            threads::wait_for_run(&cx, &parent, None, WATCH_PARENT, Until::Ended).await
        else {
            return;
        };
        let wake = format!(
            "Delegated task {task_id} reached a terminal state. Use task_status with taskId {task_id} to read the result."
        );
        let run = ended["id"].as_str().unwrap_or_default();
        let result = cx
            .dispatch(json!({
                "type": "message.dispatch",
                "commandId": format!("command:mcp:task-wake:{task_id}:{run}"),
                "threadId": parent,
                "messageId": format!("message:task-wake:{task_id}:{run}"),
                "text": wake,
                "attachments": [],
                "dispatchMode": {"type": "start_immediately"},
                "createdBy": "system",
                "creationSource": "server",
            }))
            .await;
        if let Err(ToolError::Failure { message, .. }) = result {
            eprintln!("mcp: could not wake thread {parent} for task {task_id}: {message}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_cut_like_ts() {
        assert_eq!(child_title("P", None, "  "), "P thread 1");
        assert_eq!(child_title("P", Some("Fix it"), "long"), "Fix it");
        let long = "x".repeat(100);
        assert_eq!(child_title("P", None, &long).chars().count(), 80);
    }

    #[test]
    fn a_task_id_names_a_child_only_for_its_parent() {
        assert_ne!(
            child_thread_id("a", "task:1"),
            child_thread_id("b", "task:1")
        );
        assert_eq!(
            child_thread_id("a", "task:1"),
            child_thread_id("a", "task:1")
        );
    }
}
