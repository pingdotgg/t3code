//! What a sidebar thread row says about its thread, as Conn derives it (`SidebarThreadRow.tsx`,
//! `presentThreadShell` in `packages/client-runtime/src/state/models.ts`): whether background
//! work parks the thread at idle, the time the row shows, and its linked-issue badge. Plain data
//! in and out, so the iPhone app can share it.

use conn_contract::{
    OrchestrationV2PendingBackgroundTask as BackgroundTask,
    OrchestrationV2ShellThreadStatus as Status,
};

use crate::ThreadShell;
use crate::thread::parse_iso8601_epoch_ms;

/// `backgroundWorkHoldsCompletion`: a subagent or background task holds the thread; a command or
/// monitor does so only when the agent marks it awaited (it is as often a dev server).
#[must_use]
pub fn background_work_holds_completion(tasks: &[BackgroundTask]) -> bool {
    tasks.iter().any(|task| match task {
        BackgroundTask::Subagent(_) | BackgroundTask::BackgroundTask(_) => true,
        BackgroundTask::Command(task) => task.awaited.is_some(),
        BackgroundTask::Monitor(task) => task.awaited.is_some(),
        BackgroundTask::Unknown(task) => task.awaited.is_some(),
    })
}

/// `shellRuntime`'s `parkAtIdle`: work the agent waits on holds the thread at `idle`, which the
/// row reads as Waiting, whatever the run itself says. A failed thread stays failed.
#[must_use]
pub fn parks_at_idle(thread: &ThreadShell) -> bool {
    thread.status != Status::Failed
        && thread
            .pending_background_tasks
            .as_ref()
            .and_then(Option::as_ref)
            .is_some_and(|tasks| background_work_holds_completion(tasks))
}

fn terminal(status: Status) -> bool {
    matches!(
        status,
        Status::Completed
            | Status::Interrupted
            | Status::Failed
            | Status::Cancelled
            | Status::RolledBack
    )
}

/// Keeps `candidate` when it is dated and later than the best so far (the first of equals wins).
fn later<'a>(latest: &mut Option<(&'a str, i64)>, candidate: Option<&'a str>) {
    let Some(candidate) = candidate.filter(|c| !c.is_empty()) else {
        return;
    };
    let Some(at) = parse_iso8601_epoch_ms(candidate) else {
        return;
    };
    if latest.is_none_or(|(_, best)| at > best) {
        *latest = Some((candidate, at));
    }
}

/// `resolveThreadActivityTimestamp`: the latest of the last user message and the latest run's
/// request, start and completion; the last update when none of them is dated. The row's time.
#[must_use]
pub fn thread_activity_timestamp(thread: &ThreadShell) -> &str {
    let mut latest: Option<(&str, i64)> = None;
    later(&mut latest, thread.latest_user_message_at.as_deref());
    // `presentThreadShell` gives a thread with no run no `latestRun`.
    if thread.latest_run_id.is_some() {
        later(
            &mut latest,
            thread
                .latest_run_requested_at
                .as_ref()
                .and_then(Option::as_deref),
        );
        later(
            &mut latest,
            thread
                .latest_run_started_at
                .as_ref()
                .and_then(Option::as_deref),
        );
        // An older server leaves the completion out: a finished thread completed when it updated.
        later(
            &mut latest,
            match &thread.latest_run_completed_at {
                Some(completed) => completed.as_deref(),
                None => (thread.status == Status::Idle || terminal(thread.status))
                    .then_some(thread.updated_at.as_str()),
            },
        );
    }
    latest.map_or(thread.updated_at.as_str(), |(at, _)| at)
}

/// The linked-issue badge of a card row: the issue icon and, for one issue its key, else the count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssueBadge {
    pub text: String,
    /// The badge's accessible label (`issueLabel`).
    pub label: String,
}

/// `issueBadge`: none for a thread with no linked issue.
#[must_use]
pub fn issue_badge(thread: &ThreadShell) -> Option<IssueBadge> {
    let issues = thread.issues.as_deref().unwrap_or_default();
    let first = issues.first()?;
    if let [_] = issues {
        return Some(IssueBadge {
            text: first.display_key.clone(),
            label: format!("Issue {}: {}", first.display_key, first.title),
        });
    }
    let count = issues.len();
    Some(IssueBadge {
        text: count.to_string(),
        label: format!("{count} linked issues"),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_threads::thread;

    fn with_tasks(kinds: &[(&str, bool)]) -> ThreadShell {
        let tasks: Vec<_> = kinds
            .iter()
            .enumerate()
            .map(|(i, (kind, awaited))| {
                let mut task = json!({ "kind": kind, "taskId": format!("t{i}") });
                if *awaited {
                    task["awaited"] = json!(true);
                }
                task
            })
            .collect();
        thread("t", "p", |value| {
            value["status"] = json!("completed");
            value["pendingBackgroundTasks"] = json!(tasks);
        })
    }

    #[test]
    fn a_subagent_or_background_task_holds_the_thread_at_idle() {
        assert!(parks_at_idle(&with_tasks(&[("subagent", false)])));
        assert!(parks_at_idle(&with_tasks(&[("background_task", false)])));
    }

    #[test]
    fn a_command_or_monitor_holds_it_only_when_awaited() {
        assert!(!parks_at_idle(&with_tasks(&[
            ("command", false),
            ("monitor", false)
        ])));
        assert!(parks_at_idle(&with_tasks(&[("command", true)])));
        assert!(parks_at_idle(&with_tasks(&[("monitor", true)])));
    }

    #[test]
    fn no_background_work_or_a_failed_thread_does_not_park() {
        assert!(!parks_at_idle(&thread("t", "p", |_| {})));
        let failed = thread("t", "p", |value| {
            value["status"] = json!("failed");
            value["pendingBackgroundTasks"] = json!([{ "kind": "subagent", "taskId": "s" }]);
        });
        assert!(!parks_at_idle(&failed));
    }

    #[test]
    fn the_row_time_is_the_latest_of_the_message_and_the_run() {
        let thread = thread("t", "p", |value| {
            value["status"] = json!("completed");
            value["latestRunId"] = json!("run-1");
            value["latestUserMessageAt"] = json!("2026-11-23T10:00:00.000Z");
            value["latestRunRequestedAt"] = json!("2026-11-23T10:01:00.000Z");
            value["latestRunStartedAt"] = json!("2026-11-23T10:02:00.000Z");
            value["latestRunCompletedAt"] = json!("2026-11-23T10:30:00.000Z");
            value["updatedAt"] = json!("2026-11-23T12:00:00.000Z");
        });
        assert_eq!(
            thread_activity_timestamp(&thread),
            "2026-11-23T10:30:00.000Z"
        );
    }

    #[test]
    fn a_later_user_message_beats_an_older_run() {
        let thread = thread("t", "p", |value| {
            value["latestRunId"] = json!("run-1");
            value["latestRunCompletedAt"] = json!("2026-11-23T10:30:00.000Z");
            value["latestUserMessageAt"] = json!("2026-11-23T11:00:00.000Z");
        });
        assert_eq!(
            thread_activity_timestamp(&thread),
            "2026-11-23T11:00:00.000Z"
        );
    }

    #[test]
    fn a_thread_with_nothing_dated_shows_when_it_was_updated() {
        let thread = thread("t", "p", |value| {
            value["updatedAt"] = json!("2026-11-20T08:00:00.000Z");
        });
        assert_eq!(
            thread_activity_timestamp(&thread),
            "2026-11-20T08:00:00.000Z"
        );
    }

    #[test]
    fn a_run_is_ignored_when_the_thread_has_none() {
        let thread = thread("t", "p", |value| {
            value["latestRunId"] = json!(null);
            value["latestRunCompletedAt"] = json!("2026-11-23T10:30:00.000Z");
            value["updatedAt"] = json!("2026-11-20T08:00:00.000Z");
        });
        assert_eq!(
            thread_activity_timestamp(&thread),
            "2026-11-20T08:00:00.000Z"
        );
    }

    #[test]
    fn an_older_server_without_a_completion_dates_a_finished_run_by_its_update() {
        let finished = thread("t", "p", |value| {
            value["status"] = json!("completed");
            value["latestRunId"] = json!("run-1");
            value["updatedAt"] = json!("2026-11-23T09:00:00.000Z");
        });
        assert_eq!(
            thread_activity_timestamp(&finished),
            "2026-11-23T09:00:00.000Z"
        );
        let running = thread("t", "p", |value| {
            value["status"] = json!("running");
            value["latestRunId"] = json!("run-1");
            value["latestRunStartedAt"] = json!("2026-11-23T08:00:00.000Z");
            value["updatedAt"] = json!("2026-11-23T09:00:00.000Z");
        });
        assert_eq!(
            thread_activity_timestamp(&running),
            "2026-11-23T08:00:00.000Z"
        );
    }

    fn issue(key: &str, title: &str) -> serde_json::Value {
        json!({
            "tracker": "github", "host": "github.com", "scope": "nckrtl/conn", "key": key,
            "projectId": "p", "url": "https://github.com/nckrtl/conn/issues/1", "source": "agent",
            "linkedAt": "2026-11-23T10:00:00.000Z", "displayKey": format!("#{key}"), "title": title
        })
    }

    #[test]
    fn the_issue_badge_names_one_issue_and_counts_several() {
        assert!(issue_badge(&thread("t", "p", |_| {})).is_none());
        let one = thread("t", "p", |v| {
            v["issues"] = json!([issue("7", "Fix the thing")])
        });
        assert_eq!(
            issue_badge(&one),
            Some(IssueBadge {
                text: "#7".to_owned(),
                label: "Issue #7: Fix the thing".to_owned()
            })
        );
        let three = thread("t", "p", |v| {
            v["issues"] = json!([issue("1", "a"), issue("2", "b"), issue("3", "c")]);
        });
        assert_eq!(
            issue_badge(&three),
            Some(IssueBadge {
                text: "3".to_owned(),
                label: "3 linked issues".to_owned()
            })
        );
    }
}
