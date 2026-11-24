//! `getSettlementCandidates` (`ProjectionStore.ts:8594`): the threads automatic settlement may
//! consider, each as its shell row with the fields the decision reads. A thread is left out when
//! it is archived, settled or unsettled by hand, pinned, opted out, running, waiting on a request
//! or an unanswered link card, or a delegate whose parent still lives unsettled. The server's own
//! idle compactions do not count as activity.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::shell::{IDLE_COMPACTION_MESSAGE_SQL, silent_run_sql};
use crate::store::StoreResult;

fn err(e: rusqlite::Error) -> String {
    format!("store: {e}")
}

fn parse(text: &str) -> StoreResult<Value> {
    serde_json::from_str(text).map_err(|e| format!("store: bad json: {e}"))
}

fn one(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> StoreResult<Option<Value>> {
    conn.query_row(sql, args, |row| row.get::<_, String>(0))
        .optional()
        .map_err(err)?
        .map(|text| parse(&text))
        .transpose()
}

fn exists(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> StoreResult<bool> {
    conn.query_row(sql, args, |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
        .map_err(err)
}

/// The candidates, oldest activity first; with `thread_id`, at most that thread.
pub(crate) fn candidates(conn: &Connection, thread_id: Option<&str>) -> StoreResult<Vec<Value>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, thread, shell FROM threads
             WHERE deleted = 0 AND shell IS NOT NULL AND (?1 IS NULL OR id = ?1)
             ORDER BY activity_at, id",
        )
        .map_err(err)?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([thread_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut out = Vec::new();
    for (id, thread, shell) in rows {
        let thread = parse(&thread)?;
        if let Some(candidate) = candidate(conn, &id, &thread, parse(&shell)?)? {
            out.push(candidate);
        }
    }
    Ok(out)
}

/// `pendingGuestMessageCount`: a guest's messages the thread has not taken up yet.
fn pending_guest_messages(thread: &Value) -> usize {
    thread["guestShare"]["messages"]
        .as_array()
        .map_or(0, |messages| {
            messages
                .iter()
                .filter(|message| message["status"] == "pending")
                .count()
        })
}

fn candidate(
    conn: &Connection,
    id: &str,
    thread: &Value,
    mut shell: Value,
) -> StoreResult<Option<Value>> {
    let null = |field: &str| thread.get(field).is_none_or(Value::is_null);
    if !(null("archivedAt")
        && null("settledOverride")
        && null("pinnedAt")
        && null("autoSettleDisabledAt"))
    {
        return Ok(None);
    }
    // A delegate settles with its parent, once the parent is gone, archived or settled.
    if thread["lineage"]["relationshipToParent"] == "subagent"
        && let Some(parent) = thread["lineage"]["parentThreadId"].as_str()
    {
        let live: Option<String> = conn
            .query_row(
                "SELECT thread FROM threads WHERE id = ?1 AND deleted = 0",
                [parent],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;
        if let Some(parent) = live.map(|text| parse(&text)).transpose()?
            && parent["archivedAt"].is_null()
            && parent["settledOverride"] != "settled"
        {
            return Ok(None);
        }
    }
    if exists(
        conn,
        "SELECT 1 FROM entities WHERE thread_id = ?1 AND kind = 'runs'
         AND json_extract(body, '$.status') IN ('preparing', 'starting', 'running', 'waiting')",
        params![id],
    )? || exists(
        conn,
        "SELECT 1 FROM entities WHERE thread_id = ?1 AND kind = 'runtimeRequests'
         AND json_extract(body, '$.status') = 'pending'",
        params![id],
    )? {
        return Ok(None);
    }
    // `linkCardStillAsks`: a waiting link card asks until the user writes after it.
    let user_authored = format!(
        "SELECT 1 FROM entities AS m WHERE m.thread_id = ?1 AND m.kind = 'messages'
         AND json_extract(m.body, '$.role') = 'user'
         AND json_extract(m.body, '$.createdBy') = 'user' AND NOT {IDLE_COMPACTION_MESSAGE_SQL}"
    );
    if exists(
        conn,
        &format!(
            "SELECT 1 FROM entities AS link WHERE link.thread_id = ?1 AND link.kind = 'turnItems'
             AND json_extract(link.body, '$.type') = 'link_request'
             AND json_extract(link.body, '$.status') = 'waiting'
             AND NOT EXISTS ({user_authored} AND json_extract(m.body, '$.updatedAt') >
                 COALESCE(json_extract(link.body, '$.startedAt'), json_extract(link.body, '$.updatedAt')))"
        ),
        params![id],
    )? {
        return Ok(None);
    }
    let latest_run = one(
        conn,
        &format!(
            "SELECT body FROM entities AS r WHERE thread_id = ?1 AND kind = 'runs'
             AND NOT {} ORDER BY ordinal DESC LIMIT 1",
            silent_run_sql()
        ),
        params![id],
    )?;
    let latest_message = |authored: bool| -> StoreResult<Value> {
        let by = if authored {
            "AND json_extract(m.body, '$.createdBy') = 'user'"
        } else {
            ""
        };
        Ok(one(
            conn,
            &format!(
                "SELECT body FROM entities AS m WHERE m.thread_id = ?1 AND m.kind = 'messages'
                 AND json_extract(m.body, '$.role') = 'user' {by}
                 AND NOT {IDLE_COMPACTION_MESSAGE_SQL}
                 ORDER BY json_extract(m.body, '$.updatedAt') DESC, m.id DESC LIMIT 1"
            ),
            params![id],
        )?
        .map_or(Value::Null, |message| message["updatedAt"].clone()))
    };
    let run = |field: &str| {
        latest_run
            .as_ref()
            .map_or(Value::Null, |run| run[field].clone())
    };
    let status = latest_run
        .as_ref()
        .map_or(json!("idle"), |run| run["status"].clone());
    for (field, value) in [
        ("status", status),
        ("latestRunId", run("id")),
        ("latestRunRequestedAt", run("requestedAt")),
        ("latestRunStartedAt", run("startedAt")),
        ("latestRunCompletedAt", run("completedAt")),
        ("latestUserMessageAt", latest_message(false)?),
        ("latestUserAuthoredMessageAt", latest_message(true)?),
        ("lastSnoozeWakeAt", thread["lastSnoozeWakeAt"].clone()),
        ("activityRunStatus", Value::Null),
        ("activityRunStartedAt", Value::Null),
        ("pendingRuntimeRequest", Value::Null),
        (
            "pendingGuestMessageCount",
            json!(pending_guest_messages(thread)),
        ),
    ] {
        shell[field] = value;
    }
    Ok(Some(shell))
}
