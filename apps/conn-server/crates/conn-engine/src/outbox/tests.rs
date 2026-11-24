//! The outbox store, as T3's `FoundationPersistence.test.ts` proves `EffectOutbox`.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::*;
use crate::commands::Effect;
use crate::store::Store;

struct TempStore(PathBuf, Store);

impl TempStore {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("conn-outbox-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("engine.sqlite")).unwrap();
        Self(dir, store)
    }
}

impl Drop for TempStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn close(thread: &str) -> Effect {
    Effect::CloseSession {
        thread_id: thread.into(),
    }
}

fn start(thread: &str, run: &str) -> Effect {
    Effect::StartTurn {
        thread_id: thread.into(),
        run_id: run.into(),
    }
}

fn title(thread: &str) -> Effect {
    Effect::GenerateTitle {
        thread_id: thread.into(),
        request_id: "r".into(),
        regenerate: false,
    }
}

fn enqueue(store: &mut Store, effects: &[Effect]) {
    let mut tx = store.tx().unwrap();
    tx.enqueue(Some("command"), effects).unwrap();
    tx.commit(None).unwrap();
}

/// What a claim took, as `(thread, effect_type)`.
fn claimed(store: &Store) -> Vec<(i64, String, String)> {
    store
        .claim_effects(64)
        .unwrap()
        .into_iter()
        .map(|c| {
            (
                c.id,
                c.effect.thread_id().to_owned(),
                c.effect.effect_type().to_owned(),
            )
        })
        .collect()
}

#[test]
fn every_effect_round_trips_under_its_effect_type() {
    let effects = vec![
        Effect::Rollback(crate::rollback::RollbackRequest {
            thread_id: "t".into(),
            command_id: "c".into(),
            provider_thread_id: "p".into(),
            checkpoint_id: "k".into(),
            scope_id: "s".into(),
            restore_files: Some(false),
            resume_snapshot: None,
        }),
        Effect::CaptureCheckpoint {
            thread_id: "t".into(),
            run_id: "r".into(),
        },
        start("t", "r"),
        Effect::Steer {
            thread_id: "t".into(),
            run_id: "r".into(),
            message_id: "m".into(),
        },
        Effect::Interrupt {
            thread_id: "t".into(),
            run_id: "r".into(),
        },
        Effect::AbandonStart {
            thread_id: "t".into(),
            run_id: "r".into(),
        },
        Effect::StopBackgroundWork {
            thread_id: "t".into(),
            run_id: "r".into(),
        },
        Effect::Respond {
            thread_id: "t".into(),
            request: json!({"requestId": "q"}),
        },
        close("t"),
        Effect::ApplyModelSelection {
            thread_id: "t".into(),
            selection: json!({"model": "m"}),
        },
        Effect::CleanupAttachments {
            thread_id: "t".into(),
            ids: vec![("a".into(), "b".into())],
            attachment_ids: vec!["c".into()],
        },
        Effect::RemoteTaskChanged {
            thread_id: "t".into(),
            task_id: "x".into(),
        },
        Effect::ThreadClosed {
            thread_id: "t".into(),
            reason: crate::ThreadClose::Deleted,
        },
        title("t"),
    ];
    for effect in effects {
        let text = serde_json::to_string(&effect).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["type"], effect.effect_type(), "{text}");
        let back: Effect = serde_json::from_str(&text).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), text);
    }
}

/// A cleanup row stored with fewer fields than this build knows still decodes (audit 6.7 adds
/// one).
#[test]
fn a_cleanup_row_without_its_newer_fields_decodes() {
    let effect: Effect =
        serde_json::from_value(json!({"type": "attachment.cleanup", "threadId": "t"})).unwrap();
    assert!(matches!(
        effect,
        Effect::CleanupAttachments { ids, attachment_ids, .. }
            if ids.is_empty() && attachment_ids.is_empty()
    ));
}

/// `enqueue` writes rows only in the command's transaction: a rolled back write leaves none,
/// and a commit wakes the worker.
#[tokio::test(flavor = "current_thread")]
async fn rows_commit_with_their_command_and_wake_the_worker() {
    let mut t = TempStore::new("enqueue");
    let wake = t.1.effects_wake.clone();
    {
        let mut tx = t.1.tx().unwrap();
        tx.enqueue(Some("c1"), &[close("t1")]).unwrap();
        tx.rollback();
    }
    assert!(claimed(&t.1).is_empty());
    enqueue(&mut t.1, &[close("t1")]);
    tokio::time::timeout(std::time::Duration::from_secs(1), wake.notified())
        .await
        .expect("the commit wakes the worker");
    assert_eq!(claimed(&t.1).len(), 1);
}

/// "allows only one worker to claim an available effect", "runs distinct threads concurrently
/// while serializing effects within a thread".
#[test]
fn a_thread_runs_one_effect_at_a_time_in_commit_order() {
    let mut t = TempStore::new("order");
    enqueue(&mut t.1, &[close("t1"), start("t1", "r1")]);
    enqueue(&mut t.1, &[close("t2")]);
    let first = claimed(&t.1);
    assert_eq!(
        first
            .iter()
            .map(|(_, thread, ty)| (thread.as_str(), ty.as_str()))
            .collect::<Vec<_>>(),
        [
            ("t1", "provider-session.detach"),
            ("t2", "provider-session.detach")
        ]
    );
    assert!(claimed(&t.1).is_empty(), "a running row holds its thread");
    assert!(
        t.1.settle_effect(first[0].0, Settled::Succeeded, None)
            .unwrap()
    );
    assert!(
        !t.1.settle_effect(first[0].0, Settled::Succeeded, None)
            .unwrap(),
        "a settled row settles once"
    );
    let next = claimed(&t.1);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].2, "provider-turn.start");
}

/// A replaced or dropped engine never writes: it claims, settles and commits nothing, so a
/// newer engine on the same store runs its rows alone
/// (`engine_tests::a_replaced_engine_s_running_effect_writes_nothing`).
#[test]
fn an_engine_that_no_longer_owns_the_store_writes_nothing() {
    let mut t = TempStore::new("unowned");
    t.1.take_ownership(None).unwrap();
    enqueue(&mut t.1, &[start("t1", "r1"), start("t2", "r2")]);
    let running = claimed(&t.1);
    assert_eq!(running.len(), 2);

    // A newer engine opens the same database: the older one is fenced.
    let mut newer = Store::open(&t.0.join("engine.sqlite")).unwrap();
    let released = newer.take_ownership(None).unwrap();
    enqueue(&mut newer, &[start("t3", "r3")]);
    assert!(t.1.claim_effects(64).unwrap().is_empty());
    assert!(
        !t.1.settle_effect(running[0].0, Settled::Succeeded, None)
            .unwrap()
    );
    let mut tx = t.1.tx().unwrap();
    tx.enqueue(None, &[start("t4", "r4")]).unwrap();
    assert_eq!(tx.commit(None).unwrap_err(), crate::store::NOT_OWNER);
    assert_eq!(t.1.prune_settled_batch().unwrap(), 0);

    // The newer engine still owns it, until its drop releases it.
    assert!(
        newer
            .settle_effect(running[1].0, Settled::Succeeded, None)
            .unwrap()
    );
    released.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(newer.claim_effects(64).unwrap().is_empty());
    assert!(
        !newer
            .settle_effect(running[0].0, Settled::Succeeded, None)
            .unwrap()
    );
    let mut tx = newer.tx().unwrap();
    tx.enqueue(None, &[start("t5", "r5")]).unwrap();
    assert_eq!(tx.commit(None).unwrap_err(), crate::store::NOT_OWNER);
}

/// "runs title generation beside critical work while serializing each lane", and a free row
/// passes a running thread lane.
#[test]
fn titles_and_free_rows_do_not_wait_for_the_thread_lane() {
    let mut t = TempStore::new("lanes");
    enqueue(
        &mut t.1,
        &[
            start("t1", "r1"),
            title("t1"),
            title("t1"),
            Effect::AbandonStart {
                thread_id: "t1".into(),
                run_id: "r1".into(),
            },
        ],
    );
    let types: Vec<_> = claimed(&t.1).into_iter().map(|(_, _, ty)| ty).collect();
    assert_eq!(
        types,
        [
            "provider-turn.start",
            "thread-title.generate",
            "provider-turn.abandon-start"
        ]
    );
}

/// "fails an effect this build cannot decode and claims the thread's next effect".
#[test]
fn an_unreadable_row_fails_and_frees_its_thread() {
    let mut t = TempStore::new("decode");
    enqueue(&mut t.1, &[close("t1"), start("t1", "r1")]);
    t.1.raw()
        .execute(
            "UPDATE effect_outbox SET payload = '{\"type\":\"from-a-newer-build\"}' WHERE id = 1",
            [],
        )
        .unwrap();
    let next = claimed(&t.1);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].2, "provider-turn.start");
    assert_eq!(t.1.effect_status(1).unwrap().as_deref(), Some("failed"));
}

/// "prunes settled effects past retention in batches and keeps the rest".
#[test]
fn pruning_drops_old_settled_rows_in_batches_and_keeps_the_rest() {
    let t = TempStore::new("prune");
    let now = t.1.now_millis();
    let iso = conn_support::time::iso_from_ms;
    let old = iso(now - SETTLED_RETENTION_MS - 60_000);
    let recent = iso(now - SETTLED_RETENTION_MS + 60_000);
    let insert = |count: i64, status: &str, completed: Option<&str>| {
        t.1.raw()
            .execute(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
                 INSERT INTO effect_outbox (thread_id, lane, effect_type, payload, status,
                   created_at, updated_at, completed_at)
                 SELECT 't', 'thread', 'provider-session.detach',
                   '{\"type\":\"provider-session.detach\",\"threadId\":\"t\"}', ?2, ?4, ?4, ?3
                 FROM n",
                rusqlite::params![count, status, completed, old],
            )
            .unwrap();
    };
    insert(1_201, "succeeded", Some(&old));
    insert(2, "cancelled", Some(&old));
    insert(1, "succeeded", Some(&recent));
    insert(1, "failed", Some(&old));
    insert(1, "pending", None);
    insert(1, "running", None);
    let batches: Vec<usize> =
        std::iter::from_fn(|| Some(t.1.prune_settled_batch().unwrap()).filter(|&n| n > 0))
            .collect();
    assert_eq!(batches, [PRUNE_BATCH, PRUNE_BATCH, 203]);
    let mut left: Vec<String> =
        t.1.raw()
            .prepare("SELECT status FROM effect_outbox")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
    left.sort();
    assert_eq!(left, ["failed", "pending", "running", "succeeded"]);
    assert_eq!(t.1.prune_settled_batch().unwrap(), 0);
}

fn rollback_phase(store: &Store, command: &str) -> String {
    store
        .raw()
        .query_row(
            "SELECT COALESCE(json_extract(progress, '$.phase'), 'admitted') FROM effect_outbox
             WHERE command_id = ?1",
            [command],
            |row| row.get(0),
        )
        .unwrap()
}

/// The gate's probe: an engine replaced while its rollback was admitted must not mark the
/// provider rollback sent (and then send it): the newer engine runs that rollback.
#[test]
fn a_replaced_engine_cannot_move_a_rollback_on() {
    let mut t = TempStore::new("rollback-fence");
    t.1.take_ownership(None).unwrap();
    let mut tx = t.1.tx().unwrap();
    tx.enqueue(
        Some("rb"),
        &[Effect::Rollback(crate::rollback::RollbackRequest {
            thread_id: "t1".into(),
            command_id: "rb".into(),
            provider_thread_id: "p".into(),
            checkpoint_id: "k".into(),
            scope_id: "s".into(),
            restore_files: Some(false),
            resume_snapshot: None,
        })],
    )
    .unwrap();
    tx.commit(None).unwrap();
    let mut newer = Store::open(&t.0.join("engine.sqlite")).unwrap();
    newer.take_ownership(None).unwrap();
    assert!(
        !t.1.advance_rollback("t1", "rb", "admitted", "provider", None)
            .unwrap()
    );
    assert_eq!(rollback_phase(&newer, "rb"), "admitted");
    // The owner moves it on exactly once; a second move from `admitted` moves nothing.
    assert!(
        newer
            .advance_rollback("t1", "rb", "admitted", "provider", None)
            .unwrap()
    );
    assert!(
        !newer
            .advance_rollback("t1", "rb", "admitted", "provider", None)
            .unwrap()
    );
    assert_eq!(rollback_phase(&newer, "rb"), "provider");
}

/// The gate's probe: engine A opened, then engine B took the store and committed a start.
/// A's startup cancellation, late, must not cancel B's row: a stale open aborts.
#[test]
fn a_stale_open_cancels_nothing() {
    let mut t = TempStore::new("stale-open");
    t.1.take_ownership(None).unwrap();
    let mut newer = Store::open(&t.0.join("engine.sqlite")).unwrap();
    newer.take_ownership(None).unwrap();
    enqueue(&mut newer, &[start("t1", "r1")]);
    // The #269 gate's probe: a store from an older build, with a rollback journal.
    legacy_journal(&newer, &[("rb", "t2", "admitted", None)]);
    assert_eq!(
        t.1.reconcile_after_process_loss(true).unwrap_err(),
        crate::store::NOT_OWNER
    );
    assert_eq!(newer.effect_status(1).unwrap().as_deref(), Some("pending"));
    // The stale opener migrated nothing; the current one moves the journal.
    let journal = |store: &Store| -> bool {
        store
            .raw()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'pending_rollbacks')",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert!(journal(&newer));
    newer.reconcile_after_process_loss(true).unwrap();
    assert!(!journal(&newer));
    assert_eq!(
        rollback_rows(&newer),
        [("rb".to_owned(), "pending".to_owned())]
    );
}

/// A store from before the outbox kept admitted rollbacks in `pending_rollbacks`: the next
/// start moves them into the outbox with their phase, and drops that table.
#[test]
fn legacy_pending_rollbacks_move_into_the_outbox() {
    let t = TempStore::new("legacy-rollbacks");
    t.1.raw()
        .execute_batch(
            "CREATE TABLE pending_rollbacks (command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
               request TEXT NOT NULL, phase TEXT NOT NULL, snapshot TEXT);
             INSERT INTO pending_rollbacks VALUES ('rb-1', 't1',
               '{\"providerThreadId\":\"p\",\"checkpointId\":\"k\",\"scopeId\":\"s\",\"restoreFiles\":null}',
               'admitted', NULL);
             INSERT INTO pending_rollbacks VALUES ('rb-2', 't2',
               '{\"providerThreadId\":\"p\",\"checkpointId\":\"k\",\"scopeId\":\"s\",\"restoreFiles\":false}',
               'provider_done', '{\"id\":\"p\"}');",
        )
        .unwrap();
    assert_eq!(t.1.reconcile_after_process_loss(true).unwrap(), (2, 0));
    let rollbacks = t.1.unsettled_rollbacks().unwrap();
    assert_eq!(
        rollbacks,
        [
            UnsettledRollback {
                command_id: "rb-1".into(),
                thread_id: "t1".into(),
                phase: "admitted".into(),
                snapshot: None,
            },
            UnsettledRollback {
                command_id: "rb-2".into(),
                thread_id: "t2".into(),
                phase: "provider_done".into(),
                snapshot: Some(json!({"id": "p"})),
            },
        ]
    );
    let mut claimed = t.1.claim_effects(64).unwrap();
    assert_eq!(claimed.len(), 2);
    let second = claimed.pop().unwrap();
    let Effect::Rollback(mut request) = second.effect else {
        panic!("a rollback");
    };
    assert_eq!(request.restore_files, Some(false));
    crate::rollback::resume_from(&mut request, second.progress.as_ref());
    assert_eq!(request.resume_snapshot, Some(json!({"id": "p"})));
    let gone: bool =
        t.1.raw()
            .query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'pending_rollbacks')",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert!(gone);
}

fn rollback_row(thread: &str, command: &str) -> Effect {
    Effect::Rollback(crate::rollback::RollbackRequest {
        thread_id: thread.into(),
        command_id: command.into(),
        provider_thread_id: "p".into(),
        checkpoint_id: "k".into(),
        scope_id: "s".into(),
        restore_files: Some(false),
        resume_snapshot: None,
    })
}

/// The previous build's journal, with one entry per `(command, thread, phase, snapshot)`.
fn legacy_journal(store: &Store, entries: &[(&str, &str, &str, Option<&str>)]) {
    store
        .raw()
        .execute_batch(
            "CREATE TABLE pending_rollbacks (command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
               request TEXT NOT NULL, phase TEXT NOT NULL, snapshot TEXT);",
        )
        .unwrap();
    for (command, thread, phase, snapshot) in entries {
        store
            .raw()
            .execute(
                "INSERT INTO pending_rollbacks VALUES (?1, ?2,
                   '{\"providerThreadId\":\"p\",\"checkpointId\":\"k\",\"scopeId\":\"s\",\"restoreFiles\":false}',
                   ?3, ?4)",
                rusqlite::params![command, thread, phase, snapshot],
            )
            .unwrap();
    }
}

fn set_status(store: &Store, command: &str, status: &str) {
    store
        .raw()
        .execute(
            "UPDATE effect_outbox SET status = ?2 WHERE json_extract(payload, '$.commandId') = ?1",
            [command, status],
        )
        .unwrap();
}

fn rollback_rows(store: &Store) -> Vec<(String, String)> {
    store
        .raw()
        .prepare(
            "SELECT json_extract(payload, '$.commandId'), status FROM effect_outbox
             WHERE effect_type = 'provider-thread.rollback' ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// The gate's probes: a store the previous build (#268) left with outbox rows beside its
/// journal. Each rollback keeps one row, with the journal's phase:
/// - a running row whose journal says `provider_done` goes on from the provider's answer,
///   not from `admitted` (which would send the provider rollback again);
/// - a row written with no outer `command_id` still settles when its failure is recorded;
/// - a row whose journal entry is gone committed its result before the upgrade: it settles
///   and never runs again.
#[test]
fn a_migration_reconciles_rows_the_previous_build_left() {
    let mut t = TempStore::new("legacy-reconcile");
    enqueue(&mut t.1, &[rollback_row("t1", "rb-done")]);
    let mut tx = t.1.tx().unwrap();
    tx.enqueue(None, &[rollback_row("t2", "rb-sent")]).unwrap();
    tx.commit(None).unwrap();
    enqueue(&mut t.1, &[rollback_row("t3", "rb-gone")]);
    set_status(&t.1, "rb-done", "running");
    set_status(&t.1, "rb-gone", "running");
    legacy_journal(
        &t.1,
        &[
            ("rb-done", "t1", "provider_done", Some("{\"id\":\"p\"}")),
            ("rb-sent", "t2", "provider", None),
            ("rb-new", "t4", "admitted", None),
        ],
    );
    t.1.reconcile_after_process_loss(true).unwrap();
    assert_eq!(
        rollback_rows(&t.1),
        [
            ("rb-done".to_owned(), "pending".to_owned()),
            ("rb-sent".to_owned(), "pending".to_owned()),
            ("rb-gone".to_owned(), "succeeded".to_owned()),
            ("rb-new".to_owned(), "pending".to_owned()),
        ]
    );
    let phases: Vec<_> =
        t.1.unsettled_rollbacks()
            .unwrap()
            .into_iter()
            .map(|r| (r.command_id, r.phase))
            .collect();
    assert_eq!(
        phases,
        [
            ("rb-done".to_owned(), "provider_done".to_owned()),
            ("rb-sent".to_owned(), "provider".to_owned()),
            ("rb-new".to_owned(), "admitted".to_owned()),
        ]
    );
    // The start records `rb-sent`'s failure (`rollback::recover_pending`); that settles it.
    let tx = t.1.tx().unwrap();
    tx.settle_rollback("t2", "rb-sent", Settled::Succeeded, None)
        .unwrap();
    tx.commit(None).unwrap();
    let mut claimed = t.1.claim_effects(64).unwrap();
    let ids: Vec<_> = claimed
        .iter()
        .map(|c| match &c.effect {
            Effect::Rollback(r) => r.command_id.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(ids, ["rb-done", "rb-new"]);
    let done = claimed.remove(0);
    let Effect::Rollback(mut request) = done.effect else {
        unreachable!()
    };
    crate::rollback::resume_from(&mut request, done.progress.as_ref());
    assert_eq!(request.resume_snapshot, Some(json!({"id": "p"})));
}

/// The gate's probe: the migration is one transaction. When it fails part way, nothing of it
/// stays, so the next start does not insert the journal's rows twice.
#[test]
fn an_interrupted_migration_leaves_nothing() {
    let mut t = TempStore::new("legacy-atomic");
    enqueue(&mut t.1, &[rollback_row("boom", "rb-boom")]);
    legacy_journal(
        &t.1,
        &[
            ("rb-new", "t1", "admitted", None),
            ("rb-boom", "boom", "provider_done", Some("{\"id\":\"p\"}")),
        ],
    );
    // Fails the migration's update of the existing row, after its insert.
    t.1.raw()
        .execute_batch(
            "CREATE TEMP TRIGGER boom BEFORE UPDATE ON effect_outbox WHEN OLD.thread_id = 'boom'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();
    assert!(t.1.reconcile_after_process_loss(true).is_err());
    assert_eq!(
        rollback_rows(&t.1),
        [("rb-boom".to_owned(), "pending".to_owned())]
    );
    t.1.raw().execute_batch("DROP TRIGGER boom").unwrap();
    t.1.reconcile_after_process_loss(true).unwrap();
    assert_eq!(
        rollback_rows(&t.1),
        [
            ("rb-boom".to_owned(), "pending".to_owned()),
            ("rb-new".to_owned(), "pending".to_owned()),
        ]
    );
}

/// `reconcileAfterProcessLoss`: process-bound rows are cancelled whether pending or running;
/// a running replay-safe row is pending again, and a pending one stays.
#[test]
fn process_loss_cancels_process_bound_rows_and_requeues_the_rest() {
    let mut t = TempStore::new("reconcile");
    enqueue(&mut t.1, &[start("t1", "r1"), close("t2"), close("t3")]);
    t.1.raw()
        .execute(
            "UPDATE effect_outbox SET status = 'running' WHERE id IN (1, 2)",
            [],
        )
        .unwrap();
    assert_eq!(t.1.reconcile_after_process_loss(true).unwrap(), (1, 1));
    let statuses: Vec<_> = (1..=3)
        .map(|id| t.1.effect_status(id).unwrap().unwrap())
        .collect();
    assert_eq!(statuses, ["cancelled", "pending", "pending"]);
}

/// The restart leaves a `waiting` run's capture to a capture row the previous process left.
#[test]
fn a_queued_capture_is_found_by_its_run() {
    let mut t = TempStore::new("capture-queued");
    enqueue(
        &mut t.1,
        &[Effect::CaptureCheckpoint {
            thread_id: "t1".into(),
            run_id: "run:t1:1".into(),
        }],
    );
    let tx = t.1.tx().unwrap();
    assert!(tx.capture_queued("run:t1:1").unwrap());
    assert!(!tx.capture_queued("run:t1:2").unwrap());
    tx.rollback();
}

/// The gate's probe: a restart runs a replay-safe row again under the same id. The dropped
/// engine's worker, still running that row, settles nothing; the new engine's claim stays
/// running (the engine lease, `Store::take_ownership`).
#[test]
fn a_replaced_worker_cannot_settle_the_new_claim_of_a_replayed_row() {
    let mut t = TempStore::new("replayed-claim");
    t.1.take_ownership(None).unwrap();
    enqueue(&mut t.1, &[close("t1")]);
    let old = claimed(&t.1);
    assert_eq!(old.len(), 1);
    let mut newer = Store::open(&t.0.join("engine.sqlite")).unwrap();
    newer.take_ownership(None).unwrap();
    newer.reconcile_after_process_loss(true).unwrap();
    let new = claimed(&newer);
    assert_eq!(
        new.first().map(|c| c.0),
        Some(old[0].0),
        "the same row runs again"
    );
    assert!(
        !t.1.settle_effect(old[0].0, Settled::Succeeded, None)
            .unwrap()
    );
    assert_eq!(
        newer.effect_status(old[0].0).unwrap().as_deref(),
        Some("running")
    );
}
