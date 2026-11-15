//! Thread management tools on existing engine commands (`toolkits/thread/handlers.ts`):
//! organize, queue, configure.

use std::{collections::HashSet, sync::Arc, time::Duration};

use conn_contract::from_json;
use serde_json::{Value, json};

use super::{Args, Cx, ToolError, ToolResult, fail, has_active_run, str_arg, threads, u64_arg};
use crate::{McpService, view};

/// `readThread`: the target (`threadId`, else the caller's own thread) and its projection.
async fn read_thread(cx: &Cx<'_>, args: &Args) -> Result<(String, Value), ToolError> {
    let id = str_arg(args, "threadId")
        .or_else(|| cx.caller_thread_id())
        .ok_or_else(|| {
            fail(
                "target_required",
                "Pass threadId: this MCP client is not running inside a T3 thread.",
            )
        })?
        .to_owned();
    let projection = cx.projection(&id).await.map_err(|error| match error {
        ToolError::Failure {
            code: "thread_not_found",
            ..
        } => fail("thread_not_found", "The thread was not found."),
        other => other,
    })?;
    Ok((id, projection))
}

/// `newCommandId`.
fn new_command_id() -> String {
    format!("mcp:{}", conn_support::uuid_v4())
}

/// A field the chosen action needs (TS `required`). `null` counts as given.
fn required<'a>(args: &'a Args, name: &str) -> Result<&'a Value, ToolError> {
    args.get(name)
        .ok_or_else(|| fail("invalid_request", format!("This action needs `{name}`.")))
}

/// `t3_thread_organize`: `writesThreads([threadId])`, then one engine command. A thread's own
/// agent that settles its thread mid-turn gets `settlesWhenTurnEnds` and the thread settles
/// after the run completes (`ThreadManagementService.settleThread`).
pub(super) async fn organize(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writes_threads(&[str_arg(args, "threadId")]).await?;
    let (id, projection) = read_thread(cx, args).await?;
    let action = str_arg(args, "action").unwrap_or_default();
    let command_id = new_command_id();
    let command = match action {
        "settle" => {
            let by_own_agent = cx.caller_thread_id() == Some(id.as_str());
            if by_own_agent
                && has_active_run(&projection)
                && let Some(run) = view::active_run(&projection)
            {
                let run_id = run["id"].as_str().unwrap_or_default().to_owned();
                settle_after_run(cx.service, id, run_id);
                return Ok(json!({"settlesWhenTurnEnds": true}));
            }
            json!({"type": "thread.settle", "commandId": command_id, "threadId": id})
        }
        "snooze" => {
            let Some(until) = args.get("snoozedUntil") else {
                return Err(fail("invalid_request", "snooze requires snoozedUntil."));
            };
            json!({"type": "thread.snooze", "commandId": command_id, "threadId": id,
                   "snoozedUntil": until})
        }
        "unsnooze" | "unsettle" => json!({
            "type": format!("thread.{action}"), "commandId": command_id, "threadId": id,
            "reason": "user",
        }),
        "mark_unread" => {
            json!({"type": "thread.mark-unread", "commandId": command_id, "threadId": id})
        }
        // pin, unpin, archive, unarchive: the catalog allows no other action.
        _ => json!({"type": format!("thread.{action}"), "commandId": command_id, "threadId": id}),
    };
    let sequence = cx.dispatch(command).await?;
    Ok(json!({ "sequence": sequence }))
}

/// `SETTLE_AFTER_RUN_WAIT_MS`.
const SETTLE_AFTER_RUN_WAIT: Duration = Duration::from_secs(24 * 60 * 60);

/// Run statuses after which a run never changes (`isTerminalRunStatus`).
const TERMINAL_RUN_STATUSES: [&str; 4] = ["completed", "failed", "cancelled", "interrupted"];

fn is_terminal(run: &Value) -> bool {
    TERMINAL_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or_default())
}

/// `settleAfterRun`, in the background. At most one waits per thread: a second request for
/// the same thread while one waits adds nothing. Each waiting task holds one engine
/// subscription, so their number is bounded by the threads with an active run.
fn settle_after_run(service: &Arc<McpService>, thread_id: String, run_id: String) {
    if !crate::lock(&service.settling).insert(thread_id.clone()) {
        return;
    }
    let service = Arc::clone(service);
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + SETTLE_AFTER_RUN_WAIT;
        if let Err(message) = settle_when_run_ends(&service, &thread_id, &run_id, deadline).await {
            eprintln!("mcp: settle after run {run_id}: {message}");
        }
        crate::lock(&service.settling).remove(&thread_id);
    });
}

/// Waits until `run_id` ends. A completed run then settles the thread once only automatic
/// messages (notifications, delegated completions) followed it; anything a person sent, or a
/// following run that failed, leaves the thread active.
async fn settle_when_run_ends(
    service: &McpService,
    thread_id: &str,
    run_id: &str,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let engine = service.config.engine.as_ref();
    let input = from_json(json!({"threadId": thread_id})).map_err(|e| e.to_string())?;
    let mut stream = engine
        .subscribe_thread(input)
        .await
        .map_err(|e| format!("{e:?}"))?;
    let mut waiting_for_end = true;
    let mut sequence = 0;
    loop {
        let projection = engine
            .get_thread_projection(thread_id.into())
            .await
            .map_err(|e| format!("{e:?}"))?;
        let Some(run) = view::run_by_id(&projection, run_id) else {
            return Ok(());
        };
        if waiting_for_end && is_terminal(run) {
            if run["status"] != "completed" {
                return Ok(());
            }
            waiting_for_end = false;
        }
        if !waiting_for_end
            && let Some(done) = try_settle(service, thread_id, run, &projection, sequence).await
            && done
        {
            return Ok(());
        }
        // The next run change, or the end of the wait.
        loop {
            let item = match tokio::time::timeout_at(deadline, stream.recv()).await {
                Err(_) | Ok(None) | Ok(Some(Err(_))) => return Ok(()),
                Ok(Some(Ok(item))) => conn_contract::to_json(&item),
            };
            sequence = item["sequence"].as_u64().unwrap_or(sequence);
            if item["event"]["type"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("run."))
            {
                break;
            }
        }
    }
}

/// One `trySettle`: `Some(true)` when done (settled or given up), `Some(false)` to wait for
/// the next run change.
async fn try_settle(
    service: &McpService,
    thread_id: &str,
    run: &Value,
    projection: &Value,
    sequence: u64,
) -> Option<bool> {
    let ordinal = run["ordinal"].as_u64().unwrap_or(0);
    let runs: Vec<&Value> = projection["runs"].as_array()?.iter().collect();
    let following: Vec<&Value> = runs
        .iter()
        .copied()
        .filter(|r| r["ordinal"].as_u64().unwrap_or(0) > ordinal)
        .collect();
    if !following.is_empty() {
        let following_ids: HashSet<&str> =
            following.iter().filter_map(|r| r["id"].as_str()).collect();
        let messages: Vec<&Value> = projection["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| {
                m["role"] == "user"
                    && m["runId"]
                        .as_str()
                        .is_some_and(|id| following_ids.contains(id))
            })
            .collect();
        let automatic: HashSet<&str> = messages
            .iter()
            .filter(|m| !m["notification"].is_null() || !m["delegatedCompletion"].is_null())
            .filter_map(|m| m["id"].as_str())
            .collect();
        let by_person = messages
            .iter()
            .any(|m| !m["id"].as_str().is_some_and(|id| automatic.contains(id)))
            || following.iter().any(|r| {
                !r["userMessageId"]
                    .as_str()
                    .is_some_and(|id| automatic.contains(id))
            });
        if by_person {
            return Some(true);
        }
        if following
            .iter()
            .any(|r| r["status"] != "queued" && !is_terminal(r))
        {
            return Some(false);
        }
        if following
            .iter()
            .any(|r| r["status"] != "queued" && r["status"] != "completed")
        {
            return Some(true);
        }
    }
    let Some(latest) = view::latest_run(projection) else {
        return Some(true);
    };
    let command = json!({
        "type": "thread.settle",
        "commandId": format!("server:settle-after-run:{}:{sequence}", run["id"].as_str().unwrap_or_default()),
        "threadId": thread_id,
        "expectedLatestRunId": latest["id"],
    });
    let command = from_json(command).ok()?;
    // A notification can start between the read and the guarded dispatch: then wait.
    Some(service.config.engine.dispatch(command).await.is_ok())
}

/// `QUEUE_LIST_TEXT_LIMIT` and the `read` limit, in code points (`Array.from`).
const QUEUE_LIST_TEXT_CHARS: usize = 1_000;
const QUEUE_READ_TEXT_CHARS: usize = 16_000;
const QUEUE_DEFAULT_LIMIT: usize = 20;

/// `queuedRunsInDeliveryOrder`: delegated completions first, then queue position (else
/// ordinal), then ordinal.
fn queued_in_delivery_order(projection: &Value) -> Vec<&Value> {
    let completions: HashSet<&str> = projection["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| !m["delegatedCompletion"].is_null())
        .filter_map(|m| m["id"].as_str())
        .collect();
    let mut runs: Vec<&Value> = projection["runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["status"] == "queued")
        .collect();
    let key = |run: &Value| {
        let automatic = run["userMessageId"]
            .as_str()
            .is_some_and(|id| completions.contains(id));
        let ordinal = run["ordinal"].as_f64().unwrap_or(0.0);
        let position = run["queuePosition"].as_f64().unwrap_or(ordinal);
        (std::cmp::Reverse(automatic), position, ordinal)
    };
    runs.sort_by(|a, b| {
        let (a, b) = (key(a), key(b));
        a.0.cmp(&b.0)
            .then(a.1.total_cmp(&b.1))
            .then(a.2.total_cmp(&b.2))
    });
    runs
}

/// `queueEntry`: a queued run and the start of its message.
fn queue_entry(projection: &Value, run_id: &str, limit: usize) -> Option<Value> {
    let run = projection["runs"]
        .as_array()?
        .iter()
        .find(|r| r["id"] == run_id && r["status"] == "queued")?;
    let message = projection["messages"]
        .as_array()?
        .iter()
        .find(|m| m["id"] == run["userMessageId"])?;
    let text = message["text"].as_str().unwrap_or_default();
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(limit).collect();
    Some(json!({
        "queuedRunId": run["id"],
        "text": kept,
        "truncated": chars.next().is_some(),
    }))
}

/// `t3_queue`: `list` and `read` read; the other actions are `writesThreads([threadId])` and
/// one queued-run command each.
pub(super) async fn queue(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let action = str_arg(args, "action").unwrap_or_default();
    if action == "list" || action == "read" {
        let (_, projection) = read_thread(cx, args).await?;
        if action == "list" {
            let runs = queued_in_delivery_order(&projection);
            let cursor = u64_arg(args, "cursor").unwrap_or(0) as usize;
            // `clampedPositiveInt(100)`: a larger limit is clamped, not refused.
            let limit = u64_arg(args, "limit").map_or(QUEUE_DEFAULT_LIMIT, |l| l.min(100) as usize);
            let end = cursor.saturating_add(limit);
            let items: Vec<Value> = runs
                .iter()
                .skip(cursor)
                .take(limit)
                .filter_map(|run| {
                    queue_entry(
                        &projection,
                        run["id"].as_str().unwrap_or_default(),
                        QUEUE_LIST_TEXT_CHARS,
                    )
                })
                .collect();
            return Ok(json!({
                "items": items,
                "nextCursor": if end < runs.len() { json!(end) } else { Value::Null },
            }));
        }
        let run_id = required(args, "queuedRunId")?.as_str().unwrap_or_default();
        return queue_entry(&projection, run_id, QUEUE_READ_TEXT_CHARS)
            .ok_or_else(|| fail("invalid_request", "The queued message was not found."));
    }
    cx.writes_threads(&[str_arg(args, "threadId")]).await?;
    let run_id = required(args, "queuedRunId")?.clone();
    let mut command = match action {
        "edit" => json!({"type": "queued-run.edit", "runId": run_id,
                         "text": required(args, "text")?}),
        "reorder" => json!({"type": "queued-run.reorder", "runId": run_id,
                            "beforeRunId": required(args, "beforeRunId")?}),
        "promote_to_steer" => json!({"type": "queued-message.promote-to-steer",
                                     "queuedRunId": run_id,
                                     "targetRunId": required(args, "targetRunId")?}),
        _ => json!({"type": "queued-run.cancel", "runId": run_id}),
    };
    let (id, _) = read_thread(cx, args).await?;
    command["commandId"] = json!(new_command_id());
    command["threadId"] = json!(id);
    let sequence = cx.dispatch(command).await?;
    Ok(json!({ "sequence": sequence }))
}

/// `t3_thread_configure`: without `modelSelection` it reads the thread's selection and
/// modes; with it, `writesThreads([threadId])` and `thread.model-selection.set` (same
/// provider instance) or `provider.switch` (`modelSelectionCommandType`).
pub(super) async fn configure(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let Some(selection) = args.get("modelSelection") else {
        let (_, projection) = read_thread(cx, args).await?;
        let thread = &projection["thread"];
        return Ok(json!({
            "threadId": thread["id"],
            "modelSelection": thread["modelSelection"],
            "runtimeMode": thread["runtimeMode"],
            "interactionMode": thread["interactionMode"],
        }));
    };
    cx.writes_threads(&[str_arg(args, "threadId")]).await?;
    let selection = threads::normalize_selection(selection.clone());
    let (id, projection) = read_thread(cx, args).await?;
    let kind = if projection["thread"]["providerInstanceId"] == selection["instanceId"] {
        "thread.model-selection.set"
    } else {
        "provider.switch"
    };
    let sequence = cx
        .dispatch(json!({
            "type": kind, "threadId": id, "commandId": new_command_id(),
            "modelSelection": selection,
        }))
        .await?;
    Ok(json!({ "sequence": sequence }))
}
