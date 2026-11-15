//! The notice a provider's wake shows (`backgroundWorkNotification` and `reportLabel` in
//! `packages/provider-core/src/server/notification.ts`): what background work ended, as
//! `OrchestrationV2Notification` (`source`, `outcome`, `summary`). Claude and Codex both use it.

use serde_json::{Value, json};

/// `LABEL_MAX_LENGTH`, in UTF-16 code units as JavaScript counts.
const LABEL_MAX_LENGTH: usize = 80;

/// `BackgroundWork["kind"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkKind {
    Subagent,
    Command,
    Monitor,
    BackgroundTask,
}

impl WorkKind {
    fn noun(self) -> (&'static str, &'static str) {
        match self {
            Self::Subagent => ("Subagent", "subagents"),
            Self::Command => ("Command", "commands"),
            Self::Monitor => ("Monitor", "monitors"),
            Self::BackgroundTask => ("Background task", "background tasks"),
        }
    }

    fn source(self) -> &'static str {
        match self {
            Self::Subagent => "subagent",
            Self::Command => "command",
            Self::Monitor => "monitor",
            Self::BackgroundTask => "background_task",
        }
    }
}

/// `BackgroundWorkReport`.
#[derive(Clone, Debug, PartialEq)]
pub struct Work {
    pub kind: WorkKind,
    pub label: Option<String>,
    /// `completed`, `failed`, `cancelled`, `updated` or `unknown`.
    pub outcome: &'static str,
    /// A subagent's child thread.
    pub child_thread_id: Option<String>,
    /// A command's exit code.
    pub exit_code: Option<i64>,
}

/// `reportLabel`: the first line, at most 80 UTF-16 units, cut with an ellipsis.
pub fn report_label(label: Option<&str>) -> Option<String> {
    let first = label?.trim().split('\n').next()?.trim();
    if first.is_empty() {
        return None;
    }
    let units: usize = first.chars().map(char::len_utf16).sum();
    if units <= LABEL_MAX_LENGTH {
        return Some(first.to_string());
    }
    // JavaScript slices at 79 units and steps back one when that splits a surrogate pair.
    let mut taken = String::new();
    let mut used = 0;
    for c in first.chars() {
        let width = c.len_utf16();
        if used + width > LABEL_MAX_LENGTH - 1 {
            break;
        }
        used += width;
        taken.push(c);
    }
    Some(format!("{taken}…"))
}

fn outcome_verb(kind: WorkKind, outcome: &str) -> &'static str {
    match outcome {
        "failed" => "failed",
        "cancelled" => "was stopped",
        "updated" if kind == WorkKind::Monitor => "reported new output",
        "updated" => "updated",
        _ => "finished",
    }
}

fn combined_outcome(reports: &[Work]) -> &'static str {
    let has = |o: &str| reports.iter().any(|r| r.outcome == o);
    if has("failed") {
        "failed"
    } else if has("cancelled") {
        "cancelled"
    } else if !reports.is_empty() && reports.iter().all(|r| r.outcome == "completed") {
        "completed"
    } else if has("updated") {
        "updated"
    } else {
        "unknown"
    }
}

/// `exitSuffix`.
fn exit_suffix(report: &Work) -> String {
    match (report.kind, report.exit_code) {
        (WorkKind::Command, Some(code)) => format!(" (exit {code})"),
        _ => String::new(),
    }
}

/// `namedReport`.
fn named(report: &Work, capitalize: bool) -> String {
    let noun = report.kind.noun().0;
    let noun = if capitalize {
        noun.to_string()
    } else {
        noun.to_lowercase()
    };
    let named = match report_label(report.label.as_deref()) {
        Some(label) => format!("{noun} \"{label}\""),
        None => noun,
    };
    format!("{named}{}", exit_suffix(report))
}

fn join_names(names: &[String]) -> String {
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => names.join(""),
    }
}

/// `reportsSummary`.
fn summary(reports: &[Work], outcome: &str) -> String {
    let [first, rest @ ..] = reports else {
        return String::new();
    };
    if rest.is_empty() {
        let noun = first.kind.noun().0;
        let label = report_label(first.label.as_deref())
            .map(|l| format!(" \"{l}\""))
            .unwrap_or_default();
        return format!(
            "{noun}{label} {}{}",
            outcome_verb(first.kind, first.outcome),
            exit_suffix(first)
        );
    }
    let verb = match outcome {
        "failed" => "failed",
        "cancelled" => "were stopped",
        "updated" => "updated",
        _ => "finished",
    };
    if reports.len() > 3
        || reports
            .iter()
            .all(|r| report_label(r.label.as_deref()).is_none())
    {
        let same = reports.iter().all(|r| r.kind == first.kind);
        let noun = if same {
            first.kind.noun().1
        } else {
            "background tasks"
        };
        return format!("{} {noun} {verb}", reports.len());
    }
    let names: Vec<String> = reports
        .iter()
        .enumerate()
        .map(|(i, r)| named(r, i == 0))
        .collect();
    format!("{} {verb}", join_names(&names))
}

/// `reportsSource`.
fn source(reports: &[Work]) -> Value {
    let [first, rest @ ..] = reports else {
        return json!({"kind": "background_task"});
    };
    if rest.iter().any(|r| r.kind != first.kind) {
        return json!({"kind": "background_task"});
    }
    match (&first.kind, &first.child_thread_id) {
        (WorkKind::Subagent, Some(child)) if rest.is_empty() => {
            json!({"kind": "subagent", "childThreadId": child})
        }
        (kind, _) => json!({"kind": kind.source()}),
    }
}

/// `backgroundWorkNotification`: `None` with no report.
pub fn background_work_notification(reports: &[Work]) -> Option<Value> {
    if reports.is_empty() {
        return None;
    }
    let outcome = combined_outcome(reports);
    Some(json!({
        "source": source(reports),
        "outcome": outcome,
        "summary": summary(reports, outcome),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(kind: WorkKind, label: Option<&str>, outcome: &'static str) -> Work {
        Work {
            kind,
            label: label.map(str::to_owned),
            outcome,
            child_thread_id: None,
            exit_code: None,
        }
    }

    #[test]
    fn commands_name_their_exit_code() {
        let mut failed = work(WorkKind::Command, Some("npm test\nmore"), "failed");
        failed.exit_code = Some(2);
        assert_eq!(
            background_work_notification(std::slice::from_ref(&failed)),
            Some(json!({"source": {"kind": "command"}, "outcome": "failed",
                "summary": "Command \"npm test\" failed (exit 2)"}))
        );
        let mut ok = work(WorkKind::Command, Some("make"), "completed");
        ok.exit_code = Some(0);
        assert_eq!(
            background_work_notification(&[ok, failed]).map(|n| n["summary"].clone()),
            Some(json!(
                "Command \"make\" (exit 0) and command \"npm test\" (exit 2) failed"
            ))
        );
    }

    #[test]
    fn a_subagent_names_its_child_thread() {
        let mut sub = work(WorkKind::Subagent, Some("Find the bug"), "completed");
        sub.child_thread_id = Some("thread:child".into());
        assert_eq!(
            background_work_notification(&[sub]),
            Some(
                json!({"source": {"kind": "subagent", "childThreadId": "thread:child"},
                "outcome": "completed", "summary": "Subagent \"Find the bug\" finished"})
            )
        );
        assert_eq!(background_work_notification(&[]), None);
    }

    #[test]
    fn labels_are_cut_as_javascript_counts() {
        let long = "x".repeat(100);
        assert_eq!(
            report_label(Some(&long)),
            Some(format!("{}…", "x".repeat(79)))
        );
        assert_eq!(report_label(Some("  \n")), None);
    }
}
