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
pub(crate) const TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "interrupted"];

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
    // T3 names the child's model instance on every event of the request.
    let instance = c["modelSelection"]["instanceId"]
        .as_str()
        .map(str::to_owned);
    tx.append(
        Draft::new(&child_id, "thread.created", child)
            .command(Some(&command_id))
            .provider_instance(instance.as_deref()),
    )?;

    let draft = |event_type, payload| {
        Draft::new(&parent_id, event_type, payload)
            .run(Some(&parent_run_id))
            .node(Some(&node_id))
            .command(Some(&command_id))
            .provider_instance(instance.as_deref())
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

    // Isolation `worktree`: the child's run waits in `preparing` until its setup is done, as
    // T3's `defer_start` with a workspace (`OrchestratorMcpService.delegate`).
    let dispatch_mode = if c["workspaceStrategy"]["type"] == "worktree" {
        json!({"type": "defer_start", "workspaceStrategy": c["workspaceStrategy"]})
    } else {
        json!({"type": "start_immediately"})
    };
    let dispatch = commands::handler("message.dispatch").expect("message.dispatch");
    dispatch(
        tx,
        json!({
            "type": "message.dispatch", "commandId": command_id, "threadId": child_id,
            "messageId": format!("message:delegated-task:{command_id}"), "text": task,
            "attachments": [], "modelSelection": model, "dispatchMode": dispatch_mode,
            "createdBy": created_by, "creationSource": creation_source,
        }),
    )
}

/// The parent's task rows for a child thread, when the thread is a delegated child.
pub(crate) fn parent_task(tx: &Tx<'_>, child: &Value) -> StoreResult<Option<(String, Value)>> {
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

/// `resultOfRun` (`subagentProjection.ts:282`): a run's report from its turn items, `None` when
/// it said nothing. A failed run leads with its failure, then the report it gave before failing.
fn report_of_run(items: &[Value], run: &Value) -> Option<String> {
    let ordinal = |item: &Value| item["ordinal"].as_u64().unwrap_or(0);
    let text = items
        .iter()
        .filter(|item| item["type"] == "assistant_message")
        .filter_map(|item| {
            let text = item["text"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty())?;
            Some((ordinal(item), text))
        })
        .max_by_key(|(at, _)| *at);
    let failure = items
        .iter()
        .filter(|item| run["status"] == "failed" && item["type"] == "error")
        .max_by_key(|item| ordinal(item));
    let Some(failure) = failure else {
        return text.map(|(_, text)| text.to_owned());
    };
    let message = failure["failure"]["message"].as_str().unwrap_or_default();
    Some(match text {
        Some((at, report)) if at < ordinal(failure) => {
            format!("{message}\n\nLast assistant message before the run failed:\n\n{report}")
        }
        _ => message.to_owned(),
    })
}

/// `subagentResultForRun` (`subagentProjection.ts:255`): the result a task is published with.
/// A completed run that said nothing reports the same task's earlier completed run that did;
/// a run with no report says so. `items` gives one run's turn items; `notice` is the run's
/// provider stop reason.
fn result_for_run<E>(
    run: &Value,
    runs: &[Value],
    monitor: &[Value],
    notice: Option<String>,
    items: impl Fn(&str) -> Result<Vec<Value>, E>,
) -> Result<String, E> {
    let run_id = run["id"].as_str().unwrap_or_default();
    if let Some(text) = report_of_run(&items(run_id)?, run) {
        return Ok(text);
    }
    let status = run["status"].as_str().unwrap_or("failed");
    if status != "completed" {
        return Ok(format!("Child task ended with status {status}."));
    }
    if notice.is_none() {
        for earlier in report_runs(runs, monitor, run) {
            let id = earlier["id"].as_str().unwrap_or_default();
            if let Some(text) = report_of_run(&items(id)?, earlier) {
                return Ok(text);
            }
        }
    }
    Ok(commands::completed_without_result(notice.as_deref()))
}

fn stop_notice_id(run: &Value) -> String {
    commands::provider_stop_reason_id(run["id"].as_str().unwrap_or_default())
}

fn notice_text(item: &Value) -> Option<String> {
    (item["type"] == "system_notice")
        .then(|| item["message"].as_str().map(str::to_owned))
        .flatten()
}

/// [`result_for_run`] over the stored rows.
fn task_result(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<String> {
    let notice = tx
        .entity(thread_id, "turnItems", &stop_notice_id(run))?
        .as_ref()
        .and_then(notice_text);
    let runs = tx.entities(thread_id, "runs")?;
    let monitor = monitor_update_runs(tx, thread_id)?;
    result_for_run(run, &runs, &monitor, notice, |run_id| {
        tx.entities_where(thread_id, "turnItems", "runId", run_id)
    })
}

/// [`result_for_run`] over a thread projection: the result of a task whose row was published
/// before rows kept their result.
pub fn delegated_task_result(child: &Value, run: &Value) -> String {
    let rows = |kind: &str| child[kind].as_array().map_or(&[][..], Vec::as_slice);
    let items = rows("turnItems");
    let notice = items
        .iter()
        .find(|item| item["id"] == stop_notice_id(run).as_str())
        .and_then(notice_text);
    let monitor = monitor_runs(rows("messages"));
    let result = result_for_run(run, rows("runs"), &monitor, notice, |run_id| {
        Ok::<_, std::convert::Infallible>(
            items
                .iter()
                .filter(|item| item["runId"] == run_id)
                .cloned()
                .collect(),
        )
    });
    match result {
        Ok(text) => text,
        Err(never) => match never {},
    }
}

/// `runRanAfter`'s order: when a run ended (a run that has not ended, last), then its ordinal.
fn end_key(run: &Value) -> (bool, &str, u64) {
    let end = run["completedAt"].as_str().filter(|at| !at.is_empty());
    (
        end.is_none(),
        end.unwrap_or_default(),
        run["ordinal"].as_u64().unwrap_or(0),
    )
}

/// `delegatedTaskReportRuns`: the same task's completed runs before `run`, latest first,
/// ending at another task's run or any other outcome.
fn report_runs<'a>(runs: &'a [Value], monitor: &[Value], run: &Value) -> Vec<&'a Value> {
    if run["status"] != "completed" {
        return vec![];
    }
    let mut earlier: Vec<&Value> = runs
        .iter()
        .filter(|candidate| {
            candidate["id"] != run["id"]
                && !candidate["startedAt"].is_null()
                && candidate["status"] != "rolled_back"
                && !monitor.contains(&candidate["id"])
                && end_key(run) > end_key(candidate)
        })
        .collect();
    earlier.sort_by_key(|candidate| std::cmp::Reverse(end_key(candidate)));
    earlier
        .into_iter()
        .take_while(|candidate| {
            candidate["status"] == "completed"
                && candidate["delegatedTaskId"] == run["delegatedTaskId"]
        })
        .collect()
}

/// `monitorUpdateRunIds`: runs that only answer a monitor update are never a task's work.
fn monitor_update_runs(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Vec<Value>> {
    Ok(monitor_runs(&tx.entities(thread_id, "messages")?))
}

/// [`monitor_update_runs`] over a thread's messages.
pub fn monitor_runs(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter(|m| {
            m["notification"]["source"]["kind"] == "monitor"
                && m["notification"]["outcome"] == "updated"
                && m["runId"].is_string()
        })
        .map(|m| m["runId"].clone())
        .collect()
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

/// A finished task whose result still waits for its wake message (`delegatedCompletion`
/// `delivery` planned, its message not yet in the thread).
pub(crate) fn completion_undelivered(task: &Value) -> bool {
    task["origin"] == "app_owned" && task["completionDelivery"]["state"] == "pending"
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
pub(crate) fn finalize_tasks(tx: &mut Tx<'_>, child_id: &str) -> StoreResult<Vec<Effect>> {
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
    let monitor = monitor_update_runs(tx, child_id)?;
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
        // A turn that only answers a monitor update is no task's work (`delegatedTaskProgress`).
        let owned: Vec<&Value> = runs
            .iter()
            .filter(|run| match run["delegatedTaskId"].as_str() {
                Some(task) => task == id,
                None => is_original,
            })
            .filter(|run| run["status"] != "rolled_back" && !monitor.contains(&run["id"]))
            .collect();
        let active = owned.iter().any(|run| {
            !TERMINAL.contains(&run["status"].as_str().unwrap_or_default())
                && !(run["status"] == "queued" && run["queueHeld"] == true)
        });
        let result_run = if is_original {
            owned
                .iter()
                .filter(|run| {
                    TERMINAL.contains(&run["status"].as_str().unwrap_or_default())
                        && (!run["startedAt"].is_null() || run["ordinal"] == 1)
                })
                .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
                .map(|run| (*run).clone())
        } else {
            follow_up_result_run(&owned)
        };
        let Some(result_run) = result_run else {
            continue;
        };
        if active || !TERMINAL.contains(&result_run["status"].as_str().unwrap_or_default()) {
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

/// `delegatedTaskResultRun` (`RestartBackgroundNote.ts:262`): a follow-up's latest run,
/// passing over queued work it no longer waits on. A follow-up whose only run was cancelled
/// before it started reports that run, so it ends cancelled.
fn follow_up_result_run(runs: &[&Value]) -> Option<Value> {
    let mut runs: Vec<&Value> = runs.to_vec();
    runs.sort_by_key(|run| std::cmp::Reverse(run["ordinal"].as_u64().unwrap_or(0)));
    let cancelled_before_start = |run: &Value| {
        run["status"] == "cancelled"
            && run["startedAt"].is_null()
            && run["restartContinuationOfRunId"].is_null()
    };
    let awaited: Vec<&Value> = runs
        .iter()
        .copied()
        .filter(|run| {
            !cancelled_before_start(run) && !(run["status"] == "queued" && run["queueHeld"] == true)
        })
        .collect();
    awaited
        .iter()
        .find(|run| {
            matches!(
                run["status"].as_str(),
                Some("preparing" | "starting" | "running" | "waiting")
            )
        })
        .or_else(|| awaited.iter().find(|run| run["status"] == "queued"))
        .or_else(|| awaited.first())
        .or_else(|| runs.first())
        .map(|run| (*run).clone())
}

/// `settlesChildWork` (`Orchestrator.ts:16088`): before `draft` is written, whether it ends
/// work a delegated child's task may wait on: a subagent that stops, or a roster from which a
/// task that held completion is gone.
pub(crate) fn settles_child_work(tx: &Tx<'_>, draft: &Draft) -> StoreResult<bool> {
    let payload = &draft.payload;
    match draft.event_type {
        "subagent.updated" => Ok(!work_active(payload)),
        "provider-thread.updated" => {
            let holding = |thread: &Value| -> Vec<String> {
                thread["pendingBackgroundTasks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|task| background_holds_completion(task))
                    .filter_map(|task| task["taskId"].as_str().map(str::to_owned))
                    .collect()
            };
            let id = payload["id"].as_str().unwrap_or_default();
            let Some(previous) = tx.entity(&draft.thread_id, "providerThreads", id)? else {
                return Ok(false);
            };
            let now = holding(payload);
            Ok(holding(&previous).iter().any(|task| !now.contains(task)))
        }
        _ => Ok(false),
    }
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
    let status = run["status"].as_str().unwrap_or("failed");
    let status = if status == "rolled_back" {
        "cancelled"
    } else {
        status
    };
    let now = tx.now().to_owned();
    let result = task_result(tx, child_id, run)?;
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
    let state = match row["completionDelivery"]["state"].as_str() {
        _ if cancelled => "disposed",
        // Its parent already read it, or cancelled it (`task_cancel` disposes first).
        Some("acknowledged") => "acknowledged",
        Some("disposed") => "disposed",
        _ => "pending",
    };
    row["completionDelivery"] = json!({"state": state, "observedByRunId": row["completionDelivery"]["observedByRunId"].clone()});
    let draft = |event_type, payload| {
        Draft::new(parent_id, event_type, payload)
            .run(parent_run.as_deref())
            .node(Some(&node_id))
    };
    tx.append(draft("subagent.updated", row.clone()).payload_instance())?;
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
            row["origin"] == "app_owned"
                && row["completionDelivery"]["state"] == "pending"
                // A running follow-up's delivery waits for its result (`Orchestrator.ts:2113`).
                && TERMINAL.contains(&row["status"].as_str().unwrap_or_default())
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
        tx.append(
            Draft::new(thread_id, "subagent.updated", row)
                .run(run.as_deref())
                .payload_instance(),
        )?;
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
        Err(CommandError::Rejected(e) | CommandError::ThreadArchived(e)) => {
            eprintln!("conn-engine: could not wake {thread_id}: {e}")
        }
    }
    Ok(effects)
}

/// Stop reaches every open task of the thread and the threads under it, whether or not a
/// turn runs there (`stopDelegatedTasks`): a task waiting for its children or its background
/// work is stopped too. Each task is marked cancelled before its work ends, so it publishes
/// as interrupted and does not wake the stopped parent.
pub(crate) fn stop_children(tx: &mut Tx<'_>, thread_id: &str) -> StoreResult<Vec<Effect>> {
    let mut effects = vec![];
    // Follow-ups share their child thread; its work is stopped once.
    let mut stopped: Vec<String> = vec![];
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
        if row["origin"] != "app_owned" || !row["completedAt"].is_null() {
            continue;
        }
        let task_id = row["id"].as_str().unwrap_or_default().to_owned();
        if let Some(run_id) = cancelled_run(tx, &child, &task_id)? {
            row["cancelledRunId"] = json!(run_id);
            let parent_run = row["runId"].as_str().map(str::to_owned);
            tx.append(
                Draft::new(thread_id, "subagent.updated", row)
                    .run(parent_run.as_deref())
                    .without_instance(),
            )?;
        }
        if stopped.contains(&child) {
            continue;
        }
        commands::hold_queue(tx, &child)?;
        effects.extend(commands::stop_thread_work(tx, &child, None, false)?);
        // A task with no turn left to end publishes now; one still running, when it ends.
        effects.extend(finalize_tasks(tx, &child)?);
        stopped.push(child);
    }
    Ok(effects)
}

/// The run a cancel of `task_id` stops (`cancelDelegatedTask`): the follow-up's latest run,
/// else the child's latest live turn, else the latest turn that ran.
fn cancelled_run(tx: &Tx<'_>, child_id: &str, task_id: &str) -> StoreResult<Option<String>> {
    const LIVE: [&str; 5] = ["preparing", "queued", "starting", "running", "waiting"];
    let runs = tx.entities(child_id, "runs")?;
    let monitor = monitor_update_runs(tx, child_id)?;
    let latest = |keep: &dyn Fn(&Value) -> bool| {
        runs.iter()
            .filter(|run| keep(run))
            .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
            .and_then(|run| run["id"].as_str().map(str::to_owned))
    };
    let status = |run: &Value| run["status"].as_str().unwrap_or_default().to_owned();
    Ok(latest(&|run| run["delegatedTaskId"] == task_id)
        .or_else(|| {
            latest(&|run| LIVE.contains(&status(run).as_str()) && !monitor.contains(&run["id"]))
        })
        .or_else(|| {
            latest(&|run| {
                TERMINAL.contains(&status(run).as_str())
                    && !run["startedAt"].is_null()
                    && !monitor.contains(&run["id"])
            })
        }))
}

/// `delegated_task.cancel`, internal (T3 `cancelDelegatedTask`, `Orchestrator.ts:16320`): Stop
/// for a task's child, with the task's `cancelledRunId` in the same write, so its settled turn
/// publishes as interrupted. The child and every thread under it are checked against
/// `modeLimit` first, in this write: their user may have raised one since the caller checked.
pub(crate) fn cancel_task(tx: &mut Tx<'_>, c: Value) -> Outcome {
    let (parent, mut row) = task_row(tx, &c)?;
    let task_id = row["id"].as_str().unwrap_or_default().to_owned();
    let child = c["threadId"].as_str().unwrap_or_default().to_owned();
    if row["childThreadId"] != child.as_str() {
        return reject(format!("Delegated task {task_id} does not run in {child}."));
    }
    if let Some(refusal) = above_mode_limit(tx, &child, &c["modeLimit"], &mut vec![])? {
        return reject(refusal);
    }
    if work_active(&row)
        && row["completedAt"].is_null()
        && let Some(run_id) = cancelled_run(tx, &child, &task_id)?
    {
        row["cancelledRunId"] = json!(run_id);
        row["updatedAt"] = json!(tx.now());
        let parent_run = row["runId"].as_str().map(str::to_owned);
        tx.append(
            Draft::new(&parent, "subagent.updated", row)
                .run(parent_run.as_deref())
                .without_instance(),
        )?;
    }
    let stop = commands::handler("thread.stop").expect("thread.stop");
    let mut effects = stop(
        tx,
        json!({"type": "thread.stop", "commandId": c["commandId"], "threadId": child,
               "reason": c["reason"]}),
    )?;
    effects.extend(finalize_tasks(tx, &child)?);
    Ok(effects)
}

/// The code a refused cancel starts its message with, then `": "`.
pub(crate) const MODE_REFUSALS: [&str; 2] = [
    "runtime_mode_escalation_denied",
    "interaction_mode_escalation_denied",
];

/// The refusal for the first thread of `thread_id`'s family (itself, then its delegates) that
/// runs above `limit`, as `"<code>: <message>"`. A deleted thread is passed over.
fn above_mode_limit(
    tx: &Tx<'_>,
    thread_id: &str,
    limit: &Value,
    seen: &mut Vec<String>,
) -> StoreResult<Option<String>> {
    use conn_support::modes::{interaction_rank, runtime_rank};
    if !limit.is_object() || seen.iter().any(|id| id == thread_id) {
        return Ok(None);
    }
    seen.push(thread_id.to_owned());
    if let Some(thread) = tx.thread(thread_id)?.filter(|t| t["deletedAt"].is_null()) {
        let runtime = thread["runtimeMode"]
            .as_str()
            .unwrap_or("approval-required");
        let interaction = thread["interactionMode"].as_str().unwrap_or("default");
        let code = if runtime_rank(runtime)
            > runtime_rank(limit["runtimeMode"].as_str().unwrap_or_default())
        {
            Some(MODE_REFUSALS[0])
        } else if interaction_rank(interaction)
            > interaction_rank(limit["interactionMode"].as_str().unwrap_or_default())
        {
            Some(MODE_REFUSALS[1])
        } else {
            None
        };
        if let Some(code) = code {
            return Ok(Some(format!(
                "{code}: Thread {thread_id} now runs in {runtime}/{interaction} mode, above this thread's; its user changed it while the task was being cancelled."
            )));
        }
    }
    for row in tx.entities(thread_id, "subagents")? {
        if row["origin"] != "app_owned" {
            continue;
        }
        if let Some(child) = row["childThreadId"].as_str()
            && let Some(refusal) = above_mode_limit(tx, child, limit, seen)?
        {
            return Ok(Some(refusal));
        }
    }
    Ok(None)
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
    tx.append(
        Draft::new(&parent, "subagent.updated", row)
            .run(run.as_deref())
            .payload_instance(),
    )?;
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
    tx.append(
        Draft::new(&parent, "subagent.updated", row)
            .run(run.as_deref())
            .payload_instance(),
    )?;
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
    let instance = model["instanceId"].as_str().map(str::to_owned);
    let draft = |event_type, payload| {
        Draft::new(&parent_id, event_type, payload)
            .run(Some(&parent_run_id))
            .node(Some(&node_id))
            .command(Some(&command_id))
            .provider_instance(instance.as_deref())
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
    tx.append(
        Draft::new(parent, "subagent.updated", row)
            .run(run.as_deref())
            .without_instance(),
    )?;
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
    // T3's `dispatchRemoteDelegatedTaskComplete` names no instance.
    let draft = |event_type, payload| {
        Draft::new(parent, event_type, payload)
            .run(parent_run.as_deref())
            .node(Some(&node_id))
            .without_instance()
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
        tx.append(
            Draft::new(&parent, "subagent.updated", row)
                .run(run.as_deref())
                .without_instance(),
        )?;
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

/// A provider session whose process ended with it, and when its release began.
pub(crate) struct ReleasedSession<'a> {
    pub(crate) provider_session_id: &'a str,
    /// Epoch milliseconds. A subagent that started or resumed later belongs to a newer
    /// session.
    pub(crate) released_at: i64,
}

/// `endOrphanedNativeSubagent` and `endRunlessRootTurns` (`subagentProjection.ts`): no
/// provider process is left to report the end of the thread's open provider-native subagents.
/// Each one's row, node and turn item end with `status`, and so does what its child thread
/// still has open outside a run. With `released` (`writeReleasedSubagentEvents`), only the
/// subagents of that session's provider threads end; without it (a start, when no process
/// survived), all of them.
pub(crate) fn end_orphaned_native_subagents(
    tx: &mut Tx<'_>,
    thread_id: &str,
    status: &str,
    released: Option<&ReleasedSession<'_>>,
) -> StoreResult<()> {
    let now = tx.now().to_owned();
    // The released session's provider threads: (id, driver).
    let released_threads: Vec<(Value, Value)> = match released {
        Some(released) => tx
            .entities(thread_id, "providerThreads")?
            .into_iter()
            .filter(|t| t["providerSessionId"] == released.provider_session_id)
            .map(|t| (t["id"].clone(), t["driver"].clone()))
            .collect(),
        None => Vec::new(),
    };
    if released.is_some() && released_threads.is_empty() {
        return Ok(());
    }
    for row in tx.entities(thread_id, "subagents")? {
        if row["origin"] != "provider_native" || !work_active(&row) {
            continue;
        }
        if let Some(released) = released {
            let started = row["startedAt"]
                .as_str()
                .or(row["updatedAt"].as_str())
                .and_then(crate::time::millis_from_iso);
            if started.is_some_and(|started| started > released.released_at) {
                continue;
            }
            // Record and item are written together; a record without a live item lost its
            // end, so the driver decides.
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let item = tx
                .entities_where(thread_id, "turnItems", "subagentId", &id)?
                .into_iter()
                .find(|item| item["type"] == "subagent" && work_active(item));
            let ours = released_threads.iter().any(|(thread, driver)| {
                row["driver"] == *driver
                    && item
                        .as_ref()
                        .is_none_or(|item| item["providerThreadId"] == *thread)
            });
            if !ours {
                continue;
            }
        }
        end_native_subagent(tx, thread_id, row, status, &now)?;
    }
    Ok(())
}

/// `cascadeTerminalizeRunOwnedSubagents`: a run that ends interrupted, failed or cancelled
/// ends the open work it owns. It owns its provider-native subagents, the threads they run in,
/// and the native subagents nested there (on a child thread, with no run), recursively, as
/// T3's `ownedThreadIds` grows with each subagent thread. Each open record, node, item and
/// provider turn settles on its own, once. A record that already settled keeps its result.
pub(crate) fn end_run_native_subagents(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
    status: &str,
) -> StoreResult<()> {
    let now = tx.now().to_owned();
    let mut owned = std::collections::HashSet::from([thread_id.to_owned()]);
    let mut pending: Vec<(String, Value)> = tx
        .entities_where(thread_id, "subagents", "runId", run_id)?
        .into_iter()
        .filter(|row| row["origin"] == "provider_native")
        .map(|row| (thread_id.to_owned(), row))
        .collect();
    while let Some((owner, mut row)) = pending.pop() {
        // Every event of the cascade belongs to the run that owns it, as in T3; each row keeps
        // its own `runId`.
        let run = row["runId"].as_str().unwrap_or(run_id).to_owned();
        if work_active(&row) {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let work = row.clone();
            row["status"] = json!(status);
            row["completedAt"] = json!(now);
            row["updatedAt"] = json!(now);
            tx.append(
                Draft::new(&owner, "subagent.updated", row)
                    .run(Some(run_id))
                    .node(Some(&id)),
            )?;
            row = work;
        }
        settle_subagent_rows(tx, &owner, &row, Some(&run), status, &now)?;
        let Some(child) = row["childThreadId"].as_str().map(str::to_owned) else {
            continue;
        };
        // A thread seen before is not followed again, so a cycle in the links ends here.
        if owned.contains(&child) || tx.thread(&child)?.is_none() {
            continue;
        }
        owned.insert(child.clone());
        settle_owned_work(tx, &child, run_id, status, &now)?;
        pending.extend(
            tx.entities_where(&child, "subagents", "origin", "provider_native")?
                .into_iter()
                .filter(|nested| nested["runId"].is_null())
                .map(|nested| (child.clone(), nested)),
        );
    }
    Ok(())
}

/// Ends one provider-native subagent: its record, node and item together, then its child's
/// runless root turns.
fn end_native_subagent(
    tx: &mut Tx<'_>,
    thread_id: &str,
    mut row: Value,
    status: &str,
    now: &str,
) -> StoreResult<()> {
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    let run = row["runId"].as_str().map(str::to_owned);
    let work = row.clone();
    row["status"] = json!(status);
    row["completedAt"] = json!(now);
    row["updatedAt"] = json!(now);
    tx.append(
        Draft::new(thread_id, "subagent.updated", row)
            .run(run.as_deref())
            .node(Some(&id)),
    )?;
    end_subagent_work(tx, thread_id, &work, status, now)
}

/// A subagent's open work: its node, its item, and its child's runless root turns. Only open
/// rows change, so each settles once.
fn end_subagent_work(
    tx: &mut Tx<'_>,
    thread_id: &str,
    row: &Value,
    status: &str,
    now: &str,
) -> StoreResult<()> {
    let run = row["runId"].as_str().map(str::to_owned);
    settle_subagent_rows(tx, thread_id, row, run.as_deref(), status, now)?;
    if let Some(child) = row["childThreadId"].as_str().filter(|c| *c != thread_id)
        && tx.thread(child)?.is_some()
    {
        end_runless_root_turns(tx, child, status, now)?;
    }
    Ok(())
}

/// A subagent's own open node and items, each on its own, with `run` on their events.
fn settle_subagent_rows(
    tx: &mut Tx<'_>,
    thread_id: &str,
    row: &Value,
    run: Option<&str>,
    status: &str,
    now: &str,
) -> StoreResult<()> {
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    if let Some(mut node) = tx.entity(thread_id, "nodes", &id)?.filter(work_active) {
        node["status"] = json!(status);
        node["completedAt"] = json!(now);
        tx.append(
            Draft::new(thread_id, "node.updated", node)
                .run(run)
                .node(Some(&id)),
        )?;
    }
    for mut item in tx.entities_where(thread_id, "turnItems", "subagentId", &id)? {
        if item["type"] != "subagent" || !work_active(&item) {
            continue;
        }
        item["status"] = json!(status);
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        tx.append(
            Draft::new(thread_id, "turn-item.updated", item)
                .run(run)
                .node(Some(&id)),
        )?;
    }
    Ok(())
}

/// The open work of a subagent thread the ending run (`run_id`) owns, each row on its own:
/// nodes and items with no run or with that run, as T3's cascade picks them, and provider
/// turns of no run attempt. Their events carry the row's run, or else the owning run
/// (`runId: row.runId ?? run.id`). A settled item that streams stops streaming.
fn settle_owned_work(
    tx: &mut Tx<'_>,
    thread_id: &str,
    run_id: &str,
    status: &str,
    now: &str,
) -> StoreResult<()> {
    let owned = |row: &Value| row["runId"].is_null() || row["runId"] == run_id;
    let run_of = |row: &Value| row["runId"].as_str().unwrap_or(run_id).to_owned();
    for mut node in open_rows(tx, thread_id, "nodes")? {
        if !owned(&node) {
            continue;
        }
        let (node_id, run) = (
            node["id"].as_str().unwrap_or_default().to_owned(),
            run_of(&node),
        );
        node["status"] = json!(status);
        node["completedAt"] = json!(now);
        tx.append(
            Draft::new(thread_id, "node.updated", node)
                .run(Some(&run))
                .node(Some(&node_id)),
        )?;
    }
    for mut item in open_rows(tx, thread_id, "turnItems")? {
        if !owned(&item) {
            continue;
        }
        let (node_id, run) = (item["nodeId"].as_str().map(str::to_owned), run_of(&item));
        item["status"] = json!(status);
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        if item.get("streaming").is_some() {
            item["streaming"] = json!(false);
        }
        tx.append(
            Draft::new(thread_id, "turn-item.updated", item)
                .run(Some(&run))
                .node(node_id.as_deref()),
        )?;
    }
    for mut turn in open_rows(tx, thread_id, "providerTurns")? {
        if !turn["runAttemptId"].is_null() {
            continue;
        }
        let node_id = turn["nodeId"].as_str().map(str::to_owned);
        turn["status"] = json!(status);
        turn["completedAt"] = json!(now);
        tx.append(
            Draft::new(thread_id, "provider-turn.updated", turn)
                .run(Some(run_id))
                .node(node_id.as_deref()),
        )?;
    }
    Ok(())
}

/// `endRunlessRootTurns` (`subagentProjection.ts`): when a released or restarted session leaves
/// a subagent thread behind, only its runless root turns end, with the runless items and
/// provider turns attached to them. A nested subagent's own node stays for its own end.
fn end_runless_root_turns(
    tx: &mut Tx<'_>,
    thread_id: &str,
    status: &str,
    now: &str,
) -> StoreResult<()> {
    for mut node in open_rows(tx, thread_id, "nodes")? {
        if node["kind"] != "root_turn" || !node["runId"].is_null() {
            continue;
        }
        let node_id = node["id"].as_str().unwrap_or_default().to_owned();
        node["status"] = json!(status);
        node["completedAt"] = json!(now);
        tx.append(Draft::new(thread_id, "node.updated", node).node(Some(&node_id)))?;
        for mut item in tx.entities_where(thread_id, "turnItems", "nodeId", &node_id)? {
            if !item["runId"].is_null() || !work_active(&item) {
                continue;
            }
            let kind = item["type"].as_str().unwrap_or_default().to_owned();
            item["status"] = json!(if status == "completed"
                && matches!(kind.as_str(), "command_execution" | "dynamic_tool")
            {
                "failed"
            } else {
                status
            });
            item["completedAt"] = json!(now);
            item["updatedAt"] = json!(now);
            if matches!(kind.as_str(), "reasoning" | "assistant_message") {
                item["streaming"] = json!(false);
            }
            tx.append(Draft::new(thread_id, "turn-item.updated", item).node(Some(&node_id)))?;
        }
        for mut turn in tx.entities_where(thread_id, "providerTurns", "nodeId", &node_id)? {
            if !turn["runAttemptId"].is_null() || !work_active(&turn) {
                continue;
            }
            turn["status"] = json!(status);
            turn["completedAt"] = json!(now);
            tx.append(Draft::new(thread_id, "provider-turn.updated", turn).node(Some(&node_id)))?;
        }
    }
    Ok(())
}

/// A thread's `kind` rows in an open status.
fn open_rows(tx: &Tx<'_>, thread_id: &str, kind: &str) -> StoreResult<Vec<Value>> {
    let mut rows = Vec::new();
    for status in ["pending", "running", "waiting"] {
        rows.extend(tx.entities_where(thread_id, kind, "status", status)?);
    }
    Ok(rows)
}
