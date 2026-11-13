//! Thread families: delegated tasks run as child threads of a parent thread.
//!
//! `delegated_task.request` writes, in one transaction, the child thread (lineage `subagent`,
//! `forkedFrom` the task node), the parent's task node, `subagents` row and `subagent` turn
//! item, and the child's first message. When a child run ends, [`on_run_end`] copies its status
//! and result to the parent's rows and wakes the parent with a message, by the task's
//! `completionWake`: `always` wakes it at once; `settled_only` (the default) waits until the
//! parent has no active run, so a parent that waits on the task reads it itself.
//!
//! Ids follow `IdAllocator.ts`, so an MCP tool knows them from the command id alone:
//! task `node:delegated-task:<commandId>`, child `thread:delegated-task:<commandId>`.

use serde_json::{Value, json};

use crate::commands::{self, CommandError, Effect, Outcome, active_run};
use crate::store::{Draft, StoreResult, Tx};

/// Results longer than this stay out of the wake message; the agent reads them with
/// `task_status` (`DELEGATED_RESULT_INLINE_BYTES`).
const RESULT_INLINE_BYTES: usize = 16_000;
const TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "interrupted"];

pub(crate) fn task_node_id(command_id: &str) -> String {
    format!("node:delegated-task:{command_id}")
}

pub(crate) fn child_thread_id(command_id: &str) -> String {
    format!("thread:delegated-task:{command_id}")
}

fn reject<T>(message: impl Into<String>) -> Result<T, CommandError> {
    Err(CommandError::Rejected(message.into()))
}

/// `subagentThreadTitle`: the title or prompt, cut to 72 characters.
fn child_title(title: Option<&str>, prompt: &str, parent_title: &str) -> String {
    let text = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(prompt.trim());
    if text.is_empty() {
        return format!("{parent_title} subagent");
    }
    if text.chars().count() <= 72 {
        return text.to_owned();
    }
    format!("{}...", text.chars().take(69).collect::<String>())
}

pub(crate) fn delegated_task_request(tx: &mut Tx<'_>, c: Value) -> Outcome {
    let command_id = c["commandId"].as_str().unwrap_or_default().to_owned();
    let parent_id = c["parentThreadId"].as_str().unwrap_or_default().to_owned();
    let parent_run_id = c["parentRunId"].as_str().unwrap_or_default().to_owned();
    let task = c["task"].as_str().unwrap_or_default().trim().to_owned();
    if task.is_empty() {
        return reject("A delegated task needs a task.");
    }
    let Some(parent) = tx.thread(&parent_id)? else {
        return reject(format!("Thread {parent_id} does not exist."));
    };
    let Some(parent_run) = tx
        .entity(&parent_id, "runs", &parent_run_id)?
        .filter(commands::is_active)
    else {
        return reject(format!("Run {parent_run_id} is not running."));
    };
    let node_id = task_node_id(&command_id);
    let child_id = child_thread_id(&command_id);
    let now = c["createdAt"]
        .as_str()
        .map_or_else(|| tx.now().to_owned(), str::to_owned);
    let model = commands::normalize_model_selection(&c["modelSelection"]);
    let title = c["title"].as_str().map(str::to_owned);
    let created_by = c["createdBy"].clone();
    let creation_source = c["creationSource"].clone();
    let root_node = parent_run["rootNodeId"].clone();

    let mut child = parent.clone();
    for (field, value) in [
        ("id", json!(child_id)),
        (
            "title",
            json!(child_title(
                title.as_deref(),
                &task,
                parent["title"].as_str().unwrap_or("Thread")
            )),
        ),
        ("createdBy", created_by.clone()),
        ("creationSource", creation_source.clone()),
        ("providerInstanceId", model["instanceId"].clone()),
        ("modelSelection", model.clone()),
        ("runtimeMode", c["runtimeMode"].clone()),
        ("interactionMode", c["interactionMode"].clone()),
        ("activeProviderThreadId", Value::Null),
        ("pullRequests", json!([])),
        (
            "lineage",
            json!({"parentThreadId": parent_id, "relationshipToParent": "subagent",
                   "rootThreadId": parent["lineage"]["rootThreadId"]}),
        ),
        ("forkedFrom", json!({"type": "node", "nodeId": node_id})),
        ("createdAt", json!(now)),
        ("updatedAt", json!(now)),
    ] {
        child[field] = value;
    }
    for field in [
        "archivedAt",
        "settledOverride",
        "settledAt",
        "unsettledAt",
        "snoozedUntil",
        "snoozedAt",
        "pinnedAt",
        "pinOrderKey",
        "activeOrderKey",
        "autoSettleDisabledAt",
        "lastVisitedAt",
        "deletedAt",
        "titleRegeneration",
        "lastTitleRegeneration",
        "linkedPullRequest",
    ] {
        child[field] = Value::Null;
    }
    if let Some(map) = child.as_object_mut() {
        map.remove("tags");
    }
    tx.append(Draft::new(&child_id, "thread.created", child).command(Some(&command_id)))?;

    let draft = |event_type, payload| {
        Draft::new(&parent_id, event_type, payload)
            .run(Some(&parent_run_id))
            .node(Some(&node_id))
            .command(Some(&command_id))
    };
    tx.append(draft(
        "node.updated",
        json!({
            "id": node_id, "threadId": parent_id, "runId": parent_run_id,
            "parentNodeId": c["parentNodeId"], "rootNodeId": root_node, "kind": "subagent",
            "status": "running", "countsForRun": false, "providerThreadId": null,
            "providerTurnId": null, "nativeItemRef": null, "runtimeRequestId": null,
            "checkpointScopeId": null, "startedAt": now, "completedAt": null,
        }),
    ))?;
    let mut row = json!({
        "id": node_id, "threadId": parent_id, "runId": parent_run_id,
        "parentNodeId": c["parentNodeId"], "origin": "app_owned", "createdBy": created_by,
        // A default instance is named after its driver (`claudeAgent`, `codex`).
        "driver": model["instanceId"], "providerInstanceId": model["instanceId"],
        "providerThreadId": null, "childThreadId": child_id, "nativeTaskRef": null,
        "prompt": task, "title": title, "model": model["model"], "status": "running",
        "result": null, "startedAt": now, "completedAt": null, "updatedAt": now,
    });
    if c["completionWake"].is_string() {
        row["completionWake"] = c["completionWake"].clone();
    }
    tx.append(draft("subagent.updated", row))?;
    tx.append(draft(
        "turn-item.updated",
        json!({
            "id": format!("turn-item:delegated-task:{command_id}"), "threadId": parent_id,
            "runId": parent_run_id, "nodeId": node_id,
            "providerThreadId": parent_run["providerThreadId"], "providerTurnId": null,
            "nativeItemRef": null, "parentItemId": null, "ordinal": 0, "status": "running",
            "title": title.clone().unwrap_or_else(|| child_title(None, &task, "")),
            "startedAt": now, "completedAt": null, "updatedAt": now, "type": "subagent",
            "subagentId": node_id, "origin": "app_owned", "driver": model["instanceId"],
            "providerInstanceId": model["instanceId"], "childThreadId": child_id,
            "prompt": task, "result": null,
        }),
    ))?;

    let dispatch = commands::handler("message.dispatch").expect("message.dispatch");
    dispatch(
        tx,
        json!({
            "type": "message.dispatch", "commandId": command_id, "threadId": child_id,
            "messageId": format!("message:delegated-task:{command_id}"), "text": task,
            "attachments": [], "modelSelection": model, "dispatchMode": {"type": "start_immediately"},
            "createdBy": created_by, "creationSource": creation_source,
        }),
    )
}

/// The parent's task rows for a child thread, when the thread is a delegated child.
fn parent_task(tx: &Tx<'_>, child: &Value) -> StoreResult<Option<(String, Value)>> {
    if child["lineage"]["relationshipToParent"] != "subagent" {
        return Ok(None);
    }
    let (Some(parent_id), Some(node_id)) = (
        child["lineage"]["parentThreadId"].as_str(),
        child["forkedFrom"]["nodeId"].as_str(),
    ) else {
        return Ok(None);
    };
    Ok(tx
        .entity(parent_id, "subagents", node_id)?
        .filter(|row| row["origin"] == "app_owned")
        .map(|row| (parent_id.to_owned(), row)))
}

/// The run's answer: its newest non-empty assistant text, or the failure of a failed run.
fn run_result(tx: &Tx<'_>, thread_id: &str, run_id: &str) -> StoreResult<Option<String>> {
    let items = tx.entities_where(thread_id, "turnItems", "runId", run_id)?;
    let text = |types: &[&str]| {
        items
            .iter()
            .rev()
            .filter(|i| types.contains(&i["type"].as_str().unwrap_or("")))
            .find_map(|i| {
                i["text"]
                    .as_str()
                    .or(i["failure"]["message"].as_str())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned)
            })
    };
    Ok(text(&["assistant_message"]).or_else(|| text(&["error"])))
}

/// Called in the write that ends a run. Updates a delegated child's parent rows and returns
/// the effects of waking the parent, then delivers what this thread's own children left
/// pending while it ran.
pub(crate) fn on_run_end(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
) -> StoreResult<Vec<Effect>> {
    let mut effects = vec![];
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(effects);
    };
    if let Some((parent_id, mut row)) = parent_task(tx, &thread)?
        && let Some(run) = tx.entity(thread_id, "runs", run_id)?
    {
        let status = run["status"].as_str().unwrap_or("failed").to_owned();
        if TERMINAL.contains(&status.as_str()) {
            let now = tx.now().to_owned();
            let result = run_result(tx, thread_id, run_id)?;
            let cancelled = row["cancelledRunId"] == run_id;
            row["status"] = json!(if cancelled && status == "completed" {
                "interrupted"
            } else {
                status.as_str()
            });
            row["result"] = json!(result);
            row["providerThreadId"] = run["providerThreadId"].clone();
            row["completedAt"] = json!(now);
            row["updatedAt"] = json!(now);
            let node_id = row["id"].as_str().unwrap_or_default().to_owned();
            let parent_run = row["runId"].as_str().map(str::to_owned);
            let state = if cancelled { "disposed" } else { "pending" };
            row["completionDelivery"] = json!({"state": state, "observedByRunId": null});
            let draft = |event_type, payload| {
                Draft::new(&parent_id, event_type, payload)
                    .run(parent_run.as_deref())
                    .node(Some(&node_id))
            };
            tx.append(draft("subagent.updated", row.clone()))?;
            if let Some(mut node) = tx.entity(&parent_id, "nodes", &node_id)? {
                node["status"] = row["status"].clone();
                node["completedAt"] = json!(now);
                tx.append(draft("node.updated", node))?;
            }
            let item_id = format!("turn-item:{}", node_id.replacen("node:", "", 1));
            if let Some(mut item) = tx.entity(&parent_id, "turnItems", &item_id)? {
                item["status"] = row["status"].clone();
                item["result"] = row["result"].clone();
                item["completedAt"] = json!(now);
                item["updatedAt"] = json!(now);
                tx.append(draft("turn-item.updated", item))?;
            }
            if !cancelled {
                effects.extend(deliver(tx, &parent_id, false)?);
            }
        }
    }
    // This thread's run ended: tasks that waited for it to settle are delivered now.
    effects.extend(deliver(tx, thread_id, true)?);
    Ok(effects)
}

/// Wakes `thread_id` with one message naming every finished task still `pending`. A task
/// with `settled_only` waits while the thread has an active run, unless `settled` says the
/// run just ended.
fn deliver(tx: &mut Tx<'_>, thread_id: &str, settled: bool) -> StoreResult<Vec<Effect>> {
    let busy = !settled && active_run(tx, thread_id)?.is_some();
    let due: Vec<Value> = tx
        .entities(thread_id, "subagents")?
        .into_iter()
        .filter(|row| {
            row["origin"] == "app_owned" && row["completionDelivery"]["state"] == "pending"
        })
        .filter(|row| !busy || row["completionWake"] == "always")
        .collect();
    if due.is_empty()
        || tx
            .thread(thread_id)?
            .is_none_or(|t| !t["archivedAt"].is_null())
    {
        return Ok(vec![]);
    }
    let mut inline = 0;
    let parts: Vec<String> = due
        .iter()
        .map(|row| {
            let id = row["id"].as_str().unwrap_or_default();
            let title = row["title"].as_str().map(|t| format!(" ({t})")).unwrap_or_default();
            let status = row["status"].as_str().unwrap_or_default();
            match row["result"].as_str() {
                Some(result) if inline + result.len() <= RESULT_INLINE_BYTES => {
                    inline += result.len();
                    format!("Delegated task {id}{title} [{status}]:\n{result}")
                }
                _ => format!(
                    "Delegated task {id}{title} [{status}]. Use task_status with taskId {id} to read the result."
                ),
            }
        })
        .collect();
    let first = due
        .first()
        .and_then(|row| row["id"].as_str())
        .unwrap_or_default()
        .to_owned();
    let mut effects = vec![];
    for mut row in due {
        row["completionDelivery"] = json!({"state": "delivered", "observedByRunId": null});
        let run = row["runId"].as_str().map(str::to_owned);
        tx.append(Draft::new(thread_id, "subagent.updated", row).run(run.as_deref()))?;
    }
    let dispatch = commands::handler("message.dispatch").expect("message.dispatch");
    // One id per delivery: the ordinal of the run this wake creates is new in the thread, so a
    // child's second turn never overwrites the parent's first completion message.
    let ordinal = tx.count(thread_id, "runs")? + 1;
    let command_id = format!("delegated-completion:{first}:{ordinal}");
    match dispatch(
        tx,
        json!({
            "type": "message.dispatch", "commandId": command_id, "threadId": thread_id,
            "messageId": format!("message:{command_id}"), "text": parts.join("\n\n"),
            "attachments": [], "dispatchMode": {"type": "queue_after_active"},
            "createdBy": "agent", "creationSource": "server",
        }),
    ) {
        Ok(more) => effects.extend(more),
        Err(CommandError::Store(e)) => return Err(e),
        Err(CommandError::Rejected(e)) => eprintln!("conn-engine: could not wake {thread_id}: {e}"),
    }
    Ok(effects)
}

/// Stop reaches the thread's running children too (`delegated-tasks.stop`). Their tasks end
/// as interrupted and do not wake the stopped parent.
pub(crate) fn stop_children(tx: &mut Tx<'_>, thread_id: &str) -> StoreResult<Vec<Effect>> {
    let mut effects = vec![];
    for mut row in tx.entities(thread_id, "subagents")? {
        let Some(child) = row["childThreadId"].as_str().map(str::to_owned) else {
            continue;
        };
        if row["origin"] != "app_owned" || TERMINAL.contains(&row["status"].as_str().unwrap_or(""))
        {
            continue;
        }
        commands::hold_queue(tx, &child)?;
        if let Some(run) = active_run(tx, &child)? {
            let run_id = run["id"].as_str().unwrap_or_default().to_owned();
            row["cancelledRunId"] = json!(run_id);
            let parent_run = row["runId"].as_str().map(str::to_owned);
            tx.append(Draft::new(thread_id, "subagent.updated", row).run(parent_run.as_deref()))?;
            effects.extend(stop_children(tx, &child)?);
            effects.push(Effect::Interrupt {
                thread_id: child,
                run_id,
            });
        }
    }
    Ok(effects)
}

fn task_row(tx: &Tx<'_>, c: &Value) -> Result<(String, Value), CommandError> {
    let parent = c["parentThreadId"].as_str().unwrap_or_default().to_owned();
    let task = c["taskId"].as_str().unwrap_or_default();
    match tx.entity(&parent, "subagents", task)? {
        Some(row) if row["origin"] == "app_owned" => Ok((parent, row)),
        _ => reject(format!("Task {task} does not exist.")),
    }
}

pub(crate) fn wake_policy(tx: &mut Tx<'_>, c: Value) -> Outcome {
    let (parent, mut row) = task_row(tx, &c)?;
    if row["completionWake"] == c["completionWake"] {
        return reject("The task already has this wake policy.");
    }
    row["completionWake"] = c["completionWake"].clone();
    let run = row["runId"].as_str().map(str::to_owned);
    tx.append(Draft::new(&parent, "subagent.updated", row).run(run.as_deref()))?;
    Ok(deliver(tx, &parent, false)?)
}

/// `completion-delivery.acknowledge` and `.dispose`: the parent read the result itself, or
/// no longer wants it, so no wake message names this task.
pub(crate) fn completion_delivery(tx: &mut Tx<'_>, c: Value) -> Outcome {
    let (parent, mut row) = task_row(tx, &c)?;
    let state = if c["type"] == "delegated_task.completion-delivery.dispose" {
        "disposed"
    } else {
        "acknowledged"
    };
    if matches!(
        row["completionDelivery"]["state"].as_str(),
        Some("delivered" | "disposed")
    ) {
        return Ok(vec![]);
    }
    row["completionDelivery"] = json!({"state": state, "observedByRunId": c["observedByRunId"]});
    let run = row["runId"].as_str().map(str::to_owned);
    tx.append(Draft::new(&parent, "subagent.updated", row).run(run.as_deref()))?;
    Ok(vec![])
}
