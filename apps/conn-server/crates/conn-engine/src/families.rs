//! Thread families: delegated tasks run as child threads of a parent thread.
//!
//! `delegated_task.request` writes, in one transaction, the child thread (lineage `subagent`,
//! `forkedFrom` the task node), the parent's task node, `subagents` row and `subagent` turn
//! item, and the child's first message. When a child run ends, [`on_run_end`] publishes each of
//! the child's tasks whose work settled (no active run, no subagent or awaited background
//! work still owed) to the parent's rows and wakes the parent with a message, by the task's
//! `completionWake`: `always` wakes it at once; `settled_only` (the default) waits until the
//! parent has no active run, so a parent that waits on the task reads it itself. A message
//! that starts a run in a finished child is a follow-up task of its own; its runs carry its
//! id (`delegatedTaskId`).
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
    // Isolation `worktree`: the engine made the child its own checkout before this command.
    if let Some(path) = c["worktreePath"].as_str() {
        child["worktreePath"] = json!(path);
        child["branch"] = c["branch"].clone();
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
            "title": title.unwrap_or_else(|| child_title(None, &task, "")),
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

/// The parent of a delegated child thread, and its original task: the node it forked from.
fn delegated_parent(child: &Value) -> Option<(String, String)> {
    if child["lineage"]["relationshipToParent"] != "subagent" {
        return None;
    }
    Some((
        child["lineage"]["parentThreadId"].as_str()?.to_owned(),
        child["forkedFrom"]["nodeId"].as_str()?.to_owned(),
    ))
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

/// Called in the write that ends a run. Delivers what this thread's own children left pending
/// while it ran, then publishes the thread's settled tasks to its parent.
pub(crate) fn on_run_end(
    tx: &mut Tx<'_>,
    thread_id: &str,
    _run_id: &str,
) -> StoreResult<Vec<Effect>> {
    // This thread's run ended: tasks that waited for it to settle are delivered now. A wake
    // queued here keeps this thread's own task working.
    let mut effects = deliver(tx, thread_id, true)?;
    effects.extend(finalize_tasks(tx, thread_id)?);
    Ok(effects)
}

/// `isOrchestrationV2WorkActive` for a subagent row.
fn work_active(row: &Value) -> bool {
    matches!(
        row["status"].as_str(),
        Some("pending" | "running" | "waiting")
    )
}

/// `subagentHoldsCompletion`: a subagent at work, or one whose result is still owed.
fn subagent_holds_completion(row: &Value) -> bool {
    work_active(row)
        || (row["status"] != "idle"
            && matches!(
                row["completionDelivery"]["state"].as_str(),
                Some("pending" | "claimed")
            ))
}

/// `backgroundWorkHoldsCompletion`: unawaited commands and monitors do not hold.
fn background_holds_completion(task: &Value) -> bool {
    task["awaited"] == true || matches!(task["kind"].as_str(), Some("subagent" | "background_task"))
}

/// `finalizeAppOwnedSubagent` (`Orchestrator.ts:14777`): each open task of a delegated child
/// is published to its parent once its work settled: no run of it is active, and no subagent
/// or background work its runs started still holds a result (`delegatedTaskProgress`,
/// `delegatedTaskAwaitsWork`). A task with a cancelled run does not wait for children.
fn finalize_tasks(tx: &mut Tx<'_>, child_id: &str) -> StoreResult<Vec<Effect>> {
    let mut effects = vec![];
    let Some(child) = tx.thread(child_id)? else {
        return Ok(effects);
    };
    let Some((parent_id, original)) = delegated_parent(&child) else {
        return Ok(effects);
    };
    let open: Vec<Value> = tx
        .entities(&parent_id, "subagents")?
        .into_iter()
        .filter(|row| {
            row["origin"] == "app_owned"
                && row["childThreadId"] == child_id
                && row["remoteChild"].is_null()
                && row["completedAt"].is_null()
        })
        .collect();
    if open.is_empty() {
        return Ok(effects);
    }
    let runs = tx.entities(child_id, "runs")?;
    let subagents = tx.entities(child_id, "subagents")?;
    let background: Vec<Value> = tx
        .entities(child_id, "providerThreads")?
        .iter()
        .flat_map(|thread| {
            thread["pendingBackgroundTasks"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .collect();
    for row in open {
        let id = row["id"].as_str().unwrap_or_default();
        let is_original = id == original;
        // `delegatedTaskRuns`: a follow-up's runs are tagged with it; the original owns the rest.
        let owned: Vec<&Value> = runs
            .iter()
            .filter(|run| match run["delegatedTaskId"].as_str() {
                Some(task) => task == id,
                None => is_original,
            })
            .filter(|run| run["status"] != "rolled_back")
            .collect();
        let active = owned.iter().any(|run| {
            !TERMINAL.contains(&run["status"].as_str().unwrap_or_default())
                && !(run["status"] == "queued" && run["queueHeld"] == true)
        });
        let Some(result_run) = owned
            .iter()
            .filter(|run| {
                TERMINAL.contains(&run["status"].as_str().unwrap_or_default())
                    && (!run["startedAt"].is_null() || run["ordinal"] == 1)
            })
            .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
            .map(|run| (*run).clone())
        else {
            continue;
        };
        if active {
            continue;
        }
        let cancelled = row["cancelledRunId"].is_string();
        if !cancelled {
            // The original waits on the whole thread's work (`delegatedTaskProgress`); a
            // follow-up only on what its own runs started.
            let ids: Vec<&Value> = owned.iter().map(|run| &run["id"]).collect();
            let mine = |run_id: &Value| is_original || ids.contains(&run_id);
            let holds = subagents
                .iter()
                .any(|task| mine(&task["runId"]) && subagent_holds_completion(task))
                || background.iter().any(|task| {
                    (is_original || ids.contains(&&task["runId"]))
                        && background_holds_completion(task)
                });
            if holds {
                continue;
            }
        }
        effects.extend(publish(tx, &parent_id, child_id, row, &result_run)?);
    }
    Ok(effects)
}

/// Copies a settled task's status and result to the parent's row, node and item, and wakes
/// the parent; the parent may itself be a delegated child whose task now settles.
fn publish(
    tx: &mut Tx<'_>,
    parent_id: &str,
    child_id: &str,
    mut row: Value,
    run: &Value,
) -> StoreResult<Vec<Effect>> {
    let run_id = run["id"].as_str().unwrap_or_default();
    let status = run["status"].as_str().unwrap_or("failed");
    let status = if status == "rolled_back" {
        "cancelled"
    } else {
        status
    };
    let now = tx.now().to_owned();
    let result = run_result(tx, child_id, run_id)?;
    let cancelled = row["cancelledRunId"].is_string();
    row["status"] = json!(if cancelled && status == "completed" {
        "interrupted"
    } else {
        status
    });
    row["result"] = json!(result);
    row["providerThreadId"] = run["providerThreadId"].clone();
    row["completedAt"] = json!(now);
    row["updatedAt"] = json!(now);
    let node_id = row["id"].as_str().unwrap_or_default().to_owned();
    let parent_run = row["runId"].as_str().map(str::to_owned);
    // The parent may have read the result already (`task_status`, a blocking wait).
    let state = if cancelled {
        "disposed"
    } else if row["completionDelivery"]["state"] == "acknowledged" {
        "acknowledged"
    } else {
        "pending"
    };
    row["completionDelivery"] = json!({"state": state, "observedByRunId": row["completionDelivery"]["observedByRunId"].clone()});
    let draft = |event_type, payload| {
        Draft::new(parent_id, event_type, payload)
            .run(parent_run.as_deref())
            .node(Some(&node_id))
    };
    tx.append(draft("subagent.updated", row.clone()))?;
    if let Some(mut node) = tx.entity(parent_id, "nodes", &node_id)? {
        node["status"] = row["status"].clone();
        node["completedAt"] = json!(now);
        tx.append(draft("node.updated", node))?;
    }
    let item_id = format!("turn-item:{}", node_id.replacen("node:", "", 1));
    if let Some(mut item) = tx.entity(parent_id, "turnItems", &item_id)? {
        item["status"] = row["status"].clone();
        item["result"] = row["result"].clone();
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        tx.append(draft("turn-item.updated", item))?;
    }
    let mut effects = vec![];
    if state == "pending" {
        effects.extend(deliver(tx, parent_id, false)?);
    }
    // A parent that is itself a delegated child may now have settled.
    effects.extend(finalize_tasks(tx, parent_id)?);
    Ok(effects)
}

/// What a message into a delegated child says about who sent it.
pub(crate) struct FollowUpSource<'a> {
    pub(crate) command_id: &'a str,
    pub(crate) thread_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) text: &'a str,
    pub(crate) created_by: &'a str,
    pub(crate) creation_source: &'a str,
    pub(crate) sender_thread_id: Option<&'a str>,
    pub(crate) notification: Option<&'a Value>,
    /// A scheduled task's message or a restart continuation never starts a follow-up.
    pub(crate) excluded: bool,
}

/// `recordSubagentFollowup` (`Orchestrator.ts:9794`): a message that starts a new run in a
/// delegated child whose original task already has its result is a follow-up task of its
/// own, bound to the parent's `followUpOwnerRun`. A wake continues the latest open follow-up.
pub(crate) fn record_follow_up(tx: &mut Tx<'_>, m: &FollowUpSource<'_>) -> StoreResult<()> {
    // `mayStartSubagentFollowup`.
    let may_start = !m.excluded
        && match m.notification {
            Some(n) => !(n["source"]["kind"] == "monitor" && n["outcome"] == "updated"),
            None => m.created_by == "user" || m.creation_source == "mcp",
        };
    if !may_start {
        return Ok(());
    }
    let Some(child) = tx.thread(m.thread_id)? else {
        return Ok(());
    };
    let Some((parent_id, original_id)) = delegated_parent(&child) else {
        return Ok(());
    };
    // A send with no sender thread comes from a client acting for the owner.
    if m.notification.is_none()
        && m.created_by != "user"
        && m.sender_thread_id.is_some_and(|sender| sender != parent_id)
    {
        return Ok(());
    }
    let Some(mut run) = tx.entity(m.thread_id, "runs", m.run_id)? else {
        return Ok(());
    };
    if run["delegatedTaskId"].is_string() {
        return Ok(());
    }
    let Some(original) = tx
        .entity(&parent_id, "subagents", &original_id)?
        .filter(|row| row["origin"] == "app_owned" && row["childThreadId"] == m.thread_id)
    else {
        return Ok(());
    };
    if original["completedAt"].is_null() {
        return Ok(());
    }
    if m.notification.is_some()
        && let Some(open) = latest_open_follow_up(tx, &parent_id, m.thread_id, m.run_id)?
    {
        run["delegatedTaskId"] = json!(open);
        tx.append(
            Draft::new(m.thread_id, "run.updated", run)
                .run(Some(m.run_id))
                .command(Some(m.command_id)),
        )?;
        return Ok(());
    }
    let Some(owner) = follow_up_owner_run(tx, &parent_id)? else {
        return Ok(());
    };
    let (Some(owner_id), Some(owner_root)) = (
        owner["id"].as_str().map(str::to_owned),
        owner["rootNodeId"].as_str().map(str::to_owned),
    ) else {
        return Ok(());
    };
    let now = tx.now().to_owned();
    let task_id = task_node_id(m.command_id);
    let status = match run["status"].as_str() {
        Some("queued") if run["queueHeld"] == true => "idle",
        Some("queued") => "pending",
        _ => "running",
    };
    let model = run["modelSelection"].clone();
    let mut task = original;
    for (field, value) in [
        ("id", json!(task_id)),
        ("runId", json!(owner_id)),
        ("parentNodeId", json!(owner_root)),
        ("createdBy", json!(m.created_by)),
        ("driver", run["providerInstanceId"].clone()),
        ("providerInstanceId", run["providerInstanceId"].clone()),
        ("providerThreadId", run["providerThreadId"].clone()),
        ("model", model["model"].clone()),
        ("modelSelection", model),
        ("prompt", json!(m.text)),
        ("title", child["title"].clone()),
        ("completionWake", json!("always")),
        (
            "completionDelivery",
            json!({"state": "pending", "observedByRunId": null}),
        ),
        ("status", json!(status)),
        ("result", Value::Null),
        ("startedAt", json!(now)),
        ("completedAt", Value::Null),
        ("updatedAt", json!(now)),
    ] {
        task[field] = value;
    }
    if let Some(map) = task.as_object_mut() {
        map.remove("cancelledRunId");
        map.remove("progress");
    }
    run["delegatedTaskId"] = json!(task_id);
    tx.append(
        Draft::new(m.thread_id, "run.updated", run.clone())
            .run(Some(m.run_id))
            .command(Some(m.command_id)),
    )?;
    let draft = |event_type, payload| {
        Draft::new(&parent_id, event_type, payload)
            .run(Some(&owner_id))
            .node(Some(&task_id))
            .command(Some(m.command_id))
    };
    tx.append(draft(
        "node.updated",
        json!({
            "id": task_id, "threadId": parent_id, "runId": owner_id,
            "parentNodeId": owner_root, "rootNodeId": owner_root, "kind": "subagent",
            "status": status, "countsForRun": false, "providerThreadId": run["providerThreadId"],
            "providerTurnId": null, "nativeItemRef": null, "runtimeRequestId": null,
            "checkpointScopeId": null, "startedAt": now, "completedAt": null,
        }),
    ))?;
    tx.append(draft("subagent.updated", task.clone()))?;
    tx.append(draft(
        "turn-item.updated",
        json!({
            "id": format!("turn-item:delegated-task:{}", m.command_id), "threadId": parent_id,
            "runId": owner_id, "nodeId": task_id, "providerThreadId": owner["providerThreadId"],
            "providerTurnId": null, "nativeItemRef": null, "parentItemId": null, "ordinal": 0,
            "status": status, "title": child["title"], "startedAt": now, "completedAt": null,
            "updatedAt": now, "type": "subagent", "subagentId": task_id, "origin": "app_owned",
            "driver": task["driver"], "providerInstanceId": task["providerInstanceId"],
            "childThreadId": m.thread_id, "prompt": m.text, "result": null,
        }),
    ))?;
    Ok(())
}

/// The child's latest follow-up task other than `run_id`'s, while it has no result.
fn latest_open_follow_up(
    tx: &Tx<'_>,
    parent_id: &str,
    child_id: &str,
    run_id: &str,
) -> StoreResult<Option<String>> {
    let latest = tx
        .entities(child_id, "runs")?
        .into_iter()
        .filter(|run| run["id"] != run_id && run["delegatedTaskId"].is_string())
        .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
        .and_then(|run| run["delegatedTaskId"].as_str().map(str::to_owned));
    let Some(latest) = latest else {
        return Ok(None);
    };
    Ok(tx
        .entity(parent_id, "subagents", &latest)?
        .filter(|task| {
            task["origin"] == "app_owned"
                && task["childThreadId"] == child_id
                && task["cancelledRunId"].is_null()
                && task["completedAt"].is_null()
        })
        .map(|_| latest))
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
    // `delegatedTaskRuns`: the wake belongs to the follow-up task whose run started this work.
    let mut follow_up = None;
    for row in &due {
        if let Some(run) = row["runId"].as_str()
            && let Some(task) = tx
                .entity(thread_id, "runs", run)?
                .and_then(|run| run["delegatedTaskId"].as_str().map(str::to_owned))
        {
            follow_up = Some(task);
            break;
        }
    }
    let mut effects = vec![];
    for mut row in due {
        row["completionDelivery"] = json!({"state": "delivered", "observedByRunId": null});
        let run = row["runId"].as_str().map(str::to_owned);
        tx.append(Draft::new(thread_id, "subagent.updated", row).run(run.as_deref()))?;
    }
    let dispatch = commands::handler("message.dispatch").expect("message.dispatch");
    // One id per delivery: the ordinal of the run this wake creates is new in the thread, so a
    // child's second turn never overwrites the parent's first completion message.
    let ordinal = tx.next_run_ordinal(thread_id)?;
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
        Ok(more) => {
            effects.extend(more);
            let run_id = format!("run:{thread_id}:{ordinal}");
            if let Some(task) = follow_up
                && let Some(mut run) = tx.entity(thread_id, "runs", &run_id)?
            {
                run["delegatedTaskId"] = json!(task);
                tx.append(Draft::new(thread_id, "run.updated", run).run(Some(&run_id)))?;
            }
        }
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
        // A task in a linked environment ends here; its follower then stops it there. One
        // with its result keeps it, but its thread there may run follow-up work.
        if row["origin"] == "app_owned" && row["remoteChild"].is_object() {
            if row["result"].is_string() {
                effects.push(owe_remote_stop(tx, thread_id, row)?);
            } else {
                effects.extend(finish_remote(
                    tx,
                    thread_id,
                    row,
                    "interrupted",
                    "Stopped with its parent.",
                    "disposed",
                )?);
            }
            continue;
        }
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
            effects.extend(commands::stop_run(tx, &child, &run, None, false)?);
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

/// `followUpOwnerRun`: the thread's newest active run, else the newest run that ran.
pub(crate) fn follow_up_owner_run(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Option<Value>> {
    let runs = tx.entities(thread_id, "runs")?;
    let ordinal = |run: &Value| run["ordinal"].as_u64().unwrap_or(0);
    let active = runs
        .iter()
        .filter(|run| commands::is_active(run))
        .max_by_key(|run| ordinal(run));
    if let Some(run) = active {
        return Ok(Some(run.clone()));
    }
    Ok(runs
        .iter()
        .filter(|run| {
            run["status"] != "queued"
                && !(run["status"] == "cancelled" && run["startedAt"].is_null())
        })
        .max_by_key(|run| ordinal(run))
        .cloned())
}

fn same_remote_thread(task: &Value, remote: &Value) -> bool {
    task["remoteChild"]["environmentId"] == remote["environmentId"]
        && task["remoteChild"]["threadId"] == remote["threadId"]
}

/// `delegated_task.remote.request` (T3 `dispatchRemoteDelegatedTaskRequest`): a task whose
/// child is a thread in a linked environment. The parent gets the task node, its `subagents`
/// row and turn item, as for a local task, but no child thread here. A follow-up to a finished
/// task there binds to the run a follow-up here would (`followUpOwnerRun`).
pub(crate) fn remote_request(tx: &mut Tx<'_>, c: Value) -> Outcome {
    let command_id = c["commandId"].as_str().unwrap_or_default().to_owned();
    let parent_id = c["parentThreadId"].as_str().unwrap_or_default().to_owned();
    let parent_run_id = c["parentRunId"].as_str().unwrap_or_default().to_owned();
    let task = c["task"].as_str().unwrap_or_default().trim().to_owned();
    let remote = c["remoteChild"].clone();
    if task.is_empty() || !remote["environmentId"].is_string() || !remote["threadId"].is_string() {
        return reject("A remote task needs a task and the thread it runs on.");
    }
    let Some(parent) = tx.thread(&parent_id)? else {
        return reject(format!("Thread {parent_id} does not exist."));
    };
    let follows_up = tx
        .entities(&parent_id, "subagents")?
        .iter()
        .any(|row| !row["result"].is_null() && same_remote_thread(row, &remote));
    let run = tx.entity(&parent_id, "runs", &parent_run_id)?;
    let bound = match &run {
        Some(run) if follows_up => {
            follow_up_owner_run(tx, &parent_id)?.is_some_and(|owner| owner["id"] == run["id"])
        }
        Some(run) => commands::is_active(run),
        None => false,
    };
    let Some(parent_run) = run.filter(|run| bound && !run["rootNodeId"].is_null()) else {
        return reject(format!("Parent run {parent_run_id} is not active."));
    };
    let node_id = task_node_id(&command_id);
    let now = tx.now().to_owned();
    let model = commands::normalize_model_selection(&c["modelSelection"]);
    let title = c["title"].as_str().map(str::to_owned);
    let driver = c["driver"].clone();
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
            "parentNodeId": c["parentNodeId"], "rootNodeId": parent_run["rootNodeId"],
            "kind": "subagent", "status": "running", "countsForRun": false,
            "providerThreadId": null, "providerTurnId": null, "nativeItemRef": null,
            "runtimeRequestId": null, "checkpointScopeId": null, "startedAt": now,
            "completedAt": null,
        }),
    ))?;
    let mut row = json!({
        "id": node_id, "threadId": parent_id, "runId": parent_run_id,
        "parentNodeId": c["parentNodeId"], "origin": "app_owned", "createdBy": "agent",
        "driver": driver, "providerInstanceId": model["instanceId"], "providerThreadId": null,
        "childThreadId": null, "remoteChild": remote, "nativeTaskRef": null, "prompt": task,
        "title": title, "model": model["model"], "modelSelection": model, "status": "running",
        "result": null, "startedAt": now, "completedAt": null, "updatedAt": now,
    });
    if c["completionWake"].is_string() {
        row["completionWake"] = c["completionWake"].clone();
    }
    tx.append(draft("subagent.updated", row))?;
    let parent_title = parent["title"].as_str().unwrap_or("Thread");
    tx.append(draft(
        "turn-item.updated",
        json!({
            "id": format!("turn-item:delegated-task:{command_id}"), "threadId": parent_id,
            "runId": parent_run_id, "nodeId": node_id,
            "providerThreadId": parent_run["providerThreadId"], "providerTurnId": null,
            "nativeItemRef": null, "parentItemId": null, "ordinal": 0, "status": "running",
            "title": title.unwrap_or_else(|| child_title(None, &task, parent_title)),
            "startedAt": now, "completedAt": null, "updatedAt": now, "type": "subagent",
            "subagentId": node_id, "origin": "app_owned", "driver": driver,
            "providerInstanceId": model["instanceId"], "childThreadId": null,
            "remoteChild": remote, "prompt": task, "result": null,
        }),
    ))?;
    Ok(vec![])
}

fn remote_task_row(tx: &Tx<'_>, c: &Value) -> Result<(String, Value), CommandError> {
    let (parent, row) = task_row(tx, c)?;
    if !row["remoteChild"].is_object() {
        return reject(format!(
            "Delegated task {} is not a remote task of thread {parent}.",
            row["id"].as_str().unwrap_or_default()
        ));
    }
    Ok((parent, row))
}

/// The task now owes a stop to its thread there: only `remoteChild` changes, so a result and
/// its delivery stand (`emitRemoteStopOwed`).
fn owe_remote_stop(tx: &mut Tx<'_>, parent: &str, mut row: Value) -> StoreResult<Effect> {
    let task_id = row["id"].as_str().unwrap_or_default().to_owned();
    let count = row["remoteChild"]["stopCount"].as_u64().unwrap_or(0);
    row["remoteChild"]["stoppedThere"] = json!(false);
    row["remoteChild"]["stopCount"] = json!(count + 1);
    row["updatedAt"] = json!(tx.now());
    let run = row["runId"].as_str().map(str::to_owned);
    tx.append(Draft::new(parent, "subagent.updated", row).run(run.as_deref()))?;
    Ok(Effect::RemoteTaskChanged {
        thread_id: parent.to_owned(),
        task_id,
    })
}

/// Ends a remote task here with its result: the row, its node and turn item. `delivery` is the
/// wake state: `pending` wakes the parent, `disposed` (a Stop of the parent) does not.
fn finish_remote(
    tx: &mut Tx<'_>,
    parent: &str,
    mut row: Value,
    status: &str,
    result: &str,
    delivery: &str,
) -> StoreResult<Vec<Effect>> {
    let now = tx.now().to_owned();
    row["status"] = json!(status);
    row["result"] = json!(result);
    row["completedAt"] = json!(now);
    row["updatedAt"] = json!(now);
    row["completionDelivery"] = json!({"state": delivery, "observedByRunId": null});
    let node_id = row["id"].as_str().unwrap_or_default().to_owned();
    let parent_run = row["runId"].as_str().map(str::to_owned);
    let draft = |event_type, payload| {
        Draft::new(parent, event_type, payload)
            .run(parent_run.as_deref())
            .node(Some(&node_id))
    };
    tx.append(draft("subagent.updated", row))?;
    if let Some(mut node) = tx.entity(parent, "nodes", &node_id)? {
        node["status"] = json!(status);
        node["completedAt"] = json!(now);
        tx.append(draft("node.updated", node))?;
    }
    let item_id = format!("turn-item:{}", node_id.replacen("node:", "", 1));
    if let Some(mut item) = tx.entity(parent, "turnItems", &item_id)? {
        item["status"] = json!(status);
        item["result"] = json!(result);
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        tx.append(draft("turn-item.updated", item))?;
    }
    if delivery == "pending" {
        return deliver(tx, parent, false);
    }
    Ok(vec![])
}

/// `delegated_task.remote.complete` (T3 `dispatchRemoteDelegatedTaskComplete`): the result its
/// thread there ended with. The first result stands. `stoppedThere` records that nothing is
/// left to stop there; a report that changes nothing is refused.
pub(crate) fn remote_complete(tx: &mut Tx<'_>, c: Value) -> Outcome {
    let (parent, mut row) = remote_task_row(tx, &c)?;
    let stopped_there = c["stoppedThere"].as_str();
    let stop_count = c["stopCount"].as_u64().unwrap_or(0);
    if stopped_there == Some("stopped")
        && stop_count != row["remoteChild"]["stopCount"].as_u64().unwrap_or(0)
    {
        return reject("A later stop is owed there.");
    }
    if row["result"].is_string() {
        // A Stop or cancel here that lost the race to the result still owes its stop.
        if stopped_there.is_none() {
            return Ok(vec![owe_remote_stop(tx, &parent, row)?]);
        }
        let status = row["status"].as_str().unwrap_or_default();
        let owes = matches!(status, "cancelled" | "interrupted")
            || row["remoteChild"]["stoppedThere"] == false;
        if row["remoteChild"]["stoppedThere"] == true || (owes && stopped_there != Some("stopped"))
        {
            return reject("The task already has its result.");
        }
        row["remoteChild"]["stoppedThere"] = json!(true);
        row["updatedAt"] = json!(tx.now());
        let run = row["runId"].as_str().map(str::to_owned);
        tx.append(Draft::new(&parent, "subagent.updated", row).run(run.as_deref()))?;
        return Ok(vec![]);
    }
    let status = match c["status"].as_str() {
        Some(status @ ("completed" | "failed" | "cancelled" | "interrupted")) => status,
        _ => return reject("A remote task ends completed, failed, cancelled or interrupted."),
    };
    if stopped_there.is_some() {
        row["remoteChild"]["stoppedThere"] = json!(true);
    }
    if let Some(model) = c["executedModel"].as_str() {
        row["executedModel"] = json!(model);
    }
    let result = c["result"].as_str().unwrap_or_default().to_owned();
    Ok(finish_remote(tx, &parent, row, status, &result, "pending")?)
}

/// `delegated_task.remote.stop`: a finished remote task owes its thread there a stop.
pub(crate) fn remote_stop(tx: &mut Tx<'_>, c: Value) -> Outcome {
    let (parent, row) = remote_task_row(tx, &c)?;
    if !row["result"].is_string() {
        return reject(format!(
            "Delegated task {} is not a finished remote task of thread {parent}.",
            row["id"].as_str().unwrap_or_default()
        ));
    }
    Ok(vec![owe_remote_stop(tx, &parent, row)?])
}
