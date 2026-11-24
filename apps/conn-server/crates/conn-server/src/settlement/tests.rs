//! Cases from `ThreadSettlementService.test.ts` (each names the T3 case it ports), then the sweep
//! on a real engine whose clock the test moves.

use std::sync::Arc;

use conn_engine::{Engine, ManualClock, SqliteEngine};
use serde_json::{Value, json};

use super::*;

const NOW_MS: i64 = 1_787_918_400_000; // 2026-08-28T12:00:00.000Z

fn at(offset: i64) -> Value {
    json!(conn_support::time::iso_from_millis(NOW_MS + offset))
}

fn shell(overrides: Value) -> Value {
    let mut thread = json!({
        "id": "thread-1", "projectId": "project-1", "status": "idle",
        "lineage": {"rootThreadId": "thread-1", "parentThreadId": null, "relationshipToParent": null},
        "branch": null, "linkedPullRequest": null, "pullRequests": [],
        "activityRunStatus": null, "pendingRuntimeRequest": null, "pendingBackgroundTasks": [],
        "pendingGuestMessageCount": 0,
        "latestRunId": null, "latestRunRequestedAt": null, "latestRunStartedAt": null,
        "latestRunCompletedAt": null, "latestUserMessageAt": null,
        "createdAt": at(-30 * DAY_MS), "updatedAt": at(-10 * DAY_MS),
        "archivedAt": null, "settledOverride": null, "settledAt": null,
        "snoozedUntil": null, "snoozedAt": null, "pinnedAt": null, "autoSettleDisabledAt": null,
    });
    let authored = overrides
        .get("latestUserMessageAt")
        .cloned()
        .unwrap_or(Value::Null);
    thread["latestUserAuthoredMessageAt"] = authored;
    if let (Some(thread), Value::Object(overrides)) = (thread.as_object_mut(), overrides) {
        thread.extend(overrides);
    }
    thread
}

fn persisted_link(state: Option<&str>, linked_at: &Value) -> Value {
    json!({
        "host": "example.test", "repository": "owner/repository", "number": 42,
        "url": "https://example.test/owner/repository/pull/42", "source": "manual",
        "linkedAt": linked_at,
        "snapshot": state.map(|state| json!({"state": state, "title": "Pull request",
            "headBranch": "feature", "baseBranch": "main", "isDraft": false,
            "updatedAt": linked_at, "syncedAt": linked_at})),
        "stack": null,
    })
}

fn settle(after_days: Option<u64>, on_merge: bool, keep: bool) -> AutoSettle {
    AutoSettle {
        after_days: after_days.map(|days| days as f64),
        on_merge,
        keep_pull_requests: keep,
    }
}

fn ms_of(value: &Value) -> i64 {
    super::ms(value).unwrap()
}

/// `settles a thread whose only background work is a command left running`.
#[test]
fn a_command_left_running_does_not_hold_but_a_pull_request_watch_does() {
    let command = shell(json!({"pendingBackgroundTasks":
        [{"taskId": "dev", "kind": "command", "description": "vp run dev --share"}]}));
    assert!(is_auto_settlement_candidate(&command, NOW_MS));
    let watch = shell(json!({"pendingBackgroundTasks":
        [{"taskId": "pull-request-watch:github.com/acme/app#1", "kind": "monitor"}]}));
    assert!(!is_auto_settlement_candidate(&watch, NOW_MS));
}

/// `keeps snoozed threads parked until a fresh failure or timer wake`.
#[test]
fn snoozed_threads_stay_until_a_fresh_failure_or_their_timer() {
    let snoozed = json!({"snoozedUntil": at(60 * 60 * 1_000), "snoozedAt": at(-60 * 60 * 1_000)});
    let with = |extra: Value| {
        let mut overrides = snoozed.clone();
        if let (Some(map), Value::Object(extra)) = (overrides.as_object_mut(), extra) {
            map.extend(extra);
        }
        shell(overrides)
    };
    assert!(!is_auto_settlement_candidate(&with(json!({})), NOW_MS));
    assert!(is_auto_settlement_candidate(
        &with(json!({"status": "failed", "latestRunCompletedAt": at(-30 * 60 * 1_000)})),
        NOW_MS
    ));
    assert!(!is_auto_settlement_candidate(
        &with(json!({"status": "failed", "latestRunCompletedAt": at(-2 * 60 * 60 * 1_000)})),
        NOW_MS
    ));
    assert!(!is_auto_settlement_candidate(
        &with(json!({"status": "failed", "latestRunCompletedAt": null})),
        NOW_MS
    ));
    assert!(is_auto_settlement_candidate(
        &with(json!({"snoozedUntil": at(-1)})),
        NOW_MS
    ));
}

/// `keeps threads with a PR from inactivity settlement only when asked`.
#[test]
fn a_linked_pull_request_keeps_the_thread_only_when_asked() {
    let thread = shell(json!({"latestUserMessageAt": at(-4 * DAY_MS),
        "linkedPullRequest": {"projectId": "project-1", "repository": "owner/repo", "number": 1}}));
    assert_eq!(
        resolve_auto_settlement_at(&thread, None, NOW_MS, settle(Some(3), true, true)),
        None
    );
    assert_eq!(
        resolve_auto_settlement_at(&thread, None, NOW_MS, settle(Some(3), true, false)),
        Some(ms_of(&at(-4 * DAY_MS)))
    );
    let merged = SettlementPullRequest {
        state: "merged".into(),
        merged_at: at(-1).as_str().map(str::to_owned),
        closed_at: None,
    };
    assert_eq!(
        resolve_auto_settlement_at(&thread, Some(merged), NOW_MS, settle(Some(3), true, true)),
        Some(ms_of(&at(-4 * DAY_MS)))
    );
}

/// `settles an idle thread with an open persisted link only while retention is off` and
/// `keeps an idle thread whose persisted link was never synced`.
#[test]
fn persisted_links_settle_only_as_t3_allows() {
    let open = shell(json!({"latestUserMessageAt": at(-4 * DAY_MS),
        "pullRequests": [persisted_link(Some("open"), &at(-5 * DAY_MS))]}));
    assert_eq!(
        resolve_auto_settlement_at(&open, None, NOW_MS, settle(Some(3), true, false)),
        Some(ms_of(&at(-4 * DAY_MS)))
    );
    assert_eq!(
        resolve_auto_settlement_at(&open, None, NOW_MS, settle(Some(3), true, true)),
        None
    );
    let merged = SettlementPullRequest {
        state: "merged".into(),
        merged_at: at(-1).as_str().map(str::to_owned),
        closed_at: None,
    };
    assert_eq!(
        resolve_auto_settlement_at(&open, Some(merged), NOW_MS, settle(None, true, false)),
        None,
        "an open link outranks a merged lookup"
    );
    let unsynced = shell(json!({"latestUserMessageAt": at(-4 * DAY_MS),
        "pullRequests": [persisted_link(None, &at(-5 * DAY_MS))]}));
    assert_eq!(
        resolve_auto_settlement_at(&unsynced, None, NOW_MS, settle(Some(3), true, false)),
        None
    );
}

/// `uses the latest activity time when the inactivity window elapses` and `anchors an empty
/// thread's inactivity at its creation time`.
#[test]
fn inactivity_counts_from_the_latest_activity_or_creation() {
    let idle = shell(json!({"latestUserMessageAt": at(-4 * DAY_MS),
        "latestRunRequestedAt": at(-4 * DAY_MS), "latestRunStartedAt": at(-4 * DAY_MS),
        "latestRunCompletedAt": at(-3 * DAY_MS)}));
    assert_eq!(
        resolve_auto_settlement_at(&idle, None, NOW_MS, settle(Some(2), true, false)),
        Some(ms_of(&at(-3 * DAY_MS)))
    );
    assert_eq!(
        resolve_auto_settlement_at(&idle, None, NOW_MS, settle(Some(5), true, false)),
        None
    );
    assert_eq!(
        resolve_auto_settlement_at(&idle, None, NOW_MS, settle(None, true, false)),
        None
    );
    let empty = shell(json!({"createdAt": at(-3 * DAY_MS)}));
    assert_eq!(
        resolve_auto_settlement_at(&empty, None, NOW_MS, settle(Some(2), false, false)),
        Some(ms_of(&at(-3 * DAY_MS)))
    );
    let recent = shell(json!({"createdAt": at(-DAY_MS)}));
    assert_eq!(
        resolve_auto_settlement_at(&recent, None, NOW_MS, settle(Some(2), false, false)),
        None
    );
    let woke = shell(json!({"createdAt": at(-3 * DAY_MS), "lastSnoozeWakeAt": at(-DAY_MS)}));
    assert_eq!(
        resolve_auto_settlement_at(&woke, None, NOW_MS, settle(Some(2), false, false)),
        None
    );
}

/// `restarts inactivity on a manual|timer snooze wake`.
#[test]
fn a_snooze_wake_restarts_inactivity() {
    for wake in [
        json!({"lastSnoozeWakeAt": at(-1_000)}),
        json!({"snoozedAt": at(-3 * DAY_MS), "snoozedUntil": at(-1_000)}),
    ] {
        let mut thread = shell(json!({"latestRunCompletedAt": at(-4 * DAY_MS)}));
        if let (Some(map), Value::Object(wake)) = (thread.as_object_mut(), wake) {
            map.extend(wake);
        }
        let one_day = settle(Some(1), false, false);
        assert_eq!(
            resolve_auto_settlement_at(&thread, None, NOW_MS, one_day),
            None
        );
        assert_eq!(
            resolve_auto_settlement_at(&thread, None, NOW_MS + DAY_MS, one_day),
            Some(ms_of(&at(-1_000)))
        );
    }
}

/// `settles on merge only after the user's last action and preserves the activity time`.
#[test]
fn a_merge_settles_only_after_the_users_last_action() {
    let thread = shell(json!({"latestUserMessageAt": at(-2 * 60 * 60 * 1_000),
        "latestRunCompletedAt": at(-90 * 60 * 1_000)}));
    let merged = |offset: i64| SettlementPullRequest {
        state: "merged".into(),
        merged_at: at(offset).as_str().map(str::to_owned),
        closed_at: None,
    };
    assert_eq!(
        resolve_auto_settlement_at(
            &thread,
            Some(merged(-60 * 60 * 1_000)),
            NOW_MS,
            settle(None, true, false)
        ),
        Some(ms_of(&at(-90 * 60 * 1_000)))
    );
    assert_eq!(
        resolve_auto_settlement_at(
            &thread,
            Some(merged(-60 * 60 * 1_000)),
            NOW_MS,
            settle(None, false, false)
        ),
        None
    );
    assert_eq!(
        resolve_auto_settlement_at(
            &thread,
            Some(merged(-3 * 60 * 60 * 1_000)),
            NOW_MS,
            settle(None, true, false)
        ),
        None
    );
}

/// `distinguishes a project that inherits the threshold from one that disables it`.
#[test]
fn a_project_inherits_or_disables_the_threshold() {
    let settings = |entry: Value| {
        json!({"projectSettingsOverrides": {"p": entry}})
            .as_object()
            .unwrap()
            .clone()
    };
    let inherits = settings(json!({"sidebarAutoSettleOnMerge": true}));
    assert_eq!(
        AutoSettle::for_project(&inherits, "p").after_days,
        DEFAULT_AUTO_SETTLE_AFTER_DAYS
    );
    let never = settings(json!({"sidebarAutoSettleAfterDays": null}));
    assert_eq!(AutoSettle::for_project(&never, "p").after_days, None);
}

/// `SidebarAutoSettleAfterDays` is a number between 1 and 90, so a day count can be
/// fractional: `inactivityAtMs < nowMs - days * DAY_MS` reads 1.5 days as 36 hours, for the
/// environment and for a project override.
#[test]
fn a_fractional_day_count_settles_after_that_many_hours() {
    let settings = |value: Value| value.as_object().unwrap().clone();
    let global = settings(json!({"sidebarAutoSettleAfterDays": 1.5}));
    let project = settings(json!({"sidebarAutoSettleAfterDays": null,
        "projectSettingsOverrides": {"project-1": {"sidebarAutoSettleAfterDays": 1.5}}}));
    for read in [&global, &project] {
        assert!(auto_settlement_configured(read));
        let idle = |hours: i64| shell(json!({"latestUserMessageAt": at(-hours * 60 * 60 * 1_000)}));
        assert!(
            decide(&idle(30), read, NOW_MS).is_none(),
            "30 hours is under 1.5 days"
        );
        let command = decide(&idle(40), read, NOW_MS).expect("40 hours is past 1.5 days");
        assert_eq!(command["settledAt"], at(-40 * 60 * 60 * 1_000));
    }
}

// ---- The sweep on a real engine and controlled time ----

/// `settleThread` (`ThreadSettlementService.ts:384`) reads the settings right before each
/// command: turned off while a sweep settles, they keep the threads it has not reached.
#[tokio::test(flavor = "current_thread")]
async fn each_settlement_reads_the_settings_right_before_its_command() {
    let candidates = [
        shell(json!({"id": "first", "latestUserMessageAt": at(-4 * DAY_MS)})),
        shell(json!({"id": "second", "latestUserMessageAt": at(-4 * DAY_MS)})),
    ];
    let on = std::cell::Cell::new(true);
    let settings = || {
        let days = if on.get() { json!(1) } else { Value::Null };
        json!({"sidebarAutoSettleAfterDays": days, "sidebarAutoSettleOnMerge": false})
            .as_object()
            .unwrap()
            .clone()
    };
    let mut sent = Vec::new();
    sweep_with(
        &candidates,
        settings,
        || NOW_MS,
        |command| {
            sent.push(command["threadId"].clone());
            on.set(false);
            async {}
        },
    )
    .await;
    assert_eq!(sent, [json!("first")]);
}

const T0: u64 = 1_800_000_000_000;

struct Harness {
    engine: Arc<SqliteEngine>,
    clock: Arc<ManualClock>,
    environment: Arc<Environment>,
    project: String,
    dir: std::path::PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn harness(name: &str) -> Harness {
    let dir = std::env::temp_dir().join(format!(
        "conn-settlement-{name}-{}",
        conn_support::uuid_v4()
    ));
    std::fs::create_dir_all(dir.join("project")).unwrap();
    let root = dir.join("project").to_string_lossy().into_owned();
    let clock = Arc::new(ManualClock::at(T0));
    let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
    config.projects = vec![conn_engine::ProjectConfig {
        title: "Project".into(),
        workspace_root: root.clone(),
    }];
    config.providers = vec![Arc::new(conn_engine::fake::FakeProvider::new(
        "claudeAgent",
    ))];
    config.clock = clock.clone();
    let engine = Arc::new(SqliteEngine::open(config).unwrap());
    let environment =
        Arc::new(Environment::load(&dir, None, dir.clone(), Default::default()).unwrap());
    Harness {
        engine,
        clock,
        environment,
        project: SqliteEngine::project_id_for(&root),
        dir,
    }
}

impl Harness {
    async fn dispatch(&self, command: Value) -> bool {
        self.engine
            .dispatch(conn_contract::from_json(command).unwrap())
            .await
            .is_ok()
    }

    async fn thread(&self, id: &str) -> Value {
        self.engine.get_thread_projection(id.into()).await.unwrap()["thread"].clone()
    }

    /// A thread whose first turn sends `text`; it waits for the turn to end unless it hangs.
    async fn launch(&self, id: &str, text: &str) {
        assert!(
            self.dispatch(
                json!({"type": "thread.create", "commandId": format!("create-{id}"),
            "threadId": id, "projectId": self.project, "title": id,
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
            "runtimeMode": "auto", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdBy": "user", "creationSource": "web"})
            )
            .await
        );
        self.send(id, text).await;
    }

    async fn send(&self, id: &str, text: &str) {
        let n = conn_support::uuid_v4();
        assert!(
            self.dispatch(
                json!({"type": "message.dispatch", "commandId": format!("send-{n}"),
            "threadId": id, "messageId": format!("message-{n}"), "text": text, "attachments": [],
            "dispatchMode": {"type": "start_immediately"},
            "createdBy": "user", "creationSource": "web"})
            )
            .await
        );
        let want = if text == "hang" {
            "running"
        } else {
            "completed"
        };
        for _ in 0..500 {
            let p = self.engine.get_thread_projection(id.into()).await.unwrap();
            let latest = p["runs"].as_array().and_then(|runs| runs.last()).cloned();
            if latest.is_some_and(|run| run["status"] == want) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("{id}: no {want} run");
    }

    fn now(&self) -> i64 {
        i64::try_from(self.engine.now_millis()).unwrap()
    }
}

/// The sweep on controlled time (`ThreadSettlementService.ts:803`): past the threshold an idle
/// thread settles at its last activity; a pinned and a running thread stay; with the setting
/// off nothing settles.
#[tokio::test(flavor = "current_thread")]
async fn a_sweep_settles_threads_idle_past_the_threshold_and_nothing_else() {
    let h = harness("sweep");
    h.environment
        .settings
        .update(json!({"sidebarAutoSettleAfterDays": 1}), None)
        .unwrap();
    h.launch("idle", "baseline").await;
    let last_activity = h.thread("idle").await["updatedAt"].clone();
    h.launch("pinned", "baseline").await;
    assert!(
        h.dispatch(json!({"type": "thread.pin", "commandId": "pin", "threadId": "pinned"}))
            .await
    );
    h.launch("running", "hang").await;

    // Under a day: nothing yet.
    h.clock
        .advance(std::time::Duration::from_secs(12 * 60 * 60));
    sweep(&h.engine, &h.environment).await;
    assert!(h.thread("idle").await["settledOverride"].is_null());

    h.clock
        .advance(std::time::Duration::from_secs(24 * 60 * 60));
    sweep(&h.engine, &h.environment).await;
    let idle = h.thread("idle").await;
    assert_eq!(idle["settledOverride"], "settled", "{idle}");
    assert!(
        ms(&idle["settledAt"]) <= ms(&last_activity),
        "settled at its activity"
    );
    assert!(h.thread("pinned").await["settledOverride"].is_null());
    assert!(h.thread("running").await["settledOverride"].is_null());

    // Turned off, an idle thread stays however long it waits.
    h.environment
        .settings
        .update(
            json!({"sidebarAutoSettleAfterDays": null, "sidebarAutoSettleOnMerge": false}),
            None,
        )
        .unwrap();
    h.launch("later", "baseline").await;
    h.clock
        .advance(std::time::Duration::from_secs(10 * 24 * 60 * 60));
    sweep(&h.engine, &h.environment).await;
    assert!(h.thread("later").await["settledOverride"].is_null());
}

/// `pendingGuestMessageCount` (`ProjectionStore.ts:8717`): a guest's message still waiting keeps
/// an otherwise idle thread, which settles once nothing waits.
#[tokio::test(flavor = "current_thread")]
async fn a_pending_guest_message_keeps_an_idle_thread() {
    let h = harness("guest");
    h.environment
        .settings
        .update(json!({"sidebarAutoSettleAfterDays": 1}), None)
        .unwrap();
    h.launch("guest", "baseline").await;
    h.launch("alone", "baseline").await;
    let share = |status: &str| {
        json!({"id": "share", "host": "tunnel.example", "createdAt": at(0), "expiresAt": at(DAY_MS),
            "guestName": "Guest", "messages": [
                {"id": "seen", "status": "dismissed"},
                {"id": "waiting", "status": status}]})
    };
    let set_share = |share: Value| {
        let db = h.dir.join("engine.sqlite");
        rusqlite::Connection::open(db)
            .unwrap()
            .execute(
                "UPDATE threads SET thread = json_set(thread, '$.guestShare', json(?1))
                 WHERE id = 'guest'",
                [share.to_string()],
            )
            .unwrap();
    };
    set_share(share("pending"));
    h.clock
        .advance(std::time::Duration::from_secs(2 * 24 * 60 * 60));
    let candidates = h
        .engine
        .settlement_candidates(Some("guest".into()))
        .await
        .unwrap();
    assert_eq!(candidates[0]["pendingGuestMessageCount"], 1);
    sweep(&h.engine, &h.environment).await;
    assert!(h.thread("guest").await["settledOverride"].is_null());
    assert_eq!(h.thread("alone").await["settledOverride"], "settled");

    set_share(share("delivered"));
    sweep(&h.engine, &h.environment).await;
    assert_eq!(h.thread("guest").await["settledOverride"], "settled");
}

/// The final eligibility check: user activity between the sweep's read and its command keeps
/// the thread, as T3's `thread.auto-settle` refuses a thread changed since its snapshot.
#[tokio::test(flavor = "current_thread")]
async fn activity_between_the_sweeps_read_and_its_command_keeps_the_thread() {
    let h = harness("race");
    h.environment
        .settings
        .update(json!({"sidebarAutoSettleAfterDays": 1}), None)
        .unwrap();
    h.launch("busy", "baseline").await;
    h.clock
        .advance(std::time::Duration::from_secs(2 * 24 * 60 * 60));
    let candidates = h.engine.settlement_candidates(None).await.unwrap();
    let settings = h.environment.settings.raw();
    let commands: Vec<_> = candidates
        .iter()
        .filter_map(|thread| decide(thread, &settings, h.now()))
        .collect();
    assert_eq!(commands.len(), 1, "the thread was eligible when read");
    // The user comes back before the command lands.
    h.clock.advance(std::time::Duration::from_secs(1));
    h.send("busy", "I'm back").await;
    for command in commands {
        assert!(
            !h.dispatch(command).await,
            "the engine refuses the stale decision"
        );
    }
    assert!(h.thread("busy").await["settledOverride"].is_null());
}

/// The production loop (`start`): it sweeps every minute and at once on a settings change,
/// as T3's `forkParked` sweep and its settings stream.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_loop_sweeps_each_minute_and_on_a_settings_change() {
    let h = harness("loop");
    h.environment
        .settings
        .update(
            json!({"sidebarAutoSettleAfterDays": null, "sidebarAutoSettleOnMerge": false}),
            None,
        )
        .unwrap();
    h.launch("first", "baseline").await;
    let task = start(h.engine.clone(), h.environment.clone(), Arc::default());
    h.clock
        .advance(std::time::Duration::from_secs(3 * 24 * 60 * 60));
    // The setting turns on: the change itself sweeps.
    h.environment
        .settings
        .update(json!({"sidebarAutoSettleAfterDays": 1}), None)
        .unwrap();
    for _ in 0..500 {
        if h.thread("first").await["settledOverride"] == "settled" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(h.thread("first").await["settledOverride"], "settled");
    // A new thread idle past the threshold settles at the next minute's sweep.
    h.launch("third", "baseline").await;
    h.clock
        .advance(std::time::Duration::from_secs(2 * 24 * 60 * 60));
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    for _ in 0..500 {
        if h.thread("third").await["settledOverride"] == "settled" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(h.thread("third").await["settledOverride"], "settled");
    task.abort();
}
