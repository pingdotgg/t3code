//! What a wake reports: the background work whose end woke Claude, as `ClaudeAdapterV2.ts`
//! records it (`recordWakeReport`, `opaqueTaskWakeReport`, `wakeReportsByNativeThread`) and
//! turns it into the continuation's notice (`backgroundWorkNotification` in
//! `packages/provider-core/src/server/notification.ts`). The continuation message's text is the
//! last `task_notification` summary (`claudeWakeBufferDetail`).
//!
//! Bounded: at most [`REPORT_CAP`] reports wait for a wake.

use std::collections::VecDeque;

use conn_provider_support::notification;
use serde_json::{Value, json};

/// Reports held for a wake (one per task).
const REPORT_CAP: usize = 64;

/// `BackgroundWork["kind"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Subagent,
    Command,
    Monitor,
    BackgroundTask,
}

impl Kind {
    pub(crate) fn from_task_kind(kind: Option<&str>) -> Self {
        match kind {
            Some("subagent") => Self::Subagent,
            Some("monitor") => Self::Monitor,
            Some("background_task") => Self::BackgroundTask,
            _ => Self::Command,
        }
    }

    fn work_kind(self) -> notification::WorkKind {
        match self {
            Self::Subagent => notification::WorkKind::Subagent,
            Self::Command => notification::WorkKind::Command,
            Self::Monitor => notification::WorkKind::Monitor,
            Self::BackgroundTask => notification::WorkKind::BackgroundTask,
        }
    }
}

/// `BackgroundWorkReport`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Report {
    pub kind: Kind,
    pub label: Option<String>,
    /// `completed`, `failed`, `cancelled`, `updated` or `unknown`.
    pub outcome: &'static str,
    pub child_thread_id: Option<String>,
}

/// `claudeTaskOutcome`.
pub(crate) fn task_outcome(status: Option<&str>) -> &'static str {
    match status {
        Some("completed") => "completed",
        Some("stopped") => "cancelled",
        _ => "failed",
    }
}

/// `CLAUDE_SCHEDULED_WAKEUP_EARLY_FIRE_MARGIN_MS`.
const EARLY_FIRE_MARGIN_MS: u64 = 120_000;

/// `CLAUDE_SCHEDULED_WAKEUP_TASK`: one stable entry per thread for Claude's pending
/// `ScheduleWakeup`.
pub(crate) fn scheduled_wakeup_task() -> Value {
    json!({
        "taskId": "claude-scheduled-wakeup",
        "kind": "background_task",
        "description": "Scheduled wakeup",
    })
}

/// `trackClaudeScheduledWakeup`: Claude keeps one pending wakeup per session; its tool
/// result is the only sign that Claude will start a turn by itself.
#[derive(Debug, Default)]
pub(crate) struct Scheduled {
    /// `ScheduleWakeup` calls with no result yet.
    calls: VecDeque<String>,
    /// When the pending wakeup is due (epoch ms).
    pub due: Option<u64>,
    /// The running turn may be the wakeup, fired early.
    possible_early: bool,
}

impl Scheduled {
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.calls.len()
    }

    pub(crate) fn clear(&mut self) {
        self.due = None;
        self.possible_early = false;
    }

    /// A turn started (`system` `init`), `idle` when no turn of ours runs.
    pub(crate) fn turn_started(&mut self, now: u64, idle: bool) {
        let Some(due) = self.due else {
            return;
        };
        if now >= due {
            self.due = None;
        } else if idle && now >= due.saturating_sub(EARLY_FIRE_MARGIN_MS) {
            self.possible_early = true;
        }
    }

    /// A result: an early turn was the wakeup unless a task notification started it.
    pub(crate) fn result(&mut self, from_task_notification: bool) {
        if std::mem::take(&mut self.possible_early) && !from_task_notification {
            self.due = None;
        }
    }

    pub(crate) fn call(&mut self, id: &str) {
        if self.calls.len() >= REPORT_CAP {
            self.calls.pop_front();
        }
        self.calls.push_back(id.to_string());
    }

    /// Tool results: the `ScheduleWakeup` ones set or clear the wakeup.
    pub(crate) fn results(&mut self, ids: &[&str], tool_use_result: Option<&Value>) {
        let mut returned = 0;
        for id in ids {
            let before = self.calls.len();
            self.calls.retain(|c| c != id);
            returned += before - self.calls.len();
        }
        if returned == 0 {
            return;
        }
        // stop:true reports scheduledFor 0; a failed call clears too.
        let due = (returned == 1)
            .then(|| tool_use_result?.get("scheduledFor")?.as_f64())
            .flatten()
            .filter(|d| d.is_finite() && *d > 0.0);
        self.possible_early = false;
        self.due = due.map(|d| d as u64);
    }
}

#[derive(Debug, Default)]
pub(crate) struct Wakes {
    /// Task id, report, and the user turn it was recorded in.
    reports: VecDeque<(String, Report, u32)>,
    /// User turns started on this thread (`userTurns`).
    user_turns: u32,
    /// The last non-empty `task_notification` summary since the last wake.
    pub detail: Option<String>,
    /// Nested subagents (`spawn_depth` > 1): their end notifies their owner, not the root.
    nested: VecDeque<String>,
    /// Root subagents that run in the background (`backgroundedSubagentTaskIds`).
    backgrounded: VecDeque<String>,
}

fn add_id(set: &mut VecDeque<String>, id: &str) {
    if set.iter().any(|t| t == id) {
        return;
    }
    if set.len() >= REPORT_CAP {
        set.pop_front();
    }
    set.push_back(id.to_string());
}

impl Wakes {
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.reports.len() + self.nested.len() + self.backgrounded.len()
    }

    pub(crate) fn record(&mut self, task_id: &str, report: Report) {
        self.reports.retain(|(t, _, _)| t != task_id);
        if self.reports.len() >= REPORT_CAP {
            self.reports.pop_front();
        }
        self.reports
            .push_back((task_id.to_string(), report, self.user_turns));
    }

    pub(crate) fn mark_nested(&mut self, task_id: &str) {
        add_id(&mut self.nested, task_id);
    }

    pub(crate) fn mark_backgrounded(&mut self, task_id: &str) {
        add_id(&mut self.backgrounded, task_id);
    }

    pub(crate) fn unmark_backgrounded(&mut self, task_id: &str) {
        self.backgrounded.retain(|t| t != task_id);
    }

    pub(crate) fn is_backgrounded(&self, task_id: &str) -> bool {
        self.backgrounded.iter().any(|t| t == task_id)
    }

    pub(crate) fn is_nested(&self, task_id: &str) -> bool {
        self.nested.iter().any(|t| t == task_id)
    }

    #[cfg(test)]
    pub(crate) fn has_reports(&self) -> bool {
        !self.reports.is_empty()
    }

    /// `startUserTurnForWakeReports`: reports live through one user turn.
    pub(crate) fn start_user_turn(&mut self) {
        self.user_turns = self.user_turns.saturating_add(1);
        let turn = self.user_turns;
        self.reports.retain(|(_, _, t)| t.saturating_add(1) >= turn);
        self.detail = None;
    }

    /// `takeWakeReports`.
    pub(crate) fn take(&mut self) -> Vec<Report> {
        self.reports.drain(..).map(|(_, r, _)| r).collect()
    }

    pub(crate) fn clear(&mut self) {
        self.reports.clear();
        self.detail = None;
    }
}

/// `backgroundWorkNotification`: `None` with no report.
pub(crate) fn notification(reports: &[Report]) -> Option<Value> {
    let work: Vec<notification::Work> = reports
        .iter()
        .map(|r| notification::Work {
            kind: r.kind.work_kind(),
            label: r.label.clone(),
            outcome: r.outcome,
            child_thread_id: r.child_thread_id.clone(),
            exit_code: None,
        })
        .collect();
    notification::background_work_notification(&work)
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_provider_support::notification::report_label;

    fn report(kind: Kind, label: Option<&str>, outcome: &'static str) -> Report {
        Report {
            kind,
            label: label.map(str::to_string),
            outcome,
            child_thread_id: None,
        }
    }

    #[test]
    fn one_report_names_its_work() {
        let mut sub = report(
            Kind::Subagent,
            Some("Background subagent test"),
            "completed",
        );
        sub.child_thread_id = Some("thread:subagent:1".into());
        assert_eq!(
            notification(&[sub]),
            Some(json!({
                "source": {"kind": "subagent", "childThreadId": "thread:subagent:1"},
                "outcome": "completed",
                "summary": "Subagent \"Background subagent test\" finished",
            }))
        );
        assert_eq!(
            notification(&[report(Kind::Monitor, None, "updated")]).map(|n| n["summary"].clone()),
            Some(json!("Monitor reported new output"))
        );
        assert_eq!(notification(&[]), None);
    }

    #[test]
    fn several_reports_join_or_count() {
        let two = [
            report(Kind::Command, Some("a"), "completed"),
            report(Kind::Monitor, Some("b"), "failed"),
        ];
        assert_eq!(
            notification(&two),
            Some(json!({
                "source": {"kind": "background_task"},
                "outcome": "failed",
                "summary": "Command \"a\" and monitor \"b\" failed",
            }))
        );
        let unnamed = [
            report(Kind::Command, None, "completed"),
            report(Kind::Command, None, "completed"),
        ];
        assert_eq!(
            notification(&unnamed).map(|n| n["summary"].clone()),
            Some(json!("2 commands finished"))
        );
    }

    #[test]
    fn labels_keep_the_first_line_and_80_units() {
        assert_eq!(report_label(Some("  one\ntwo")), Some("one".into()));
        assert_eq!(report_label(Some(" \n")), None);
        let long = "x".repeat(90);
        assert_eq!(
            report_label(Some(&long)),
            Some(format!("{}…", "x".repeat(79)))
        );
        // A surrogate pair at the cut is not split.
        let emoji = format!("{}😀tail{}", "x".repeat(78), "y".repeat(10));
        assert_eq!(
            report_label(Some(&emoji)),
            Some(format!("{}…", "x".repeat(78)))
        );
    }

    #[test]
    fn reports_live_through_one_user_turn() {
        let mut wakes = Wakes::default();
        wakes.record("a", report(Kind::Command, None, "completed"));
        wakes.start_user_turn();
        assert!(wakes.has_reports());
        wakes.start_user_turn();
        assert!(!wakes.has_reports());
        for i in 0..100 {
            wakes.record(&i.to_string(), report(Kind::Command, None, "completed"));
        }
        assert_eq!(wakes.len(), REPORT_CAP);
    }
}
