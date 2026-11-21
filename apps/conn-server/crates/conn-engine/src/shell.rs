//! `OrchestrationV2ThreadShell`: the summary row a thread shows in lists.
//!
//! Derived from the thread's projection rows inside the write that changed them, the way
//! `ProjectionStore.ts` builds it, for the fields this engine can produce. Message bodies stay
//! out of shell rows (`latestVisibleMessage` is always null, as in TS).

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::store::{StoreResult, Tx};

const PENDING_SECRET_SQL: &str = "SELECT i.body FROM entities i INDEXED BY entities_waiting_secrets
    JOIN entities r ON r.thread_id = i.thread_id AND r.kind = 'runs' AND r.id = json_extract(i.body, '$.runId')
    WHERE i.thread_id = ?1 AND i.kind = 'turnItems'
      AND json_extract(i.body, '$.type') = 'secret_request'
      AND json_extract(i.body, '$.status') = 'waiting'
      AND json_extract(r.body, '$.status') IN ('preparing','starting','running','waiting')
    ORDER BY json_extract(i.body, '$.updatedAt') DESC, i.id DESC LIMIT 1";

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

/// The shell's `pendingBackgroundTasks` (`derivePendingBackgroundWork`). Only background
/// turn items in an active status are read, so the cost stays with the work that still runs.
fn pending_background_tasks(
    tx: &Tx<'_>,
    thread_id: &str,
    thread: &Value,
    latest_run: Option<&Value>,
    provider_threads: &[Value],
) -> StoreResult<Vec<Value>> {
    let has_active_run = latest_run.is_some_and(|run| {
        matches!(
            run["status"].as_str(),
            Some("preparing" | "starting" | "running")
        )
    });
    if has_active_run {
        return Ok(vec![]);
    }
    let read = |sql: &str| -> StoreResult<Vec<Value>> {
        let mut statement = tx.conn().prepare(sql).map_err(|e| format!("store: {e}"))?;
        let rows = statement
            .query_map(params![thread_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("store: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            let text = row.map_err(|e| format!("store: {e}"))?;
            if let Ok(value) = serde_json::from_str(&text) {
                out.push(value);
            }
        }
        Ok(out)
    };
    let items = read(
        "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
         AND json_extract(body, '$.type') IN ('command_execution', 'dynamic_tool', 'subagent')
         AND json_extract(body, '$.status') IN ('pending', 'running', 'waiting')
         ORDER BY first_seq",
    )?;
    let rolled_back: std::collections::HashSet<String> = read(
        "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'runs'
         AND json_extract(body, '$.status') = 'rolled_back'",
    )?
    .iter()
    .filter_map(|run| run["id"].as_str().map(str::to_owned))
    .collect();
    let pull_requests = thread["pullRequests"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(crate::background::derive_pending_background_work(
        &crate::background::BackgroundInput {
            latest_run,
            has_active_run,
            provider_threads,
            turn_items: &items,
            active_provider_thread_id: thread["activeProviderThreadId"].as_str(),
            rolled_back_run_ids: &rolled_back,
            pull_requests: &pull_requests,
        },
    ))
}

/// The latest run that started and the provider thread whose background work outlives it,
/// for a Stop with no active run (`dispatchThreadStop`: `derivePendingBackgroundWork` on the
/// latest run). `None` when nothing runs in the background.
pub(crate) fn settled_background_target(
    tx: &Tx<'_>,
    thread_id: &str,
) -> StoreResult<Option<(Value, Value)>> {
    let Some(thread) = tx.thread(thread_id)? else {
        return Ok(None);
    };
    let latest_run = one(
        tx,
        "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'runs'
         AND json_extract(body, '$.status') != 'queued' ORDER BY ordinal DESC LIMIT 1",
        params![thread_id],
    )?;
    let provider_threads = tx.entities(thread_id, "providerThreads")?;
    let pending = pending_background_tasks(
        tx,
        thread_id,
        &thread,
        latest_run.as_ref(),
        &provider_threads,
    )?;
    let Some(run) = latest_run.filter(|_| !pending.is_empty()) else {
        return Ok(None);
    };
    let provider_thread = provider_threads
        .into_iter()
        .find(|pt| pt["id"] == run["providerThreadId"]);
    Ok(provider_thread.map(|pt| (run, pt)))
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

    // `latestUnheldRun`: the newest run, a queued one too (the thread shows `queued` while a
    // message waits behind a running turn), but not a run held in the queue, nor a run
    // cancelled before it started that an earlier run outlived (a steered queued message).
    let latest_run = one(
        tx,
        "SELECT body FROM entities AS r WHERE thread_id = ?1 AND kind = 'runs'
         AND NOT (json_extract(body, '$.status') = 'queued' AND json_extract(body, '$.queueHeld') IS 1)
         AND NOT (json_extract(body, '$.status') = 'cancelled' AND json_extract(body, '$.startedAt') IS NULL
                  AND json_extract(body, '$.completedAt') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM entities AS e WHERE e.thread_id = ?1 AND e.kind = 'runs'
                              AND e.ordinal < r.ordinal
                              AND json_extract(e.body, '$.status') != 'queued'
                              AND (json_extract(e.body, '$.completedAt') IS NULL
                                   OR json_extract(e.body, '$.completedAt')
                                      >= json_extract(r.body, '$.completedAt'))))
         ORDER BY ordinal DESC LIMIT 1",
        params![thread_id],
    )?;
    // `isInterruptibleRunForShell` and `isActivityRunForShell`: the newest run in those
    // states, whichever run is latest.
    let newest_in = |statuses: &str| {
        one(
            tx,
            &format!(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'runs'
                 AND json_extract(body, '$.status') IN ({statuses})
                 ORDER BY ordinal DESC LIMIT 1"
            ),
            params![thread_id],
        )
    };
    let active_run = newest_in("'preparing', 'starting', 'running'")?;
    let activity_run = newest_in("'preparing', 'starting', 'running', 'waiting'")?;
    let (active_run, activity_run) = (active_run.as_ref(), activity_run.as_ref());
    let pending = one(
        tx,
        "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'runtimeRequests'
         AND json_extract(body, '$.status') = 'pending' ORDER BY seq DESC LIMIT 1",
        params![thread_id],
    )?;
    let secret = one(tx, PENDING_SECRET_SQL, params![thread_id])?;
    let mut pending_summary = pending.as_ref().map_or(Value::Null, |request| {
        json!({
            "id":request.get("id"), "kind":request.get("kind"), "createdAt":request.get("createdAt")
        })
    });
    if let Some(secret) = secret.filter(|s| s.get("nodeId").is_some_and(Value::is_string)) {
        let created = secret
            .get("startedAt")
            .filter(|v| !v.is_null())
            .or_else(|| secret.get("updatedAt"));
        let replaces = pending.as_ref().is_none_or(|p| {
            p.get("kind").and_then(Value::as_str) == Some("user_input")
                && created.and_then(Value::as_str) >= p.get("createdAt").and_then(Value::as_str)
        });
        if replaces {
            pending_summary = json!({"id":secret.get("id"),"kind":"user_input","createdAt":created,"blocking":true,"userOnly":true});
        }
    }
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
    let provider_threads = tx.entities(thread_id, "providerThreads")?;
    let mut history: Vec<Value> = Vec::new();
    for provider_thread in &provider_threads {
        let id = provider_thread["providerInstanceId"].clone();
        if id.is_string() && !history.contains(&id) {
            history.push(id);
        }
    }
    let pending_background = pending_background_tasks(
        tx,
        thread_id,
        &thread,
        latest_run.as_ref(),
        &provider_threads,
    )?;

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

    let mut row = json!({
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
        "pendingRuntimeRequest": pending_summary,
        "pendingGuestMessageCount": 0,
        "latestVisibleMessage": null,
        "latestUserMessageAt": latest_user.as_ref().map_or(Value::Null, |m| m["updatedAt"].clone()),
        "latestUserAuthoredMessageAt": latest_user
            .as_ref()
            .filter(|m| m["createdBy"] == "user")
            .map_or(Value::Null, |m| m["updatedAt"].clone()),
        "hasActionableProposedPlan": false,
        "pendingBackgroundTasks": pending_background,
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
    });
    // As T3's shell: present only when the thread has them.
    for key in [
        "linkedPullRequest",
        "branchPullRequest",
        "issues",
        "historyOrigin",
    ] {
        if let (Some(value), Some(map)) = (thread.get(key), row.as_object_mut()) {
            map.insert(key.into(), value.clone());
        }
    }
    // The link that started it, when one did (`linkOrigin`): the fence reads it.
    if let Some(from) = thread.get("delegatedFrom").filter(|d| d.is_object()) {
        row["delegatedFrom"] = from.clone();
    }
    if let Some(origin) = thread.get("linkOrigin").filter(|o| o.is_object()) {
        row["linkOrigin"] = origin.clone();
    }
    Ok(row)
}

#[cfg(test)]
mod tests {
    #[test]
    fn pending_secrets_use_a_sparse_index_and_look_up_their_own_run() {
        let path = std::env::temp_dir().join(format!(
            "conn-secret-index-{}.sqlite",
            conn_support::uuid_v4()
        ));
        let store = crate::store::Store::open(&path).unwrap();
        let plan = store.query_plan(super::PENDING_SECRET_SQL, rusqlite::params!["t"]);
        assert!(
            plan.iter()
                .any(|step| step.contains("USING INDEX entities_waiting_secrets")),
            "{plan:?}"
        );
        assert!(
            plan.iter()
                .any(|step| step.contains("r USING PRIMARY KEY") && step.contains("id=?")),
            "{plan:?}"
        );
        assert!(
            !plan.iter().any(|step| step.contains("TEMP B-TREE")),
            "{plan:?}"
        );
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
}
