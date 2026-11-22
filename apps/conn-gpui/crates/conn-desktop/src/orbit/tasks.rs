//! The tasks Orbit tracks, as Conn reads them (Orbit's Conn Tasks read contract v1).
//!
//! Port of `packages/client-runtime/src/orbitGateway/tasks.ts` and `tasksWire.ts`. Field names
//! match the Gateway's snake_case JSON. Orbit owns tasks; Conn Server owns conversations.
//!
//! Decoding is forgiving the way Conn's is: a list row off the contract hides that task, not the
//! page; an unknown subtask or agent literal degrades that item to `Unknown`; an insights number
//! Orbit leaves out or changes becomes `None` (a dash), never zero.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// A task's status. A list row with any other status is skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Backlog,
    Todo,
    Reserved,
    Running,
    Reviewing,
    Settling,
    WaitingForReview,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    /// The wire name, such as `waiting_for_review`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Todo => "todo",
            Self::Reserved => "reserved",
            Self::Running => "running",
            Self::Reviewing => "reviewing",
            Self::Settling => "settling",
            Self::WaitingForReview => "waiting_for_review",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A subtask's status; `Unknown` is a status this contract version does not name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtaskStatus {
    Todo,
    Reserved,
    Running,
    Reviewing,
    Completed,
    Failed,
    Cancelled,
    #[serde(other)]
    Unknown,
}

/// `Question`: an agent waits for an answer. The others come from Orbit's assistance fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    Question,
    Failure,
    Direction,
    Observation,
    RemovalFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskAttention {
    pub kind: AttentionKind,
    pub question: Option<String>,
    pub reason: Option<String>,
}

/// `None` is unknown, never zero.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct TaskMetrics {
    /// Wall clock across every attempt and wait, up to now while it runs.
    pub duration_ms: Option<f64>,
    pub tokens: Option<f64>,
    /// Task: the branch's diff against the default branch at the last report. Subtask: always `None`.
    pub lines_added: Option<f64>,
    pub lines_deleted: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskProject {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerState {
    Running,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskNode {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskWorkspace {
    pub instance_id: i64,
    pub name: String,
    /// The Instance status; `removing` and `removed` mean the copy is disposed.
    pub status: String,
    pub power_state: Option<PowerState>,
    pub node: Option<TaskNode>,
    pub branch: Option<String>,
    /// `None` when the copy has no registered server, or the caller has no access to its Node.
    pub conn_environment_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestState {
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskPullRequest {
    pub number: i64,
    pub url: String,
    pub state: Option<PullRequestState>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubtaskCounts {
    pub total: i64,
    pub todo: i64,
    pub running: i64,
    pub completed: i64,
    pub failed: i64,
    pub cancelled: i64,
}

/// One row of `GET /conn/tasks`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskSummary {
    pub id: i64,
    pub title: String,
    pub status: TaskStatus,
    pub attention: Option<TaskAttention>,
    pub project: TaskProject,
    /// `None` before the task starts, or after its copy was removed.
    pub workspace: Option<TaskWorkspace>,
    pub pull_request: Option<TaskPullRequest>,
    pub subtask_counts: SubtaskCounts,
    pub created_at: String,
    pub updated_at: String,
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deliverable {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub description: String,
}

/// One subtask. Its metrics never carry lines: Orbit records no per-subtask line delta.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "RawSubtask")]
pub struct Subtask {
    pub id: i64,
    pub position: i64,
    pub title: String,
    pub brief: String,
    pub deliverables: Vec<Deliverable>,
    pub status: SubtaskStatus,
    pub attention: Option<TaskAttention>,
    /// Orbit's agent record id, matching a [`TaskAgent::id`].
    pub current_implementer_agent_id: Option<i64>,
    pub metrics: TaskMetrics,
}

#[derive(Deserialize)]
struct RawSubtask {
    id: i64,
    position: i64,
    title: String,
    brief: String,
    deliverables: Vec<Deliverable>,
    status: SubtaskStatus,
    #[serde(default)]
    attention: Value,
    current_implementer_agent_id: Option<i64>,
    metrics: TaskMetrics,
}

impl From<RawSubtask> for Subtask {
    fn from(raw: RawSubtask) -> Self {
        // Unknown attention leaves the brief readable, with an unknown subtask state.
        let attention = serde_json::from_value::<Option<TaskAttention>>(raw.attention);
        let status = if attention.is_ok() {
            raw.status
        } else {
            SubtaskStatus::Unknown
        };
        Self {
            id: raw.id,
            position: raw.position,
            title: raw.title,
            brief: raw.brief,
            deliverables: raw.deliverables,
            status,
            attention: attention.ok().flatten(),
            current_implementer_agent_id: raw.current_implementer_agent_id,
            metrics: TaskMetrics {
                lines_added: None,
                lines_deleted: None,
                ..raw.metrics
            },
        }
    }
}

/// A Conn conversation, by its canonical server and thread.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ConversationRef {
    pub environment_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Implementer,
    Reviewer,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Idle,
    Working,
    AskingForInput,
    Done,
    Failed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskAgent {
    /// Orbit's agent-thread record id. Never a Conn thread id.
    pub id: i64,
    pub role: AgentRole,
    pub subtask_ids: Vec<i64>,
    /// False for earlier attempts.
    pub current: bool,
    /// Counts per role and subtask, from 1.
    pub attempt: i64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// `None` before Orbit's first observation.
    pub state: Option<AgentState>,
    pub needs_input: bool,
    pub created_at: String,
    pub observed_at: Option<String>,
    /// The only link to a Conn thread. `None` when the workspace is gone or not reachable.
    pub conn: Option<ConversationRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImplementerMode {
    PerSubtask,
    /// Reserved for a future Orbit mode.
    Shared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskExecution {
    pub implementer_mode: ImplementerMode,
}

/// `GET /conn/tasks/{task}`: the row plus brief, subtasks (in position order) and agents.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskDetail {
    #[serde(flatten)]
    pub summary: TaskSummary,
    pub brief: String,
    pub execution: TaskExecution,
    pub metrics: TaskMetrics,
    pub subtasks: Vec<Subtask>,
    /// Implementers and reviewers, oldest first, current and earlier attempts.
    pub agents: Vec<TaskAgent>,
}

impl TaskDetail {
    pub fn implementer_mode(&self) -> ImplementerMode {
        self.execution.implementer_mode
    }
}

/// One page of the task list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TasksPage {
    pub tasks: Vec<TaskSummary>,
    /// Rows left out because they did not match the contract, such as an unknown status.
    pub skipped: usize,
    pub next_cursor: Option<String>,
}

/// The filters of `GET /conn/tasks`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TasksListQuery {
    /// Orbit Project id. Without it the list is every task this Node may read.
    pub project: Option<i64>,
    pub instance: Option<i64>,
    pub status: Option<TaskStatus>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InsightsPeriod {
    #[serde(rename = "24h")]
    Day,
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
}

impl InsightsPeriod {
    /// The board's periods, in menu order.
    pub const ALL: [Self; 3] = [Self::Day, Self::Week, Self::Month];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Week => "7d",
            Self::Month => "30d",
        }
    }
}

fn lenient_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value
        .as_ref()
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite()))
}

/// One period of Orbit's task insights. Every number is `None` when Orbit does not report it;
/// durations and tokens are medians.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct InsightsSummary {
    #[serde(default, deserialize_with = "lenient_number")]
    pub tasks: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub merged: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens_per_merged_pr: Option<f64>,
    /// Ready to merged.
    #[serde(default, deserialize_with = "lenient_number")]
    pub lead_time_ms: Option<f64>,
    /// Orbit 6041: ready to deployed.
    #[serde(default, deserialize_with = "lenient_number")]
    pub delivery_time_ms: Option<f64>,
    /// Orbit 6041: merged to deployed.
    #[serde(default, deserialize_with = "lenient_number")]
    pub deploy_wait_ms: Option<f64>,
    /// Orbit 6042: PR opened to merged.
    #[serde(default, deserialize_with = "lenient_number")]
    pub pr_merge_wait_ms: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub pr_first_pass: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub wasted_share: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub review_rounds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InsightsWeek {
    pub week_start: String,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens_per_merged_pr: Option<f64>,
}

/// One day (`date`, `YYYY-MM-DD`) or hour (ISO start of the hour) of the period.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InsightsBucket {
    pub date: String,
    pub merged: f64,
    /// The bucket's own numbers, by the same rules as `current`.
    pub values: InsightsSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InsightsBreakdownRow {
    pub key: String,
    pub label: String,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tasks: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub merged: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens_per_merged_pr: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub lead_time_ms: Option<f64>,
}

/// `GET /api/v1/task-insights`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskInsights {
    pub period: InsightsPeriod,
    pub current: InsightsSummary,
    pub previous: InsightsSummary,
    /// The last 12 weeks, oldest first, whatever the period.
    pub weekly: Vec<InsightsWeek>,
    /// Each day of the period, oldest first; empty for the 24-hour period.
    pub daily: Vec<InsightsBucket>,
    /// Each hour of the 24-hour period, oldest first; empty otherwise.
    pub hourly: Vec<InsightsBucket>,
    /// The wire's `breakdowns.model`.
    pub by_model: Vec<InsightsBreakdownRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskInsightsQuery {
    pub period: InsightsPeriod,
    /// Orbit Project id. Without it the numbers cover every task this Node may read.
    pub project: Option<i64>,
}

// ---------------------------------------------------------------------------------------------
// Environments (`GET /conn/environments`)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentStatus {
    Registered,
    SessionExpired,
}

/// A registered Conn server, as Orbit lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitEnvironment {
    pub environment_id: String,
    pub label: String,
    pub url: String,
    pub server_version: Option<String>,
    pub registered_by: Option<String>,
    /// When the server last registered. A refused pairing waits for the next registration.
    pub registered_at: Option<String>,
    pub status: EnvironmentStatus,
    /// The container Instance whose server this is, or `None` for a self-registered server.
    pub instance_id: Option<i64>,
    /// `Stopped` means the Instance is asleep.
    pub power_state: Option<PowerState>,
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub instance_name: Option<String>,
    pub node_name: Option<String>,
    pub instance_url: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

/// Decodes rows one by one: a row off the contract is left out, not the whole answer.
fn each_row<T: DeserializeOwned>(rows: &[Value]) -> Vec<T> {
    rows.iter()
        .filter_map(|row| serde_json::from_value(row.clone()).ok())
        .collect()
}

/// An optional array field: absent or null is empty; any other non-array fails the envelope.
fn optional_rows(value: Option<&Value>) -> Option<&[Value]> {
    match value {
        None | Some(Value::Null) => Some(&[]),
        Some(Value::Array(rows)) => Some(rows),
        Some(_) => None,
    }
}

/// The `{ data, meta: { next_cursor } }` list envelope.
pub fn decode_tasks_page(json: &Value) -> Option<TasksPage> {
    let rows = json.get("data")?.as_array()?;
    let next_cursor = match json.get("meta") {
        None => None,
        Some(meta) => match meta.as_object()?.get("next_cursor") {
            None | Some(Value::Null) => None,
            Some(Value::String(cursor)) => Some(cursor.clone()),
            Some(_) => return None,
        },
    };
    let tasks: Vec<TaskSummary> = each_row(rows);
    Some(TasksPage {
        skipped: rows.len() - tasks.len(),
        tasks,
        next_cursor,
    })
}

/// `{ data: <task> }` for one task, with subtasks in position order.
pub fn decode_task_detail(json: &Value) -> Option<TaskDetail> {
    let mut detail: TaskDetail = serde_json::from_value(json.get("data")?.clone()).ok()?;
    detail.subtasks.sort_by_key(|subtask| subtask.position);
    Some(detail)
}

/// A task-create result, `{ data: <task> }`: its list-row fields, whatever else it carries.
pub fn decode_task_created(json: &Value) -> Option<TaskSummary> {
    serde_json::from_value(json.get("data")?.clone()).ok()
}

/// The Gateway's error envelope, loosely: only the code and message matter.
pub fn decode_error_envelope(json: &Value) -> Option<(String, String)> {
    let error = json.get("error")?;
    Some((
        error.get("code")?.as_str()?.to_owned(),
        error.get("message")?.as_str()?.to_owned(),
    ))
}

fn decode_bucket(row: &Value, key: &str) -> Option<InsightsBucket> {
    let date = row.get(key)?.as_str()?.to_owned();
    let merged = row.get("merged")?.as_f64()?;
    let values = InsightsSummary::deserialize(row).ok()?;
    Some(InsightsBucket {
        date,
        merged,
        values,
    })
}

/// `GET /api/v1/task-insights`. Every number decodes on its own.
pub fn decode_task_insights(json: &Value) -> Option<TaskInsights> {
    let data = json.get("data")?.as_object()?;
    let period: InsightsPeriod = serde_json::from_value(data.get("period")?.clone()).ok()?;
    let summary = |key: &str| -> Option<InsightsSummary> {
        let value = data.get(key)?;
        value
            .is_object()
            .then(|| InsightsSummary::deserialize(value).ok())?
    };
    let current = summary("current")?;
    let previous = summary("previous")?;
    let weekly = each_row(optional_rows(data.get("weekly"))?);
    let daily = optional_rows(data.get("daily"))?
        .iter()
        .filter_map(|row| decode_bucket(row, "date"))
        .collect();
    let hourly = optional_rows(data.get("hourly"))?
        .iter()
        .filter_map(|row| decode_bucket(row, "hour"))
        .collect();
    let by_model = match data.get("breakdowns") {
        None => Vec::new(),
        Some(breakdowns) => each_row(optional_rows(breakdowns.as_object()?.get("model"))?),
    };
    Some(TaskInsights {
        period,
        current,
        previous,
        weekly,
        daily,
        hourly,
        by_model,
    })
}

/// A string the way the Gateway stores it: trimmed, and `None` when nothing is left.
fn optional_text(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn decode_environment(value: &Value) -> Option<OrbitEnvironment> {
    let data = value.as_object()?;
    let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    let status = match data.get("status")?.as_str()? {
        "registered" => EnvironmentStatus::Registered,
        "session_expired" => EnvironmentStatus::SessionExpired,
        _ => return None,
    };
    let power_state = match data.get("power_state").and_then(Value::as_str) {
        Some("running") => Some(PowerState::Running),
        Some("stopped") => Some(PowerState::Stopped),
        _ => None,
    };
    Some(OrbitEnvironment {
        environment_id: text("environment_id")?,
        label: text("label")?,
        url: text("url")?,
        server_version: text("server_version"),
        registered_by: text("registered_by"),
        registered_at: text("registered_at"),
        status,
        instance_id: data.get("instance_id").and_then(Value::as_i64),
        power_state,
        project_id: data.get("project_id").and_then(Value::as_i64),
        project_name: optional_text(data.get("project_name")),
        project_slug: optional_text(data.get("project_slug")),
        instance_name: optional_text(data.get("instance_name")),
        node_name: optional_text(data.get("node_name")),
        instance_url: optional_text(data.get("instance_url")),
    })
}

/// `{ data: [environment] }`; one bad entry fails the whole list, as in Conn.
pub fn decode_environments(json: &Value) -> Option<Vec<OrbitEnvironment>> {
    json.get("data")?
        .as_array()?
        .iter()
        .map(decode_environment)
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Lanes, labels and workspace state
// ---------------------------------------------------------------------------------------------

/// Board lanes are a view over Orbit's statuses, not a lifecycle of their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskLane {
    Backlog,
    Todo,
    InProgress,
    Done,
}

impl TaskLane {
    /// Every lane in board order.
    pub const ALL: [Self; 4] = [Self::Backlog, Self::Todo, Self::InProgress, Self::Done];

    pub fn label(self) -> &'static str {
        match self {
            Self::Backlog => "Backlog",
            Self::Todo => "To do",
            Self::InProgress => "In progress",
            Self::Done => "Done",
        }
    }

    pub fn of(status: TaskStatus) -> Self {
        match status {
            TaskStatus::Backlog => Self::Backlog,
            TaskStatus::Todo | TaskStatus::Reserved => Self::Todo,
            TaskStatus::Running
            | TaskStatus::Reviewing
            | TaskStatus::Settling
            | TaskStatus::WaitingForReview => Self::InProgress,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled => Self::Done,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskLabelTone {
    Info,
    Warning,
    Destructive,
    Muted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskLabel {
    pub label: &'static str,
    pub tone: TaskLabelTone,
}

/// The finer state a card names inside its lane, or `None` when the lane says enough.
pub fn task_label(status: TaskStatus, attention: Option<&TaskAttention>) -> Option<TaskLabel> {
    let label = |label, tone| Some(TaskLabel { label, tone });
    if attention.is_some_and(|a| a.kind == AttentionKind::Question) {
        return label("Needs answer", TaskLabelTone::Warning);
    }
    match status {
        TaskStatus::Failed => return label("Failed", TaskLabelTone::Destructive),
        TaskStatus::Cancelled => return label("Cancelled", TaskLabelTone::Muted),
        _ => {}
    }
    if attention.is_some_and(|a| a.kind != AttentionKind::Observation) {
        return label("Blocked", TaskLabelTone::Destructive);
    }
    match status {
        TaskStatus::Reviewing | TaskStatus::WaitingForReview => {
            label("In review", TaskLabelTone::Info)
        }
        TaskStatus::Running | TaskStatus::Settling => label("Working", TaskLabelTone::Info),
        _ => None,
    }
}

/// Where the task's workspace stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskEnvironment {
    NotStarted,
    Disposed,
    Stopped,
    Unreachable,
    Ready { environment_id: String },
}

impl TaskSummary {
    pub fn lane(&self) -> TaskLane {
        TaskLane::of(self.status)
    }

    pub fn label(&self) -> Option<TaskLabel> {
        task_label(self.status, self.attention.as_ref())
    }

    pub fn environment(&self) -> TaskEnvironment {
        let Some(workspace) = &self.workspace else {
            return match self.lane() {
                TaskLane::Backlog | TaskLane::Todo => TaskEnvironment::NotStarted,
                _ => TaskEnvironment::Disposed,
            };
        };
        if workspace.status == "removing" || workspace.status == "removed" {
            return TaskEnvironment::Disposed;
        }
        if workspace.power_state == Some(PowerState::Stopped) {
            return TaskEnvironment::Stopped;
        }
        match &workspace.conn_environment_id {
            None => TaskEnvironment::Unreachable,
            Some(id) => TaskEnvironment::Ready {
                environment_id: id.clone(),
            },
        }
    }
}
