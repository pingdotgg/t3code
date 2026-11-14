//! Cases from `apps/server/src/scheduledTasks/ScheduledTaskService.test.ts`,
//! `.schedule.test.ts` and `.interval.test.ts`, on a paused tokio clock. Each test names the
//! T3 case it ports. Webhook cases are in `webhook/tests.rs`; managed policy is not
//! built.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use conn_contract::{
    ScheduledTask, ScheduledTaskRunStatus, ScheduledTaskThreadMode, from_json, to_json,
};
use conn_engine::BoxFuture;
use jiff::tz::TimeZone;
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};

use super::{
    Config, Failure, LaunchRequest, ScheduledTasks, SendError, SendRequest, TaskRunner,
    ThreadShell, UpsertInput,
    schedule::{format_iso, parse_iso},
};
use crate::clock::TestClock;

type Launch =
    Box<dyn Fn(LaunchRequest) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;
type SendFn = Box<dyn Fn(SendRequest) -> BoxFuture<'static, Result<(), SendError>> + Send + Sync>;
type Shell = Box<dyn Fn(String) -> Option<ThreadShell> + Send + Sync>;
type Queued = Box<dyn Fn(String, String) -> bool + Send + Sync>;
type Outcome = Box<dyn Fn(String, String) -> BoxFuture<'static, Option<String>> + Send + Sync>;

/// `Layer.mock(ThreadLaunchService)` and `Layer.mock(ThreadManagementService)`: each part
/// answers as the test scripts it; an unscripted call fails as an unimplemented mock does.
pub(super) struct Fake {
    pub(super) launch: Launch,
    pub(super) send: SendFn,
    pub(super) shell: Shell,
    pub(super) queued: Queued,
    pub(super) outcome: Outcome,
}

impl std::fmt::Debug for Fake {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Fake")
    }
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            launch: Box::new(|_| Box::pin(async { Err("synthetic dispatch failure".to_owned()) })),
            send: Box::new(|_| Box::pin(async { Err(SendError::Other("not scripted".into())) })),
            shell: Box::new(|_| None),
            queued: Box::new(|_, _| false),
            outcome: Box::new(|_, _| Box::pin(async { None })),
        }
    }
}

impl TaskRunner for Fake {
    fn launch(&self, request: LaunchRequest) -> BoxFuture<'_, Result<String, String>> {
        (self.launch)(request)
    }
    fn send(&self, request: SendRequest) -> BoxFuture<'_, Result<(), SendError>> {
        (self.send)(request)
    }
    fn thread_shell(
        &self,
        thread_id: String,
    ) -> BoxFuture<'_, Result<Option<ThreadShell>, String>> {
        let shell = (self.shell)(thread_id);
        Box::pin(async move { Ok(shell) })
    }
    fn has_queued_occurrence(
        &self,
        task: String,
        thread: String,
    ) -> BoxFuture<'_, Result<bool, String>> {
        let queued = (self.queued)(task, thread);
        Box::pin(async move { Ok(queued) })
    }
    fn run_outcome(&self, thread: String, message: String) -> BoxFuture<'_, Option<String>> {
        (self.outcome)(thread, message)
    }
}

pub(super) fn shell(project: &str) -> Option<ThreadShell> {
    Some(ThreadShell {
        project_id: project.to_owned(),
        deleted: false,
        archived: false,
    })
}

pub(super) struct Env {
    pub(super) dir: PathBuf,
    pub(super) clock: TestClock,
}

impl Env {
    pub(super) fn new(name: &str, now: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "conn-features-{name}-{}-{}",
            std::process::id(),
            conn_support::uuid_v4()
        ));
        Self {
            dir,
            clock: TestClock::new(ms(now)),
        }
    }

    pub(super) async fn start(&self, fake: Fake, zone: &str, timer: bool) -> ScheduledTasks {
        ScheduledTasks::start(Config {
            state_dir: self.dir.clone(),
            clock: Arc::new(self.clock.clone()),
            zone: TimeZone::get(zone).expect("zone"),
            runner: Arc::new(fake),
            start_timer: timer,
        })
        .await
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub(super) fn ms(text: &str) -> i64 {
    parse_iso(text).expect("time")
}

pub(super) fn input(extra: Value) -> UpsertInput {
    let mut base = json!({
        "title": "Interval review",
        "prompt": "Review the open pull requests.",
        "enabled": true,
        "schedule": {"type": "interval", "everyMs": 60_000},
        "projectId": "project-interval-duration",
        "workspaceStrategy": {"type": "root"},
        "modelSelection": {"instanceId": "codex", "model": "gpt-5.4"},
        "runtimeMode": "full-access",
        "interactionMode": "default",
    });
    if let (Some(base), Value::Object(extra)) = (base.as_object_mut(), extra) {
        base.extend(extra);
    }
    serde_json::from_value(base).expect("upsert input")
}

pub(super) async fn upsert(service: &ScheduledTasks, extra: Value) -> ScheduledTask {
    service.upsert(input(extra)).await.expect("saved")
}

pub(super) async fn failure(service: &ScheduledTasks, extra: Value) -> String {
    match service.upsert(input(extra)).await {
        Err(Failure::Task(error)) => error.message,
        other => panic!("expected a task error, got {other:?}"),
    }
}

pub(super) async fn tasks(service: &ScheduledTasks) -> Vec<ScheduledTask> {
    service.list().await.tasks.into_iter().flatten().collect()
}

fn next(task: &ScheduledTask) -> Option<&str> {
    task.next_run_at.as_deref()
}

/// `persists elapsed interval $zone from $from`.
#[tokio::test(start_paused = true)]
async fn intervals_persist_elapsed_time_through_pause_resume_and_a_failed_run() {
    for (zone, from, every, expected) in [
        (
            "America/New_York",
            "2026-03-08T06:30:00.000Z",
            7_200_000,
            "2026-03-08T08:30:00.000Z",
        ),
        (
            "America/New_York",
            "2026-11-01T05:30:00.000Z",
            7_200_000,
            "2026-11-01T07:30:00.000Z",
        ),
        (
            "America/New_York",
            "2026-11-01T06:30:00.000Z",
            60_000,
            "2026-11-01T06:31:00.000Z",
        ),
        (
            "UTC",
            "2026-11-01T06:30:00.000Z",
            60_000,
            "2026-11-01T06:31:00.000Z",
        ),
        (
            "Asia/Tokyo",
            "2026-03-08T06:30:00.000Z",
            7_200_000,
            "2026-03-08T08:30:00.000Z",
        ),
    ] {
        let env = Env::new("interval", from);
        let service = env.start(Fake::default(), zone, false).await;
        let created = upsert(
            &service,
            json!({"commandId": "interval-duration", "schedule": {"type": "interval", "everyMs": every}}),
        )
        .await;
        assert_eq!(next(&created), Some(expected), "{zone} created");
        assert_eq!(
            tasks(&service).await[0].next_run_at.as_deref(),
            Some(expected),
            "listed"
        );
        let paused = service
            .set_enabled(&created.id, false)
            .await
            .expect("pause");
        assert_eq!(next(&paused), None, "paused");
        let resumed = service
            .set_enabled(&created.id, true)
            .await
            .expect("resume");
        assert_eq!(next(&resumed), Some(expected), "resumed");
        let ran = service.run_now(&created.id).await.expect("ran");
        assert_eq!(
            ran.task.last_run_status,
            ScheduledTaskRunStatus::Failed,
            "dispatch failed"
        );
        assert_eq!(ran.thread_id, None, "no thread");
        assert_eq!(ran.task.run_count, 1, "counted");
        assert_eq!(next(&ran.task), Some(expected), "rescheduled from now");
        assert_eq!(
            ran.task.last_run_error.as_deref(),
            Some("synthetic dispatch failure"),
            "error kept"
        );
    }
}

/// `keeps fixed-time schedules on the local calendar from $from`.
#[tokio::test(start_paused = true)]
async fn fixed_times_stay_on_the_local_calendar() {
    for (from, expected) in [
        ("2026-03-07T23:30:00.000Z", "2026-03-08T13:00:00.000Z"),
        ("2026-10-31T23:30:00.000Z", "2026-11-01T14:00:00.000Z"),
    ] {
        let env = Env::new("fixed", from);
        let service = env.start(Fake::default(), "America/New_York", false).await;
        let created = upsert(
            &service,
            json!({"commandId": "fixed", "schedule": {"type": "fixed_time", "timeOfDay": "09:00"}}),
        )
        .await;
        assert_eq!(next(&created), Some(expected), "from {from}");
        assert_eq!(
            service.list().await.time_zone.as_deref(),
            Some("America/New_York"),
            "zone"
        );
    }
}

/// `runs a one-time schedule once and rejects past times`. Each launch takes two minutes, so a
/// manual run can start before the run time and end after it.
#[tokio::test(start_paused = true)]
async fn a_one_time_schedule_runs_once_and_refuses_past_times() {
    let env = Env::new("once", "2026-11-01T07:59:00.000Z");
    let fake = Fake {
        launch: Box::new(|_| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(120)).await;
                Err("synthetic".to_owned())
            })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let once = json!({"commandId": "once", "schedule": {"type": "once", "runAt": "2026-11-01T03:00:00-05:00"}});
    let created = upsert(&service, once.clone()).await;
    assert_eq!(
        to_json(&created.schedule),
        json!({"type": "once", "runAt": "2026-11-01T08:00:00.000Z"}),
        "stored as UTC"
    );
    assert_eq!(next(&created), Some("2026-11-01T08:00:00.000Z"));
    let early = service.run_now(&created.id).await.expect("early run");
    assert_eq!(
        next(&early.task),
        Some("2026-11-01T08:00:00.000Z"),
        "an early run keeps it"
    );
    let due = service.run_now(&created.id).await.expect("due run");
    assert_eq!(next(&due.task), None, "used up");
    assert_eq!(tasks(&service).await[0].next_run_at, None, "listed");
    service
        .set_enabled(&created.id, false)
        .await
        .expect("pause");
    let resumed = service
        .set_enabled(&created.id, true)
        .await
        .expect_err("past");
    assert_eq!(
        resumed.message,
        "The run time has passed. Pick a time in the future."
    );
    let mut late = once;
    late["commandId"] = Value::Null;
    late["title"] = json!("Late");
    if let Some(map) = late.as_object_mut() {
        map.remove("commandId");
    }
    assert_eq!(
        failure(&service, late).await,
        "The run time has passed. Pick a time in the future."
    );
}

/// `keeps a one-time run after a restart interrupts an earlier manual run`.
#[tokio::test(start_paused = true)]
async fn a_restart_keeps_a_one_time_run_an_interrupted_manual_run_did_not_use() {
    let env = Env::new("restart-once", "2026-11-01T07:59:00.000Z");
    let service = env.start(Fake::default(), "UTC", false).await;
    let created = upsert(
        &service,
        json!({"commandId": "once-race", "schedule": {"type": "once", "runAt": "2026-11-01T08:00:00Z"}}),
    )
    .await;
    service
        .edit_store(|tasks| {
            for task in tasks {
                task.last_run_status = ScheduledTaskRunStatus::Running;
                task.last_run_at = Some("2026-11-01T07:59:00.000Z".into());
            }
        })
        .await;
    env.clock.set(ms("2026-11-01T08:05:00.000Z"));
    let restarted = env.start(Fake::default(), "UTC", false).await;
    let listed = tasks(&restarted).await;
    assert_eq!(listed[0].id, created.id);
    assert_eq!(listed[0].last_run_status, ScheduledTaskRunStatus::Failed);
    assert_eq!(
        listed[0].last_run_error.as_deref(),
        Some("Run was interrupted by a server restart.")
    );
    assert_eq!(next(&listed[0]), Some("2026-11-01T08:00:00.000Z"));
    assert_eq!(listed[0].run_count, 1, "the interrupted run counts");
}

/// `reports the stored task when the row was replaced during the run`.
#[tokio::test(start_paused = true)]
async fn a_run_reports_the_stored_task_when_its_row_was_replaced() {
    let env = Env::new("replaced", "2026-11-01T07:00:00.000Z");
    let handle: Arc<StdMutex<Option<ScheduledTasks>>> = Arc::default();
    let inner = handle.clone();
    let fake = Fake {
        launch: Box::new(move |_| {
            let service = inner.lock().expect("lock").clone();
            Box::pin(async move {
                if let Some(service) = service {
                    service
                        .edit_store(|tasks| {
                            for task in tasks {
                                task.last_run_status = ScheduledTaskRunStatus::Never;
                                task.last_run_at = None;
                                task.run_count = 0;
                            }
                        })
                        .await;
                }
                Err("synthetic dispatch failure".to_owned())
            })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    *handle.lock().expect("lock") = Some(service.clone());
    let created = upsert(
        &service,
        json!({"commandId": "once-race", "schedule": {"type": "once", "runAt": "2026-11-01T08:00:00Z"}}),
    )
    .await;
    let ran = service.run_now(&created.id).await.expect("ran");
    assert_eq!(ran.task.run_count, 0, "the replacement's count");
    assert_eq!(ran.task.last_run_status, ScheduledTaskRunStatus::Never);
}

/// `rejects a stale form save after deletion while preserving explicit-id creates`.
#[tokio::test(start_paused = true)]
async fn a_stale_form_save_after_deletion_is_refused() {
    let env = Env::new("stale", "2026-07-01T09:00:00.000Z");
    let service = env.start(Fake::default(), "UTC", false).await;
    let base = json!({"id": "scheduled-task:edit-after-delete", "title": "Review"});
    let created = upsert(&service, base.clone()).await;
    let edit = json!({"id": "scheduled-task:edit-after-delete", "requireExisting": true, "title": "Edited"});
    assert_eq!(upsert(&service, edit.clone()).await.title, "Edited");
    service.delete(&created.id).await.expect("deleted");
    assert_eq!(failure(&service, edit).await, "Schedule task not found.");
    assert!(tasks(&service).await.is_empty(), "nothing listed");
    assert_eq!(
        upsert(&service, base).await.id,
        created.id,
        "an explicit id creates again"
    );
}

/// `preserves a due run when a save only pads the scheduled hour`.
#[tokio::test(start_paused = true)]
async fn a_padded_hour_keeps_a_due_run() {
    let due = "2026-07-01T13:00:00.000Z"; // 09:00 in New York
    let env = Env::new("padded", "2026-07-01T12:59:59.000Z");
    let service = env.start(Fake::default(), "America/New_York", false).await;
    let created = upsert(
        &service,
        json!({"commandId": "schedule-time-format", "creationSource": "mcp",
               "schedule": {"type": "fixed_time", "timeOfDay": "9:00"}}),
    )
    .await;
    assert_eq!(next(&created), Some(due));
    env.clock.set(ms("2026-07-01T13:00:01.000Z"));
    let update = json!({"id": created.id, "commandId": "schedule-time-format",
                        "schedule": {"type": "fixed_time", "timeOfDay": "09:00"}});
    assert_eq!(
        next(&upsert(&service, update.clone()).await),
        Some(due),
        "kept"
    );
    assert_eq!(
        tasks(&service).await[0].next_run_at.as_deref(),
        Some(due),
        "listed"
    );
    let mut moved = update;
    moved["schedule"]["timeOfDay"] = json!("09:30");
    assert_eq!(
        next(&upsert(&service, moved).await),
        Some("2026-07-01T13:30:00.000Z"),
        "a real change plans again"
    );
}

/// `keeps the task list order when a toggle or edit rewrites updated_at`.
#[tokio::test(start_paused = true)]
async fn toggles_and_edits_keep_the_list_order() {
    let env = Env::new("order", "2026-07-01T09:00:00.000Z");
    let service = env.start(Fake::default(), "UTC", false).await;
    let ids = || async {
        tasks(&service)
            .await
            .into_iter()
            .map(|t| t.id)
            .collect::<Vec<_>>()
    };
    let older = upsert(
        &service,
        json!({"id": "scheduled-task:older", "title": "older"}),
    )
    .await;
    tokio::time::advance(Duration::from_secs(1)).await;
    upsert(
        &service,
        json!({"id": "scheduled-task:newer", "title": "newer"}),
    )
    .await;
    let order = vec![
        "scheduled-task:newer".to_owned(),
        "scheduled-task:older".to_owned(),
    ];
    assert_eq!(ids().await, order);
    tokio::time::advance(Duration::from_secs(1)).await;
    let toggled = service.set_enabled(&older.id, false).await.expect("toggle");
    assert!(toggled.updated_at > older.updated_at, "updated_at moved");
    assert_eq!(ids().await, order, "after a toggle");
    tokio::time::advance(Duration::from_secs(1)).await;
    upsert(
        &service,
        json!({"id": older.id, "requireExisting": true, "title": "Edited", "enabled": false}),
    )
    .await;
    assert_eq!(ids().await, order, "after an edit");
}

/// The thread of `keeps one queued occurrence...`: runs that never start.
#[derive(Default)]
struct BusyThread {
    /// (run id, status, message id, scheduled task id)
    runs: Vec<(String, String, String, String)>,
}

impl BusyThread {
    fn queued_of(&self, task: &str) -> usize {
        self.runs
            .iter()
            .filter(|(_, status, _, of)| status == "queued" && of == task)
            .count()
    }
}

/// `keeps one queued occurrence of a recurring task while its bound thread is busy`.
#[tokio::test(start_paused = true)]
async fn a_busy_bound_thread_holds_one_queued_occurrence() {
    let env = Env::new("busy", "2026-07-01T09:00:00.000Z");
    let thread: Arc<StdMutex<BusyThread>> = Arc::default();
    let (sends, queued) = (thread.clone(), thread.clone());
    let fake = Fake {
        send: Box::new(move |request| {
            if let Ok(mut thread) = sends.lock() {
                let run = format!("run:{}", request.message_id);
                thread.runs.push((
                    run,
                    "queued".into(),
                    request.message_id,
                    request.scheduled_task_id,
                ));
            }
            Box::pin(async { Ok(()) })
        }),
        queued: Box::new(move |task, _| queued.lock().is_ok_and(|t| t.queued_of(&task) > 0)),
        shell: Box::new(|_| shell("project-busy-thread")),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let bound = |id: &str, title: &str, schedule: Value| {
        json!({"id": id, "title": title, "prompt": title, "schedule": schedule,
               "projectId": "project-busy-thread", "threadId": "thread:busy"})
    };
    let task = upsert(
        &service,
        bound(
            "scheduled-task:busy-thread",
            "Check progress",
            json!({"type": "interval", "everyMs": 60_000}),
        ),
    )
    .await;
    for _ in 0..3 {
        tokio::time::advance(Duration::from_secs(61)).await;
        service.run_due().await;
    }
    let count = |id: String| {
        let thread = thread.clone();
        move || thread.lock().map_or(0, |t| t.queued_of(&id))
    };
    let occurrences = count(task.id.clone());
    assert_eq!(occurrences(), 1, "one held copy");
    let listed = tasks(&service).await;
    assert!(
        listed[0].next_run_at.as_deref().and_then(parse_iso) > Some(ms("2026-07-01T09:03:03.000Z")),
        "skipped intervals still move on"
    );
    service.run_now(&task.id).await.expect("run now");
    assert_eq!(occurrences(), 2, "Run now is an explicit request");
    if let Ok(mut t) = thread.lock() {
        for run in &mut t.runs {
            run.1 = "running".into();
        }
    }
    tokio::time::advance(Duration::from_secs(61)).await;
    service.run_due().await;
    assert_eq!(occurrences(), 1, "the next interval sends again");
    let once = upsert(
        &service,
        bound(
            "scheduled-task:busy-thread-once",
            "Check once",
            json!({"type": "once", "runAt": "2026-07-01T09:05:00.000Z"}),
        ),
    )
    .await;
    service.run_now(&once.id).await.expect("run now");
    tokio::time::advance(Duration::from_secs(61)).await;
    service.run_due().await;
    assert_eq!(
        count(once.id)(),
        2,
        "a one-time run still sends behind a queued Run now"
    );
}

/// `idle polls still wake for tasks saved later, recorded due times, and beside far-future
/// tasks`: here the timer sleeps until the earliest run and wakes on a save.
#[tokio::test(start_paused = true)]
async fn the_timer_wakes_for_a_task_saved_later_beside_a_far_future_one() {
    let env = Env::new("idle", "2026-07-01T09:00:00.000Z");
    let (tx, rx) = oneshot::channel::<String>();
    let tx = StdMutex::new(Some(tx));
    let fake = Fake {
        launch: Box::new(move |request| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(request.title);
            }
            Box::pin(async { Ok("thread-idle-poll".to_owned()) })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", true).await;
    tokio::time::sleep(Duration::from_secs(6)).await;
    upsert(
        &service,
        json!({"title": "Far future", "projectId": "project-idle-poll",
               "schedule": {"type": "interval", "everyMs": 3e14 as i64}}),
    )
    .await;
    let created = upsert(
        &service,
        json!({"title": "Idle poll", "projectId": "project-idle-poll"}),
    )
    .await;
    let started = tokio::time::Instant::now();
    assert_eq!(rx.await.expect("launched"), created.title);
    assert_eq!(
        started.elapsed(),
        Duration::from_secs(60),
        "at its due time, not before"
    );
}

/// `a fixed-time slot missed while the server was off shows on the task`.
#[tokio::test(start_paused = true)]
async fn a_fixed_time_missed_while_off_shows_on_the_task() {
    let env = Env::new("missed", "2026-07-01T12:00:00.000Z"); // 08:00 in New York
    let launches = Arc::new(StdMutex::new(0));
    let fake = |launches: Arc<StdMutex<i32>>| Fake {
        launch: Box::new(move |_| {
            if let Ok(mut n) = launches.lock() {
                *n += 1;
            }
            Box::pin(async { Ok("thread-missed-slot".to_owned()) })
        }),
        ..Fake::default()
    };
    let first = env
        .start(fake(launches.clone()), "America/New_York", false)
        .await;
    let task = upsert(
        &first,
        json!({"title": "Morning bookkeeping", "prompt": "Update yesterday's notes.",
               "projectId": "project-missed-slot", "schedule": {"type": "fixed_time", "timeOfDay": "09:00"}}),
    )
    .await;
    first.run_now(&task.id).await.expect("manual run");
    // The server is off across the 09:00 slot and comes back at 09:30.
    env.clock.set(ms("2026-07-01T13:30:00.000Z"));
    let second = env
        .start(fake(launches.clone()), "America/New_York", true)
        .await;
    tokio::time::sleep(Duration::from_secs(6)).await;
    let listed = tasks(&second).await;
    assert_eq!(listed[0].id, task.id);
    assert_eq!(
        *launches.lock().expect("lock"),
        1,
        "the missed slot did not run"
    );
    assert_eq!(
        next(&listed[0]),
        Some("2026-07-02T13:00:00.000Z"),
        "the next day's slot"
    );
    assert_eq!(listed[0].last_run_status, ScheduledTaskRunStatus::Failed);
    assert_eq!(
        listed[0].last_run_error.as_deref(),
        Some("Missed a scheduled run because the server was not running at that time.")
    );
}

/// `a run made while the scheduler was busy is not overwritten by its stale missed slot`.
#[tokio::test(start_paused = true)]
async fn a_manual_run_during_a_busy_pass_is_not_overwritten_by_a_stale_missed_slot() {
    let env = Env::new("stale-slot", "2026-07-01T10:00:00.000Z"); // 06:00 in New York
    let slow_started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let last = Arc::new(Notify::new());
    let fake = |slow_started: Arc<Notify>, release: Arc<Notify>, last: Arc<Notify>| Fake {
        launch: Box::new(move |request| {
            let (slow_started, release, last) =
                (slow_started.clone(), release.clone(), last.clone());
            Box::pin(async move {
                match request.title.as_str() {
                    "Slow" => {
                        slow_started.notify_one();
                        release.notified().await;
                    }
                    "Last" => last.notify_one(),
                    _ => {}
                }
                Ok(format!("thread-{}", request.title))
            })
        }),
        ..Fake::default()
    };
    let first = env
        .start(
            fake(slow_started.clone(), release.clone(), last.clone()),
            "America/New_York",
            false,
        )
        .await;
    let save = |title: &str, schedule: Value| json!({"title": title, "prompt": "Update the notes.", "projectId": "project-stale-slot", "schedule": schedule});
    upsert(
        &first,
        save("Slow", json!({"type": "interval", "everyMs": 3_600_000})),
    )
    .await;
    let morning = upsert(
        &first,
        save(
            "Morning",
            json!({"type": "fixed_time", "timeOfDay": "08:00"}),
        ),
    )
    .await;
    upsert(
        &first,
        save("Last", json!({"type": "interval", "everyMs": 9_000_000})),
    )
    .await;
    // Due at 07:00, 08:00 and 08:30; the server is off until 09:30.
    env.clock.set(ms("2026-07-01T13:30:00.000Z"));
    let second = env
        .start(
            fake(slow_started.clone(), release.clone(), last.clone()),
            "America/New_York",
            true,
        )
        .await;
    slow_started.notified().await;
    second.run_now(&morning.id).await.expect("manual run");
    release.notify_one();
    last.notified().await;
    let morning = tasks(&second)
        .await
        .into_iter()
        .find(|t| t.id == morning.id)
        .expect("morning");
    assert_eq!(morning.last_run_status, ScheduledTaskRunStatus::Succeeded);
    assert_eq!(morning.last_run_error, None);
    assert_eq!(
        next(&morning),
        Some("2026-07-02T12:00:00.000Z"),
        "tomorrow 08:00"
    );
}

/// `releases interrupted runs on startup and still executes due tasks`: corrupt rows cannot
/// be stored here, so the cases are the running rows, a huge interval and a bad due time.
#[tokio::test(start_paused = true)]
async fn startup_releases_interrupted_runs_and_runs_due_tasks() {
    let now = "2026-09-09T12:00:00.000Z";
    let env = Env::new("startup", now);
    let row = |id: &str, next: &str, status: &str, every: i64| {
        json!({
            "id": id, "title": id, "prompt": "p", "enabled": true,
            "schedule": {"type": "interval", "everyMs": every},
            "projectId": "project", "threadId": null, "threadMode": "new_thread",
            "workspaceStrategy": {"type": "root"},
            "modelSelection": {"instanceId": "codex", "model": "gpt-5.4"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "createdBy": "user", "creationSource": "web",
            "createdAt": now, "updatedAt": now, "nextRunAt": next, "lastRunAt": null,
            "lastRunStatus": status, "lastRunError": null, "runCount": 0,
        })
    };
    let huge = 9_000_000_000_000_000_i64;
    let rows = vec![
        row("stuck-valid", now, "running", 60_000),
        row("stuck-huge", now, "running", huge),
        row("due-bad-date", "", "never", 60_000),
        row("due-healthy", now, "never", 60_000),
        row("due-huge", now, "never", huge),
        row("due-second", now, "never", 60_000),
    ];
    std::fs::create_dir_all(&env.dir).expect("dir");
    std::fs::write(
        env.dir.join("scheduled-tasks.json"),
        json!({"version": 1, "tasks": rows}).to_string(),
    )
    .expect("seed");
    env.clock.set(ms(now) + 1_000);
    let launches = Arc::new(StdMutex::new(0));
    let counted = launches.clone();
    let fake = Fake {
        launch: Box::new(move |_| {
            if let Ok(mut n) = counted.lock() {
                *n += 1;
            }
            Box::pin(async { Err("test launch failure".to_owned()) })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", true).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let by_id =
        |id: &str, all: &[ScheduledTask]| all.iter().find(|t| t.id == id).cloned().expect(id);
    let all = tasks(&service).await;
    for id in ["stuck-valid", "stuck-huge"] {
        let task = by_id(id, &all);
        assert_eq!(task.last_run_status, ScheduledTaskRunStatus::Failed, "{id}");
        assert_eq!(
            task.last_run_error.as_deref(),
            Some("Run was interrupted by a server restart."),
            "{id}"
        );
        assert_eq!(task.run_count, 1, "{id}");
    }
    assert!(
        by_id("stuck-valid", &all).next_run_at.is_some(),
        "planned again"
    );
    assert_eq!(by_id("stuck-huge", &all).next_run_at, None, "no next run");
    for id in ["due-healthy", "due-huge", "due-second"] {
        let task = by_id(id, &all);
        assert_eq!(task.last_run_status, ScheduledTaskRunStatus::Failed, "{id}");
        assert!(
            task.last_run_error
                .as_deref()
                .is_some_and(|e| e.contains("test launch failure")),
            "{id}"
        );
        assert_eq!(task.run_count, 1, "{id}");
    }
    assert_eq!(by_id("due-huge", &all).next_run_at, None);
    let bad = by_id("due-bad-date", &all);
    assert_eq!(
        (bad.last_run_status, bad.run_count),
        (ScheduledTaskRunStatus::Never, 0),
        "skipped"
    );
    assert_eq!(*launches.lock().expect("lock"), 3, "three due runs");
}

/// `thread cleanup notifies subscribers and a finishing run cannot recreate the task`.
#[tokio::test(start_paused = true)]
async fn thread_cleanup_during_a_run_removes_the_task_for_good() {
    let env = Env::new("cleanup", "2026-07-01T09:00:00.000Z");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (s, r) = (started.clone(), release.clone());
    let fake = Fake {
        send: Box::new(move |_| {
            let (s, r) = (s.clone(), r.clone());
            Box::pin(async move {
                s.notify_one();
                r.notified().await;
                Err(SendError::Other("test dispatch failure".into()))
            })
        }),
        shell: Box::new(|_| shell("project:test")),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let task = upsert(
        &service,
        json!({"id": "task:deleted-during-run", "projectId": "project:test", "threadId": "thread:deleted-during-run"}),
    )
    .await;
    let mut updates = service.subscribe();
    assert_eq!(updates.recv().await.expect("first").tasks.len(), 1);
    let runner = service.clone();
    let id = task.id.clone();
    let run = tokio::spawn(async move { runner.run_now(&id).await });
    started.notified().await;
    let refused = service.run_now(&task.id).await.expect_err("busy");
    assert_eq!(refused.message, "Schedule task is already running.");
    service
        .delete_for_thread("thread:deleted-during-run")
        .await
        .expect("cleanup");
    loop {
        let list = updates.recv().await.expect("update");
        if list.tasks.is_empty() {
            break;
        }
    }
    release.notify_one();
    let _ = run.await.expect("joined");
    assert!(tasks(&service).await.is_empty(), "not recreated");
}

/// `a run that ends $status after its message was accepted records it`.
#[tokio::test(start_paused = true)]
async fn a_run_that_fails_after_its_message_was_accepted_records_it() {
    let env = Env::new("outcome", "2026-07-01T09:00:00.000Z");
    let ended = Arc::new(Notify::new());
    let e = ended.clone();
    let fake = Fake {
        send: Box::new(|_| Box::pin(async { Ok(()) })),
        shell: Box::new(|_| shell("project:test")),
        outcome: Box::new(move |_, _| {
            let e = e.clone();
            Box::pin(async move {
                e.notified().await;
                Some("Weekly usage limit reached".to_owned())
            })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let task = upsert(
        &service,
        json!({"id": "task:quota", "projectId": "project:test", "threadId": "thread:quota"}),
    )
    .await;
    let ran = service.run_now(&task.id).await.expect("ran");
    assert_eq!(
        ran.task.last_run_status,
        ScheduledTaskRunStatus::Succeeded,
        "dispatched"
    );
    let mut updates = service.subscribe();
    ended.notify_one();
    loop {
        let list = updates.recv().await.expect("update");
        let current = list
            .tasks
            .into_iter()
            .flatten()
            .find(|t| t.id == task.id)
            .expect("task");
        if current.last_run_status == ScheduledTaskRunStatus::Failed {
            assert_eq!(
                current.last_run_error.as_deref(),
                Some("Weekly usage limit reached")
            );
            assert_eq!(current.run_count, 1);
            break;
        }
    }
}

/// `a bound run follows its thread when promotion moves it mid-send`.
#[tokio::test(start_paused = true)]
async fn a_bound_run_follows_its_thread_to_another_project() {
    let env = Env::new("follow", "2026-07-01T09:00:00.000Z");
    let sends: Arc<StdMutex<Vec<(String, String)>>> = Arc::default();
    let shells = Arc::new(StdMutex::new(vec![
        "project:promoted",
        "project:scratch",
        "project:promoted",
    ]));
    let recorded = sends.clone();
    let fake = Fake {
        send: Box::new(move |request| {
            let attempts = recorded.lock().map_or(0, |mut all| {
                all.push((request.project_id.clone(), request.command_id.clone()));
                all.len()
            });
            Box::pin(async move {
                if attempts < 3 {
                    Err(SendError::ThreadNotFound {
                        project_id: request.project_id,
                        thread_id: request.thread_id,
                    })
                } else {
                    Ok(())
                }
            })
        }),
        shell: Box::new(move |_| {
            let project = shells
                .lock()
                .ok()
                .and_then(|mut all| (!all.is_empty()).then(|| all.remove(0)));
            shell(project.unwrap_or("project:promoted"))
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let task = upsert(
        &service,
        json!({"id": "task:promoted-during-run", "projectId": "project:promoted",
               "threadId": "thread:promoted-during-run"}),
    )
    .await;
    let ran = service.run_now(&task.id).await.expect("ran");
    assert_eq!(ran.thread_id.as_deref(), Some("thread:promoted-during-run"));
    let attempts = sends.lock().expect("lock").clone();
    let projects: Vec<&str> = attempts.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(
        projects,
        ["project:promoted", "project:scratch", "project:promoted"]
    );
    assert!(
        attempts.iter().all(|(_, c)| *c == attempts[0].1),
        "one command id"
    );
}

/// `a first run whose thread was deleted before it bound removes the task`.
#[tokio::test(start_paused = true)]
async fn a_first_run_whose_thread_was_deleted_before_binding_removes_the_task() {
    let env = Env::new("deleted-bind", "2026-07-01T09:00:00.000Z");
    let fake = Fake {
        launch: Box::new(|_| Box::pin(async { Ok("thread:deleted".to_owned()) })),
        shell: Box::new(|_| {
            Some(ThreadShell {
                project_id: "project:test".into(),
                deleted: true,
                archived: false,
            })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let task = upsert(
        &service,
        json!({"id": "task:thread-deleted-mid-launch", "projectId": "project:test", "threadMode": "continue"}),
    )
    .await;
    service.run_now(&task.id).await.expect("ran");
    assert!(tasks(&service).await.is_empty(), "removed");
}

/// `a first run never binds its thread to a task $change`.
#[tokio::test(start_paused = true)]
async fn a_first_run_never_binds_to_a_recreated_or_moved_task() {
    for change in ["recreated", "moved"] {
        let env = Env::new("rebind", "2026-07-01T09:00:00.000Z");
        let launching = Arc::new(Notify::new());
        let proceed = Arc::new(Notify::new());
        let (l, p) = (launching.clone(), proceed.clone());
        let fake = Fake {
            launch: Box::new(move |_| {
                let (l, p) = (l.clone(), p.clone());
                Box::pin(async move {
                    l.notify_one();
                    p.notified().await;
                    Ok("thread:old-generation".to_owned())
                })
            }),
            ..Fake::default()
        };
        let service = env.start(fake, "UTC", false).await;
        let base = json!({"id": "task:recreated-mid-launch", "projectId": "project:test", "threadMode": "continue"});
        upsert(&service, base.clone()).await;
        let runner = service.clone();
        let run = tokio::spawn(async move { runner.run_now("task:recreated-mid-launch").await });
        launching.notified().await;
        if change == "recreated" {
            service
                .delete("task:recreated-mid-launch")
                .await
                .expect("deleted");
            tokio::time::advance(Duration::from_secs(1)).await;
            upsert(&service, base).await;
        } else {
            let mut moved = base;
            moved["projectId"] = json!("project:moved");
            upsert(&service, moved).await;
        }
        proceed.notify_one();
        let _ = run.await.expect("joined");
        let replacement = tasks(&service).await.into_iter().next().expect("task");
        assert_eq!(replacement.thread_id, None, "{change}");
    }
}

/// `checks a task's destination thread only when the destination changes`.
#[tokio::test(start_paused = true)]
async fn the_destination_thread_is_checked_only_when_it_changes() {
    let env = Env::new("destination", "2026-07-01T09:00:00.000Z");
    let archived = Arc::new(StdMutex::new(false));
    let flag = archived.clone();
    let fake = Fake {
        shell: Box::new(move |thread| {
            let make = |project: &str, deleted, archived| {
                Some(ThreadShell {
                    project_id: project.into(),
                    deleted,
                    archived,
                })
            };
            match thread.as_str() {
                "thread:destination" => make("project:test", false, *flag.lock().expect("lock")),
                "thread:archived" => make("project:test", false, true),
                "thread:deleted" => make("project:test", true, false),
                "thread:other-project" => make("project:other", false, false),
                _ => None,
            }
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let save = |thread: &str| json!({"id": "task:destination", "projectId": "project:test", "threadId": thread});
    for (thread, message) in [
        ("thread:missing", "That thread no longer exists."),
        ("thread:deleted", "That thread no longer exists."),
        (
            "thread:archived",
            "That thread is archived. Unarchive it or pick another destination.",
        ),
        (
            "thread:other-project",
            "That thread belongs to a different project.",
        ),
    ] {
        assert_eq!(failure(&service, save(thread)).await, message, "{thread}");
    }
    assert!(tasks(&service).await.is_empty());
    upsert(&service, save("thread:destination")).await;
    *archived.lock().expect("lock") = true;
    assert_eq!(
        upsert(&service, save("thread:destination"))
            .await
            .thread_id
            .as_deref(),
        Some("thread:destination"),
        "a thread archived later stays editable"
    );
}

/// `a run interrupted right after it reserves the task does not block the next run`, and
/// the T3 server's `onError`: a caller that stops waiting stops the run, which is recorded as
/// failed with T3's interrupt text, and the task is free for the next run.
#[tokio::test(start_paused = true)]
async fn a_caller_that_stops_waiting_stops_the_run_and_records_a_failure() {
    let env = Env::new("interrupted", "2026-07-01T09:00:00.000Z");
    let launches = Arc::new(StdMutex::new(0));
    let finished = Arc::new(StdMutex::new(0));
    let (counted, done) = (launches.clone(), finished.clone());
    let fake = Fake {
        launch: Box::new(move |_| {
            if let Ok(mut n) = counted.lock() {
                *n += 1;
            }
            let done = done.clone();
            Box::pin(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Ok(mut n) = done.lock() {
                    *n += 1;
                }
                Ok("thread:launched".to_owned())
            })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let task = upsert(
        &service,
        json!({"id": "task:interrupted-reservation", "projectId": "project:test"}),
    )
    .await;
    let runner = service.clone();
    let id = task.id.clone();
    let first = tokio::spawn(async move { runner.run_now(&id).await });
    while *launches.lock().expect("lock") == 0 {
        tokio::task::yield_now().await;
    }
    first.abort();
    assert!(first.await.expect_err("aborted").is_cancelled());
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        *finished.lock().expect("lock"),
        0,
        "the launch stopped with its caller"
    );
    let listed = tasks(&service).await;
    assert_eq!(listed[0].last_run_status, ScheduledTaskRunStatus::Failed);
    assert_eq!(
        listed[0].last_run_error.as_deref(),
        Some(super::INTERRUPTED_RUN)
    );
    assert_eq!(listed[0].run_count, 1);
    assert!(listed[0].next_run_at.is_some(), "planned again");
    let second = service.run_now(&task.id).await.expect("second run");
    assert_eq!(second.thread_id.as_deref(), Some("thread:launched"));
    assert_eq!(*launches.lock().expect("lock"), 2);
    assert_eq!(
        tasks(&service).await[0].last_run_status,
        ScheduledTaskRunStatus::Succeeded
    );
}

/// `a fresh-session task launches one thread, then starts each later run fresh in it`.
#[tokio::test(start_paused = true)]
async fn a_fresh_session_task_launches_one_thread_then_starts_each_later_run_fresh_in_it() {
    let env = Env::new("fresh-session", "2026-07-01T09:00:00.000Z");
    let launches = Arc::new(StdMutex::new(0));
    let sends: Arc<StdMutex<Vec<(String, bool)>>> = Arc::default();
    let (counted, sent) = (launches.clone(), sends.clone());
    let fake = Fake {
        launch: Box::new(move |_| {
            if let Ok(mut n) = counted.lock() {
                *n += 1;
            }
            Box::pin(async { Ok("thread:fresh-session-task".to_owned()) })
        }),
        send: Box::new(move |request| {
            if let Ok(mut all) = sent.lock() {
                all.push((request.thread_id.clone(), request.fresh_context));
            }
            Box::pin(async { Ok(()) })
        }),
        shell: Box::new(|_| {
            Some(ThreadShell {
                project_id: "project:test".into(),
                deleted: false,
                archived: false,
            })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let base = json!({"id": "task:fresh-session", "title": "Triage",
        "prompt": "Triage new issues", "projectId": "project:test"});
    let with = |extra: Value| {
        let mut all = base.clone();
        if let (Some(all), Some(extra)) = (all.as_object_mut(), extra.as_object()) {
            all.extend(extra.clone());
        }
        all
    };
    upsert(&service, with(json!({"threadMode": "fresh_session"}))).await;
    let first = service
        .run_now("task:fresh-session")
        .await
        .expect("first run");
    assert_eq!(
        first.thread_id.as_deref(),
        Some("thread:fresh-session-task")
    );
    // A form opened before the first run saves no thread; the binding stays.
    let task = upsert(
        &service,
        with(json!({"threadId": null, "threadMode": "fresh_session"})),
    )
    .await;
    assert_eq!(task.thread_id.as_deref(), Some("thread:fresh-session-task"));
    assert_eq!(
        task.thread_mode,
        Some(ScheduledTaskThreadMode::FreshSession)
    );
    // A client that predates thread modes sends neither; both stay.
    let legacy = upsert(&service, with(json!({"threadId": null}))).await;
    assert_eq!(
        legacy.thread_id.as_deref(),
        Some("thread:fresh-session-task")
    );
    assert_eq!(
        legacy.thread_mode,
        Some(ScheduledTaskThreadMode::FreshSession)
    );
    service
        .run_now("task:fresh-session")
        .await
        .expect("second run");
    assert_eq!(*launches.lock().expect("lock"), 1);
    assert_eq!(
        *sends.lock().expect("lock"),
        [("thread:fresh-session-task".to_owned(), true)]
    );
    // Its thread stays in the old project, so moving the task leaves it for a new one.
    let moved = upsert(
        &service,
        with(json!({"projectId": "project:moved", "threadId": "thread:fresh-session-task"})),
    )
    .await;
    assert_eq!(moved.thread_id, None);
    assert_eq!(
        moved.thread_mode,
        Some(ScheduledTaskThreadMode::FreshSession)
    );
    let unbound = upsert(&service, with(json!({"threadMode": "new_thread"}))).await;
    assert_eq!(unbound.thread_id, None);
}

/// Schedules the contract refuses are defects, as Effect answers a payload that does not
/// decode.
#[tokio::test(start_paused = true)]
async fn invalid_schedules_are_refused() {
    let env = Env::new("refused", "2026-07-01T09:00:00.000Z");
    let service = env.start(Fake::default(), "UTC", false).await;
    assert!(matches!(
        service
            .upsert(input(
                json!({"schedule": {"type": "interval", "everyMs": 1000}})
            ))
            .await,
        Err(Failure::Invalid(_))
    ));
    assert!(matches!(
        service.upsert(input(json!({"title": "   "}))).await,
        Err(Failure::Invalid(_))
    ));
}

/// The store survives a restart, and a run's ids follow T3's command and message id form.
#[tokio::test(start_paused = true)]
async fn the_store_survives_a_restart_and_runs_use_t3_ids() {
    let env = Env::new("ids", "2026-07-01T09:00:00.000Z");
    let seen: Arc<StdMutex<Vec<LaunchRequest>>> = Arc::default();
    let record = seen.clone();
    let fake = Fake {
        launch: Box::new(move |request| {
            if let Ok(mut all) = record.lock() {
                all.push(request);
            }
            Box::pin(async { Ok("thread:new".to_owned()) })
        }),
        ..Fake::default()
    };
    let service = env.start(fake, "UTC", false).await;
    let task = upsert(
        &service,
        json!({"id": "scheduled-task:ids", "createdBy": "agent", "creationSource": "mcp"}),
    )
    .await;
    let ran = service.run_now(&task.id).await.expect("ran");
    assert_eq!(ran.task.thread_id, None, "a new-thread task stays unbound");
    let request = seen
        .lock()
        .expect("lock")
        .first()
        .cloned()
        .expect("launched");
    let started = ms("2026-07-01T09:00:00.000Z");
    assert_eq!(
        request.command_id,
        format!("scheduled-task:scheduled-task:ids:{started}:manual")
    );
    assert_eq!(
        request.message_id,
        format!("scheduled-task-message:scheduled-task:ids:{started}:manual")
    );
    assert_eq!(request.scheduled_task_id, "scheduled-task:ids");
    assert_eq!(
        (request.created_by, request.creation_source),
        (json!("agent"), json!("mcp"))
    );
    let restarted = env.start(Fake::default(), "UTC", false).await;
    let listed = tasks(&restarted).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].run_count, 1);
    assert_eq!(
        listed[0].last_run_at.as_deref(),
        Some(format_iso(started).as_str())
    );
    let stored: Value =
        serde_json::from_slice(&std::fs::read(env.dir.join("scheduled-tasks.json")).expect("file"))
            .expect("json");
    let decoded: Vec<ScheduledTask> = from_json(stored["tasks"].clone()).expect("contract rows");
    assert_eq!(decoded.len(), 1);
}
