//! `freshContext`: a run that starts a new provider conversation. T3's rules from
//! `Orchestrator.ts` (`isScheduledFreshRun`, `contextBoundaryOrdinal`,
//! `conversationProviderThread`, `providerThreadPredatesBoundary`).
//!
//! A fresh run gets a new provider thread, and its session is released first (each session of
//! Claude and Codex holds one native conversation). A fresh run that a schedule sent is a side
//! conversation: the thread's own conversation goes on past it, so the next plain message
//! continues the newest provider thread that the schedule did not start.

use serde_json::Value;

use crate::store::{StoreResult, Tx};

/// `isScheduledFreshRun`: a fresh run whose message came from a scheduled task.
fn is_scheduled_fresh_run(run: &Value, user_items: &[Value]) -> bool {
    run["freshContext"] == true
        && user_items.iter().any(|item| {
            item["messageId"] == run["userMessageId"] && item["scheduledTaskId"].is_string()
        })
}

/// `cancelledBeforeStart`: cancelled before it ever ran (a restart continuation did run).
fn cancelled_before_start(run: &Value) -> bool {
    run["status"] == "cancelled"
        && run["startedAt"].is_null()
        && run["restartContinuationOfRunId"].is_null()
}

/// `contextBoundaryOrdinal`: the ordinal of the newest fresh run that started and that no
/// schedule sent. Runs before it never reach a provider again.
pub(crate) fn boundary(runs: &[Value], user_items: &[Value]) -> u64 {
    runs.iter()
        .filter(|run| {
            run["freshContext"] == true
                && run["status"] != "queued"
                && !cancelled_before_start(run)
                && !is_scheduled_fresh_run(run, user_items)
        })
        .filter_map(|run| run["ordinal"].as_u64())
        .max()
        .unwrap_or(0)
}

/// `providerThreadPredatesBoundary`.
fn predates(provider_thread: &Value, boundary: u64) -> bool {
    boundary > 0
        && provider_thread["firstRunOrdinal"]
            .as_u64()
            .is_none_or(|first| first < boundary)
}

/// `conversationProviderThread`: the provider thread a plain message continues. The active
/// one, unless a scheduled fresh run started it; then the newest root thread of this app
/// thread that ran a turn, is not older than the boundary, and that no such run started.
pub(crate) fn conversation_thread(
    tx: &Tx<'_>,
    thread_id: &str,
    active: Value,
) -> StoreResult<Value> {
    let runs = tx.entities(thread_id, "runs")?;
    if !runs.iter().any(|run| run["freshContext"] == true) {
        return Ok(active);
    }
    let user_items = tx.entities_where(thread_id, "turnItems", "type", "user_message")?;
    let scheduled = |pt: &Value| {
        runs.iter().any(|run| {
            run["ordinal"] == pt["firstRunOrdinal"] && is_scheduled_fresh_run(run, &user_items)
        })
    };
    if !scheduled(&active) {
        return Ok(active);
    }
    let boundary = boundary(&runs, &user_items);
    let chosen = tx
        .entities(thread_id, "providerThreads")?
        .into_iter()
        .filter(|pt| {
            pt["appThreadId"] == thread_id
                && pt["ownerNodeId"].is_null()
                && !pt["lastRunOrdinal"].is_null()
                && !predates(pt, boundary)
                && !scheduled(pt)
        })
        .max_by_key(|pt| pt["lastRunOrdinal"].as_u64().unwrap_or(0));
    Ok(chosen.unwrap_or(active))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn run(ordinal: u64, fresh: bool, status: &str, message: &str) -> Value {
        json!({"ordinal": ordinal, "freshContext": fresh, "status": status,
               "userMessageId": message, "startedAt": "2026-11-14T00:00:00.000Z"})
    }

    #[test]
    fn the_boundary_is_the_newest_started_fresh_run_no_schedule_sent() {
        let items = vec![
            json!({"messageId": "m3", "scheduledTaskId": "task:1"}),
            json!({"messageId": "m2"}),
        ];
        let runs = vec![
            run(1, false, "completed", "m1"),
            run(2, true, "completed", "m2"),
            run(3, true, "completed", "m3"),
            run(4, true, "queued", "m4"),
        ];
        assert_eq!(
            boundary(&runs, &items),
            2,
            "a scheduled and a queued fresh run move nothing"
        );
        let mut never_ran = run(5, true, "cancelled", "m5");
        never_ran["startedAt"] = Value::Null;
        assert_eq!(boundary(&[never_ran], &items), 0);
    }

    #[test]
    fn a_provider_thread_predates_the_boundary_when_it_started_before_it() {
        assert!(!predates(&json!({"firstRunOrdinal": 1}), 0), "no boundary");
        assert!(predates(&json!({"firstRunOrdinal": 1}), 2));
        assert!(predates(&json!({"firstRunOrdinal": null}), 2));
        assert!(!predates(&json!({"firstRunOrdinal": 2}), 2));
    }
}
