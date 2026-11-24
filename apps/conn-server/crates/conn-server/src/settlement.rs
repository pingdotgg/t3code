//! Automatic thread settlement (`ThreadSettlementService.ts`): a sweep every minute, after a
//! settings change and after a settlement settles the threads the user configured to settle
//! after days without activity, and the delegates whose parent is gone, archived or settled.
//! Each decision reads the settings again and sends `thread.auto-settle` with the thread's
//! `updatedAt` as its snapshot, so the engine refuses it when the thread changed since.
//!
//! Not built: settling on a pull request found by a branch lookup on the host (the second half
//! of T3's sweep). A merged or closed pull request already stored on the thread's links counts.

use std::sync::Arc;
use std::time::Duration;

use conn_engine::{Engine, SqliteEngine};
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

use crate::environment::Environment;
use crate::settings::generated::{
    DEFAULT_AUTO_SETTLE_AFTER_DAYS, DEFAULT_AUTO_SETTLE_KEEP_PULL_REQUESTS,
    DEFAULT_AUTO_SETTLE_ON_MERGE,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
/// `QUEUED_TURN_START_GRACE_MS`.
const QUEUED_TURN_START_GRACE_MS: i64 = 2 * 60 * 1_000;
/// `Schedule.spaced("1 minute")`.
const SWEEP_EVERY: Duration = Duration::from_secs(60);
/// `isPullRequestWatchTask`.
pub(crate) const PULL_REQUEST_WATCH_TASK_ID: &str = "pull-request-watch:";

fn ms(value: &Value) -> Option<i64> {
    value.as_str().and_then(conn_support::time::millis_from_iso)
}

/// A project's automatic settlement settings (`resolveProjectSettings`): the project's override
/// when it has the key (a `null` day count included), else the environment's, else T3's default.
/// The day count is a number, so it can be fractional (`SidebarAutoSettleAfterDays`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoSettle {
    pub after_days: Option<f64>,
    pub on_merge: bool,
    pub keep_pull_requests: bool,
}

impl AutoSettle {
    pub fn for_project(settings: &Map<String, Value>, project_id: &str) -> Self {
        let project = settings
            .get("projectSettingsOverrides")
            .and_then(|overrides| overrides.get(project_id));
        let value = |key: &str| {
            project
                .and_then(|p| p.get(key))
                .or_else(|| settings.get(key))
        };
        Self {
            after_days: match value("sidebarAutoSettleAfterDays") {
                Some(Value::Null) => None,
                Some(days) => days.as_f64(),
                None => DEFAULT_AUTO_SETTLE_AFTER_DAYS,
            },
            on_merge: value("sidebarAutoSettleOnMerge")
                .and_then(Value::as_bool)
                .unwrap_or(DEFAULT_AUTO_SETTLE_ON_MERGE),
            keep_pull_requests: value("sidebarAutoSettleKeepPullRequests")
                .and_then(Value::as_bool)
                .unwrap_or(DEFAULT_AUTO_SETTLE_KEEP_PULL_REQUESTS),
        }
    }
}

/// `autoSettlementConfigured`: the environment or a project settles on merge or after days.
fn auto_settlement_configured(settings: &Map<String, Value>) -> bool {
    let global = AutoSettle::for_project(settings, "");
    global.on_merge
        || global.after_days.is_some()
        || settings
            .get("projectSettingsOverrides")
            .and_then(Value::as_object)
            .is_some_and(|overrides| {
                overrides.values().any(|entry| {
                    entry["sidebarAutoSettleOnMerge"] == true
                        || entry
                            .get("sidebarAutoSettleAfterDays")
                            .is_some_and(|days| !days.is_null())
                })
            })
}

/// A pull request's end, as a settlement decision reads it (`SettlementPullRequest`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementPullRequest {
    pub state: String,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
}

/// `isSnoozed`: as the client's `effectiveSnoozed`, so agents and the sidebar agree.
pub fn is_snoozed(thread: &Value, now: i64) -> bool {
    if ms(&thread["snoozedUntil"]).is_none_or(|until| until <= now) {
        return false;
    }
    if thread["pendingGuestMessageCount"].as_u64().unwrap_or(0) > 0 {
        return false;
    }
    let snoozed_at = ms(&thread["snoozedAt"]);
    let request = &thread["pendingRuntimeRequest"];
    if !request.is_null()
        && (request["kind"] != "user_input"
            || snoozed_at.is_none()
            || ms(&request["createdAt"]) > snoozed_at)
    {
        return false;
    }
    let completed = ms(&thread["latestRunCompletedAt"]);
    let woke_on_error = thread["status"] == "failed"
        && (snoozed_at.is_none() || completed.zip(snoozed_at).is_some_and(|(c, s)| c > s));
    !woke_on_error
}

/// `threadHasQueuedTurnStart`: a user message sent moments ago whose run has not shown yet.
fn has_queued_turn_start(thread: &Value, now: i64) -> bool {
    let Some(message_at) = ms(&thread["latestUserMessageAt"]) else {
        return false;
    };
    if thread["status"] == "failed" || (now - message_at).abs() > QUEUED_TURN_START_GRACE_MS {
        return false;
    }
    if thread["latestRunId"].is_null() {
        return true;
    }
    [
        "latestRunRequestedAt",
        "latestRunStartedAt",
        "latestRunCompletedAt",
    ]
    .iter()
    .all(|field| ms(&thread[*field]).is_none_or(|at| at < message_at))
}

/// `isAutoSettlementCandidate`.
pub fn is_auto_settlement_candidate(thread: &Value, now: i64) -> bool {
    let set = |field: &str| !thread[field].is_null();
    if set("archivedAt") || set("settledOverride") || set("pinnedAt") || set("autoSettleDisabledAt")
    {
        return false;
    }
    if set("pendingRuntimeRequest") || thread["pendingGuestMessageCount"].as_u64().unwrap_or(0) > 0
    {
        return false;
    }
    if set("activityRunStatus") {
        return false;
    }
    let tasks = thread["pendingBackgroundTasks"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    // `backgroundWorkHoldsCompletion`; a pull request watch keeps the thread too.
    if tasks.iter().any(|task| {
        task["awaited"] == true
            || matches!(task["kind"].as_str(), Some("subagent" | "background_task"))
            || task["taskId"]
                .as_str()
                .is_some_and(|id| id.starts_with(PULL_REQUEST_WATCH_TASK_ID))
    }) {
        return false;
    }
    !has_queued_turn_start(thread, now) && !is_snoozed(thread, now)
}

/// `threadActivityAtMs`.
fn activity_at(thread: &Value) -> Option<i64> {
    [
        "latestUserMessageAt",
        "latestRunRequestedAt",
        "latestRunStartedAt",
        "latestRunCompletedAt",
    ]
    .iter()
    .filter_map(|field| ms(&thread[*field]))
    .max()
    .or_else(|| ms(&thread["createdAt"]))
}

/// `linkTerminalAtMs`: when a linked pull request merged or closed.
fn link_terminal_at(link: &Value) -> i64 {
    let snapshot = &link["snapshot"];
    let at = if snapshot["state"] == "merged" {
        &snapshot["mergedAt"]
    } else {
        &snapshot["closedAt"]
    };
    ms(at).unwrap_or(i64::MIN)
}

/// `settlementPullRequestLinks`: visible links, without those added after their pull request
/// already ended (they record finished work, not an outcome the thread waits on).
fn settlement_links(thread: &Value) -> Vec<&Value> {
    thread["pullRequests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|link| link["source"] != "stack-dismissed")
        .filter(|link| {
            let snapshot = &link["snapshot"];
            if snapshot.is_null() || snapshot["state"] == "open" {
                return true;
            }
            ms(&link["linkedAt"]).is_none_or(|linked| link_terminal_at(link) >= linked)
        })
        .collect()
}

/// `pullRequestSettles`: a merge (when allowed) or a close after the user's last action.
fn pull_request_settles(
    thread: &Value,
    pull_request: &SettlementPullRequest,
    on_merge: bool,
) -> bool {
    let terminal_at = match pull_request.state.as_str() {
        "merged" if on_merge => pull_request.merged_at.as_deref(),
        "closed" => pull_request.closed_at.as_deref(),
        _ => return false,
    };
    let Some(at) = terminal_at.and_then(conn_support::time::millis_from_iso) else {
        return false;
    };
    let anchor = [
        ms(&thread["createdAt"]),
        ms(&thread["latestUserAuthoredMessageAt"]),
    ]
    .into_iter()
    .flatten()
    .max();
    anchor.is_some_and(|anchor| at >= anchor)
}

/// `resolveAutoSettlementAt`: when the thread settles automatically (its activity time, or the
/// start of its inactivity), or `None` when it does not settle now.
pub fn resolve_auto_settlement_at(
    thread: &Value,
    pull_request: Option<SettlementPullRequest>,
    now: i64,
    settings: AutoSettle,
) -> Option<i64> {
    let links = settlement_links(thread);
    if links.iter().any(|link| link["snapshot"].is_null()) {
        return None;
    }
    // An open link means its pull request is not finished: only inactivity can settle.
    let has_open_link = links.iter().any(|link| link["snapshot"]["state"] == "open");
    let pull_request = if has_open_link {
        None
    } else if let Some(latest) = links.iter().copied().reduce(|current, candidate| {
        if link_terminal_at(candidate) > link_terminal_at(current) {
            candidate
        } else {
            current
        }
    }) {
        let snapshot = &latest["snapshot"];
        Some(SettlementPullRequest {
            state: snapshot["state"].as_str().unwrap_or_default().to_owned(),
            merged_at: snapshot["mergedAt"].as_str().map(str::to_owned),
            closed_at: snapshot["closedAt"].as_str().map(str::to_owned),
        })
    } else {
        pull_request
    };
    if !is_auto_settlement_candidate(thread, now) {
        return None;
    }
    let activity = activity_at(thread)?;
    if let Some(pull_request) = &pull_request
        && pull_request_settles(thread, pull_request, settings.on_merge)
    {
        return Some(activity);
    }
    let has_pull_request = has_open_link
        || pull_request.is_some()
        || !thread["linkedPullRequest"].is_null()
        || !thread["branchPullRequest"].is_null();
    if settings.keep_pull_requests && has_pull_request {
        return None;
    }
    let days = settings.after_days?;
    let timer_wake = ms(&thread["snoozedUntil"]).filter(|until| *until <= now);
    let inactive_since = [Some(activity), ms(&thread["lastSnoozeWakeAt"]), timer_wake]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or(activity);
    // As T3, in floating point: `inactivityAtMs < nowMs - autoSettleAfterDays * DAY_MS`.
    let settles = (inactive_since as f64) < now as f64 - days * DAY_MS as f64;
    settles.then_some(inactive_since)
}

/// The `thread.auto-settle` for one candidate under `settings` at `now`, or `None` when it
/// does not settle now. A delegate settles with its parent (the engine offers it only once the
/// parent is done). `snapshotAt` is the thread's `updatedAt` as read, which the engine checks.
pub fn decide(thread: &Value, settings: &Map<String, Value>, now: i64) -> Option<Value> {
    let id = thread["id"].as_str()?;
    let mut command = json!({
        "type": "thread.auto-settle",
        "commandId": format!("server:auto-settle:{id}:{}", conn_support::uuid_v4()),
        "threadId": id,
        "snapshotAt": thread["updatedAt"],
    });
    if thread["lineage"]["relationshipToParent"] != "subagent" {
        let project = thread["projectId"].as_str().unwrap_or_default();
        let at = resolve_auto_settlement_at(
            thread,
            None,
            now,
            AutoSettle::for_project(settings, project),
        )?;
        command["settledAt"] = json!(conn_support::time::iso_from_millis(at));
    }
    Some(command)
}

/// One sweep over `candidates`: the sweep's own read skips the threads that do not settle,
/// and each one that does is decided again on the settings and time read right before its
/// command, as T3's `settleThread` does, since `thread.auto-settle` does not read settings.
pub(crate) async fn sweep_with<F: std::future::Future<Output = ()>>(
    candidates: &[Value],
    settings: impl Fn() -> Map<String, Value>,
    now: impl Fn() -> i64,
    mut dispatch: impl FnMut(Value) -> F,
) {
    let (read, read_at) = (settings(), now());
    let configured = auto_settlement_configured(&read);
    for thread in candidates {
        if !(configured || thread["lineage"]["relationshipToParent"] == "subagent")
            || !is_auto_settlement_candidate(thread, read_at)
            || decide(thread, &read, read_at).is_none()
        {
            continue;
        }
        if let Some(command) = decide(thread, &settings(), now()) {
            dispatch(command).await;
        }
    }
}

/// One sweep on the engine's clock. A refused command (the thread changed since it was read)
/// is not an error.
pub async fn sweep(engine: &SqliteEngine, environment: &Environment) {
    let candidates = match engine.settlement_candidates(None).await {
        Ok(candidates) => candidates,
        Err(error) => {
            eprintln!("automatic thread settlement: {error}");
            return;
        }
    };
    let now = || i64::try_from(engine.now_millis()).unwrap_or(i64::MAX);
    sweep_with(
        &candidates,
        || environment.settings.raw(),
        now,
        |command| async move {
            let Ok(command) = conn_contract::from_json(command) else {
                return;
            };
            if let Err(conn_engine::EngineError::Internal(error)) = engine.dispatch(command).await {
                eprintln!("automatic thread settlement: {error}");
            }
        },
    )
    .await;
}

/// Sweeps at start, every minute, after a settings change and when `wake` is notified (a
/// settlement may free a delegate). Time is the engine's clock.
pub fn start(
    engine: Arc<SqliteEngine>,
    environment: Arc<Environment>,
    wake: Arc<Notify>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut changes = environment.settings.subscribe();
        loop {
            sweep(&engine, &environment).await;
            tokio::select! {
                () = tokio::time::sleep(SWEEP_EVERY) => {}
                changed = changes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                () = wake.notified() => {}
            }
        }
    })
}

#[cfg(test)]
mod tests;
