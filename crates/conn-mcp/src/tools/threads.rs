//! Thread tools: launch, list, read, search, send, wait, interrupt, update, pending requests.

use std::time::Duration;

use conn_contract::from_json;
use conn_engine::EngineError;
use serde_json::{Value, json};

use super::{
    Args, Cx, ToolError, ToolResult, bool_arg, fail, interaction_rank, internal, projects,
    runtime_rank, str_arg, u64_arg,
};
use crate::{time::now_iso, view};

const DEFAULT_LIST_LIMIT: usize = 10;
const DEFAULT_READ_LIMIT: usize = 10;
const DEFAULT_RUN_LIMIT: usize = 10;
const DEFAULT_ITEM_MAX_CHARS: usize = 500;
/// A read stays near this size; later items wait for the next page.
const READ_BUDGET_CHARS: usize = 30_000;
const DEFAULT_WAIT_MS: u64 = 10 * 60 * 1000;
pub const MAX_WAIT_MS: u64 = 60 * 60 * 1000;
const MESSAGE_VIEW_TYPES: [&str; 3] = ["user_message", "assistant_message", "proposed_plan"];

fn thread_id(args: &Args) -> &str {
    str_arg(args, "threadId").unwrap_or_default()
}

/// The thread a tool acts on: `threadId`, or the caller's own thread.
fn target_id<'a>(cx: &'a Cx<'_>, args: &'a Args) -> Result<&'a str, ToolError> {
    str_arg(args, "threadId")
        .or_else(|| cx.caller_thread_id())
        .ok_or_else(|| {
            fail(
                "target_required",
                "Pass threadId: this MCP client is not running inside a T3 thread.",
            )
        })
}

pub async fn list(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let all = bool_arg(args, "allProjects") == Some(true);
    let own = cx.caller_projection().await?;
    let project_id: Option<String> = if all {
        None
    } else if let Some(id) = str_arg(args, "projectId") {
        Some(id.to_owned())
    } else if let Some(own) = &own {
        own["thread"]["projectId"].as_str().map(str::to_owned)
    } else {
        return Err(fail(
            "target_required",
            "Pass projectId, or allProjects: true for every project. This MCP client is not running inside a T3 thread.",
        ));
    };
    let shell = cx.shell().await?;
    if let (Some(id), Some(_)) = (&project_id, str_arg(args, "projectId"))
        && !shell["projects"]
            .as_array()
            .is_some_and(|p| p.iter().any(|p| p["id"] == id.as_str()))
    {
        return Err(fail("invalid_request", "The project was not found."));
    }
    let now = now_iso();
    let statuses: Vec<&str> = args
        .get("statuses")
        .and_then(Value::as_array)
        .map(|s| s.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let title = str_arg(args, "titleContains").map(str::to_lowercase);
    let include_subagents = bool_arg(args, "includeSubagents") != Some(false);
    let mut threads: Vec<&Value> = shell["threads"]
        .as_array()
        .map(|t| t.iter().collect())
        .unwrap_or_default();
    threads.retain(|t| {
        project_id.as_deref().is_none_or(|id| t["projectId"] == id)
            && (include_subagents || t["lineage"]["relationshipToParent"] != "subagent")
            && (statuses.is_empty()
                || view::listed_status(t)
                    .as_str()
                    .is_some_and(|s| statuses.contains(&s)))
            && bool_arg(args, "settled").is_none_or(|want| view::is_settled(t) == want)
            && bool_arg(args, "snoozed").is_none_or(|want| view::is_snoozed(t, &now) == want)
            && title.as_deref().is_none_or(|needle| {
                t["title"]
                    .as_str()
                    .is_some_and(|title| title.to_lowercase().contains(needle))
            })
    });
    // Newest first.
    threads.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
    let cursor = u64_arg(args, "cursor").unwrap_or(0) as usize;
    let limit = u64_arg(args, "limit").map_or(DEFAULT_LIST_LIMIT, |l| l as usize);
    let page: Vec<Value> = threads
        .iter()
        .skip(cursor)
        .take(limit)
        .map(|t| view::list_item(cx.config(), cx.caller, t, &now))
        .collect();
    let end = cursor + page.len();
    Ok(json!({
        "projectId": project_id,
        "currentThreadId": cx.caller_thread_id(),
        "threads": page,
        "nextCursor": if end < threads.len() { json!(end) } else { Value::Null },
        "total": threads.len(),
    }))
}

pub async fn read(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let id = thread_id(args);
    let projection = cx.projection(id).await?;
    let view_name = str_arg(args, "view").unwrap_or("messages");
    let limit = u64_arg(args, "limit").map_or(DEFAULT_READ_LIMIT, |l| l.min(100) as usize);
    let max_chars =
        u64_arg(args, "maxCharsPerItem").map_or(DEFAULT_ITEM_MAX_CHARS, |m| m.min(20_000) as usize);
    let run_limit = u64_arg(args, "runLimit").map_or(DEFAULT_RUN_LIMIT, |r| r.min(50) as usize);
    let after = args.get("afterPosition").and_then(Value::as_i64);
    let before = u64_arg(args, "beforePosition");
    let item_id = str_arg(args, "itemId");
    // Thread callers read newest first; clients (the CLI, Swamp) page forward from the start.
    let newest_first = before.is_some()
        || (after.is_none() && item_id.is_none() && cx.caller_thread_id().is_some());

    let rows: Vec<&Value> = projection["visibleTurnItems"]
        .as_array()
        .map(|r| r.iter().collect())
        .unwrap_or_default();
    let in_view = |row: &&Value| {
        view_name == "activity"
            || MESSAGE_VIEW_TYPES.contains(&row["item"]["type"].as_str().unwrap_or(""))
    };
    let position = |row: &Value| row["position"].as_i64().unwrap_or(0);
    let (page, mut has_more, has_earlier): (Vec<&Value>, bool, bool) = if let Some(item) = item_id {
        let found: Vec<&Value> = rows
            .iter()
            .copied()
            .filter(|r| r["sourceItemId"] == item)
            .collect();
        (found, false, false)
    } else if newest_first {
        let matching: Vec<&Value> = rows
            .iter()
            .copied()
            .filter(in_view)
            .filter(|r| before.is_none_or(|b| position(r) < b as i64))
            .filter(|r| after.is_none_or(|a| position(r) > a))
            .collect();
        let start = matching.len().saturating_sub(limit);
        (matching[start..].to_vec(), false, start > 0)
    } else {
        let after = after.unwrap_or(-1);
        let matching: Vec<&Value> = rows
            .iter()
            .copied()
            .filter(in_view)
            .filter(|r| position(r) > after)
            .collect();
        let earlier = rows
            .iter()
            .copied()
            .filter(in_view)
            .any(|r| position(r) <= after);
        (
            matching.iter().copied().take(limit).collect(),
            matching.len() > limit,
            earlier,
        )
    };
    let messages: &[Value] = projection["messages"].as_array().map_or(&[], Vec::as_slice);
    let offset = if item_id.is_some() {
        u64_arg(args, "textOffset").unwrap_or(0) as usize
    } else {
        0
    };
    let mut items: Vec<Value> = page
        .iter()
        .map(|row| view::timeline_item(row, messages, max_chars, offset))
        .collect();
    let page = if after.is_none() && before.is_none() && item_id.is_none() {
        view::Page::First
    } else {
        view::Page::Later
    };
    let thread = view::thread_detail(cx.config(), cx.caller, &projection, &now_iso(), page);
    let mut runs: Vec<&Value> = projection["runs"]
        .as_array()
        .map(|r| r.iter().collect())
        .unwrap_or_default();
    runs.sort_by_key(|run| std::cmp::Reverse(run["ordinal"].as_u64().unwrap_or(0)));
    let recent_runs: Vec<Value> = runs
        .into_iter()
        .take(run_limit)
        .map(|run| view::thread_run(&projection, run))
        .collect();

    // Keep the end of the page the caller reads toward, and at least one item.
    let mut size = json!({"thread": thread, "recentRuns": recent_runs})
        .to_string()
        .len();
    let mut kept = 0;
    let order: Vec<usize> = if newest_first {
        (0..items.len()).rev().collect()
    } else {
        (0..items.len()).collect()
    };
    for index in order {
        size += items[index].to_string().len() + 1;
        if kept > 0 && size > READ_BUDGET_CHARS {
            break;
        }
        kept += 1;
    }
    let start = if newest_first { items.len() - kept } else { 0 };
    let total = items.len();
    items = items.drain(start..start + kept).collect();
    if !newest_first && kept < total {
        has_more = true;
    }
    let earlier = (has_earlier || start > 0)
        .then(|| items.first().map(|i| i["position"].clone()))
        .flatten();
    Ok(json!({
        "thread": thread,
        "recentRuns": recent_runs,
        "nextPosition": items.last().map_or(Value::Null, |i| i["position"].clone()),
        "hasMore": has_more,
        "earlierPosition": earlier,
        "items": items,
    }))
}

const SNIPPET_CHARS: usize = 240;

/// Title, branch, project title, then message text, in active non-subagent threads.
pub async fn search(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let query = str_arg(args, "query")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if query.chars().count() < 2 {
        return Err(ToolError::InvalidParams(
            "Expected a value with a length of at least 2\n  at [\"query\"]".into(),
        ));
    }
    let limit = u64_arg(args, "limit").unwrap_or(10) as usize;
    let own = cx.caller_projection().await?;
    let project_id = str_arg(args, "projectId").map(str::to_owned).or_else(|| {
        own.as_ref()
            .and_then(|p| p["thread"]["projectId"].as_str().map(str::to_owned))
    });
    let shell = cx.shell().await?;
    let project_titles: Vec<(&Value, String)> = shell["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            (
                &p["id"],
                p["title"].as_str().unwrap_or_default().to_lowercase(),
            )
        })
        .collect();
    let threads: Vec<&Value> = shell["threads"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["lineage"]["relationshipToParent"] != "subagent")
        .filter(|t| project_id.as_deref().is_none_or(|id| t["projectId"] == id))
        .collect();
    let mut matches = Vec::new();
    let mut pending = Vec::new();
    for thread in &threads {
        let lower = |key: &str| thread[key].as_str().unwrap_or_default().to_lowercase();
        let project_hit = project_titles
            .iter()
            .any(|(id, title)| *id == &thread["projectId"] && title.contains(&query));
        if lower("title").contains(&query) || lower("branch").contains(&query) || project_hit {
            matches.push(search_match(cx, thread, "title", None, None));
        } else {
            pending.push(*thread);
        }
    }
    // Message text costs a projection read per thread; stop once the page is full.
    for thread in pending {
        if matches.len() >= limit {
            break;
        }
        let Ok(projection) = cx
            .projection(thread["id"].as_str().unwrap_or_default())
            .await
        else {
            continue;
        };
        let hit = projection["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .find(|m| {
                m["text"]
                    .as_str()
                    .is_some_and(|text| text.to_lowercase().contains(&query))
            });
        if let Some(message) = hit {
            let source = if message["role"] == "user" {
                "user"
            } else {
                "assistant"
            };
            let text = message["text"].as_str().unwrap_or_default();
            let snippet: String = text.chars().take(SNIPPET_CHARS).collect();
            matches.push(search_match(
                cx,
                thread,
                source,
                Some(snippet),
                Some(message["createdAt"].clone()),
            ));
        }
    }
    matches.truncate(limit);
    Ok(json!({ "currentThreadId": cx.caller_thread_id(), "matches": matches }))
}

fn search_match(
    cx: &Cx<'_>,
    thread: &Value,
    source: &str,
    snippet: Option<String>,
    at: Option<Value>,
) -> Value {
    let id = thread["id"].as_str().unwrap_or_default();
    let title = thread["title"].as_str().unwrap_or_default();
    let mut out = json!({
        "threadId": id, "projectId": thread["projectId"], "title": title,
        "link": cx.link(id, title), "source": source,
    });
    if let Some(snippet) = snippet {
        out["snippet"] = json!(snippet);
        out["messageCreatedAt"] = at.unwrap_or(Value::Null);
    }
    out
}

/// A mode the caller asked for, never broader than its own (TS `resolveRuntimeMode`).
fn resolve_mode(
    limit: &str,
    requested: Option<&str>,
    rank: fn(&str) -> usize,
    code: &'static str,
    noun: &str,
) -> Result<String, ToolError> {
    let resolved = match requested {
        None | Some("inherit") => limit,
        Some(mode) => mode,
    };
    if rank(resolved) > rank(limit) {
        return Err(fail(
            code,
            format!("Child {noun} mode {resolved} is broader than parent mode {limit}."),
        ));
    }
    Ok(resolved.to_owned())
}

pub fn resolve_runtime_mode(limit: &str, requested: Option<&str>) -> Result<String, ToolError> {
    resolve_mode(
        limit,
        requested,
        runtime_rank,
        "runtime_mode_escalation_denied",
        "runtime",
    )
}

pub fn resolve_interaction_mode(limit: &str, requested: Option<&str>) -> Result<String, ToolError> {
    resolve_mode(
        limit,
        requested,
        interaction_rank,
        "interaction_mode_escalation_denied",
        "interaction",
    )
}

/// Starts a thread through the engine's `launchThread`; returns its projection.
pub async fn launch_thread(cx: &Cx<'_>, input: Value) -> ToolResult {
    match cx.engine().launch_thread(input).await {
        Ok(result) => Ok(result["projection"].clone()),
        Err(EngineError::Rejected(error)) => Err(fail(
            "invalid_request",
            error["message"]
                .as_str()
                .unwrap_or("The thread could not start.")
                .to_owned(),
        )),
        Err(EngineError::Internal(message)) => Err(internal(message)),
    }
}

pub async fn launch(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.require_write()?;
    let limits = cx.limits().await?;
    let own = cx.caller_projection().await?;
    if bool_arg(args, "scratch") == Some(true) {
        return Err(fail(
            "invalid_request",
            "Conn Server has no Scratch folder yet. Pass projectId.",
        ));
    }
    if args
        .get("attachments")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
    {
        return Err(fail(
            "invalid_request",
            "A new thread accepts only pending attachment uploads, and Conn Server takes none yet.",
        ));
    }
    let project_id = match str_arg(args, "projectId") {
        Some(id) => id.to_owned(),
        None => own
            .as_ref()
            .and_then(|p| p["thread"]["projectId"].as_str().map(str::to_owned))
            .ok_or_else(|| {
                fail(
                    "target_required",
                    "Pass projectId: this MCP client is not running inside a T3 thread.",
                )
            })?,
    };
    // A retry with the same key replays the first launch: the ids derive from the caller
    // and the key, and the engine replays a command it already accepted.
    let command_id = match str_arg(args, "clientRequestId") {
        Some(key) => cx.hashed_id("mcp:launch:", key),
        None => format!("mcp:launch:{}", crate::uuid_v4()),
    };
    let model_selection = args
        .get("modelSelection")
        .cloned()
        .or_else(|| own.as_ref().map(|p| p["thread"]["modelSelection"].clone()))
        .or_else(|| projects::default_model_selection(cx))
        .ok_or_else(|| {
            fail(
                "invalid_request",
                "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
            )
        })?;
    let model_selection = normalize_selection(model_selection);
    if let Some(instance) = model_selection["instanceId"].as_str()
        && projects::provider(cx, instance).is_none()
    {
        return Err(fail(
            "provider_unavailable",
            format!(
                "Provider {instance} is not available here. orchestrator_capabilities lists providers."
            ),
        ));
    }
    let runtime_mode = resolve_runtime_mode(&limits.runtime_mode, str_arg(args, "runtimeMode"))?;
    let interaction_mode =
        resolve_interaction_mode(&limits.interaction_mode, str_arg(args, "interactionMode"))?;
    let strategy = args
        .get("workspaceStrategy")
        .cloned()
        .unwrap_or_else(|| json!({"type": "root"}));
    if strategy["type"] == "worktree" {
        return Err(fail(
            "invalid_request",
            "Conn Server cannot prepare a new worktree yet. No thread was created. Use workspaceStrategy: {type: \"root\"}.",
        ));
    }
    let mut input = json!({
        "commandId": command_id,
        "threadId": command_id,
        "projectId": project_id,
        "title": str_arg(args, "title").unwrap_or_default(),
        "modelSelection": model_selection,
        "runtimeMode": runtime_mode,
        "interactionMode": interaction_mode,
        "workspaceStrategy": strategy,
        "createdBy": "agent",
        "creationSource": "mcp",
    });
    if let Some(message) = str_arg(args, "message") {
        input["initialMessage"] = json!({
            "messageId": command_id,
            "text": message,
            "attachments": [],
        });
    }
    let projection = launch_thread(cx, input).await?;
    let thread = &projection["thread"];
    let id = thread["id"].as_str().unwrap_or_default();
    let run = projection["runs"].as_array().and_then(|runs| {
        runs.iter()
            .find(|r| r["userMessageId"] == command_id.as_str())
    });
    Ok(json!({
        "threadId": id,
        "link": cx.link(id, thread["title"].as_str().unwrap_or_default()),
        "projectId": thread["projectId"],
        "modelSelection": thread["modelSelection"],
        "runId": run.map_or(Value::Null, |r| r["id"].clone()),
        "status": run.map_or(Value::Null, |r| r["status"].clone()),
    }))
}

/// `{instanceId, model, options?}`; `provider` names the instance in older clients.
fn normalize_selection(mut selection: Value) -> Value {
    if selection["instanceId"].is_null()
        && let Some(provider) = selection.get("provider").cloned()
    {
        selection["instanceId"] = provider;
    }
    if let Some(map) = selection.as_object_mut() {
        map.remove("provider");
        map.retain(|_, v| !v.is_null());
    }
    selection
}

pub async fn send(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.require_write()?;
    let id = thread_id(args);
    let limits = cx.limits().await?;
    let projection = cx.projection(id).await?;
    cx.within_limits(&limits, &projection["thread"])?;
    let mode = str_arg(args, "mode").unwrap_or("auto");
    if bool_arg(args, "freshContext") == Some(true) {
        return Err(fail(
            "thread_not_sendable",
            "Conn Server cannot start a fresh provider session on send yet.",
        ));
    }
    let key = Cx::request_key(args);
    let message_id = cx.stable_id("message", "thread-send", &key);
    let command_id = cx.stable_id("command", "thread-send", &key);
    let replay = projection["runs"]
        .as_array()
        .and_then(|runs| {
            runs.iter()
                .find(|r| r["userMessageId"] == message_id.as_str())
        })
        .cloned();
    let mut delivery = "started";
    if replay.is_none()
        && let Some(active) = view::active_run(&projection)
    {
        if mode != "restart" {
            return Err(fail(
                "thread_not_sendable",
                format!(
                    "Thread {id} is running run {}. Conn Server cannot queue or steer a message yet: wait for the run with t3_thread_wait, then send, or send with mode \"restart\".",
                    active["id"].as_str().unwrap_or_default()
                ),
            ));
        }
        let run_id = active["id"].as_str().unwrap_or_default().to_owned();
        cx.dispatch(json!({
            "type": "run.interrupt",
            "commandId": format!("{command_id}:interrupt"),
            "threadId": id,
            "runId": run_id,
            "reason": "Restarted by an agent's message.",
        }))
        .await?;
        wait_for_run(cx, id, Some(&run_id), Duration::from_secs(30), Until::Ended).await?;
        delivery = "restarted";
    }
    let sender = cx.caller_thread_id().map(str::to_owned);
    let mut command = json!({
        "type": "message.dispatch",
        "commandId": command_id,
        "threadId": id,
        "messageId": message_id,
        "text": str_arg(args, "message").unwrap_or_default(),
        "attachments": [],
        "dispatchMode": {"type": "start_immediately"},
        "createdBy": "agent",
        "creationSource": "mcp",
    });
    if let Some(sender) = sender {
        command["senderThreadId"] = json!(sender);
    }
    cx.dispatch(command).await?;
    let projection = cx.projection(id).await?;
    let run = projection["runs"]
        .as_array()
        .and_then(|runs| {
            runs.iter()
                .find(|r| r["userMessageId"] == message_id.as_str())
        })
        .ok_or_else(|| internal("message.dispatch made no run"))?;
    Ok(json!({
        "threadId": id,
        "link": cx.link(id, projection["thread"]["title"].as_str().unwrap_or_default()),
        "messageId": message_id,
        "runId": run["id"],
        "status": run["status"],
        "delivery": delivery,
    }))
}

/// When a wait for a run ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Until {
    Ended,
    /// Also when it waits on a question or approval: a person must answer.
    EndedOrWaiting,
}

/// Waits until a run reaches `until`. No `run_id`: the thread's latest run. Returns the run, `None` for a thread with
/// no run, and whether the wait timed out.
pub async fn wait_for_run(
    cx: &Cx<'_>,
    thread: &str,
    run_id: Option<&str>,
    timeout: Duration,
    until: Until,
) -> Result<(Option<Value>, bool), ToolError> {
    let pick = |projection: &Value| -> Result<Option<Value>, ToolError> {
        match run_id {
            Some(id) => view::run_by_id(projection, id)
                .cloned()
                .map(Some)
                .ok_or_else(|| {
                    fail(
                        "run_not_found",
                        format!("Run {id} is not in thread {thread}."),
                    )
                }),
            None => Ok(view::latest_run(projection).cloned()),
        }
    };
    let settled = |run: &Option<Value>| {
        run.as_ref().is_none_or(|r| {
            !view::is_live(r) || (until == Until::EndedOrWaiting && r["status"] == "waiting")
        })
    };
    let deadline = tokio::time::Instant::now() + timeout;
    // The stream starts with a snapshot, then carries each committed event.
    let input = from_json(json!({"threadId": thread})).map_err(internal)?;
    let mut stream = match cx.engine().subscribe_thread(input).await {
        Ok(stream) => stream,
        Err(EngineError::Rejected(_)) => {
            return Err(fail(
                "thread_not_found",
                format!("Thread {thread} is no longer available."),
            ));
        }
        Err(EngineError::Internal(message)) => return Err(internal(message)),
    };
    let mut current = pick(&cx.projection(thread).await?)?;
    loop {
        if settled(&current) {
            return Ok((current, false));
        }
        let item = match tokio::time::timeout_at(deadline, stream.recv()).await {
            Err(_) => return Ok((current, true)),
            Ok(None) | Ok(Some(Err(_))) => {
                return Ok((pick(&cx.projection(thread).await?)?, false));
            }
            Ok(Some(Ok(item))) => conn_contract::to_json(&item),
        };
        let kind = item["event"]["type"].as_str().unwrap_or_default();
        if kind.starts_with("run.") || kind.starts_with("runtime-request.") {
            current = pick(&cx.projection(thread).await?)?;
        }
    }
}

pub async fn wait(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let id = thread_id(args);
    cx.projection(id).await?;
    let timeout = args
        .get("timeoutMs")
        .and_then(Value::as_f64)
        .map_or(DEFAULT_WAIT_MS, |ms| (ms.max(1.0) as u64).min(MAX_WAIT_MS));
    let (run, timed_out) = wait_for_run(
        cx,
        id,
        str_arg(args, "runId"),
        Duration::from_millis(timeout),
        Until::EndedOrWaiting,
    )
    .await?;
    Ok(json!({
        "threadId": id,
        "runId": run.as_ref().map_or(Value::Null, |r| r["id"].clone()),
        "status": run.as_ref().map_or(json!("idle"), |r| r["status"].clone()),
        "timedOut": timed_out,
    }))
}

pub async fn interrupt(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.require_write()?;
    let id = thread_id(args);
    let limits = cx.limits().await?;
    let projection = cx.projection(id).await?;
    cx.within_limits(&limits, &projection["thread"])?;
    let key = Cx::request_key(args);
    let reason = str_arg(args, "reason")
        .map(str::to_owned)
        .unwrap_or_else(|| "Stopped by an agent.".to_owned());
    let run = match str_arg(args, "runId") {
        Some(run_id) => Some(
            view::run_by_id(&projection, run_id)
                .ok_or_else(|| {
                    fail(
                        "run_not_found",
                        format!("Run {run_id} is not in thread {id}."),
                    )
                })?
                .clone(),
        ),
        None => view::active_run(&projection).cloned(),
    };
    let Some(run) = run else {
        return Ok(json!({"threadId": id, "runId": null, "status": "no_active_run"}));
    };
    if !view::is_live(&run) {
        return Ok(json!({"threadId": id, "runId": run["id"], "status": run["status"]}));
    }
    let command = if bool_arg(args, "stop") == Some(true) {
        json!({
            "type": "thread.stop",
            "commandId": cx.stable_id("command", "thread-stop", &key),
            "threadId": id,
            "reason": reason,
        })
    } else {
        json!({
            "type": "run.interrupt",
            "commandId": cx.stable_id("command", "thread-interrupt", &key),
            "threadId": id,
            "runId": run["id"],
            "reason": reason,
        })
    };
    cx.dispatch(command).await?;
    Ok(json!({"threadId": id, "runId": run["id"], "status": "interrupt_requested"}))
}

pub async fn update(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.require_write()?;
    let id = target_id(cx, args)?.to_owned();
    let action = str_arg(args, "action").unwrap_or_default();
    if action == "regenerate_title" {
        return Err(fail(
            "invalid_request",
            "Conn Server cannot generate titles yet. Rename with action \"rename\" and a title.",
        ));
    }
    let title = str_arg(args, "title")
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| fail("invalid_request", "Pass a non-empty title to rename."))?;
    let key = Cx::request_key(args);
    let command_id = cx.stable_id("command", "thread-update", &key);
    cx.projection(&id).await?;
    let sequence = cx
        .dispatch(json!({
            "type": "thread.metadata.update",
            "commandId": command_id,
            "threadId": id,
            "title": title,
        }))
        .await?;
    let projection = cx.projection(&id).await?;
    let thread = &projection["thread"];
    Ok(json!({
        "threadId": id,
        "action": action,
        "commandId": command_id,
        "sequence": sequence,
        "title": thread["title"],
        "titleRegeneration": null,
        "linkedPullRequest": thread.get("linkedPullRequest").cloned().unwrap_or(Value::Null),
        "updatedAt": projection["updatedAt"],
    }))
}

/// Questions an agent asked (`user_input` requests); approvals are not listed or answered.
pub async fn pending_request(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let action = str_arg(args, "action").unwrap_or_default();
    if action == "respond" {
        cx.require_write()?;
    }
    let id = target_id(cx, args)?.to_owned();
    let projection = cx
        .projection(&id)
        .await
        .map_err(|_| fail("thread_not_found", "The thread was not found."))?;
    let requests = projection["runtimeRequests"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if action == "list" {
        let ids: Vec<Value> = requests
            .iter()
            .filter(|r| r["kind"] == "user_input" && r["status"] == "pending")
            .map(|r| r["id"].clone())
            .collect();
        return Ok(json!({ "requestIds": ids }));
    }
    let request_id = str_arg(args, "requestId")
        .ok_or_else(|| fail("invalid_request", "This action needs `requestId`."))?;
    let request = requests
        .iter()
        .find(|r| r["id"] == request_id && r["kind"] == "user_input");
    let item = projection["turnItems"].as_array().and_then(|items| {
        items
            .iter()
            .find(|i| i["type"] == "user_input_request" && i["requestId"] == request_id)
    });
    let (Some(request), Some(item)) = (request, item) else {
        return Err(fail(
            "invalid_request",
            "The pending user-input request was not found.",
        ));
    };
    if request["status"] != "pending" {
        return Err(fail(
            "invalid_request",
            if request["status"] == "resolved" {
                "The user-input request was already answered.".to_owned()
            } else {
                format!(
                    "The user-input request is no longer pending ({}).",
                    request["status"].as_str().unwrap_or_default()
                )
            },
        ));
    }
    if action == "read" {
        return Ok(json!({"requestId": request_id, "questions": item["questions"]}));
    }
    let answers = args
        .get("answers")
        .cloned()
        .ok_or_else(|| fail("invalid_request", "This action needs `answers`."))?;
    let sequence = cx
        .dispatch(json!({
            "type": "runtime-request.respond",
            "commandId": format!("command:mcp:{}", crate::uuid_v4()),
            "threadId": id,
            "requestId": request_id,
            "answers": answers,
        }))
        .await?;
    Ok(json!({ "sequence": sequence }))
}
