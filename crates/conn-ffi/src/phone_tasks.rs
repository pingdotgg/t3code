//! The phone Tasks tab, ported from Conn mobile (`apps/mobile/src/features/tasks`:
//! `TasksScreen.tsx`, `TaskRows.tsx`, `taskPresentation.ts`, `orbitTasks.ts`, `taskList.ts`),
//! so the SwiftUI view only draws.
//!
//! The desktop board ([`OrbitCore::tasks_board`]) shows every lane side by side. The phone shows
//! one lane at a time, In progress first, and its rows say more: project, task number, subtasks,
//! time and machine.

use std::collections::HashMap;

use conn_orbit::OrbitTasksClient;
use conn_orbit::insights::parse_date_ms;
use conn_orbit::tasks::{TaskLane, TasksListQuery};
use tokio::task::JoinSet;

use crate::orbit::{
    FfiAttentionKind, FfiTaskLane, FfiTaskPullRequest, FfiTaskStatus, FfiTaskSummary, OrbitCore,
};
use crate::types::{FfiError, FfiOrbitErrorReason};

/// The Gateway's largest page. The list follows the cursor up to `MAX_PAGES` pages (`taskList.ts`).
const PAGE_SIZE: u32 = 100;
const MAX_PAGES: usize = 10;

/// The phone shows In progress first: it is what a phone checks (`MOBILE_TASK_LANES`).
const PHONE_LANES: [FfiTaskLane; 4] = [
    FfiTaskLane::InProgress,
    FfiTaskLane::Todo,
    FfiTaskLane::Backlog,
    FfiTaskLane::Done,
];

/// Orbit projects carry no favicon, so a row shows a lettered tile in one of this many colours.
const PROJECT_TILE_COLORS: u32 = 8;

/// Every task this device may read, as [`OrbitCore::phone_tasks`] read it.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiPhoneTasks {
    /// Every task, in Orbit's order.
    pub tasks: Vec<FfiTaskSummary>,
    /// How long each running task has worked. The list carries no metrics, so this comes from
    /// each running task's detail; a task whose detail did not answer has no entry.
    pub running_durations_ms: HashMap<i64, f64>,
}

/// The status dot on a row's project tile (`taskDotState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiTaskDot {
    /// Grey: needs an answer, or has not started (backlog, to do, cancelled).
    Waiting,
    /// Red: failed, or blocked while it runs.
    Failed,
    /// Blue: runs.
    Working,
    /// Green: done.
    Done,
}

/// One lane in the lane menu, with how many tasks in it match the search.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiPhoneTaskLane {
    pub id: FfiTaskLane,
    pub label: String,
    pub count: u32,
    pub selected: bool,
}

/// One row of the Tasks tab (`TaskRow`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiPhoneTaskRow {
    pub id: i64,
    pub title: String,
    pub dot: FfiTaskDot,
    /// Work in progress drops the title to regular weight, like a working thread.
    pub recede: bool,
    /// The project tile's letter and colour (an index into mobile's eight `PROJECT_COLORS`).
    pub tile_letter: String,
    pub tile_color_index: u8,
    /// `conn · #482 · 1/4 · 12m · nick-mini`: project, number, subtasks, time and machine.
    pub detail: String,
    pub pull_request: Option<FfiTaskPullRequest>,
    pub accessibility_label: String,
}

/// What the Tasks tab shows for one lane and search.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiPhoneTasksView {
    /// The lane menu, in phone order.
    pub lanes: Vec<FfiPhoneTaskLane>,
    /// The rows of the selected lane that match the search.
    pub rows: Vec<FfiPhoneTaskRow>,
    /// The line under the title: `In progress · 3`.
    pub subtitle: String,
    /// What the list says when the lane has no rows; `None` when it has some.
    pub empty_text: Option<String>,
}

/// A title and a line that explain why the tasks cannot be read (`tasksErrorText`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiPhoneNotice {
    pub title: String,
    pub detail: String,
}

#[uniffi::export]
impl OrbitCore {
    /// Every task this device may read, plus each running task's timer (`useOrbitTaskList`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] when the list cannot be read. A running task whose detail
    /// cannot be read only loses its timer.
    pub async fn phone_tasks(&self) -> Result<FfiPhoneTasks, FfiError> {
        let client = self.tasks_client();
        self.spawn_on_rt(async move {
            let query = TasksListQuery {
                limit: Some(PAGE_SIZE),
                ..TasksListQuery::default()
            };
            let page = client
                .list_all_tasks(&query, MAX_PAGES)
                .await
                .map_err(FfiError::from)?;
            let running = page
                .tasks
                .iter()
                .filter(|task| task.lane() == TaskLane::InProgress)
                .map(|task| task.id);
            let running_durations_ms = running_durations(&client, running).await;
            Ok(FfiPhoneTasks {
                tasks: page.tasks.iter().map(FfiTaskSummary::from).collect(),
                running_durations_ms,
            })
        })
        .await
    }
}

/// Reads the running tasks' details side by side and keeps the durations Orbit reported.
async fn running_durations(
    client: &OrbitTasksClient,
    task_ids: impl Iterator<Item = i64>,
) -> HashMap<i64, f64> {
    let mut reads = JoinSet::new();
    for task_id in task_ids {
        let client = client.clone();
        reads.spawn(async move { client.get_task(task_id).await });
    }
    let mut durations = HashMap::new();
    while let Some(joined) = reads.join_next().await {
        if let Ok(Ok(detail)) = joined
            && let Some(duration_ms) = detail.metrics.duration_ms
        {
            durations.insert(detail.summary.id, duration_ms);
        }
    }
    durations
}

/// The Tasks tab for `lane` and `query` at `now_ms` (Unix milliseconds, for the row times).
#[uniffi::export]
pub fn phone_tasks_view(
    list: FfiPhoneTasks,
    lane: FfiTaskLane,
    query: String,
    now_ms: i64,
) -> FfiPhoneTasksView {
    let matching: Vec<&FfiTaskSummary> = list
        .tasks
        .iter()
        .filter(|task| matches_query(task, &query))
        .collect();
    let lanes = PHONE_LANES
        .iter()
        .map(|&id| FfiPhoneTaskLane {
            id,
            label: lane_label(id).to_owned(),
            count: count(matching.iter().filter(|task| task.lane == id).count()),
            selected: id == lane,
        })
        .collect();
    let rows: Vec<FfiPhoneTaskRow> = matching
        .iter()
        .filter(|task| task.lane == lane)
        .map(|task| {
            let duration_ms = list.running_durations_ms.get(&task.id).copied();
            task_row(task, duration_ms, now_ms)
        })
        .collect();
    let subtitle = format!("{} · {}", lane_label(lane), rows.len());
    let empty_text = rows.is_empty().then(|| {
        if query.is_empty() {
            "Nothing here"
        } else {
            "No matching tasks"
        }
        .to_owned()
    });
    FfiPhoneTasksView {
        lanes,
        rows,
        subtitle,
        empty_text,
    }
}

/// Why the tasks cannot be read, in mobile's words.
#[uniffi::export]
pub fn phone_tasks_error_text(reason: FfiOrbitErrorReason) -> FfiPhoneNotice {
    let (title, detail) = match reason {
        FfiOrbitErrorReason::NotANode => (
            "This device is not an Orbit Node",
            "Orbit reads tasks only for devices on its network.",
        ),
        FfiOrbitErrorReason::AccessRequired => (
            "No access to Orbit",
            "This device has no access to the Node that serves tasks.",
        ),
        FfiOrbitErrorReason::ExtensionDisabled => (
            "Tasks are turned off in Orbit",
            "Turn on the Tasks extension in Orbit to see tasks here.",
        ),
        FfiOrbitErrorReason::NotFound => ("Task not found", "Orbit has no task with this number."),
        FfiOrbitErrorReason::Unreachable
        | FfiOrbitErrorReason::InvalidResponse
        | FfiOrbitErrorReason::VersionConflict
        | FfiOrbitErrorReason::Unsupported
        | FfiOrbitErrorReason::Gateway => (
            "Tasks are unavailable",
            "The Orbit Gateway did not answer. Pull to try again.",
        ),
    };
    FfiPhoneNotice {
        title: title.to_owned(),
        detail: detail.to_owned(),
    }
}

fn lane_label(lane: FfiTaskLane) -> &'static str {
    TaskLane::from(lane).label()
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Title, `#482` or `482`, project (name or slug), machine or workspace (`taskMatchesQuery`).
fn matches_query(task: &FfiTaskSummary, query: &str) -> bool {
    let lowered = query.trim().to_lowercase();
    let needle = lowered.strip_prefix('#').unwrap_or(&lowered);
    if needle.is_empty() {
        return true;
    }
    let workspace = task.workspace.as_ref();
    [
        task.title.as_str(),
        &task.id.to_string(),
        task.project.name.as_str(),
        task.project.slug.as_str(),
        workspace.and_then(|w| w.node_name.as_deref()).unwrap_or(""),
        workspace.map_or("", |w| w.name.as_str()),
    ]
    .iter()
    .any(|value| value.to_lowercase().contains(needle))
}

fn attention_kind(task: &FfiTaskSummary) -> Option<FfiAttentionKind> {
    task.attention.as_ref().map(|attention| attention.kind)
}

/// Attention that needs the user, unlike an observation.
fn has_blocking_attention(task: &FfiTaskSummary) -> bool {
    attention_kind(task).is_some_and(|kind| kind != FfiAttentionKind::Observation)
}

/// Grey while it needs an answer, red when blocked or failed, blue while it runs, green when
/// done; anything else (backlog, to do, cancelled) is grey (`taskDotState`).
fn task_dot(task: &FfiTaskSummary) -> FfiTaskDot {
    if attention_kind(task) == Some(FfiAttentionKind::Question) {
        return FfiTaskDot::Waiting;
    }
    if task.status == FfiTaskStatus::Failed {
        return FfiTaskDot::Failed;
    }
    let in_progress = task.lane == FfiTaskLane::InProgress;
    if in_progress && has_blocking_attention(task) {
        return FfiTaskDot::Failed;
    }
    if in_progress {
        return FfiTaskDot::Working;
    }
    if task.status == FfiTaskStatus::Completed {
        FfiTaskDot::Done
    } else {
        FfiTaskDot::Waiting
    }
}

/// The status the row's accessibility label names (`taskStatusRow(task).label`).
fn status_label(task: &FfiTaskSummary) -> &str {
    if attention_kind(task) == Some(FfiAttentionKind::Question) {
        return "Needs answer";
    }
    if has_blocking_attention(task) && task.status != FfiTaskStatus::Completed {
        return "Blocked";
    }
    &task.status_text
}

#[uniffi::export]
pub fn task_receipt_row(task: FfiTaskSummary, now_ms: i64) -> FfiPhoneTaskRow {
    task_row(&task, None, now_ms)
}

fn task_row(task: &FfiTaskSummary, duration_ms: Option<f64>, now_ms: i64) -> FfiPhoneTaskRow {
    let dot = task_dot(task);
    let counts = task.subtask_counts;
    let time = match duration_ms {
        Some(ms) if task.lane == FfiTaskLane::InProgress => working_duration_label(ms),
        _ => compact_elapsed(
            task.last_activity_at.as_deref().unwrap_or(&task.updated_at),
            now_ms,
        ),
    };
    let node = task
        .workspace
        .as_ref()
        .and_then(|w| w.node_name.clone())
        .unwrap_or_default();
    let detail = join_present(
        [
            task.project.name.to_lowercase(),
            format!("#{}", task.id),
            if counts.total > 0 {
                format!("{}/{}", counts.completed, counts.total)
            } else {
                String::new()
            },
            time,
            node,
        ],
        " · ",
    );
    let accessibility_label = join_present(
        [
            task.title.clone(),
            status_label(task).to_owned(),
            format!("#{}", task.id),
            detail.clone(),
            task.pull_request
                .as_ref()
                .map(|pr| format!("Pull request {}", pr.number))
                .unwrap_or_default(),
        ],
        ", ",
    );
    let (tile_letter, tile_color_index) = project_tile(&task.project.name);
    FfiPhoneTaskRow {
        id: task.id,
        title: task.title.clone(),
        dot,
        recede: dot == FfiTaskDot::Working,
        tile_letter,
        tile_color_index,
        detail,
        pull_request: task.pull_request.clone(),
        accessibility_label,
    }
}

/// JavaScript's `[...].filter(Boolean).join(separator)`.
fn join_present<const N: usize>(parts: [String; N], separator: &str) -> String {
    parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(separator)
}

/// The tile's letter and colour: the first letter upper-cased, and the sum of the name's
/// characters (their first UTF-16 unit, as `charCodeAt(0)`) picks the colour (`ProjectTile`).
fn project_tile(name: &str) -> (String, u8) {
    let hash: u32 = name
        .chars()
        .map(|c| {
            let mut units = [0u16; 2];
            u32::from(c.encode_utf16(&mut units)[0])
        })
        .fold(0, u32::wrapping_add);
    let index = u8::try_from(hash % PROJECT_TILE_COLORS).unwrap_or(0);
    let letter = name
        .chars()
        .next()
        .map_or_else(|| "?".to_owned(), |c| c.to_uppercase().collect());
    (letter, index)
}

/// `<1m`, `23m`, `2h`, `3d` since `timestamp` (`relativeTime` in `lib/time.ts`).
fn compact_elapsed(timestamp: &str, now_ms: i64) -> String {
    let Some(at_ms) = parse_date_ms(timestamp) else {
        return "<1m".to_owned();
    };
    let seconds = (now_ms - at_ms).max(0) / 1000;
    if seconds < 60 {
        return "<1m".to_owned();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    format!("{}d", hours / 24)
}

/// `42s`, `12m`, `1h 5m` (`formatWorkingDurationLabel` in `client-runtime`).
fn working_duration_label(elapsed_ms: f64) -> String {
    // `as` saturates, so a negative value or NaN becomes 0 like the JavaScript guard.
    let seconds = if elapsed_ms.is_finite() {
        (elapsed_ms / 1000.0).floor() as u64
    } else {
        0
    };
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use conn_orbit::fixtures::{FixtureScenario, FixtureTransport};

    use super::*;
    use crate::orbit::{
        FfiSubtaskCounts, FfiTaskAttention, FfiTaskEnvironmentState, FfiTaskProject,
        FfiTaskWorkspace,
    };

    /// 2026-11-23T12:00:00Z.
    const NOW_MS: i64 = 1_795_435_200_000;

    fn task(id: i64, status: FfiTaskStatus, lane: FfiTaskLane) -> FfiTaskSummary {
        FfiTaskSummary {
            id,
            title: format!("Task {id}"),
            status,
            status_text: "In progress".to_owned(),
            lane,
            label: None,
            label_tone: None,
            card_detail: String::new(),
            attention: None,
            project: FfiTaskProject {
                id: 1,
                slug: "conn-app".to_owned(),
                name: "Conn".to_owned(),
                code: None,
            },
            workspace: None,
            environment: FfiTaskEnvironmentState::NotStarted,
            pull_request: None,
            subtask_counts: FfiSubtaskCounts {
                total: 0,
                todo: 0,
                running: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
            },
            created_at: "2026-11-23T10:00:00Z".to_owned(),
            updated_at: "2026-11-23T11:00:00Z".to_owned(),
            last_activity_at: None,
        }
    }

    fn with_attention(mut task: FfiTaskSummary, kind: FfiAttentionKind) -> FfiTaskSummary {
        task.attention = Some(FfiTaskAttention {
            kind,
            question: None,
            reason: None,
        });
        task
    }

    #[test]
    fn dot_and_status_follow_mobile_task_dot_state() {
        use FfiTaskLane::{Backlog, Done, InProgress, Todo};
        use FfiTaskStatus::{Backlog as BacklogStatus, Cancelled, Completed, Failed, Running};

        let cases = [
            (task(1, Running, InProgress), FfiTaskDot::Working),
            (task(2, Completed, Done), FfiTaskDot::Done),
            (task(3, Failed, Done), FfiTaskDot::Failed),
            (task(4, Cancelled, Done), FfiTaskDot::Waiting),
            (task(5, BacklogStatus, Backlog), FfiTaskDot::Waiting),
            (
                with_attention(task(6, Running, InProgress), FfiAttentionKind::Question),
                FfiTaskDot::Waiting,
            ),
            (
                with_attention(task(7, Running, InProgress), FfiAttentionKind::Failure),
                FfiTaskDot::Failed,
            ),
            (
                with_attention(task(8, Running, InProgress), FfiAttentionKind::Observation),
                FfiTaskDot::Working,
            ),
            (
                with_attention(
                    task(9, FfiTaskStatus::Todo, Todo),
                    FfiAttentionKind::Failure,
                ),
                FfiTaskDot::Waiting,
            ),
        ];
        for (task, dot) in &cases {
            assert_eq!(task_dot(task), *dot, "dot for task {}", task.id);
        }

        let question = with_attention(task(10, Running, InProgress), FfiAttentionKind::Question);
        assert_eq!(
            status_label(&question),
            "Needs answer",
            "a question needs an answer"
        );
        let blocked = with_attention(task(11, Running, InProgress), FfiAttentionKind::Direction);
        assert_eq!(
            status_label(&blocked),
            "Blocked",
            "direction attention blocks"
        );
        let mut done = with_attention(task(12, Completed, Done), FfiAttentionKind::Failure);
        done.status_text = "Done".to_owned();
        assert_eq!(
            status_label(&done),
            "Done",
            "a completed task is done, whatever its attention"
        );
    }

    #[test]
    fn row_detail_names_project_number_subtasks_time_and_machine() {
        let mut running = task(482, FfiTaskStatus::Running, FfiTaskLane::InProgress);
        running.subtask_counts.total = 4;
        running.subtask_counts.completed = 1;
        running.workspace = Some(FfiTaskWorkspace {
            instance_id: 7,
            name: "conn-482".to_owned(),
            status: "running".to_owned(),
            power_state: None,
            node_id: Some(3),
            node_name: Some("nick-mini".to_owned()),
            branch: None,
            conn_environment_id: None,
        });
        running.pull_request = Some(FfiTaskPullRequest {
            number: 1931,
            url: "https://github.com/example/conn/pull/1931".to_owned(),
            state: None,
        });

        let row = task_row(&running, Some(3_900_000.0), NOW_MS);
        assert_eq!(
            row.detail, "conn · #482 · 1/4 · 1h 5m · nick-mini",
            "running row"
        );
        assert!(row.recede, "a working row drops to regular weight");
        assert_eq!(
            row.accessibility_label,
            "Task 482, In progress, #482, conn · #482 · 1/4 · 1h 5m · nick-mini, Pull request 1931",
            "accessibility label"
        );

        let no_timer = task_row(&running, None, NOW_MS);
        assert_eq!(
            no_timer.detail, "conn · #482 · 1/4 · 1h · nick-mini",
            "without a timer the row shows when the task last changed"
        );

        let mut idle = task(9, FfiTaskStatus::Todo, FfiTaskLane::Todo);
        idle.last_activity_at = Some("2026-11-23T11:59:30.000Z".to_owned());
        let row = task_row(&idle, Some(60_000.0), NOW_MS);
        assert_eq!(
            row.detail, "conn · #9 · <1m",
            "no subtasks, no machine, no timer"
        );
        assert!(!row.recede, "an idle row keeps medium weight");
    }

    #[test]
    fn times_match_mobile_formatters() {
        assert_eq!(compact_elapsed("not a date", NOW_MS), "<1m", "unparseable");
        assert_eq!(
            compact_elapsed("2026-11-23T12:30:00Z", NOW_MS),
            "<1m",
            "future"
        );
        assert_eq!(
            compact_elapsed("2026-11-23T11:37:00Z", NOW_MS),
            "23m",
            "minutes"
        );
        assert_eq!(
            compact_elapsed("2026-11-23T09:59:00Z", NOW_MS),
            "2h",
            "hours"
        );
        assert_eq!(
            compact_elapsed("2026-11-20T12:00:00Z", NOW_MS),
            "3d",
            "days"
        );
        assert_eq!(working_duration_label(42_999.0), "42s", "seconds");
        assert_eq!(working_duration_label(720_000.0), "12m", "minutes");
        assert_eq!(working_duration_label(3_900_000.0), "1h 5m", "hours");
        assert_eq!(working_duration_label(f64::NAN), "0s", "not a number");
        assert_eq!(working_duration_label(-5.0), "0s", "negative");
    }

    #[test]
    fn project_tile_matches_mobile_hash() {
        // "Conn" = 67 + 111 + 110 + 110 = 398, 398 % 8 = 6.
        assert_eq!(project_tile("Conn"), ("C".to_owned(), 6), "Conn tile");
        // "orbit" = 111 + 114 + 98 + 105 + 116 = 544, 544 % 8 = 0.
        assert_eq!(project_tile("orbit"), ("O".to_owned(), 0), "orbit tile");
        assert_eq!(project_tile(""), ("?".to_owned(), 0), "empty name");
    }

    #[test]
    fn view_shows_one_lane_in_phone_order_with_search_counts() {
        let mut list = FfiPhoneTasks {
            tasks: vec![
                task(1, FfiTaskStatus::Running, FfiTaskLane::InProgress),
                task(2, FfiTaskStatus::Todo, FfiTaskLane::Todo),
                task(3, FfiTaskStatus::Completed, FfiTaskLane::Done),
                task(4, FfiTaskStatus::Running, FfiTaskLane::InProgress),
            ],
            running_durations_ms: HashMap::from([(1, 30_000.0)]),
        };
        list.tasks[3].project.slug = "orbit-core".to_owned();

        let view = phone_tasks_view(list.clone(), FfiTaskLane::InProgress, String::new(), NOW_MS);
        let lanes: Vec<_> = view
            .lanes
            .iter()
            .map(|l| (l.id, l.label.as_str(), l.count, l.selected))
            .collect();
        assert_eq!(
            lanes,
            vec![
                (FfiTaskLane::InProgress, "In progress", 2, true),
                (FfiTaskLane::Todo, "To do", 1, false),
                (FfiTaskLane::Backlog, "Backlog", 0, false),
                (FfiTaskLane::Done, "Done", 1, false),
            ],
            "In progress first, then to do, backlog and done"
        );
        assert_eq!(view.subtitle, "In progress · 2", "subtitle");
        assert_eq!(view.rows[0].detail, "conn · #1 · 30s", "the running timer");
        assert_eq!(view.empty_text, None, "rows to show");

        let searched = phone_tasks_view(
            list.clone(),
            FfiTaskLane::InProgress,
            " #4 ".to_owned(),
            NOW_MS,
        );
        assert_eq!(searched.rows.len(), 1, "number search");
        let by_slug = phone_tasks_view(
            list.clone(),
            FfiTaskLane::InProgress,
            "ORBIT-".to_owned(),
            NOW_MS,
        );
        assert_eq!(by_slug.rows.first().map(|r| r.id), Some(4), "slug search");

        let empty = phone_tasks_view(list.clone(), FfiTaskLane::Backlog, String::new(), NOW_MS);
        assert_eq!(
            empty.empty_text.as_deref(),
            Some("Nothing here"),
            "empty lane"
        );
        let no_match = phone_tasks_view(list, FfiTaskLane::Done, "zzz".to_owned(), NOW_MS);
        assert_eq!(
            no_match.empty_text.as_deref(),
            Some("No matching tasks"),
            "no match"
        );
        assert_eq!(
            no_match.subtitle, "Done · 0",
            "subtitle counts the rows shown"
        );
    }

    #[test]
    fn reads_every_task_and_running_timers_from_the_gateway() {
        let orbit =
            OrbitCore::with_transport(Arc::new(FixtureTransport::new(FixtureScenario::Default)))
                .expect("OrbitCore");
        let list = futures::executor::block_on(orbit.phone_tasks()).expect("phone_tasks");
        assert!(!list.tasks.is_empty(), "fixture tasks read");
        let running: Vec<i64> = list
            .tasks
            .iter()
            .filter(|t| t.lane == FfiTaskLane::InProgress)
            .map(|t| t.id)
            .collect();
        assert!(
            list.running_durations_ms
                .keys()
                .all(|id| running.contains(id)),
            "timers only for running tasks"
        );
        assert_eq!(
            list.running_durations_ms.get(&482),
            Some(&2_280_000.0),
            "task 482's detail reports 38 minutes"
        );

        let error =
            OrbitCore::with_transport(Arc::new(FixtureTransport::new(FixtureScenario::NotANode)))
                .expect("OrbitCore");
        let Err(FfiError::Orbit { reason, .. }) = futures::executor::block_on(error.phone_tasks())
        else {
            panic!("a device that is not a Node cannot read tasks");
        };
        assert_eq!(reason, FfiOrbitErrorReason::NotANode, "error reason");
        assert_eq!(
            phone_tasks_error_text(reason).title,
            "This device is not an Orbit Node",
            "error text"
        );
    }
}
