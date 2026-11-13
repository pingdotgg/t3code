//! Delegated tasks: `delegate_task`, `task_status`, `task_cancel`.
//!
//! `delegate_task` dispatches the engine's `delegated_task.request`, which writes the child
//! thread (lineage `subagent`), the parent's subagent rows and the child's first run, and
//! wakes the parent when the child ends. Ids follow from the command id (engine README), so
//! no table keeps tasks: task `node:delegated-task:<commandId>`, child
//! `thread:delegated-task:<commandId>`.

use std::time::Duration;

use serde_json::{Value, json};

use super::{
    Args, Cx, ToolResult, fail, projects, str_arg,
    threads::{self, MAX_WAIT_MS},
};
use crate::{Caller, view};

const DEFAULT_TASK_WAIT_MS: u64 = 4 * 60 * 1000;
pub const RUNNING_TASK_NEXT: &str =
    "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
const TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "interrupted"];
const TASK_PREFIX: &str = "node:delegated-task:";

/// The child thread of a task id, as the engine names it.
fn child_thread_id(task_id: &str) -> Option<String> {
    let command_id = task_id.strip_prefix(TASK_PREFIX)?;
    Some(format!("thread:delegated-task:{command_id}"))
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

    let parent_run = active.cloned().unwrap_or_default();
    let key = Cx::request_key(args);
    let command_id = cx.stable_id("command", "delegate-task", &key);
    let task_id = format!("{TASK_PREFIX}{command_id}");
    let child = format!("thread:delegated-task:{command_id}");
    let task = str_arg(args, "task").unwrap_or_default();
    let prompt = match str_arg(args, "role") {
        None | Some("general") => task.to_owned(),
        Some(role) => format!("Act as the {role} sub-agent for this task.\n\n{task}"),
    };
    let wait = str_arg(args, "mode") == Some("wait");
    let mut command = json!({
        "type": "delegated_task.request",
        "commandId": command_id,
        "parentThreadId": caller.thread_id,
        "parentRunId": parent_run["id"],
        "parentNodeId": parent_run["rootNodeId"],
        "task": prompt,
        "modelSelection": selection,
        "runtimeMode": runtime_mode,
        "interactionMode": interaction_mode,
        // A wait delivers the result through this call; it wakes the parent only after the
        // wait gives up (below).
        "completionWake": if wait { "settled_only" } else { "always" },
        "createdBy": "agent",
        "creationSource": "mcp",
    });
    if let Some(title) = str_arg(args, "title")
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        command["title"] = json!(title);
    }
    cx.dispatch(command).await?;

    if wait {
        let timeout = args
            .get("timeoutMs")
            .and_then(Value::as_f64)
            .map_or(DEFAULT_TASK_WAIT_MS, |ms| {
                (ms.max(1.0) as u64).min(MAX_WAIT_MS)
            });
        let (_, timed_out) =
            threads::wait_for_run(cx, &child, None, Duration::from_millis(timeout)).await?;
        if timed_out {
            cx.dispatch(json!({
                "type": "delegated_task.wake-policy",
                "commandId": format!("{command_id}:wake-always"),
                "parentThreadId": caller.thread_id,
                "taskId": task_id,
                "completionWake": "always",
            }))
            .await?;
        }
        return read_task(cx, &caller.thread_id, &task_id, timed_out).await;
    }
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
    let child_id = child_thread_id(task_id).ok_or_else(not_found)?;
    let child = cx.projection(&child_id).await.map_err(|_| not_found())?;
    if child["thread"]["lineage"]["parentThreadId"] != parent {
        return Err(not_found());
    }
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
