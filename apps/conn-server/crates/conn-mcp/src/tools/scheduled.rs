//! `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task` and
//! `run_scheduled_task_now`: `OrchestratorMcpService.ts` (`scheduleTask`,
//! `updateScheduledTask`, `listScheduledTasks`, `deleteScheduledTask`) and the thread
//! toolkit's `run_scheduled_task_now`, with the access rules of their toolkits' handlers.

use std::path::Path;

use conn_contract::{ScheduledTask, ScheduledTaskThreadMode, to_json};
use conn_features::scheduled::{self, Failure as TaskFailure, ScheduledTasks, UpsertInput};
use serde_json::{Value, json};

use super::{
    Args, Cx, Limits, ToolError, ToolResult, bool_arg, fail, internal, str_arg,
    threads::{resolve_interaction_mode, resolve_runtime_mode},
};

/// `fullAccessRequired` in `McpToolAccess.ts`.
const FULL_ACCESS_REQUIRED: &str = "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

fn service<'a>(cx: &'a Cx<'_>) -> Result<&'a ScheduledTasks, ToolError> {
    cx.config().scheduled_tasks.as_ref().ok_or_else(|| {
        fail(
            "capability_denied",
            "Scheduled tasks are not available here.",
        )
    })
}

/// `scheduledTaskSummary`. No task here has a webhook, so no URL or signature field.
fn summary(task: &ScheduledTask) -> Value {
    json!({
        "scheduledTaskId": task.id,
        "title": task.title,
        "prompt": task.prompt,
        "enabled": task.enabled,
        "projectId": task.project_id,
        "boundThreadId": task.thread_id,
        "freshSession": scheduled::thread_mode_of(task) == ScheduledTaskThreadMode::FreshSession,
        "schedule": to_json(&task.schedule),
        "nextRunAt": task.next_run_at,
        "lastRunStatus": to_json(&task.last_run_status),
    })
}

/// The caller's own thread, for thread callers (`loadCaller(scope, ["runs"])`'s parent).
async fn parent(cx: &Cx<'_>) -> Result<Option<Value>, ToolError> {
    cx.caller_projection().await
}

/// `requireProject`: a live project row from the shell.
async fn require_project(cx: &Cx<'_>, project_id: &str) -> ToolResult {
    let shell = cx.shell().await?;
    shell["projects"]
        .as_array()
        .and_then(|projects| {
            projects
                .iter()
                .find(|p| p["id"] == project_id && p["deletedAt"].is_null())
        })
        .cloned()
        .ok_or_else(|| {
            fail(
                "invalid_request",
                format!("Project {project_id} was not found."),
            )
        })
}

/// `scheduledTaskWorkspaceStrategy`: a bound task runs in its thread's checkout; a task that
/// starts new threads gets a worktree from the newest default branch for each run.
async fn workspace_strategy(cx: &Cx<'_>, bound: bool, project_id: &str) -> ToolResult {
    if bound {
        return Ok(json!({"type": "root"}));
    }
    let project = require_project(cx, project_id).await?;
    let root = project["workspaceRoot"].as_str().unwrap_or_default();
    Ok(json!({
        "type": "worktree",
        "baseRef": scheduled::base_ref(Path::new(root)).await,
        "startFromOrigin": true,
    }))
}

fn bind_refusal(parent: Option<&Value>) -> ToolError {
    fail(
        "invalid_request",
        if parent.is_none() {
            "bindToCurrentThread needs an agent running inside a T3 thread."
        } else {
            "bindToCurrentThread binds to this thread, which belongs to a different project."
        },
    )
}

fn upsert_input(value: Value) -> Result<UpsertInput, ToolError> {
    serde_json::from_value(value).map_err(|e| internal(format!("bad scheduled task input: {e}")))
}

async fn save(
    service: &ScheduledTasks,
    input: UpsertInput,
    verb: &str,
) -> Result<ScheduledTask, ToolError> {
    service.upsert(input).await.map_err(|error| match error {
        TaskFailure::Task(error) => fail(
            "orchestration_error",
            format!("Could not {verb} task: {}", error.message),
        ),
        TaskFailure::Invalid(message) => ToolError::InvalidParams(message),
    })
}

/// `schedule_task`: creates a task (`startsThreads`, refused to linked callers), or with
/// `scheduledTaskId` updates one (`writes`).
pub(super) async fn schedule(cx: &Cx<'_>, args: &Args) -> ToolResult {
    // Arguments decode before any access rule, as the TS tool decodes its parameters.
    let mut args = args.clone();
    if let Some(schedule) = args.get("schedule") {
        let decoded = check_schedule(schedule).map_err(ToolError::InvalidParams)?;
        args.insert("schedule".into(), decoded);
    }
    match str_arg(&args, "scheduledTaskId") {
        None => create(cx, &args).await,
        Some(id) => update(cx, &args, id).await,
    }
}

/// `OrchestratorMcpSchedule`: a `ScheduledTaskUpsertSchedule` object, or the same as JSON
/// text (OpenCode sends nested objects as strings). Answers the object, or Effect's decode
/// text with its path for the checks an agent hits.
fn check_schedule(value: &Value) -> Result<Value, String> {
    let at = |path: &str, problem: &str| format!("{problem}\n  at [\"schedule\"]{path}");
    let object = match value {
        Value::String(text) => serde_json::from_str::<Value>(text)
            .map_err(|_| at("", "Expected a valid JSON string"))?,
        other => other.clone(),
    };
    match object["type"].as_str() {
        Some("interval") => match object.get("everyMs").and_then(Value::as_f64) {
            Some(every) if every.fract() != 0.0 => Err(at("[\"everyMs\"]", "Expected an integer")),
            Some(every) if every <= 0.0 => {
                Err(at("[\"everyMs\"]", "Expected a value greater than 0"))
            }
            Some(every) if every < scheduled::schedule::MIN_INTERVAL_MS as f64 => Err(at(
                "[\"everyMs\"]",
                "Expected a value greater than or equal to 60000",
            )),
            _ => Ok(object),
        },
        Some("fixed_time") => {
            if let Some(time) = object.get("timeOfDay").and_then(Value::as_str)
                && scheduled::schedule::parse_time_of_day(time).is_none()
            {
                return Err(at(
                    "[\"timeOfDay\"]",
                    "Expected a string matching the RegExp ^([01]?\\d|2[0-3]):([0-5]\\d)$",
                ));
            }
            if let Some(days) = object.get("weekdays").and_then(Value::as_array) {
                for (index, day) in days.iter().enumerate() {
                    if day.as_i64().is_none_or(|d| !(0..=6).contains(&d)) {
                        return Err(at(
                            &format!("[\"weekdays\"][{index}]"),
                            "Expected a value between 0 and 6",
                        ));
                    }
                }
            }
            Ok(object)
        }
        Some("once") => match scheduled::schedule::decode_upsert_schedule(&object) {
            Err(error) => Err(at("[\"runAt\"]", &error.0)),
            Ok(_) => Ok(object),
        },
        // Webhooks and unknown kinds go on to the service, which answers them.
        _ => Ok(object),
    }
}

async fn create(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let limits = cx.writing_caller().await?;
    // `startsThreads(() => ({}))`: the task runs at the caller's own modes.
    let runtime_mode = resolve_runtime_mode(&limits.runtime_mode, None)?;
    let interaction_mode = resolve_interaction_mode(&limits.interaction_mode, None)?;
    let (Some(prompt), Some(schedule)) = (str_arg(args, "prompt"), args.get("schedule")) else {
        return Err(fail(
            "invalid_request",
            "A new scheduled task needs `prompt` and `schedule`.",
        ));
    };
    let service = service(cx)?;
    let parent = parent(cx).await?;
    let parent_thread = parent.as_ref().map(|p| &p["thread"]);
    let parent_project = parent_thread.and_then(|t| t["projectId"].as_str());
    let project_id = match str_arg(args, "projectId").or(parent_project) {
        Some(id) => id.to_owned(),
        None => {
            return Err(fail(
                "target_required",
                "Pass projectId: this MCP client is not running inside a T3 thread.",
            ));
        }
    };
    let project = require_project(cx, &project_id).await?;
    let bind = bool_arg(args, "bindToCurrentThread")
        .unwrap_or(parent_project == Some(project_id.as_str()));
    if bind && parent_project != Some(project_id.as_str()) {
        return Err(bind_refusal(parent.as_ref()));
    }
    let model_selection = match parent_thread.map(|t| t["modelSelection"].clone()) {
        Some(selection) if !selection.is_null() => selection,
        _ if !project["defaultModelSelection"].is_null() => {
            project["defaultModelSelection"].clone()
        }
        _ => {
            return Err(fail(
                "invalid_request",
                format!(
                    "Project {project_id} has no default model, so this caller cannot pick one for it."
                ),
            ));
        }
    };
    let derived: String = prompt
        .split('\n')
        .next()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(80)
        .collect();
    let title = match str_arg(args, "title") {
        Some(title) => title.to_owned(),
        None if !derived.is_empty() => derived,
        None => "Scheduled task".to_owned(),
    };
    let thread_mode = if bool_arg(args, "freshSession") == Some(true) {
        "fresh_session"
    } else if bind {
        "continue"
    } else {
        "new_thread"
    };
    let mut input = json!({
        "title": title,
        "prompt": prompt,
        "enabled": bool_arg(args, "enabled").unwrap_or(true),
        "schedule": schedule,
        "projectId": project_id,
        "threadId": if bind { parent_thread.map_or(Value::Null, |t| t["id"].clone()) } else { Value::Null },
        "threadMode": thread_mode,
        "workspaceStrategy": workspace_strategy(cx, bind, &project_id).await?,
        "modelSelection": model_selection,
        "runtimeMode": runtime_mode,
        "interactionMode": interaction_mode,
        "createdBy": "agent",
        "creationSource": "mcp",
    });
    // Scoped by the caller, so two callers reusing one clientRequestId get two tasks.
    if let Some(key) = str_arg(args, "clientRequestId") {
        input["commandId"] = json!(cx.stable_id("command", "schedule-task", key));
    }
    let task = save(service, upsert_input(input)?, "schedule").await?;
    Ok(summary(&task))
}

/// `loadScheduledTask`: a task the caller may change runs at modes no broader than its own,
/// so editing its prompt cannot run work above the caller's limits.
async fn load_task(
    cx: &Cx<'_>,
    service: &ScheduledTasks,
    id: &str,
    limits: &Limits,
) -> Result<ScheduledTask, ToolError> {
    let task = service.find(id).await.ok_or_else(|| {
        fail(
            "task_not_found",
            format!("Scheduled task {id} was not found."),
        )
    })?;
    let mut modes = vec![(to_json(&task.runtime_mode), to_json(&task.interaction_mode))];
    // `scheduledTaskRunModes`: a missing or deleted thread adds no modes; a failed read fails.
    if let Some(thread) = &task.thread_id {
        match cx
            .engine()
            .get_thread_projection(conn_contract::ThreadId::from(thread.as_str()))
            .await
        {
            Ok(projection) if projection["thread"]["deletedAt"].is_null() => {
                let bound = &projection["thread"];
                modes.push((
                    bound["runtimeMode"].clone(),
                    bound["interactionMode"].clone(),
                ));
            }
            Ok(_) | Err(conn_engine::EngineError::Rejected(_)) => {}
            Err(conn_engine::EngineError::Internal(message)) => return Err(internal(message)),
        }
    }
    for (runtime, interaction) in modes {
        resolve_runtime_mode(&limits.runtime_mode, runtime.as_str())?;
        resolve_interaction_mode(&limits.interaction_mode, interaction.as_str())?;
    }
    Ok(task)
}

async fn update(cx: &Cx<'_>, args: &Args, id: &str) -> ToolResult {
    let limits = cx.writing_caller().await?;
    let service = service(cx)?;
    let parent = parent(cx).await?;
    let existing = load_task(cx, service, id, &limits).await?;
    let parent_thread = parent.as_ref().map(|p| &p["thread"]);
    let parent_project = parent_thread.and_then(|t| t["projectId"].as_str());
    let bind = bool_arg(args, "bindToCurrentThread");
    let fresh = bool_arg(args, "freshSession");
    if bind == Some(true) && parent_project != Some(existing.project_id.as_str()) {
        return Err(bind_refusal(parent.as_ref()));
    }
    // A save keeps a bound thread unless the task goes back to new threads, so this pair
    // would leave runs in the old thread.
    if bind == Some(false) && fresh == Some(true) && existing.thread_id.is_some() {
        return Err(fail(
            "invalid_request",
            "To move this task to a new thread with fresh sessions, first unbind it with bindToCurrentThread: false, then set freshSession: true in a second call.",
        ));
    }
    let thread_id: Option<String> = match bind {
        None => existing.thread_id.clone(),
        Some(true) => parent_thread.and_then(|t| t["id"].as_str().map(str::to_owned)),
        Some(false) => None,
    };
    // The workspace resets only when the binding flips, so unbinding cannot leave runs in
    // the shared checkout.
    let workspace = if thread_id.is_none() == existing.thread_id.is_none() {
        to_json(&existing.workspace_strategy)
    } else {
        workspace_strategy(cx, thread_id.is_some(), &existing.project_id).await?
    };
    let stored_mode = scheduled::thread_mode_of(&existing);
    let thread_mode = if fresh.is_none() && bind.is_none() {
        stored_mode
    } else if fresh
        .unwrap_or(bind != Some(false) && stored_mode == ScheduledTaskThreadMode::FreshSession)
    {
        ScheduledTaskThreadMode::FreshSession
    } else if thread_id.is_none()
        && (bind == Some(false) || stored_mode == ScheduledTaskThreadMode::NewThread)
    {
        ScheduledTaskThreadMode::NewThread
    } else {
        ScheduledTaskThreadMode::Continue
    };
    let input = json!({
        "id": existing.id,
        "title": str_arg(args, "title").unwrap_or(&existing.title),
        "prompt": str_arg(args, "prompt").unwrap_or(&existing.prompt),
        "enabled": bool_arg(args, "enabled").unwrap_or(existing.enabled),
        "schedule": args.get("schedule").cloned().unwrap_or_else(|| to_json(&existing.schedule)),
        "projectId": existing.project_id,
        "threadId": thread_id,
        "threadMode": to_json(&thread_mode),
        "workspaceStrategy": workspace,
        "modelSelection": to_json(&existing.model_selection),
        "runtimeMode": to_json(&existing.runtime_mode),
        "interactionMode": to_json(&existing.interaction_mode),
        "createdBy": to_json(&existing.created_by),
        "creationSource": to_json(&existing.creation_source),
    });
    let task = save(service, upsert_input(input)?, "update scheduled").await?;
    Ok(summary(&task))
}

/// `list_scheduled_tasks` (`reads`): the caller's project by default, all outside a thread.
pub(super) async fn list(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let service = service(cx)?;
    let parent = parent(cx).await?;
    let project = str_arg(args, "projectId").map(str::to_owned).or_else(|| {
        parent
            .as_ref()
            .and_then(|p| p["thread"]["projectId"].as_str().map(str::to_owned))
    });
    let tasks: Vec<Value> = service
        .list()
        .await
        .tasks
        .iter()
        .flatten()
        .filter(|task| project.as_deref().is_none_or(|p| task.project_id == p))
        .map(summary)
        .collect();
    Ok(json!({ "tasks": tasks }))
}

/// `delete_scheduled_task` (`writes`).
pub(super) async fn delete(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let limits = cx.writing_caller().await?;
    let service = service(cx)?;
    let id = str_arg(args, "scheduledTaskId").unwrap_or_default();
    let existing = load_task(cx, service, id, &limits).await?;
    service.delete(&existing.id).await.map_err(|error| {
        fail(
            "orchestration_error",
            format!("Could not delete scheduled task: {}", error.message),
        )
    })?;
    Ok(json!({ "scheduledTaskId": existing.id, "deleted": true }))
}

/// `run_scheduled_task_now` (`writesEnvironment`): a live caller at full access and default
/// interaction. Success means started, not finished.
pub(super) async fn run_now(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let limits = cx.writing_caller().await?;
    if !(limits.runtime_mode == "full-access" && limits.interaction_mode == "default") {
        return Err(fail("capability_denied", FULL_ACCESS_REQUIRED));
    }
    let service = service(cx)?;
    let id = str_arg(args, "taskId").unwrap_or_default();
    if service.find(id).await.is_none() {
        return Err(fail("invalid_request", "The scheduled task was not found."));
    }
    let outcome = service
        .run_now(id)
        .await
        .map_err(|error| fail("orchestration_error", error.message))?;
    let mut result = json!({
        "taskId": outcome.task.id,
        "threadId": outcome.thread_id,
        "lastRunStatus": to_json(&outcome.task.last_run_status),
        "lastRunError": outcome.task.last_run_error,
        "runCount": outcome.task.run_count,
        "nextRunAt": outcome.task.next_run_at,
    });
    if let Some(thread) = &outcome.thread_id {
        let title = cx
            .projection(thread)
            .await
            .ok()
            .and_then(|p| p["thread"]["title"].as_str().map(str::to_owned))
            .unwrap_or_default();
        result["link"] = json!(cx.link(thread, &title));
    }
    Ok(result)
}
