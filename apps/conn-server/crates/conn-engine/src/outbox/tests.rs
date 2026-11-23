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
        Effect::CleanupHtmlAttachments {
            thread_id: "t".into(),
            ids: vec![("a".into(), "b".into())],
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
    assert_eq!(t.1.prune_settled_effects().unwrap(), 1_203);
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
    assert_eq!(t.1.prune_settled_effects().unwrap(), 0);
}
