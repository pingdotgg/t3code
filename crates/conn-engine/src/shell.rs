//! `OrchestrationV2ThreadShell`: the summary row a thread shows in lists.
//!
//! Derived from the thread's projection rows inside the write that changed them, the way
//! `ProjectionStore.ts` builds it, for the fields this engine can produce. Message bodies stay
//! out of shell rows (`latestVisibleMessage` is always null, as in TS).

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::store::{StoreResult, Tx};

pub(crate) const LIVE_RUN_STATUSES: [&str; 5] =
    ["preparing", "queued", "starting", "running", "waiting"];
/// `isActiveRun`: the run that owns the provider. A queued run waits behind it.
pub(crate) const ACTIVE_RUN_STATUSES: [&str; 4] = ["preparing", "starting", "running", "waiting"];

fn one(tx: &Tx<'_>, sql: &str, args: &[&dyn rusqlite::ToSql]) -> StoreResult<Option<Value>> {
    tx.conn()
        .query_row(sql, args, |row| row.get::<_, String>(0))
        .optional()
        .map(|body| body.and_then(|text| serde_json::from_str(&text).ok()))
        .map_err(|e| format!("store: {e}"))
}

pub(crate) fn thread_shell(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Value> {
    let thread = tx
        .thread(thread_id)?
        .ok_or_else(|| format!("thread {thread_id} has no row"))?;
    let activity_at: String = tx
        .conn()
        .query_row(
            "SELECT activity_at FROM threads WHERE id = ?1",
            [thread_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("store: {e}"))?;

    // Queued runs and runs cancelled from the queue never started: the thread's status is the
    // latest run that did.
    let latest_run = one(
        tx,
        "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'runs'
         AND json_extract(body, '$.status') != 'queued'
         AND NOT (json_extract(body, '$.status') = 'cancelled' AND json_extract(body, '$.startedAt') IS NULL
                  AND json_extract(body, '$.activeAttemptId') IS NULL)
         ORDER BY ordinal DESC LIMIT 1",
        params![thread_id],
    )?;
    let active_run = latest_run
        .as_ref()
        .filter(|run| ACTIVE_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or("")));
    let activity_run = active_run;
    let pending = one(
        tx,
        "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'runtimeRequests'
         AND json_extract(body, '$.status') = 'pending' ORDER BY seq DESC LIMIT 1",
        params![thread_id],
    )?;
    let latest_user = one(
        tx,
        "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'messages'
         AND json_extract(body, '$.role') = 'user' ORDER BY first_seq DESC LIMIT 1",
        params![thread_id],
    )?;
    // `latestRootProviderFailure`: the newest failed error item on a failed run's root node.
    let failure = match &latest_run {
        Some(run) if run["status"] == "failed" => one(
            tx,
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
             AND json_extract(body, '$.type') = 'error' AND json_extract(body, '$.status') = 'failed'
             AND json_extract(body, '$.runId') = ?2 AND json_extract(body, '$.nodeId') = ?3
             ORDER BY seq DESC LIMIT 1",
            params![thread_id, run["id"].as_str(), run["rootNodeId"].as_str()],
        )?
        .map(|item| item["failure"].clone()),
        _ => None,
    };
    let item_count = tx.count(thread_id, "turnItems")?;
    let mut history: Vec<Value> = Vec::new();
    for provider_thread in tx.entities(thread_id, "providerThreads")? {
        let id = provider_thread["providerInstanceId"].clone();
        if id.is_string() && !history.contains(&id) {
            history.push(id);
        }
    }

    let field = |name: &str| thread.get(name).cloned().unwrap_or(Value::Null);
    let run_field = |name: &str| {
        latest_run
            .as_ref()
            .map_or(Value::Null, |run| run[name].clone())
    };
    let failure_field = |name: &str| {
        failure
            .as_ref()
            .map_or(Value::Null, |failure| failure[name].clone())
    };
    let status = latest_run
        .as_ref()
        .map_or(json!("idle"), |run| run["status"].clone());

    Ok(json!({
        "createdBy": field("createdBy"),
        "creationSource": field("creationSource"),
        "id": thread_id,
        "projectId": field("projectId"),
        "title": field("title"),
        "providerInstanceId": field("providerInstanceId"),
        "modelSelection": field("modelSelection"),
        "runtimeMode": field("runtimeMode"),
        "interactionMode": field("interactionMode"),
        "branch": field("branch"),
        "worktreePath": field("worktreePath"),
        "pullRequests": thread.get("pullRequests").cloned().unwrap_or(json!([])),
        "lineage": field("lineage"),
        "forkedFrom": field("forkedFrom"),
        "activeProviderThreadId": field("activeProviderThreadId"),
        "latestRunId": run_field("id"),
        "latestRunRequestedAt": run_field("requestedAt"),
        "latestRunStartedAt": run_field("startedAt"),
        "latestRunCompletedAt": run_field("completedAt"),
        "latestRunStopRequested": false,
        "latestRunBackgroundWake": false,
        "activeRunId": active_run.map_or(Value::Null, |run| run["id"].clone()),
        "blockedOnThreadWait": false,
        "activityRunStatus": activity_run.map_or(Value::Null, |run| run["status"].clone()),
        "activityRunStartedAt": activity_run.map_or(Value::Null, |run| {
            if run["startedAt"].is_null() { run["requestedAt"].clone() } else { run["startedAt"].clone() }
        }),
        "status": status,
        "lastError": failure_field("message"),
        "lastErrorClass": failure_field("class"),
        "lastErrorCode": failure_field("code"),
        "usageLimitResetAt": null,
        "pendingRuntimeRequest": pending.map_or(Value::Null, |request| json!({
            "id": request["id"],
            "kind": request["kind"],
            "createdAt": request["createdAt"],
        })),
        "pendingGuestMessageCount": 0,
        "latestVisibleMessage": null,
        "latestUserMessageAt": latest_user.as_ref().map_or(Value::Null, |m| m["updatedAt"].clone()),
        "latestUserAuthoredMessageAt": latest_user
            .as_ref()
            .filter(|m| m["createdBy"] == "user")
            .map_or(Value::Null, |m| m["updatedAt"].clone()),
        "hasActionableProposedPlan": false,
        "pendingBackgroundTasks": [],
        "providerInstanceHistory": history,
        "goal": null,
        "itemCount": item_count,
        "visibleItemCount": item_count,
        "createdAt": field("createdAt"),
        "updatedAt": activity_at,
        "archivedAt": field("archivedAt"),
        "settledOverride": field("settledOverride"),
        "settledAt": field("settledAt"),
        "unsettledAt": field("unsettledAt"),
        "snoozedUntil": field("snoozedUntil"),
        "snoozedAt": field("snoozedAt"),
        "pinnedAt": field("pinnedAt"),
        "autoSettleDisabledAt": field("autoSettleDisabledAt"),
        "pinOrderKey": field("pinOrderKey"),
        "activeOrderKey": field("activeOrderKey"),
        "tags": thread.get("tags").cloned().unwrap_or(json!([])),
        "lastVisitedAt": field("lastVisitedAt"),
        "opens": field("opens"),
        "titleRegeneration": field("titleRegeneration"),
        "lastTitleRegeneration": field("lastTitleRegeneration"),
        "limitRecovery": field("limitRecovery"),
        "deletedAt": field("deletedAt"),
    }))
}
