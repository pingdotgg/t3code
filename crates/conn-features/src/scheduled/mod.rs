//! Scheduled tasks: the store, the schedule rules, the timer, and runs that start turns
//! through the engine. Behaviour follows `apps/server/src/scheduledTasks/ScheduledTaskService.ts`;
//! `README.md` lists where it differs.
//!
//! State lives in `<state-dir>/scheduled-tasks.json`, written whole and atomically after each
//! change, and in memory as the list of tasks (at most [`MAX_TASKS`]). One task (the timer)
//! sleeps until the earliest next run, or until a change; it never polls.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use conn_contract::{
    ModelSelection, OrchestrationV2Actor, OrchestrationV2CreationSource,
    OrchestrationV2ThreadLaunchWorkspaceStrategy, ProviderInteractionMode, RuntimeMode,
    ScheduledTask, ScheduledTaskListResult, ScheduledTaskRunStatus, ScheduledTaskSchedule,
    ScheduledTaskThreadMode, from_json, to_json,
};
use conn_engine::BoxFuture;
use jiff::tz::TimeZone;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, mpsc, watch};

use crate::clock::Clock;

mod engine;
pub mod schedule;

pub use engine::EngineRunner;

/// `resolveScheduledTaskBaseRef`: the primary remote's default branch (or `main`, `master`)
/// when that remote ref exists, else a local `main` or `master`, else `main`. A run's worktree
/// starts there, so each run sees the newest default branch.
pub async fn base_ref(project_root: &Path) -> String {
    use conn_vcs::repo::{primary_remote, ref_exists, remote_default_branch};
    const CONVENTIONAL: [&str; 2] = ["main", "master"];
    if let Ok(Some(remote)) = primary_remote(project_root).await {
        let default = remote_default_branch(project_root, &remote)
            .await
            .ok()
            .flatten();
        for branch in default.iter().map(String::as_str).chain(CONVENTIONAL) {
            let full = format!("refs/remotes/{remote}/{branch}");
            if ref_exists(project_root, &full).await.unwrap_or(false) {
                return format!("{remote}/{branch}");
            }
        }
    }
    for branch in CONVENTIONAL {
        if ref_exists(project_root, &format!("refs/heads/{branch}"))
            .await
            .unwrap_or(false)
        {
            return branch.to_owned();
        }
    }
    "main".to_owned()
}
use schedule::{format_iso, is_missed_fixed_time_run, is_same_schedule, next_run_at, parse_iso};

/// The most tasks one server keeps. The T3 server has no limit; a bound keeps the list, the
/// file and every subscriber's copy small.
pub const MAX_TASKS: usize = 500;
/// The longest the timer sleeps before it reads the wall clock again, so a clock change or a
/// host that slept is seen within this time (the T3 server's due hint ages out after the same).
const MAX_SLEEP: Duration = Duration::from_secs(10 * 60);
/// `RUN_OUTCOME_WAIT_MS`: how long a run's outcome is followed after its message went out.
pub const RUN_OUTCOME_WAIT: Duration = Duration::from_secs(24 * 60 * 60);
const FILE_NAME: &str = "scheduled-tasks.json";

/// `ScheduledTaskError`, the contract's failure for every scheduled task method.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TaskError {
    pub message: String,
    pub task_id: Option<String>,
}

impl TaskError {
    fn new(message: impl Into<String>, task_id: Option<&str>) -> Self {
        Self {
            message: message.into(),
            task_id: task_id.map(str::to_owned),
        }
    }

    /// The contract's tagged error.
    pub fn to_contract(&self) -> Value {
        let mut error = json!({"_tag": "ScheduledTaskError", "message": self.message});
        if let Some(id) = &self.task_id {
            error["taskId"] = json!(id);
        }
        error
    }
}

/// How a call fails: a typed task error, or input the contract's schema refuses (a defect
/// over RPC, as Effect answers a payload that does not decode).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Failure {
    #[error(transparent)]
    Task(#[from] TaskError),
    #[error("{0}")]
    Invalid(String),
}

/// `ScheduledTaskUpsertInput`, with the schedule kept as JSON until it is checked: a webhook
/// schedule may carry a signing secret, and this type never holds one.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub require_existing: Option<bool>,
    #[serde(default)]
    pub command_id: Option<String>,
    pub title: String,
    pub prompt: String,
    pub enabled: bool,
    pub schedule: Value,
    pub project_id: String,
    /// Absent and `null` both keep the stored binding (`input.threadId ?? existing.threadId`).
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub thread_mode: Option<ScheduledTaskThreadMode>,
    pub workspace_strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
    pub model_selection: ModelSelection,
    pub runtime_mode: RuntimeMode,
    pub interaction_mode: ProviderInteractionMode,
    #[serde(default)]
    pub created_by: Option<OrchestrationV2Actor>,
    #[serde(default)]
    pub creation_source: Option<OrchestrationV2CreationSource>,
}

impl std::fmt::Debug for UpsertInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The schedule is left out: a webhook schedule can carry a signing secret.
        f.debug_struct("UpsertInput")
            .field("id", &self.id)
            .field("title", &self.title)
            .field("project_id", &self.project_id)
            .finish_non_exhaustive()
    }
}

/// A thread's row as runs need it (`getThreadShell`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadShell {
    pub project_id: String,
    pub deleted: bool,
    pub archived: bool,
}

/// A new thread for a run (`ThreadLaunchService.launch`).
#[derive(Debug, Clone)]
pub struct LaunchRequest {
    pub command_id: String,
    pub project_id: String,
    pub title: String,
    pub model_selection: Value,
    pub runtime_mode: Value,
    pub interaction_mode: Value,
    pub workspace_strategy: Value,
    pub message_id: String,
    pub scheduled_task_id: String,
    pub text: String,
    pub created_by: Value,
    pub creation_source: Value,
}

/// A run in the bound thread (`ThreadManagementService.sendToThread`, mode `queue`).
#[derive(Debug, Clone)]
pub struct SendRequest {
    pub project_id: String,
    pub command_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub scheduled_task_id: String,
    pub text: String,
    pub created_by: Value,
    pub creation_source: Value,
    /// A `fresh_session` task: the run starts a new provider conversation (`freshContext`).
    pub fresh_context: bool,
}

/// Why a send failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SendError {
    /// `ThreadManagementThreadNotFoundError`: no such thread in that project.
    #[error("Thread {thread_id} was not found in project {project_id}.")]
    ThreadNotFound {
        project_id: String,
        thread_id: String,
    },
    #[error("{0}")]
    Other(String),
}

/// What a run needs from the engine. [`EngineRunner`] serves it; tests script it.
pub trait TaskRunner: Send + Sync + std::fmt::Debug {
    /// Starts a thread with the run's message; returns its id.
    fn launch(&self, request: LaunchRequest) -> BoxFuture<'_, Result<String, String>>;
    fn send(&self, request: SendRequest) -> BoxFuture<'_, Result<(), SendError>>;
    fn thread_shell(&self, thread_id: String)
    -> BoxFuture<'_, Result<Option<ThreadShell>, String>>;
    /// Whether a queued run in the thread holds a message of this task.
    fn has_queued_occurrence(
        &self,
        task_id: String,
        thread_id: String,
    ) -> BoxFuture<'_, Result<bool, String>>;
    /// Waits for the run of `message_id` to end, at most [`RUN_OUTCOME_WAIT`]. `Some(error)`
    /// when it ended without success and still holds the message (`recordRunFailure`).
    fn run_outcome(&self, thread_id: String, message_id: String) -> BoxFuture<'_, Option<String>>;
}

/// What runs a task: the timer, a person, or an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trigger {
    Scheduled,
    Manual,
}

impl Trigger {
    fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Manual => "manual",
        }
    }
}

/// The result of a run: the task as stored after it, and the thread it went to.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub task: ScheduledTask,
    pub thread_id: Option<String>,
}

/// The settings a service starts with.
#[derive(Debug)]
pub struct Config {
    pub state_dir: PathBuf,
    pub clock: Arc<dyn Clock>,
    pub zone: TimeZone,
    pub runner: Arc<dyn TaskRunner>,
    /// `false` leaves the timer parked: only `runNow` runs tasks. Tests use it as the T3
    /// server's tests park their scheduler.
    pub start_timer: bool,
}

/// The scheduled task service. Clones share one store and one timer.
#[derive(Clone, Debug)]
pub struct ScheduledTasks {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    clock: Arc<dyn Clock>,
    zone: TimeZone,
    runner: Arc<dyn TaskRunner>,
    /// The store: every task, in no order. Held across a file write so writes land in order.
    tasks: Mutex<Vec<ScheduledTask>>,
    /// Tasks with a run between its start and its record (`activeRuns`).
    active: StdMutex<HashSet<String>>,
    /// One outcome follower per task, the newest run's.
    followers: StdMutex<HashMap<String, tokio::task::AbortHandle>>,
    /// Bumped on every change; subscribers list again.
    changes: watch::Sender<u64>,
    /// Wakes the timer to plan again.
    wake: Notify,
}

impl std::fmt::Debug for Inner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScheduledTasks")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

/// Loads the stored tasks. A file that does not parse moves aside, so the server still starts;
/// a task that does not decode is dropped with a warning (the T3 server skips such rows).
fn load(path: &Path) -> Vec<ScheduledTask> {
    let text = match std::fs::read(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            eprintln!("scheduled tasks: cannot read {}: {error}", path.display());
            return Vec::new();
        }
    };
    let rows = match serde_json::from_slice::<Value>(&text) {
        Ok(Value::Object(mut file)) => match file.remove("tasks") {
            Some(Value::Array(rows)) => rows,
            _ => Vec::new(),
        },
        _ => {
            let aside = path.with_extension("json.unreadable");
            eprintln!(
                "scheduled tasks: {} does not parse; moved to {}",
                path.display(),
                aside.display()
            );
            let _ = std::fs::rename(path, aside);
            return Vec::new();
        }
    };
    let mut tasks = Vec::with_capacity(rows.len().min(MAX_TASKS));
    for row in rows {
        match from_json::<ScheduledTask>(row) {
            Ok(task) if tasks.len() < MAX_TASKS => tasks.push(task),
            Ok(task) => eprintln!("scheduled tasks: over {MAX_TASKS}; dropped {}", task.id),
            Err(error) => eprintln!("scheduled tasks: skipped an undecodable task: {error}"),
        }
    }
    tasks
}

impl ScheduledTasks {
    /// Opens the store and starts the timer on the current runtime. Runs left `running` by a
    /// stopped server are recorded as failed first (`Run was interrupted by a server restart.`).
    pub async fn start(config: Config) -> Self {
        let path = config.state_dir.join(FILE_NAME);
        let read_path = path.clone();
        let tasks = tokio::task::spawn_blocking(move || load(&read_path))
            .await
            .unwrap_or_default();
        let (changes, _) = watch::channel(0);
        let service = Self {
            inner: Arc::new(Inner {
                path,
                clock: config.clock,
                zone: config.zone,
                runner: config.runner,
                tasks: Mutex::new(tasks),
                active: StdMutex::new(HashSet::new()),
                followers: StdMutex::new(HashMap::new()),
                changes,
                wake: Notify::new(),
            }),
        };
        service.recover_interrupted_runs().await;
        if config.start_timer {
            let timer = service.clone();
            tokio::spawn(async move { timer.run_timer().await });
        }
        service
    }

    fn now(&self) -> i64 {
        self.inner.clock.now_ms()
    }

    /// The server's IANA zone, for the list result.
    fn time_zone(&self) -> Option<String> {
        self.inner.zone.iana_name().map(str::to_owned)
    }

    fn notify_changed(&self) {
        self.inner
            .changes
            .send_modify(|version| *version = version.wrapping_add(1));
        self.inner.wake.notify_one();
    }

    async fn persist(&self, tasks: &[ScheduledTask]) -> Result<(), String> {
        let body = json!({"version": 1, "tasks": tasks}).to_string();
        let path = self.inner.path.clone();
        tokio::task::spawn_blocking(move || conn_support::fs::write_private(&path, body.as_bytes()))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }

    /// Writes the store, mapping a failure to the task error T3 uses for that write.
    async fn save(
        &self,
        tasks: &[ScheduledTask],
        message: &str,
        task_id: Option<&str>,
    ) -> Result<(), TaskError> {
        self.persist(tasks).await.map_err(|error| {
            eprintln!("scheduled tasks: {message} {error}");
            TaskError::new(message, task_id)
        })
    }

    /// `list`: newest first by creation, then by id, so toggles and runs never reorder.
    pub async fn list(&self) -> ScheduledTaskListResult {
        let mut tasks = self.inner.tasks.lock().await.clone();
        tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        ScheduledTaskListResult {
            tasks: tasks.into_iter().map(Some).collect(),
            time_zone: self.time_zone(),
        }
    }

    /// `subscribeList`: the list now, then again after each change. A slow reader sees only
    /// the newest list, never a backlog.
    pub fn subscribe(&self) -> mpsc::Receiver<ScheduledTaskListResult> {
        let (tx, rx) = mpsc::channel(1);
        let service = self.clone();
        let mut changes = self.inner.changes.subscribe();
        tokio::spawn(async move {
            loop {
                changes.borrow_and_update();
                if tx.send(service.list().await).await.is_err() {
                    return;
                }
                tokio::select! {
                    changed = changes.changed() => if changed.is_err() { return },
                    () = tx.closed() => return,
                }
            }
        });
        rx
    }

    /// Changes stored rows directly, as T3's tests write SQL beside the service.
    #[cfg(test)]
    async fn edit_store(&self, edit: impl FnOnce(&mut Vec<ScheduledTask>)) {
        let mut tasks = self.inner.tasks.lock().await;
        edit(&mut tasks);
        let _ = self.persist(&tasks).await;
    }

    pub async fn find(&self, id: &str) -> Option<ScheduledTask> {
        self.inner
            .tasks
            .lock()
            .await
            .iter()
            .find(|t| t.id == id)
            .cloned()
    }

    async fn load_task(&self, id: &str) -> Result<ScheduledTask, TaskError> {
        self.find(id)
            .await
            .ok_or_else(|| TaskError::new("Schedule task not found.", Some(id)))
    }

    /// `upsert`: creates or edits a task. An edit that leaves the schedule and `enabled` as
    /// they were keeps the next run; a one-time run in the past is refused.
    pub async fn upsert(&self, input: UpsertInput) -> Result<ScheduledTask, Failure> {
        let title = input.title.trim();
        let prompt = input.prompt.trim();
        if title.is_empty() || prompt.is_empty() {
            return Err(Failure::Invalid(
                "Expected a non-blank string for title and prompt".into(),
            ));
        }
        let Some(schedule) =
            schedule::decode_upsert_schedule(&input.schedule).map_err(|e| Failure::Invalid(e.0))?
        else {
            return Err(TaskError::new(
                "This server does not run webhook tasks yet.",
                input.id.as_deref(),
            )
            .into());
        };
        let now = self.now();
        let id = match (&input.id, &input.command_id) {
            (Some(id), _) => id.clone(),
            (None, Some(command)) => format!("scheduled-task:{command}"),
            (None, None) => format!("scheduled-task:{}", conn_support::uuid_v4()),
        };
        let mut tasks = self.inner.tasks.lock().await;
        let existing = tasks.iter().find(|t| t.id == id).cloned();
        if input.require_existing == Some(true) && existing.is_none() {
            return Err(TaskError::new("Schedule task not found.", Some(&id)).into());
        }
        if existing.is_none() && tasks.len() >= MAX_TASKS {
            return Err(TaskError::new(
                format!("This server keeps at most {MAX_TASKS} scheduled tasks. Delete one first."),
                Some(&id),
            )
            .into());
        }
        let thread_mode = resolve_thread_mode(&input, existing.as_ref());
        let kept_thread = input
            .thread_id
            .clone()
            .or_else(|| existing.as_ref().and_then(|t| t.thread_id.clone()));
        // A bound thread belongs to its project, so moving the task leaves it for a new one.
        let moved_off_thread = existing
            .as_ref()
            .is_some_and(|e| e.project_id != input.project_id && kept_thread == e.thread_id);
        let thread_id = if thread_mode == ScheduledTaskThreadMode::NewThread || moved_off_thread {
            None
        } else {
            kept_thread
        };
        // An unchanged destination is not checked again, so a task on an archived thread
        // stays editable.
        if let Some(thread) = &thread_id
            && Some(thread) != existing.as_ref().and_then(|e| e.thread_id.as_ref())
        {
            self.require_destination(thread, &input.project_id, &id)
                .await?;
        }
        let schedule_unchanged = existing.as_ref().is_some_and(|e| {
            e.enabled == input.enabled && is_same_schedule(&e.schedule, &schedule)
        });
        let next = if schedule_unchanged {
            existing.as_ref().and_then(|e| e.next_run_at.clone())
        } else {
            let next = self.next_run(input.enabled, &schedule, now);
            if input.enabled && matches!(schedule, ScheduledTaskSchedule::Once(_)) && next.is_none()
            {
                return Err(TaskError::new(
                    "The run time has passed. Pick a time in the future.",
                    Some(&id),
                )
                .into());
            }
            next
        };
        let creation_source = input
            .creation_source
            .unwrap_or(OrchestrationV2CreationSource::Web);
        let task = ScheduledTask {
            id: id.clone(),
            title: title.to_owned(),
            prompt: prompt.to_owned(),
            enabled: input.enabled,
            schedule,
            project_id: input.project_id.clone(),
            thread_id,
            thread_mode: Some(thread_mode),
            workspace_strategy: input.workspace_strategy.clone(),
            model_selection: input.model_selection.clone(),
            runtime_mode: input.runtime_mode,
            interaction_mode: input.interaction_mode,
            created_by: existing
                .as_ref()
                .map(|e| e.created_by)
                .or(input.created_by)
                .unwrap_or(OrchestrationV2Actor::User),
            creation_source,
            created_at: existing
                .as_ref()
                .map_or_else(|| format_iso(now), |e| e.created_at.clone()),
            updated_at: format_iso(now),
            next_run_at: next,
            last_run_at: existing.as_ref().and_then(|e| e.last_run_at.clone()),
            last_run_status: existing
                .as_ref()
                .map_or(ScheduledTaskRunStatus::Never, |e| e.last_run_status),
            last_run_error: existing.as_ref().and_then(|e| e.last_run_error.clone()),
            run_count: existing.as_ref().map_or(0, |e| e.run_count),
            webhook: None,
            blocked_by_policy: None,
        };
        let mut next_tasks = tasks.clone();
        match next_tasks.iter_mut().find(|t| t.id == id) {
            Some(slot) => *slot = task.clone(),
            None => next_tasks.push(task.clone()),
        }
        self.save(&next_tasks, "Could not save schedule task.", Some(&id))
            .await?;
        *tasks = next_tasks;
        drop(tasks);
        self.notify_changed();
        Ok(task)
    }

    async fn require_destination(
        &self,
        thread_id: &str,
        project_id: &str,
        task_id: &str,
    ) -> Result<(), TaskError> {
        let shell = self
            .inner
            .runner
            .thread_shell(thread_id.to_owned())
            .await
            .map_err(|_| TaskError::new("Could not read the destination thread.", Some(task_id)))?;
        match shell {
            None => Err(TaskError::new(
                "That thread no longer exists.",
                Some(task_id),
            )),
            Some(shell) if shell.deleted => Err(TaskError::new(
                "That thread no longer exists.",
                Some(task_id),
            )),
            Some(shell) if shell.archived => Err(TaskError::new(
                "That thread is archived. Unarchive it or pick another destination.",
                Some(task_id),
            )),
            Some(shell) if shell.project_id != project_id => Err(TaskError::new(
                "That thread belongs to a different project.",
                Some(task_id),
            )),
            Some(_) => Ok(()),
        }
    }

    fn next_run(
        &self,
        enabled: bool,
        schedule: &ScheduledTaskSchedule,
        from: i64,
    ) -> Option<String> {
        if !enabled {
            return None;
        }
        next_run_at(schedule, from, &self.inner.zone).map(format_iso)
    }

    /// `nextRunAfterRun`: a one-time task counts from the run's start, so a manual run that
    /// began before its time does not use it up.
    fn next_run_after_run(
        &self,
        task: &ScheduledTask,
        started: Option<&str>,
        now: i64,
    ) -> Option<String> {
        let from = match (&task.schedule, started.and_then(parse_iso)) {
            (ScheduledTaskSchedule::Once(_), Some(started)) => started,
            _ => now,
        };
        self.next_run(task.enabled, &task.schedule, from)
    }

    /// `setEnabled`. Pausing clears the next run; resuming plans it from now.
    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<ScheduledTask, TaskError> {
        let mut tasks = self.inner.tasks.lock().await;
        let Some(index) = tasks.iter().position(|t| t.id == id) else {
            return Err(TaskError::new("Schedule task not found.", Some(id)));
        };
        let mut next_tasks = tasks.clone();
        let Some(task) = next_tasks.get_mut(index) else {
            return Err(TaskError::new("Schedule task not found.", Some(id)));
        };
        if task.enabled == enabled {
            return Ok(task.clone());
        }
        let now = self.now();
        let next = self.next_run(enabled, &task.schedule, now);
        if enabled && matches!(task.schedule, ScheduledTaskSchedule::Once(_)) && next.is_none() {
            return Err(TaskError::new(
                "The run time has passed. Pick a time in the future.",
                Some(id),
            ));
        }
        task.enabled = enabled;
        task.next_run_at = next;
        task.updated_at = format_iso(now);
        let updated = task.clone();
        self.save(&next_tasks, "Could not update schedule task.", Some(id))
            .await?;
        *tasks = next_tasks;
        drop(tasks);
        self.notify_changed();
        Ok(updated)
    }

    /// `delete`: answers with the id whether or not the task existed, as T3.
    pub async fn delete(&self, id: &str) -> Result<String, TaskError> {
        let mut tasks = self.inner.tasks.lock().await;
        let next_tasks: Vec<ScheduledTask> = tasks.iter().filter(|t| t.id != id).cloned().collect();
        self.save(&next_tasks, "Could not delete schedule task.", Some(id))
            .await?;
        *tasks = next_tasks;
        drop(tasks);
        self.forget(id);
        self.notify_changed();
        Ok(id.to_owned())
    }

    /// `deleteForThread`: removes the tasks still bound to a deleted thread.
    pub async fn delete_for_thread(&self, thread_id: &str) -> Result<(), TaskError> {
        let mut tasks = self.inner.tasks.lock().await;
        let (removed, kept): (Vec<_>, Vec<_>) = tasks
            .iter()
            .cloned()
            .partition(|t| t.thread_id.as_deref() == Some(thread_id));
        if removed.is_empty() {
            return Ok(());
        }
        self.save(&kept, "Could not delete thread's schedule tasks.", None)
            .await?;
        *tasks = kept;
        drop(tasks);
        for task in &removed {
            self.forget(&task.id);
        }
        self.notify_changed();
        Ok(())
    }

    fn forget(&self, id: &str) {
        if let Ok(mut followers) = self.inner.followers.lock()
            && let Some(follower) = followers.remove(id)
        {
            follower.abort();
        }
    }

    /// `runNow`: runs the task at once, also while it is paused. Answers after the run's
    /// message went out, with the thread or `None` when the dispatch failed. The run belongs
    /// to the caller, as in the T3 server: when the caller stops waiting, the run stops and is
    /// recorded as failed ([`INTERRUPTED_RUN`]).
    pub async fn run_now(&self, id: &str) -> Result<RunOutcome, TaskError> {
        let task = self.load_task(id).await?;
        if matches!(task.schedule, ScheduledTaskSchedule::Webhook(_)) {
            return Err(TaskError::new(
                "Webhook tasks run when their URL receives a request.",
                Some(id),
            ));
        }
        self.run_task(task, Trigger::Manual).await
    }

    /// `releaseStuckRun`: a run that stopped before it recorded its end is recorded as failed,
    /// while its row is still marked running.
    async fn release_stuck_run(&self, id: &str, started_iso: &str, message: &str) {
        let now = self.now();
        let mut tasks = self.inner.tasks.lock().await;
        let mut next_tasks = tasks.clone();
        let Some(slot) = next_tasks
            .iter_mut()
            .find(|t| t.id == id && t.last_run_status == ScheduledTaskRunStatus::Running)
        else {
            return;
        };
        let mut source = slot.clone();
        source.last_run_at = Some(started_iso.to_owned());
        slot.last_run_status = ScheduledTaskRunStatus::Failed;
        slot.last_run_error = Some(message.to_owned());
        slot.next_run_at = self.next_run_after_run(&source, Some(started_iso), now);
        slot.updated_at = format_iso(now);
        slot.run_count = slot.run_count.saturating_add(1);
        if self.persist(&next_tasks).await.is_ok() {
            *tasks = next_tasks;
            drop(tasks);
            self.notify_changed();
        }
    }

    /// `runTask`.
    async fn run_task(
        &self,
        task: ScheduledTask,
        trigger: Trigger,
    ) -> Result<RunOutcome, TaskError> {
        let started = self.now();
        let Some(_reservation) = Reservation::take(&self.inner, &task.id) else {
            return match trigger {
                Trigger::Manual => Err(TaskError::new(
                    "Schedule task is already running.",
                    Some(&task.id),
                )),
                Trigger::Scheduled => Ok(RunOutcome {
                    task,
                    thread_id: None,
                }),
            };
        };
        // Read again, so a task deleted, paused or moved since the timer read it cannot fire.
        let Some(active) = self.find(&task.id).await else {
            return match trigger {
                Trigger::Manual => Err(TaskError::new("Schedule task not found.", Some(&task.id))),
                Trigger::Scheduled => Ok(RunOutcome {
                    task,
                    thread_id: None,
                }),
            };
        };
        if trigger == Trigger::Scheduled {
            let due = active.next_run_at.as_deref().and_then(parse_iso);
            if !active.enabled || due.is_none_or(|due| due > started) {
                return Ok(RunOutcome {
                    task: active,
                    thread_id: None,
                });
            }
            // A thread that stays busy would otherwise collect one copy of the prompt per
            // interval. A failed read falls through to the normal send.
            if !matches!(active.schedule, ScheduledTaskSchedule::Once(_))
                && let Some(thread) = &active.thread_id
                && self
                    .inner
                    .runner
                    .has_queued_occurrence(active.id.clone(), thread.clone())
                    .await
                    .unwrap_or(false)
            {
                self.reschedule_missed(&active, started, None).await;
                return Ok(RunOutcome {
                    task: active,
                    thread_id: None,
                });
            }
        }
        let started_iso = format_iso(started);
        self.mark_running(&active.id, &started_iso).await?;
        // From here a dropped run records its failure, as T3's `onError` does.
        let mut stuck = StuckRun {
            service: Some(self.clone()),
            id: active.id.clone(),
            started_iso: started_iso.clone(),
        };
        let fire_key = format!("{}:{started}:{}", active.id, trigger.as_str());
        let command_id = format!("scheduled-task:{fire_key}");
        let message_id = format!("scheduled-task-message:{fire_key}");
        let thread_mode = thread_mode_of(&active);
        let dispatched = match &active.thread_id {
            None => {
                let launched = self
                    .inner
                    .runner
                    .launch(LaunchRequest {
                        command_id,
                        project_id: active.project_id.clone(),
                        title: active.title.clone(),
                        model_selection: to_json(&active.model_selection),
                        runtime_mode: to_json(&active.runtime_mode),
                        interaction_mode: to_json(&active.interaction_mode),
                        workspace_strategy: to_json(&active.workspace_strategy),
                        message_id: message_id.clone(),
                        scheduled_task_id: active.id.clone(),
                        text: active.prompt.clone(),
                        created_by: to_json(&active.created_by),
                        creation_source: to_json(&active.creation_source),
                    })
                    .await;
                if let Ok(thread) = &launched
                    && thread_mode != ScheduledTaskThreadMode::NewThread
                {
                    self.bind_thread(&active, thread).await;
                }
                launched
            }
            Some(thread) => self
                .send_bound(&active, thread, &command_id, &message_id)
                .await
                .map(|()| thread.clone())
                .map_err(|e| e.to_string()),
        };
        let completed = self.now();
        let (status, error, thread_id) = match dispatched {
            Ok(thread) => (ScheduledTaskRunStatus::Succeeded, None, Some(thread)),
            Err(error) => (ScheduledTaskRunStatus::Failed, Some(error), None),
        };
        let recorded = self
            .record_completion(&task, &started_iso, started, completed, status, error)
            .await;
        stuck.service = None;
        let (recorded, written) = recorded?;
        if written && let Some(thread) = &thread_id {
            self.follow_outcome(&active.id, &started_iso, thread, &message_id);
        }
        Ok(RunOutcome {
            task: recorded,
            thread_id,
        })
    }

    /// A bound run follows its thread when it moved to another project during the send; one
    /// move needs at most two retries. The same ids replay safely.
    async fn send_bound(
        &self,
        task: &ScheduledTask,
        thread_id: &str,
        command_id: &str,
        message_id: &str,
    ) -> Result<(), SendError> {
        let mut project_id = task.project_id.clone();
        let mut retries = 2;
        loop {
            let sent = self
                .inner
                .runner
                .send(SendRequest {
                    project_id: project_id.clone(),
                    command_id: command_id.to_owned(),
                    thread_id: thread_id.to_owned(),
                    message_id: message_id.to_owned(),
                    scheduled_task_id: task.id.clone(),
                    text: task.prompt.clone(),
                    created_by: to_json(&task.created_by),
                    creation_source: to_json(&task.creation_source),
                    fresh_context: thread_mode_of(task) == ScheduledTaskThreadMode::FreshSession,
                })
                .await;
            match sent {
                Err(error @ SendError::ThreadNotFound { .. }) if retries > 0 => {
                    retries -= 1;
                    let shell = self
                        .inner
                        .runner
                        .thread_shell(thread_id.to_owned())
                        .await
                        .ok()
                        .flatten();
                    match shell {
                        Some(shell) if shell.project_id != project_id => {
                            project_id = shell.project_id
                        }
                        _ => return Err(error),
                    }
                }
                other => return other,
            }
        }
    }

    async fn mark_running(&self, id: &str, started_iso: &str) -> Result<(), TaskError> {
        let mut tasks = self.inner.tasks.lock().await;
        let mut next_tasks = tasks.clone();
        let Some(task) = next_tasks.iter_mut().find(|t| t.id == id) else {
            return Err(TaskError::new("Schedule task not found.", Some(id)));
        };
        task.updated_at = started_iso.to_owned();
        task.last_run_at = Some(started_iso.to_owned());
        task.last_run_status = ScheduledTaskRunStatus::Running;
        task.last_run_error = None;
        self.save(
            &next_tasks,
            "Could not mark schedule task as running.",
            Some(id),
        )
        .await?;
        *tasks = next_tasks;
        drop(tasks);
        self.notify_changed();
        Ok(())
    }

    /// Records the end of a dispatch on the row this run marked running. A row deleted or
    /// recreated meanwhile is not this run's: the stored row is reported and left as it is.
    async fn record_completion(
        &self,
        task: &ScheduledTask,
        started_iso: &str,
        started: i64,
        completed: i64,
        status: ScheduledTaskRunStatus,
        error: Option<String>,
    ) -> Result<(ScheduledTask, bool), TaskError> {
        let mut tasks = self.inner.tasks.lock().await;
        let current = tasks.iter().find(|t| t.id == task.id).cloned();
        let source = current.clone().unwrap_or_else(|| task.clone());
        let from = if matches!(source.schedule, ScheduledTaskSchedule::Once(_)) {
            started
        } else {
            completed
        };
        let mut done = source.clone();
        done.updated_at = format_iso(completed);
        done.last_run_at = Some(started_iso.to_owned());
        done.next_run_at = self.next_run(source.enabled, &source.schedule, from);
        done.last_run_status = status;
        done.last_run_error = error;
        done.run_count = source.run_count.saturating_add(1);
        let Some(current) = current else {
            return Ok((done, false));
        };
        let ours = current.last_run_status == ScheduledTaskRunStatus::Running
            && current.last_run_at.as_deref() == Some(started_iso);
        if !ours {
            return Ok((current, false));
        }
        let mut next_tasks = tasks.clone();
        if let Some(slot) = next_tasks.iter_mut().find(|t| t.id == task.id) {
            slot.updated_at = done.updated_at.clone();
            slot.next_run_at = done.next_run_at.clone();
            slot.last_run_status = done.last_run_status;
            slot.last_run_error = done.last_run_error.clone();
            slot.run_count = done.run_count;
            done = slot.clone();
        }
        if let Err(error) = self
            .save(
                &next_tasks,
                "Could not record schedule task run.",
                Some(&task.id),
            )
            .await
        {
            // Keep the record in memory: the timer skips running rows, so this run must end.
            *tasks = next_tasks;
            drop(tasks);
            self.notify_changed();
            return Err(error);
        }
        *tasks = next_tasks;
        drop(tasks);
        self.notify_changed();
        Ok((done, true))
    }

    /// `bindThread`: a continuing task keeps the thread its first run launched. A thread
    /// deleted before the binding landed already ran its cleanup, so that cleanup runs here.
    async fn bind_thread(&self, task: &ScheduledTask, thread_id: &str) {
        {
            let mut tasks = self.inner.tasks.lock().await;
            let mut next_tasks = tasks.clone();
            let Some(slot) = next_tasks.iter_mut().find(|t| {
                t.id == task.id
                    && t.created_at == task.created_at
                    && t.project_id == task.project_id
                    && t.thread_id.is_none()
                    && thread_mode_of(t) != ScheduledTaskThreadMode::NewThread
            }) else {
                return;
            };
            slot.thread_id = Some(thread_id.to_owned());
            if self
                .save(
                    &next_tasks,
                    "Could not bind a scheduled task to its first thread.",
                    Some(&task.id),
                )
                .await
                .is_err()
            {
                return;
            }
            *tasks = next_tasks;
        }
        self.notify_changed();
        match self.inner.runner.thread_shell(thread_id.to_owned()).await {
            Ok(None) => {
                let _ = self.delete_for_thread(thread_id).await;
            }
            Ok(Some(shell)) if shell.deleted => {
                let _ = self.delete_for_thread(thread_id).await;
            }
            _ => {}
        }
    }

    /// `recordRunFailure`: the provider can still refuse a turn after its message was
    /// accepted, so the run is followed and a failure replaces the recorded success.
    fn follow_outcome(&self, task_id: &str, started_iso: &str, thread_id: &str, message_id: &str) {
        let service = self.clone();
        let (task_id, started_iso) = (task_id.to_owned(), started_iso.to_owned());
        let (thread_id, message_id) = (thread_id.to_owned(), message_id.to_owned());
        let key = task_id.clone();
        let handle = tokio::spawn(async move {
            let Some(error) = service
                .inner
                .runner
                .run_outcome(thread_id, message_id)
                .await
            else {
                return;
            };
            let mut tasks = service.inner.tasks.lock().await;
            let mut next_tasks = tasks.clone();
            let Some(slot) = next_tasks.iter_mut().find(|t| {
                t.id == task_id
                    && t.last_run_at.as_deref() == Some(started_iso.as_str())
                    && t.last_run_status == ScheduledTaskRunStatus::Succeeded
            }) else {
                return;
            };
            slot.last_run_status = ScheduledTaskRunStatus::Failed;
            slot.last_run_error = Some(error);
            if service.persist(&next_tasks).await.is_ok() {
                *tasks = next_tasks;
                drop(tasks);
                service.notify_changed();
            }
        });
        if let Ok(mut followers) = self.inner.followers.lock()
            && let Some(previous) = followers.insert(key, handle.abort_handle())
        {
            previous.abort();
        }
    }

    /// `rescheduleMissedRun`: moves a skipped run on, only when the row is still the one the
    /// timer read (a run or edit since then already moved it).
    async fn reschedule_missed(&self, seen: &ScheduledTask, now: i64, run_error: Option<&str>) {
        let next = self.next_run(seen.enabled, &seen.schedule, now);
        let mut tasks = self.inner.tasks.lock().await;
        let mut next_tasks = tasks.clone();
        let Some(slot) = next_tasks.iter_mut().find(|t| {
            t.id == seen.id
                && t.next_run_at == seen.next_run_at
                && t.last_run_at == seen.last_run_at
        }) else {
            return;
        };
        slot.next_run_at = next;
        slot.updated_at = format_iso(now);
        if let Some(error) = run_error {
            slot.last_run_status = ScheduledTaskRunStatus::Failed;
            slot.last_run_error = Some(error.to_owned());
        }
        if self.persist(&next_tasks).await.is_ok() {
            *tasks = next_tasks;
            drop(tasks);
            self.notify_changed();
        }
    }

    /// Runs a stopped server left `running` are recorded as failed and planned again.
    async fn recover_interrupted_runs(&self) {
        let now = self.now();
        let mut tasks = self.inner.tasks.lock().await;
        if !tasks
            .iter()
            .any(|t| t.last_run_status == ScheduledTaskRunStatus::Running)
        {
            return;
        }
        let mut next_tasks = tasks.clone();
        for task in next_tasks
            .iter_mut()
            .filter(|t| t.last_run_status == ScheduledTaskRunStatus::Running)
        {
            task.next_run_at = self.next_run_after_run(task, task.last_run_at.as_deref(), now);
            task.last_run_status = ScheduledTaskRunStatus::Failed;
            task.last_run_error = Some("Run was interrupted by a server restart.".into());
            task.updated_at = format_iso(now);
            task.run_count = task.run_count.saturating_add(1);
        }
        if let Err(error) = self.persist(&next_tasks).await {
            eprintln!("scheduled tasks: could not reset interrupted runs: {error}");
        }
        *tasks = next_tasks;
        drop(tasks);
        self.notify_changed();
    }

    /// The earliest next run of an enabled task that is not running.
    async fn next_due(&self) -> Option<i64> {
        self.inner
            .tasks
            .lock()
            .await
            .iter()
            .filter(|t| t.enabled && t.last_run_status != ScheduledTaskRunStatus::Running)
            .filter_map(|t| t.next_run_at.as_deref().and_then(parse_iso))
            .min()
    }

    /// `runDueTasks`: due tasks one after another, oldest due first. A fixed time more than
    /// ten minutes late was missed (the server was off) and moves to its next slot.
    async fn run_due(&self) {
        let now = self.now();
        let mut due: Vec<(i64, ScheduledTask)> = self
            .inner
            .tasks
            .lock()
            .await
            .iter()
            .filter(|t| t.enabled && t.last_run_status != ScheduledTaskRunStatus::Running)
            .filter_map(|t| {
                let at = t.next_run_at.as_deref().and_then(parse_iso)?;
                (at <= now).then(|| (at, t.clone()))
            })
            .collect();
        due.sort_by(|(a, x), (b, y)| a.cmp(b).then(x.id.cmp(&y.id)));
        for (at, task) in due {
            if is_missed_fixed_time_run(&task.schedule, at, now) {
                self.reschedule_missed(
                    &task,
                    now,
                    Some("Missed a scheduled run because the server was not running at that time."),
                )
                .await;
            } else if let Err(error) = self.run_task(task, Trigger::Scheduled).await {
                eprintln!("scheduled tasks: a scheduled run failed: {error}");
            }
        }
    }

    /// The timer: sleeps until the earliest next run or a change, then runs what is due.
    async fn run_timer(&self) {
        loop {
            self.run_due().await;
            let wait = self.next_due().await.map(|at| {
                Duration::from_millis(u64::try_from(at - self.now()).unwrap_or(0)).min(MAX_SLEEP)
            });
            match wait {
                Some(wait) => {
                    tokio::select! {
                        () = tokio::time::sleep(wait) => {}
                        () = self.inner.wake.notified() => {}
                    }
                }
                None => self.inner.wake.notified().await,
            }
        }
    }
}

/// `scheduledTaskThreadMode`: tasks stored before thread modes continue a bound thread.
pub fn thread_mode_of(task: &ScheduledTask) -> ScheduledTaskThreadMode {
    task.thread_mode.unwrap_or(if task.thread_id.is_none() {
        ScheduledTaskThreadMode::NewThread
    } else {
        ScheduledTaskThreadMode::Continue
    })
}

/// `resolveThreadMode`: an edit keeps the stored mode; binding a thread to a new-thread task
/// continues it.
fn resolve_thread_mode(
    input: &UpsertInput,
    existing: Option<&ScheduledTask>,
) -> ScheduledTaskThreadMode {
    if let Some(mode) = input.thread_mode {
        return mode;
    }
    let stored = existing.map_or(ScheduledTaskThreadMode::NewThread, thread_mode_of);
    if stored == ScheduledTaskThreadMode::NewThread && input.thread_id.is_some() {
        ScheduledTaskThreadMode::Continue
    } else {
        stored
    }
}

/// What a run that stops without an end records: T3's text for an interrupt-only cause
/// (`Cause.squash`).
pub const INTERRUPTED_RUN: &str = "All fibers interrupted without error";

/// Armed while a run is marked running and has not recorded its end. Dropped armed (the
/// caller of `runNow` stopped waiting), it records the run as failed.
struct StuckRun {
    service: Option<ScheduledTasks>,
    id: String,
    started_iso: String,
}

impl Drop for StuckRun {
    fn drop(&mut self) {
        let Some(service) = self.service.take() else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let (id, started_iso) = (
            std::mem::take(&mut self.id),
            std::mem::take(&mut self.started_iso),
        );
        runtime.spawn(async move {
            service
                .release_stuck_run(&id, &started_iso, INTERRUPTED_RUN)
                .await;
        });
    }
}

/// A task's place in `active` for the length of one run; released on drop, also when the
/// run's future is dropped.
struct Reservation<'a> {
    inner: &'a Inner,
    id: String,
}

impl<'a> Reservation<'a> {
    fn take(inner: &'a Inner, id: &str) -> Option<Self> {
        let mut active = inner.active.lock().ok()?;
        active.insert(id.to_owned()).then(|| Self {
            inner,
            id: id.to_owned(),
        })
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.inner.active.lock() {
            active.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests;
