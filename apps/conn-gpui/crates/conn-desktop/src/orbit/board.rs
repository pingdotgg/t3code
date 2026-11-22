//! The Tasks board: lanes, search, card text and error notices.
//!
//! Port of `apps/web/src/orbit/tasks/tasksBoard.logic.ts`.

use super::client::TasksErrorReason;
use super::tasks::{TaskLane, TaskSummary};

/// Search matches the title, the project, the task number (with or without "#") and the machine.
pub fn matches_task_query(task: &TaskSummary, query: &str) -> bool {
    let lowered = query.trim().to_lowercase();
    let needle = lowered.strip_prefix('#').unwrap_or(&lowered);
    if needle.is_empty() {
        return true;
    }
    let machine = task
        .workspace
        .as_ref()
        .and_then(|w| w.node.as_ref())
        .map_or("", |node| node.name.as_str());
    [
        task.title.as_str(),
        task.project.name.as_str(),
        &task.id.to_string(),
        machine,
    ]
    .join(" ")
    .to_lowercase()
    .contains(needle)
}

/// One lane of the board: the tasks that match the search, and the lane's full count.
#[derive(Debug, Clone, PartialEq)]
pub struct BoardLane<'a> {
    pub id: TaskLane,
    pub label: &'static str,
    pub tasks: Vec<&'a TaskSummary>,
    pub total: usize,
}

/// The lanes the user keeps on, in board order, keeping Orbit's task order inside each lane.
pub fn tasks_board_lanes<'a>(
    tasks: &'a [TaskSummary],
    query: &str,
    hidden_lanes: &[TaskLane],
) -> Vec<BoardLane<'a>> {
    TaskLane::ALL
        .into_iter()
        .filter(|lane| !hidden_lanes.contains(lane))
        .map(|lane| {
            let in_lane: Vec<&TaskSummary> = tasks.iter().filter(|t| t.lane() == lane).collect();
            BoardLane {
                id: lane,
                label: lane.label(),
                total: in_lane.len(),
                tasks: in_lane
                    .into_iter()
                    .filter(|task| matches_task_query(task, query))
                    .collect(),
            }
        })
        .collect()
}

/// The card's quiet line: subtask progress and the machine the task runs on. A task with one
/// subtask is just the task, so the count shows from two subtasks. Empty when there is neither.
pub fn task_card_detail(task: &TaskSummary) -> String {
    let counts = task.subtask_counts;
    let mut parts = Vec::new();
    if counts.total >= 2 {
        parts.push(format!("{}/{} subtasks", counts.completed, counts.total));
    }
    if let Some(node) = task.workspace.as_ref().and_then(|w| w.node.as_ref())
        && !node.name.is_empty()
    {
        parts.push(node.name.clone());
    }
    parts.join(" · ")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorNoticeKind {
    Access,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorNotice {
    pub title: &'static str,
    pub kind: ErrorNoticeKind,
}

/// What the panel says when the list cannot be read.
pub fn tasks_error_notice(reason: TasksErrorReason) -> ErrorNotice {
    let (title, kind) = match reason {
        TasksErrorReason::NotANode => ("This device is not an Orbit Node", ErrorNoticeKind::Access),
        TasksErrorReason::AccessRequired => ("No access to Orbit", ErrorNoticeKind::Access),
        TasksErrorReason::ExtensionDisabled => (
            "Tasks are turned off in Orbit",
            ErrorNoticeKind::Unavailable,
        ),
        TasksErrorReason::NotFound => ("Task not found", ErrorNoticeKind::Unavailable),
        TasksErrorReason::Unreachable | TasksErrorReason::InvalidResponse => {
            ("Tasks are unavailable", ErrorNoticeKind::Unavailable)
        }
    };
    ErrorNotice { title, kind }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::fixture_tasks;
    use super::super::tasks::{TaskEnvironment, TaskNode};
    use super::*;

    #[test]
    fn counts_subtasks_on_a_card_only_from_two() {
        let tasks = fixture_tasks();
        let Some(task) = tasks
            .iter()
            .find(|t| t.workspace.as_ref().is_some_and(|w| w.node.is_some()))
        else {
            panic!("no fixture task on a machine");
        };
        let with_counts = |total, completed, node: Option<&str>| {
            let mut copy = task.clone();
            copy.subtask_counts.total = total;
            copy.subtask_counts.completed = completed;
            match node {
                None => copy.workspace = None,
                Some(name) => {
                    if let Some(workspace) = copy.workspace.as_mut() {
                        workspace.node = Some(TaskNode {
                            id: 9,
                            name: name.to_owned(),
                        });
                    }
                }
            }
            copy
        };
        assert_eq!(
            task_card_detail(&with_counts(2, 1, Some("beast"))),
            "1/2 subtasks · beast"
        );
        assert_eq!(task_card_detail(&with_counts(1, 0, Some("beast"))), "beast");
        assert_eq!(task_card_detail(&with_counts(1, 1, None)), "");
        assert_eq!(task_card_detail(&with_counts(0, 0, None)), "");
    }

    #[test]
    fn lays_fixture_tasks_out_in_lanes_with_their_finer_labels() {
        let tasks = fixture_tasks();
        let lanes: Vec<_> = tasks_board_lanes(&tasks, "", &[])
            .into_iter()
            .map(|lane| {
                let cards: Vec<_> = lane
                    .tasks
                    .iter()
                    .map(|t| (t.id, t.label().map(|l| l.label)))
                    .collect();
                (lane.label, cards)
            })
            .collect();
        assert_eq!(
            lanes,
            vec![
                ("Backlog", vec![(520, None)]),
                ("To do", vec![(510, None)]),
                (
                    "In progress",
                    vec![
                        (482, Some("Working")),
                        (470, Some("In review")),
                        (465, Some("Needs answer")),
                        (458, Some("Blocked")),
                        (452, Some("Working")),
                    ]
                ),
                (
                    "Done",
                    vec![(449, Some("Failed")), (440, Some("Cancelled")), (431, None)]
                ),
            ]
        );
    }

    #[test]
    fn searches_by_title_project_number_or_machine_and_leaves_hidden_lanes_out() {
        let tasks = fixture_tasks();
        let shown = |query: &str| -> Vec<(TaskLane, Vec<i64>, usize)> {
            tasks_board_lanes(&tasks, query, &[TaskLane::Backlog])
                .into_iter()
                .map(|lane| {
                    (
                        lane.id,
                        lane.tasks.iter().map(|t| t.id).collect(),
                        lane.total,
                    )
                })
                .collect()
        };
        assert_eq!(
            shown("#482"),
            vec![
                (TaskLane::Todo, vec![], 1),
                (TaskLane::InProgress, vec![482], 5),
                (TaskLane::Done, vec![], 3),
            ]
        );
        assert_eq!(shown("composer")[1], (TaskLane::InProgress, vec![482], 5));
        assert_eq!(shown("beast")[0], (TaskLane::Todo, vec![], 1));
        assert_eq!(
            shown("conn")
                .iter()
                .map(|(_, ids, _)| ids.len())
                .sum::<usize>(),
            9
        );
    }

    #[test]
    fn tells_the_workspace_states_apart() {
        let kinds: Vec<_> = fixture_tasks()
            .iter()
            .map(|task| {
                let kind = match task.environment() {
                    TaskEnvironment::NotStarted => "not-started",
                    TaskEnvironment::Disposed => "disposed",
                    TaskEnvironment::Stopped => "stopped",
                    TaskEnvironment::Unreachable => "unreachable",
                    TaskEnvironment::Ready { .. } => "ready",
                };
                (task.id, kind)
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                (520, "not-started"),
                (510, "not-started"),
                (482, "ready"),
                (470, "ready"),
                (465, "ready"),
                (458, "stopped"),
                (452, "unreachable"),
                (449, "disposed"),
                (440, "disposed"),
                (431, "ready"),
            ]
        );
    }

    #[test]
    fn names_error_notices() {
        assert_eq!(
            tasks_error_notice(TasksErrorReason::NotANode),
            ErrorNotice {
                title: "This device is not an Orbit Node",
                kind: ErrorNoticeKind::Access
            }
        );
        assert_eq!(
            tasks_error_notice(TasksErrorReason::InvalidResponse).title,
            "Tasks are unavailable"
        );
    }
}
