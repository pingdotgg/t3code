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
/// A read result stays within this many bytes of JSON; later items wait for the next page.
/// Claude Code saves MCP results over about 25k tokens to a file. Bytes, not characters: CJK
/// text runs near one token per character (`THREAD_READ_RESULT_MAX_BYTES`).
const READ_RESULT_MAX_BYTES: usize = 30_000;
const DEFAULT_WAIT_MS: u64 = 10 * 60 * 1000;
pub(super) const MAX_WAIT_MS: u64 = 60 * 60 * 1000;
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

pub(super) async fn list(cx: &Cx<'_>, args: &Args) -> ToolResult {
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

pub(super) async fn read(cx: &Cx<'_>, args: &Args) -> ToolResult {
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
    let page_kind = if after.is_none() && before.is_none() && item_id.is_none() {
        view::Page::First
    } else {
        view::Page::Later
    };
    let thread = view::thread_detail(cx.config(), cx.caller, &projection, &now_iso(), page_kind);
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

    let total = page.len();
    let (items, start) = items_within_budget(
        &json!({"thread": thread, "recentRuns": recent_runs}),
        &page,
        messages,
        max_chars,
        offset,
        newest_first,
    );
    if !newest_first && items.len() < total {
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

/// `timelineItemsWithinBudget`: the items, taken from the end the caller pages toward, whose
/// result fits `READ_RESULT_MAX_BYTES`, and the index of the first one kept. The result is
/// never empty for a page with rows: an oversized first item is cut to fit.
fn items_within_budget(
    envelope: &Value,
    rows: &[&Value],
    messages: &[Value],
    max_chars: usize,
    offset: usize,
    newest_first: bool,
) -> (Vec<Value>, usize) {
    let mut empty = envelope.clone();
    empty["nextPosition"] = Value::Null;
    empty["hasMore"] = json!(false);
    empty["earlierPosition"] = Value::Null;
    empty["items"] = json!([]);
    // An oversized envelope (a huge thread title, say) must not starve the items.
    let budget = READ_RESULT_MAX_BYTES
        .saturating_sub(view::json_bytes(&empty))
        .max(READ_RESULT_MAX_BYTES / 2);
    let ordered: Vec<&Value> = if newest_first {
        rows.iter().rev().copied().collect()
    } else {
        rows.to_vec()
    };
    let mut items: Vec<Value> = Vec::new();
    let mut bytes = 0;
    for row in ordered {
        let item = view::timeline_item(row, messages, max_chars, offset);
        bytes += view::json_bytes(&item) + usize::from(!items.is_empty());
        if bytes <= budget {
            items.push(item);
            continue;
        }
        if items.is_empty() {
            items.push(view::timeline_item_within(
                row, messages, max_chars, offset, budget,
            ));
        }
        break;
    }
    if newest_first {
        items.reverse();
        let start = rows.len().saturating_sub(items.len());
        (items, start)
    } else {
        (items, 0)
    }
}

/// `searchThreads` (`ThreadSearch.ts`): title hits first, then message hits from the
/// engine's index (one per thread, outside the title hits), with a fifth of the slots kept
/// for messages. Candidates are the project's active, listed threads.
pub(super) async fn search(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let query = str_arg(args, "query")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    // `OrchestrationSearchThreadsInput.query`: trimmed, 2 to 200 UTF-16 units.
    let length = query.encode_utf16().count();
    if length < 2 {
        return Err(ToolError::InvalidParams(
            "Expected a value with a length of at least 2\n  at [\"query\"]".into(),
        ));
    }
    if length > SEARCH_QUERY_MAX_LENGTH {
        return Err(ToolError::InvalidParams(format!(
            "Expected a value with a length of at most {SEARCH_QUERY_MAX_LENGTH}\n  at [\"query\"]"
        )));
    }
    let limit = u64_arg(args, "limit").map_or(SEARCH_DEFAULT_LIMIT, |l| l as usize);
    let own = cx.caller_projection().await?;
    let project_id = str_arg(args, "projectId").map(str::to_owned).or_else(|| {
        own.as_ref()
            .and_then(|p| p["thread"]["projectId"].as_str().map(str::to_owned))
    });
    let shell = cx.shell().await?;
    let live_projects: Vec<(&Value, String)> = shell["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["deletedAt"].is_null())
        .map(|p| {
            (
                &p["id"],
                p["title"].as_str().unwrap_or_default().to_lowercase(),
            )
        })
        .collect();
    // `titleCandidates`: not deleted or archived, not a subagent or side chat, in a live project.
    let mut candidates: Vec<&Value> = shell["threads"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["deletedAt"].is_null() && t["archivedAt"].is_null())
        .filter(|t| t["lineage"]["relationshipToParent"] != "subagent")
        .filter(|t| t["lineage"]["sideChat"] != true)
        .filter(|t| live_projects.iter().any(|(id, _)| *id == &t["projectId"]))
        .filter(|t| project_id.as_deref().is_none_or(|id| t["projectId"] == id))
        .collect();
    // Like the clients: what the user last wrote, else when the thread began, newest first.
    let activity = |t: &Value| {
        t["latestUserMessageAt"]
            .as_str()
            .or(t["createdAt"].as_str())
            .unwrap_or_default()
            .to_owned()
    };
    candidates.sort_by_cached_key(|t| std::cmp::Reverse(activity(t)));
    let title_hits: Vec<&Value> = candidates
        .iter()
        .copied()
        .filter(|thread| {
            let lower = |key: &str| thread[key].as_str().unwrap_or_default().to_lowercase();
            let project_hit = live_projects
                .iter()
                .any(|(id, title)| *id == &thread["projectId"] && title.contains(&query));
            lower("title").contains(&query) || lower("branch").contains(&query) || project_hit
        })
        .take(limit)
        .collect();
    let shown: Vec<&Value> = title_hits.iter().map(|t| &t["id"]).collect();
    let mut input = json!({
        "query": query,
        "limit": SEARCH_MESSAGE_LIMIT,
        "excludedThreadIds": shown,
    });
    if let Some(id) = &project_id {
        input["projectId"] = json!(id);
    }
    let found = cx
        .engine()
        .call("orchestration.searchThreads", input)
        .await
        .map_err(|error| internal(format!("{error:?}")))?;
    let message_hits: Vec<Value> = found["matches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|hit| {
            let thread = candidates.iter().find(|t| t["id"] == hit["threadId"])?;
            Some(search_match(
                cx,
                thread,
                hit["source"].as_str().unwrap_or("assistant"),
                hit["snippet"].as_str().map(str::to_owned),
                Some(hit["messageCreatedAt"].clone()),
            ))
        })
        .collect();
    let message_slots = message_hits.len().min(limit / 5);
    let mut matches: Vec<Value> = title_hits
        .iter()
        .take(limit.saturating_sub(message_slots))
        .map(|thread| search_match(cx, thread, "title", None, None))
        .collect();
    matches.extend(message_hits);
    matches.truncate(limit);
    Ok(json!({ "currentThreadId": cx.caller_thread_id(), "matches": matches }))
}

/// The tool's `limit` default, and the message hits `searchThreads` asks the index for.
const SEARCH_DEFAULT_LIMIT: usize = 50;
const SEARCH_MESSAGE_LIMIT: usize = 50;
/// `THREAD_SEARCH_QUERY_MAX_LENGTH`.
const SEARCH_QUERY_MAX_LENGTH: usize = 200;

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

pub(super) fn resolve_runtime_mode(
    limit: &str,
    requested: Option<&str>,
) -> Result<String, ToolError> {
    resolve_mode(
        limit,
        requested,
        runtime_rank,
        "runtime_mode_escalation_denied",
        "runtime",
    )
}

pub(super) fn resolve_interaction_mode(
    limit: &str,
    requested: Option<&str>,
) -> Result<String, ToolError> {
    resolve_mode(
        limit,
        requested,
        interaction_rank,
        "interaction_mode_escalation_denied",
        "interaction",
    )
}

/// Starts a thread through the engine's `launchThread`; returns its projection.
pub(super) async fn launch_thread(cx: &Cx<'_>, input: Value) -> ToolResult {
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

pub(super) async fn launch(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let limits = cx.writing_caller().await?;
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
        None => format!("mcp:launch:{}", conn_support::uuid_v4()),
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
    // `root`, `existing_worktree` and `worktree` go to the engine's launch, which makes a new
    // worktree through the server's host before the thread exists.
    let strategy = args
        .get("workspaceStrategy")
        .cloned()
        .unwrap_or_else(|| json!({"type": "root"}));
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
pub(super) fn normalize_selection(mut selection: Value) -> Value {
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

pub(super) async fn send(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let id = thread_id(args);
    cx.writes_threads(&[str_arg(args, "threadId")]).await?;
    let projection = cx.projection(id).await?;
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
    // `ThreadManagementService.sendToThread`: steer and restart need a running turn; auto
    // steers one if there is one, else starts; queue waits behind the active run.
    let active = view::active_run(&projection).and_then(|r| r["id"].as_str().map(str::to_owned));
    let dispatch_mode = match (mode, active) {
        ("steer" | "restart", None) => {
            let verb = if mode == "steer" {
                "steered"
            } else {
                "restarted"
            };
            return Err(fail(
                "thread_not_sendable",
                format!("Thread {id} has no running turn that can be {verb}."),
            ));
        }
        ("steer" | "auto", Some(run)) => json!({"type": "steer_active", "targetRunId": run}),
        ("restart", Some(run)) => json!({"type": "restart_active", "targetRunId": run}),
        ("queue", _) => json!({"type": "queue_after_active"}),
        _ => json!({"type": "start_immediately"}),
    };
    let sender = cx.caller_thread_id().map(str::to_owned);
    let mut command = json!({
        "type": "message.dispatch",
        "commandId": command_id,
        "threadId": id,
        "messageId": message_id,
        "text": str_arg(args, "message").unwrap_or_default(),
        "attachments": [],
        "dispatchMode": dispatch_mode,
        "createdBy": "agent",
        "creationSource": "mcp",
    });
    if let Some(sender) = sender {
        command["senderThreadId"] = json!(sender);
    }
    cx.dispatch(command).await?;
    let projection = cx.projection(id).await?;
    let message = projection["messages"]
        .as_array()
        .and_then(|messages| messages.iter().find(|m| m["id"] == message_id.as_str()))
        .ok_or_else(|| internal("message.dispatch made no message"))?;
    let run = projection["runs"]
        .as_array()
        .and_then(|runs| runs.iter().find(|r| r["id"] == message["runId"]))
        .ok_or_else(|| internal("message.dispatch made no run"))?;
    let intent = projection["turnItems"]
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item["type"] == "user_message" && item["messageId"] == message_id.as_str()
            })
        })
        .and_then(|item| item["inputIntent"].as_str().map(str::to_owned));
    let delivery = match intent.as_deref() {
        None | Some("queued_turn") => "queued",
        Some("turn_start") => "started",
        _ if mode == "restart" => "restarted",
        _ => "steered",
    };
    Ok(json!({
        "threadId": id,
        "link": cx.link(id, projection["thread"]["title"].as_str().unwrap_or_default()),
        "messageId": message_id,
        "runId": run["id"],
        "status": run["status"],
        "delivery": delivery,
    }))
}

/// Waits until a run ends or waits on a question or approval (a person must answer). No
/// `run_id`: the thread's latest run. Returns the run, `None` for a thread with no run, and
/// whether the wait timed out.
pub(super) async fn wait_for_run(
    cx: &Cx<'_>,
    thread: &str,
    run_id: Option<&str>,
    timeout: Duration,
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
        run.as_ref()
            .is_none_or(|r| !view::is_live(r) || r["status"] == "waiting")
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

pub(super) async fn wait(cx: &Cx<'_>, args: &Args) -> ToolResult {
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
    )
    .await?;
    Ok(json!({
        "threadId": id,
        "runId": run.as_ref().map_or(Value::Null, |r| r["id"].clone()),
        "status": run.as_ref().map_or(json!("idle"), |r| r["status"].clone()),
        "timedOut": timed_out,
    }))
}

pub(super) async fn interrupt(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let id = thread_id(args);
    cx.writes_threads(&[str_arg(args, "threadId")]).await?;
    let projection = cx.projection(id).await?;
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

pub(super) async fn update(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writes_threads(&[str_arg(args, "threadId")]).await?;
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
pub(super) async fn pending_request(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let action = str_arg(args, "action").unwrap_or_default();
    if action == "respond" {
        cx.writes_threads(&[str_arg(args, "threadId")]).await?;
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
            "commandId": format!("command:mcp:{}", conn_support::uuid_v4()),
            "threadId": id,
            "requestId": request_id,
            "answers": answers,
        }))
        .await?;
    Ok(json!({ "sequence": sequence }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(position: i64, text: &str) -> Value {
        json!({ "position": position, "visibility": "visible", "sourceThreadId": "t",
                "sourceItemId": format!("i{position}"),
                "item": { "type": "reasoning", "runId": "r", "status": "completed",
                          "title": null, "updatedAt": "2026-01-01T00:00:00.000Z", "text": text } })
    }

    fn positions(items: &[Value]) -> Vec<i64> {
        items
            .iter()
            .filter_map(|i| i["position"].as_i64())
            .collect()
    }

    #[test]
    fn a_read_keeps_the_end_it_pages_toward_within_the_byte_budget() {
        // 20 rows of 2,000 bytes of text: about 14 fit in 30,000 bytes.
        let rows: Vec<Value> = (0..20).map(|p| row(p, &"x".repeat(2_000))).collect();
        let refs: Vec<&Value> = rows.iter().collect();
        let envelope = json!({"thread": {}, "recentRuns": []});
        let (items, start) = items_within_budget(&envelope, &refs, &[], 2_000, 0, true);
        assert_eq!(items.len(), 20 - start);
        assert!(start > 0);
        assert_eq!(positions(&items).last(), Some(&19));
        let size: usize = items.iter().map(|i| view::json_bytes(i) + 1).sum();
        assert!(size <= READ_RESULT_MAX_BYTES, "{size}");
        // One more row would not fit.
        let next = view::timeline_item(&rows[start - 1], &[], 2_000, 0);
        assert!(size + view::json_bytes(&next) + 1 > READ_RESULT_MAX_BYTES);
        // Paging forward keeps the start.
        let (items, start) = items_within_budget(&envelope, &refs, &[], 2_000, 0, false);
        assert_eq!((positions(&items).first().copied(), start), (Some(0), 0));
        assert!(items.len() < 20);
    }

    #[test]
    fn the_byte_budget_counts_bytes_not_characters() {
        // 3,000 CJK characters are 9,000 bytes; the same 20 rows keep far fewer than by chars.
        let rows: Vec<Value> = (0..20).map(|p| row(p, &"漢".repeat(3_000))).collect();
        let refs: Vec<&Value> = rows.iter().collect();
        let envelope = json!({"thread": {}, "recentRuns": []});
        let (items, _) = items_within_budget(&envelope, &refs, &[], 3_000, 0, true);
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn an_oversized_first_item_is_cut_not_dropped() {
        let rows = [row(0, &"漢".repeat(20_000))];
        let refs: Vec<&Value> = rows.iter().collect();
        let envelope = json!({"thread": {}, "recentRuns": []});
        let (items, start) = items_within_budget(&envelope, &refs, &[], 20_000, 0, true);
        assert_eq!((items.len(), start), (1, 0));
        let item = &items[0];
        assert_eq!(item["textTruncated"], true);
        assert!(view::json_bytes(item) <= READ_RESULT_MAX_BYTES);
        assert_eq!(
            item["nextTextOffset"].as_u64(),
            item["text"].as_str().map(|t| t.chars().count() as u64)
        );
    }
}
