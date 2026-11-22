//! Task detail: status text and tones, the subtask lead, the Agents tab and usage text.
//!
//! Port of `apps/web/src/orbit/tasks/taskDetail.logic.ts`. `observeOrbitTask` becomes
//! [`TaskObserver`]: the decision part of it (which results to show), with the reads left to
//! the caller's runtime.

use super::client::{TasksErrorReason, TasksInvalidation, TasksResult};
use super::format::{format_duration, format_tokens, locale_number};
use super::tasks::{
    AgentRole, AgentState, AttentionKind, ConversationRef, ImplementerMode, Subtask, SubtaskStatus,
    TaskAgent, TaskDetail, TaskMetrics, TaskStatus,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StatusTone {
    Success,
    Info,
    Warning,
    Destructive,
    Muted,
}

/// The task status as the detail header names it.
pub fn task_status_text(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Backlog => "Backlog",
        TaskStatus::Todo => "To do",
        TaskStatus::Reserved => "Starting",
        TaskStatus::Running => "In progress",
        TaskStatus::Reviewing => "In review",
        TaskStatus::Settling => "Settling",
        TaskStatus::WaitingForReview => "Waiting for review",
        TaskStatus::Completed => "Done",
        TaskStatus::Failed => "Failed",
        TaskStatus::Cancelled => "Cancelled",
    }
}

fn waits_for_input(subtask: &Subtask, implementer: Option<&TaskAgent>) -> bool {
    subtask
        .attention
        .as_ref()
        .is_some_and(|a| a.kind == AttentionKind::Question)
        || implementer.is_some_and(|agent| {
            agent.needs_input || agent.state == Some(AgentState::AskingForInput)
        })
}

pub fn subtask_status_text(subtask: &Subtask, task: &TaskDetail) -> &'static str {
    let implementer = if task.implementer_mode() == ImplementerMode::Shared {
        shared_implementer(task)
    } else {
        current_implementer(task, subtask)
    };
    if waits_for_input(subtask, implementer) {
        return "Needs input";
    }
    if task.summary.status == TaskStatus::WaitingForReview
        && subtask.status == SubtaskStatus::Reviewing
    {
        return "Waiting for review";
    }
    match subtask.status {
        SubtaskStatus::Todo => "Not started",
        SubtaskStatus::Reserved => "Starting",
        SubtaskStatus::Running => "In progress",
        SubtaskStatus::Reviewing => "In review",
        SubtaskStatus::Completed => "Done",
        SubtaskStatus::Failed => "Failed",
        SubtaskStatus::Cancelled => "Cancelled",
        SubtaskStatus::Unknown => "Unknown state",
    }
}

fn started(subtask: &Subtask) -> bool {
    !matches!(
        subtask.status,
        SubtaskStatus::Todo | SubtaskStatus::Reserved
    )
}

/// Green done, blue in progress, amber waiting on a person, red failure.
fn subtask_tone(
    task: &TaskDetail,
    subtask: &Subtask,
    implementer: Option<&TaskAgent>,
) -> StatusTone {
    if task.summary.status == TaskStatus::WaitingForReview
        && subtask.status == SubtaskStatus::Reviewing
    {
        return StatusTone::Warning;
    }
    if waits_for_input(subtask, implementer) {
        return StatusTone::Warning;
    }
    match subtask.status {
        SubtaskStatus::Completed => StatusTone::Success,
        SubtaskStatus::Running | SubtaskStatus::Reviewing => StatusTone::Info,
        SubtaskStatus::Failed => StatusTone::Destructive,
        _ => StatusTone::Muted,
    }
}

/// Orbit names providers by CLI; Conn's icons are keyed by driver (`claude` is `claudeAgent`).
pub fn orbit_agent_driver_kind(provider: Option<&str>) -> Option<String> {
    match provider {
        None | Some("") => None,
        Some("claude") => Some("claudeAgent".to_owned()),
        Some(other) => Some(other.to_owned()),
    }
}

/// The implementer that works on every subtask when Orbit runs a task with one shared agent.
pub fn shared_implementer(task: &TaskDetail) -> Option<&TaskAgent> {
    if task.implementer_mode() != ImplementerMode::Shared {
        return None;
    }
    task.agents
        .iter()
        .find(|agent| agent.role == AgentRole::Implementer && agent.current)
}

fn current_implementer<'a>(task: &'a TaskDetail, subtask: &Subtask) -> Option<&'a TaskAgent> {
    subtask
        .current_implementer_agent_id
        .and_then(|id| task.agents.iter().find(|agent| agent.id == id))
        .or_else(|| {
            task.agents.iter().rev().find(|agent| {
                agent.role == AgentRole::Implementer
                    && agent.current
                    && agent.subtask_ids.contains(&subtask.id)
            })
        })
}

/// What leads a subtask row. Per subtask, a started subtask shows its implementer with the
/// subtask's state as the dot. Shared, only the subtask the agent is on shows it. Unstarted keeps
/// a ring.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SubtaskLead<'a> {
    Agent {
        agent: &'a TaskAgent,
        tone: StatusTone,
    },
    State {
        tone: StatusTone,
    },
    Done,
    NotStarted,
}

pub fn subtask_lead<'a>(task: &'a TaskDetail, subtask: &Subtask) -> SubtaskLead<'a> {
    if !started(subtask) {
        return SubtaskLead::NotStarted;
    }
    if task.implementer_mode() == ImplementerMode::Shared {
        if subtask.status == SubtaskStatus::Completed {
            return SubtaskLead::Done;
        }
        let active = matches!(
            subtask.status,
            SubtaskStatus::Running | SubtaskStatus::Reviewing
        );
        return match shared_implementer(task) {
            Some(shared) if active => SubtaskLead::Agent {
                agent: shared,
                tone: subtask_tone(task, subtask, Some(shared)),
            },
            _ => SubtaskLead::State {
                tone: subtask_tone(task, subtask, None),
            },
        };
    }
    let implementer = current_implementer(task, subtask);
    let tone = subtask_tone(task, subtask, implementer);
    match implementer {
        Some(agent) => SubtaskLead::Agent { agent, tone },
        None => SubtaskLead::State { tone },
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRow<'a> {
    pub agent: &'a TaskAgent,
    pub label: String,
    /// Only an agent with a Conn conversation opens; the rest are plain rows.
    pub conversation: Option<&'a ConversationRef>,
}

impl AgentRow<'_> {
    /// Whether the row is a button (opens the conversation) or plain text.
    pub fn is_interactive(&self) -> bool {
        self.conversation.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentsModel<'a> {
    pub current: Vec<AgentRow<'a>>,
    pub earlier: Vec<AgentRow<'a>>,
}

fn role_text(agent: &TaskAgent) -> &'static str {
    match agent.role {
        AgentRole::Implementer => "Implementer",
        AgentRole::Reviewer => "Reviewer",
        AgentRole::Unknown => "Agent",
    }
}

fn row_for(agent: &TaskAgent, label: String) -> AgentRow<'_> {
    AgentRow {
        agent,
        label: if agent.attempt > 1 {
            format!("{label} · attempt {}", agent.attempt)
        } else {
            label
        },
        conversation: agent.conn.as_ref(),
    }
}

/// The Agents tab for the task (`subtask_id` `None`) or one subtask: current agents, then earlier
/// attempts. A shared implementer appears once, as "Implementer · all subtasks".
pub fn agents_for(task: &TaskDetail, subtask_id: Option<i64>) -> AgentsModel<'_> {
    let shared = shared_implementer(task).map(|agent| agent.id);
    let label = |agent: &TaskAgent| -> String {
        if Some(agent.id) == shared {
            return "Implementer · all subtasks".to_owned();
        }
        let role = role_text(agent);
        if subtask_id.is_some() {
            return role.to_owned();
        }
        match agent.subtask_ids.as_slice() {
            [] => format!("{role} · whole task"),
            [only] => task
                .subtasks
                .iter()
                .find(|s| s.id == *only)
                .map_or_else(|| role.to_owned(), |s| format!("{role} · {}", s.title)),
            _ => role.to_owned(),
        }
    };
    let relevant = |agent: &&TaskAgent| {
        Some(agent.id) == shared
            || subtask_id
                .is_none_or(|id| agent.subtask_ids.is_empty() || agent.subtask_ids.contains(&id))
    };
    // Implementers before reviewers, each in Orbit's oldest-first order.
    let ordered: Vec<&TaskAgent> = task
        .agents
        .iter()
        .filter(relevant)
        .filter(|a| a.role == AgentRole::Implementer)
        .chain(
            task.agents
                .iter()
                .filter(relevant)
                .filter(|a| a.role != AgentRole::Implementer),
        )
        .collect();
    let rows = |current: bool| {
        ordered
            .iter()
            .filter(|agent| agent.current == current)
            .map(|agent| row_for(agent, label(agent)))
            .collect()
    };
    AgentsModel {
        current: rows(true),
        earlier: rows(false),
    }
}

pub fn agent_state_text(agent: &TaskAgent) -> &'static str {
    if agent.needs_input {
        return "Needs input";
    }
    match agent.state {
        Some(AgentState::Working) => "Working",
        Some(AgentState::AskingForInput) => "Needs input",
        Some(AgentState::Idle) => "Idle",
        Some(AgentState::Done) => "Done",
        Some(AgentState::Failed) => "Failed",
        Some(AgentState::Unknown) => "Unknown state",
        None => "Not observed yet",
    }
}

pub fn agent_state_tone(agent: &TaskAgent) -> StatusTone {
    if agent.needs_input || agent.state == Some(AgentState::AskingForInput) {
        return StatusTone::Warning;
    }
    match agent.state {
        Some(AgentState::Working) => StatusTone::Info,
        Some(AgentState::Done) => StatusTone::Success,
        Some(AgentState::Failed) => StatusTone::Destructive,
        _ => StatusTone::Muted,
    }
}

fn tokens_text(tokens: f64) -> String {
    format!("{} tokens", format_tokens(tokens))
}

/// The quiet line under a subtask: only what Orbit reported.
pub fn subtask_usage_text(metrics: &TaskMetrics) -> Option<String> {
    let parts: Vec<String> = [
        metrics.duration_ms.map(format_duration),
        metrics.tokens.map(tokens_text),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskUsage {
    pub text: String,
    /// `(added, deleted)`.
    pub lines: Option<(f64, f64)>,
    pub description: String,
}

const DASH: &str = "\u{2013}";

/// The task's usage row. Tokens come from Orbit as one total; never sum agents here. Lines are a
/// branch snapshot against the default branch, not a sum of subtasks.
pub fn task_usage(metrics: &TaskMetrics) -> TaskUsage {
    // A dash stands for an unreported value; with neither reported, one dash.
    let text = if metrics.duration_ms.is_none() && metrics.tokens.is_none() {
        DASH.to_owned()
    } else {
        format!(
            "{} · {}",
            metrics
                .duration_ms
                .map_or_else(|| DASH.to_owned(), format_duration),
            metrics.tokens.map_or_else(|| DASH.to_owned(), tokens_text)
        )
    };
    let lines = metrics.lines_added.zip(metrics.lines_deleted);
    let description = [
        metrics.duration_ms.map_or_else(
            || "Duration not reported.".to_owned(),
            |ms| format!("{} across all attempts.", format_duration(ms)),
        ),
        metrics.tokens.map_or_else(
            || "Tokens not reported.".to_owned(),
            |tokens| format!("{} across all agents.", tokens_text(tokens)),
        ),
        lines.map_or_else(
            || "Branch diff not reported yet.".to_owned(),
            |(added, deleted)| {
                format!(
                    "Branch diff against the default branch at the last report: {} added, {} removed.",
                    locale_number(added),
                    locale_number(deleted)
                )
            },
        ),
    ]
    .join(" ");
    TaskUsage {
        text,
        lines,
        description,
    }
}

/// Which task-detail reads to show, port of `observeOrbitTask`.
///
/// Subscribe to [`OrbitTasksClient::subscribe`](super::client::OrbitTasksClient::subscribe)
/// before the first read, call [`TaskObserver::begin_read`] before each `get_task`, and pass
/// the result to [`TaskObserver::finish_read`]. It drops stale answers, and keeps the shown task
/// when a refresh fails to reach the Gateway.
#[derive(Debug, Clone, Default)]
pub struct TaskObserver {
    task_id: i64,
    request: u64,
    has_task: bool,
}

impl TaskObserver {
    pub fn new(task_id: i64) -> Self {
        Self {
            task_id,
            request: 0,
            has_task: false,
        }
    }

    pub fn task_id(&self) -> i64 {
        self.task_id
    }

    /// Whether an invalidation means this task must read again.
    pub fn wants(&self, target: TasksInvalidation) -> bool {
        target.touches(self.task_id)
    }

    /// Starts a read; the returned ticket goes back to `finish_read`.
    pub fn begin_read(&mut self) -> u64 {
        self.request += 1;
        self.request
    }

    /// The result to show, or `None` when it is stale or a transient failure over a shown task.
    pub fn finish_read(
        &mut self,
        ticket: u64,
        result: TasksResult<TaskDetail>,
    ) -> Option<TasksResult<TaskDetail>> {
        if ticket != self.request {
            return None;
        }
        if let Err(error) = &result
            && self.has_task
            && matches!(
                error.reason,
                TasksErrorReason::Unreachable | TasksErrorReason::InvalidResponse
            )
        {
            return None;
        }
        self.has_task = result.is_ok();
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::super::client::TasksError;
    use super::super::fixtures::fixture_task;
    use super::super::tasks::{TaskEnvironment, TaskMetrics};
    use super::*;

    fn fixture(id: i64) -> TaskDetail {
        match fixture_task(id) {
            Some(task) => task,
            None => panic!("fixture {id}"),
        }
    }

    fn lead_kind(lead: SubtaskLead<'_>) -> (&'static str, Option<StatusTone>) {
        match lead {
            SubtaskLead::Agent { tone, .. } => ("agent", Some(tone)),
            SubtaskLead::State { tone } => ("state", Some(tone)),
            SubtaskLead::Done => ("done", None),
            SubtaskLead::NotStarted => ("not-started", None),
        }
    }

    fn labels(rows: &[AgentRow<'_>]) -> Vec<String> {
        rows.iter().map(|row| row.label.clone()).collect()
    }

    #[test]
    fn shows_per_subtask_implementers_with_state_dots() {
        let task = fixture(482);
        let leads: Vec<_> = task
            .subtasks
            .iter()
            .map(|s| lead_kind(subtask_lead(&task, s)))
            .collect();
        assert_eq!(
            leads,
            vec![
                ("agent", Some(StatusTone::Success)),
                ("agent", Some(StatusTone::Info)),
                ("not-started", None),
                ("not-started", None),
            ]
        );
        assert_eq!(
            labels(&agents_for(&task, Some(task.subtasks[0].id)).earlier),
            vec!["Reviewer"]
        );
        let mut whole = task.clone();
        for agent in &mut whole.agents {
            if agent.role == AgentRole::Reviewer {
                agent.subtask_ids.clear();
                agent.current = true;
            }
        }
        assert_eq!(
            agents_for(&whole, None)
                .current
                .last()
                .map(|r| r.label.as_str()),
            Some("Reviewer · whole task")
        );
        let waiting = fixture(465);
        assert_eq!(
            lead_kind(subtask_lead(&waiting, &waiting.subtasks[1])),
            ("agent", Some(StatusTone::Warning))
        );
        let failed = fixture(449);
        assert_eq!(
            lead_kind(subtask_lead(&failed, &failed.subtasks[1])),
            ("agent", Some(StatusTone::Destructive))
        );
        let agents = agents_for(&failed, Some(failed.subtasks[1].id));
        assert_eq!(labels(&agents.current), vec!["Implementer · attempt 2"]);
        assert_eq!(labels(&agents.earlier), vec!["Implementer"]);
        assert_eq!(agent_state_text(agents.earlier[0].agent), "Failed");
        let mut waiting_review = fixture(470);
        waiting_review.summary.status = TaskStatus::WaitingForReview;
        assert_eq!(
            lead_kind(subtask_lead(&waiting_review, &waiting_review.subtasks[2])),
            ("agent", Some(StatusTone::Warning))
        );
        assert_eq!(
            subtask_status_text(&waiting_review.subtasks[2], &waiting_review),
            "Waiting for review"
        );
    }

    #[test]
    fn shows_a_shared_implementer_only_on_the_current_subtask_and_once() {
        let task = fixture(452);
        let leads: Vec<_> = task
            .subtasks
            .iter()
            .map(|s| lead_kind(subtask_lead(&task, s)))
            .collect();
        assert_eq!(
            leads,
            vec![("done", None), ("agent", Some(StatusTone::Info))]
        );
        assert_eq!(
            labels(&agents_for(&task, None).current),
            vec![
                "Implementer · all subtasks",
                "Reviewer · Attachment chips in the composer"
            ]
        );
        let mut waiting = task.clone();
        waiting.summary.status = TaskStatus::WaitingForReview;
        assert_eq!(
            lead_kind(subtask_lead(&waiting, &waiting.subtasks[1])),
            ("agent", Some(StatusTone::Warning))
        );
        for subtask in &task.subtasks {
            let expected: Vec<&str> = if subtask.status == SubtaskStatus::Completed {
                vec!["Implementer · all subtasks"]
            } else {
                vec!["Implementer · all subtasks", "Reviewer"]
            };
            assert_eq!(
                labels(&agents_for(&task, Some(subtask.id)).current),
                expected
            );
        }
    }

    #[test]
    fn keeps_missing_conversations_noninteractive() {
        for (id, kind, expected) in [
            (449, TaskEnvironment::Disposed, vec![false, false]),
            (458, TaskEnvironment::Stopped, vec![false]),
        ] {
            let task = fixture(id);
            assert_eq!(task.summary.environment(), kind);
            let interactive: Vec<bool> = agents_for(&task, None)
                .current
                .iter()
                .map(AgentRow::is_interactive)
                .collect();
            assert_eq!(interactive, expected);
        }
        let task = fixture(482);
        let interactive: Vec<bool> = agents_for(&task, None)
            .current
            .iter()
            .map(AgentRow::is_interactive)
            .collect();
        assert_eq!(interactive, vec![true, true]);
    }

    #[test]
    fn distinguishes_unknown_metrics_from_zero() {
        let task = fixture(482);
        let usage = task_usage(&task.metrics);
        assert_eq!(usage.text, "38m · \u{2013}");
        assert_eq!(usage.lines, Some((610.0, 88.0)));
        assert!(usage.description.contains("across all attempts"));
        assert!(usage.description.contains("610 added, 88 removed."));
        let none = TaskMetrics::default();
        assert_eq!(task_usage(&none).text, "\u{2013}");
        assert_eq!(
            task_usage(&TaskMetrics {
                tokens: Some(2_000_000.0),
                ..none
            })
            .text,
            "\u{2013} · 2M tokens"
        );
        let zero = TaskMetrics {
            duration_ms: Some(0.0),
            tokens: Some(0.0),
            lines_added: Some(0.0),
            lines_deleted: Some(0.0),
        };
        assert_eq!(task_usage(&zero).text, "0s · 0 tokens");
        assert_eq!(task_usage(&zero).lines, Some((0.0, 0.0)));
        assert_eq!(subtask_usage_text(&none), None);
        assert_eq!(
            subtask_usage_text(&TaskMetrics {
                duration_ms: Some(60_000.0),
                tokens: Some(0.0),
                ..none
            })
            .as_deref(),
            Some("1m · 0 tokens")
        );
        let shared = fixture(452);
        assert!(
            task_usage(&TaskMetrics {
                tokens: Some(123.0),
                ..shared.metrics
            })
            .text
            .contains("123 tokens")
        );
    }

    #[test]
    fn observer_drops_stale_reads_and_keeps_data_on_transient_failures() {
        let task = fixture(482);
        let error = |reason| {
            Err(TasksError {
                reason,
                message: String::new(),
            })
        };
        let mut observer = TaskObserver::new(482);
        assert!(observer.wants(TasksInvalidation::List));
        assert!(!observer.wants(TasksInvalidation::Task(470)));
        assert!(observer.wants(TasksInvalidation::Task(482)));
        let first = observer.begin_read();
        assert!(observer.finish_read(first, Ok(task.clone())).is_some());
        let failing = observer.begin_read();
        assert!(
            observer
                .finish_read(failing, error(TasksErrorReason::Unreachable))
                .is_none()
        );
        let stale = observer.begin_read();
        let fresh = observer.begin_read();
        assert!(observer.finish_read(stale, Ok(task.clone())).is_none());
        assert!(observer.finish_read(fresh, Ok(task.clone())).is_some());
        for reason in [
            TasksErrorReason::NotFound,
            TasksErrorReason::AccessRequired,
            TasksErrorReason::NotANode,
            TasksErrorReason::ExtensionDisabled,
        ] {
            let ticket = observer.begin_read();
            assert_eq!(
                observer
                    .finish_read(ticket, error(reason))
                    .and_then(|r| r.err())
                    .map(|e| e.reason),
                Some(reason)
            );
            let ticket = observer.begin_read();
            assert!(
                observer
                    .finish_read(ticket, Ok(task.clone()))
                    .is_some_and(|r| r.is_ok())
            );
        }
        // An initial error shows; the next read recovers.
        let mut fresh_observer = TaskObserver::new(482);
        let ticket = fresh_observer.begin_read();
        assert!(
            fresh_observer
                .finish_read(ticket, error(TasksErrorReason::Unreachable))
                .is_some()
        );
        let ticket = fresh_observer.begin_read();
        assert!(fresh_observer.finish_read(ticket, Ok(task)).is_some());
    }

    #[test]
    fn maps_status_and_driver_text() {
        assert_eq!(task_status_text(TaskStatus::Reserved), "Starting");
        assert_eq!(
            orbit_agent_driver_kind(Some("claude")).as_deref(),
            Some("claudeAgent")
        );
        assert_eq!(
            orbit_agent_driver_kind(Some("codex")).as_deref(),
            Some("codex")
        );
        assert_eq!(orbit_agent_driver_kind(Some("")), None);
    }
}
