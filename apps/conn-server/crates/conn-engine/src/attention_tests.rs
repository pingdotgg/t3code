use std::sync::Arc;
use std::time::Duration;

use conn_contract::attention::{ConnAttentionEventType as Type, ConnAttentionKind as Kind};
use serde_json::{Value, json};

use super::*;
use crate::clock::{Clock, ManualClock};
use crate::store::{Draft, Store};

const T0: u64 = 1_795_000_000_000;

struct Fixture {
    store: Store,
    clock: Arc<ManualClock>,
    path: std::path::PathBuf,
    thread: Value,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("sqlite-shm"));
    }
}

fn iso(ms: u64) -> String {
    conn_support::time::iso_from_ms(ms)
}

fn open(path: &std::path::Path, clock: &Arc<ManualClock>, on: bool) -> Store {
    let mut store = Store::open(path).unwrap();
    store.set_clock(clock.clone());
    if on {
        store.attention = Some(Arc::new(tokio::sync::Notify::new()));
    }
    store
}

impl Fixture {
    fn new(on: bool) -> Self {
        Self::with_thread(on, json!({}))
    }

    /// A thread with `extra` laid over a plain top-level thread, created idle.
    fn with_thread(on: bool, extra: Value) -> Self {
        let path =
            std::env::temp_dir().join(format!("conn-attention-{}.sqlite", conn_support::uuid_v4()));
        let clock = Arc::new(ManualClock::at(T0));
        let store = open(&path, &clock, on);
        let mut thread = json!({
            "id": "t",
            "projectId": "p",
            "title": "Fix the build",
            "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "t"},
            "createdAt": iso(T0),
            "archivedAt": null,
            "deletedAt": null,
            "lastVisitedAt": null,
        });
        for (key, value) in extra.as_object().unwrap() {
            thread[key] = value.clone();
        }
        let mut fixture = Self {
            store,
            clock,
            path,
            thread,
        };
        let thread = fixture.thread.clone();
        fixture.write(|tx| {
            tx.append(Draft::new("t", "thread.created", thread))
                .unwrap();
        });
        fixture
    }

    fn tick(&self, ms: u64) {
        self.clock.advance(Duration::from_millis(ms));
    }

    fn now(&self) -> u64 {
        self.clock.now_millis()
    }

    fn write(&mut self, f: impl FnOnce(&mut crate::store::Tx<'_>)) {
        let mut tx = self.store.tx().unwrap();
        f(&mut tx);
        tx.commit(None).unwrap();
    }

    fn run(&mut self, id: &str, ordinal: u64, status: &str) {
        self.tick(1_000);
        let at = iso(self.now());
        let done = matches!(status, "completed" | "failed" | "cancelled");
        let run = json!({
            "id": id, "ordinal": ordinal, "status": status,
            "requestedAt": at, "startedAt": at,
            "completedAt": if done { json!(at) } else { Value::Null },
        });
        self.write(|tx| {
            tx.append(Draft::new("t", "run.updated", run)).unwrap();
        });
    }

    fn request(&mut self, id: &str, kind: &str, status: &str) {
        self.tick(1_000);
        let request =
            json!({"id": id, "kind": kind, "status": status, "createdAt": iso(self.now())});
        self.write(|tx| {
            tx.append(Draft::new("t", "runtime-request.updated", request))
                .unwrap();
        });
    }

    fn update_thread(&mut self, change: Value) {
        self.tick(1_000);
        for (key, value) in change.as_object().unwrap() {
            self.thread[key] = value.clone();
        }
        let thread = self.thread.clone();
        self.write(|tx| {
            tx.append(Draft::new("t", "thread.updated", thread))
                .unwrap();
        });
    }

    fn outbox(&self) -> Vec<AttentionOutboxRow> {
        due(self.store.raw(), u64::MAX >> 2, 100).unwrap()
    }

    fn sent(&self) -> Vec<(Type, Option<Kind>, Option<String>)> {
        self.outbox()
            .into_iter()
            .map(|row| (row.event_type, row.kind, row.request_id))
            .collect()
    }
}

fn raised(kind: Kind, request: Option<&str>) -> (Type, Option<Kind>, Option<String>) {
    (Type::Attention, Some(kind), request.map(str::to_owned))
}

fn cleared(request: Option<&str>) -> (Type, Option<Kind>, Option<String>) {
    (Type::AttentionCleared, None, request.map(str::to_owned))
}

#[test]
fn each_kind_is_raised_once() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    f.request("q1", "command", "pending");
    f.request("q1", "command", "resolved");
    f.request("q2", "user_input", "pending");
    f.request("q2", "user_input", "resolved");
    f.run("r1", 1, "completed");
    f.run("r2", 2, "running");
    f.run("r2", 2, "failed");
    assert_eq!(
        f.sent(),
        vec![
            raised(Kind::Approval, Some("q1")),
            cleared(Some("q1")),
            raised(Kind::Input, Some("q2")),
            cleared(Some("q2")),
            raised(Kind::TurnFinished, None),
            raised(Kind::TurnFailed, None),
        ]
    );
    let rows = f.outbox();
    assert_eq!(rows[0].thread_title.as_deref(), Some("Fix the build"));
    assert_eq!(rows[1].thread_title, None, "a clear carries no title");
    assert!(
        rows.iter()
            .all(|row| row.thread_id == "t" && row.event_id.len() == 26)
    );
    let event = rows[4].to_event("env");
    assert_eq!(event.environment_id, "env");
    assert_eq!(event.occurred_at, rows[4].occurred_at);
}

#[test]
fn a_pending_secret_is_input() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    f.tick(1_000);
    let item = json!({
        "id": "secret-1", "type": "secret_request", "status": "waiting", "runId": "r1",
        "nodeId": "n1", "startedAt": iso(f.now()), "updatedAt": iso(f.now()),
    });
    f.write(|tx| {
        tx.append(Draft::new("t", "turn-item.updated", item))
            .unwrap();
    });
    assert_eq!(f.sent(), vec![raised(Kind::Input, Some("secret-1"))]);
}

#[test]
fn nothing_is_written_when_attention_is_off() {
    let mut f = Fixture::new(false);
    f.run("r1", 1, "running");
    f.request("q1", "command", "pending");
    f.run("r1", 1, "completed");
    assert!(f.outbox().is_empty());
}

#[test]
fn delegated_children_side_chats_and_archived_threads_are_skipped() {
    let subagent = json!({"lineage": {"parentThreadId": "p", "relationshipToParent": "subagent", "rootThreadId": "p"}});
    let delegated = json!({"delegatedFrom": {"environmentId": "e", "threadId": "x"}});
    let side_chat = json!({"lineage": {"parentThreadId": "p", "relationshipToParent": "fork", "rootThreadId": "p", "sideChat": true}});
    let archived = json!({"archivedAt": iso(T0)});
    for extra in [subagent, delegated, side_chat, archived] {
        let mut f = Fixture::with_thread(true, extra.clone());
        f.run("r1", 1, "running");
        f.request("q1", "command", "pending");
        f.request("q1", "command", "resolved");
        f.run("r1", 1, "completed");
        assert!(f.outbox().is_empty(), "{extra}");
    }
}

#[test]
fn a_fork_is_a_top_level_thread() {
    let fork = json!({"lineage": {"parentThreadId": "p", "relationshipToParent": "fork", "rootThreadId": "p"}});
    let mut f = Fixture::with_thread(true, fork);
    f.run("r1", 1, "running");
    f.run("r1", 1, "completed");
    assert_eq!(f.sent(), vec![raised(Kind::TurnFinished, None)]);
}

#[test]
fn auth_refresh_requests_are_not_approvals() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    f.request("q1", "auth_refresh", "pending");
    assert!(f.outbox().is_empty());
}

#[test]
fn a_snoozed_thread_holds_back_completions_but_not_approvals() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    let until = iso(f.now() + 60 * 60 * 1000);
    f.update_thread(json!({"snoozedUntil": until, "snoozedAt": iso(f.now())}));
    f.run("r1", 1, "completed");
    assert!(f.outbox().is_empty(), "a completion while snoozed");
    f.run("r2", 2, "running");
    f.request("q1", "command", "pending");
    assert_eq!(f.sent(), vec![raised(Kind::Approval, Some("q1"))]);
    f.request("q1", "command", "resolved");
    f.request("q2", "user_input", "pending");
    f.request("q2", "user_input", "resolved");
    f.run("r2", 2, "failed");
    assert_eq!(
        f.sent(),
        vec![
            raised(Kind::Approval, Some("q1")),
            cleared(Some("q1")),
            raised(Kind::Input, Some("q2")),
            cleared(Some("q2")),
            raised(Kind::TurnFailed, None),
        ],
        "a newer question and a newer failure raise the thread's hand"
    );
}

#[test]
fn a_question_older_than_the_snooze_waits() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    let shell = |snoozed: bool| {
        let mut row = json!({
            "id": "t", "title": "T", "lineage": {}, "archivedAt": null, "deletedAt": null,
            "status": "running", "latestRunId": "r1",
            "pendingRuntimeRequest": {"id": "q1", "kind": "user_input", "createdAt": iso(T0)},
        });
        if snoozed {
            row["snoozedUntil"] = json!(iso(T0 + 3_600_000));
            row["snoozedAt"] = json!(iso(T0 + 1_000));
        }
        row
    };
    let need = need(&shell(true)).unwrap();
    assert!(snoozed(&shell(true), &need, T0 + 2_000));
    assert!(
        !snoozed(&shell(true), &need, T0 + 3_600_001),
        "the snooze ended"
    );
    assert!(!snoozed(&shell(false), &need, T0 + 2_000));
}

#[test]
fn the_first_shell_row_never_raises() {
    let mut f = Fixture::new(true);
    f.tick(1_000);
    let at = iso(f.now());
    let thread = json!({
        "id": "u", "projectId": "p", "title": "Imported",
        "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "u"},
        "createdAt": at, "archivedAt": null, "deletedAt": null,
    });
    let run = json!({"id": "r1", "ordinal": 1, "status": "completed", "requestedAt": at, "startedAt": at, "completedAt": at});
    f.write(|tx| {
        tx.append(Draft::new("u", "thread.created", thread))
            .unwrap();
        tx.append(Draft::new("u", "run.updated", run)).unwrap();
    });
    assert!(f.outbox().is_empty());
}

#[test]
fn a_key_is_sent_once() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    f.request("a", "command", "pending");
    f.request("b", "command", "pending");
    // `b` is answered, so the shell shows `a` again: it was sent, so it is not sent again.
    f.request("b", "command", "resolved");
    // A rename of a finished thread changes the shell, not the key.
    f.request("a", "command", "resolved");
    f.run("r1", 1, "completed");
    f.update_thread(json!({"title": "Renamed"}));
    assert_eq!(
        f.sent(),
        vec![
            raised(Kind::Approval, Some("a")),
            raised(Kind::Approval, Some("b")),
            cleared(Some("b")),
            cleared(Some("a")),
            raised(Kind::TurnFinished, None),
        ]
    );
}

#[test]
fn a_request_still_pending_under_a_newer_one_is_not_cleared() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    f.request("a", "command", "pending");
    f.request("b", "command", "pending");
    assert_eq!(
        f.sent(),
        vec![
            raised(Kind::Approval, Some("a")),
            raised(Kind::Approval, Some("b")),
        ]
    );
}

#[test]
fn opening_the_thread_clears_what_was_sent() {
    let mut f = Fixture::new(true);
    f.update_thread(json!({"lastVisitedAt": iso(f.now())}));
    assert!(f.outbox().is_empty(), "nothing was sent, so nothing clears");
    f.run("r1", 1, "running");
    f.run("r1", 1, "completed");
    f.update_thread(json!({"lastVisitedAt": iso(f.now())}));
    f.update_thread(json!({"lastVisitedAt": iso(f.now())}));
    assert_eq!(
        f.sent(),
        vec![raised(Kind::TurnFinished, None), cleared(None)],
        "the second visit has nothing left to clear"
    );
}

#[test]
fn the_outbox_survives_a_restart() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    f.run("r1", 1, "completed");
    let before = f.outbox();
    assert_eq!(before.len(), 1);
    let reopened = open(&f.path, &f.clock, true);
    f.store = reopened;
    assert_eq!(f.outbox(), before);
    assert_eq!(next_due(f.store.raw()).unwrap(), Some(before[0].created_ms));
}

#[test]
fn delivery_retry_and_stale_drop_change_only_their_row() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    f.request("q1", "command", "pending");
    f.request("q1", "command", "resolved");
    let rows = f.outbox();
    assert_eq!(rows.len(), 2);
    let conn = f.store.raw();
    retry(conn, rows[0].outbox_id, 1, T0 + 999_999).unwrap();
    let due_now = due(conn, f.now(), 10).unwrap();
    assert_eq!(due_now.len(), 1, "the retried row waits");
    assert_eq!(due_now[0].outbox_id, rows[1].outbox_id);
    delivered(conn, rows[1].outbox_id).unwrap();
    assert_eq!(next_due(conn).unwrap(), Some(T0 + 999_999));
    let again = due(conn, T0 + 999_999, 10).unwrap();
    assert_eq!(again[0].attempts, 1);
    assert_eq!(drop_older(conn, rows[0].created_ms + 1).unwrap(), 1);
    assert_eq!(next_due(conn).unwrap(), None);
}

fn wake_shell(run: &str, completed: bool, monitor: bool) -> Value {
    json!({
        "id": "t", "title": "T", "lineage": {}, "archivedAt": null, "deletedAt": null,
        "status": if completed { "completed" } else { "running" },
        "latestRunId": run,
        "latestRunCompletedAt": iso(T0),
        "latestRunBackgroundWake": true,
        "pendingRuntimeRequest": null,
        "pendingBackgroundTasks": if monitor {
            json!([{"taskId": "m1", "kind": "monitor", "description": "tail"}])
        } else {
            json!([{"taskId": "pull-request-watch:github.com/a/b#1", "kind": "monitor", "description": "pr"}])
        },
    })
}

#[test]
fn a_wake_completion_waits_out_the_grace_and_a_new_run_cancels_it() {
    let f = Fixture::new(true);
    let conn = f.store.raw();
    // A Monitor still runs: its progress wake's completion is not raised.
    assert!(
        !record(
            conn,
            "t",
            Some(&wake_shell("w1", false, true)),
            &wake_shell("w1", true, true),
            T0,
            &iso(T0)
        )
        .unwrap()
    );
    // A pull request watch does not hold it: it is raised after the grace.
    assert!(
        record(
            conn,
            "t",
            Some(&wake_shell("w1", false, false)),
            &wake_shell("w1", true, false),
            T0,
            &iso(T0)
        )
        .unwrap()
    );
    assert!(
        due(conn, T0 + RELEASED_COMPLETION_GRACE_MS - 1, 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        due(conn, T0 + RELEASED_COMPLETION_GRACE_MS, 10)
            .unwrap()
            .len(),
        1
    );
    // A new run inside the grace drops it.
    record(
        conn,
        "t",
        Some(&wake_shell("w1", true, false)),
        &wake_shell("w2", false, false),
        T0 + 1_000,
        &iso(T0 + 1_000),
    )
    .unwrap();
    assert_eq!(next_due(conn).unwrap(), None);
}

#[test]
fn a_completion_past_its_grace_is_kept_when_a_run_starts() {
    let f = Fixture::new(true);
    let conn = f.store.raw();
    record(
        conn,
        "t",
        Some(&wake_shell("w1", false, false)),
        &wake_shell("w1", true, false),
        T0,
        &iso(T0),
    )
    .unwrap();
    let later = T0 + RELEASED_COMPLETION_GRACE_MS + 1;
    record(
        conn,
        "t",
        Some(&wake_shell("w1", true, false)),
        &wake_shell("w2", false, false),
        later,
        &iso(later),
    )
    .unwrap();
    assert_eq!(due(conn, later, 10).unwrap().len(), 1);
}
