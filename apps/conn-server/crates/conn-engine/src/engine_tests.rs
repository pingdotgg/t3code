//! Engine tests: commands into a temp-file store, stream items out, and a restart.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use conn_contract::{from_json, to_json};
use serde_json::{Value, json};
use tokio::time::timeout;

use crate::fake::FakeProvider;
use crate::{Engine, EngineConfig, EngineError, ProjectConfig, SqliteEngine, Subscription};

const ROOT: &str = "/tmp/conn-engine-project";

struct TempDb(PathBuf);

impl TempDb {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("conn-engine-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> PathBuf {
        self.0.join("engine.sqlite")
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn open(db: &TempDb) -> (SqliteEngine, Arc<FakeProvider>) {
    open_with(db, FakeProvider::new("claudeAgent"))
}

fn open_with(db: &TempDb, provider: FakeProvider) -> (SqliteEngine, Arc<FakeProvider>) {
    let provider = Arc::new(provider);
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    (SqliteEngine::open(config).unwrap(), provider)
}

fn project_id() -> String {
    SqliteEngine::project_id_for(ROOT)
}

fn create(thread: &str, command: &str) -> Value {
    json!({
        "type": "thread.create", "commandId": command, "threadId": thread,
        "projectId": project_id(), "title": "New thread",
        "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
    })
}

fn message(thread: &str, command: &str, text: &str) -> Value {
    json!({
        "type": "message.dispatch", "commandId": command, "threadId": thread,
        "messageId": format!("message:{command}"), "text": text, "attachments": [],
        "dispatchMode": {"type": "start_immediately"}, "createdBy": "user", "creationSource": "web",
    })
}

async fn dispatch(engine: &SqliteEngine, command: Value) -> u64 {
    let result = engine.dispatch(from_json(command).unwrap()).await;
    match result {
        Ok(result) => to_json(&result)["sequence"].as_u64().unwrap(),
        Err(EngineError::Rejected(e)) => panic!("rejected: {}", to_json(&e)),
        Err(EngineError::Internal(e)) => panic!("internal: {e}"),
    }
}

async fn command_events(engine: &SqliteEngine, id: &'static str) -> Vec<Value> {
    engine
        .inner()
        .db(move |store| store.command_events(id))
        .await
        .unwrap()
}

async fn next<T: serde::Serialize, E: serde::Serialize>(stream: &mut Subscription<T, E>) -> Value {
    let item = timeout(Duration::from_secs(5), stream.recv())
        .await
        .expect("stream item in time")
        .expect("stream open");
    match item {
        Ok(item) => to_json(&item),
        Err(e) => panic!("stream failed: {}", to_json(&e)),
    }
}

/// Reads thread events until a `run.updated` with a final status. Returns `(type, payload)`.
async fn until_run_ends<E: serde::Serialize>(
    stream: &mut Subscription<conn_contract::ThreadStreamItem, E>,
) -> Vec<(String, Value)> {
    let mut seen = vec![];
    loop {
        let item = next(stream).await;
        assert_eq!(item["kind"], "event", "{item}");
        let event = &item["event"];
        let ty = event["type"].as_str().unwrap().to_owned();
        let ended = ty == "run.updated"
            && ["completed", "interrupted", "failed", "cancelled"]
                .contains(&event["payload"]["status"].as_str().unwrap());
        seen.push((ty, event["payload"].clone()));
        if ended {
            return seen;
        }
    }
}

fn kinds(events: &[(String, Value)]) -> Vec<String> {
    events
        .iter()
        .map(|(ty, payload)| {
            let detail = payload["kind"]
                .as_str()
                .or(payload["type"].as_str())
                .or(payload["role"].as_str())
                .unwrap_or("");
            let status = payload["status"].as_str().unwrap_or("");
            let streaming = if payload["streaming"] == true {
                " streaming"
            } else {
                ""
            };
            format!("{ty} {detail} {status}{streaming}")
                .trim()
                .replace("  ", " ")
        })
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn a_turn_streams_through_the_shell_and_thread_streams() {
    let db = TempDb::new("turn");
    let (engine, _) = open(&db);

    let mut shell = engine
        .subscribe_shell(from_json(json!({"requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    let snapshot = next(&mut shell).await;
    assert_eq!(snapshot["kind"], "snapshot");
    assert_eq!(snapshot["snapshot"]["projects"][0]["workspaceRoot"], ROOT);
    assert_eq!(snapshot["snapshot"]["threads"], json!([]));
    assert_eq!(next(&mut shell).await, json!({"kind": "synchronized"}));

    let created = dispatch(&engine, create("t1", "c1")).await;
    let row = next(&mut shell).await;
    assert_eq!(row["kind"], "thread.updated");
    assert_eq!(row["sequence"], created);
    assert_eq!(row["location"], "active");
    assert_eq!(row["thread"]["status"], "idle");

    let mut thread = engine
        .subscribe_thread(
            from_json(json!({"threadId": "t1", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    let first = next(&mut thread).await;
    assert_eq!(first["kind"], "snapshot");
    assert_eq!(first["snapshotSequence"], created);
    assert_eq!(first["projection"]["thread"]["title"], "New thread");
    assert_eq!(next(&mut thread).await, json!({"kind": "synchronized"}));

    dispatch(&engine, message("t1", "c2", "hello")).await;
    let events = until_run_ends(&mut thread).await;
    // Streamed chunks inside one flush window collapse to their newest version, and that version
    // leaves the log when the final one lands, so a live reader may or may not see it.
    let settled: Vec<String> = kinds(&events)
        .into_iter()
        .filter(|k| !k.ends_with("streaming"))
        .collect();
    assert_eq!(
        settled,
        [
            "run.created starting",
            "node.updated root_turn pending",
            "message.updated user",
            "turn-item.updated user_message completed",
            "provider-session.updated ready",
            "provider-thread.updated active",
            "thread.metadata-updated",
            "run-attempt.created running",
            "run.updated running",
            "node.updated root_turn running",
            "provider-turn.updated running",
            "message.updated assistant",
            "turn-item.updated assistant_message completed",
            "provider-turn.updated completed",
            "run-attempt.updated completed",
            "run.updated completed",
        ]
    );

    // The projection the client rebuilds from these events matches the snapshot.
    let projection = engine.get_thread_projection("t1".into()).await.unwrap();
    let texts: Vec<_> = projection["visibleTurnItems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["item"]["text"].clone())
        .collect();
    assert_eq!(texts, [json!("hello"), json!("echo: hello")]);
    assert_eq!(projection["runs"][0]["status"], "completed");

    // The shell shows the run start and its end.
    let mut statuses = vec![];
    while statuses.last() != Some(&json!("completed")) {
        let item = next(&mut shell).await;
        statuses.push(item["thread"]["status"].clone());
    }
    assert!(statuses.contains(&json!("starting")), "{statuses:?}");
    assert!(statuses.contains(&json!("running")), "{statuses:?}");

    // Streaming versions leave the log once the final version exists.
    let streaming = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 1000))
        .await
        .unwrap()
        .into_iter()
        .filter(|(_, e)| e["payload"]["streaming"] == true)
        .count();
    assert_eq!(streaming, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn a_retried_command_returns_its_receipt() {
    let db = TempDb::new("receipt");
    let (engine, _) = open(&db);
    let first = dispatch(&engine, create("t1", "c1")).await;
    let again = dispatch(&engine, create("t1", "c1")).await;
    assert_eq!(first, again);
    assert_eq!(engine.inner().db(|s| s.event_count("t1")).await, 1);

    // The same thread under a new command id is a conflict, not a retry.
    let conflict = engine
        .dispatch(from_json(create("t1", "c9")).unwrap())
        .await;
    let Err(EngineError::Rejected(error)) = conflict else {
        panic!("expected a rejection")
    };
    assert_eq!(
        to_json(&error)["_tag"],
        "OrchestrationV2DispatchCommandError"
    );
    assert_eq!(to_json(&error)["commandId"], "c9");
    let refused = to_json(&error)["detail"].as_str().unwrap().to_owned();

    // T3's `Orchestrator.control-reads.test.ts` ("a duplicate create is rejected"): the
    // refusal is recorded, so a retry answers it again and changes nothing.
    let events = engine.inner().db(|s| s.event_count("t1")).await;
    let retried = rejection(&engine, create("t1", "c9")).await;
    assert!(
        retried.contains(&format!("Command c9 was previously rejected: {refused}")),
        "{retried}"
    );
    assert_eq!(engine.inner().db(|s| s.event_count("t1")).await, events);

    // A receipt proves the command only for its own thread (`OrchestratorCommandIdConflictError`).
    let conflict = rejection(&engine, create("t2", "c1")).await;
    assert!(
        conflict.contains(
            "Command c1 was already handled for thread t1 and cannot be replayed for t2."
        ),
        "{conflict}"
    );
}

/// Audit 1.6 and 1.7, T3's receipts (`Orchestrator.ts` `replayCommandReceipt` and
/// `commitRejectedCommand`, `ProjectionMaintenance.ts`): after the store reopens, a refused id
/// is refused again though its precondition now holds, and an accepted archive replays as its
/// receipt after an undo and more than 4,096 later writes. A new id runs normally.
#[tokio::test(flavor = "current_thread")]
async fn a_command_id_keeps_its_outcome_across_a_reopen() {
    let db = TempDb::new("receipt-outcomes");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let refused = |engine: SqliteEngine, command: Value| async move {
        match engine.dispatch(from_json(command).unwrap()).await {
            Err(EngineError::Rejected(error)) => (engine, to_json(&error).to_string()),
            Ok(_) => panic!("expected a refusal, the command was accepted"),
            Err(_) => panic!("expected a refusal, the store failed"),
        }
    };
    let stale = json!({"type": "thread.metadata.update", "commandId": "stale", "threadId": "t1",
        "expectedBranch": "topic", "branch": "old-destination"});
    let (engine, error) = refused(engine, stale.clone()).await;
    assert!(error.contains("changed before"), "{error}");
    let archive = json!({"type": "thread.archive", "commandId": "archive", "threadId": "t1"});
    let archived = dispatch(&engine, archive.clone()).await;
    dispatch(
        &engine,
        json!({"type": "thread.unarchive", "commandId": "undo", "threadId": "t1"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "move", "threadId": "t1",
            "branch": "topic"}),
    )
    .await;
    dispatch(&engine, create("other", "create-other")).await;
    for i in 0..4_400 {
        dispatch(
            &engine,
            json!({"type": "thread.metadata.update", "commandId": format!("rename-{i}"),
                "threadId": "other", "title": format!("Title {i}")}),
        )
        .await;
    }
    drop(engine);

    let (engine, _) = open(&db);
    let (engine, error) = refused(engine, stale.clone()).await;
    assert!(
        error.contains("Command stale was previously rejected"),
        "{error}"
    );
    assert_eq!(dispatch(&engine, archive).await, archived);
    let thread = projection(&engine, "t1").await["thread"].clone();
    assert!(thread["archivedAt"].is_null());
    assert_eq!(thread["branch"], "topic");
    let mut fresh = stale;
    fresh["commandId"] = json!("stale-again");
    dispatch(&engine, fresh).await;
    assert_eq!(
        projection(&engine, "t1").await["thread"]["branch"],
        "old-destination"
    );
}

async fn rejection(engine: &SqliteEngine, command: Value) -> String {
    match engine.dispatch(from_json(command).unwrap()).await {
        Err(EngineError::Rejected(e)) => to_json(&e)["detail"].as_str().unwrap_or("").to_owned(),
        Ok(_) => panic!("expected a refusal"),
        Err(EngineError::Internal(e)) => panic!("internal: {e}"),
    }
}

/// A fork's receipt belongs to its target thread (`commandThreadId`), so one id reused for a
/// fork to another thread is a conflict, not a replay that creates nothing.
#[tokio::test(flavor = "current_thread")]
async fn a_fork_receipt_belongs_to_its_target_thread() {
    let db = TempDb::new("fork-receipt");
    let (engine, _) = open(&db);
    dispatch(&engine, create("a", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "a"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("a", "c2", "first")).await;
    until_run_ends(&mut thread).await;
    let fork = |target: &str| {
        json!({"type": "thread.fork", "commandId": "f1", "sourceThreadId": "a",
            "targetThreadId": target, "sourcePoint": {"type": "run", "runId": "run:a:1"},
            "createdBy": "user", "creationSource": "web"})
    };
    dispatch(&engine, fork("b")).await;
    let conflict = rejection(&engine, fork("c")).await;
    assert!(
        conflict
            .contains("Command f1 was already handled for thread b and cannot be replayed for c."),
        "{conflict}"
    );
    assert!(engine.thread_snapshot("c".into()).await.unwrap().is_none());
    // The same id for the same target is a replay.
    dispatch(&engine, fork("b")).await;
}

/// T3's deciders emit their event even when nothing changes: a re-pin records `thread.pinned`
/// with the thread's `updatedAt` kept. A command with no event answers its own thread's latest
/// sequence, not another thread's.
#[tokio::test(flavor = "current_thread")]
async fn a_repin_records_its_event_and_a_quiet_stop_answers_its_thread() {
    let db = TempDb::new("repin");
    let (engine, _) = open(&db);
    let a_created = dispatch(&engine, create("a", "c1")).await;
    dispatch(&engine, create("b", "c2")).await;
    let pinned = dispatch(
        &engine,
        json!({"type": "thread.pin", "commandId": "p1", "threadId": "a", "orderKey": "a0"}),
    )
    .await;
    let updated_at = engine.shell_snapshot().await.unwrap()["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "a")
        .unwrap()["updatedAt"]
        .clone();
    dispatch(
        &engine,
        json!({"type": "thread.pin", "commandId": "p2", "threadId": "a", "orderKey": "a0"}),
    )
    .await;
    let again = command_events(&engine, "p2").await;
    assert_eq!(again.len(), 1, "a re-pin records thread.pinned");
    assert_eq!(again[0]["type"], "thread.pinned");
    assert_eq!(again[0]["payload"]["updatedAt"], updated_at);
    assert!(pinned > a_created);
    // b writes after a; a Stop on idle a answers a's latest sequence.
    dispatch(
        &engine,
        json!({"type": "thread.tag.set", "commandId": "t1", "threadId": "b", "tag": "x",
            "tagged": true}),
    )
    .await;
    let a_latest = engine
        .inner()
        .db(|s| s.thread_events_after("a", 0, 100_000))
        .await
        .unwrap()
        .last()
        .unwrap()
        .0;
    let stopped = dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "stop-1", "threadId": "a"}),
    )
    .await;
    assert_eq!(stopped, a_latest);
}

/// A host whose provider instances can be switched off during a test.
#[derive(Default)]
struct Switchable(std::sync::atomic::AtomicBool);

impl crate::EngineHost for Switchable {
    fn provider_instance_enabled(&self, _project_id: Option<&str>, _instance_id: &str) -> bool {
        !self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// T3's queue start holds the queue when the next run's provider is off for its project
/// (`startNextQueuedRun`): a replayed `queue.resume` answers its recorded sequence and starts
/// nothing.
#[tokio::test(flavor = "current_thread")]
async fn a_replayed_resume_holds_a_queue_whose_provider_is_off() {
    let db = TempDb::new("resume-replay-off");
    let host = Arc::new(Switchable::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "later")).await;
    let resume = json!({"type": "queue.resume", "commandId": "r1", "threadId": "t1"});
    let recorded = dispatch(&engine, resume.clone()).await;
    engine
        .inner()
        .db(|store| {
            let mut tx = store.tx()?;
            let mut run = tx.entity("t1", "runs", "run:t1:1")?.unwrap();
            run["status"] = json!("interrupted");
            tx.append(crate::store::Draft::new("t1", "run.updated", run).run(Some("run:t1:1")))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    host.0.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(dispatch(&engine, resume).await, recorded);
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][1]["status"], "queued", "nothing starts");
    assert_eq!(p["runs"][1]["queueHeld"], true, "the queue is held");
}

/// The store as main (schema 4) left it: receipts with no owner, error or later columns.
fn downgrade_to_v4(db: &TempDb) {
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    // Main wrote every project receipt as `project`.
    conn.execute_batch("UPDATE receipts SET command_type = 'project' WHERE owner_kind = 'project'")
        .unwrap();
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('receipts')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for column in columns {
        if !["command_id", "command_type", "sequence"].contains(&column.as_str()) {
            conn.execute_batch(&format!("ALTER TABLE receipts DROP COLUMN {column}"))
                .unwrap();
        }
    }
    conn.execute_batch("PRAGMA user_version = 4").unwrap();
}

/// v4 (main) → final: the upgrade adds the receipt columns and names no owner, so a retry of
/// a command from before it is refused, never run twice; new commands and main's message index
/// work as before.
#[tokio::test(flavor = "current_thread")]
async fn a_v4_store_upgrades_and_refuses_its_old_retries() {
    let db = TempDb::new("v4-upgrade");
    let root = std::env::temp_dir().join(format!("conn-v4-project-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let project = json!({"type": "project.create", "commandId": "p1", "projectId": "project:p1",
        "title": "P", "workspaceRoot": root.to_string_lossy()});
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("a", "c1")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "a"})).unwrap())
            .await
            .unwrap();
        next(&mut thread).await;
        dispatch(&engine, message("a", "m1", "Ångström café citation")).await;
        until_run_ends(&mut thread).await;
        dispatch(
            &engine,
            json!({"type": "thread.settle", "commandId": "s1", "threadId": "a"}),
        )
        .await;
        engine
            .call("projects.mutate", project.clone())
            .await
            .unwrap();
    }
    downgrade_to_v4(&db);
    let (engine, _) = open(&db);
    let old = rejection(
        &engine,
        json!({"type": "thread.settle", "commandId": "s1", "threadId": "a"}),
    )
    .await;
    assert!(
        old.contains("Command s1 was handled before receipts named their owner"),
        "{old}"
    );
    let retried = engine.call("projects.mutate", project).await;
    assert!(
        format!("{retried:?}").contains("Command p1 was handled before receipts named their owner"),
        "{retried:?}"
    );
    dispatch(
        &engine,
        json!({"type": "thread.unsettle", "commandId": "u1", "threadId": "a", "reason": "user"}),
    )
    .await;
    let found = engine
        .inner()
        .db(|s| s.search_threads(&json!({"query": "Ångström café"})))
        .await
        .unwrap();
    assert!(found.to_string().contains("\"a\""), "{found}");
}

/// The receipt upgrade adds only the columns a store lacks: one a failed or partial upgrade
/// left (here `error`) stays, the rest are added, and commands work.
#[tokio::test(flavor = "current_thread")]
async fn a_partial_receipt_upgrade_finishes_on_open() {
    let db = TempDb::new("upgrade-partial");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("a", "c1")).await;
    }
    downgrade_to_v4(&db);
    rusqlite::Connection::open(db.path())
        .unwrap()
        .execute_batch("ALTER TABLE receipts ADD COLUMN ERROR TEXT")
        .unwrap();
    let (engine, _) = open(&db);
    dispatch(&engine, create("b", "c2")).await;
    drop(engine);
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 5);
    let columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('receipts')
             WHERE lower(name) IN ('owner_kind', 'owner_id', 'error')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(columns, 3);
}

/// A project command's typed refusal from planning is its receipt, as T3's
/// `commitRejectedProjectCommand`: a retry gets it again even after the conflict is gone. A
/// refusal before planning (the folder) stays retryable. `project.update` records T3's
/// `project.meta.update`.
#[tokio::test(flavor = "current_thread")]
async fn a_planned_project_refusal_is_replayed() {
    let db = TempDb::new("project-refusal");
    let (engine, _) = open(&db);
    let folder = |name: &str| {
        std::env::temp_dir()
            .join(format!(
                "conn-project-refusal-{}-{name}",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned()
    };
    let (one, missing) = (folder("one"), folder("missing"));
    std::fs::create_dir_all(&one).unwrap();
    let _ = std::fs::remove_dir_all(&missing);
    let mutate = |command: Value| engine.call("projects.mutate", command);
    let create_project = |id: &str, project: &str, root: &str| {
        json!({"type": "project.create", "commandId": id, "projectId": project,
            "title": "P", "workspaceRoot": root})
    };
    let cause = |result: Result<Value, EngineError<Value>>| match result {
        Err(EngineError::Rejected(e)) => e["cause"].clone(),
        other => panic!("expected a refusal: {other:?}"),
    };
    mutate(create_project("c1", "project:p1", &one))
        .await
        .unwrap();
    let first = cause(mutate(create_project("c2", "project:p2", &one)).await);
    assert_eq!(first["_tag"], "ProjectConflictError", "{first}");
    mutate(json!({"type": "project.delete", "commandId": "d1", "projectId": "project:p1"}))
        .await
        .unwrap();
    let again = cause(mutate(create_project("c2", "project:p2", &one)).await);
    assert_eq!(
        again, first,
        "the recorded refusal, though the folder is free now"
    );
    // Refused before planning: the same id works once the folder exists.
    let early = cause(mutate(create_project("c3", "project:p3", &missing)).await);
    assert_eq!(early["_tag"], "ProjectOperationError", "{early}");
    std::fs::create_dir_all(&missing).unwrap();
    mutate(create_project("c3", "project:p3", &missing))
        .await
        .unwrap();
    mutate(
        json!({"type": "project.update", "commandId": "u1", "projectId": "project:p3",
        "title": "Renamed"}),
    )
    .await
    .unwrap();
    let kind: String = engine
        .inner()
        .db(|s| {
            s.raw()
                .query_row(
                    "SELECT command_type FROM receipts WHERE command_id = 'u1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
        })
        .await
        .unwrap();
    assert_eq!(kind, "project.meta.update");
    // An offline folder another project holds: T3 checks the folder before planning, so the
    // refusal stays retryable and the id works once the folder is back and free.
    std::fs::remove_dir_all(&missing).unwrap();
    let offline = cause(mutate(create_project("c4", "project:p4", &missing)).await);
    assert_eq!(offline["_tag"], "ProjectOperationError", "{offline}");
    std::fs::create_dir_all(&missing).unwrap();
    mutate(json!({"type": "project.delete", "commandId": "d3", "projectId": "project:p3"}))
        .await
        .unwrap();
    mutate(create_project("c4", "project:p4", &missing))
        .await
        .unwrap();
    // A monogram has at most two graphemes (`Intl.Segmenter`), not two chars.
    let icon = |id: &str, text: &str| {
        json!({"type": "project.update", "commandId": id, "projectId": "project:p4",
            "projectIcon": {"kind": "monogram", "text": text}})
    };
    let project = mutate(icon("i1", "किका")).await.unwrap();
    assert_eq!(project["projectIcon"]["text"], "किका");
    let long = cause(mutate(icon("i2", "abc")).await);
    assert_eq!(long["_tag"], "ProjectInvalidError", "{long}");
}

/// T3's `readCommitted`: a replay whose project row is gone is a typed read error, not null.
#[tokio::test(flavor = "current_thread")]
async fn a_project_replay_without_its_row_is_a_read_error() {
    let db = TempDb::new("project-replay-row");
    let (engine, _) = open(&db);
    let root = std::env::temp_dir().join(format!("conn-project-row-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let command = json!({"type": "project.create", "commandId": "c1", "projectId": "project:p1",
        "title": "P", "workspaceRoot": root.to_string_lossy()});
    engine
        .call("projects.mutate", command.clone())
        .await
        .unwrap();
    engine
        .inner()
        .db(|s| {
            s.raw()
                .execute("DELETE FROM projects WHERE id = 'project:p1'", [])
                .map_err(|e| e.to_string())
        })
        .await
        .unwrap();
    match engine.call("projects.mutate", command).await {
        Err(EngineError::Rejected(e)) => {
            assert_eq!(e["cause"]["_tag"], "ProjectOperationError", "{e}");
            assert_eq!(
                e["cause"]["message"],
                "The accepted project command did not produce a project row."
            );
        }
        other => panic!("expected a read error: {other:?}"),
    }
}

/// T3's queue start (`startNextQueuedRun`) checks and starts the queued run on its effective
/// selection: a message that follows the thread's selection takes the thread's current one.
/// An unpinned scheduled send and a delegated-task completion both follow it.
#[tokio::test(flavor = "current_thread")]
async fn the_queue_starts_on_the_effective_selection() {
    queued_run_follows_selection(Queued::Scheduled).await;
    queued_run_follows_selection(Queued::DelegatedCompletion).await;
}

#[derive(Debug, Clone, Copy)]
enum Queued {
    Scheduled,
    DelegatedCompletion,
}

async fn queued_run_follows_selection(queued: Queued) {
    let db = TempDb::new(&format!("queue-effective-{queued:?}"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![
        Arc::new(FakeProvider::new("claudeAgent")),
        Arc::new(FakeProvider::new("other")),
        Arc::new(FakeProvider::new("off")),
    ];
    config.host = Some(Arc::new(OneInstanceOff));
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    match queued {
        // The command the scheduler's `EngineRunner::send` builds: no model selection.
        Queued::Scheduled => {
            dispatch(
                &engine,
                json!({"type": "message.dispatch", "commandId": "c3", "threadId": "t1",
                    "messageId": "message:c3", "scheduledTaskId": "scheduled-task:x",
                    "text": "later", "attachments": [],
                    "dispatchMode": {"type": "queue_after_active"},
                    "createdBy": "agent", "creationSource": "server"}),
            )
            .await;
        }
        // A child's end queues its completion wake (`families::deliver`).
        Queued::DelegatedCompletion => {
            dispatch(&engine, delegate("d1", "look", Some("always"))).await;
            let child = "thread:delegated-task:d1";
            run_to_end(&engine, child, &format!("run:{child}:1")).await;
        }
    }
    // The turn ends with the message waiting.
    engine
        .inner()
        .db(|store| {
            let mut tx = store.tx()?;
            let mut run = tx.entity("t1", "runs", "run:t1:1")?.unwrap();
            run["status"] = json!("interrupted");
            tx.append(crate::store::Draft::new("t1", "run.updated", run).run(Some("run:t1:1")))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][1]["status"], "queued", "{queued:?}");
    let select = |id: &str, instance: &str| {
        json!({"type": "thread.model-selection.set", "commandId": id, "threadId": "t1",
            "modelSelection": {"instanceId": instance, "model": "m"}})
    };
    // The thread is now on a provider the project turned off: the queue holds.
    dispatch(&engine, select("s1", "off")).await;
    dispatch(
        &engine,
        json!({"type": "queue.resume", "commandId": "r1", "threadId": "t1"}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_eq!(
        p["runs"][1]["status"], "queued",
        "{queued:?}: held, not started on run:t1:2's own provider"
    );
    assert_eq!(p["runs"][1]["queueHeld"], true, "{queued:?}");
    // On another enabled provider, the run starts there.
    dispatch(&engine, select("s2", "other")).await;
    dispatch(
        &engine,
        json!({"type": "queue.resume", "commandId": "r2", "threadId": "t1"}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_ne!(p["runs"][1]["status"], "queued", "{queued:?}");
    assert_eq!(p["runs"][1]["providerInstanceId"], "other", "{queued:?}");
}

/// A project write reads its receipt in its own transaction, as T3's `commitProjectCommand`:
/// a thread command's id, or another project's or command's, is refused and the receipt kept.
#[tokio::test(flavor = "current_thread")]
async fn a_project_write_checks_the_receipt_it_would_reuse() {
    let db = TempDb::new("project-receipt");
    let (engine, _) = open(&db);
    // A thread command refused under the id.
    let refused = rejection(
        &engine,
        json!({"type": "thread.archive", "commandId": "x", "threadId": "missing"}),
    )
    .await;
    assert!(refused.contains("does not exist"), "{refused}");
    let folder = |name: &str| {
        let dir = std::env::temp_dir().join(format!(
            "conn-project-receipt-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    };
    let create_project = |id: &str, project: &str, root: &str| {
        json!({"type": "project.create", "commandId": id, "projectId": project,
            "title": "P", "workspaceRoot": root})
    };
    let (root1, root2) = (folder("one"), folder("two"));
    let used = engine
        .call("projects.mutate", create_project("x", "project:p1", &root1))
        .await;
    let error = format!("{used:?}");
    assert!(used.is_err(), "a thread command's id is refused");
    assert!(
        error.contains("Command x was already used by a thread command."),
        "{error}"
    );
    let again = rejection(
        &engine,
        json!({"type": "thread.archive", "commandId": "x", "threadId": "missing"}),
    )
    .await;
    assert!(
        again.contains("Command x was previously rejected"),
        "the receipt is kept: {again}"
    );
    // A project receipt answers only for its project and command.
    engine
        .call("projects.mutate", create_project("p", "project:p1", &root1))
        .await
        .unwrap();
    engine
        .call("projects.mutate", create_project("p", "project:p1", &root1))
        .await
        .unwrap();
    let other = engine
        .call("projects.mutate", create_project("p", "project:p2", &root2))
        .await;
    let error = format!("{other:?}");
    assert!(
        error.contains("Command p was already used by project.create for project:p1."),
        "{error}"
    );
}

/// A visit is compared with the stored read mark as T3 reads it, whatever form main stored.
#[tokio::test(flavor = "current_thread")]
async fn a_stale_visit_loses_to_a_mark_in_mains_format() {
    let db = TempDb::new("visit-main-format");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    // Main stored the client's string as it came.
    engine
        .inner()
        .db(|store| {
            let mut tx = store.tx()?;
            let mut thread = tx.thread("t1")?.unwrap();
            thread["lastVisitedAt"] = json!("2020-01-02");
            tx.append(crate::store::Draft::new("t1", "thread.visited", thread))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    dispatch(
        &engine,
        json!({"type": "thread.visit", "commandId": "v1", "threadId": "t1",
            "visitedAt": "2020-01-01T12:00:00.000Z"}),
    )
    .await;
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["lastVisitedAt"], "2020-01-02");
    assert!(command_events(&engine, "v1").await.is_empty());
}

/// T3 replays `queue.resume` and `queued-run.start` by checking the queue again
/// (`replayCommandReceipt`), and answers the recorded sequence.
#[tokio::test(flavor = "current_thread")]
async fn a_replayed_queue_resume_starts_what_waits() {
    let db = TempDb::new("resume-replay");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "later")).await;
    // Accepted while the turn runs: nothing can start yet.
    let resume = json!({"type": "queue.resume", "commandId": "r1", "threadId": "t1"});
    let recorded = dispatch(&engine, resume.clone()).await;
    // The turn ends without draining the queue (a store as a crash leaves it).
    engine
        .inner()
        .db(|store| {
            let mut tx = store.tx()?;
            let mut run = tx.entity("t1", "runs", "run:t1:1")?.unwrap();
            run["status"] = json!("interrupted");
            tx.append(crate::store::Draft::new("t1", "run.updated", run).run(Some("run:t1:1")))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][1]["status"], "queued");
    let replayed = dispatch(&engine, resume).await;
    assert_eq!(replayed, recorded, "the recorded sequence");
    let p = projection(&engine, "t1").await;
    assert_ne!(
        p["runs"][1]["status"], "queued",
        "the replay started the waiting run"
    );
}

/// `thread.auto-settle` as T3's: a thread the user set active, or that changed after the
/// sweep's snapshot, is refused; then it is a settle, archive guard first.
#[tokio::test(flavor = "current_thread")]
async fn auto_settle_rechecks_the_thread_against_its_snapshot() {
    let db = TempDb::new("auto-settle");
    let (engine, _) = open(&db);
    let later = "2100-01-01T00:00:00.000Z";
    let auto = |id: &str, thread: &str, at: &str| json!({"type": "thread.auto-settle", "commandId": id, "threadId": thread, "snapshotAt": at});
    let row = |shell: &Value, id: &str| {
        shell["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .cloned()
            .unwrap()
    };
    // The user unsettled it after the sweep.
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(
        &engine,
        json!({"type": "thread.settle", "commandId": "c2", "threadId": "t1"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.unsettle", "commandId": "c3", "threadId": "t1", "reason": "user"}),
    )
    .await;
    let refused = rejection(&engine, auto("a1", "t1", later)).await;
    assert!(
        refused.contains("Thread t1 changed before automatic settlement."),
        "{refused}"
    );
    assert_eq!(
        row(&engine.shell_snapshot().await.unwrap(), "t1")["settledOverride"],
        "active"
    );
    // It changed after the snapshot.
    dispatch(&engine, create("t2", "c4")).await;
    let refused = rejection(&engine, auto("a2", "t2", "2000-01-01T00:00:00.000Z")).await;
    assert!(
        refused.contains("Thread t2 changed before automatic settlement."),
        "{refused}"
    );
    // Archived with auto-settle off: the settle's archive guard answers.
    dispatch(&engine, create("t3", "c5")).await;
    dispatch(
        &engine,
        json!({"type": "thread.auto-settle.set", "commandId": "c6", "threadId": "t3", "enabled": false}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "c7", "threadId": "t3"}),
    )
    .await;
    let refused = rejection(&engine, auto("a3", "t3", later)).await;
    assert!(refused.contains("Thread t3 is archived."), "{refused}");
    // Unchanged since the snapshot: settled.
    dispatch(&engine, create("t4", "c8")).await;
    dispatch(&engine, auto("a4", "t4", later)).await;
    assert_eq!(
        row(&engine.shell_snapshot().await.unwrap(), "t4")["settledOverride"],
        "settled"
    );
}

/// A settle sent for a run that is no longer the thread's latest is refused, as T3's
/// (`expectedLatestRunId`, every run by ordinal); a thread with no run has none to match.
#[tokio::test(flavor = "current_thread")]
async fn a_settle_for_a_stale_run_is_refused() {
    let db = TempDb::new("stale-settle");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let settle = |id: &str, run: &str| json!({"type": "thread.settle", "commandId": id, "threadId": "t1", "expectedLatestRunId": run});
    let refused = rejection(&engine, settle("s0", "run:t1:1")).await;
    assert!(
        refused.contains("The thread received another run before settlement."),
        "{refused}"
    );
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    for (command, text) in [("c2", "first"), ("c3", "second")] {
        dispatch(&engine, message("t1", command, text)).await;
        until_run_ends(&mut thread).await;
    }
    let refused = rejection(&engine, settle("s1", "run:t1:1")).await;
    assert!(
        refused.contains("The thread received another run before settlement."),
        "{refused}"
    );
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(
        shell["threads"][0]["settledOverride"],
        Value::Null,
        "not settled"
    );
    dispatch(&engine, settle("s2", "run:t1:2")).await;
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["settledOverride"], "settled");
}

/// T3's settle refuses a thread with a queued user message (`Orchestrator.ts`): a stopped
/// turn's follow-up must be sent or removed first, so a settle never hides it.
#[tokio::test(flavor = "current_thread")]
async fn a_settle_waits_for_a_queued_user_message() {
    let db = TempDb::new("settle-queued");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "follow-up")).await;
    dispatch(
        &engine,
        json!({"type": "message.dispatch", "commandId": "c5", "threadId": "t1",
            "messageId": "message:c5", "scheduledTaskId": "scheduled-task:x",
            "text": "scheduled", "attachments": [],
            "dispatchMode": {"type": "queue_after_active"},
            "createdBy": "agent", "creationSource": "server"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c4", "threadId": "t1"}),
    )
    .await;
    until_run_ends(&mut thread).await;
    assert_eq!(
        projection(&engine, "t1").await["runs"][1]["status"],
        "queued"
    );
    let refused = rejection(
        &engine,
        json!({"type": "thread.settle", "commandId": "s1", "threadId": "t1"}),
    )
    .await;
    assert!(refused.contains("has a queued message"), "{refused}");
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["settledOverride"], Value::Null);
    // With the user's message removed, the settle cancels the scheduled run (T3's cohort
    // cancel), so a later resume never runs it.
    dispatch(
        &engine,
        json!({"type": "queued-run.cancel", "commandId": "x1", "threadId": "t1",
            "runId": "run:t1:2"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.settle", "commandId": "s2", "threadId": "t1"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "queue.resume", "commandId": "r1", "threadId": "t1"}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["thread"]["settledOverride"], "settled");
    assert_eq!(p["runs"][2]["status"], "cancelled", "{}", p["runs"][2]);
}

/// T3's queue start moves the thread to the run's selection (`startNextQueuedRun`): an
/// unpinned scheduled run queued behind a pinned one starts on the pinned run's model.
#[tokio::test(flavor = "current_thread")]
async fn a_queued_run_moves_the_thread_to_its_selection() {
    let db = TempDb::new("queue-moves-selection");
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![
        Arc::new(FakeProvider::new("claudeAgent")),
        Arc::new(FakeProvider::new("other")),
    ];
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut pinned = message("t1", "c3", "pinned");
    pinned["dispatchMode"] = json!({"type": "queue_after_active"});
    pinned["modelSelection"] = json!({"instanceId": "other", "model": "m"});
    dispatch(&engine, pinned).await;
    dispatch(
        &engine,
        json!({"type": "message.dispatch", "commandId": "c4", "threadId": "t1",
            "messageId": "message:c4", "scheduledTaskId": "scheduled-task:x",
            "text": "scheduled", "attachments": [],
            "dispatchMode": {"type": "queue_after_active"},
            "createdBy": "agent", "creationSource": "server"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c5", "threadId": "t1"}),
    )
    .await;
    until_run_ends(&mut thread).await;
    dispatch(
        &engine,
        json!({"type": "queue.resume", "commandId": "r1", "threadId": "t1"}),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:3").await;
    assert_eq!(p["runs"][1]["providerInstanceId"], "other");
    assert_eq!(p["thread"]["modelSelection"]["instanceId"], "other");
    assert_eq!(
        p["runs"][2]["providerInstanceId"], "other",
        "the scheduled run follows the thread the pinned run moved"
    );
}

/// `thread.visit` as T3's: a visit older than the stored one keeps the later time and records
/// nothing; a newer one records `thread.visit-recorded`, not a copy of the thread.
#[tokio::test(flavor = "current_thread")]
async fn a_delayed_visit_keeps_the_later_time() {
    let db = TempDb::new("visit-order");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let visit = |id: &str, at: &str| json!({"type": "thread.visit", "commandId": id, "threadId": "t1", "visitedAt": at});
    dispatch(&engine, visit("v1", "2027-01-02T00:00:00.000+01:00")).await;
    // The same instant written later in another zone: not after it.
    dispatch(&engine, visit("v2", "2027-01-01T23:00:00.000Z")).await;
    dispatch(&engine, visit("v3", "2026-12-31T00:00:00.000Z")).await;
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(
        shell["threads"][0]["lastVisitedAt"],
        "2027-01-01T23:00:00.000Z"
    );
    let recorded = command_events(&engine, "v1").await;
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0]["type"], "thread.visit-recorded");
    assert_eq!(
        recorded[0]["payload"],
        json!({"lastVisitedAt": "2027-01-01T23:00:00.000Z"})
    );
    assert_eq!(recorded[0]["providerInstanceId"], "claudeAgent");
    assert!(command_events(&engine, "v2").await.is_empty());
    assert!(command_events(&engine, "v3").await.is_empty());
}

/// The first message after a merge-back carries the handoff and transfers, written before its
/// run: their envelopes name the destination instance, as T3's.
#[tokio::test(flavor = "current_thread")]
async fn a_merge_back_first_message_names_its_instance() {
    let db = TempDb::new("merge-back-instance");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut source = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut source).await;
    dispatch(&engine, message("t1", "c2", "first")).await;
    until_run_ends(&mut source).await;
    dispatch(
        &engine,
        json!({"type": "thread.fork", "commandId": "f1", "sourceThreadId": "t1",
            "targetThreadId": "t2", "sourcePoint": {"type": "run", "runId": "run:t1:1"},
            "createdBy": "user", "creationSource": "web"}),
    )
    .await;
    let mut fork = engine
        .subscribe_thread(from_json(json!({"threadId": "t2"})).unwrap())
        .await
        .unwrap();
    next(&mut fork).await;
    dispatch(&engine, message("t2", "c3", "fork work")).await;
    until_run_ends(&mut fork).await;
    dispatch(
        &engine,
        json!({"type": "thread.merge_back", "commandId": "m1", "sourceThreadId": "t2",
            "targetThreadId": "t1", "sourcePoint": {"type": "run", "runId": "run:t2:1"},
            "createdBy": "user", "creationSource": "web"}),
    )
    .await;
    dispatch(&engine, message("t1", "c4", "use it")).await;
    let carried: Vec<Value> = command_events(&engine, "c4")
        .await
        .into_iter()
        .filter(|e| {
            e["type"] == "context-handoff.updated" || e["type"] == "context-transfer.updated"
        })
        .collect();
    assert!(!carried.is_empty(), "the message carries the merge-back");
    for event in &carried {
        assert_eq!(event["providerInstanceId"], "claudeAgent", "{event}");
    }
}

/// T3's `runtimeLayer.test.ts`, "persists rejected command receipts across retries".
#[tokio::test(flavor = "current_thread")]
async fn persists_rejected_command_receipts_across_retries() {
    let db = TempDb::new("rejected-receipt");
    let (engine, _) = open(&db);
    let archive = json!({"type": "thread.archive", "commandId": "missing-archive",
        "threadId": "missing-thread"});
    let first = rejection(&engine, archive.clone()).await;
    assert!(
        first.contains("Thread missing-thread does not exist."),
        "{first}"
    );
    dispatch(&engine, create("missing-thread", "c1")).await;
    let retry = rejection(&engine, archive).await;
    assert!(
        retry.contains("Command missing-archive was previously rejected: "),
        "{retry}"
    );
    assert!(
        engine.shell_snapshot().await.unwrap()["threads"][0]["archivedAt"].is_null(),
        "the retry archives nothing"
    );
}

/// An old retry, after an undo and after more receipts than a short-lived cache would keep,
/// is answered from its receipt and changes nothing: T3 keeps every receipt.
#[tokio::test(flavor = "current_thread")]
async fn an_old_retry_after_an_undo_leaves_the_thread_as_it_is() {
    let db = TempDb::new("old-retry");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, create("t2", "c2")).await;
    let settle = json!({"type": "thread.settle", "commandId": "settle-1", "threadId": "t1"});
    dispatch(&engine, settle.clone()).await;
    dispatch(
        &engine,
        json!({"type": "thread.unsettle", "commandId": "undo-1", "threadId": "t1",
            "reason": "user", "restoreUnsettledAt": null}),
    )
    .await;
    for n in 0..4_400 {
        dispatch(
            &engine,
            json!({"type": "thread.tag.set", "commandId": format!("w{n}"), "threadId": "t2",
                "tag": "busy", "tagged": n % 2 == 0}),
        )
        .await;
    }
    let row = |shell: &Value| {
        shell["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == "t1")
            .cloned()
            .unwrap()
    };
    let before = row(&engine.shell_snapshot().await.unwrap());
    let events = engine.inner().db(|s| s.event_count("t1")).await;
    dispatch(&engine, settle).await;
    assert_eq!(row(&engine.shell_snapshot().await.unwrap()), before);
    assert_eq!(before["settledOverride"], "active");
    assert_eq!(engine.inner().db(|s| s.event_count("t1")).await, events);
}

#[tokio::test(flavor = "current_thread")]
async fn streams_resume_after_a_sequence() {
    let db = TempDb::new("resume");
    let (engine, _) = open(&db);
    let created = dispatch(&engine, create("t1", "c1")).await;
    dispatch(
        &engine,
        json!({"type": "thread.visit", "commandId": "c2", "threadId": "t1",
        "visitedAt": "2026-11-13T09:00:00.000Z"}),
    )
    .await;

    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1", "afterSequence": created, "requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    let replayed = next(&mut thread).await;
    assert_eq!(replayed["kind"], "event");
    assert_eq!(replayed["event"]["type"], "thread.visit-recorded");
    assert_eq!(next(&mut thread).await["kind"], "synchronized");
    let mut shell = engine
        .subscribe_shell(
            from_json(json!({"afterSequence": 0, "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    let project = next(&mut shell).await;
    assert_eq!(project["kind"], "project.updated");
    assert_eq!(next(&mut shell).await["kind"], "thread.updated");
    let visited = next(&mut shell).await;
    assert_eq!(
        visited["thread"]["lastVisitedAt"],
        "2026-11-13T09:00:00.000Z"
    );
    assert_eq!(next(&mut shell).await["kind"], "synchronized");

    // A cursor from a different database cannot resume.
    let mut shell = engine
        .subscribe_shell(
            from_json(json!({"afterSequence": 999, "httpSnapshotFallback": true})).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(next(&mut shell).await, json!({"kind": "snapshot-required"}));

    // A client that missed the deletion resumes into `thread.deleted`, as on T3.
    let visited = dispatch(
        &engine,
        json!({"type": "thread.visit", "commandId": "c3",
        "threadId": "t1", "visitedAt": "2026-11-13T09:01:00.000Z"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.delete", "commandId": "c4", "threadId": "t1"}),
    )
    .await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1", "afterSequence": visited, "requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    // crates/conn-state/tests/fixtures/thread_deleted_replay.json records this item.
    assert_eq!(next(&mut thread).await["event"]["type"], "thread.deleted");
    drop(thread);
    assert!(
        engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .is_err()
    );
    assert!(
        engine
            .subscribe_thread(from_json(json!({"threadId": "nope", "afterSequence": 0})).unwrap())
            .await
            .is_err()
    );

    // A replay over 1 MiB stored gets a snapshot (`THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES`).
    dispatch(&engine, create("t3", "b1")).await;
    let before = dispatch(
        &engine,
        json!({"type": "thread.visit", "commandId": "b2", "threadId": "t3",
        "visitedAt": "2026-11-13T09:04:00.000Z"}),
    )
    .await;
    let large = dispatch(
        &engine,
        json!({"type": "thread.visit", "commandId": "b3", "threadId": "t3",
        "visitedAt": "2026-11-13T09:05:00.000Z"}),
    )
    .await;
    rusqlite::Connection::open(db.path())
        .unwrap()
        .execute(
            "UPDATE events SET event = json_set(event, '$.payload.pad', ?1) WHERE seq = ?2",
            rusqlite::params!["x".repeat(1_100_000), large as i64],
        )
        .unwrap();
    let mut resumed = engine
        .subscribe_thread(from_json(json!({"threadId": "t3", "afterSequence": before})).unwrap())
        .await
        .unwrap();
    assert_eq!(next(&mut resumed).await["kind"], "snapshot");
    drop(resumed);

    // A cursor older than the replay bound needs a snapshot, which a deleted thread has not.
    dispatch(&engine, create("t2", "e1")).await;
    let early = dispatch(
        &engine,
        json!({"type": "thread.visit", "commandId": "e2", "threadId": "t2",
        "visitedAt": "2026-11-13T09:02:00.000Z"}),
    )
    .await;
    // Each visit is later, so each moves the read mark and appends an event.
    for n in 0..130 {
        dispatch(
            &engine,
            json!({"type": "thread.visit", "commandId": format!("e-visit-{n}"),
            "threadId": "t2", "visitedAt": format!("2026-11-13T09:{:02}:{:02}.000Z", 3 + n / 60, n % 60)}),
        )
        .await;
    }
    let mut resumed = engine
        .subscribe_thread(from_json(json!({"threadId": "t2", "afterSequence": early})).unwrap())
        .await
        .unwrap();
    assert_eq!(next(&mut resumed).await["kind"], "snapshot");
    drop(resumed);
    dispatch(
        &engine,
        json!({"type": "thread.delete", "commandId": "e3", "threadId": "t2"}),
    )
    .await;
    assert!(
        engine
            .subscribe_thread(from_json(json!({"threadId": "t2", "afterSequence": early})).unwrap())
            .await
            .is_err()
    );

    // A thread deleted and created again under its ID resumes from a snapshot: the replay
    // holds `thread.created` and the thread exists (`ws.ts`, `hasCreateEvent`).
    dispatch(&engine, create("t4", "r1")).await;
    let seen = dispatch(
        &engine,
        json!({"type": "thread.visit", "commandId": "r2", "threadId": "t4",
        "visitedAt": "2026-11-13T09:06:00.000Z"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.delete", "commandId": "r3", "threadId": "t4"}),
    )
    .await;
    dispatch(&engine, create("t4", "r4")).await;
    let mut resumed = engine
        .subscribe_thread(from_json(json!({"threadId": "t4", "afterSequence": seen})).unwrap())
        .await
        .unwrap();
    let first = next(&mut resumed).await;
    assert_eq!(first["kind"], "snapshot", "{first}");
    assert!(
        first["projection"]["thread"]["deletedAt"].is_null(),
        "{first}"
    );
}

/// Appends copies of `event` (a stored `message.updated`) with the given text sizes and
/// streaming flags straight to the store, after its last event. Returns the cursor before them.
fn append_message_updates(db: &TempDb, event: &Value, copies: &[(usize, bool)]) -> u64 {
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    let last: i64 = conn
        .query_row("SELECT MAX(seq) FROM events", [], |row| row.get(0))
        .unwrap();
    for (n, (size, streaming)) in copies.iter().enumerate() {
        let seq = last + 1 + n as i64;
        let mut copy = event.clone();
        copy["id"] = json!(format!("event:{seq}"));
        copy["payload"]["text"] = json!("x".repeat(*size));
        copy["payload"]["streaming"] = json!(streaming);
        conn.execute(
            "INSERT INTO events (seq, thread_id, type, streaming, event) VALUES (?1, 't1', 'message.updated', ?2, ?3)",
            rusqlite::params![seq, streaming, copy.to_string()],
        )
        .unwrap();
    }
    last as u64
}

/// T3 bounds a resume's replay twice at 1 MiB (`ws.ts`): the stored payload JSON of the
/// events after the cursor, then the items it would send once streamed updates of one
/// message are coalesced (`coalesceLiveUpdatedEvents`).
#[tokio::test(flavor = "current_thread")]
async fn a_resume_bounds_stored_payloads_and_coalesced_items_as_t3() {
    const LIMIT: usize = 1_048_576;
    let db = TempDb::new("resume-bytes");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    until_run_ends(&mut stream).await;
    drop(stream);
    drop(engine);
    let event: Value = {
        let conn = rusqlite::Connection::open(db.path()).unwrap();
        let text: String = conn
            .query_row(
                "SELECT event FROM events WHERE type = 'message.updated'
                 AND json_extract(event, '$.payload.role') = 'assistant' ORDER BY seq DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&text).unwrap()
    };
    let sized = |size: usize, streaming: bool| {
        let mut copy = event.clone();
        copy["payload"]["text"] = json!("x".repeat(size));
        copy["payload"]["streaming"] = json!(streaming);
        copy
    };
    // Text size per copy so the payload or the sent item is exactly `bytes` long.
    let payload_overhead = sized(0, true)["payload"].to_string().len();
    let item_overhead = |seq: u64| {
        let mut copy = sized(0, false);
        copy["id"] = json!(format!("event:{seq}"));
        json!({"kind": "event", "sequence": seq, "event": copy})
            .to_string()
            .len()
    };
    let db = &db;
    let resume = |after: u64| async move {
        let (engine, _) = open(db);
        let mut resumed = engine
            .subscribe_thread(
                from_json(json!({"threadId": "t1", "afterSequence": after,
                "requestCompletionMarker": true}))
                .unwrap(),
            )
            .await
            .unwrap();
        let mut items = vec![];
        loop {
            let item = next(&mut resumed).await;
            if item["kind"] == "synchronized" {
                return items;
            }
            items.push(item);
        }
    };

    // Eight streamed updates of one message: their payloads are exactly 1 MiB, the items
    // before coalescing are more, and the one kept after coalescing fits.
    let each = LIMIT / 8 - payload_overhead;
    let after = append_message_updates(db, &event, &[(each, true); 8]);
    let items = resume(after).await;
    assert_eq!(items.len(), 1, "coalesced to the last update");
    assert_eq!(items[0]["kind"], "event");
    assert_eq!(items[0]["sequence"], after + 8);

    // One stored byte more: a snapshot, although the coalesced replay would fit.
    let mut copies = [(each, true); 8];
    copies[7].0 += 1;
    let after = append_message_updates(db, &event, &copies);
    assert_eq!(resume(after).await[0]["kind"], "snapshot");

    // One final update whose item is exactly 1 MiB replays; one byte more does not.
    let last = {
        let conn = rusqlite::Connection::open(db.path()).unwrap();
        conn.query_row("SELECT MAX(seq) FROM events", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap() as u64
    };
    let size = LIMIT - item_overhead(last + 1);
    let after = append_message_updates(db, &event, &[(size, false)]);
    let items = resume(after).await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], "event");
    let after = append_message_updates(db, &event, &[(size + 1, false)]);
    assert_eq!(resume(after).await[0]["kind"], "snapshot");
}

#[tokio::test(flavor = "current_thread")]
async fn interrupt_and_permission_answers_reach_the_provider() {
    let db = TempDb::new("interrupt");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    assert_eq!(next(&mut thread).await["kind"], "snapshot");

    dispatch(&engine, message("t1", "c2", "hang")).await;
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "provider-turn.updated" {
            break;
        }
    }
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c3", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    let events = until_run_ends(&mut thread).await;
    assert_eq!(events.last().unwrap().1["status"], "interrupted");

    // A second turn reuses the session and asks for an approval.
    dispatch(&engine, message("t1", "c4", "ask")).await;
    let request = loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "runtime-request.updated" {
            break item["event"]["payload"].clone();
        }
    };
    assert_eq!(request["status"], "pending");
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(
        shell["threads"][0]["pendingRuntimeRequest"]["id"],
        "request:1"
    );

    dispatch(
        &engine,
        json!({"type": "runtime-request.respond", "commandId": "c5", "threadId": "t1",
        "requestId": "request:1", "decision": "accept"}),
    )
    .await;
    let events = until_run_ends(&mut thread).await;
    let answer = events
        .iter()
        .find(|(ty, p)| ty == "message.updated" && p["role"] == "assistant")
        .unwrap();
    assert_eq!(answer.1["text"], "approval: accept");
    assert_eq!(events.last().unwrap().1["status"], "completed");
    // A request answered through its live session names that session's instance, as T3's
    // `dispatchRuntimeRequestRespond`.
    assert_eq!(request["responseCapability"]["type"], "live");
    let log = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 100_000))
        .await
        .unwrap();
    let resolved = log
        .iter()
        .map(|(_, e)| e)
        .find(|e| e["type"] == "runtime-request.updated" && e["payload"]["status"] == "resolved")
        .expect("the answer is stored");
    assert_eq!(resolved["providerInstanceId"], "claudeAgent", "{resolved}");

    // Answering again is refused: the request is no longer pending.
    let again = engine
        .dispatch(
            from_json(
                json!({"type": "runtime-request.respond", "commandId": "c6", "threadId": "t1",
            "requestId": "request:1", "decision": "accept"}),
            )
            .unwrap(),
        )
        .await;
    assert!(matches!(again, Err(EngineError::Rejected(_))));
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_turn_shows_its_error() {
    let db = TempDb::new("fail");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "fail")).await;
    let events = until_run_ends(&mut thread).await;
    assert!(kinds(&events).contains(&"turn-item.updated error failed".to_owned()));
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["status"], "failed");
    assert_eq!(
        shell["threads"][0]["lastError"],
        "The fake provider failed."
    );
}

/// `activeProviderGoalForShell`: the shell shows the goal of the thread's active provider
/// thread, as the GPUI thread list and the desktop goal banner read it.
#[tokio::test(flavor = "current_thread")]
async fn the_shell_shows_the_active_provider_threads_goal() {
    let db = TempDb::new("goal");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    assert_eq!(
        engine.shell_snapshot().await.unwrap()["threads"][0]["goal"],
        Value::Null
    );
    dispatch(&engine, message("t1", "c2", "goal")).await;
    until_run_ends(&mut thread).await;
    let active = json!({"objective": "Ship the feature", "status": "active", "tokensUsed": 12,
        "tokenBudget": null, "timeUsedSeconds": 3});
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["goal"], active);
    // The next ordinary turn's running row keeps the stored goal.
    dispatch(&engine, message("t1", "c3", "hello")).await;
    until_run_ends(&mut thread).await;
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["goal"], active);
}

/// `RunExecutionService`'s provider stop reason: a turn a hook stopped ends completed, with
/// the hook's reason kept as a "Stopped by the provider" warning on its run. The work log
/// shows it after a reload; an ordinary completed turn gets none.
#[tokio::test(flavor = "current_thread")]
async fn a_provider_stop_reason_stays_on_the_completed_run() {
    let db = TempDb::new("stop-reason");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hook-stop")).await;
    until_run_ends(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "plain")).await;
    until_run_ends(&mut thread).await;
    drop(thread);
    drop(engine);

    let (engine, _) = open(&db);
    let p = projection(&engine, "t1").await;
    let warnings: Vec<(Value, Value, Value, Value)> = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "system_notice")
        .map(|item| {
            (
                item["runId"].clone(),
                item["title"].clone(),
                item["level"].clone(),
                item["message"].clone(),
            )
        })
        .collect();
    assert_eq!(
        warnings,
        [(
            json!("run:t1:1"),
            json!("Stopped by the provider"),
            json!("warning"),
            json!(crate::fake::HOOK_STOP_REASON)
        )]
    );
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".to_owned(), "completed".to_owned()),
            ("run:t1:2".to_owned(), "completed".to_owned())
        ]
    );
    // `subagentProjection.ts` finds the notice by `runSignalTurnItem`'s id.
    let id = conn_support::ids::join_id(
        "turn-item",
        &["run", "run:t1:1", "signal", "provider-stop-reason"],
    );
    assert_eq!(item_of(&p, &id)["message"], crate::fake::HOOK_STOP_REASON);
}

/// `RunExecutionService`'s interrupted terminal: the Stop result takes the stored Stop
/// request's reason, else the provider's stop reason, and never shows a stop-reason warning.
#[tokio::test(flavor = "current_thread")]
async fn a_provider_stop_reason_backs_the_stop_result() {
    let db = TempDb::new("stop-reason-interrupt");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hook-interrupt")).await;
    until_run_ends(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "hook-hang")).await;
    until_provider_turn(&mut thread).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    dispatch(&engine, stop("t1", "c4")).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(
        item_of(&p, "turn-item:run:t1:1:interrupt-result")["message"],
        crate::fake::HOOK_STOP_REASON
    );
    assert_eq!(
        item_of(&p, "turn-item:run:t1:2:interrupt-result")["message"],
        "Stopped by user"
    );
    let notices = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "system_notice")
        .count();
    assert_eq!(notices, 0, "an interrupted run shows no warning");
}

/// `subagentResultForRun`: a delegated child a hook stopped before any answer gives its
/// parent the hook's reason, not an empty result.
#[tokio::test(flavor = "current_thread")]
async fn a_hook_stopped_child_gives_its_parent_the_reason() {
    let db = TempDb::new("stop-reason-child");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, delegate("d1", "hook-stop", None)).await;
    let child = "thread:delegated-task:d1";
    run_to_end(&engine, child, &format!("run:{child}:1")).await;
    let parent = projection(&engine, "t1").await;
    let expected = format!(
        "Child task completed without an assistant result.\n\n{}",
        crate::fake::HOOK_STOP_REASON
    );
    assert_eq!(parent["subagents"][0]["result"], expected.as_str());
    assert_eq!(
        item_of(&parent, "turn-item:delegated-task:d1")["result"],
        expected.as_str()
    );
}

/// Starts a `hang` turn on t1 and drops the engine while it runs, as a killed process would.
async fn die_during_a_turn(db: &TempDb, command: &str) {
    let (engine, _) = open(db);
    if engine.get_thread_projection("t1".into()).await.is_err() {
        dispatch(&engine, create("t1", "c1")).await;
    }
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", command, "hang")).await;
    until_provider_turn(&mut thread).await;
    // The provider took the prompt: its start row settles (the restart's evidence).
    settled_statuses(db, "provider-turn.start").await;
}

/// Audit 5.1, T3's `reconcile` (`resolveProjectSettings(..).continueThreadsAfterServerUpdate`):
/// the restart continues a cut turn only where the setting allows it, and a project override
/// wins in both directions.
#[tokio::test(flavor = "current_thread")]
async fn a_project_override_decides_whether_a_restart_continues() {
    for (global, project, continues) in [(false, true, true), (true, false, false)] {
        let db = TempDb::new(&format!("restart-policy-{global}-{project}"));
        die_during_a_turn(&db, "c2").await;
        let mut config = EngineConfig::new(db.path());
        config.projects = vec![ProjectConfig {
            title: "Project".into(),
            workspace_root: ROOT.into(),
        }];
        config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
        config.restart_policy = crate::RestartPolicy {
            continue_by_default: global,
            projects: [(project_id(), project)].into(),
        };
        let engine = SqliteEngine::open(config).unwrap();
        let p = if continues {
            run_to_end(&engine, "t1", "run:t1:2").await
        } else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            projection(&engine, "t1").await
        };
        assert_eq!(run_of(&p, "run:t1:1")["status"], "cancelled");
        let runs = p["runs"].as_array().map(Vec::len);
        assert_eq!(
            runs,
            Some(if continues { 2 } else { 1 }),
            "global {global}, project {project}"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_restart_continues_the_running_turn_in_the_same_provider_thread() {
    let db = TempDb::new("restart");
    die_during_a_turn(&db, "c2").await;

    let (engine, provider) = open(&db);
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "cancelled".into()),
            ("run:t1:2".into(), "completed".into())
        ]
    );
    assert_eq!(p["runs"][1]["restartContinuationOfRunId"], "run:t1:1");
    let types: Vec<_> = p["visibleTurnItems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["item"]["type"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        types,
        [
            "user_message",
            "system_notice",
            "user_message",
            "assistant_message"
        ]
    );
    let continuation = &p["messages"][1];
    assert_eq!(continuation["createdBy"], "agent");
    assert_eq!(continuation["creationSource"], "server");
    assert!(
        continuation["text"]
            .as_str()
            .unwrap()
            .starts_with("Continue where you left off.")
    );
    // The new session resumed the stored provider thread instead of starting a new one.
    assert_eq!(p["runs"][1]["providerThreadId"], "provider-thread:t1");
    assert_eq!(
        provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["status"], "completed");
}

/// A clean stop (SIGTERM, a service restart) keeps the running turn for the next start, as T3
/// does: the closing session's end of the turn is not stored, so the next start continues it.
/// `idle-diff.mjs` compares the shell after such a restart with the T3 server's.
#[tokio::test(flavor = "current_thread")]
async fn a_shutdown_leaves_the_running_turn_for_the_next_start() {
    let db = TempDb::new("shutdown-running");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .unwrap();
        next(&mut thread).await;
        dispatch(&engine, message("t1", "c2", "hang")).await;
        until_provider_turn(&mut thread).await;
        engine.shutdown().await;
        let p = projection(&engine, "t1").await;
        assert_eq!(
            run_statuses(&p),
            [("run:t1:1".into(), "running".into())],
            "shutdown stores no end of the turn"
        );
    }
    let (engine, _) = open(&db);
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "cancelled".into()),
            ("run:t1:2".into(), "completed".into())
        ]
    );
    assert_eq!(p["runs"][1]["restartContinuationOfRunId"], "run:t1:1");
}

/// Under systemd the stop signal reaches the provider processes too, and they exit while the
/// server still drains its connections, before [`Engine::shutdown`]. Once shutdown began, that
/// exit must not end the run: the next start continues it, as after any clean stop. Before
/// `begin_shutdown` the run was stored `failed` ("The provider session ended during the
/// turn."), found on Beast with `systemctl restart t3.service` during a Codex turn.
#[tokio::test(flavor = "current_thread")]
async fn a_provider_that_exits_with_the_server_leaves_the_run_for_the_next_start() {
    let db = TempDb::new("shutdown-provider-exit");
    {
        let exit = Arc::new(tokio::sync::Notify::new());
        let (engine, _) = open_with(
            &db,
            FakeProvider::new("claudeAgent").with_process_exit(exit.clone()),
        );
        dispatch(&engine, create("t1", "c1")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .unwrap();
        next(&mut thread).await;
        dispatch(&engine, message("t1", "c2", "hang")).await;
        until_provider_turn(&mut thread).await;
        engine.begin_shutdown();
        exit.notify_waiters();
        // Let the pump see the end of the stream before the server closes the sessions.
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        engine.shutdown().await;
        let p = projection(&engine, "t1").await;
        assert_eq!(
            run_statuses(&p),
            [("run:t1:1".into(), "running".into())],
            "a provider exit after the signal ends no run"
        );
    }
    let (engine, _) = open(&db);
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][1]["restartContinuationOfRunId"], "run:t1:1");
}

/// Without a shutdown, a provider process that exits during a turn fails the run.
#[tokio::test(flavor = "current_thread")]
async fn a_provider_that_exits_during_a_turn_fails_the_run() {
    let db = TempDb::new("provider-exit");
    let exit = Arc::new(tokio::sync::Notify::new());
    let (engine, _) = open_with(
        &db,
        FakeProvider::new("claudeAgent").with_process_exit(exit.clone()),
    );
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    exit.notify_waiters();
    let mut status = String::new();
    for _ in 0..200 {
        tokio::task::yield_now().await;
        let p = projection(&engine, "t1").await;
        status = p["runs"][0]["status"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if status != "running" {
            break;
        }
    }
    assert_eq!(status, "failed");
}

/// t1's provider thread (the session's), once a turn has started there.
async fn provider_thread_of_t1(engine: &SqliteEngine) -> String {
    projection(engine, "t1").await["providerThreads"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Writes, on t1, a running native subagent (`node:native`) of `provider_thread` with its
/// node, turn item and child thread `child` (an open runless root turn, a command and a
/// provider turn under it), plus a finished native one and a running app-owned one, which
/// stay as they are. Two more running native ones belong to a newer session: `node:other`
/// runs on another provider thread, `node:late` started after now.
async fn seed_native_subagents(engine: &SqliteEngine, provider_thread: &str) {
    dispatch(engine, create("child", "c-child")).await;
    let provider_thread = provider_thread.to_owned();
    engine
        .inner()
        .write(move |tx| {
            use crate::store::Draft;
            let now = tx.now().to_owned();
            let later = "2999-01-01T00:00:00.000Z";
            let sub = |id: &str, origin: &str, status: &str, child: Value, started: &str| {
                json!({"id": id, "threadId": "t1", "runId": "run:t1:1", "parentNodeId": null,
                       "origin": origin, "createdBy": "agent", "driver": "claudeAgent",
                       "providerInstanceId": "claudeAgent", "providerThreadId": null,
                       "childThreadId": child, "prompt": "p", "title": id, "model": null,
                       "status": status, "result": null, "startedAt": started,
                       "completedAt": null, "updatedAt": started})
            };
            for (row, on) in [
                (
                    sub(
                        "node:native",
                        "provider_native",
                        "running",
                        json!("child"),
                        &now,
                    ),
                    provider_thread.as_str(),
                ),
                (
                    sub(
                        "node:done",
                        "provider_native",
                        "completed",
                        json!(null),
                        &now,
                    ),
                    provider_thread.as_str(),
                ),
                (
                    sub("node:app", "app_owned", "running", json!(null), &now),
                    provider_thread.as_str(),
                ),
                (
                    sub(
                        "node:other",
                        "provider_native",
                        "running",
                        json!(null),
                        &now,
                    ),
                    "pt:newer-session",
                ),
                (
                    sub(
                        "node:late",
                        "provider_native",
                        "running",
                        json!(null),
                        later,
                    ),
                    provider_thread.as_str(),
                ),
            ] {
                let id = row["id"].as_str().unwrap().to_owned();
                tx.append(Draft::new("t1", "subagent.updated", row.clone()))?;
                tx.append(Draft::new(
                    "t1",
                    "node.updated",
                    json!({
                    "id": id, "threadId": "t1", "runId": "run:t1:1", "kind": "subagent",
                    "status": row["status"], "startedAt": now, "completedAt": null}),
                ))?;
                tx.append(Draft::new(
                    "t1",
                    "turn-item.updated",
                    json!({
                    "id": format!("item:{id}"), "threadId": "t1", "runId": "run:t1:1",
                    "nodeId": id, "status": row["status"], "type": "subagent",
                    "subagentId": id, "providerThreadId": on,
                    "startedAt": now, "completedAt": null, "updatedAt": now}),
                ))?;
            }
            tx.append(Draft::new(
                "child",
                "node.updated",
                json!({
                "id": "node:child-root", "threadId": "child", "runId": null, "kind": "root_turn",
                "status": "running", "startedAt": now, "completedAt": null}),
            ))?;
            tx.append(Draft::new(
                "child",
                "turn-item.updated",
                json!({
                "id": "item:child-cmd", "threadId": "child", "runId": null,
                "nodeId": "node:child-root", "status": "running", "type": "command_execution",
                "input": "ls", "startedAt": now, "completedAt": null, "updatedAt": now}),
            ))?;
            tx.append(Draft::new(
                "child",
                "provider-turn.updated",
                json!({
                "id": "turn:child", "threadId": "child", "runAttemptId": null,
                "nodeId": "node:child-root", "status": "running", "startedAt": now,
                "completedAt": null}),
            ))?;
            Ok(())
        })
        .await
        .unwrap();
}

/// `(thread, kind, id)` row's status.
async fn row_status(engine: &SqliteEngine, thread: &str, kind: &str, id: &str) -> String {
    let (thread, kind, id) = (thread.to_owned(), kind.to_owned(), id.to_owned());
    engine
        .inner()
        .write(move |tx| tx.entity(&thread, &kind, &id))
        .await
        .unwrap()
        .unwrap()["status"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The open native subagent, its node and item, and its child's runless root turn, item and
/// provider turn end with `status`; the finished and app-owned subagents stay as they were.
async fn assert_orphans_ended(engine: &SqliteEngine, status: &str) {
    for (thread, kind, id) in [
        ("t1", "subagents", "node:native"),
        ("t1", "nodes", "node:native"),
        ("t1", "turnItems", "item:node:native"),
        ("child", "nodes", "node:child-root"),
        ("child", "turnItems", "item:child-cmd"),
        ("child", "providerTurns", "turn:child"),
    ] {
        assert_eq!(
            row_status(engine, thread, kind, id).await,
            status,
            "{kind} {id}"
        );
    }
    // The run's own end may close the app-owned item; its subagent row is not ours to end.
    assert_eq!(
        row_status(engine, "t1", "subagents", "node:done").await,
        "completed"
    );
    assert_eq!(
        row_status(engine, "t1", "turnItems", "item:node:done").await,
        "completed"
    );
    assert_eq!(
        row_status(engine, "t1", "subagents", "node:app").await,
        "running"
    );
    // The client moves the agent to "Previous agents" from these events' statuses.
    let events = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 10_000))
        .await
        .unwrap();
    let ended: Vec<(String, String)> = events
        .iter()
        .filter(|(_, e)| e["payload"]["status"] == status)
        .map(|(_, e)| {
            (
                e["type"].as_str().unwrap().to_owned(),
                e["payload"]["id"].as_str().unwrap().to_owned(),
            )
        })
        .filter(|(_, id)| id.contains("native"))
        .collect();
    assert_eq!(
        ended,
        [
            ("subagent.updated".to_owned(), "node:native".to_owned()),
            ("node.updated".to_owned(), "node:native".to_owned()),
            (
                "turn-item.updated".to_owned(),
                "item:node:native".to_owned()
            ),
        ]
    );
    let subagent = &events
        .iter()
        .rev()
        .find(|(_, e)| e["type"] == "subagent.updated" && e["payload"]["id"] == "node:native")
        .unwrap()
        .1;
    assert!(subagent["payload"]["completedAt"].is_string());
    assert_eq!(subagent["nodeId"], "node:native");
}

/// No provider process survives a restart: a start ends the native subagents it finds open
/// as cancelled (`ProviderRuntimeRecoveryService.ts`).
#[tokio::test(flavor = "current_thread")]
async fn a_restart_cancels_orphaned_native_subagents() {
    let db = TempDb::new("orphans-restart");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        seed_native_subagents(&engine, "pt:gone").await;
    }
    let (engine, _) = open(&db);
    assert_orphans_ended(&engine, "cancelled").await;
    // No process survives a restart: a newer session's ones end too.
    assert_eq!(
        row_status(&engine, "t1", "subagents", "node:other").await,
        "cancelled"
    );
}

/// Release and recovery end a subagent thread's runless root turns and what hangs under them
/// (`endRunlessRootTurns`), not every open row: a subagent nested there keeps its node for its
/// own end, and a runless item outside the root turn stays too.
#[tokio::test(flavor = "current_thread")]
async fn a_restart_ends_only_the_runless_root_turns_of_a_subagent_thread() {
    let db = TempDb::new("orphans-restart-root-turns");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        seed_native_subagents(&engine, "pt:gone").await;
        engine
            .inner()
            .write(|tx| {
                use crate::store::Draft;
                let now = tx.now().to_owned();
                tx.append(Draft::new(
                    "child",
                    "node.updated",
                    json!({"id": "node:nested", "threadId": "child", "runId": null,
                        "kind": "subagent", "status": "running", "startedAt": now,
                        "completedAt": null}),
                ))?;
                tx.append(Draft::new(
                    "child",
                    "turn-item.updated",
                    json!({"id": "item:loose", "threadId": "child", "runId": null,
                        "nodeId": null, "status": "running", "type": "command_execution",
                        "input": "ls", "startedAt": now, "completedAt": null, "updatedAt": now}),
                ))?;
                Ok(())
            })
            .await
            .unwrap();
    }
    let (engine, _) = open(&db);
    assert_eq!(
        row_status(&engine, "child", "nodes", "node:child-root").await,
        "cancelled"
    );
    assert_eq!(
        row_status(&engine, "child", "nodes", "node:nested").await,
        "running"
    );
    assert_eq!(
        row_status(&engine, "child", "turnItems", "item:loose").await,
        "running"
    );
}

/// A session whose process ends takes its native subagents with it: they end interrupted
/// (`writeReleasedSubagentEvents` in `ProviderSessionManager.ts`).
#[tokio::test(flavor = "current_thread")]
async fn a_provider_exit_interrupts_its_native_subagents() {
    let db = TempDb::new("orphans-exit");
    let exit = Arc::new(tokio::sync::Notify::new());
    let (engine, _) = open_with(
        &db,
        FakeProvider::new("claudeAgent").with_process_exit(exit.clone()),
    );
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    seed_native_subagents(&engine, &provider_thread).await;
    exit.notify_waiters();
    // The pump stores the subagents' end after the run's.
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "subagent.updated"
            && item["event"]["payload"]["status"] == "interrupted"
        {
            break;
        }
    }
    assert_orphans_ended(&engine, "interrupted").await;
    assert_newer_session_untouched(&engine).await;
}

/// A newer session's subagents stay open: one on another provider thread, one started after
/// the release.
async fn assert_newer_session_untouched(engine: &SqliteEngine) {
    // The run's own end leaves their items open too: a live native subagent ends itself.
    for id in ["node:other", "node:late"] {
        assert_eq!(
            row_status(engine, "t1", "turnItems", &format!("item:{id}")).await,
            "running",
            "{id}"
        );
        assert_eq!(
            row_status(engine, "t1", "subagents", id).await,
            "running",
            "{id}"
        );
        assert_eq!(
            row_status(engine, "t1", "nodes", id).await,
            "running",
            "{id}"
        );
    }
}

/// A closed session whose process ended interrupts its own native subagents and no newer
/// session's.
#[tokio::test(flavor = "current_thread")]
async fn a_closed_session_interrupts_only_its_own_native_subagents() {
    let db = TempDb::new("orphans-close");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent"));
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    seed_native_subagents(&engine, &provider_thread).await;
    engine.inner().close_session("t1").await;
    assert_orphans_ended(&engine, "interrupted").await;
    assert_newer_session_untouched(&engine).await;
}

/// A session closed on a process that keeps running (Codex's shared `app-server`) leaves its
/// native subagents open: the process may still run them. Its pump ends all the same.
#[tokio::test(flavor = "current_thread")]
async fn a_shared_runtime_close_leaves_native_subagents_open() {
    let db = TempDb::new("orphans-shared");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent").with_shared_runtime());
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    seed_native_subagents(&engine, &provider_thread).await;
    engine.inner().close_session("t1").await;
    // The pump sees the close and ends the run; wait for that, then for anything after it.
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "run.updated" && item["event"]["payload"]["status"] == "failed"
        {
            break;
        }
    }
    engine.inner().events_stored("t1").await;
    for (thread, kind, id) in [
        ("t1", "subagents", "node:native"),
        ("t1", "nodes", "node:native"),
        ("t1", "turnItems", "item:node:native"),
        ("child", "nodes", "node:child-root"),
    ] {
        assert_eq!(
            row_status(&engine, thread, kind, id).await,
            "running",
            "{kind} {id}"
        );
    }
}

/// After that close the process still reports what it runs for the session: a subagent that
/// ends later reaches the store, as T3's adapter keeps a child's turn context past a release.
/// The pump reads on until the session drops its events.
#[tokio::test(flavor = "current_thread")]
async fn a_shared_runtime_close_still_stores_a_subagents_later_end() {
    let db = TempDb::new("orphans-shared-late");
    let (engine, provider) = open_with(&db, FakeProvider::new("claudeAgent").with_shared_runtime());
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    seed_native_subagents(&engine, &provider_thread).await;
    engine.inner().close_session("t1").await;
    let late = provider
        .after_close
        .lock()
        .unwrap()
        .take()
        .expect("the closed session's events");
    let mut subagent = engine
        .inner()
        .write(|tx| tx.entity("t1", "subagents", "node:native"))
        .await
        .unwrap()
        .unwrap();
    subagent["status"] = json!("completed");
    subagent["completedAt"] = subagent["startedAt"].clone();
    subagent["parentNodeId"] = json!("node:root");
    subagent["nativeTaskRef"] = Value::Null;
    late.send(from_json(json!({"type": "subagent.updated", "subagent": subagent})).unwrap())
        .await
        .unwrap();
    drop(late);
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "subagent.updated"
            && item["event"]["payload"]["id"] == "node:native"
            && item["event"]["payload"]["status"] == "completed"
        {
            break;
        }
    }
    assert_eq!(
        row_status(&engine, "t1", "subagents", "node:native").await,
        "completed"
    );
}

/// A confirmed Stop ends the run's own native subagent with it: record, node, item and its
/// child's runless turn together (T3's `cascadeTerminalizeRunOwnedSubagents`).
#[tokio::test(flavor = "current_thread")]
async fn a_confirmed_stop_ends_the_runs_native_subagents() {
    let db = TempDb::new("orphans-stop");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent"));
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    seed_native_subagents(&engine, &provider_thread).await;
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c3", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    let ended = until_run_ends(&mut thread).await;
    assert_eq!(ended.last().unwrap().1["status"], "interrupted");
    for (thread, kind, id) in [
        ("t1", "subagents", "node:native"),
        ("t1", "nodes", "node:native"),
        ("t1", "turnItems", "item:node:native"),
        ("child", "nodes", "node:child-root"),
        ("child", "turnItems", "item:child-cmd"),
    ] {
        assert_eq!(
            row_status(&engine, thread, kind, id).await,
            "interrupted",
            "{kind} {id}"
        );
    }
    // An app-owned subagent is not the provider's to end.
    assert_eq!(
        row_status(&engine, "t1", "subagents", "node:app").await,
        "running"
    );
}

/// A Stop after the subagent's record settled still settles the open work the run's child
/// link leads to: its item and the child's runless root turn and item (T3 keeps
/// `linkedChildThreadIds` for the run's lifetime). Ports the `stopped` case of T3's "ends a
/// subagent that outlived its root when the provider stream fails": the record keeps its
/// result.
#[tokio::test(flavor = "current_thread")]
async fn a_confirmed_stop_after_the_record_settled_ends_the_childs_open_work() {
    let db = TempDb::new("orphans-stop-settled");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent"));
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    seed_native_subagents(&engine, &provider_thread).await;
    engine
        .inner()
        .write(|tx| {
            let mut row = tx.entity("t1", "subagents", "node:native")?.unwrap();
            row["status"] = json!("completed");
            tx.append(crate::store::Draft::new("t1", "subagent.updated", row))?;
            Ok(())
        })
        .await
        .unwrap();
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c3", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    until_run_ends(&mut thread).await;
    assert_eq!(
        row_status(&engine, "t1", "subagents", "node:native").await,
        "completed",
        "a settled record keeps its result"
    );
    for (thread, kind, id) in [
        ("t1", "nodes", "node:native"),
        ("t1", "turnItems", "item:node:native"),
        ("child", "nodes", "node:child-root"),
        ("child", "turnItems", "item:child-cmd"),
    ] {
        assert_eq!(
            row_status(&engine, thread, kind, id).await,
            "interrupted",
            "{kind} {id}"
        );
    }
    // Each row settles once.
    let events = engine
        .inner()
        .db(|store| store.thread_events_after("child", 0, 10_000))
        .await
        .unwrap();
    let ends = events
        .iter()
        .filter(|(_, e)| {
            e["payload"]["id"] == "node:child-root" && e["payload"]["status"] == "interrupted"
        })
        .count();
    assert_eq!(ends, 1);
}

/// A failed root whose native children still run (`childTurnsContinue`) leaves them running:
/// they settle without it (`RunExecutionService` skips the cascade).
#[tokio::test(flavor = "current_thread")]
async fn a_failed_root_whose_children_continue_leaves_them_running() {
    let db = TempDb::new("orphans-failed-continue");
    let (engine, provider) = open_with(&db, FakeProvider::new("claudeAgent"));
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    seed_native_subagents(&engine, &provider_thread).await;
    let events = provider
        .last_events
        .lock()
        .unwrap()
        .as_ref()
        .and_then(tokio::sync::mpsc::WeakSender::upgrade)
        .expect("the session's events");
    events
        .send(
            from_json(
                json!({"type": "turn.terminal", "providerThreadId": provider_thread,
                "providerTurnId": "turn:run:t1:1", "runOrdinal": 1, "status": "failed",
                "failure": null, "threadDisposition": "reusable", "childTurnsContinue": true}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    drop(events);
    let ended = until_run_ends(&mut thread).await;
    assert_eq!(ended.last().unwrap().1["status"], "failed");
    for (thread, kind, id) in [
        ("t1", "subagents", "node:native"),
        ("t1", "nodes", "node:native"),
        ("t1", "turnItems", "item:node:native"),
        ("child", "nodes", "node:child-root"),
    ] {
        assert_eq!(
            row_status(&engine, thread, kind, id).await,
            "running",
            "{kind} {id}"
        );
    }
}

/// A Stop the provider confirmed before a close keeps its status: the close stores the
/// terminals already received before it detaches the run.
#[tokio::test(flavor = "current_thread")]
async fn a_close_keeps_a_stop_the_provider_already_confirmed() {
    let db = TempDb::new("close-after-stop");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent"));
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let inner = engine.inner();
    // The provider confirms the Stop: its events are sent before the close starts. The pump
    // holds the first of them, received but not stored, while the session closes.
    let pump = engine.test_pause_at("pump.event");
    inner
        .clone()
        .interrupt("t1".to_owned(), "run:t1:1".to_owned())
        .await;
    pump.reached.notified().await;
    assert_eq!(
        row_status(&engine, "t1", "runs", "run:t1:1").await,
        "running",
        "nothing of the Stop is stored before the close"
    );
    inner.close_session("t1").await;
    pump.resume.notify_one();
    // A Stop the close lost would detach the run as `failed` instead.
    until_run_ends(&mut thread).await;
    assert_eq!(
        row_status(&engine, "t1", "runs", "run:t1:1").await,
        "interrupted"
    );
}

/// Starts a hanging run on `t1` with the native subagents of [`seed_native_subagents`].
async fn hanging_run_with_subagents(
    engine: &SqliteEngine,
) -> Subscription<conn_contract::ThreadStreamItem, conn_contract::GetThreadProjectionError> {
    dispatch(engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(engine).await;
    seed_native_subagents(engine, &provider_thread).await;
    thread
}

async fn stop_t1<E: serde::Serialize>(
    engine: &SqliteEngine,
    thread: &mut Subscription<conn_contract::ThreadStreamItem, E>,
) {
    dispatch(
        engine,
        json!({"type": "run.interrupt", "commandId": "c3", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    let ended = until_run_ends(thread).await;
    assert_eq!(ended.last().unwrap().1["status"], "interrupted");
}

/// Ports T3's "ends a nested native subagent and its thread when the root run is
/// interrupted": a native subagent nested on the child thread (no run) and its own thread's
/// root turn end with the run that owns them.
#[tokio::test(flavor = "current_thread")]
async fn a_confirmed_stop_ends_a_nested_native_subagent_and_its_thread() {
    let db = TempDb::new("orphans-stop-nested");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent"));
    let mut thread = hanging_run_with_subagents(&engine).await;
    dispatch(&engine, create("grandchild", "c-grandchild")).await;
    engine
        .inner()
        .write(|tx| {
            use crate::store::Draft;
            let now = tx.now().to_owned();
            tx.append(Draft::new(
                "child",
                "subagent.updated",
                json!({"id": "node:nested", "threadId": "child", "runId": null,
                    "parentNodeId": null, "origin": "provider_native", "createdBy": "agent",
                    "driver": "claudeAgent", "providerInstanceId": "claudeAgent",
                    "providerThreadId": null, "childThreadId": "grandchild", "prompt": "p",
                    "title": "nested", "model": null, "status": "running", "result": null,
                    "startedAt": now, "completedAt": null, "updatedAt": now}),
            ))?;
            tx.append(Draft::new(
                "grandchild",
                "node.updated",
                json!({"id": "node:grandchild-root", "threadId": "grandchild", "runId": null,
                    "kind": "root_turn", "status": "running", "startedAt": now,
                    "completedAt": null}),
            ))?;
            Ok(())
        })
        .await
        .unwrap();
    stop_t1(&engine, &mut thread).await;
    assert_eq!(
        row_status(&engine, "child", "subagents", "node:nested").await,
        "interrupted"
    );
    assert_eq!(
        row_status(&engine, "grandchild", "nodes", "node:grandchild-root").await,
        "interrupted"
    );
    // Each cascade event belongs to the run that owns it; the rows keep their own `runId`
    // (`RunExecutionService.ts`: `runId: row.runId ?? run.id`).
    for (thread_id, event_type, id) in [
        ("child", "subagent.updated", "node:nested"),
        ("grandchild", "node.updated", "node:grandchild-root"),
    ] {
        let events = engine
            .inner()
            .db(move |store| store.thread_events_after(thread_id, 0, 10_000))
            .await
            .unwrap();
        let (_, ended) = events
            .iter()
            .rev()
            .find(|(_, e)| e["type"] == event_type && e["payload"]["id"] == id)
            .unwrap();
        assert_eq!(ended["payload"]["status"], "interrupted");
        assert_eq!(ended["runId"], "run:t1:1", "{event_type} {id}");
        assert_eq!(ended["payload"]["runId"], Value::Null, "{event_type} {id}");
    }
}

/// The child's root turn settled while one of its items is still open: the item ends on its
/// own.
#[tokio::test(flavor = "current_thread")]
async fn a_confirmed_stop_ends_an_open_item_under_a_settled_child_turn() {
    let db = TempDb::new("orphans-stop-open-item");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent"));
    let mut thread = hanging_run_with_subagents(&engine).await;
    engine
        .inner()
        .write(|tx| {
            let mut node = tx.entity("child", "nodes", "node:child-root")?.unwrap();
            node["status"] = json!("completed");
            tx.append(crate::store::Draft::new("child", "node.updated", node))?;
            Ok(())
        })
        .await
        .unwrap();
    stop_t1(&engine, &mut thread).await;
    assert_eq!(
        row_status(&engine, "child", "nodes", "node:child-root").await,
        "completed"
    );
    assert_eq!(
        row_status(&engine, "child", "turnItems", "item:child-cmd").await,
        "interrupted"
    );
}

/// T3 picks a child thread's open nodes and items by run, not by kind: any node or item with
/// no run or with the root run ends, and a streaming item stops streaming.
#[tokio::test(flavor = "current_thread")]
async fn a_confirmed_stop_ends_every_open_child_node_and_item_of_the_run() {
    let db = TempDb::new("orphans-stop-owned-rows");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent"));
    let mut thread = hanging_run_with_subagents(&engine).await;
    engine
        .inner()
        .write(|tx| {
            use crate::store::Draft;
            let now = tx.now().to_owned();
            tx.append(Draft::new(
                "child",
                "node.updated",
                json!({"id": "node:child-tool", "threadId": "child", "runId": null,
                    "kind": "tool", "status": "running", "startedAt": now, "completedAt": null}),
            ))?;
            tx.append(Draft::new(
                "child",
                "turn-item.updated",
                json!({"id": "item:child-text", "threadId": "child", "runId": "run:t1:1",
                    "nodeId": null, "status": "running", "type": "assistant_message",
                    "text": "partial", "streaming": true, "startedAt": now,
                    "completedAt": null, "updatedAt": now}),
            ))?;
            Ok(())
        })
        .await
        .unwrap();
    stop_t1(&engine, &mut thread).await;
    assert_eq!(
        row_status(&engine, "child", "nodes", "node:child-tool").await,
        "interrupted"
    );
    let item = engine
        .inner()
        .write(|tx| tx.entity("child", "turnItems", "item:child-text"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(item["status"], "interrupted");
    assert_eq!(item["streaming"], false);
}

/// A run's chain of nested native subagents is followed to its end, however long.
#[tokio::test(flavor = "current_thread")]
async fn a_confirmed_stop_follows_a_long_chain_of_nested_subagents() {
    const DEPTH: usize = 300;
    let db = TempDb::new("orphans-stop-chain");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent"));
    let mut thread = hanging_run_with_subagents(&engine).await;
    for n in 0..DEPTH {
        dispatch(
            &engine,
            create(&format!("chain{n}"), &format!("c-chain{n}")),
        )
        .await;
    }
    engine
        .inner()
        .write(|tx| {
            use crate::store::Draft;
            let now = tx.now().to_owned();
            // `child` (the run's own subagent thread) leads to chain0, chain0 to chain1, ...
            for n in 0..DEPTH {
                let owner = if n == 0 {
                    "child".to_owned()
                } else {
                    format!("chain{}", n - 1)
                };
                tx.append(Draft::new(
                    &owner,
                    "subagent.updated",
                    json!({"id": format!("node:chain{n}"), "threadId": owner, "runId": null,
                        "parentNodeId": null, "origin": "provider_native", "createdBy": "agent",
                        "driver": "claudeAgent", "providerInstanceId": "claudeAgent",
                        "providerThreadId": null, "childThreadId": format!("chain{n}"),
                        "prompt": "p", "title": "chain", "model": null, "status": "running",
                        "result": null, "startedAt": now, "completedAt": null, "updatedAt": now}),
                ))?;
            }
            let last = format!("chain{}", DEPTH - 1);
            tx.append(Draft::new(
                &last,
                "node.updated",
                json!({"id": "node:deepest-root", "threadId": last, "runId": null,
                    "kind": "root_turn", "status": "running", "startedAt": now,
                    "completedAt": null}),
            ))?;
            Ok(())
        })
        .await
        .unwrap();
    stop_t1(&engine, &mut thread).await;
    assert_eq!(
        row_status(
            &engine,
            &format!("chain{}", DEPTH - 1),
            "nodes",
            "node:deepest-root"
        )
        .await,
        "interrupted"
    );
}

/// The provider confirmed a Stop and its terminal waits in the channel while the pump is held
/// by a slow write. The pump stores it in order: the run ends interrupted, not failed.
#[tokio::test(flavor = "current_thread")]
async fn a_close_behind_a_slow_write_keeps_a_confirmed_stop() {
    let ended =
        close_behind_a_slow_write(FakeProvider::new("claudeAgent"), Behind::ConfirmedStop).await;
    assert_eq!(ended, "interrupted");
}

/// No Stop: the provider's close itself ends the turn as interrupted while the pump is held by
/// a slow write. The close names itself as the cause, so the run is detached: it fails as a
/// session that ended during the turn.
#[tokio::test(flavor = "current_thread")]
async fn a_close_does_not_count_its_own_interrupt_as_a_stop() {
    let provider = FakeProvider::new("claudeAgent").with_close_interrupting();
    let ended = close_behind_a_slow_write(provider, Behind::Nothing).await;
    assert_eq!(ended, "failed");
}

/// A continuation request the pump read ahead and dispatched waits in the channel with the
/// message when the session closes. The close's own interrupted end still detaches the run.
#[tokio::test(flavor = "current_thread")]
async fn a_close_after_a_read_ahead_continuation_detaches_the_run() {
    let provider = FakeProvider::new("claudeAgent").with_close_interrupting();
    let ended = close_behind_a_slow_write(provider, Behind::Continuation).await;
    assert_eq!(ended, "failed");
}

/// A Stop the provider never confirmed is not confirmed by the close: the close's own
/// interrupted end detaches the run, which fails.
#[tokio::test(flavor = "current_thread")]
async fn a_stop_ended_only_by_the_close_is_not_a_confirmed_stop() {
    let db = TempDb::new("close-unconfirmed-stop");
    let (engine, _) = open_with(
        &db,
        FakeProvider::new("claudeAgent").with_close_interrupting(),
    );
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "stuck")).await;
    until_provider_turn(&mut thread).await;
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c3", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    // The provider did not confirm it: the Stop is marked unresponsive.
    loop {
        let item = next(&mut thread).await;
        let payload = &item["event"]["payload"];
        if payload["type"] == "run_interrupt_request" && payload["unresponsiveAt"].is_string() {
            break;
        }
    }
    engine.inner().close_session("t1").await;
    let ended = until_run_ends(&mut thread).await;
    assert_eq!(ended.last().unwrap().1["status"], "failed");
}

/// What waits in the channel behind the assistant message in [`close_behind_a_slow_write`].
#[derive(Clone, Copy, Debug)]
enum Behind {
    Nothing,
    /// The provider's confirmation of a Stop.
    ConfirmedStop,
    /// A continuation request, which the pump reads ahead of the message's write.
    Continuation,
}

/// Holds the store, sends an assistant message and `behind` on the running turn, closes the
/// session, then lets the store go. The run's end status.
async fn close_behind_a_slow_write(provider: FakeProvider, behind: Behind) -> String {
    let db = TempDb::new(&format!("close-slow-write-{behind:?}"));
    let (engine, provider) = open_with(&db, provider);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    // Hold the store.
    let (held, holding) = tokio::sync::oneshot::channel();
    let (release, hold) = std::sync::mpsc::channel::<()>();
    let inner = engine.inner().clone();
    let blocker = tokio::spawn(async move {
        inner
            .write(move |_| {
                let _ = held.send(());
                let _ = hold.recv();
                Ok(())
            })
            .await
    });
    holding.await.unwrap();
    let events = provider
        .last_events
        .lock()
        .unwrap()
        .as_ref()
        .and_then(tokio::sync::mpsc::WeakSender::upgrade)
        .expect("the session's events");
    let now = "2026-01-01T00:00:00.000Z";
    let mut sent = vec![
        json!({"type": "message.updated", "message": {"createdBy": "agent",
        "creationSource": "provider", "id": "message:slow", "threadId": "t1",
        "runId": "run:t1:1", "nodeId": null, "role": "assistant", "text": "x",
        "attachments": [], "streaming": false, "createdAt": now, "updatedAt": now}}),
    ];
    match behind {
        Behind::Nothing => {}
        Behind::ConfirmedStop => sent.push(
            json!({"type": "turn.terminal", "providerThreadId": provider_thread,
            "providerTurnId": "turn:run:t1:1", "runOrdinal": 1, "status": "interrupted",
            "failure": null, "threadDisposition": "reusable"}),
        ),
        Behind::Continuation => sent
            .push(json!({"type": "continuation.requested", "threadId": "t1",
            "providerThreadId": provider_thread, "detail": "Subagent completed: helper"})),
    }
    for event in sent {
        events.send(from_json(event).unwrap()).await.unwrap();
    }
    drop(events);
    let inner = engine.inner().clone();
    let closing = tokio::spawn(async move { inner.close_session("t1").await });
    tokio::time::timeout(Duration::from_secs(30), async {
        while provider.closed.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the close reached the session");
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    closing.await.unwrap();
    let ended = until_run_ends(&mut thread).await;
    ended.last().unwrap().1["status"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A clean stop leaves them open for the next start, which cancels them.
#[tokio::test(flavor = "current_thread")]
async fn a_shutdown_leaves_native_subagents_for_the_next_start() {
    let db = TempDb::new("orphans-shutdown");
    {
        let exit = Arc::new(tokio::sync::Notify::new());
        let (engine, _) = open_with(
            &db,
            FakeProvider::new("claudeAgent").with_process_exit(exit.clone()),
        );
        dispatch(&engine, create("t1", "c1")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .unwrap();
        next(&mut thread).await;
        dispatch(&engine, message("t1", "c2", "hang")).await;
        until_provider_turn(&mut thread).await;
        let provider_thread = provider_thread_of_t1(&engine).await;
        seed_native_subagents(&engine, &provider_thread).await;
        engine.begin_shutdown();
        exit.notify_waiters();
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        engine.shutdown().await;
        assert_eq!(
            row_status(&engine, "t1", "subagents", "node:native").await,
            "running"
        );
        assert_eq!(
            row_status(&engine, "child", "nodes", "node:child-root").await,
            "running"
        );
    }
    let (engine, _) = open(&db);
    assert_orphans_ended(&engine, "cancelled").await;
}

#[tokio::test(flavor = "current_thread")]
async fn restart_continuations_stop_after_three_in_a_row() {
    let db = TempDb::new("restart-loop");
    die_during_a_turn(&db, "c2").await;
    // Each start continues the turn; the test then marks the continuation as running, as if
    // the process died during it too.
    for round in 1..=4 {
        let (engine, _) = open(&db);
        let runs = projection(&engine, "t1").await["runs"]
            .as_array()
            .unwrap()
            .len();
        if round <= 3 {
            assert_eq!(runs, round + 1, "round {round} adds a continuation");
            let run = format!("run:t1:{}", round + 1);
            let p = run_to_end(&engine, "t1", &run).await;
            assert_eq!(
                p["runs"][round]["restartContinuationOfRunId"],
                format!("run:t1:{round}")
            );
            let inner = engine.inner().clone();
            inner
                .write(move |tx| {
                    let mut r = tx.entity("t1", "runs", &run)?.unwrap();
                    r["status"] = json!("running");
                    tx.append(crate::store::Draft::new("t1", "run.updated", r))
                        .map(|_| ())
                })
                .await
                .unwrap();
        } else {
            assert_eq!(runs, 4, "the fourth restart in a row only cancels");
            let p = projection(&engine, "t1").await;
            assert_eq!(p["runs"][3]["status"], "cancelled");
        }
    }
}

/// T3's "recovers starting work after restart": a user's prompt the provider never took waits
/// at the head of the held queue; the user sends it again.
#[tokio::test(flavor = "current_thread")]
async fn a_restart_holds_an_undelivered_message_for_the_user() {
    let db = TempDb::new("restart-starting");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        // A run the provider never took: written, but its start effect never ran.
        let inner = engine.inner().clone();
        let command = message("t1", "c2", "late");
        inner
            .write(move |tx| {
                let handler = crate::commands::handler("message.dispatch").unwrap();
                handler(tx, command)
                    .map(|_| ())
                    .map_err(|_| "rejected".to_owned())
            })
            .await
            .unwrap();
    }
    let (engine, _) = open(&db);
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][0]["status"], "queued");
    assert_eq!(p["runs"][0]["queueHeld"], true);
    dispatch(
        &engine,
        json!({"type": "queued-run.start", "commandId": "q1", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(p["runs"][0]["status"], "completed");
    assert_eq!(p["messages"][1]["text"], "echo: late");
}

/// A restart during workspace preparation cancels the run, as T3's recovery does
/// (`ProviderRuntimeRecoveryService.test.ts`, "preparing"): its setup died with the process, so
/// the provider never starts in a half-built checkout.
#[tokio::test(flavor = "current_thread")]
async fn a_restart_cancels_an_interrupted_preparation() {
    let db = TempDb::new("restart-preparing");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        let mut send = message("t1", "c2", "work");
        send["dispatchMode"] = json!({"type": "defer_start",
            "workspaceStrategy": {"type": "worktree", "baseRef": "HEAD", "startFromOrigin": false}});
        dispatch(&engine, send).await;
    }
    let (engine, _) = open(&db);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][0]["status"], "cancelled");
    assert!(p["providerThreads"].as_array().unwrap().is_empty());
    let items = p["turnItems"].as_array().unwrap();
    assert!(items.iter().any(|i| i["title"] == "Server restarted"));
    assert!(
        items
            .iter()
            .filter(|i| i["type"] == "command_execution")
            .all(|i| i["status"] == "cancelled")
    );
}

/// A store the pre-merge branch wrote is at version 6 with `message_keys.search_text` and no
/// receipt owners (that branch numbered its search step 5 and had no receipts step). It opens
/// at 5 without the column, gets the receipt columns, and commands and their retries work.
#[tokio::test(flavor = "current_thread")]
async fn a_version_6_store_without_receipt_owners_gets_them() {
    let db = TempDb::new("receipt-owners-v6");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
    }
    {
        let conn = rusqlite::Connection::open(db.path()).unwrap();
        conn.execute_batch(
            "ALTER TABLE receipts DROP COLUMN owner_kind;
             ALTER TABLE receipts DROP COLUMN owner_id;
             ALTER TABLE receipts DROP COLUMN error;
             ALTER TABLE message_keys ADD COLUMN search_text TEXT;
             PRAGMA user_version = 6;",
        )
        .unwrap();
    }
    let (engine, _) = open(&db);
    dispatch(&engine, create("t2", "c2")).await;
    dispatch(&engine, message("t2", "c3", "hello")).await;
    let retried = engine
        .dispatch(from_json(create("t2", "c2")).unwrap())
        .await;
    assert!(retried.is_ok(), "{retried:?}");
    drop(engine);
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    let columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('receipts')
             WHERE name IN ('owner_kind', 'owner_id', 'error')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(columns, 3);
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 5);
    let search_text: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('message_keys') WHERE name = 'search_text'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(search_text, 0);
}

/// An inert rehearsal copy (`recover_runs` off) leaves a run it found active as it was: no
/// provider turn starts, so the copy never repeats the original's work.
#[tokio::test(flavor = "current_thread")]
async fn without_recovery_an_active_run_stays_as_found() {
    let db = TempDb::new("restart-inert");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        let inner = engine.inner().clone();
        let command = message("t1", "c2", "late");
        inner
            .write(move |tx| {
                let handler = crate::commands::handler("message.dispatch").unwrap();
                handler(tx, command)
                    .map(|_| ())
                    .map_err(|_| "rejected".to_owned())
            })
            .await
            .unwrap();
    }
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.providers = vec![provider.clone()];
    config.recover_runs = false;
    let engine = SqliteEngine::open(config).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let p = projection(&engine, "t1").await;
    assert_ne!(p["runs"][0]["status"], "completed");
    assert_ne!(p["runs"][0]["status"], "cancelled");
    assert_eq!(p["messages"].as_array().map(Vec::len), Some(1));
}

#[tokio::test(flavor = "current_thread")]
async fn launch_thread_creates_and_starts_in_one_call() {
    let db = TempDb::new("launch");
    let (engine, _) = open(&db);
    let input = json!({
        "commandId": "launch-1", "threadId": "t9", "projectId": project_id(), "title": "Launched",
        "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "workspaceStrategy": {"type": "root"},
        "initialMessage": {"messageId": "m1", "text": "hi", "attachments": []},
    });
    let result = engine.launch_thread(input.clone()).await.unwrap();
    assert_eq!(result["threadId"], "t9");
    assert_eq!(result["resumed"], false);
    assert_eq!(result["projection"]["messages"][0]["text"], "hi");
    let retry = engine.launch_thread(input.clone()).await.unwrap();
    assert_eq!(retry["resumed"], true);
    assert_eq!(retry["sequence"], result["sequence"]);
    // The replay starts no second turn.
    assert_eq!(user_messages(&retry["projection"]), 1);
    assert_eq!(record_count(&retry["projection"], "runs"), 1);
    let mut moved = input;
    moved["projectId"] = json!("project:other");
    assert_eq!(refusal(&engine, moved).await, "Project identity changed.");

    let missing = engine.get_thread_projection("nope".into()).await;
    assert!(matches!(missing, Err(EngineError::Rejected(_))));
    assert!(
        engine
            .thread_snapshot("nope".into())
            .await
            .unwrap()
            .is_none()
    );
}

/// Pauses the command `command_id` inside its transaction, runs `call` until it gets there,
/// aborts the call (a closed socket aborts its handler), then lets the commit go on.
async fn abort_inside_commit<T: Send + 'static>(
    engine: &SqliteEngine,
    command_id: &str,
    call: impl std::future::Future<Output = T> + Send + 'static,
) {
    let (paused_tx, paused_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    *crate::lock(&engine.inner().commit_pause) = Some(crate::engine::CommitPause {
        command_id: command_id.into(),
        paused: paused_tx,
        release: release_rx,
    });
    let call = tokio::spawn(call);
    tokio::task::spawn_blocking(move || paused_rx.recv_timeout(Duration::from_secs(30)))
        .await
        .unwrap()
        .expect("the commit paused");
    call.abort();
    assert!(call.await.is_err_and(|e| e.is_cancelled()));
    release_tx.send(()).unwrap();
}

/// A closed socket aborts a launch while its first message commits (in the launch's own
/// `thread.create`). The commit goes through, and so does the provider start it holds: exactly
/// one session opens and the run completes.
#[tokio::test(flavor = "current_thread")]
async fn an_aborted_launch_still_starts_its_committed_run() {
    let db = TempDb::new("launch-aborted");
    let (engine, provider) = open(&db);
    let engine = Arc::new(engine);
    let input = json!({
        "commandId": "A", "threadId": "t1", "projectId": project_id(), "title": "Launched",
        "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "workspaceStrategy": {"type": "root"},
        "initialMessage": {"messageId": "m-a", "text": "hi", "attachments": []},
    });
    let launcher = engine.clone();
    abort_inside_commit(
        &engine,
        "A",
        async move { launcher.launch_thread(input).await },
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(run_of(&p, "run:t1:1")["status"], "completed");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

/// The same for a command that is not a launch: an aborted archive still closes the thread
/// on the host, once.
#[tokio::test(flavor = "current_thread")]
async fn an_aborted_archive_still_closes_the_thread() {
    let db = TempDb::new("archive-aborted");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.host = Some(host.clone());
    let engine = Arc::new(SqliteEngine::open(config).unwrap());
    dispatch(&engine, create("t1", "c1")).await;
    let mut shell = engine
        .subscribe_shell(from_json(json!({"requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    next(&mut shell).await;
    next(&mut shell).await;
    let archiver = engine.clone();
    abort_inside_commit(&engine, "a1", async move {
        archiver
            .dispatch(
                from_json(json!({"type": "thread.archive", "commandId": "a1", "threadId": "t1"}))
                    .unwrap(),
            )
            .await
    })
    .await;
    // The commit publishes itself: a connected client sees the archive without the caller.
    let row = next(&mut shell).await;
    assert_eq!(row["kind"], "thread.updated");
    assert_eq!(row["location"], "archive");
    tokio::time::timeout(Duration::from_secs(5), async {
        while host.closed.lock().unwrap().is_empty() {
            host.closed_event.notified().await;
        }
    })
    .await
    .expect("the host hears of the archive");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        *host.closed.lock().unwrap(),
        [("t1".to_owned(), crate::ThreadClose::Archived)]
    );
}

/// Archives `t1` and stops its `thread.closed` effect after it ran, before its settlement.
/// Returns the release.
async fn archive_up_to_settlement(engine: &SqliteEngine) -> tokio::sync::oneshot::Sender<()> {
    let (paused_tx, paused_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    crate::lock(&engine.inner().worker_hooks).settle_pause =
        Some(("thread.closed", paused_tx, release_rx));
    dispatch(
        engine,
        json!({"type": "thread.archive", "commandId": "a1", "threadId": "t1"}),
    )
    .await;
    timeout(Duration::from_secs(5), paused_rx)
        .await
        .expect("the archive effect ran")
        .unwrap();
    release_tx
}

/// The status of the thread's `thread.closed` row.
async fn archive_row(engine: &SqliteEngine) -> (String, Option<String>) {
    engine
        .inner()
        .db(|store| {
            store.raw().query_row(
                "SELECT status, last_error FROM effect_outbox WHERE effect_type = 'thread.closed'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .await
        .unwrap()
}

/// T3's "terminalizes a process-bound claim when success settlement fails"
/// (`EffectWorker.test.ts`), and the gate's probe: a settlement write that fails once must not
/// hold the thread. The row ends `failed`, the effect does not run again, and the thread's next
/// turn starts.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_settlement_frees_the_thread_without_running_the_effect_again() {
    // One failed write, and (the second gate's probe) two in a row.
    for faults in [1, 2] {
        let db = TempDb::new(&format!("settle-fault-{faults}"));
        let host = Arc::new(RecordingHost::default());
        let mut config = EngineConfig::new(db.path());
        config.projects = vec![ProjectConfig {
            title: "Project".into(),
            workspace_root: ROOT.into(),
        }];
        config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
        config.host = Some(host.clone());
        let engine = SqliteEngine::open(config).unwrap();
        dispatch(&engine, create("t1", "c1")).await;
        let release = archive_up_to_settlement(&engine).await;
        engine
            .inner()
            .db(move |store| store.settle_faults.set(faults))
            .await;
        release.send(()).unwrap();
        dispatch(&engine, message("t1", "c2", "after")).await;
        let p = run_to_end(&engine, "t1", "run:t1:1").await;
        assert_eq!(run_of(&p, "run:t1:1")["status"], "completed");
        let (status, error) = archive_row(&engine).await;
        assert_eq!(status, "failed");
        let error = error.unwrap();
        assert!(error.contains("after execution started"), "{error}");
        assert!(error.contains("injected settlement fault"), "{error}");
        assert_eq!(host.closed.lock().unwrap().len(), 1, "the effect ran once");
    }
}

/// The round-3 gate's probe: a settlement that keeps failing (here every write fails) stops
/// trying once another engine took the store, even though this engine was never dropped.
#[tokio::test(flavor = "current_thread")]
async fn a_settlement_stops_retrying_once_another_engine_owns_the_store() {
    let db = TempDb::new("settle-owner-changed");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let release = archive_up_to_settlement(&engine).await;
    engine
        .inner()
        .db(|store| store.settle_faults.set(u32::MAX))
        .await;
    rusqlite::Connection::open(db.path())
        .unwrap()
        .execute(
            "UPDATE meta SET value = value + 1 WHERE key = 'engine_epoch'",
            [],
        )
        .unwrap();
    release.send(()).unwrap();
    let faults = || engine.inner().db(|store| store.settle_faults.get());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let first = faults().await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        faults().await,
        first,
        "no settlement after the owner changed"
    );
}

/// T3's "keeps requeueing a failed claim while the database is locked" (`retryWhileLocked`),
/// and the second gate's probe: another connection holds the write lock while the worker
/// settles. The settlement waits for the lock, then the row succeeds and the next turn starts.
#[tokio::test(flavor = "current_thread")]
async fn a_settlement_waits_out_a_locked_store() {
    let db = TempDb::new("settle-locked");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let release = archive_up_to_settlement(&engine).await;
    engine
        .inner()
        .db(|store| store.raw().busy_timeout(Duration::from_millis(1)))
        .await
        .unwrap();
    let locker = rusqlite::Connection::open(db.path()).unwrap();
    locker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (busy_tx, busy_rx) = tokio::sync::oneshot::channel();
    crate::lock(&engine.inner().worker_hooks).settle_busy = Some(busy_tx);
    release.send(()).unwrap();
    timeout(Duration::from_secs(5), busy_rx)
        .await
        .expect("the settlement met the lock")
        .unwrap();
    locker.execute_batch("COMMIT").unwrap();
    engine
        .inner()
        .db(|store| store.raw().busy_timeout(Duration::from_secs(5)))
        .await
        .unwrap();
    dispatch(&engine, message("t1", "c2", "after")).await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(run_of(&p, "run:t1:1")["status"], "completed");
    assert_eq!(archive_row(&engine).await, ("succeeded".to_owned(), None));
    assert_eq!(host.closed.lock().unwrap().len(), 1, "the effect ran once");
}

/// Beside T3's "prunes settled effects past retention in batches and keeps the rest"
/// (`outbox/tests.rs`): the prune lets the store go between batches, so a read that comes
/// while it prunes runs before the last batch.
#[tokio::test(flavor = "current_thread")]
async fn a_read_gets_in_between_prune_batches() {
    let db = TempDb::new("prune-batches");
    let clock = Arc::new(crate::ManualClock::at(1_000_000_000_000));
    let mut config = EngineConfig::new(db.path());
    config.clock = clock.clone();
    // Opened off the runtime, so no worker or prune loop of its own runs beside this one.
    let engine = std::thread::spawn(move || SqliteEngine::open(config).unwrap())
        .join()
        .unwrap();
    let inner = engine.inner().clone();
    let total = 2 * crate::outbox::PRUNE_BATCH + 200;
    let count = || {
        inner.db(|store| {
            store
                .raw()
                .query_row("SELECT COUNT(*) FROM effect_outbox", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap() as usize
        })
    };
    let settled_at = conn_support::time::iso_from_ms(crate::Clock::now_millis(clock.as_ref()));
    inner
        .db(move |store| {
            store.raw().execute(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
                 INSERT INTO effect_outbox (thread_id, lane, effect_type, payload, status,
                   created_at, updated_at, completed_at)
                 SELECT 't', 'thread', 'thread.closed', '{}', 'succeeded', ?2, ?2, ?2 FROM n",
                rusqlite::params![total as i64, settled_at],
            )
        })
        .await
        .unwrap();
    // The rows age past retention.
    clock.advance(Duration::from_millis(
        crate::outbox::SETTLED_RETENTION_MS + 60_000,
    ));
    let (paused_tx, paused_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    crate::lock(&inner.worker_hooks).prune_pause = Some((paused_tx, release_rx));
    let prune = tokio::spawn({
        let inner = inner.clone();
        async move { inner.prune_settled_effects().await }
    });
    timeout(Duration::from_secs(5), paused_rx)
        .await
        .expect("the prune paused between batches")
        .unwrap();
    assert_eq!(count().await, total - crate::outbox::PRUNE_BATCH);
    release_tx.send(()).unwrap();
    assert_eq!(prune.await.unwrap().unwrap(), total);
    assert_eq!(count().await, 0);
}

/// The gate's probe: opening the engine reads and migrates the store, and waits on its write
/// lock. On the server's one runtime thread that blocks every task, so the open runs on the
/// blocking pool: another task keeps running while it waits.
#[tokio::test(flavor = "current_thread")]
async fn opening_the_engine_does_not_block_the_runtime() {
    let db = TempDb::new("open-blocking");
    drop(SqliteEngine::open(EngineConfig::new(db.path())).unwrap());
    let locker = rusqlite::Connection::open(db.path()).unwrap();
    locker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let ticks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ticker = tokio::spawn({
        let ticks = ticks.clone();
        async move {
            loop {
                ticks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    });
    let unlock = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        locker.execute_batch("COMMIT").unwrap();
    });
    let before = ticks.load(std::sync::atomic::Ordering::SeqCst);
    let engine = SqliteEngine::start(EngineConfig::new(db.path()))
        .await
        .unwrap();
    let during = ticks.load(std::sync::atomic::Ordering::SeqCst) - before;
    unlock.join().unwrap();
    ticker.abort();
    drop(engine);
    assert!(
        during >= 5,
        "the runtime ran {during} ticks while the engine opened"
    );
}

/// The round-3 gate's probe: a start the server gave up on (its future dropped) still runs on
/// the blocking pool. When it gets to the lease after a newer engine opened, it must not take
/// the store from that engine.
#[tokio::test(flavor = "current_thread")]
async fn an_abandoned_start_never_takes_the_lease_of_a_newer_engine() {
    let db = TempDb::new("abandoned-start");
    drop(open(&db));
    let (paused_tx, paused_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let mut config = EngineConfig::new(db.path());
    config.open_pause = Some(crate::engine::OpenPause {
        paused: paused_tx,
        release: release_rx,
        finished: finished_tx,
    });
    let abandoned = tokio::spawn(SqliteEngine::start(config));
    tokio::task::spawn_blocking(move || paused_rx.recv())
        .await
        .unwrap()
        .unwrap();
    abandoned.abort();
    assert!(abandoned.await.is_err_and(|e| e.is_cancelled()));
    let (engine, _) = open(&db);
    release_tx.send(()).unwrap();
    tokio::task::spawn_blocking(move || finished_rx.recv())
        .await
        .unwrap()
        .unwrap();
    // The newer engine still owns the store: its commands commit.
    dispatch(&engine, create("t1", "c1")).await;
}

/// One engine per store: a second open while the first lives gets "store in use" and changes
/// nothing; the first goes on as before.
#[tokio::test(flavor = "current_thread")]
async fn a_second_engine_on_a_live_store_is_refused() {
    let db = TempDb::new("store-lock");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let epoch = || -> i64 {
        rusqlite::Connection::open(db.path())
            .unwrap()
            .query_row(
                "SELECT value FROM meta WHERE key = 'engine_epoch'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    let before = (epoch(), engine.test_events("t1").await.len());
    let Err(error) = SqliteEngine::start(EngineConfig::new(db.path())).await else {
        panic!("a second engine opened the store");
    };
    assert_eq!(error, crate::STORE_IN_USE);
    assert_eq!((epoch(), engine.test_events("t1").await.len()), before);
    dispatch(&engine, message("t1", "c2", "still here")).await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(run_of(&p, "run:t1:1")["status"], "completed");
}

/// The lock follows the database file, not its spelling: an open through a symlink to a live
/// store, and the reverse, is refused and leaves the live engine's lease alone.
#[tokio::test(flavor = "current_thread")]
async fn a_store_opened_through_a_symlink_is_refused() {
    let db = TempDb::new("store-lock-symlink");
    let link = db.0.join("link.sqlite");
    std::os::unix::fs::symlink(db.path(), &link).unwrap();
    let epoch = || -> i64 {
        rusqlite::Connection::open(db.path())
            .unwrap()
            .query_row(
                "SELECT value FROM meta WHERE key = 'engine_epoch'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    // The first open creates the file: its lock must already be the one the target takes.
    for (first, second) in [(link.clone(), db.path()), (db.path(), link.clone())] {
        let engine = SqliteEngine::open(EngineConfig::new(&first)).unwrap();
        let before = epoch();
        let Err(error) = SqliteEngine::start(EngineConfig::new(&second)).await else {
            panic!(
                "{} opened the store {} holds",
                second.display(),
                first.display()
            );
        };
        assert_eq!(error, crate::STORE_IN_USE);
        assert_eq!(epoch(), before);
        drop(engine);
        std::fs::remove_file(db.path()).unwrap();
    }
}

/// Once the engine is dropped, its store opens again, and the new engine recovers what the
/// first left: its cut turn is continued.
#[tokio::test(flavor = "current_thread")]
async fn a_store_opens_again_after_its_engine_drops_and_recovers() {
    let db = TempDb::new("store-lock-reopen");
    die_during_a_turn(&db, "c2").await;
    let (engine, _) = open(&db);
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(run_of(&p, "run:t1:1")["status"], "cancelled");
    assert_eq!(run_of(&p, "run:t1:2")["status"], "completed");
}

/// A row a previous process left running does not hold its thread after a restart: the start
/// cancels it, and the next command's effects run.
#[tokio::test(flavor = "current_thread")]
async fn a_row_left_running_does_not_hold_its_thread_after_a_restart() {
    let db = TempDb::new("outbox-restart");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        engine.test_hold_lane("t1").await;
    }
    let (engine, _) = open(&db);
    dispatch(&engine, message("t1", "c2", "after")).await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(run_of(&p, "run:t1:1")["status"], "completed");
}

/// A title generator that answers only when the test lets it.
#[derive(Default)]
struct HeldTitles {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl crate::TitleGenerator for HeldTitles {
    fn generate(&self, _: crate::TitleRequest) -> crate::BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            Ok("Held title".to_owned())
        })
    }
}

fn title_config(db: &TempDb, titles: Option<Arc<HeldTitles>>) -> EngineConfig {
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    // The engine that holds a title is the one the test drops: its idle sessions close soon,
    // so its tasks end and the test can wait for them. The next engine keeps the default.
    if titles.is_some() {
        config.idle_session = Some(Duration::from_millis(20));
    }
    config.title_generator = titles.map(|t| t as Arc<dyn crate::TitleGenerator>);
    config
}

/// Creates thread `t1` and asks for a title, which the held generator now holds. Returns a
/// handle on the engine's state that lives as long as one of its tasks.
async fn hold_a_title(
    engine: &SqliteEngine,
    titles: &HeldTitles,
) -> std::sync::Weak<crate::engine::Inner> {
    dispatch(engine, create("t1", "c1")).await;
    dispatch(engine, message("t1", "c2", "fonts")).await;
    run_to_end(engine, "t1", "run:t1:1").await;
    dispatch(
        engine,
        json!({"type": "thread.metadata.update", "commandId": "r1", "threadId": "t1", "regenerateTitle": true}),
    )
    .await;
    timeout(Duration::from_secs(5), titles.entered.notified())
        .await
        .expect("the title effect runs");
    Arc::downgrade(engine.inner())
}

/// The thread's title events, oldest first.
async fn title_events(engine: &SqliteEngine) -> Vec<(String, Value)> {
    let mut events = engine.test_events("t1").await;
    events.retain(|(kind, _)| kind.contains("title"));
    events
}

/// Waits until no task of a dropped engine is left.
async fn old_tasks_end(old: std::sync::Weak<crate::engine::Inner>) {
    timeout(Duration::from_secs(5), async {
        while old.strong_count() > 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the dropped engine's tasks end");
}

/// A dropped engine's running effect never writes, even with no newer engine on the store.
#[tokio::test(flavor = "current_thread")]
async fn a_dropped_engine_s_running_effect_writes_nothing() {
    let db = TempDb::new("fence-drop");
    let titles = Arc::new(HeldTitles::default());
    let engine = SqliteEngine::open(title_config(&db, Some(titles.clone()))).unwrap();
    let old = hold_a_title(&engine, &titles).await;
    let before = title_events(&engine).await;
    drop(engine);
    titles.release.notify_one();
    old_tasks_end(old).await;
    let engine = SqliteEngine::open(title_config(&db, None)).unwrap();
    assert_eq!(title_events(&engine).await, before);
    assert_eq!(
        projection(&engine, "t1").await["thread"]["title"],
        "New thread"
    );
}

/// T3's "does not reclaim a running effect after its process-local lease expires", for a
/// newer engine, and the gate's probe: an engine replaced while its effect runs must not write
/// into the new engine's store. Before the fence, the old task committed its title with a stale sequence
/// and the new engine's next command failed on `events.seq`.
#[tokio::test(flavor = "current_thread")]
async fn a_replaced_engine_s_running_effect_writes_nothing() {
    let db = TempDb::new("fence-replace");
    let titles = Arc::new(HeldTitles::default());
    let engine = SqliteEngine::open(title_config(&db, Some(titles.clone()))).unwrap();
    let old = hold_a_title(&engine, &titles).await;
    drop(engine);
    let engine = SqliteEngine::open(title_config(&db, None)).unwrap();
    titles.release.notify_one();
    old_tasks_end(old).await;
    dispatch(&engine, message("t1", "c3", "after")).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "completed");
    assert_eq!(p["thread"]["title"], "New thread");
}

/// Commits `command` and its effects as one write, then marks rows of `running_type` as
/// running: what a process that stopped mid-effect leaves behind.
async fn commit_left_running(engine: &SqliteEngine, command: Value, running_type: &'static str) {
    engine
        .inner()
        .db(move |store| {
            let mut tx = store.tx().unwrap();
            let handler = crate::commands::handler(command["type"].as_str().unwrap()).unwrap();
            let Ok(effects) = handler(&mut tx, command) else {
                panic!("command rejected");
            };
            tx.enqueue(None, &effects).unwrap();
            tx.commit(None).unwrap();
            store
                .raw()
                .execute(
                    "UPDATE effect_outbox SET status = 'running' WHERE effect_type = ?1",
                    [running_type],
                )
                .unwrap();
        })
        .await;
}

/// The statuses of `effect_type`'s rows once none is running or pending (up to 5 s).
async fn settled_statuses(db: &TempDb, effect_type: &str) -> Vec<String> {
    for _ in 0..250 {
        let statuses = outbox_statuses(db, effect_type);
        if statuses.iter().all(|s| s != "running" && s != "pending") {
            return statuses;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    outbox_statuses(db, effect_type)
}

fn outbox_statuses(db: &TempDb, effect_type: &str) -> Vec<String> {
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    let mut stmt = conn
        .prepare("SELECT status FROM effect_outbox WHERE effect_type = ?1 ORDER BY id")
        .unwrap();
    stmt.query_map([effect_type], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// Process loss, replay-safe: an archive's host close that a stopped process was running runs
/// again after the restart, once. An inert copy (`recover_runs` off) cancels it instead.
#[tokio::test(flavor = "current_thread")]
async fn a_replay_safe_effect_runs_again_after_a_restart() {
    for recover in [true, false] {
        let db = TempDb::new(&format!("outbox-loss-safe-{recover}"));
        {
            let (engine, _) = open(&db);
            dispatch(&engine, create("t1", "c1")).await;
            commit_left_running(
                &engine,
                json!({"type": "thread.archive", "commandId": "a1", "threadId": "t1"}),
                "thread.closed",
            )
            .await;
        }
        let host = Arc::new(RecordingHost::default());
        let mut config = EngineConfig::new(db.path());
        config.host = Some(host.clone());
        config.recover_runs = recover;
        let _engine = SqliteEngine::open(config).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let heard = host.closed.lock().unwrap().clone();
        if recover {
            assert_eq!(heard, [("t1".to_owned(), crate::ThreadClose::Archived)]);
            assert_eq!(settled_statuses(&db, "thread.closed").await, ["succeeded"]);
        } else {
            assert!(heard.is_empty(), "{heard:?}");
            assert_eq!(outbox_statuses(&db, "thread.closed"), ["cancelled"]);
        }
    }
}

/// One case of T3's "recovers $0 work after restart" (`ProviderRuntimeRecoveryService.test.ts`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum LostStart {
    /// A user's prompt whose start the process was running (`starting`).
    Starting,
    /// A user's prompt marked `running`, its start not returned: Codex may hold it already.
    Running,
    /// As `Running`, with the provider turn our Claude adapter reports before a cold host has
    /// the prompt.
    RunningEarlyTurn,
    /// A scheduled task's prompt (`starting-scheduled`).
    Scheduled,
    /// An MCP agent's prompt (`running-delegated`).
    Mcp,
    /// The same, sent again 3 times already (`running-delegated-capped`).
    McpCapped,
    /// The same, on a snoozed thread (`running-delegated-snoozed`).
    McpSnoozed,
    /// The same, on a thread archived before the stop (the gate's probe).
    McpArchived,
    /// A user's prompt on a thread archived before the stop (the gate's probe).
    UserArchived,
    /// The #268 gate's probe: Codex confirmed the turn (`turn/started`, a strong native turn
    /// ref) before the worker settled the start row.
    RunningConfirmedTurn,
    /// The #268 gate's probe: a continuation an earlier restart admitted, cut off before its
    /// start (`RestartContinuation.test.ts`).
    Continuation,
    /// The #268 gate's probe: an MCP prompt whose run has a stored Stop.
    McpStopped,
    /// The #268 gate's probe: as `RunningEarlyTurn`, in a store from before the outbox (no
    /// start rows): the weak turn still proves nothing.
    LegacyEarlyTurn,
}

/// Leaves `run:t1:1` as a process that died during its start leaves it: the message and run
/// committed, the start row running.
async fn leave_lost_start(engine: &SqliteEngine, case: LostStart) {
    dispatch(engine, create("t1", "c1")).await;
    let mut command = message("t1", "c2", "late");
    match case {
        LostStart::Scheduled => command["scheduledTaskId"] = json!("task:1"),
        LostStart::Mcp
        | LostStart::McpCapped
        | LostStart::McpSnoozed
        | LostStart::McpArchived
        | LostStart::McpStopped => {
            command["createdBy"] = json!("agent");
            command["creationSource"] = json!("mcp");
        }
        LostStart::Continuation => {
            command["createdBy"] = json!("agent");
            command["creationSource"] = json!("server");
            command["restartContinuationOfRunId"] = json!("run:t1:0");
        }
        _ => {}
    }
    if case == LostStart::McpSnoozed {
        dispatch(
            engine,
            json!({"type": "thread.snooze", "commandId": "s1", "threadId": "t1",
                   "snoozedUntil": "2999-01-01T00:00:00.000Z"}),
        )
        .await;
    }
    let running = !matches!(case, LostStart::Starting | LostStart::Scheduled);
    let early_turn = matches!(
        case,
        LostStart::RunningEarlyTurn | LostStart::RunningConfirmedTurn | LostStart::LegacyEarlyTurn
    );
    let strength = if case == LostStart::RunningConfirmedTurn {
        json!({"driver": "codex", "nativeId": "turn-1", "strength": "strong"})
    } else {
        Value::Null
    };
    let stopped = case == LostStart::McpStopped;
    let capabilities = to_json(
        &conn_provider::Provider::capabilities(&FakeProvider::new("claudeAgent"))
            .await
            .unwrap(),
    );
    let archived = matches!(case, LostStart::McpArchived | LostStart::UserArchived);
    engine
        .inner()
        .db(move |store| {
            let mut tx = store.tx().unwrap();
            let handler = crate::commands::handler("message.dispatch").unwrap();
            let Ok(effects) = handler(&mut tx, command) else {
                panic!("rejected")
            };
            tx.enqueue(Some("c2"), &effects).unwrap();
            if running {
                // What the start writes before it calls the provider.
                let attempt = "run:t1:1:attempt:1";
                let now = tx.now().to_owned();
                tx.append(
                    crate::store::Draft::new(
                        "t1",
                        "run-attempt.created",
                        json!({"id": attempt, "runId": "run:t1:1", "attemptOrdinal": 1,
                               "rootNodeId": "node:run:t1:1:root",
                               "providerInstanceId": "claudeAgent",
                               "providerThreadId": "provider-thread:t1", "providerTurnId": null,
                               "reason": "initial", "status": "running", "startedAt": now,
                               "completedAt": null}),
                    )
                    .run(Some("run:t1:1")),
                )
                .unwrap();
                if early_turn {
                    tx.append(
                        crate::store::Draft::new(
                            "t1",
                            "provider-turn.updated",
                            json!({"id": "turn:run:t1:1", "providerThreadId": "provider-thread:t1",
                                   "runAttemptId": attempt, "nodeId": "node:run:t1:1:root",
                                   "ordinal": 1, "nativeTurnRef": strength, "status": "running",
                                   "startedAt": now, "completedAt": null}),
                        )
                        .run(Some("run:t1:1")),
                    )
                    .unwrap();
                }
                let mut run = tx.entity("t1", "runs", "run:t1:1").unwrap().unwrap();
                run["status"] = json!("running");
                run["startedAt"] = json!(now);
                run["activeAttemptId"] = json!(attempt);
                tx.append(crate::store::Draft::new("t1", "run.updated", run).run(Some("run:t1:1")))
                    .unwrap();
                // The previous process's session, which died with it.
                tx.append(crate::store::Draft::new(
                    "t1",
                    "provider-session.updated",
                    json!({"id": "provider-session:t1:run:t1:1", "status": "ready",
                           "driver": "claudeAgent", "providerInstanceId": "claudeAgent",
                           "capabilities": capabilities, "cwd": ROOT, "model": null,
                           "lastError": null, "createdAt": now, "updatedAt": now}),
                ))
                .unwrap();
            }
            if stopped {
                let now = tx.now().to_owned();
                tx.append(
                    crate::store::Draft::new(
                        "t1",
                        "turn-item.updated",
                        json!({"id": "turn-item:run:t1:1:interrupt-request", "threadId": "t1",
                               "runId": "run:t1:1", "type": "run_interrupt_request",
                               "status": "completed", "startedAt": now, "updatedAt": now}),
                    )
                    .run(Some("run:t1:1")),
                )
                .unwrap();
            }
            tx.commit(None).unwrap();
            store
                .raw()
                .execute(
                    "UPDATE effect_outbox SET status = 'running', attempt_count = 1
                     WHERE effect_type = 'provider-turn.start'",
                    [],
                )
                .unwrap();
            if case == LostStart::LegacyEarlyTurn {
                store
                    .raw()
                    .execute(
                        "DELETE FROM effect_outbox WHERE effect_type = 'provider-turn.start'",
                        [],
                    )
                    .unwrap();
            }
            if case == LostStart::McpCapped {
                for _ in 0..3 {
                    store
                        .raw()
                        .execute(
                            "INSERT INTO effect_outbox (command_id, thread_id, lane, effect_type,
                               payload, status, attempt_count, created_at, updated_at)
                             VALUES ('command:restart-resend:run:t1:1', 't1', 'thread',
                               'provider-turn.start',
                               '{\"type\":\"provider-turn.start\",\"threadId\":\"t1\",\"runId\":\"run:t1:1\"}',
                               'cancelled', 1, '', '')",
                            [],
                        )
                        .unwrap();
                }
            }
        })
        .await;
    // Archived while its start was cut off (the gate's probe).
    if archived {
        dispatch(
            engine,
            json!({"type": "thread.archive", "commandId": "a1", "threadId": "t1"}),
        )
        .await;
    }
}

/// T3's "recovers $0 work after restart", and the gate's probes. A prompt the provider never
/// accepted is not sent again on its own: a user's prompt waits at the head of the held queue
/// (Codex may have it already, and an archived thread must not get it). Unattended work is sent
/// again, at most 3 times, and never to a resting thread. A provider turn alone is no proof: our
/// Claude adapter reports one before a cold host has the prompt.
#[tokio::test(flavor = "current_thread")]
async fn a_prompt_the_provider_never_accepted_is_held_resent_or_cancelled() {
    use LostStart::*;
    for case in [
        Starting,
        Running,
        RunningEarlyTurn,
        Scheduled,
        Mcp,
        McpCapped,
        McpSnoozed,
        McpArchived,
        UserArchived,
        RunningConfirmedTurn,
        Continuation,
        McpStopped,
        LegacyEarlyTurn,
    ] {
        let db = TempDb::new(&format!("lost-start-{case:?}"));
        {
            let (engine, _) = open(&db);
            leave_lost_start(&engine, case).await;
        }
        let (engine, provider) = open(&db);
        let starts = || {
            crate::lock(&provider.calls)
                .iter()
                .filter(|c| c.as_str() == "start run:t1:1")
                .count()
        };
        let p = match case {
            Scheduled | Mcp | Continuation => run_to_end(&engine, "t1", "run:t1:1").await,
            _ => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                projection(&engine, "t1").await
            }
        };
        let run = run_of(&p, "run:t1:1");
        match case {
            Starting | Running | RunningEarlyTurn | LegacyEarlyTurn | UserArchived => {
                assert_eq!(starts(), 0, "{case:?}: not sent again");
                assert_eq!(run["status"], "queued", "{case:?}");
                assert_eq!(run["queueHeld"], true, "{case:?}");
                assert_eq!(run["queuePosition"], 1, "{case:?}");
                if case != Starting && case != UserArchived {
                    let attempt = &p["attempts"][0];
                    assert_eq!(attempt["status"], "pending", "{case:?}");
                }
                assert_eq!(
                    p["runs"].as_array().map(Vec::len),
                    Some(1),
                    "{case:?}: no continuation"
                );
                if case != Starting && case != UserArchived {
                    let sessions = p["providerSessions"].as_array().unwrap();
                    assert!(
                        sessions.iter().all(|s| s["status"] == "stopped"),
                        "{case:?}: the dead session is stopped: {sessions:?}"
                    );
                }
            }
            Scheduled | Mcp | Continuation => {
                assert_eq!(starts(), 1, "{case:?}: sent again once");
                assert_eq!(run["status"], "completed", "{case:?}");
            }
            McpCapped | McpSnoozed | McpArchived | McpStopped | RunningConfirmedTurn => {
                assert_eq!(starts(), 0, "{case:?}");
                assert_eq!(run["status"], "cancelled", "{case:?}");
                assert_eq!(
                    p["runs"].as_array().map(Vec::len),
                    Some(1),
                    "{case:?}: no continuation"
                );
            }
        }
    }
}

/// The #268 gate's probe: a project opted out of continuing after a restart. The cut run A is
/// cancelled, and the user prompt B queued behind it waits in the held queue (T3's
/// `reconcileProjection`); it does not start on its own.
#[tokio::test(flavor = "current_thread")]
async fn an_opted_out_restart_holds_the_queued_prompt() {
    let db = TempDb::new("restart-opt-out-queued");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .unwrap();
        next(&mut thread).await;
        dispatch(&engine, message("t1", "c2", "hang")).await;
        until_provider_turn(&mut thread).await;
        settled_statuses(&db, "provider-turn.start").await;
        dispatch(&engine, message("t1", "c3", "after")).await;
        let p = projection(&engine, "t1").await;
        assert_eq!(run_of(&p, "run:t1:2")["status"], "queued");
    }
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    config.providers = vec![provider.clone()];
    config.restart_policy = crate::RestartPolicy {
        continue_by_default: true,
        projects: [(project_id(), false)].into(),
    };
    let engine = SqliteEngine::open(config).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:1")["status"], "cancelled");
    assert_eq!(run_of(&p, "run:t1:2")["status"], "queued");
    assert_eq!(run_of(&p, "run:t1:2")["queueHeld"], true);
    assert!(
        crate::lock(&provider.calls)
            .iter()
            .all(|c| c != "start run:t1:2")
    );
}

/// The #268 gate's probe: a close's host cleanup (a deleted thread's scheduled tasks) ends
/// before its row settles, so a close replayed at start does not settle with it undone.
#[tokio::test(flavor = "current_thread")]
async fn a_close_settles_after_its_host_cleanup() {
    let db = TempDb::new("close-awaits-host");
    let host = Arc::new(RecordingHost::default());
    let (release, hold) = tokio::sync::oneshot::channel();
    *crate::lock(&host.close_hold) = Some(hold);
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "a1", "threadId": "t1"}),
    )
    .await;
    timeout(Duration::from_secs(5), host.closed_event.notified())
        .await
        .expect("the host hears of the close");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(outbox_statuses(&db, "thread.closed"), ["running"]);
    release.send(()).unwrap();
    assert_eq!(settled_statuses(&db, "thread.closed").await, ["succeeded"]);
}

/// The gate's probe: a child's checkpoint capture runs again after a restart (replay-safe),
/// after its first run already wrote the child's end and the parent's wake. The parent is woken
/// once.
#[tokio::test(flavor = "current_thread")]
async fn a_replayed_capture_wakes_the_parent_once() {
    let db = TempDb::new("capture-replay-wake");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, delegate("d1", "look around", Some("always"))).await;
    let child = "thread:delegated-task:d1";
    let child_run = format!("run:{child}:1");
    run_to_end(&engine, child, &child_run).await;
    let wakes = |p: &Value| {
        p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| {
                m["text"]
                    .as_str()
                    .is_some_and(|t| t.starts_with("Delegated task"))
            })
            .count()
    };
    assert_eq!(wakes(&projection(&engine, "t1").await), 1);
    engine
        .inner()
        .clone()
        .capture_run(child.to_owned(), child_run)
        .await;
    assert_eq!(wakes(&projection(&engine, "t1").await), 1);
}

/// The gate's probe: an engine opened with `hold_effects` runs no effect, also not one a
/// restart replays, until the server's host services are up (`start_effects`).
#[tokio::test(flavor = "current_thread")]
async fn held_effects_wait_for_the_host() {
    let db = TempDb::new("hold-effects");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        commit_left_running(
            &engine,
            json!({"type": "thread.archive", "commandId": "a1", "threadId": "t1"}),
            "thread.closed",
        )
        .await;
    }
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.host = Some(host.clone());
    config.hold_effects = true;
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t2", "c2")).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(host.closed.lock().unwrap().is_empty());
    assert_eq!(outbox_statuses(&db, "thread.closed"), ["pending"]);
    engine.start_effects();
    assert_eq!(settled_statuses(&db, "thread.closed").await, ["succeeded"]);
    assert_eq!(
        *host.closed.lock().unwrap(),
        [("t1".to_owned(), crate::ThreadClose::Archived)]
    );
}

/// The gate's probe: rollback 1, then a session detach 2, both left by a stopped process. The
/// rollback keeps its place in the lane, ahead of the detach; a restart does not move it to the
/// end.
#[tokio::test(flavor = "current_thread")]
async fn a_restart_keeps_a_rollback_ahead_of_later_work() {
    let db = TempDb::new("rollback-lane-order");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        engine
            .inner()
            .db(|store| {
                let mut tx = store.tx().unwrap();
                let rollback = crate::rollback::RollbackRequest {
                    thread_id: "t1".into(),
                    command_id: "rb-1".into(),
                    provider_thread_id: "provider-thread:t1".into(),
                    checkpoint_id: "k".into(),
                    scope_id: "s".into(),
                    restore_files: Some(false),
                    resume_snapshot: None,
                };
                tx.enqueue(Some("rb-1"), &[crate::commands::Effect::Rollback(rollback)])
                    .unwrap();
                tx.enqueue(
                    Some("d-2"),
                    &[crate::commands::Effect::CloseSession {
                        thread_id: "t1".into(),
                    }],
                )
                .unwrap();
                tx.commit(None).unwrap();
                assert!(
                    store
                        .advance_rollback(
                            "t1",
                            "rb-1",
                            "admitted",
                            "provider_done",
                            Some(&json!({"id": "provider-thread:t1"})),
                        )
                        .unwrap()
                );
                store
                    .raw()
                    .execute(
                        "UPDATE effect_outbox SET status = 'running'
                         WHERE effect_type = 'provider-thread.rollback'",
                        [],
                    )
                    .unwrap();
            })
            .await;
    }
    let mut config = EngineConfig::new(db.path());
    config.hold_effects = true;
    let engine = SqliteEngine::open(config).unwrap();
    let rows: Vec<(String, String, Option<String>)> = engine
        .inner()
        .db(|store| {
            let mut stmt = store
                .raw()
                .prepare(
                    "SELECT effect_type, status, json_extract(progress, '$.snapshot.id')
                     FROM effect_outbox WHERE thread_id = 't1' AND status IN ('pending', 'running')
                     ORDER BY id",
                )
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        })
        .await;
    assert_eq!(
        rows,
        [
            (
                "provider-thread.rollback".to_owned(),
                "pending".to_owned(),
                Some("provider-thread:t1".to_owned())
            ),
            (
                "provider-session.detach".to_owned(),
                "pending".to_owned(),
                None
            ),
        ]
    );
}

/// An engine on `db` whose worker waits (`hold_effects`), so a test sees what recovery wrote.
fn open_held(db: &TempDb) -> SqliteEngine {
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.hold_effects = true;
    SqliteEngine::open(config).unwrap()
}

/// The #268 gate's probe: a continuation sent again keeps its run id. Cut off by crash after
/// crash, it stops at the chain limit instead of being sent forever.
#[tokio::test(flavor = "current_thread")]
async fn a_continuation_cut_off_again_and_again_stops_at_the_chain_limit() {
    let db = TempDb::new("continuation-crash-loop");
    {
        let (engine, _) = open(&db);
        leave_lost_start(&engine, LostStart::Continuation).await;
    }
    for round in 1..=4 {
        let engine = open_held(&db);
        let p = projection(&engine, "t1").await;
        let run = run_of(&p, "run:t1:1");
        if round <= 3 {
            assert_eq!(run["status"], "starting", "round {round}: sent again");
            // The worker claimed the resend; the process died again before it settled.
            engine
                .inner()
                .db(|store| {
                    store
                        .raw()
                        .execute(
                            "UPDATE effect_outbox SET status = 'running', attempt_count = 1
                             WHERE command_id = 'command:restart-resend:run:t1:1'
                               AND status = 'pending'",
                            [],
                        )
                        .unwrap()
                })
                .await;
        } else {
            assert_eq!(run["status"], "cancelled", "round {round}: the chain ends");
        }
    }
}

/// The #268 gate's probe: Stop committed after the provider took the prompt, and the process
/// died before the provider heard of it. The restart does not continue the run.
#[tokio::test(flavor = "current_thread")]
async fn a_stopped_run_is_not_continued_after_a_restart() {
    let db = TempDb::new("restart-after-stop");
    die_during_a_turn(&db, "c2").await;
    {
        // An inert copy reads the store as it is, to write the stored Stop.
        let mut config = EngineConfig::new(db.path());
        config.recover_runs = false;
        let engine = SqliteEngine::open(config).unwrap();
        engine
            .inner()
            .write(|tx| {
                let now = tx.now().to_owned();
                tx.append(
                    crate::store::Draft::new(
                        "t1",
                        "turn-item.updated",
                        json!({"id": "turn-item:run:t1:1:interrupt-request", "threadId": "t1",
                               "runId": "run:t1:1", "type": "run_interrupt_request",
                               "status": "completed", "startedAt": now, "updatedAt": now}),
                    )
                    .run(Some("run:t1:1")),
                )
            })
            .await
            .unwrap();
    }
    let engine = open_held(&db);
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:1")["status"], "cancelled");
    assert_eq!(
        p["runs"].as_array().map(Vec::len),
        Some(1),
        "no continuation"
    );
}

/// The #268 gate's probe: an unattended prompt is sent again, and the user's prompt queued
/// behind it is held, as on every other restart path.
#[tokio::test(flavor = "current_thread")]
async fn a_resend_holds_the_prompt_queued_behind_it() {
    let db = TempDb::new("resend-holds-queue");
    {
        let (engine, _) = open(&db);
        leave_lost_start(&engine, LostStart::Mcp).await;
        dispatch(&engine, message("t1", "c3", "after")).await;
        assert_eq!(
            run_of(&projection(&engine, "t1").await, "run:t1:2")["status"],
            "queued"
        );
    }
    let (engine, _) = open(&db);
    run_to_end(&engine, "t1", "run:t1:1").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "queued");
    assert_eq!(run_of(&p, "run:t1:2")["queueHeld"], true);
}

/// The #268 gate's probe: a provider's buffered notification queued behind a run that waits
/// for its checkpoint lost its output with the process, so a restart cancels it
/// (`ProviderRuntimeRecoveryService`). A user prompt and a server notice with its own text
/// stay held.
#[tokio::test(flavor = "current_thread")]
async fn a_restart_cancels_a_queued_buffered_provider_notification() {
    let db = TempDb::new("restart-buffered-notification");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        dispatch(&engine, message("t1", "c2", "first")).await;
        run_to_end(&engine, "t1", "run:t1:1").await;
        engine.test_force_waiting("t1", "run:t1:1").await;
        for (command, source) in [("c3", "provider"), ("c4", "server")] {
            dispatch(
                &engine,
                json!({"type": "message.dispatch", "commandId": command, "threadId": "t1",
                       "messageId": format!("message:{command}"), "text": "Background task completed.",
                       "notification": {"source": {"kind": "background_task"},
                           "outcome": "updated", "summary": "Background activity updated"},
                       "attachments": [], "dispatchMode": {"type": "queue_after_active"},
                       "createdBy": "agent", "creationSource": source}),
            )
            .await;
        }
        dispatch(&engine, message("t1", "c5", "after")).await;
        let p = projection(&engine, "t1").await;
        for run in ["run:t1:2", "run:t1:3", "run:t1:4"] {
            assert_eq!(run_of(&p, run)["status"], "queued", "{run}");
        }
    }
    let engine = open_held(&db);
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "cancelled");
    for run in ["run:t1:3", "run:t1:4"] {
        assert_eq!(run_of(&p, run)["status"], "queued", "{run}");
        assert_eq!(run_of(&p, run)["queueHeld"], true, "{run}");
    }
}

/// The #268 gate's probe: cancelling a buffered notification queued behind a run that waits
/// for approval leaves that approval pending, so recovery does not continue past it.
#[tokio::test(flavor = "current_thread")]
async fn a_restart_cancelling_a_notification_keeps_the_active_approval() {
    let db = TempDb::new("restart-notification-approval");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .unwrap();
        dispatch(&engine, message("t1", "c2", "ask")).await;
        while next(&mut thread).await["event"]["type"] != "runtime-request.updated" {}
        dispatch(
            &engine,
            json!({"type": "message.dispatch", "commandId": "c3", "threadId": "t1",
                   "messageId": "message:c3", "text": "Background task completed.",
                   "notification": {"source": {"kind": "background_task"},
                       "outcome": "updated", "summary": "Background activity updated"},
                   "attachments": [], "dispatchMode": {"type": "queue_after_active"},
                   "createdBy": "agent", "creationSource": "provider"}),
        )
        .await;
        assert_eq!(
            run_of(&projection(&engine, "t1").await, "run:t1:2")["status"],
            "queued"
        );
    }
    let engine = open_held(&db);
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "cancelled");
    assert_eq!(run_of(&p, "run:t1:1")["status"], "cancelled");
    assert_eq!(
        p["runs"].as_array().map(Vec::len),
        Some(2),
        "the run that waited for approval does not continue on its own"
    );
}

/// The #268 gate's probe: a host cleanup that fails is tried again; one that keeps failing
/// leaves its row `failed` with the error, instead of `succeeded`.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_close_cleanup_is_retried_then_recorded() {
    for failures in [1, u32::MAX] {
        let db = TempDb::new(&format!("close-fails-{failures}"));
        let host = Arc::new(RecordingHost::default());
        host.close_failures
            .store(failures, std::sync::atomic::Ordering::SeqCst);
        let mut config = EngineConfig::new(db.path());
        config.projects = vec![ProjectConfig {
            title: "Project".into(),
            workspace_root: ROOT.into(),
        }];
        config.host = Some(host.clone());
        let engine = SqliteEngine::open(config).unwrap();
        dispatch(&engine, create("t1", "c1")).await;
        dispatch(
            &engine,
            json!({"type": "thread.archive", "commandId": "a1", "threadId": "t1"}),
        )
        .await;
        let statuses = settled_statuses(&db, "thread.closed").await;
        if failures == 1 {
            assert_eq!(statuses, ["succeeded"]);
            assert_eq!(host.closed.lock().unwrap().len(), 2, "tried again");
        } else {
            assert_eq!(statuses, ["failed"]);
            let error: String = rusqlite::Connection::open(db.path())
                .unwrap()
                .query_row(
                    "SELECT last_error FROM effect_outbox WHERE effect_type = 'thread.closed'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(error.contains("could not clean up"), "{error}");
        }
    }
}

/// The user sends a held prompt again: it runs once.
#[tokio::test(flavor = "current_thread")]
async fn a_held_prompt_runs_when_the_user_sends_it() {
    let db = TempDb::new("lost-start-send");
    {
        let (engine, _) = open(&db);
        leave_lost_start(&engine, LostStart::Running).await;
    }
    let (engine, provider) = open(&db);
    dispatch(
        &engine,
        json!({"type": "queued-run.start", "commandId": "q1", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(run_of(&p, "run:t1:1")["status"], "completed");
    assert_eq!(
        crate::lock(&provider.calls)
            .iter()
            .filter(|c| c.as_str() == "start run:t1:1")
            .count(),
        1
    );
}

/// `ThreadLaunchService.launch` for a scheduled run: the first message carries the task id
/// (the client's timeline marks it) and the launch's own actor.
#[tokio::test(flavor = "current_thread")]
async fn a_scheduled_launch_keeps_its_task_id_and_actor() {
    let db = TempDb::new("launch-scheduled");
    let (engine, _) = open(&db);
    let input = json!({
        "commandId": "scheduled-task:t:1:manual", "projectId": project_id(), "title": "Nightly",
        "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "workspaceStrategy": {"type": "root"},
        "initialMessage": {"messageId": "scheduled-task-message:t:1:manual",
                           "scheduledTaskId": "scheduled-task:t", "text": "hi", "attachments": []},
        "createdBy": "agent", "creationSource": "mcp",
    });
    let result = engine.launch_thread(input).await.unwrap();
    assert_eq!(result["threadId"], "thread:scheduled-task:t:1:manual");
    let message = &result["projection"]["messages"][0];
    assert_eq!(message["scheduledTaskId"], "scheduled-task:t");
    assert_eq!(message["createdBy"], "agent");
}

fn launch_input(command: &str, thread: &str, text: &str) -> Value {
    json!({
        "commandId": command, "threadId": thread, "projectId": project_id(), "title": "Launched",
        "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "workspaceStrategy": {"type": "root"},
        "initialMessage": {"messageId": format!("m-{command}"), "text": text, "attachments": []},
    })
}

fn record_count(projection: &Value, kind: &str) -> usize {
    projection[kind].as_array().map_or(0, Vec::len)
}

/// The user's messages; the fake provider's answer may already be there too.
fn user_messages(projection: &Value) -> usize {
    projection["messages"]
        .as_array()
        .map_or(0, |m| m.iter().filter(|m| m["role"] == "user").count())
}

async fn refusal(engine: &SqliteEngine, input: Value) -> String {
    match engine.launch_thread(input).await {
        Err(EngineError::Rejected(error)) => error["message"].as_str().unwrap().to_owned(),
        Ok(_) => panic!("expected a refusal, got a launch"),
        Err(EngineError::Internal(e)) => panic!("expected a refusal, got {e}"),
    }
}

/// Holds the first attachment claim forever, as a launch whose caller went away.
#[derive(Default)]
struct HoldFirstClaim {
    held: std::sync::atomic::AtomicBool,
    reached: tokio::sync::Notify,
}

impl crate::EngineHost for HoldFirstClaim {
    fn claim_attachments(
        &self,
        _thread_id: String,
        attachments: Value,
    ) -> crate::BoxFuture<'_, Result<Value, String>> {
        if self.held.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Box::pin(std::future::ready(Ok(attachments)));
        }
        self.reached.notify_one();
        Box::pin(std::future::pending())
    }
}

/// `ThreadLaunchService`: the thread and its first message commit in one transaction, so a
/// launch dropped part way (a closed socket) leaves no empty thread.
#[tokio::test(flavor = "current_thread")]
async fn a_dropped_launch_leaves_no_empty_thread() {
    let db = TempDb::new("launch-dropped");
    let host = Arc::new(HoldFirstClaim::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    let mut input = launch_input("launch-drop", "t-drop", "hi");
    input["initialMessage"]["attachments"] = json!([{"type": "image", "id": "pending-1",
        "name": "a.png", "mimeType": "image/png", "sizeBytes": 3}]);
    tokio::select! {
        _ = engine.launch_thread(input.clone()) => panic!("the claim never ends"),
        () = host.reached.notified() => {}
    }
    assert!(
        engine
            .get_thread_projection(conn_contract::ThreadId::from("t-drop"))
            .await
            .is_err()
    );
    let result = engine.launch_thread(input).await.unwrap();
    assert_eq!(result["resumed"], false);
    assert_eq!(result["projection"]["messages"][0]["text"], "hi");
}

/// Older builds wrote a launch's thread and first message as two commands: a replay finishes
/// a launch cut between them, and replays a complete one without a second turn.
#[tokio::test(flavor = "current_thread")]
async fn a_launch_split_by_an_older_build_completes_on_replay() {
    let db = TempDb::new("launch-split");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-cut", "launch-cut")).await;
    let cut = engine
        .launch_thread(launch_input("launch-cut", "t-cut", "hi"))
        .await
        .unwrap();
    assert_eq!(cut["projection"]["messages"][0]["text"], "hi");
    assert_eq!(record_count(&cut["projection"], "runs"), 1);

    dispatch(&engine, create("t-whole", "launch-whole")).await;
    let mut first = message("t-whole", "launch-whole:initial-message", "hi");
    first["messageId"] = json!("m-launch-whole");
    dispatch(&engine, first).await;
    let whole = engine
        .launch_thread(launch_input("launch-whole", "t-whole", "hi"))
        .await
        .unwrap();
    assert_eq!(whole["resumed"], true);
    assert_eq!(user_messages(&whole["projection"]), 1);
    assert_eq!(record_count(&whole["projection"], "runs"), 1);
}

/// `validateReusableThread`: a launch reuses only an empty, active thread of its project.
#[tokio::test(flavor = "current_thread")]
async fn a_launch_reuses_only_an_empty_active_thread_of_its_project() {
    const REFUSED: &str =
        "Only an empty active thread in the target project can change workspace during launch.";
    let db = TempDb::new("launch-reuse");
    let (engine, _) = open(&db);
    let reuse = |command: &str, thread: &str| {
        let mut input = launch_input(command, thread, "hi");
        input["reuseExistingThread"] = json!(true);
        input
    };
    dispatch(&engine, create("t-busy", "c-busy")).await;
    dispatch(&engine, message("t-busy", "c-busy-m", "earlier")).await;
    assert_eq!(refusal(&engine, reuse("l-busy", "t-busy")).await, REFUSED);

    let mut other = create("t-other", "c-other");
    other["projectId"] = json!("project:other");
    dispatch(&engine, other).await;
    assert_eq!(refusal(&engine, reuse("l-other", "t-other")).await, REFUSED);

    dispatch(&engine, create("t-archived", "c-archived")).await;
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "c-archive", "threadId": "t-archived"}),
    )
    .await;
    assert_eq!(
        refusal(&engine, reuse("l-archived", "t-archived")).await,
        REFUSED
    );

    dispatch(&engine, create("t-empty", "c-empty")).await;
    let first = engine
        .launch_thread(reuse("l-empty", "t-empty"))
        .await
        .unwrap();
    assert_eq!(first["resumed"], false);
    let again = engine
        .launch_thread(reuse("l-empty", "t-empty"))
        .await
        .unwrap();
    assert_eq!(again["resumed"], true);
    assert_eq!(user_messages(&again["projection"]), 1);
    assert_eq!(record_count(&again["projection"], "runs"), 1);

    // A reuse without a message still records its claim (T3's `thread.metadata.update`).
    dispatch(&engine, create("t-quiet", "c-quiet")).await;
    let mut quiet = reuse("l-quiet", "t-quiet");
    quiet.as_object_mut().unwrap().remove("initialMessage");
    let first = engine.launch_thread(quiet.clone()).await.unwrap();
    assert_eq!(first["resumed"], false);
    let again = engine.launch_thread(quiet).await.unwrap();
    assert_eq!(again["resumed"], true);
}

/// T3's `replayCommandReceipt` and claim check: a launch's id is bound to its thread and
/// project, so a replay elsewhere starts nothing.
#[tokio::test(flavor = "current_thread")]
async fn a_launch_replay_stays_on_its_thread_and_project() {
    let db = TempDb::new("launch-bound");
    let (engine, _) = open(&db);
    engine
        .launch_thread(launch_input("launch-a", "t-a", "hi"))
        .await
        .unwrap();
    let conflict =
        "Command launch-a was already handled for thread t-a and cannot be replayed for t-b.";
    dispatch(&engine, create("t-b", "c-b")).await;
    let mut reuse = launch_input("launch-a", "t-b", "hi");
    reuse["reuseExistingThread"] = json!(true);
    assert_eq!(refusal(&engine, reuse).await, conflict);
    assert_eq!(
        refusal(&engine, launch_input("launch-a", "t-b", "hi")).await,
        conflict
    );
    assert_eq!(record_count(&projection(&engine, "t-b").await, "runs"), 0);

    // An older build's create-only claim, replayed for another project: no message lands.
    dispatch(&engine, create("t-old", "launch-old")).await;
    let mut moved = launch_input("launch-old", "t-old", "hi");
    moved["projectId"] = json!("project:other");
    assert_eq!(refusal(&engine, moved).await, "Project identity changed.");
    assert_eq!(user_messages(&projection(&engine, "t-old").await), 0);
}

/// `DispatchModeLimit`: an agent's first message, sent apart from its claim, may not run in
/// broader modes than the agent launched with.
#[tokio::test(flavor = "current_thread")]
async fn an_agent_launch_message_keeps_its_mode_limit() {
    let db = TempDb::new("launch-modes");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-wide", "launch-wide")).await;
    let mut narrow = launch_input("launch-wide", "t-wide", "hi");
    narrow["runtimeMode"] = json!("approval-required");
    narrow["createdBy"] = json!("agent");
    narrow["creationSource"] = json!("mcp");
    assert_eq!(
        refusal(&engine, narrow).await,
        "Thread t-wide now runs in full-access/default mode, above what this caller may change."
    );
    assert_eq!(user_messages(&projection(&engine, "t-wide").await), 0);
    // T3 records no receipt for this refusal: once the user lowers the thread's modes, the
    // same launch goes through.
    dispatch(
        &engine,
        json!({"type": "thread.runtime-mode.set", "commandId": "c-lower", "threadId": "t-wide",
               "runtimeMode": "approval-required"}),
    )
    .await;
    let mut retry = launch_input("launch-wide", "t-wide", "hi");
    retry["runtimeMode"] = json!("approval-required");
    retry["createdBy"] = json!("agent");
    retry["creationSource"] = json!("mcp");
    let launched = engine.launch_thread(retry).await.unwrap();
    assert_eq!(user_messages(&launched["projection"]), 1);
}

/// Provisions worktrees with unique branches (as git does), can hold or refuse attachment
/// claims, and turns the provider off.
#[derive(Default)]
struct LaunchHost {
    provider_off: std::sync::atomic::AtomicBool,
    /// Turns the provider off while a worktree is made.
    off_during_provision: std::sync::atomic::AtomicBool,
    refuse_claims: std::sync::atomic::AtomicBool,
    /// The claim, counted from 1, that waits for `release`; 0 holds none.
    hold_claim: std::sync::atomic::AtomicUsize,
    claims: std::sync::atomic::AtomicUsize,
    reached: tokio::sync::Notify,
    release: tokio::sync::Notify,
    branches: Mutex<std::collections::HashSet<String>>,
    discarded: Mutex<Vec<String>>,
    discard_done: tokio::sync::Notify,
    /// The attachment ids the engine asked to release.
    released: Mutex<Vec<String>>,
    /// Claims return new ids (`claimed-<n>`), as a claim of a pending upload does.
    rename_claims: std::sync::atomic::AtomicBool,
    /// A discard waits for `discard_gate`.
    hold_discard: std::sync::atomic::AtomicBool,
    discard_gate: tokio::sync::Notify,
    /// Worktree setup runs until the engine cancels it (a slow fetch or submodule update).
    block_provision: std::sync::atomic::AtomicBool,
    provision_reached: tokio::sync::Notify,
    cancel_gate: tokio::sync::Notify,
    /// The threads whose preparation the engine cancelled.
    cancelled: Mutex<Vec<String>>,
}

impl crate::EngineHost for LaunchHost {
    fn provider_instance_enabled(&self, _project_id: Option<&str>, _instance_id: &str) -> bool {
        !self.provider_off.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn claim_attachments(
        &self,
        _thread_id: String,
        attachments: Value,
    ) -> crate::BoxFuture<'_, Result<Value, String>> {
        use std::sync::atomic::Ordering;
        let n = self.claims.fetch_add(1, Ordering::SeqCst) + 1;
        let held = self.hold_claim.load(Ordering::SeqCst) == n;
        Box::pin(async move {
            if held {
                self.reached.notify_one();
                self.release.notified().await;
            }
            if self.refuse_claims.load(Ordering::SeqCst) {
                Err("The upload is gone.".to_owned())
            } else if self.rename_claims.load(Ordering::SeqCst) {
                let mut renamed = attachments;
                for a in renamed.as_array_mut().into_iter().flatten() {
                    a["id"] = json!(format!("claimed-{n}"));
                }
                Ok(renamed)
            } else {
                Ok(attachments)
            }
        })
    }

    fn provision_worktree(
        &self,
        request: crate::WorktreeRequest,
    ) -> crate::BoxFuture<'_, Result<crate::ProvisionedWorktree, String>> {
        use std::sync::atomic::Ordering;
        if self.off_during_provision.load(Ordering::SeqCst) {
            self.provider_off.store(true, Ordering::SeqCst);
        }
        let branch = format!("conn/{}", request.thread_id);
        let blocked = self.block_provision.load(Ordering::SeqCst);
        Box::pin(async move {
            if blocked {
                self.provision_reached.notify_one();
                // conn-vcs removes what it made when its setup is cancelled.
                self.cancel_gate.notified().await;
                return Err("Worktree setup cancelled.".to_owned());
            }
            if self.branches.lock().unwrap().insert(branch.clone()) {
                Ok(crate::ProvisionedWorktree {
                    path: format!("/tmp/worktrees/{}", request.thread_id),
                    branch,
                })
            } else {
                Err(format!("A branch named '{branch}' already exists."))
            }
        })
    }

    fn cancel_preparation(&self, thread_id: &str) {
        self.cancelled.lock().unwrap().push(thread_id.to_owned());
        self.cancel_gate.notify_one();
    }

    fn release_attachments(&self, attachments: Value) -> crate::BoxFuture<'_, ()> {
        let ids = attachments
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a["id"].as_str().map(str::to_owned));
        self.released.lock().unwrap().extend(ids);
        Box::pin(std::future::ready(()))
    }

    fn discard_worktree(
        &self,
        _thread_id: String,
        _project_root: String,
        worktree: crate::ProvisionedWorktree,
        _refused: Option<String>,
    ) -> crate::BoxFuture<'_, Result<(), String>> {
        let held = self.hold_discard.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if held {
                self.discard_gate.notified().await;
            }
            self.branches.lock().unwrap().remove(&worktree.branch);
            self.discarded.lock().unwrap().push(worktree.branch);
            self.discard_done.notify_one();
            Ok(())
        })
    }
}

fn launch_engine(db: &TempDb, host: &Arc<LaunchHost>) -> SqliteEngine {
    let mut config = EngineConfig::new(db.path());
    config.home = Some(db.0.join("home"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    SqliteEngine::open(config).unwrap()
}

fn with_attachment(mut input: Value) -> Value {
    input["initialMessage"]["attachments"] = json!([{"type": "image", "id": "pending-1",
        "name": "a.png", "mimeType": "image/png", "sizeBytes": 3}]);
    input
}

fn reused(mut input: Value) -> Value {
    input["reuseExistingThread"] = json!(true);
    input
}

fn without_message(mut input: Value) -> Value {
    input.as_object_mut().unwrap().remove("initialMessage");
    input
}

fn in_worktree(mut input: Value) -> Value {
    input["workspaceStrategy"] = json!({"type": "worktree", "baseRef": "main"});
    input
}

fn launch_refusal(result: Result<Value, EngineError<Value>>) -> String {
    match result {
        Err(EngineError::Rejected(error)) => error["message"].as_str().unwrap().to_owned(),
        Ok(value) => panic!("expected a refusal, got {value}"),
        Err(EngineError::Internal(e)) => panic!("expected a refusal, got {e}"),
    }
}

/// T3 reads the committed thread's project before the first message, and the message's own
/// write sees the thread as it is then. A scratch thread promoted to a project while a legacy
/// launch replays gets no message.
#[tokio::test(flavor = "current_thread")]
async fn a_launch_message_checks_its_project_in_its_own_write() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-promoted");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    let scratch = call(&engine, "projects.ensureScratch", json!({}))
        .await
        .unwrap();
    let folder = db.0.join("home/scratch/2026-11-23-idea");
    std::fs::create_dir_all(&folder).unwrap();
    // An older build's create-only claim.
    let mut old = create("t-old", "launch-old");
    old["projectId"] = scratch["projectId"].clone();
    old["worktreePath"] = json!(folder.to_string_lossy());
    dispatch(&engine, old).await;

    let mut input = with_attachment(launch_input("launch-old", "t-old", "hi"));
    input["projectId"] = scratch["projectId"].clone();
    // The replayed create claims nothing; the first message's claim is the first.
    host.hold_claim.store(1, Ordering::SeqCst);
    let launch = engine.launch_thread(input);
    tokio::pin!(launch);
    tokio::select! {
        _ = &mut launch => panic!("the message claim is held"),
        () = host.reached.notified() => {}
    }
    call(
        &engine,
        "projects.createFromThread",
        json!({"threadId": "t-old"}),
    )
    .await
    .unwrap();
    host.release.notify_one();
    assert_eq!(launch_refusal(launch.await), "Project identity changed.");
    assert_eq!(user_messages(&projection(&engine, "t-old").await), 0);
}

/// T3 stores each receipt's thread: a launch id another thread's command already used is a
/// conflict, even when that command wrote no event under its id.
#[tokio::test(flavor = "current_thread")]
async fn a_launch_id_another_thread_used_is_a_conflict() {
    let db = TempDb::new("launch-owner");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-a", "c-a")).await;
    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "shared", "threadId": "t-a",
               "title": "Renamed"}),
    )
    .await;
    dispatch(&engine, create("t-b", "c-b")).await;
    let conflict =
        "Command shared was already handled for thread t-a and cannot be replayed for t-b.";
    let quiet = without_message(reused(launch_input("shared", "t-b", "hi")));
    assert_eq!(refusal(&engine, quiet).await, conflict);
    assert_eq!(
        refusal(&engine, reused(launch_input("shared", "t-b", "hi"))).await,
        conflict
    );
    assert_eq!(record_count(&projection(&engine, "t-b").await, "runs"), 0);
}

/// The server owns a launch once it started: a caller that goes away during the attachment
/// claim still gets its worktree removed when the claim fails, so a retry can make it again.
#[tokio::test(flavor = "current_thread")]
async fn a_launch_dropped_during_its_claim_still_cleans_up() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-cancel");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    let input = with_attachment(in_worktree(launch_input("launch-cut", "t-cut", "hi")));
    host.hold_claim.store(1, Ordering::SeqCst);
    tokio::select! {
        _ = engine.launch_thread(input.clone()) => panic!("the claim is held"),
        () = host.reached.notified() => {}
    }
    host.refuse_claims.store(true, Ordering::SeqCst);
    host.release.notify_one();
    timeout(Duration::from_secs(5), host.discard_done.notified())
        .await
        .expect("the server removes the worktree after the caller left");
    assert_eq!(
        *host.discarded.lock().unwrap(),
        vec!["conn/t-cut".to_owned()]
    );
    host.refuse_claims.store(false, Ordering::SeqCst);
    let retry = engine.launch_thread(input).await.unwrap();
    assert_eq!(retry["resumed"], false);
    assert_eq!(retry["projection"]["messages"][0]["text"], "hi");
}

/// T3 lets an accepted launch replay whatever the provider's state now: also a reuse an older
/// build completed with only its `:initial-message` receipt.
#[tokio::test(flavor = "current_thread")]
async fn an_older_reuse_replays_after_its_provider_is_off() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-old-reuse");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    dispatch(&engine, create("t-r", "c-r")).await;
    let mut first = message("t-r", "l-r:initial-message", "hi");
    first["messageId"] = json!("m-l-r");
    dispatch(&engine, first).await;
    host.provider_off.store(true, Ordering::SeqCst);
    let replay = engine
        .launch_thread(reused(launch_input("l-r", "t-r", "hi")))
        .await
        .unwrap();
    assert_eq!(replay["resumed"], true);
    assert_eq!(record_count(&replay["projection"], "runs"), 1);
}

/// The claim is the atomic step: an identical retry that finishes while another waits makes
/// the waiting one replay, not fail.
#[tokio::test(flavor = "current_thread")]
async fn identical_reuse_retries_converge() {
    let db = TempDb::new("launch-converge");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-same", "c-same")).await;
    let input = reused(launch_input("l-same", "t-same", "hi"));
    let pause = engine.test_pause_at("launch.receipts-read");
    let first = engine.launch_thread(input.clone());
    tokio::pin!(first);
    tokio::select! {
        _ = &mut first => panic!("the first launch is held"),
        () = pause.reached.notified() => {}
    }
    let second = engine.launch_thread(input).await.unwrap();
    assert_eq!(second["resumed"], false);
    pause.resume.notify_one();
    let first = first.await.unwrap();
    assert_eq!(first["resumed"], true);
    assert_eq!(user_messages(&first["projection"]), 1);
    assert_eq!(record_count(&first["projection"], "runs"), 1);
}

/// The reuse claim checks the thread in its own write: one archived after the launch began is
/// not claimed.
#[tokio::test(flavor = "current_thread")]
async fn a_reuse_refuses_a_thread_archived_before_its_claim() {
    let db = TempDb::new("launch-archived");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-arch", "c-arch")).await;
    let pause = engine.test_pause_at("launch.before-claim");
    let launch = engine.launch_thread(without_message(reused(launch_input(
        "l-arch", "t-arch", "hi",
    ))));
    tokio::pin!(launch);
    tokio::select! {
        _ = &mut launch => panic!("the launch is held"),
        () = pause.reached.notified() => {}
    }
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "c-archive", "threadId": "t-arch"}),
    )
    .await;
    pause.resume.notify_one();
    assert_eq!(
        launch_refusal(launch.await),
        "Only an empty active thread in the target project can change workspace during launch."
    );
}

/// A launch's receipt is durable: its id replays onto the same thread long after, also
/// past more writes than the store once kept receipts for. No second thread appears.
#[tokio::test(flavor = "current_thread")]
async fn an_old_launch_id_replays_after_many_writes() {
    let db = TempDb::new("launch-durable");
    let (engine, _) = open(&db);
    let mut input = launch_input("l-old", "unused", "hi");
    input.as_object_mut().unwrap().remove("threadId");
    let first = engine.launch_thread(input.clone()).await.unwrap();
    dispatch(&engine, create("t-other", "c-other")).await;
    for n in 0..4_400 {
        dispatch(
            &engine,
            json!({"type": "thread.metadata.update", "commandId": format!("c-w{n}"),
                   "threadId": "t-other", "title": format!("Title {n}")}),
        )
        .await;
    }
    let again = engine.launch_thread(input).await.unwrap();
    assert_eq!(again["threadId"], first["threadId"]);
    assert_eq!(again["resumed"], true);
    let launched = engine.shell_snapshot().await.unwrap()["threads"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["title"] == "Launched")
        .count();
    assert_eq!(launched, 1);
}

/// A refused launch releases only the files its own claim made. An attachment the message
/// names by a stable id (already a thread's file) passes the claim unchanged and stays.
#[tokio::test(flavor = "current_thread")]
async fn a_refused_launch_keeps_attachments_it_did_not_claim() {
    let db = TempDb::new("launch-keep-files");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    dispatch(&engine, create("t-taken", "c-taken")).await;
    let mut input = launch_input("l-taken", "t-taken", "hi");
    input["initialMessage"]["attachments"] = json!([{"type": "image",
        "id": "thread-old-0f8fad5b-d9cb-469f-a165-70867728950e", "name": "a.png",
        "mimeType": "image/png", "sizeBytes": 3}]);
    refusal(&engine, input).await;
    assert_eq!(*host.released.lock().unwrap(), Vec::<String>::new());
}

/// T3's `replayCommandReceipt` needs the receipt's thread. A receipt that names none (an old
/// one whose command wrote no event) cannot prove the command ran for this thread.
#[tokio::test(flavor = "current_thread")]
async fn a_receipt_without_an_owner_replays_for_no_thread() {
    let db = TempDb::new("receipt-no-owner");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    rusqlite::Connection::open(db.path())
        .unwrap()
        .execute(
            "INSERT INTO receipts (command_id, command_type, sequence) VALUES ('c-old', 'x', 1)",
            [],
        )
        .unwrap();
    assert_eq!(
        refused(
            &engine,
            json!({"type": "thread.metadata.update", "commandId": "c-old", "threadId": "t1",
                   "title": "Renamed"}),
        )
        .await,
        "Command c-old was handled before receipts named their owner; it cannot be replayed for t1."
    );
}

/// Round 3. `ThreadLaunchService` records the launch's checkout on a reused thread: an empty
/// thread bound to checkout A, launched for checkout B, runs its provider in B.
#[tokio::test(flavor = "current_thread")]
async fn a_reused_thread_runs_in_the_launch_checkout() {
    let db = TempDb::new("launch-reuse-checkout");
    let (engine, _) = open(&db);
    let (a, b) = (db.0.join("checkout-a"), db.0.join("checkout-b"));
    std::fs::create_dir_all(&b).unwrap();
    let mut thread = create("t-ck", "c-ck");
    thread["worktreePath"] = json!(a.to_string_lossy());
    dispatch(&engine, thread).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t-ck"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    let mut input = reused(launch_input("l-ck", "t-ck", "hi"));
    input["workspaceStrategy"] = json!({"type": "existing_worktree",
        "worktreePath": b.to_string_lossy(), "branch": "b"});
    engine.launch_thread(input).await.unwrap();
    until_run_ends(&mut stream).await;
    let p = projection(&engine, "t-ck").await;
    assert_eq!(p["thread"]["worktreePath"], json!(b.to_string_lossy()));
    assert_eq!(p["thread"]["branch"], "b");
    assert_eq!(p["providerSessions"][0]["cwd"], json!(b.to_string_lossy()));
}

/// Round 3. Only a first message proves a send: T3 needs an accepted `message.dispatch` with
/// its run (`ThreadLaunchService.ts`, "Initial message was accepted without a durable run").
/// A metadata command that used the message's id is not one.
#[tokio::test(flavor = "current_thread")]
async fn a_metadata_command_under_the_message_id_is_no_first_message() {
    let db = TempDb::new("launch-not-a-send");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-m", "c-m")).await;
    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "l-m:initial-message",
               "threadId": "t-m", "title": "Renamed"}),
    )
    .await;
    assert_eq!(
        refusal(&engine, reused(launch_input("l-m", "t-m", "hi"))).await,
        "Initial message was accepted without a durable run."
    );
    assert_eq!(user_messages(&projection(&engine, "t-m").await), 0);
}

/// Round 3. Shutdown waits for a launch it admitted: one that owns a worktree commits or
/// removes it first. A launch after shutdown began is refused.
#[tokio::test(flavor = "current_thread")]
async fn shutdown_waits_for_a_launch_that_owns_a_worktree() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-shutdown");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    let input = with_attachment(in_worktree(launch_input("l-sd", "t-sd", "hi")));
    host.hold_claim.store(1, Ordering::SeqCst);
    host.hold_discard.store(true, Ordering::SeqCst);
    let launch = engine.launch_thread(input);
    tokio::pin!(launch);
    tokio::select! {
        _ = &mut launch => panic!("the claim is held"),
        () = host.reached.notified() => {}
    }
    host.refuse_claims.store(true, Ordering::SeqCst);
    host.release.notify_one();
    let (discarded_when_shut, ()) = tokio::join!(
        async {
            engine.shutdown().await;
            host.discarded.lock().unwrap().len()
        },
        async {
            for _ in 0..16 {
                tokio::task::yield_now().await;
            }
            host.discard_gate.notify_one();
        }
    );
    assert_eq!(
        discarded_when_shut, 1,
        "shutdown returned before the cleanup"
    );
    assert_eq!(launch_refusal(launch.await), "The upload is gone.");
    assert_eq!(
        refusal(&engine, launch_input("l-late", "t-late", "hi")).await,
        "The server is shutting down."
    );
}

/// Round 3. Two identical launches each claim the upload; the one that replays releases the
/// copy its own claim made.
#[tokio::test(flavor = "current_thread")]
async fn a_replayed_launch_releases_the_copies_its_claim_made() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-replay-copies");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    host.rename_claims.store(true, Ordering::SeqCst);
    host.hold_claim.store(1, Ordering::SeqCst);
    let input = with_attachment(launch_input("l-twice", "t-twice", "hi"));
    let first = engine.launch_thread(input.clone());
    tokio::pin!(first);
    tokio::select! {
        _ = &mut first => panic!("the claim is held"),
        () = host.reached.notified() => {}
    }
    let second = engine.launch_thread(input).await.unwrap();
    assert_eq!(second["resumed"], false);
    host.release.notify_one();
    let first = first.await.unwrap();
    assert_eq!(first["resumed"], true);
    assert_eq!(*host.released.lock().unwrap(), vec!["claimed-1".to_owned()]);
}

/// Round 3, T3's "does not let a failing same-command caller strand a concurrent durable
/// launch": an invalid reuse is refused at admission and records nothing, so a valid launch
/// with the same id still runs.
#[tokio::test(flavor = "current_thread")]
async fn an_invalid_reuse_does_not_burn_its_launch_id() {
    let db = TempDb::new("launch-burn");
    let (engine, _) = open(&db);
    refusal(&engine, reused(launch_input("l-burn", "t-missing", "hi"))).await;
    let launched = engine
        .launch_thread(launch_input("l-burn", "t-peer", "hi"))
        .await
        .unwrap();
    assert_eq!(launched["threadId"], "t-peer");
    assert_eq!(user_messages(&launched["projection"]), 1);
}

/// Round 3. The projection a launch returns is checked too: a thread moved to another
/// project while a replay ran is not returned as this launch's.
#[tokio::test(flavor = "current_thread")]
async fn a_replay_returns_no_projection_from_another_project() {
    let db = TempDb::new("launch-moved");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    let scratch = call(&engine, "projects.ensureScratch", json!({}))
        .await
        .unwrap();
    let folder = db.0.join("home/scratch/2026-11-23-moved");
    std::fs::create_dir_all(&folder).unwrap();
    let mut input = launch_input("l-moved", "t-moved", "hi");
    input["projectId"] = scratch["projectId"].clone();
    input["workspaceStrategy"] = json!({"type": "existing_worktree",
        "worktreePath": folder.to_string_lossy()});
    engine.launch_thread(input.clone()).await.unwrap();
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t-moved"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    // Promotion refuses a thread that is still working: wait for its run unless it ended.
    let status = projection(&engine, "t-moved").await["runs"][0]["status"].clone();
    if !["completed", "failed", "interrupted", "cancelled"].contains(&status.as_str().unwrap_or(""))
    {
        until_run_ends(&mut stream).await;
    }
    let pause = engine.test_pause_at("launch.before-projection");
    let replay = engine.launch_thread(input);
    tokio::pin!(replay);
    tokio::select! {
        _ = &mut replay => panic!("the replay is held"),
        () = pause.reached.notified() => {}
    }
    call(
        &engine,
        "projects.createFromThread",
        json!({"threadId": "t-moved"}),
    )
    .await
    .unwrap();
    pause.resume.notify_one();
    assert_eq!(launch_refusal(replay.await), "Project identity changed.");
}

/// Round 4. The separate first message checks the checkout its claim recorded: a reuse that
/// rebinds the empty thread meanwhile makes the first launch refuse, not start elsewhere.
#[tokio::test(flavor = "current_thread")]
async fn a_rebound_checkout_refuses_the_first_message() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-rebound");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    dispatch(&engine, create("t-rb", "c-rb")).await;
    let checkout = |input: &mut Value, path: &std::path::Path| {
        input["workspaceStrategy"] =
            json!({"type": "existing_worktree", "worktreePath": path.to_string_lossy()});
    };
    let mut first = with_attachment(reused(launch_input("l-rb-a", "t-rb", "hi")));
    checkout(&mut first, &db.0.join("checkout-a"));
    host.hold_claim.store(1, Ordering::SeqCst);
    let launch = engine.launch_thread(first);
    tokio::pin!(launch);
    tokio::select! {
        _ = &mut launch => panic!("the message claim is held"),
        () = host.reached.notified() => {}
    }
    let mut second = without_message(reused(launch_input("l-rb-b", "t-rb", "hi")));
    checkout(&mut second, &db.0.join("checkout-b"));
    engine.launch_thread(second).await.unwrap();
    host.release.notify_one();
    assert_eq!(
        launch_refusal(launch.await),
        "The thread's checkout changed during the launch."
    );
    assert_eq!(user_messages(&projection(&engine, "t-rb").await), 0);
}

/// Round 4. Only a `message.dispatch` is a first message: a metadata update whose
/// continuation made a run under the message's id does not stand in for it.
#[tokio::test(flavor = "current_thread")]
async fn a_continuation_run_is_no_first_message() {
    let db = TempDb::new("launch-continuation");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-cont", "c-cont")).await;
    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "l-cont:initial-message",
               "threadId": "t-cont", "title": "Moved",
               "continuation": {"messageId": "m-cont", "text": "go on"}}),
    )
    .await;
    assert_eq!(
        refusal(&engine, reused(launch_input("l-cont", "t-cont", "hi"))).await,
        "Only an empty active thread in the target project can change workspace during launch."
    );
}

/// Round 4. Shutdown cancels a launch's worktree setup instead of waiting for it.
#[tokio::test(flavor = "current_thread")]
async fn shutdown_cancels_a_stalled_worktree_setup() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-stalled-setup");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    host.block_provision.store(true, Ordering::SeqCst);
    let launch = engine.launch_thread(in_worktree(launch_input("l-st", "t-st", "hi")));
    tokio::pin!(launch);
    tokio::select! {
        _ = &mut launch => panic!("the setup is held"),
        () = host.provision_reached.notified() => {}
    }
    timeout(Duration::from_secs(30), engine.shutdown())
        .await
        .expect("shutdown cancels the setup");
    assert_eq!(*host.cancelled.lock().unwrap(), vec!["t-st".to_owned()]);
    assert_eq!(launch_refusal(launch.await), "Worktree setup cancelled.");
}

/// Round 4. T3 reads the `:initial-message` receipt only when the claim needs a separate first
/// message: a stray command under that id does not change a fresh launch's admission.
#[tokio::test(flavor = "current_thread")]
async fn a_stray_message_id_does_not_change_admission() {
    let db = TempDb::new("launch-stray-id");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-else", "c-else")).await;
    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "l-fresh:initial-message",
               "threadId": "t-else", "title": "Renamed"}),
    )
    .await;
    let launched = engine
        .launch_thread(launch_input("l-fresh", "t-fresh", "hi"))
        .await
        .unwrap();
    assert_eq!(launched["resumed"], false);
    assert_eq!(user_messages(&launched["projection"]), 1);
}

/// Round 5. Every separate first message checks the checkout its claim recorded, read from
/// the claim's own event: an older build's split launch, replayed after a reuse rebound its
/// thread, is refused instead of starting in the other checkout.
#[tokio::test(flavor = "current_thread")]
async fn a_split_launch_replay_keeps_its_claimed_checkout() {
    let db = TempDb::new("launch-split-checkout");
    let (engine, _) = open(&db);
    let (a, b) = (db.0.join("checkout-a"), db.0.join("checkout-b"));
    // An older build's create-only claim, in checkout A.
    let mut old = create("t-split", "l-split");
    old["worktreePath"] = json!(a.to_string_lossy());
    dispatch(&engine, old).await;
    let mut rebind = without_message(reused(launch_input("l-rebind", "t-split", "hi")));
    rebind["workspaceStrategy"] =
        json!({"type": "existing_worktree", "worktreePath": b.to_string_lossy()});
    engine.launch_thread(rebind).await.unwrap();
    assert_eq!(
        refusal(&engine, launch_input("l-split", "t-split", "hi")).await,
        "The thread's checkout changed during the launch."
    );
    assert_eq!(user_messages(&projection(&engine, "t-split").await), 0);
}

/// Round 5. A launch's replay is only a launch when its id's receipt is a `thread.create`:
/// a continuation that ran under the launch id does not stand in for its first message.
#[tokio::test(flavor = "current_thread")]
async fn a_continuation_under_the_launch_id_is_no_launch() {
    let db = TempDb::new("launch-id-continuation");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-lc", "c-lc")).await;
    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "l-lc", "threadId": "t-lc",
               "title": "Moved", "continuation": {"messageId": "m-lc", "text": "go on"}}),
    )
    .await;
    assert_eq!(
        refusal(&engine, launch_input("l-lc", "t-lc", "hi")).await,
        "Command l-lc was already handled as thread.metadata.update and cannot be replayed as a launch."
    );
}

/// Guidance proof: a send wins a race against a conditional delete. T3 decides
/// `onlyIfUnused` under the thread lock; a thread with a message or run stays, and the delete
/// is accepted with no change.
#[tokio::test(flavor = "current_thread")]
async fn a_send_wins_against_a_conditional_delete() {
    let db = TempDb::new("delete-if-unused");
    let (engine, _) = open(&db);
    let delete = |thread: &str, command: &str| {
        json!({"type": "thread.delete", "commandId": command, "threadId": thread,
               "onlyIfUnused": true})
    };
    dispatch(&engine, create("t-used", "c-used")).await;
    dispatch(&engine, message("t-used", "c-used-m", "mine")).await;
    dispatch(&engine, delete("t-used", "d-used")).await;
    let kept = projection(&engine, "t-used").await;
    assert_eq!(kept["thread"]["deletedAt"], Value::Null);
    assert_eq!(user_messages(&kept), 1);

    dispatch(&engine, create("t-unused", "c-unused")).await;
    dispatch(&engine, delete("t-unused", "d-unused")).await;
    assert!(
        engine
            .get_thread_projection("t-unused".into())
            .await
            .is_err()
    );
}

/// Guidance proof: a send wins a race against a rebinding. A reuse launch held before its
/// claim finds the thread used and claims nothing; the send stays the only message.
#[tokio::test(flavor = "current_thread")]
async fn a_send_wins_against_a_reuse_claim() {
    let db = TempDb::new("launch-rebind");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t-race", "c-race")).await;
    let pause = engine.test_pause_at("launch.before-claim");
    let launch = engine.launch_thread(reused(launch_input("l-race", "t-race", "theirs")));
    tokio::pin!(launch);
    tokio::select! {
        _ = &mut launch => panic!("the launch is held"),
        () = pause.reached.notified() => {}
    }
    dispatch(&engine, message("t-race", "c-race-m", "mine")).await;
    pause.resume.notify_one();
    assert_eq!(
        launch_refusal(launch.await),
        "Only an empty active thread in the target project can change workspace during launch."
    );
    let p = projection(&engine, "t-race").await;
    assert_eq!(user_messages(&p), 1);
    assert_eq!(p["messages"][0]["text"], "mine");
}

/// Guidance proof: receipts are durable (T3 keeps them) and record refusals too. An old
/// retry after an undo, and after more than 4,400 unrelated writes, changes nothing; a
/// refused command replays its refusal after the state that refused it changed.
#[tokio::test(flavor = "current_thread")]
async fn an_old_retry_after_an_undo_and_many_writes_changes_nothing() {
    let db = TempDb::new("receipts-durable");
    let (engine, _) = open(&db);
    let archive = json!({"type": "thread.archive", "commandId": "c-arch", "threadId": "t-u"});
    let rename = json!({"type": "thread.metadata.update", "commandId": "c-early",
                        "threadId": "t-late", "title": "Too early"});
    dispatch(&engine, create("t-u", "c-u")).await;
    dispatch(&engine, archive.clone()).await;
    dispatch(
        &engine,
        json!({"type": "thread.unarchive", "commandId": "c-unarch", "threadId": "t-u"}),
    )
    .await;
    let early = refused(&engine, rename.clone()).await;
    dispatch(&engine, create("t-other", "c-other")).await;
    for n in 0..4_400 {
        dispatch(
            &engine,
            json!({"type": "thread.metadata.update", "commandId": format!("c-w{n}"),
                   "threadId": "t-other", "title": format!("Title {n}")}),
        )
        .await;
    }
    dispatch(&engine, archive).await;
    assert_eq!(
        projection(&engine, "t-u").await["thread"]["archivedAt"],
        Value::Null
    );
    dispatch(&engine, create("t-late", "c-late")).await;
    assert_eq!(
        refused(&engine, rename).await,
        format!("Command c-early was previously rejected: {early}")
    );
    assert_eq!(
        projection(&engine, "t-late").await["thread"]["title"],
        "New thread"
    );
}

/// T3 checks the provider again in the commit: one turned off while the worktree is made, or
/// during the attachment claim, refuses the launch and leaves no thread.
#[tokio::test(flavor = "current_thread")]
async fn a_provider_turned_off_mid_launch_refuses_it() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-off");
    let host = Arc::new(LaunchHost::default());
    let engine = launch_engine(&db, &host);
    let off = format!(
        "Provider instance \"claudeAgent\" is disabled for project {}.",
        project_id()
    );
    host.off_during_provision.store(true, Ordering::SeqCst);
    assert_eq!(
        refusal(&engine, in_worktree(launch_input("l-off", "t-off", "hi"))).await,
        off
    );
    assert!(engine.get_thread_projection("t-off".into()).await.is_err());
    assert_eq!(
        *host.discarded.lock().unwrap(),
        vec!["conn/t-off".to_owned()]
    );

    host.off_during_provision.store(false, Ordering::SeqCst);
    host.provider_off.store(false, Ordering::SeqCst);
    host.hold_claim.store(1, Ordering::SeqCst);
    let launch = engine.launch_thread(with_attachment(launch_input("l-claim", "t-claim", "hi")));
    tokio::pin!(launch);
    tokio::select! {
        _ = &mut launch => panic!("the claim is held"),
        () = host.reached.notified() => {}
    }
    host.provider_off.store(true, Ordering::SeqCst);
    host.release.notify_one();
    assert_eq!(launch_refusal(launch.await), off);
    assert!(
        engine
            .get_thread_projection("t-claim".into())
            .await
            .is_err()
    );
}

/// `ThreadLaunchService`: a refused claim removes the worktree made for it, and a launch
/// already accepted replays after its provider was turned off.
#[tokio::test(flavor = "current_thread")]
async fn a_launch_cleans_up_its_worktree_and_replays_past_a_disabled_provider() {
    use std::sync::atomic::Ordering;
    let db = TempDb::new("launch-host");
    let host = Arc::new(LaunchHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();

    let mut worktree = launch_input("launch-wt", "t-wt", "hi");
    worktree["workspaceStrategy"] = json!({"type": "worktree", "baseRef": "main"});
    worktree["initialMessage"]["attachments"] = json!([{"type": "image", "id": "pending-1",
        "name": "a.png", "mimeType": "image/png", "sizeBytes": 3}]);
    host.refuse_claims.store(true, Ordering::SeqCst);
    assert_eq!(refusal(&engine, worktree).await, "The upload is gone.");
    assert_eq!(
        *host.discarded.lock().unwrap(),
        vec!["conn/t-wt".to_owned()]
    );
    host.refuse_claims.store(false, Ordering::SeqCst);

    let input = launch_input("launch-on", "t-on", "hi");
    engine.launch_thread(input.clone()).await.unwrap();
    host.provider_off.store(true, Ordering::SeqCst);
    let replay = engine.launch_thread(input).await.unwrap();
    assert_eq!(replay["resumed"], true);
    assert_eq!(record_count(&replay["projection"], "runs"), 1);
}

/// Records what each worktree launch asks for a missing base, and has no such base.
#[derive(Default)]
struct MissingBaseHost {
    asked: Mutex<Vec<conn_vcs::setup::MissingBase>>,
}

impl crate::EngineHost for MissingBaseHost {
    fn provision_worktree(
        &self,
        request: crate::WorktreeRequest,
    ) -> crate::BoxFuture<'_, Result<crate::ProvisionedWorktree, String>> {
        self.asked.lock().unwrap().push(request.missing_base);
        Box::pin(std::future::ready(Err(
            "fatal: not a valid object name: 'gone'".to_owned(),
        )))
    }
}

/// Only the trusted scheduler lets a saved base fall back. A client's launch names its base
/// now, so it fails without it, even when its first message carries a `scheduledTaskId`.
#[tokio::test(flavor = "current_thread")]
async fn only_the_scheduler_lets_a_missing_base_fall_back() {
    use conn_vcs::setup::MissingBase;

    let db = TempDb::new("launch-missing-base");
    let host = Arc::new(MissingBaseHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    let input = |command: &str| {
        json!({
            "commandId": command, "projectId": project_id(), "title": "Nightly",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "workspaceStrategy": {"type": "worktree", "baseRef": "gone"},
            "initialMessage": {"messageId": format!("m:{command}"),
                               "scheduledTaskId": "scheduled-task:t", "text": "hi",
                               "attachments": []},
        })
    };
    let public = engine.launch_thread(input("public")).await;
    assert!(
        matches!(&public, Err(EngineError::Rejected(e)) if e["message"].as_str().is_some_and(|m| m.contains("gone"))),
        "{public:?}"
    );
    let _ = engine
        .launch_thread_with(input("scheduled"), MissingBase::FallBack)
        .await;
    assert_eq!(
        *host.asked.lock().unwrap(),
        [MissingBase::Fail, MissingBase::FallBack]
    );
}

fn message_with(
    thread: &str,
    command: &str,
    text: &str,
    mode: Value,
    intent: Option<&str>,
) -> Value {
    let mut m = message(thread, command, text);
    m["dispatchMode"] = mode;
    if let Some(intent) = intent {
        m["deliveryIntent"] = json!(intent);
    }
    m
}

async fn projection(engine: &SqliteEngine, thread: &str) -> Value {
    engine.get_thread_projection(thread.into()).await.unwrap()
}

fn run_statuses(projection: &Value) -> Vec<(String, String)> {
    projection["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["id"].as_str().unwrap().to_owned(),
                r["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn item_texts(projection: &Value) -> Vec<String> {
    let rows: Vec<Value> = projection["visibleTurnItems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["item"].clone())
        .collect();
    texts(&rows)
}

/// Like [`item_texts`], over `turnItems`: hidden rows too.
fn local_item_texts(projection: &Value) -> Vec<String> {
    texts(projection["turnItems"].as_array().unwrap())
}

fn texts(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|item| {
            format!(
                "{} {}",
                item["inputIntent"]
                    .as_str()
                    .unwrap_or(item["type"].as_str().unwrap()),
                item["text"].as_str().unwrap_or("")
            )
        })
        .collect()
}

/// Waits on the thread stream until the provider turn of the running run is live.
async fn until_provider_turn<E: serde::Serialize>(
    stream: &mut Subscription<conn_contract::ThreadStreamItem, E>,
) {
    loop {
        let item = next(stream).await;
        if item["event"]["type"] == "provider-turn.updated" {
            return;
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_message_sent_during_a_turn_queues_and_starts_after_it() {
    let db = TempDb::new("queue");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;

    // The client's "queue" sends `queue_after_active`; a plain start while busy queues too.
    dispatch(
        &engine,
        message_with(
            "t1",
            "c3",
            "second",
            json!({"type": "queue_after_active"}),
            None,
        ),
    )
    .await;
    dispatch(&engine, message("t1", "c4", "third")).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "running".into()),
            ("run:t1:2".into(), "queued".into()),
            ("run:t1:3".into(), "queued".into())
        ]
    );
    assert_eq!(p["runs"][1]["queuePosition"], 1);
    assert_eq!(p["runs"][2]["queuePosition"], 2);
    // Queued messages have no turn item yet. The shell's latest run is the newest queued one
    // (T3's `latestUnheldRun`; `idle-diff.mjs` compares it with the T3 server); the running
    // run stays the active and the activity run.
    assert_eq!(item_texts(&p), ["turn_start hang"]);
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["status"], "queued");
    assert_eq!(shell["threads"][0]["latestRunId"], "run:t1:3");
    assert_eq!(shell["threads"][0]["activeRunId"], "run:t1:1");
    assert_eq!(shell["threads"][0]["activityRunStatus"], "running");

    // Reorder: third before second.
    dispatch(
        &engine,
        json!({"type": "queued-run.reorder", "commandId": "c5", "threadId": "t1",
               "runId": "run:t1:3", "beforeRunId": "run:t1:2"}),
    )
    .await;
    // Edit the text of a queued message.
    dispatch(
        &engine,
        json!({"type": "queued-run.edit", "commandId": "c6", "threadId": "t1",
               "runId": "run:t1:2", "text": "second, edited"}),
    )
    .await;

    // Ending the turn (not with Stop) starts the queue in order.
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c7", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    for _ in 0..3 {
        until_run_ends(&mut thread).await;
    }
    let p = projection(&engine, "t1").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "interrupted".into()),
            ("run:t1:2".into(), "completed".into()),
            ("run:t1:3".into(), "completed".into())
        ]
    );
    assert_eq!(
        item_texts(&p),
        [
            "turn_start hang",
            "run_interrupt_request ",
            "run_interrupt_result ",
            "queued_turn third",
            "assistant_message echo: third",
            "queued_turn second, edited",
            "assistant_message echo: second, edited",
        ]
    );
}

/// `thread.metadata.update` with a `continuation` queues that message in the same commit, as
/// the agent through /mcp (T3's `metadataUpdateContinuation`, used by the worktree handoff).
#[tokio::test(flavor = "current_thread")]
async fn a_metadata_update_queues_its_continuation() {
    let db = TempDb::new("metadata-continuation");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;

    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "c3", "threadId": "t1",
               "title": "Moved", "continuation": {"messageId": "m-next", "text": "go on"}}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["thread"]["title"], "Moved", "the update applies");
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "running".into()),
            ("run:t1:2".into(), "queued".into())
        ],
        "the continuation queues behind the active run"
    );
    let queued = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "m-next")
        .expect("the continuation message exists");
    assert_eq!(queued["createdBy"], "agent");
    assert_eq!(queued["creationSource"], "mcp");
}

#[tokio::test(flavor = "current_thread")]
async fn stop_holds_the_queue_until_resume() {
    let db = TempDb::new("hold");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "later")).await;
    dispatch(&engine, message("t1", "c4", "cancel me")).await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c5", "threadId": "t1"}),
    )
    .await;
    until_run_ends(&mut thread).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][1]["status"], "queued");
    assert_eq!(p["runs"][1]["queueHeld"], true);

    dispatch(
        &engine,
        json!({"type": "queued-run.cancel", "commandId": "c6", "threadId": "t1", "runId": "run:t1:3"}),
    )
    .await;
    // Starting a queued run while busy is refused; here the thread is stopped, so it is not.
    dispatch(
        &engine,
        json!({"type": "queue.resume", "commandId": "c7", "threadId": "t1"}),
    )
    .await;
    loop {
        let events = until_run_ends(&mut thread).await;
        if events.last().unwrap().1["id"] == "run:t1:2" {
            break;
        }
    }
    let p = projection(&engine, "t1").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "interrupted".into()),
            ("run:t1:2".into(), "completed".into()),
            ("run:t1:3".into(), "cancelled".into())
        ]
    );
    let shell = engine.shell_snapshot().await.unwrap();
    assert_eq!(shell["threads"][0]["status"], "completed");
    assert_eq!(shell["threads"][0]["latestRunId"], "run:t1:2");
}

#[tokio::test(flavor = "current_thread")]
async fn a_steer_reaches_the_running_turn() {
    let db = TempDb::new("steer");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(
        &engine,
        message_with(
            "t1",
            "c3",
            "also this",
            json!({"type": "start_immediately"}),
            Some("steer"),
        ),
    )
    .await;
    until_run_ends(&mut thread).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(run_statuses(&p), [("run:t1:1".into(), "completed".into())]);
    assert_eq!(
        item_texts(&p),
        [
            "turn_start hang",
            "steer also this",
            "assistant_message steered: also this"
        ]
    );
    assert_eq!(p["messages"][1]["runId"], "run:t1:1");
}

/// `dispatchMessage` and `goalCommandStopsActiveRun`: a native `/goal` never joins a running
/// turn. One that changes no running goal waits in the queue; one that starts goal work
/// stops the run and goes first.
#[tokio::test(flavor = "current_thread")]
async fn a_goal_command_never_steers_a_running_turn() {
    let db = TempDb::new("goal-steer");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let steer = json!({"type": "steer_active", "targetRunId": "run:t1:1"});
    dispatch(
        &engine,
        message_with("t1", "c3", "/goal clear", steer.clone(), None),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".to_owned(), "running".to_owned()),
            ("run:t1:2".to_owned(), "queued".to_owned())
        ]
    );
    assert!(
        !local_item_texts(&p).iter().any(|t| t.contains("steer")),
        "{:?}",
        local_item_texts(&p)
    );
    // A queued goal stays its own run: it never becomes a steer once the turn runs.
    assert!(
        p["runs"][1]["steerWhenReadyRunId"].is_null(),
        "{}",
        p["runs"][1]
    );
    dispatch(
        &engine,
        message_with("t1", "c4", "/goal Ship the feature", steer, None),
    )
    .await;
    let p = projection(&engine, "t1").await;
    let goal_run = p["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["userMessageId"] == "message:c4")
        .unwrap()
        .clone();
    assert_eq!(goal_run["queuePosition"], 1, "{goal_run}");
    // The goal stops the run it replaces.
    loop {
        let item = next(&mut thread).await;
        let run = &item["event"]["payload"];
        if item["event"]["type"] == "run.updated" && run["id"] == "run:t1:1" {
            if run["status"] == "interrupted" {
                break;
            }
            assert_eq!(run["status"], "running", "{run}");
        }
    }
}

/// Waits on the thread stream until `run` ends, and returns its final status.
async fn until_run_status<E: serde::Serialize>(
    stream: &mut Subscription<conn_contract::ThreadStreamItem, E>,
    run: &str,
) -> String {
    loop {
        let item = next(stream).await;
        let payload = &item["event"]["payload"];
        if item["event"]["type"] == "run.updated"
            && payload["id"] == run
            && ["completed", "interrupted", "failed", "cancelled"]
                .contains(&payload["status"].as_str().unwrap_or_default())
        {
            return payload["status"].as_str().unwrap_or_default().to_owned();
        }
    }
}

/// `isNativeMaintenanceCommand` is only `/compact` and `/logout`: a running `/goal` turn is goal
/// work, so a Clear sent into it while its goal is active stops it and goes first.
#[tokio::test(flavor = "current_thread")]
async fn a_goal_clear_stops_the_running_goal_turn() {
    let db = TempDb::new("goal-clear-running");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "/goal Ship the feature")).await;
    until_provider_turn(&mut thread).await;
    // The goal row is stored before the Clear is decided.
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "provider-thread.updated"
            && item["event"]["payload"]["goal"]["status"] == "active"
        {
            break;
        }
    }
    dispatch(
        &engine,
        message_with(
            "t1",
            "c3",
            "/goal clear",
            json!({"type": "start_immediately"}),
            Some("auto"),
        ),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][1]["queuePosition"], 1, "{}", p["runs"][1]);
    assert_eq!(
        until_run_status(&mut thread, "run:t1:1").await,
        "interrupted"
    );
}

/// `promotes a queued goal by stopping the running turn` (`SteeringCompletion`): the goal
/// keeps its own run, goes first and stops the turn; it is never steered in as chat.
#[tokio::test(flavor = "current_thread")]
async fn promoting_a_queued_goal_stops_the_running_turn() {
    let db = TempDb::new("goal-promote");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let queue = json!({"type": "queue_after_active"});
    dispatch(
        &engine,
        message_with("t1", "c3", "queued", queue.clone(), None),
    )
    .await;
    dispatch(
        &engine,
        message_with("t1", "c4", "/goal ship it", queue, None),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "queued-message.promote-to-steer", "commandId": "promote",
            "threadId": "t1", "queuedRunId": "run:t1:3", "targetRunId": "run:t1:1"}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert!(
        !local_item_texts(&p).iter().any(|t| t.contains("steer")),
        "{:?}",
        local_item_texts(&p)
    );
    assert_eq!(
        until_run_status(&mut thread, "run:t1:1").await,
        "interrupted"
    );
    // The goal starts next; the other queued message still waits.
    loop {
        let item = next(&mut thread).await;
        let run = &item["event"]["payload"];
        if item["event"]["type"] == "run.updated" && run["id"] == "run:t1:3" {
            assert_ne!(run["status"], "cancelled", "{run}");
            if run["status"] == "running" {
                break;
            }
        }
    }
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][1]["status"], "queued", "{}", p["runs"][1]);
}

/// `providerTurnOrdinal`: a run's first provider turn follows the highest ordinal on its
/// provider thread. A goal run Codex continued has two turns, so the next run's turn is the
/// third, and a rollback to the goal's checkpoint counts it.
#[tokio::test(flavor = "current_thread")]
async fn a_run_after_a_continued_goal_run_gets_the_next_turn_ordinal() {
    let db = TempDb::new("goal-ordinals");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "goal-continued")).await;
    until_run_ends(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "hello")).await;
    until_run_ends(&mut thread).await;
    let p = projection(&engine, "t1").await;
    let mut ordinals: Vec<(String, Value)> = p["providerTurns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["id"].as_str().unwrap().to_owned(), t["ordinal"].clone()))
        .collect();
    ordinals.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        ordinals,
        [
            ("turn:run:t1:1".to_owned(), json!(1)),
            ("turn:run:t1:1:2".to_owned(), json!(2)),
            ("turn:run:t1:2".to_owned(), json!(3)),
        ]
    );
}

/// `runningProviderThread`: the turn gets the provider thread row the engine stores, goal and
/// all. Codex shows a goal change only against that row, so a Clear after a Pause clears it.
#[tokio::test(flavor = "current_thread")]
async fn a_goal_clear_after_a_pause_clears_the_goal_row() {
    let db = TempDb::new("goal-pause-clear");
    let (engine, _) = open_with(&db, FakeProvider::new("codex").with_driver("codex"));
    let mut create = create("t1", "c1");
    create["modelSelection"] = json!({"instanceId": "codex", "model": "gpt-5"});
    dispatch(&engine, create).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "goal")).await;
    until_run_ends(&mut thread).await;
    assert_eq!(shell_goal_status(&engine).await, "active");
    dispatch(&engine, message("t1", "c3", "/goal pause")).await;
    until_run_ends(&mut thread).await;
    assert_eq!(shell_goal_status(&engine).await, "paused");
    dispatch(&engine, message("t1", "c4", "/goal clear")).await;
    until_run_ends(&mut thread).await;
    assert_eq!(shell_goal_status(&engine).await, Value::Null);
}

async fn shell_goal_status(engine: &SqliteEngine) -> Value {
    engine.shell_snapshot().await.unwrap()["threads"][0]["goal"]["status"].clone()
}

/// An engine with a running `hang` turn on t1, on the instance `instance`.
async fn hanging_turn(
    db: &TempDb,
    providers: Vec<FakeProvider>,
    instance: &str,
) -> (
    SqliteEngine,
    Subscription<conn_contract::ThreadStreamItem, conn_contract::GetThreadProjectionError>,
) {
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = providers
        .into_iter()
        .map(|p| Arc::new(p) as Arc<dyn conn_provider::Provider>)
        .collect();
    let engine = SqliteEngine::open(config).unwrap();
    let mut create = create("t1", "c1");
    create["modelSelection"] = json!({"instanceId": instance, "model": "m"});
    dispatch(&engine, create).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    (engine, thread)
}

/// `goalDriverFor(command, modelSelection.instanceId)`: the message's own provider decides
/// whether `/goal` is a goal. A Codex goal sent into another provider's turn stops it and goes
/// first; it never steers in as chat.
#[tokio::test(flavor = "current_thread")]
async fn a_codex_goal_into_another_providers_turn_stops_it() {
    let db = TempDb::new("goal-other-provider");
    let (engine, mut thread) = hanging_turn(
        &db,
        vec![
            FakeProvider::new("grok").with_driver("grok"),
            FakeProvider::new("codex").with_driver("codex"),
        ],
        "grok",
    )
    .await;
    let mut goal = message_with(
        "t1",
        "c3",
        "/goal Ship the feature",
        json!({"type": "steer_active", "targetRunId": "run:t1:1"}),
        None,
    );
    goal["modelSelection"] = json!({"instanceId": "codex", "model": "gpt-5"});
    dispatch(&engine, goal).await;
    let p = projection(&engine, "t1").await;
    assert!(
        !local_item_texts(&p).iter().any(|t| t.contains("steer")),
        "{:?}",
        local_item_texts(&p)
    );
    assert_eq!(p["runs"][1]["queuePosition"], 1, "{}", p["runs"]);
    assert_eq!(
        until_run_status(&mut thread, "run:t1:1").await,
        "interrupted"
    );
}

/// `ensureGoalCommandSupported`: Claude goals cannot be paused or resumed. The send is refused
/// before it can stop the running turn.
#[tokio::test(flavor = "current_thread")]
async fn a_claude_goal_resume_is_refused_before_it_stops_work() {
    let db = TempDb::new("goal-claude-resume");
    let (engine, _thread) =
        hanging_turn(&db, vec![FakeProvider::new("claudeAgent")], "claudeAgent").await;
    for (command, text) in [("c3", "/goal resume"), ("c4", "/goal pause")] {
        let message = message_with(
            "t1",
            command,
            text,
            json!({"type": "steer_active", "targetRunId": "run:t1:1"}),
            None,
        );
        assert_eq!(
            refused(&engine, message).await,
            "Claude goals cannot be paused or resumed. Send /goal clear to remove the goal."
        );
    }
    let p = projection(&engine, "t1").await;
    assert_eq!(
        run_statuses(&p),
        [("run:t1:1".to_owned(), "running".to_owned())]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_declined_steer_waits_first_in_the_queue() {
    let db = TempDb::new("steer-declined");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent").without_steering());
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "queued first")).await;
    dispatch(
        &engine,
        message_with(
            "t1",
            "c4",
            "steer me",
            json!({"type": "steer_active", "targetRunId": "run:t1:1"}),
            None,
        ),
    )
    .await;
    // The follow-up lands after the decline; wait for its run.
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "run.created"
            && item["event"]["payload"]["userMessageId"] == "message:c4"
        {
            break;
        }
    }
    let p = projection(&engine, "t1").await;
    let queued: Vec<_> = p["runs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["status"] == "queued")
        .map(|r| (r["userMessageId"].clone(), r["queuePosition"].clone()))
        .collect();
    assert_eq!(
        queued,
        [
            (json!("message:c3"), json!(2)),
            (json!("message:c4"), json!(1))
        ]
    );
    assert_eq!(
        local_item_texts(&p),
        ["turn_start hang", "queued_turn steer me"],
        "the steer item now waits in the queue"
    );
    // T3's timeline rule: a queued user message is not shown until its run starts.
    assert_eq!(item_texts(&p), ["turn_start hang"]);
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c5", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    for _ in 0..3 {
        until_run_ends(&mut thread).await;
    }
    let p = projection(&engine, "t1").await;
    assert_eq!(
        item_texts(&p),
        [
            "turn_start hang",
            "queued_turn steer me",
            "run_interrupt_request ",
            "run_interrupt_result ",
            "assistant_message echo: steer me",
            "queued_turn queued first",
            "assistant_message echo: queued first",
        ]
    );
}

fn open_home(db: &TempDb) -> SqliteEngine {
    let mut config = EngineConfig::new(db.path());
    config.home = Some(db.0.join("home"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    SqliteEngine::open(config).unwrap()
}

async fn call(engine: &SqliteEngine, method: &str, input: Value) -> Result<Value, Value> {
    match engine.call(method, input).await {
        Ok(value) => Ok(value),
        Err(EngineError::Rejected(error)) => Err(error),
        Err(EngineError::Internal(e)) => panic!("internal: {e}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn clients_add_rename_and_remove_projects() {
    let db = TempDb::new("projects");
    let engine = open_home(&db);
    let folder = db.0.join("repo");
    std::fs::create_dir_all(&folder).unwrap();
    let root = folder.to_string_lossy().into_owned();
    let mut shell = engine
        .subscribe_shell(from_json(json!({"requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    next(&mut shell).await;
    next(&mut shell).await;

    let created = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.create", "commandId": "p1", "projectId": "project:new",
               "title": "Repo", "workspaceRoot": root}),
    )
    .await
    .unwrap();
    assert_eq!(created["title"], "Repo");
    assert_eq!(created["deletedAt"], Value::Null);
    assert_eq!(
        serde_json::to_value(engine.projects_snapshot().await.unwrap()).unwrap(),
        engine.shell_snapshot().await.unwrap()["projects"]
    );
    let item = next(&mut shell).await;
    assert_eq!(item["kind"], "project.updated");
    assert_eq!(item["project"]["workspaceRoot"], root.as_str());

    // The same folder twice is a conflict; a retry of the same command is not.
    let again = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.create", "commandId": "p2", "projectId": "project:other",
               "title": "Repo", "workspaceRoot": root}),
    )
    .await
    .unwrap_err();
    assert_eq!(again["_tag"], "ProjectMutationError");
    assert_eq!(again["cause"]["_tag"], "ProjectConflictError");
    let retry = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.create", "commandId": "p1", "projectId": "project:new",
               "title": "Repo", "workspaceRoot": root}),
    )
    .await
    .unwrap();
    assert_eq!(retry["id"], "project:new");
    // Another spelling of the same folder is the same folder (`normalizeWorkspaceRoot`).
    let dotted = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.create", "commandId": "p3", "projectId": "project:dotted",
               "title": "Repo", "workspaceRoot": format!("{root}/./")}),
    )
    .await
    .unwrap_err();
    assert_eq!(dotted["cause"]["_tag"], "ProjectConflictError");
    // An update cannot point a project at a folder that is not there.
    let missing = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.update", "commandId": "u-missing", "projectId": "project:new",
               "workspaceRoot": format!("{root}-missing")}),
    )
    .await
    .unwrap_err();
    assert_eq!(missing["cause"]["_tag"], "ProjectOperationError");

    let renamed = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.update", "commandId": "p3-rename", "projectId": "project:new",
               "title": "Renamed", "pinned": true}),
    )
    .await
    .unwrap();
    assert_eq!(renamed["title"], "Renamed");
    assert_eq!(renamed["hasCustomTitle"], true);
    assert!(renamed["pinnedAt"].is_string());
    assert_eq!(next(&mut shell).await["project"]["title"], "Renamed");

    // A project with a thread is not removed without `force`.
    let mut thread = create("t1", "c1");
    thread["projectId"] = json!("project:new");
    dispatch(&engine, thread).await;
    assert_eq!(next(&mut shell).await["kind"], "thread.updated");
    let refused = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.delete", "commandId": "p4", "projectId": "project:new"}),
    )
    .await
    .unwrap_err();
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("still has 1 thread")
    );
    call(
        &engine,
        "projects.mutate",
        json!({"type": "project.delete", "commandId": "p5", "projectId": "project:new", "force": true}),
    )
    .await
    .unwrap();
    let mut kinds = vec![];
    for _ in 0..2 {
        kinds.push(next(&mut shell).await["kind"].clone());
    }
    assert_eq!(kinds, [json!("thread.removed"), json!("project.removed")]);
    let snapshot = engine.shell_snapshot().await.unwrap();
    assert_eq!(snapshot["projects"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["threads"], json!([]));

    // The configured folder stays removed after a restart.
    let start = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.delete", "commandId": "p6", "projectId": project_id()}),
    )
    .await;
    assert!(start.is_ok());
    drop(engine);
    let engine = open_home(&db);
    assert_eq!(
        engine.shell_snapshot().await.unwrap()["projects"],
        json!([])
    );
}

#[tokio::test(flavor = "current_thread")]
async fn scratch_and_new_projects_get_folders_under_home() {
    let db = TempDb::new("scratch");
    let engine = open_home(&db);
    let scratch = call(&engine, "projects.ensureScratch", json!({}))
        .await
        .unwrap();
    let again = call(&engine, "projects.ensureScratch", json!({}))
        .await
        .unwrap();
    assert_eq!(scratch, again);
    let snapshot = engine.shell_snapshot().await.unwrap();
    let row = snapshot["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == scratch["projectId"])
        .unwrap()
        .clone();
    assert_eq!(row["title"], "No project");
    assert_eq!(row["projectIcon"]["name"], "message-square-dashed");
    assert!(db.0.join("home/scratch").is_dir());

    // A No-project thread with its own folder becomes a project in place.
    let folder = db.0.join("home/scratch/2026-11-13-idea");
    std::fs::create_dir_all(&folder).unwrap();
    let mut thread = create("t1", "c1");
    thread["projectId"] = scratch["projectId"].clone();
    thread["worktreePath"] = json!(folder.to_string_lossy());
    thread["title"] = json!("Idea");
    dispatch(&engine, thread).await;
    let promoted = call(
        &engine,
        "projects.createFromThread",
        json!({"threadId": "t1"}),
    )
    .await
    .unwrap();
    let projection = engine.get_thread_projection("t1".into()).await.unwrap();
    assert_eq!(projection["thread"]["projectId"], promoted["projectId"]);
    assert_eq!(projection["thread"]["worktreePath"], Value::Null);
    let shell = engine.shell_snapshot().await.unwrap();
    let project = shell["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == promoted["projectId"])
        .unwrap()
        .clone();
    assert_eq!(project["title"], "Idea");
    assert_eq!(shell["threads"][0]["projectId"], promoted["projectId"]);
    // Running it again finishes a partial move and changes nothing here.
    let again = call(
        &engine,
        "projects.createFromThread",
        json!({"threadId": "t1"}),
    )
    .await
    .unwrap();
    assert_eq!(again, promoted);
    let mut outside = create("t2", "c2");
    outside["title"] = json!("Elsewhere");
    dispatch(&engine, outside).await;
    let refused = call(
        &engine,
        "projects.createFromThread",
        json!({"threadId": "t2"}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused["_tag"], "OrchestrationDispatchCommandError");

    let created = call(&engine, "projects.createNew", json!({"name": "My App"}))
        .await
        .unwrap();
    let root = std::path::PathBuf::from(created["workspaceRoot"].as_str().unwrap());
    assert_eq!(root, db.0.join("home/projects/my-app"));
    assert!(root.join(".git").is_dir());
    assert!(root.join("README.md").is_file());
    let second = call(&engine, "projects.createNew", json!({"name": "My App"}))
        .await
        .unwrap();
    assert!(
        second["workspaceRoot"]
            .as_str()
            .unwrap()
            .ends_with("my-app-2")
    );
}

#[test]
fn every_contract_command_is_handled_or_refused_with_a_reason() {
    // Generated from the pinned contract, so a new command fails this test until it is handled
    // or refused with a reason.
    let mut handled = 0;
    for command in conn_contract::COMMAND_TYPES.iter().copied() {
        if crate::commands::handler(command).is_some() {
            handled += 1;
        } else {
            assert_ne!(
                crate::commands::refusal(command),
                "Conn Server does not support this command.",
                "{command} has no reason"
            );
        }
    }
    assert_eq!(handled, 52);
    assert_eq!(conn_contract::COMMAND_TYPES.len(), 58);
}

/// The link sweep's syncs, as T3's decider writes them: `thread.pull-request-link.sync`
/// replaces a link's snapshot and stack and leaves `updatedAt`; `thread.pull-request.sync`
/// sets the branch's pull request when the thread is still as the lookup saw it, and shows in
/// the shell row, where the sidebar chip reads it.
#[tokio::test(flavor = "current_thread")]
async fn link_and_branch_syncs_write_what_the_host_read() {
    let db = TempDb::new("pr-link-sync");
    let (engine, _) = open(&db);
    let mut thread = create("t1", "c1");
    thread["branch"] = json!("fix");
    dispatch(&engine, thread).await;
    dispatch(
        &engine,
        json!({"type": "thread.pull-request.link", "commandId": "l1", "threadId": "t1",
            "host": "github.com", "repository": "o/r", "number": 14,
            "url": "https://github.com/o/r/pull/14", "source": "manual"}),
    )
    .await;
    let before = projection(&engine, "t1").await["thread"].clone();
    // Let the clock move, so a sync that counted as activity would show.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let snapshot = json!({"state": "open", "title": "Fix the chip", "headBranch": "fix",
        "baseBranch": "main", "isDraft": false, "updatedAt": "2026-11-19T08:00:00Z",
        "syncedAt": "2026-11-19T09:00:00.000Z", "closedAt": null, "mergedAt": null,
        "checksState": "failing", "reviewDecision": "review-required"});
    dispatch(
        &engine,
        json!({"type": "thread.pull-request-link.sync", "commandId": "s1", "threadId": "t1",
            "host": "GitHub.com", "repository": "O/R", "number": 14, "snapshot": snapshot,
            "stack": null}),
    )
    .await;
    let after = projection(&engine, "t1").await["thread"].clone();
    assert_eq!(after["pullRequests"][0]["snapshot"], snapshot, "{after}");
    assert_eq!(
        after["updatedAt"], before["updatedAt"],
        "a host read is not activity"
    );
    // A sync for a pull request the thread does not link changes nothing.
    dispatch(
        &engine,
        json!({"type": "thread.pull-request-link.sync", "commandId": "s2", "threadId": "t1",
            "host": "github.com", "repository": "o/r", "number": 99, "snapshot": snapshot,
            "stack": null}),
    )
    .await;
    assert_eq!(projection(&engine, "t1").await["thread"], after);

    let shell = engine.shell_snapshot().await.unwrap();
    let branch_pr = json!({"projectId": project_id(), "repository": "o/r", "number": 14,
        "url": "https://github.com/o/r/pull/14"});
    let sync = |id: &str, branch: Value, expected_pr: Value| {
        json!({"type": "thread.pull-request.sync", "commandId": id, "threadId": "t1",
            "projectId": project_id(), "snapshotSequence": shell["snapshotSequence"],
            "expected": {"workspaceRoot": ROOT, "branch": branch, "worktreePath": null,
                "linkedPullRequest": null, "branchPullRequest": expected_pr},
            "branchPullRequest": branch_pr})
    };
    // The lookup saw another branch: refused, as T3 refuses it.
    let refused = engine
        .dispatch(from_json(sync("b0", json!("other"), Value::Null)).unwrap())
        .await;
    match refused {
        Err(EngineError::Rejected(e)) => assert!(
            to_json(&e)
                .to_string()
                .contains("changed before pull request discovery"),
            "{}",
            to_json(&e)
        ),
        other => panic!("not refused: {other:?}"),
    }
    dispatch(&engine, sync("b1", json!("fix"), Value::Null)).await;
    let thread = projection(&engine, "t1").await["thread"].clone();
    assert_eq!(thread["branchPullRequest"], branch_pr);
    assert_eq!(thread["updatedAt"], before["updatedAt"]);
    let r = engine.shell_snapshot().await.unwrap()["threads"][0].clone();
    assert_eq!(r["branchPullRequest"], branch_pr, "the shell carries it");
    assert_eq!(
        r["updatedAt"], before["updatedAt"],
        "the sidebar does not move the thread"
    );
    // A second lookup that expected no pull request is stale now.
    assert!(
        engine
            .dispatch(from_json(sync("b2", json!("fix"), Value::Null)).unwrap())
            .await
            .is_err()
    );
}

/// A watch starts with a link, its sync from the watch loop records what the host showed and
/// wakes the thread with T3's notice, and Stop ends it (`dispatchPullRequestWatchSync`).
#[tokio::test(flavor = "current_thread")]
async fn a_pull_request_watch_sync_wakes_the_thread_with_a_notice() {
    let db = TempDb::new("pr-watch");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(
        &engine,
        json!({"type": "thread.pull-request.watch", "commandId": "w1", "threadId": "t1",
            "host": "GitHub.com", "repository": "O/R", "number": 7, "watching": true,
            "link": {"url": "https://github.com/O/R/pull/7", "source": "agent"}}),
    )
    .await;
    let link = projection(&engine, "t1").await["thread"]["pullRequests"][0].clone();
    assert_eq!(link["host"], "github.com", "{link}");
    assert_eq!(link["source"], "agent");
    let started = link["watch"]["startedAt"].as_str().unwrap().to_owned();
    assert_eq!(
        link["watch"]["awaitingBaseline"], "all",
        "a first watch waits for its baseline"
    );
    assert_eq!(link["watch"]["remarksThrough"], started);

    let sync = |watch: Value, wake: Value| {
        json!({"commandId": format!("s-{}", watch["wakes"]), "threadId": "t1", "host": "github.com",
            "repository": "o/r", "number": 7, "startedAt": started, "watch": watch, "wake": wake})
    };
    let mut moved = link["watch"].clone();
    moved.as_object_mut().unwrap().remove("awaitingBaseline");
    moved["headSha"] = json!("abcdef1234");
    moved["failedChecks"] = json!(["test"]);
    let wake = json!({"text": "Update on pull request #7", "messageId": "message:pr-watch:1",
        "notification": {"source": {"kind": "monitor"}, "outcome": "failed",
            "summary": "#7: checks failed"}});
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    engine
        .sync_pull_request_watch(sync(moved.clone(), wake.clone()))
        .await
        .unwrap();
    until_run_ends(&mut thread).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(
        p["thread"]["pullRequests"][0]["watch"], moved,
        "the watch moved on"
    );
    let message = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "message:pr-watch:1")
        .cloned()
        .expect("the wake message");
    assert_eq!(message["createdBy"], "agent");
    assert_eq!(message["creationSource"], "server");
    assert_eq!(
        message["notification"]["source"],
        json!({"kind": "monitor", "pullRequest": {"host": "github.com", "repository": "o/r",
            "number": 7, "watchStartedAt": started, "headSha": "abcdef1234"}})
    );
    assert_eq!(run_statuses(&p).len(), 1, "the wake ran a turn");

    // A sync for a watch that is no longer the current one is refused whole.
    let mut stale = sync(moved.clone(), wake.clone());
    stale["startedAt"] = json!("2020-01-01T00:00:00.000Z");
    stale["commandId"] = json!("s-stale");
    assert!(engine.sync_pull_request_watch(stale).await.is_err());

    // Stop ends the watch and keeps it as the ended one.
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "stop", "threadId": "t1"}),
    )
    .await;
    let link = projection(&engine, "t1").await["thread"]["pullRequests"][0].clone();
    assert!(link.get("watch").is_none(), "{link}");
    assert_eq!(link["endedWatch"], moved);

    // Watching again keeps what the ended watch told; unwatching leaves the link.
    dispatch(
        &engine,
        json!({"type": "thread.pull-request.watch", "commandId": "w2", "threadId": "t1",
            "host": "github.com", "repository": "o/r", "number": 7, "watching": true}),
    )
    .await;
    let watch = projection(&engine, "t1").await["thread"]["pullRequests"][0]["watch"].clone();
    assert_eq!(watch["headSha"], "abcdef1234");
    assert_eq!(watch["failedChecks"], json!(["test"]));
    assert!(watch.get("awaitingBaseline").is_none(), "{watch}");
    dispatch(
        &engine,
        json!({"type": "thread.pull-request.watch", "commandId": "w3", "threadId": "t1",
            "host": "github.com", "repository": "o/r", "number": 7, "watching": false}),
    )
    .await;
    let link = projection(&engine, "t1").await["thread"]["pullRequests"][0].clone();
    assert!(
        link.get("watch").is_none() && link["endedWatch"].is_object(),
        "{link}"
    );

    // Settled threads refuse new watches.
    dispatch(
        &engine,
        json!({"type": "thread.settle", "commandId": "settle", "threadId": "t1"}),
    )
    .await;
    let refused = engine
        .dispatch(
            from_json(
                json!({"type": "thread.pull-request.watch", "commandId": "w4",
                "threadId": "t1", "host": "github.com", "repository": "o/r", "number": 7,
                "watching": true}),
            )
            .unwrap(),
        )
        .await;
    assert!(matches!(refused, Err(EngineError::Rejected(_))));
}

fn watch_command(id: &str, number: u64, watching: bool) -> Value {
    json!({"type": "thread.pull-request.watch", "commandId": id, "threadId": "t1",
        "host": "github.com", "repository": "o/r", "number": number, "watching": watching,
        "link": {"url": format!("https://github.com/o/r/pull/{number}"), "source": "manual"}})
}

async fn current_watch(engine: &SqliteEngine, number: u64) -> Value {
    projection(engine, "t1").await["thread"]["pullRequests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["number"] == number)
        .map(|l| l["watch"].clone())
        .unwrap_or(Value::Null)
}

fn section(number: u64) -> Value {
    json!({"text": format!("Update on pull request #{number}\n\nLook into each item and act on it as your task requires. This PR stays linked and watched, so do not link, watch, or list it again. End your turn when you are done, and Conn wakes you on the next change. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox."),
        "outcome": "failed", "summary": format!("#{number}: checks failed")})
}

/// A wake queued behind a running turn is checked again when it would start
/// (`startNextQueuedRun`): one whose watches all ended is cancelled; one for two pull
/// requests, one of them since unwatched, tells only the other.
#[tokio::test(flavor = "current_thread")]
async fn a_queued_wake_is_dropped_or_narrowed_when_its_watches_end() {
    let db = TempDb::new("pr-wake-stale");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    for (id, n) in [("w7", 7), ("w8", 8)] {
        dispatch(&engine, watch_command(id, n, true)).await;
    }
    let started = |watch: &Value| watch["startedAt"].as_str().unwrap().to_owned();
    let (s7, s8) = (
        started(&current_watch(&engine, 7).await),
        started(&current_watch(&engine, 8).await),
    );
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;

    // Turn 1 keeps the thread busy; a wake for #7 queues behind it, then #7 is unwatched.
    dispatch(&engine, message("t1", "m1", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut w7 = current_watch(&engine, 7).await;
    w7["failedChecks"] = json!(["ci"]);
    engine
        .sync_pull_request_watch(json!({"commandId": "s1", "threadId": "t1",
            "host": "github.com", "repository": "o/r", "number": 7, "startedAt": s7,
            "watch": w7, "wake": {"text": "Update on pull request #7", "messageId": "message:wake-1",
                "notification": {"source": {"kind": "monitor"}, "outcome": "failed",
                    "summary": "#7: checks failed"}}}))
        .await
        .unwrap();
    dispatch(&engine, watch_command("u7", 7, false)).await;
    let runs = run_statuses(&projection(&engine, "t1").await);
    assert_eq!(runs.last().unwrap().1, "queued", "{runs:?}");
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "i1", "threadId": "t1",
            "runId": runs[0].0}),
    )
    .await;
    until_run_ends(&mut thread).await;
    let runs = run_statuses(&projection(&engine, "t1").await);
    assert_eq!(runs[1].1, "cancelled", "the stale wake never ran: {runs:?}");

    // Turn 3 busy again; one wake for #7 (watched again) and #8 queues; #8 is unwatched.
    dispatch(&engine, watch_command("w7b", 7, true)).await;
    let s7 = started(&current_watch(&engine, 7).await);
    dispatch(&engine, message("t1", "m3", "hang")).await;
    until_provider_turn(&mut thread).await;
    let (w7, w8) = (
        current_watch(&engine, 7).await,
        current_watch(&engine, 8).await,
    );
    engine
        .sync_pull_request_watch(json!({"commandId": "s2", "threadId": "t1",
            "host": "github.com", "repository": "o/r", "number": 7, "startedAt": s7, "watch": w7,
            "others": [{"host": "github.com", "repository": "o/r", "number": 8,
                "startedAt": s8, "watch": w8}],
            "wake": {"text": "both", "messageId": "message:wake-2",
                "notification": {"source": {"kind": "monitor"}, "outcome": "failed",
                    "summary": "#7: checks failed; #8: checks failed"},
                "sections": [section(7), section(8)]}}))
        .await
        .unwrap();
    dispatch(&engine, watch_command("u8", 8, false)).await;
    let runs = run_statuses(&projection(&engine, "t1").await);
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "i3", "threadId": "t1",
            "runId": runs[2].0}),
    )
    .await;
    until_run_ends(&mut thread).await;
    until_run_ends(&mut thread).await;
    let p = projection(&engine, "t1").await;
    let runs = run_statuses(&p);
    assert_eq!(runs[3].1, "completed", "the narrowed wake ran: {runs:?}");
    let wake = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "message:wake-2")
        .cloned()
        .unwrap();
    assert_eq!(wake["text"], section(7)["text"], "only #7 is told");
    assert_eq!(wake["notification"]["summary"], "#7: checks failed");
    assert!(
        wake["notification"]["source"]
            .get("otherPullRequests")
            .is_none()
    );
    assert!(
        wake["notification"]["source"]["pullRequest"]
            .get("section")
            .is_none()
    );
}

/// A finished push clears each watch's `checksPending` (`checks-reopen`), and a read of the
/// old head that was in flight cannot put its `false` back (`syncedPullRequestWatch`).
#[tokio::test(flavor = "current_thread")]
async fn a_push_reopens_watched_checks_and_an_old_read_cannot_close_them() {
    let db = TempDb::new("pr-push-reopen");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, watch_command("w7", 7, true)).await;
    let mut answered = current_watch(&engine, 7).await;
    let started = answered["startedAt"].as_str().unwrap().to_owned();
    answered.as_object_mut().unwrap().remove("awaitingBaseline");
    answered["checksPending"] = json!(false);
    answered["passed"] = json!(true);
    engine
        .sync_pull_request_watch(json!({"commandId": "s1", "threadId": "t1",
            "host": "github.com", "repository": "o/r", "number": 7, "startedAt": started,
            "watch": answered}))
        .await
        .unwrap();
    assert_eq!(current_watch(&engine, 7).await["checksPending"], false);

    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "m1", "push")).await;
    until_run_ends(&mut thread).await;
    let reopened = current_watch(&engine, 7).await;
    assert!(reopened.get("checksPending").is_none(), "{reopened}");
    assert_eq!(reopened["passed"], true, "only the answer is forgotten");

    // The read started before the push lands now: its `false` belongs to the old head.
    let mut late = answered.clone();
    late["headSha"] = json!("old");
    engine
        .sync_pull_request_watch(json!({"commandId": "s2", "threadId": "t1",
            "host": "github.com", "repository": "o/r", "number": 7, "startedAt": started,
            "watch": late, "checksPendingBefore": false}))
        .await
        .unwrap();
    let after = current_watch(&engine, 7).await;
    assert!(after.get("checksPending").is_none(), "{after}");
    assert_eq!(after["headSha"], "old", "the rest of the read lands");
}

/// Every event of a turn names the provider instance in its envelope, as T3's: the thread's,
/// the run's and the provider session's are all the thread's instance here.
#[tokio::test(flavor = "current_thread")]
async fn a_turns_events_name_the_provider_instance() {
    let db = TempDb::new("envelope-instance");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let events = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 100_000))
        .await
        .unwrap();
    let missing: Vec<String> = events
        .iter()
        .filter(|(_, e)| e["providerInstanceId"] != "claudeAgent")
        .map(|(_, e)| format!("{} {}", e["type"], e["payload"]["type"]))
        .collect();
    assert!(missing.is_empty(), "{missing:#?}");
    assert!(events.len() > 5, "the turn wrote its events");
}

/// Which thread commands move the thread's `updatedAt` (the sidebar order), as T3's deciders
/// in `dispatchThreadMutation`: a command that changes nothing keeps it, and so do a tag, a
/// visit and an Active reorder.
#[tokio::test(flavor = "current_thread")]
async fn thread_commands_move_updated_at_as_t3() {
    let db = TempDb::new("updated-at");
    let clock = Arc::new(crate::clock::ManualClock::at(1_800_000_000_000));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.clock = clock.clone();
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let later = "2100-01-01T00:00:00.000Z";
    let issue = json!({"tracker": "github", "host": "github.com", "scope": "o/r", "key": "7",
        "projectId": project_id(), "url": "https://github.com/o/r/issues/7", "displayKey": "#7",
        "title": "Bug", "source": "manual"});
    let pull = json!({"host": "github.com", "repository": "o/r", "number": 7,
        "url": "https://github.com/o/r/pull/7", "source": "manual"});
    let steps = [
        (
            "thread.tag.set",
            json!({"tag": "bug", "tagged": true}),
            false,
        ),
        ("thread.active.reorder", json!({"orderKey": "a"}), false),
        ("thread.pin", json!({"orderKey": "a0"}), true),
        ("thread.pin", json!({"orderKey": "a0"}), false),
        ("thread.pin.reorder", json!({"orderKey": "a0"}), false),
        ("thread.pin.reorder", json!({"orderKey": "b0"}), true),
        ("thread.unpin", json!({}), true),
        ("thread.unpin", json!({}), false),
        ("thread.auto-settle.set", json!({"enabled": false}), true),
        ("thread.auto-settle.set", json!({"enabled": false}), false),
        ("thread.snooze", json!({"snoozedUntil": later}), true),
        ("thread.pin", json!({"orderKey": "a0"}), true),
        ("thread.unpin", json!({}), true),
        ("thread.snooze", json!({"snoozedUntil": later}), true),
        ("thread.unsnooze", json!({"reason": "user"}), true),
        ("thread.unsnooze", json!({"reason": "user"}), false),
        ("thread.settle", json!({}), true),
        ("thread.settle", json!({}), false),
        ("thread.snooze", json!({"snoozedUntil": later}), true),
        ("thread.settle", json!({}), true),
        ("thread.unsettle", json!({"reason": "user"}), true),
        ("thread.unsettle", json!({"reason": "user"}), false),
        (
            "thread.visit",
            json!({"visitedAt": "2027-01-01T00:00:00.000Z"}),
            false,
        ),
        (
            "thread.runtime-mode.set",
            json!({"runtimeMode": "approval-required"}),
            true,
        ),
        (
            "thread.interaction-mode.set",
            json!({"interactionMode": "plan"}),
            true,
        ),
        ("thread.metadata.update", json!({"title": "Renamed"}), true),
        ("thread.issue.link", issue.clone(), true),
        ("thread.issue.unlink", issue, true),
        ("thread.pull-request.link", pull.clone(), true),
        ("thread.pull-request.unlink", pull, true),
        ("thread.archive", json!({}), true),
        ("thread.unarchive", json!({}), true),
    ];
    for (n, (ty, extra, moves)) in steps.into_iter().enumerate() {
        let before = engine.shell_snapshot().await.unwrap()["threads"][0]["updatedAt"].clone();
        clock.advance(Duration::from_secs(1));
        let mut command = json!({"type": ty, "commandId": format!("u{n}"), "threadId": "t1"});
        command
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        dispatch(&engine, command).await;
        let after = engine.shell_snapshot().await.unwrap()["threads"][0]["updatedAt"].clone();
        assert_eq!(
            after != before,
            moves,
            "step {n}: {ty} {extra}: {before} -> {after}"
        );
    }

    // A visit time is read as T3's `DateTime.make` reads it, and stored in the wire form.
    let visit = |id: &str, at: &str| json!({"type": "thread.visit", "commandId": id, "threadId": "t1", "visitedAt": at});
    dispatch(&engine, visit("v1", "Jan 2 2028 10:00 GMT+1")).await;
    assert_eq!(
        engine.shell_snapshot().await.unwrap()["threads"][0]["lastVisitedAt"],
        "2028-01-02T09:00:00.000Z"
    );
    let refused = engine
        .dispatch(from_json(visit("v2", "not a time")).unwrap())
        .await;
    let Err(EngineError::Rejected(e)) = refused else {
        panic!("a visit time that does not parse is refused");
    };
    assert!(
        to_json(&e)
            .to_string()
            .contains("Thread t1 visit time not a time is not a valid timestamp."),
        "{}",
        to_json(&e)
    );
}

/// T3's `dispatchThreadMutation` refuses these commands on an archived thread, and checks
/// that before anything else it reads: a run id, a snooze time, a pin.
#[tokio::test(flavor = "current_thread")]
async fn an_archived_thread_refuses_lifecycle_commands_first() {
    let db = TempDb::new("archived-guard");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "c2", "threadId": "t1"}),
    )
    .await;
    let before = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 100_000))
        .await
        .unwrap();
    let later = "2100-01-01T00:00:00.000Z";
    for (n, (ty, extra)) in [
        ("thread.settle", json!({})),
        ("thread.settle", json!({"expectedLatestRunId": "run:other"})),
        ("thread.auto-settle", json!({"snapshotAt": later})),
        ("thread.unsettle", json!({"reason": "user"})),
        ("thread.snooze", json!({"snoozedUntil": later})),
        ("thread.snooze", json!({"snoozedUntil": "not a time"})),
        ("thread.unsnooze", json!({"reason": "user"})),
        ("thread.auto-settle.set", json!({"enabled": false})),
        ("thread.pin", json!({"orderKey": "a0"})),
        ("thread.unpin", json!({})),
        ("thread.pin.reorder", json!({"orderKey": "b0"})),
        ("thread.active.reorder", json!({"orderKey": "b0"})),
    ]
    .into_iter()
    .enumerate()
    {
        let mut command = json!({"type": ty, "commandId": format!("g{n}"), "threadId": "t1"});
        command
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let result = engine.dispatch(from_json(command).unwrap()).await;
        let Err(EngineError::Rejected(e)) = result else {
            panic!("{ty} {extra} on an archived thread is refused");
        };
        let text = to_json(&e).to_string();
        assert!(
            text.contains("Thread t1 is archived."),
            "{ty} {extra}: {text}"
        );
    }
    let after = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 100_000))
        .await
        .unwrap();
    assert_eq!(after, before);
}

#[tokio::test(flavor = "current_thread")]
async fn thread_lifecycle_commands_reach_the_shell_row() {
    let db = TempDb::new("lifecycle");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let row = |shell: &Value| shell["threads"][0].clone();
    let cmd = |n: u32, ty: &str, extra: Value| {
        let mut c = json!({"type": ty, "commandId": format!("l{n}"), "threadId": "t1"});
        c.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        c
    };

    dispatch(&engine, cmd(1, "thread.pin", json!({"orderKey": "a0"}))).await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert!(r["pinnedAt"].is_string());
    assert_eq!(r["pinOrderKey"], "a0");
    dispatch(
        &engine,
        cmd(2, "thread.pin.reorder", json!({"orderKey": "b0"})),
    )
    .await;
    dispatch(
        &engine,
        cmd(3, "thread.tag.set", json!({"tag": "bug", "tagged": true})),
    )
    .await;
    dispatch(
        &engine,
        cmd(4, "thread.tag.set", json!({"tag": "ui", "tagged": true})),
    )
    .await;
    dispatch(
        &engine,
        cmd(5, "thread.tag.set", json!({"tag": "bug", "tagged": false})),
    )
    .await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["pinOrderKey"], "b0");
    assert_eq!(r["tags"], json!(["ui"]));

    // Settling unpins; pinning again brings it back as active.
    dispatch(&engine, cmd(6, "thread.settle", json!({}))).await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["settledOverride"], "settled");
    assert_eq!(r["pinnedAt"], Value::Null);
    dispatch(
        &engine,
        cmd(7, "thread.unsettle", json!({"reason": "user"})),
    )
    .await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["settledOverride"], "active");
    assert!(r["unsettledAt"].is_string());

    // An undo of a settle restores the Active anchor it cleared, as T3 does.
    let anchor = r["unsettledAt"].clone();
    let restore = |n: u32, at: Value| {
        cmd(
            n,
            "thread.unsettle",
            json!({"reason": "user", "restoreUnsettledAt": at}),
        )
    };
    dispatch(&engine, cmd(71, "thread.settle", json!({}))).await;
    dispatch(&engine, restore(72, json!("2020-01-02T03:04:05.006Z"))).await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["settledOverride"], "active");
    assert_eq!(r["unsettledAt"], "2020-01-02T03:04:05.006Z");
    assert_ne!(r["unsettledAt"], anchor);
    // The envelope names the thread's provider instance, as T3's does.
    let restored = command_events(&engine, "l72").await;
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0]["type"], "thread.unsettled");
    assert_eq!(restored[0]["providerInstanceId"], "claudeAgent");
    assert_eq!(
        restored[0]["providerInstanceId"],
        restored[0]["payload"]["providerInstanceId"]
    );
    // Already active keeps its anchor and `updatedAt`. A fresh command still records one
    // `thread.unsettled`; a retry of the same command records nothing more.
    let updated_at = r["updatedAt"].clone();
    for _ in 0..2 {
        dispatch(&engine, restore(73, json!("2021-01-01T00:00:00.000Z"))).await;
    }
    let kept = command_events(&engine, "l73").await;
    assert_eq!(kept.len(), 1, "one event per command id");
    assert_eq!(kept[0]["type"], "thread.unsettled");
    assert_eq!(
        kept[0]["payload"]["unsettledAt"],
        "2020-01-02T03:04:05.006Z"
    );
    assert_eq!(kept[0]["payload"]["updatedAt"], updated_at);
    assert_eq!(kept[0]["providerInstanceId"], "claudeAgent");
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["unsettledAt"], "2020-01-02T03:04:05.006Z");
    assert_eq!(r["updatedAt"], updated_at);
    dispatch(&engine, cmd(74, "thread.settle", json!({}))).await;
    dispatch(&engine, restore(75, Value::Null)).await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["settledOverride"], "active");
    assert_eq!(r["unsettledAt"], Value::Null);
    // T3's `DateTime.make` reads a time without a zone as UTC.
    dispatch(&engine, cmd(77, "thread.settle", json!({}))).await;
    dispatch(&engine, restore(78, json!("2020-01-02T03:04:05"))).await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["unsettledAt"], "2020-01-02T03:04:05.000Z");
    // And `Date.parse`'s older forms.
    dispatch(&engine, cmd(87, "thread.settle", json!({}))).await;
    dispatch(&engine, restore(88, json!("Thu, 02 Jan 2020 03:04:05 GMT"))).await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["unsettledAt"], "2020-01-02T03:04:05.000Z");
    // A year past 9999 is written as `toISOString` writes it.
    dispatch(&engine, cmd(79, "thread.settle", json!({}))).await;
    dispatch(&engine, restore(80, json!("9999-12-31T23:30:00-01:00"))).await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["unsettledAt"], "+010000-01-01T00:30:00.000Z");
    let bad = engine
        .dispatch(from_json(restore(76, json!("not a time"))).unwrap())
        .await;
    let Err(EngineError::Rejected(e)) = bad else {
        panic!("an anchor that is not a time is refused");
    };
    assert!(
        to_json(&e)
            .to_string()
            .contains("unsettle anchor not a time is not a valid time"),
        "{}",
        to_json(&e)
    );
    // A delayed undo on a thread archived since is refused before its anchor is read, and
    // changes neither the log nor the projection.
    dispatch(&engine, cmd(81, "thread.settle", json!({}))).await;
    dispatch(&engine, cmd(82, "thread.archive", json!({}))).await;
    let before_shell = engine.shell_snapshot().await.unwrap();
    let before_log = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 100_000))
        .await
        .unwrap();
    for (n, at) in [
        (83, json!("2020-01-02T03:04:05.006Z")),
        (84, json!("not a time")),
    ] {
        let refused = engine.dispatch(from_json(restore(n, at)).unwrap()).await;
        let Err(EngineError::Rejected(e)) = refused else {
            panic!("an archived thread refuses an undo of its settle");
        };
        assert!(
            to_json(&e).to_string().contains("Thread t1 is archived."),
            "{}",
            to_json(&e)
        );
    }
    let after_log = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 100_000))
        .await
        .unwrap();
    assert_eq!(after_log, before_log);
    assert_eq!(engine.shell_snapshot().await.unwrap(), before_shell);
    dispatch(&engine, cmd(85, "thread.unarchive", json!({}))).await;
    dispatch(
        &engine,
        cmd(86, "thread.unsettle", json!({"reason": "user"})),
    )
    .await;

    dispatch(
        &engine,
        cmd(8, "thread.snooze", json!({"snoozedUntil": "Jan 1 2030"})),
    )
    .await;
    assert_eq!(
        row(&engine.shell_snapshot().await.unwrap())["snoozedUntil"],
        "2030-01-01T00:00:00.000Z"
    );
    dispatch(
        &engine,
        cmd(9, "thread.unsnooze", json!({"reason": "user"})),
    )
    .await;
    dispatch(
        &engine,
        cmd(10, "thread.auto-settle.set", json!({"enabled": false})),
    )
    .await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["snoozedUntil"], Value::Null);
    assert!(r["autoSettleDisabledAt"].is_string());

    dispatch(
        &engine,
        cmd(
            11,
            "thread.pull-request.link",
            json!({"host": "github.com", "repository": "o/r",
            "number": 7, "url": "https://github.com/o/r/pull/7", "source": "manual"}),
        ),
    )
    .await;
    assert_eq!(
        row(&engine.shell_snapshot().await.unwrap())["pullRequests"][0]["number"],
        7
    );
    dispatch(
        &engine,
        cmd(
            12,
            "thread.pull-request.unlink",
            json!({"host": "GitHub.com", "repository": "o/r", "number": 7}),
        ),
    )
    .await;
    assert_eq!(
        row(&engine.shell_snapshot().await.unwrap())["pullRequests"],
        json!([])
    );

    // Mark unread needs a completed run; with one, the visit moves just before it.
    let refused = engine
        .dispatch(from_json(cmd(13, "thread.mark-unread", json!({}))).unwrap())
        .await;
    assert!(matches!(refused, Err(EngineError::Rejected(_))));
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hi")).await;
    until_run_ends(&mut thread).await;
    dispatch(&engine, cmd(14, "thread.mark-unread", json!({}))).await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    let visited = crate::time::millis_from_iso(r["lastVisitedAt"].as_str().unwrap()).unwrap();
    let completed =
        crate::time::millis_from_iso(r["latestRunCompletedAt"].as_str().unwrap()).unwrap();
    assert_eq!(visited, completed - 1);

    // A provider switch takes effect between turns and drops the old provider thread.
    dispatch(
        &engine,
        cmd(
            15,
            "provider.switch",
            json!({"modelSelection": {"instanceId": "codex", "model": "gpt"}}),
        ),
    )
    .await;
    let r = row(&engine.shell_snapshot().await.unwrap());
    assert_eq!(r["providerInstanceId"], "codex");
    assert_eq!(r["activeProviderThreadId"], Value::Null);

    assert!(
        crate::commands::refusal("prepared-run.retry").contains("workspace preparation"),
        "a refused command says why"
    );
}

async fn stream_items(engine: &SqliteEngine, method: &str, input: Value, n: usize) -> Vec<Value> {
    let mut rx = engine
        .open_stream(method, input)
        .await
        .unwrap_or_else(|_| panic!("{method}"));
    let mut out = vec![];
    for _ in 0..n {
        let item = timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        out.push(item.unwrap());
    }
    out
}

#[tokio::test(flavor = "current_thread")]
async fn orchestration_reads_answer_from_the_store() {
    let db = TempDb::new("reads");
    let (engine, _) = open(&db);
    let wt = db.0.join("wt").to_string_lossy().into_owned();
    std::fs::create_dir_all(&wt).unwrap();
    for (thread, title) in [("t1", "Fix the login bug"), ("t2", "Write docs")] {
        let mut c = create(thread, &format!("create-{thread}"));
        c["title"] = json!(title);
        c["worktreePath"] = json!(wt);
        dispatch(&engine, c).await;
    }
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(
        &engine,
        message("t1", "m1", "the parser chokes on Unicode quotes"),
    )
    .await;
    until_run_ends(&mut thread).await;
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "a1", "threadId": "t2"}),
    )
    .await;

    let titles = call(
        &engine,
        "orchestration.getThreadTitles",
        json!({"threadIds": ["t1", "t2", "nope"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        titles,
        json!({"t1": "Fix the login bug", "t2": "Write docs"})
    );
    let meta = call(
        &engine,
        "orchestration.getThreadLinkMetadata",
        json!({"threadIds": ["t1"]}),
    )
    .await
    .unwrap();
    assert_eq!(meta["t1"]["projectId"], project_id());

    let archived = call(&engine, "orchestration.getArchivedShellSnapshot", json!({}))
        .await
        .unwrap();
    assert_eq!(archived["threads"][0]["id"], "t2");
    let family = call(
        &engine,
        "orchestration.getThreadFamily",
        json!({"threadId": "t1"}),
    )
    .await
    .unwrap();
    assert_eq!(family["threads"].as_array().unwrap().len(), 1);
    let ids = call(
        &engine,
        "orchestration.getWorktreeThreadIds",
        json!({"worktreePath": wt}),
    )
    .await
    .unwrap();
    assert_eq!(ids, json!({"threadIds": ["t1"]}));

    let item = call(
        &engine,
        "orchestration.getTurnItem",
        json!({"threadId": "t1", "itemId": "turn-item:message:m1"}),
    )
    .await
    .unwrap();
    assert_eq!(item["item"]["type"], "user_message");

    // Search: messages only (titles are the client's), through the trigram index.
    let found = call(
        &engine,
        "orchestration.searchThreads",
        json!({"query": "login"}),
    )
    .await
    .unwrap();
    assert_eq!(found["matches"], json!([]));
    let found = call(
        &engine,
        "orchestration.searchThreads",
        json!({"query": "UNICODE quo"}),
    )
    .await
    .unwrap();
    // One match per thread, from its newest matching message: the assistant's echo.
    assert_eq!(found["matches"].as_array().unwrap().len(), 1);
    assert_eq!(found["matches"][0]["source"], "assistant");
    assert!(
        found["matches"][0]["snippet"]
            .as_str()
            .unwrap()
            .contains("Unicode quotes")
    );
    // A two-letter Latin word searches nothing, as `messageSearchTokens` (`paletteSearch.ts`).
    let found = call(
        &engine,
        "orchestration.searchThreads",
        json!({"query": "ch", "titlesOnly": false}),
    )
    .await
    .unwrap();
    assert_eq!(found["matches"], json!([]));

    // In-thread find: "the" once in the user message, once in its echo.
    let find = call(
        &engine,
        "orchestration.searchThread",
        json!({"threadId": "t1", "query": "the"}),
    )
    .await
    .unwrap();
    assert_eq!(find["totalMatches"], 2);
    assert_eq!(
        find["match"],
        json!({"entryId": "message:m1", "runId": "run:t1:1", "occurrence": 0})
    );
    let next_hit = call(
        &engine,
        "orchestration.searchThread",
        json!({"threadId": "t1", "query": "the", "start": {"entryId": "message:m1", "occurrence": 0}, "offset": 1}),
    )
    .await
    .unwrap();
    assert_eq!(next_hit["activeIndex"], 1);
    assert_eq!(next_hit["match"]["entryId"], "message:run:t1:1:a");
    let streamed = stream_items(
        &engine,
        "orchestration.searchThreadStream",
        json!({"threadId": "t1", "query": "the"}),
        1,
    )
    .await;
    assert_eq!(streamed[0]["totalMatches"], 2);
    let suggestion = stream_items(
        &engine,
        "orchestration.subscribePromptSuggestion",
        json!({"threadId": "t1"}),
        1,
    )
    .await;
    assert_eq!(suggestion, [Value::Null]);
    assert_eq!(
        call(
            &engine,
            "orchestration.getNativeChildWork",
            json!({"threadId": "t1"})
        )
        .await
        .unwrap(),
        json!({"children": []})
    );
}

#[tokio::test(flavor = "current_thread")]
async fn older_settled_threads_page_and_trim() {
    let db = TempDb::new("settled");
    let (engine, _) = open(&db);
    for n in 0..30 {
        let id = format!("s{n:02}");
        let mut command = create(&id, &format!("c{id}"));
        // One older settled thread and one in the shell share a title word.
        match n {
            3 => command["title"] = json!("Osprey release notes"),
            27 => command["title"] = json!("Osprey launch"),
            _ => {}
        }
        dispatch(&engine, command).await;
        dispatch(
            &engine,
            json!({"type": "thread.settle", "commandId": format!("x{id}"), "threadId": id,
                   "settledAt": format!("2026-01-01T00:00:{n:02}.000Z")}),
        )
        .await;
    }
    // A bounded shell keeps the newest 25 settled threads and counts the 5 older ones.
    let mut shell = engine
        .subscribe_shell(
            from_json(json!({"omitOlderSettled": true, "omitIdleSubagents": true})).unwrap(),
        )
        .await
        .unwrap();
    let snapshot = next(&mut shell).await["snapshot"].clone();
    assert_eq!(snapshot["threads"].as_array().unwrap().len(), 25);
    assert_eq!(
        snapshot["olderSettled"]["before"],
        "2026-01-01T00:00:05.000Z"
    );
    assert_eq!(snapshot["olderSettled"]["counts"][0]["count"], 5);

    // The phone's HTTP reload trims as the socket does, and a current cursor keeps its rows.
    let query = |omit: bool, resume_from: Option<u64>| crate::HttpShellQuery {
        omit_idle_subagents: omit,
        omit_older_settled: omit,
        resume_from,
    };
    let http = engine.http_shell_snapshot(query(true, None)).await.unwrap();
    assert_eq!(http, Some(snapshot.clone()));
    let full = engine
        .http_shell_snapshot(query(false, None))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(full["threads"].as_array().unwrap().len(), 30);
    assert!(full.get("olderSettled").is_none());
    let sequence = snapshot["snapshotSequence"].as_u64().unwrap();
    assert_eq!(
        engine
            .http_shell_snapshot(query(true, Some(sequence)))
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        engine
            .http_shell_snapshot(query(true, Some(sequence + 1)))
            .await
            .unwrap(),
        Some(snapshot.clone())
    );

    let page = call(
        &engine,
        "orchestration.getOlderSettledThreads",
        json!({"before": {"settledAt": "2026-01-01T00:00:05.000Z"}, "limit": 2}),
    )
    .await
    .unwrap();
    let ids: Vec<_> = page["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(ids, [json!("s04"), json!("s03")]);
    let counts = call(
        &engine,
        "orchestration.getOlderSettledThreads",
        json!({"before": {"settledAt": "2026-01-01T00:00:05.000Z"}, "limit": 0}),
    )
    .await
    .unwrap();
    assert_eq!(counts["counts"][0]["count"], 5);

    // The scheduled-task picker searches the omitted thread by title (`searchOlderSettled`):
    // only older settled rows come back, in the requested projects.
    let search = |query: &str, projects: Value, titles_only: bool| {
        let engine = &engine;
        let query = query.to_owned();
        async move {
            call(
                engine,
                "orchestration.searchThreads",
                json!({"query": query, "titlesOnly": titles_only, "projectIds": projects,
                       "olderSettledBefore": "2026-01-01T00:00:05.000Z"}),
            )
            .await
            .unwrap()
        }
    };
    let ids = |found: &Value| -> Vec<Value> {
        found["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].clone())
            .collect()
    };
    let found = search("osprey release", json!([project_id()]), true).await;
    assert_eq!(ids(&found), [json!("s03")]);
    assert_eq!(found["matches"], json!([]));
    assert!(found["snapshotSequence"].as_u64().is_some());
    assert_eq!(
        ids(&search("Osprey", json!([project_id()]), true).await),
        [json!("s03")]
    );
    assert!(ids(&search("osprey", json!(["another-project"]), true).await).is_empty());
    // A mixed query still searches messages; without the cutoff no rows come back.
    let mixed = search("osprey notes", json!([project_id()]), false).await;
    assert_eq!(ids(&mixed), [json!("s03")]);
    let plain = call(
        &engine,
        "orchestration.searchThreads",
        json!({"query": "osprey"}),
    )
    .await
    .unwrap();
    assert!(plain.get("threads").is_none());
}

async fn settle_threads(engine: &SqliteEngine, ids: impl IntoIterator<Item = String>) {
    for (n, id) in ids.into_iter().enumerate() {
        dispatch(engine, create(&id, &format!("c{id}"))).await;
        dispatch(
            engine,
            json!({"type": "thread.settle", "commandId": format!("x{id}"), "threadId": id,
                   "settledAt": format!("2026-01-01T00:00:{n:02}.000Z")}),
        )
        .await;
    }
}

fn trimmed_query(resume_from: Option<u64>) -> crate::HttpShellQuery {
    crate::HttpShellQuery {
        omit_idle_subagents: true,
        omit_older_settled: true,
        resume_from,
    }
}

/// The trimmed shell over the socket, which the HTTP route must match.
async fn trimmed_shell(engine: &SqliteEngine) -> Value {
    let mut shell = engine
        .subscribe_shell(
            from_json(json!({"omitOlderSettled": true, "omitIdleSubagents": true})).unwrap(),
        )
        .await
        .unwrap();
    let snapshot = next(&mut shell).await["snapshot"].clone();
    let http = engine
        .http_shell_snapshot(trimmed_query(None))
        .await
        .unwrap();
    assert_eq!(http, Some(snapshot.clone()), "HTTP and the socket agree");
    snapshot
}

fn shell_ids(snapshot: &Value) -> Vec<String> {
    snapshot["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect()
}

/// `shellTrimFacts`: with fewer than 25 settled threads the oldest is the cut, so none is older.
#[tokio::test(flavor = "current_thread")]
async fn a_small_project_keeps_every_settled_thread() {
    for (settled, shown, older) in [(1, 1, 0), (24, 24, 0), (25, 25, 0), (26, 25, 1)] {
        let db = TempDb::new(&format!("settled-small-{settled}"));
        let (engine, _) = open(&db);
        settle_threads(&engine, (0..settled).map(|n| format!("s{n:02}"))).await;
        let snapshot = trimmed_shell(&engine).await;
        assert_eq!(shell_ids(&snapshot).len(), shown, "{settled} settled");
        let counted: u64 = snapshot["olderSettled"]["counts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["count"].as_u64())
            .sum();
        assert_eq!(counted, older, "{settled} settled");
        let oldest_kept = 0.max(settled as i64 - 25);
        assert_eq!(
            snapshot["olderSettled"]["before"],
            format!("2026-01-01T00:00:{oldest_kept:02}.000Z"),
            "{settled} settled"
        );
    }
}

/// `remoteTaskParentIds`: the owner of a task in a linked environment stays in a trimmed shell,
/// an idle subagent or an older settled thread alike.
#[tokio::test(flavor = "current_thread")]
async fn the_owner_of_a_remote_task_stays_in_a_trimmed_shell() {
    let db = TempDb::new("settled-remote");
    let (engine, _) = open(&db);
    settle_threads(&engine, (0..26).map(|n| format!("s{n:02}"))).await;
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, delegate("d1", "look around", None)).await;
    let child = "thread:delegated-task:d1";
    run_to_end(&engine, child, &format!("run:{child}:1")).await;
    let before = shell_ids(&trimmed_shell(&engine).await);
    assert!(!before.contains(&"s00".to_owned()));
    assert!(!before.contains(&child.to_owned()));
    for owner in ["s00", child] {
        let row = json!({"id": format!("node:remote:{owner}"), "threadId": owner,
            "origin": "app_owned", "childThreadId": null, "status": "running",
            "remoteChild": {"environmentId": "env:b", "threadId": "thread:b", "label": "B"}});
        let inner = engine.inner().clone();
        let owner = owner.to_owned();
        inner
            .write(move |tx| {
                tx.append(crate::store::Draft::new(&owner, "subagent.updated", row))
                    .map(|_| ())
            })
            .await
            .unwrap();
    }
    let after = shell_ids(&trimmed_shell(&engine).await);
    assert!(after.contains(&"s00".to_owned()), "{after:?}");
    assert!(after.contains(&child.to_owned()), "{after:?}");
}

async fn head_sequence(engine: &SqliteEngine) -> u64 {
    engine.shell_snapshot().await.unwrap()["snapshotSequence"]
        .as_u64()
        .unwrap()
}

/// `canResumeShellFrom`: at most 1,000 events and 8 MiB of them behind, for the socket and
/// the HTTP route alike.
#[tokio::test(flavor = "current_thread")]
async fn a_shell_resumes_at_most_a_thousand_events_back() {
    let db = TempDb::new("shell-resume-cap");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let append = |count: usize, output: String| {
        let inner = engine.inner().clone();
        async move {
            inner
                .write(move |tx| {
                    for n in 0..count {
                        let item = json!({"id": format!("turn-item:x{n}"), "threadId": "t1",
                            "runId": null, "nodeId": null, "providerThreadId": null,
                            "providerTurnId": null, "nativeItemRef": null, "parentItemId": null,
                            "ordinal": n, "status": "completed", "title": null, "startedAt": null,
                            "completedAt": null, "updatedAt": "2026-01-01T00:00:00.000Z",
                            "type": "command_execution", "input": "ls", "output": output});
                        tx.append(crate::store::Draft::new("t1", "turn-item.updated", item))?;
                    }
                    Ok(())
                })
                .await
                .unwrap()
        }
    };
    let resumes = |after: u64| {
        let engine = &engine;
        async move {
            let http = engine
                .http_shell_snapshot(trimmed_query(Some(after)))
                .await
                .unwrap()
                .is_none();
            let mut shell = engine
                .subscribe_shell(
                    from_json(json!({"afterSequence": after, "httpSnapshotFallback": true,
                        "requestCompletionMarker": true}))
                    .unwrap(),
                )
                .await
                .unwrap();
            let socket = next(&mut shell).await["kind"] != "snapshot-required";
            assert_eq!(http, socket, "HTTP and the socket agree at {after}");
            http
        }
    };
    let start = head_sequence(&engine).await;
    append(1001, String::new()).await;
    let head = head_sequence(&engine).await;
    assert_eq!(head - start, 1001);
    assert!(resumes(head).await);
    assert!(resumes(head - 1000).await);
    assert!(!resumes(head - 1001).await);
    // Nine events of 1 MiB each are past the budget.
    append(9, "x".repeat(1024 * 1024)).await;
    let big = head_sequence(&engine).await;
    assert!(resumes(big - 7).await);
    assert!(!resumes(big - 9).await);
}

/// `searchOlderSettled`: message hits outside the older settled rows do not use up its five.
#[tokio::test(flavor = "current_thread")]
async fn older_settled_search_skips_ineligible_message_hits() {
    let db = TempDb::new("settled-search-eligible");
    let (engine, _) = open(&db);
    let ids: Vec<String> = (0..30).map(|n| format!("s{n:02}")).collect();
    for id in &ids {
        dispatch(&engine, create(id, &format!("c{id}"))).await;
    }
    // Oldest first: the older settled thread's hit ranks below five newer ones.
    for id in ["s00", "s25", "s26", "s27", "s28", "s29"] {
        dispatch(&engine, message(id, &format!("m{id}"), "zebrafish")).await;
        run_to_end(&engine, id, &format!("run:{id}:1")).await;
    }
    for (n, id) in ids.iter().enumerate() {
        dispatch(
            &engine,
            json!({"type": "thread.settle", "commandId": format!("x{id}"), "threadId": id,
                   "settledAt": format!("2026-01-01T00:00:{n:02}.000Z")}),
        )
        .await;
    }
    let found = call(
        &engine,
        "orchestration.searchThreads",
        json!({"query": "zebrafish", "olderSettledBefore": "2026-01-01T00:00:05.000Z"}),
    )
    .await
    .unwrap();
    let threads: Vec<_> = found["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(threads, [json!("s00")], "{}", found["matches"]);
}

#[tokio::test(flavor = "current_thread")]
async fn force_stop_and_command_output() {
    let db = TempDb::new("force");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;

    // A command item that grows while it runs.
    let item = |output: &str, status: &str| {
        json!({"id": "turn-item:cmd", "threadId": "t1", "runId": "run:t1:1", "nodeId": "node:run:t1:1:root",
            "providerThreadId": null, "providerTurnId": null, "nativeItemRef": null, "parentItemId": null,
            "ordinal": 0, "status": status, "title": null, "startedAt": "2026-01-01T00:00:00.000Z",
            "completedAt": null, "updatedAt": "2026-01-01T00:00:00.000Z", "type": "command_execution",
            "input": "ls", "output": output})
    };
    let write = |value: Value| {
        let inner = engine.inner().clone();
        async move {
            inner
                .write(move |tx| {
                    tx.append(crate::store::Draft::new("t1", "turn-item.updated", value))
                        .map(|_| ())
                })
                .await
                .unwrap()
        }
    };
    write(item("a\n", "running")).await;
    let mut output = engine
        .open_stream(
            "orchestration.subscribeCommandOutput",
            json!({"threadId": "t1", "itemId": "turn-item:cmd"}),
        )
        .await
        .unwrap();
    assert_eq!(
        frame(&mut output).await,
        json!({"kind": "replace", "text": "a\n", "truncated": false, "running": true})
    );
    write(item("a\nb\n", "completed")).await;
    assert_eq!(
        frame(&mut output).await,
        json!({"kind": "append", "text": "b\n", "truncated": false, "running": false})
    );
    assert!(output.recv().await.is_none());
    let missing = engine
        .open_stream(
            "orchestration.subscribeCommandOutput",
            json!({"threadId": "t1", "itemId": "nope"}),
        )
        .await;
    assert!(matches!(missing, Err(EngineError::Rejected(_))));

    let superseded = call(
        &engine,
        "orchestration.forceStopThread",
        json!({"threadId": "t1", "runId": "run:t1:9"}),
    )
    .await
    .unwrap_err();
    assert_eq!(superseded["reason"], "superseded");
    let stopped = call(
        &engine,
        "orchestration.forceStopThread",
        json!({"threadId": "t1"}),
    )
    .await
    .unwrap();
    assert_eq!(stopped["outcome"], "killed");
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][0]["status"], "interrupted");
}

async fn frame(rx: &mut Subscription<Value, Value>) -> Value {
    timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

fn delegate(command: &str, task: &str, wake: Option<&str>) -> Value {
    let mut c = json!({
        "type": "delegated_task.request", "commandId": command, "parentThreadId": "t1",
        "parentRunId": "run:t1:1", "parentNodeId": "node:run:t1:1:root", "task": task,
        "title": "Helper", "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "createdBy": "agent", "creationSource": "mcp",
    });
    if let Some(wake) = wake {
        c["completionWake"] = json!(wake);
    }
    c
}

async fn run_to_end(engine: &SqliteEngine, thread: &str, run: &str) -> Value {
    let ended = |r: &Value| {
        ["completed", "interrupted", "failed", "cancelled"]
            .contains(&r["status"].as_str().unwrap_or(""))
    };
    // Subscribe first, so an end after the snapshot still arrives as an event.
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": thread})).unwrap())
        .await
        .unwrap();
    let snapshot = next(&mut stream).await;
    let done = snapshot["projection"]["runs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == run && ended(r));
    if done {
        return projection(engine, thread).await;
    }
    loop {
        let item = next(&mut stream).await;
        let payload = &item["event"]["payload"];
        if item["event"]["type"] == "run.updated" && payload["id"] == run && ended(payload) {
            break;
        }
    }
    projection(engine, thread).await
}

/// #327's review: a child whose run completed while its provider-native subagent still
/// worked keeps its task open. A restart cancels that orphaned subagent, and the task then
/// reaches its parent, though the child has no unfinished run (`recoverDelegatedTasks`).
#[tokio::test(flavor = "current_thread")]
async fn a_restart_publishes_a_task_its_orphaned_native_subagent_held() {
    let db = TempDb::new("restart-orphan-task");
    let child = "thread:delegated-task:d1";
    let task = "node:delegated-task:d1";
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        let mut parent = engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .unwrap();
        next(&mut parent).await;
        dispatch(&engine, message("t1", "c2", "hang")).await;
        until_provider_turn(&mut parent).await;
        dispatch(&engine, delegate("d1", "hang", None)).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": child})).unwrap())
            .await
            .unwrap();
        next(&mut thread).await;
        until_provider_turn(&mut thread).await;
        let run = format!("run:{child}:1");
        engine
            .inner()
            .write(move |tx| {
                let now = tx.now().to_owned();
                tx.append(crate::store::Draft::new(
                    child,
                    "subagent.updated",
                    json!({"id": "node:native", "threadId": child, "runId": run,
                        "parentNodeId": null, "origin": "provider_native", "createdBy": "agent",
                        "driver": "claudeAgent", "providerInstanceId": "claudeAgent",
                        "providerThreadId": null, "childThreadId": null, "prompt": "p",
                        "title": "native", "model": null, "status": "running", "result": null,
                        "startedAt": now, "completedAt": null, "updatedAt": now}),
                ))?;
                Ok(())
            })
            .await
            .unwrap();
        dispatch(
            &engine,
            message_with(
                child,
                "s1",
                "finish",
                json!({"type": "start_immediately"}),
                Some("steer"),
            ),
        )
        .await;
        until_run_ends(&mut thread).await;
        let row = &projection(&engine, "t1").await["subagents"][0];
        assert_eq!(row["id"], task);
        assert!(
            row["completedAt"].is_null(),
            "the native subagent holds it: {row}"
        );
    }
    let (engine, _) = open(&db);
    let row = &projection(&engine, "t1").await["subagents"][0];
    assert_eq!(row["status"], "completed", "{row}");
    assert_eq!(row["result"], "steered: finish");
}

#[tokio::test(flavor = "current_thread")]
async fn a_delegated_task_runs_as_a_child_thread_and_wakes_its_parent() {
    let db = TempDb::new("delegate");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;

    // `settled_only` (the default): the parent is busy, so the result waits.
    dispatch(&engine, delegate("d1", "look around", None)).await;
    let child = "thread:delegated-task:d1";
    let task = "node:delegated-task:d1";
    let p = run_to_end(&engine, child, &format!("run:{child}:1")).await;
    assert_eq!(p["thread"]["lineage"]["parentThreadId"], "t1");
    assert_eq!(p["thread"]["lineage"]["relationshipToParent"], "subagent");
    assert_eq!(p["thread"]["forkedFrom"]["nodeId"], task);
    let parent = projection(&engine, "t1").await;
    let row = &parent["subagents"][0];
    assert_eq!(row["childThreadId"], child);
    assert_eq!(row["status"], "completed");
    assert_eq!(row["result"], "echo: look around");
    assert_eq!(row["completionDelivery"]["state"], "pending");
    // The shell counts the parent's subagents, as T3's `subagentCount`; a child has none.
    let shells = engine
        .inner()
        .db(move |store| {
            let tx = store.tx()?;
            let rows = (
                crate::shell::thread_shell(&tx, "t1")?,
                crate::shell::thread_shell(&tx, child)?,
            );
            tx.rollback();
            Ok::<_, String>(rows)
        })
        .await
        .unwrap();
    assert_eq!(shells.0["subagentCount"], 1);
    assert!(shells.1.get("subagentCount").is_none());
    let item = parent["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "subagent")
        .unwrap()
        .clone();
    assert_eq!(item["result"], "echo: look around");
    assert_eq!(
        run_statuses(&parent).len(),
        1,
        "no wake while the parent runs"
    );

    // The family read and the shell show the child.
    let family = call(
        &engine,
        "orchestration.getThreadFamily",
        json!({"threadId": child}),
    )
    .await
    .unwrap();
    let ids: Vec<_> = family["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(ids.len(), 2, "{ids:?}");

    // `always`: a second task wakes the busy parent at once, queued behind its turn.
    dispatch(&engine, delegate("d2", "second", Some("always"))).await;
    run_to_end(
        &engine,
        "thread:delegated-task:d2",
        "run:thread:delegated-task:d2:1",
    )
    .await;
    let parent = projection(&engine, "t1").await;
    assert_eq!(parent["runs"][1]["status"], "queued");
    let wake = parent["messages"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(wake["createdBy"], "agent");
    assert!(
        wake["text"].as_str().unwrap().starts_with(
            "Delegated task node:delegated-task:d2 (Helper) [completed]:\necho: second"
        )
    );

    // When the parent's turn ends, the queued wake runs and the first task is delivered too.
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c3", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    let parent = run_to_end(&engine, "t1", "run:t1:3").await;
    let deliveries: Vec<_> = parent["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["completionDelivery"]["state"].clone())
        .collect();
    assert_eq!(deliveries, [json!("delivered"), json!("delivered")]);
    let texts: Vec<String> = parent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["createdBy"] == "agent" && m["role"] == "user")
        .map(|m| m["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(texts.len(), 2);
    assert!(texts.iter().any(|t| t.contains("echo: look around")));
}

#[tokio::test(flavor = "current_thread")]
async fn stopping_a_parent_stops_its_children_without_a_wake() {
    let db = TempDb::new("delegate-stop");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, delegate("d1", "hang", Some("always"))).await;
    let child = "thread:delegated-task:d1";
    let mut child_stream = engine
        .subscribe_thread(from_json(json!({"threadId": child})).unwrap())
        .await
        .unwrap();
    next(&mut child_stream).await;
    loop {
        let item = next(&mut child_stream).await;
        if item["event"]["type"] == "provider-turn.updated" {
            break;
        }
    }
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "s1", "threadId": "t1"}),
    )
    .await;
    run_to_end(&engine, child, &format!("run:{child}:1")).await;
    let parent = run_to_end(&engine, "t1", "run:t1:1").await;
    let row = &parent["subagents"][0];
    assert_eq!(row["status"], "interrupted");
    assert_eq!(row["completionDelivery"]["state"], "disposed");
    assert_eq!(
        run_statuses(&parent).len(),
        1,
        "a stopped parent gets no wake"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn compact_snapshots_for_clients_that_opt_in() {
    let db = TempDb::new("compact");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let mut thread = engine
        .subscribe_thread(
            from_json(json!({"threadId": "t1", "acceptDedupedBodies": true, "acceptCompactTurnItems": true}))
                .unwrap(),
        )
        .await
        .unwrap();
    let snapshot = next(&mut thread).await;
    assert_eq!(snapshot["turnItemsOmitLocalVisible"], true);
    assert_eq!(snapshot["projection"]["turnItems"], json!([]));
    let rows = snapshot["projection"]["visibleTurnItems"]
        .as_array()
        .unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        assert_eq!(row["item"]["text"], "");
        assert_eq!(row["item"]["textOmitted"], true);
    }
    assert_eq!(snapshot["projection"]["messages"][1]["text"], "echo: hello");
}

/// A clock on tokio's paused time, so the idle tests move it with `sleep`, and the server's
/// own reaper loop runs as it does in production.
struct PausedClock(tokio::time::Instant);

impl crate::Clock for PausedClock {
    fn now_millis(&self) -> u64 {
        u64::try_from(self.0.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

fn paused_clock() -> Arc<dyn crate::Clock> {
    Arc::new(PausedClock(tokio::time::Instant::now()))
}

/// Paused tokio time plus a wall-clock jump, as a container sees on wake after Orbit froze
/// it with a still monotonic clock.
struct JumpClock {
    start: tokio::time::Instant,
    jumped: std::sync::atomic::AtomicU64,
}

impl crate::Clock for JumpClock {
    fn now_millis(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis())
            .unwrap_or(u64::MAX)
            .saturating_add(self.jumped.load(std::sync::atomic::Ordering::SeqCst))
    }
}

impl JumpClock {
    fn jump(&self, by: Duration) {
        let by = u64::try_from(by.as_millis()).unwrap_or(u64::MAX);
        self.jumped
            .fetch_add(by, std::sync::atomic::Ordering::SeqCst);
    }
}

/// An engine with T3's idle limits (30 minutes, a 4-hour hold) on a [`JumpClock`].
async fn engine_on_jump_clock(name: &str, first: &str) -> (TempDb, SqliteEngine, Arc<JumpClock>) {
    let db = TempDb::new(name);
    let clock = Arc::new(JumpClock {
        start: tokio::time::Instant::now(),
        jumped: std::sync::atomic::AtomicU64::new(0),
    });
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.clock = clock.clone();
    config.idle_session = Some(Duration::from_secs(30 * 60));
    config.idle_max_hold = Duration::from_secs(4 * 60 * 60);
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", first)).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    (db, engine, clock)
}

/// The idle release reads the engine's wall clock when the reaper wakes (every 15 minutes
/// of monotonic time). After a wall jump with a still monotonic clock, the jump counts as
/// idle time: 10 minutes plus one 15-minute reaper wait keeps the session; 2 hours or
/// 3 days release it at that wait. T3 waits on `Effect.sleep(idleTimeoutMs)`
/// (`ProviderSessionManager.ts`), monotonic, so there it would wait 30 minutes after the
/// thaw. With a monotonic clock that ran on, both release at the thaw.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_idle_session_after_a_wall_clock_jump() {
    for (jump, live) in [(10 * 60, 1), (2 * 3600, 0), (3 * 86_400, 0)] {
        let (_db, engine, clock) = engine_on_jump_clock("idle-jump", "first").await;
        clock.jump(Duration::from_secs(jump));
        tokio::time::sleep(Duration::from_secs(15 * 60 + 1)).await;
        assert_eq!(engine.inner().live_count(), live, "+{jump}s");
    }
}

/// Background work holds an idle session up to 4 hours from the first idle check that finds
/// it, by the wall clock, as T3's `pinnedSinceMs` (`Clock.currentTimeMillis`). A 2-hour
/// jump starts the hold; a 3-day jump after it ends the hold at the next reaper wait.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn background_work_holds_through_a_jump_until_the_wall_clock_passes_the_hold() {
    let (_db, engine, clock) = engine_on_jump_clock("idle-hold-jump", "background-hold").await;
    clock.jump(Duration::from_secs(10 * 60));
    tokio::time::sleep(Duration::from_secs(15 * 60 + 1)).await;
    assert_eq!(engine.inner().live_count(), 1, "+10 minutes: not idle yet");
    clock.jump(Duration::from_secs(2 * 3600));
    tokio::time::sleep(Duration::from_secs(15 * 60)).await;
    assert_eq!(engine.inner().live_count(), 1, "+2 hours: held");
    clock.jump(Duration::from_secs(3 * 86_400));
    tokio::time::sleep(Duration::from_secs(15 * 60)).await;
    assert_eq!(engine.inner().live_count(), 0, "+3 days: the hold is over");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_idle_session_closes_and_the_next_turn_resumes_it() {
    let db = TempDb::new("idle");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.clock = paused_clock();
    config.idle_session = Some(Duration::from_secs(60));
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "first")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(engine.inner().live_count(), 1);

    // The paused clock jumps past the idle limit; the reaper closes the session.
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(engine.inner().live_count(), 0);
    // T3's release record: the session's row says it stopped.
    let p = projection(&engine, "t1").await;
    assert_eq!(
        p["providerSessions"][0]["status"], "stopped",
        "{}",
        p["providerSessions"]
    );

    dispatch(&engine, message("t1", "c3", "second")).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][1]["status"], "completed");
    assert_eq!(p["runs"][1]["providerThreadId"], "provider-thread:t1");
    assert_eq!(
        provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

struct ScriptedTitles;

impl crate::TitleGenerator for ScriptedTitles {
    fn generate(
        &self,
        request: crate::TitleRequest,
    ) -> crate::BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            match request.kind {
                crate::TitleKind::Initial { message } => Ok(format!("\"About {}\"", message.text)),
                crate::TitleKind::Regenerate { messages, .. } => {
                    Err(format!("model busy\nsaw {} messages", messages.len()))
                }
            }
        })
    }
}

#[tokio::test(flavor = "current_thread")]
async fn titles_come_from_the_generator_and_failures_keep_the_seed() {
    let db = TempDb::new("titles");
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.title_generator = Some(Arc::new(ScriptedTitles));
    let engine = SqliteEngine::open(config).unwrap();
    let mut shell = engine
        .subscribe_shell(from_json(json!({"requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    next(&mut shell).await;
    next(&mut shell).await;
    engine
        .launch_thread(json!({
            "commandId": "l1", "threadId": "t1", "projectId": project_id(), "title": "Seed title",
            "generateTitle": true, "modelSelection": {"instanceId": "claudeAgent", "model": "m"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "workspaceStrategy": {"type": "root"},
            "initialMessage": {"messageId": "m1", "text": "fonts", "attachments": []},
        }))
        .await
        .unwrap();
    // The shell shows the seed while the title is generated, then the generated title.
    let mut titles = vec![];
    while titles.last() != Some(&json!("About fonts")) {
        let row = next(&mut shell).await;
        if row["kind"] == "thread.updated" {
            titles.push(row["thread"]["title"].clone());
        }
    }
    assert_eq!(titles.first(), Some(&json!("Seed title")));
    let thread = projection(&engine, "t1").await["thread"].clone();
    assert_eq!(thread["titleRegeneration"], Value::Null);

    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "r1", "threadId": "t1", "regenerateTitle": true}),
    )
    .await;
    loop {
        let row = next(&mut shell).await;
        if row["thread"]["lastTitleRegeneration"].is_object() {
            assert_eq!(row["thread"]["title"], "About fonts");
            assert_eq!(row["thread"]["lastTitleRegeneration"]["status"], "failed");
            assert!(
                row["thread"]["lastTitleRegeneration"]["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("saw ")
            );
            assert_eq!(row["thread"]["titleRegeneration"], Value::Null);
            break;
        }
    }
}

#[derive(Default)]
struct RecordingObserver(std::sync::Mutex<Vec<String>>, tokio::sync::Notify);

impl crate::TurnObserver for RecordingObserver {
    fn turn_started(&self, point: crate::TurnPoint) -> crate::BoxFuture<'_, ()> {
        Box::pin(async move {
            self.0.lock().unwrap().push(format!(
                "start {} {} {:?}",
                point.run_id, point.run_ordinal, point.cwd
            ));
        })
    }
    fn turn_ended(&self, point: crate::TurnPoint, status: String) -> crate::BoxFuture<'_, ()> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap()
                .push(format!("end {} {status}", point.run_id));
            self.1.notify_one();
        })
    }
}

#[tokio::test(flavor = "current_thread")]
async fn the_turn_observer_sees_each_turn_start_and_end() {
    let db = TempDb::new("observer");
    let observer = Arc::new(RecordingObserver::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.turn_observer = Some(observer.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "one")).await;
    until_run_ends(&mut thread).await;
    observer.1.notified().await;
    dispatch(&engine, message("t1", "c3", "hang")).await;
    until_provider_turn(&mut thread).await;
    // A queued message never started, so the observer never hears of it.
    dispatch(&engine, message("t1", "c4", "later")).await;
    dispatch(
        &engine,
        json!({"type": "queued-run.cancel", "commandId": "c5", "threadId": "t1", "runId": "run:t1:3"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c6", "threadId": "t1", "runId": "run:t1:2"}),
    )
    .await;
    observer.1.notified().await;
    assert_eq!(
        *observer.0.lock().unwrap(),
        [
            format!("start run:t1:1 1 Some(\"{ROOT}\")"),
            "end run:t1:1 completed".to_owned(),
            format!("start run:t1:2 2 Some(\"{ROOT}\")"),
            "end run:t1:2 interrupted".to_owned(),
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_steer_sent_before_the_provider_turn_runs_waits_then_steers() {
    let db = TempDb::new("steer-deferred");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    // Both commands land before the turn's start effect runs, so the run is still `starting`.
    dispatch(&engine, message("t1", "c2", "hang")).await;
    dispatch(
        &engine,
        message_with(
            "t1",
            "c3",
            "early",
            json!({"type": "start_immediately"}),
            Some("steer"),
        ),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][1]["status"], "queued");
    assert_eq!(p["runs"][1]["steerWhenReadyRunId"], "run:t1:1");
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "completed".into()),
            ("run:t1:2".into(), "cancelled".into())
        ]
    );
    assert_eq!(
        item_texts(&p),
        [
            "turn_start hang",
            "promoted_queued_to_steer early",
            "assistant_message steered: early"
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_subagent_writes_to_its_own_child_thread() {
    let db = TempDb::new("subagent");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "subagent")).await;
    let parent = run_to_end(&engine, "t1", "run:t1:1").await;
    let child = projection(&engine, "child:run:t1:1").await;
    assert_eq!(child["thread"]["lineage"]["parentThreadId"], "t1");
    assert_eq!(
        child["thread"]["lineage"]["relationshipToParent"],
        "subagent"
    );
    let texts = |p: &Value| -> Vec<String> {
        p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["text"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(texts(&child), ["do the sub task"]);
    assert_eq!(child["messages"][0]["runId"], Value::Null);
    assert_eq!(texts(&parent), ["subagent", "delegated"]);
}

#[tokio::test(flavor = "current_thread")]
async fn a_steer_status_moves_the_user_item() {
    let db = TempDb::new("steer-status");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(
        &engine,
        message_with(
            "t1",
            "c3",
            "also this",
            json!({"type": "start_immediately"}),
            Some("steer"),
        ),
    )
    .await;
    let seen = until_run_ends(&mut thread).await;
    let steer_item: Vec<&str> = seen
        .iter()
        .filter(|(ty, p)| ty == "turn-item.updated" && p["id"] == "turn-item:message:c3")
        .map(|(_, p)| p["status"].as_str().unwrap())
        .collect();
    assert_eq!(steer_item, ["completed", "pending", "completed"]);
}

/// Codex's wakes carry their whole text (`delivery: "message_text"`): T3's
/// `ProviderContinuationService` then creates the message as the server's, not the
/// provider's, with the provider's notice, and its turn sends that text.
#[tokio::test(flavor = "current_thread")]
async fn a_message_text_wake_is_the_servers_message() {
    let db = TempDb::new("continuation-text");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "background-text")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    let wake = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["createdBy"] == "agent" && m["role"] == "user")
        .unwrap();
    assert_eq!(wake["creationSource"], "server");
    assert_eq!(wake["text"], "Subagent completed: helper");
    assert_eq!(
        wake["notification"]["summary"],
        "Subagent \"helper\" finished"
    );
    assert!(
        p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "echo: Subagent completed: helper"),
        "the wake turn sent its text"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_continuation_request_runs_a_provider_turn_after_the_run() {
    let db = TempDb::new("continuation");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "background")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "completed".into()),
            ("run:t1:2".into(), "completed".into())
        ]
    );
    // T3 lists messages by the turn item that shows them; the wake has a notification item,
    // so it is found by its source, not by its place.
    let wake = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["creationSource"] == "provider" && m["role"] == "user")
        .unwrap();
    assert_eq!(wake["createdBy"], "agent");
    assert_eq!(wake["creationSource"], "provider");
    assert_eq!(wake["text"], "Background task completed.");
    // `ProviderContinuationService`: the wake carries its default notification, and the
    // client shows it as a notice (a `notification` turn item), not as a user message.
    let notice = json!({
        "source": {"kind": "background_task"},
        "outcome": "updated",
        "summary": "Background activity updated",
    });
    assert_eq!(
        wake["notification"], notice,
        "the wake message names its notification"
    );
    let wake_id = wake["id"].as_str().unwrap();
    let items: Vec<&Value> = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["id"] == format!("turn-item:{wake_id}"))
        .collect();
    assert_eq!(items.len(), 1, "one turn item for the wake: {items:?}");
    let item = items[0];
    assert_eq!(item["type"], "notification", "{item}");
    assert_eq!(item["source"], notice["source"]);
    assert_eq!(item["outcome"], "updated");
    assert_eq!(item["summary"], "Background activity updated");
    assert_eq!(item["status"], "completed");
    assert!(item.get("text").is_none(), "a notice has no text: {item}");
    assert!(
        item.get("messageId").is_none(),
        "a notice names no message: {item}"
    );
    // The wake run's answer has a message item, so it comes before the notice.
    assert!(
        p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["text"] == "continued" && m["role"] == "assistant")
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn background_work_holds_an_idle_session_up_to_the_limit() {
    let db = TempDb::new("idle-hold");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.clock = paused_clock();
    config.idle_session = Some(Duration::from_secs(60));
    config.idle_max_hold = Duration::from_secs(600);
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "background-hold")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;

    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(engine.inner().live_count(), 1, "held by background work");
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(
        engine.inner().live_count(),
        0,
        "released after the hold limit"
    );
}

/// `background_work.updated` (pending) holds an idle session as the provider's own probe does,
/// and the shell row lists the still-running background command as T3's
/// `derivePendingBackgroundWork` does: `/mcp` and the client read it there.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn reported_background_work_holds_the_session_and_shows_in_the_shell() {
    let db = TempDb::new("bg-reported");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.clock = paused_clock();
    config.idle_session = Some(Duration::from_secs(60));
    config.idle_max_hold = Duration::from_secs(600);
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "background-reported")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;

    let shell = engine
        .inner()
        .db(|store| {
            let tx = store.tx()?;
            let row = crate::shell::thread_shell(&tx, "t1");
            tx.rollback();
            row
        })
        .await
        .unwrap();
    assert_eq!(
        shell["pendingBackgroundTasks"],
        json!([{"taskId": "bg-1", "description": "sleep 600", "kind": "command"}])
    );
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(
        engine.inner().live_count(),
        1,
        "held by reported background work"
    );
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(
        engine.inner().live_count(),
        0,
        "released after the hold limit"
    );
}

#[derive(Default)]
struct RecordingHost {
    sessions: Mutex<Vec<crate::AgentSession>>,
    revoked: Mutex<Vec<String>>,
    released: Mutex<Vec<Value>>,
    /// Attachments each claim was asked for, in order.
    claims: Mutex<Vec<Value>>,
    /// Attachments each whole-response limit check saw, in order.
    limit_checks: Mutex<Vec<Value>>,
    /// Ids each attachment cleanup removed, in order.
    deleted: Mutex<Vec<Vec<String>>>,
    deleted_event: tokio::sync::Notify,
    closed: Mutex<Vec<(String, crate::ThreadClose)>>,
    html_cleanup: Mutex<Vec<(String, String)>>,
    closed_event: tokio::sync::Notify,
    /// The next `thread_closed` ends only once this is sent (or dropped).
    close_hold: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    /// How many next `thread_closed` calls fail.
    close_failures: std::sync::atomic::AtomicU32,
}

impl crate::EngineHost for RecordingHost {
    fn agent_tools(&self, session: crate::AgentSession) -> Option<crate::AgentTools> {
        self.sessions.lock().unwrap().push(session.clone());
        Some(crate::AgentTools {
            servers: vec![conn_provider::McpServer {
                device_tools: false,
                name: "conn".into(),
                url: "http://127.0.0.1:1/mcp".into(),
                headers: vec![(
                    "Authorization".into(),
                    format!("Bearer {}", session.thread_id),
                )],
            }],
            key: format!("key:{}", session.thread_id),
        })
    }
    fn agent_tools_fit(&self, session: &crate::AgentSession, key: &str) -> bool {
        key == format!("key:{}", session.thread_id)
            && !self.revoked.lock().unwrap().iter().any(|k| k == key)
    }
    fn session_closed(&self, key: &str) {
        self.revoked.lock().unwrap().push(key.to_owned());
    }
    fn claim_attachments(
        &self,
        thread_id: String,
        attachments: Value,
    ) -> crate::BoxFuture<'_, Result<Value, String>> {
        self.claims.lock().unwrap().push(attachments.clone());
        Box::pin(async move {
            let list = attachments.as_array().unwrap();
            if (1..list.len()).any(|i| list[..i].iter().any(|a| a["id"] == list[i]["id"])) {
                return Err("Duplicate attachment ids are not allowed.".into());
            }
            let claimed: Vec<Value> = attachments
                .as_array()
                .unwrap()
                .iter()
                .map(|a| {
                    let mut a = a.clone();
                    let id = a["id"].as_str().unwrap().replace("pending", &thread_id);
                    a["id"] = json!(id);
                    a
                })
                .collect();
            Ok(json!(claimed))
        })
    }
    fn release_attachments(&self, attachments: Value) -> crate::BoxFuture<'_, ()> {
        self.released.lock().unwrap().push(attachments);
        Box::pin(async {})
    }
    fn check_attachment_limits(
        &self,
        attachments: Value,
    ) -> crate::BoxFuture<'_, Result<(), String>> {
        self.limit_checks.lock().unwrap().push(attachments);
        Box::pin(async { Ok(()) })
    }
    fn delete_attachments(&self, ids: Vec<String>) -> crate::BoxFuture<'_, ()> {
        self.deleted.lock().unwrap().push(ids);
        self.deleted_event.notify_one();
        Box::pin(async {})
    }
    /// A saved file whose id starts with `gone` was removed.
    fn check_retained_attachments(
        &self,
        attachments: Value,
    ) -> crate::BoxFuture<'_, Result<(), String>> {
        let gone = attachments
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"].as_str().unwrap().starts_with("gone"));
        Box::pin(async move {
            if gone {
                Err("Attachment 'old.txt' cannot be sent: attachment not found.".into())
            } else {
                Ok(())
            }
        })
    }
    fn attachment_references(
        &self,
        attachments: Value,
    ) -> crate::BoxFuture<'_, Result<Vec<String>, String>> {
        let lines = attachments
            .as_array()
            .unwrap()
            .iter()
            .map(|a| format!("saved at /files/{}", a["id"].as_str().unwrap()))
            .collect();
        Box::pin(async move { Ok(lines) })
    }
    fn cleanup_html_attachments(&self, ids: Vec<(String, String)>) -> crate::BoxFuture<'_, ()> {
        self.html_cleanup.lock().unwrap().extend(ids);
        Box::pin(async {})
    }
    fn thread_closed(
        &self,
        thread_id: &str,
        reason: crate::ThreadClose,
    ) -> crate::BoxFuture<'_, Result<(), String>> {
        self.closed
            .lock()
            .unwrap()
            .push((thread_id.to_owned(), reason));
        self.closed_event.notify_one();
        let hold = crate::lock(&self.close_hold).take();
        let failed = self
            .close_failures
            .try_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |left| left.checked_sub(1),
            )
            .is_ok();
        Box::pin(async move {
            if let Some(hold) = hold {
                let _ = hold.await;
            }
            if failed {
                return Err("the host could not clean up".to_owned());
            }
            Ok(())
        })
    }
}

#[tokio::test(flavor = "current_thread")]
async fn the_host_grants_tools_claims_attachments_and_hears_closes() {
    let db = TempDb::new("host");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.host = Some(host.clone());
    let clock = Arc::new(crate::ManualClock::at(1_800_000_000_000));
    config.clock = clock.clone();
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let image = json!({"type": "image", "id": "pending-1", "name": "a.png",
        "mimeType": "image/png", "sizeBytes": 3});
    let mut first = message("t1", "c2", "look");
    first["attachments"] = json!([image]);
    dispatch(&engine, first).await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(p["messages"][0]["attachments"][0]["id"], "t1-1");
    assert_eq!(provider.mcp_servers.lock().unwrap()[0].name, "conn");
    assert_eq!(
        host.sessions.lock().unwrap()[0].project_id.as_deref(),
        Some(project_id().as_str())
    );

    // A refused message gives its claimed files back.
    let mut refused = message("missing", "c3", "nope");
    refused["attachments"] = json!([image]);
    assert!(engine.dispatch(from_json(refused).unwrap()).await.is_err());
    assert_eq!(host.released.lock().unwrap()[0][0]["id"], "missing-1");

    engine.inner().db(|store| {
        let mut tx = store.tx()?;
        tx.append(crate::store::Draft::new("t1", "turn-item.updated", json!({"id":"page", "type":"dynamic_tool", "toolName":"html_render", "output":{"htmlRender":{"attachmentId":"t1-00000000-0000-4000-8000-000000000001-html", "title":"Page", "height":100}}})))?;
        tx.commit(None)
    }).await.unwrap();
    // Each settle names its settlement by the committed `settledAt`: a repeat keeps it, and
    // a settlement after an unsettle is a new one.
    for (command, kind) in [
        ("s1", "thread.settle"),
        ("s2", "thread.settle"),
        ("s3", "thread.unsettle"),
        ("s4", "thread.settle"),
    ] {
        clock.advance(Duration::from_secs(1));
        dispatch(
            &engine,
            json!({"type": kind, "commandId": command, "threadId": "t1", "reason": "user"}),
        )
        .await;
    }
    while host.closed.lock().unwrap().len() < 3 {
        host.closed_event.notified().await;
    }
    let settled: Vec<_> = host
        .closed
        .lock()
        .unwrap()
        .drain(..)
        .map(|(_, c)| c)
        .collect();
    let at =
        |seconds: i64| conn_support::time::iso_from_millis(1_800_000_000_000 + seconds * 1_000);
    assert_eq!(
        settled,
        [
            crate::ThreadClose::Settled { settled_at: at(1) },
            crate::ThreadClose::SettledAgain { settled_at: at(1) },
            crate::ThreadClose::Settled { settled_at: at(4) },
        ]
    );
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "c4", "threadId": "t1"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.delete", "commandId": "c5", "threadId": "t1"}),
    )
    .await;
    while host.closed.lock().unwrap().len() < 2 {
        host.closed_event.notified().await;
    }
    assert_eq!(
        *host.closed.lock().unwrap(),
        [
            ("t1".to_owned(), crate::ThreadClose::Archived),
            ("t1".to_owned(), crate::ThreadClose::Deleted)
        ]
    );
    assert_eq!(
        *host.html_cleanup.lock().unwrap(),
        [(
            "t1".into(),
            "t1-00000000-0000-4000-8000-000000000001-html".into()
        )]
    );
    assert_eq!(*host.revoked.lock().unwrap(), ["key:t1"]);
}

/// A workspace handoff releases the per-thread provider process and revokes its MCP
/// credential, as T3's `releaseEntry` does; the continuation's session gets a new one.
#[tokio::test(flavor = "current_thread")]
async fn a_workspace_handoff_revokes_the_old_session_tools() {
    let db = TempDb::new("handoff-revokes");
    let worktree = db.0.join("handoff-worktree").to_string_lossy().into_owned();
    std::fs::create_dir_all(&worktree).unwrap();
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    assert!(host.revoked.lock().unwrap().is_empty());

    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "c3", "threadId": "t1",
               "worktreePath": worktree, "expectedWorktreePath": null,
               "continuation": {"messageId": "m-next", "text": "hang"}}),
    )
    .await;
    timeout(Duration::from_secs(10), async {
        while host.revoked.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the handoff revokes the old session's tools");
    assert_eq!(*host.revoked.lock().unwrap(), ["key:t1"]);
}

/// On a process shared by several threads (Codex's `app-server`), a handoff keeps the old
/// session's credential and the continuation reuses it, as T3 does; it is revoked once the
/// shared process ends.
#[tokio::test(flavor = "current_thread")]
async fn a_handoff_on_a_shared_process_keeps_and_reuses_the_tools() {
    let db = TempDb::new("handoff-shared");
    let worktree = db.0.join("handoff-worktree").to_string_lossy().into_owned();
    std::fs::create_dir_all(&worktree).unwrap();
    let provider = Arc::new(FakeProvider::new("claudeAgent").with_shared_runtime());
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    let mut first = Vec::new();
    for (thread, command) in [("t1", "c1"), ("t2", "c2")] {
        dispatch(&engine, create(thread, command)).await;
        let mut events = engine
            .subscribe_thread(from_json(json!({"threadId": thread})).unwrap())
            .await
            .unwrap();
        next(&mut events).await;
        dispatch(&engine, message(thread, &format!("{command}-m"), "hang")).await;
        until_provider_turn(&mut events).await;
        if thread == "t1" {
            first = provider.mcp_servers.lock().unwrap().clone();
        }
    }
    assert_eq!(host.sessions.lock().unwrap().len(), 2);

    dispatch(
        &engine,
        json!({"type": "thread.metadata.update", "commandId": "c3", "threadId": "t1",
               "worktreePath": worktree, "expectedWorktreePath": null,
               "continuation": {"messageId": "m-next", "text": "go on"}}),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][1]["status"], "completed", "the continuation ran");
    assert!(
        host.revoked.lock().unwrap().is_empty(),
        "the shared process keeps it"
    );
    assert_eq!(
        host.sessions.lock().unwrap().len(),
        2,
        "the continuation reuses the credential"
    );
    assert_eq!(*provider.mcp_servers.lock().unwrap(), first);

    // t1 closes while t2 keeps the process; then t2 closes and the process ends.
    engine.inner().close_session("t1").await;
    assert!(host.revoked.lock().unwrap().is_empty());
    *provider.closes_as.lock().unwrap() = conn_provider::Closed::RuntimeStopped;
    engine.inner().close_session("t2").await;
    let mut revoked = host.revoked.lock().unwrap().clone();
    revoked.sort();
    assert_eq!(revoked, ["key:t1", "key:t2"]);
}

/// Two fake providers, `claudeAgent` and `codex`, as a server with both configured.
fn open_two(db: &TempDb) -> (SqliteEngine, Arc<FakeProvider>, Arc<FakeProvider>) {
    let claude = Arc::new(FakeProvider::new("claudeAgent"));
    let codex = Arc::new(FakeProvider::new("codex"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![claude.clone(), codex.clone()];
    (SqliteEngine::open(config).unwrap(), claude, codex)
}

fn count(n: &std::sync::atomic::AtomicUsize) -> usize {
    n.load(std::sync::atomic::Ordering::SeqCst)
}

fn model_selection_set(command: &str, instance: &str) -> Value {
    json!({
        "type": "thread.model-selection.set", "commandId": command, "threadId": "t1",
        "modelSelection": {"instanceId": instance, "model": "m"},
    })
}

/// `planSelectionTransition` decides a same-instance model change once a session row exists:
/// `reject` refuses the command, `restart_session` releases the session between turns
/// (`restart_and_resume`) and refuses while a run is active.
#[tokio::test(flavor = "current_thread")]
async fn the_provider_plans_a_model_change() {
    let selection = |command: &str, model: &str| {
        json!({
            "type": "thread.model-selection.set", "commandId": command, "threadId": "t1",
            "modelSelection": {"instanceId": "claudeAgent", "model": model},
        })
    };
    // Reject.
    let db = TempDb::new("plan-reject");
    let (engine, _) = open_with(
        &db,
        FakeProvider::new("claudeAgent").with_selection_plan(
            conn_provider::SelectionTransitionPlan::Reject {
                reason: "no model switch here".into(),
            },
        ),
    );
    dispatch(&engine, create("t1", "c1")).await;
    // No session yet: the change applies at the next turn.
    dispatch(&engine, selection("c2", "m1")).await;
    dispatch(&engine, message("t1", "c3", "hi")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let refused = engine
        .dispatch(from_json(selection("c4", "m2")).unwrap())
        .await;
    assert!(
        matches!(&refused, Err(EngineError::Rejected(e)) if to_json(e).to_string().contains("no model switch here")),
        "{refused:?}"
    );

    // Restart.
    let db = TempDb::new("plan-restart");
    let (engine, provider) = open_with(
        &db,
        FakeProvider::new("claudeAgent")
            .with_selection_plan(conn_provider::SelectionTransitionPlan::RestartSession),
    );
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let busy = engine
        .dispatch(from_json(selection("c3", "m2")).unwrap())
        .await;
    assert!(
        matches!(busy, Err(EngineError::Rejected(_))),
        "a busy thread keeps its session"
    );
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c4", "threadId": "t1"}),
    )
    .await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(&engine, selection("c5", "m2")).await;
    for _ in 0..200 {
        if count(&provider.closed) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(count(&provider.closed), 1, "the session was released");
}

/// A Stop the provider does not confirm (Codex since T3 b5b470542a) leaves the run running and
/// marks its `run_interrupt_request` unresponsive, so clients offer Force stop
/// (`thread.interrupt.unresponsive`). Force stop then ends it with its own Stop result.
#[tokio::test(flavor = "current_thread")]
async fn an_unconfirmed_stop_offers_force_stop() {
    let db = TempDb::new("unresponsive-stop");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "stuck")).await;
    until_provider_turn(&mut thread).await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c3", "threadId": "t1"}),
    )
    .await;
    let request = loop {
        let item = next(&mut thread).await;
        let payload = &item["event"]["payload"];
        if payload["type"] == "run_interrupt_request" && payload["unresponsiveAt"].is_string() {
            break payload.clone();
        }
    };
    assert_eq!(request["message"], "Stopped by user");
    let p = projection(&engine, "t1").await;
    assert_eq!(
        run_statuses(&p),
        [("run:t1:1".into(), "running".into())],
        "the run stays open"
    );

    call(
        &engine,
        "orchestration.forceStopThread",
        json!({"threadId": "t1"}),
    )
    .await
    .unwrap();
    let p = projection(&engine, "t1").await;
    assert_eq!(
        run_statuses(&p),
        [("run:t1:1".into(), "interrupted".into())]
    );
    let result = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "run_interrupt_result")
        .cloned()
        .unwrap();
    assert_eq!(result["message"], "Force stopped by user");
    assert_eq!(result["parentItemId"], request["id"]);
}

/// A model change on the thread's instance during a provider turn goes to the running session
/// (`provider-session.apply-model-selection` in `Orchestrator.ts`); with no provider turn
/// running it only changes the thread, and the next turn carries it.
#[tokio::test(flavor = "current_thread")]
async fn a_model_change_during_a_turn_reaches_the_running_session() {
    let db = TempDb::new("live-selection");
    let (engine, claude, _codex) = open_two(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    // Idle thread: nothing is sent to a provider.
    dispatch(&engine, model_selection_set("c2", "claudeAgent")).await;
    assert!(crate::lock(&claude.applied_selections).is_empty());

    dispatch(&engine, message("t1", "c3", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(
        &engine,
        json!({
            "type": "thread.model-selection.set", "commandId": "c4", "threadId": "t1",
            "modelSelection": {"instanceId": "claudeAgent", "model": "m2"},
        }),
    )
    .await;
    for _ in 0..200 {
        if !crate::lock(&claude.applied_selections).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let applied = crate::lock(&claude.applied_selections).clone();
    assert_eq!(applied.len(), 1, "{applied:?}");
    assert_eq!(applied[0]["model"], "m2");
    assert_eq!(count(&claude.closed), 0, "the session stays open");
}

/// `thread.model-selection.set` to another instance is a provider switch, as in
/// `Orchestrator.ts`: refused while a run is active, `thread.provider-switched`, the old session
/// closes, and the next turn runs on the new provider in its own provider thread.
#[tokio::test(flavor = "current_thread")]
async fn a_model_selection_on_another_instance_switches_the_provider() {
    let db = TempDb::new("switch-selection");
    let (engine, claude, codex) = open_two(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let busy = engine
        .dispatch(from_json(model_selection_set("c3", "codex")).unwrap())
        .await;
    assert!(
        matches!(busy, Err(EngineError::Rejected(_))),
        "a busy thread keeps its provider"
    );
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c4", "threadId": "t1"}),
    )
    .await;
    run_to_end(&engine, "t1", "run:t1:1").await;

    // A model change on the same instance stays a model change.
    dispatch(&engine, model_selection_set("c5", "claudeAgent")).await;
    assert_eq!(count(&claude.closed), 0);

    dispatch(&engine, model_selection_set("c6", "codex")).await;
    let mut switched = None;
    while switched.is_none() {
        let item = next(&mut thread).await;
        let ty = item["event"]["type"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if ty.starts_with("thread.") && item["event"]["payload"]["providerInstanceId"] == "codex" {
            switched = Some((ty, item["event"]["payload"].clone()));
        }
    }
    let (ty, payload) = switched.unwrap();
    assert_eq!(ty, "thread.provider-switched");
    assert_eq!(payload["activeProviderThreadId"], Value::Null);
    // The close runs as an effect after the event is stored, so wait for it.
    for _ in 0..200 {
        if count(&claude.closed) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(count(&claude.closed), 1, "the old session closes");

    dispatch(&engine, message("t1", "c7", "hi")).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][1]["status"], "completed");
    assert_eq!(p["runs"][1]["providerInstanceId"], "codex");
    assert_eq!(p["runs"][1]["providerThreadId"], "provider-thread:codex:t1");
    assert_eq!((count(&claude.sessions), count(&codex.sessions)), (1, 1));
}

/// A `message.dispatch` that names another instance runs there: the live session of the other
/// instance closes, and a provider thread of the other instance is never resumed. Going back
/// resumes the first instance's own provider thread (`rootProviderThreadsForProvider`).
#[tokio::test(flavor = "current_thread")]
async fn a_dispatch_on_another_instance_runs_on_that_provider() {
    let db = TempDb::new("switch-dispatch");
    let (engine, claude, codex) = open_two(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hi")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;

    let mut on_codex = message("t1", "c3", "hi");
    on_codex["modelSelection"] = json!({"instanceId": "codex", "model": "gpt"});
    dispatch(&engine, on_codex).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][1]["status"], "completed");
    assert_eq!(p["runs"][1]["providerThreadId"], "provider-thread:codex:t1");
    assert_eq!((count(&claude.sessions), count(&codex.sessions)), (1, 1));
    assert_eq!(count(&claude.closed), 1);

    let mut back = message("t1", "c4", "hi");
    back["modelSelection"] = json!({"instanceId": "claudeAgent", "model": "m"});
    dispatch(&engine, back).await;
    let p = run_to_end(&engine, "t1", "run:t1:3").await;
    assert_eq!(p["runs"][2]["status"], "completed");
    assert_eq!(p["runs"][2]["providerThreadId"], "provider-thread:t1");
    assert_eq!((count(&claude.sessions), count(&codex.sessions)), (2, 1));
    assert_eq!(count(&codex.closed), 1);
}

/// Claude, and Codex that takes injected history (`thread/inject_items`), as a server with both.
fn open_two_injecting(db: &TempDb) -> (SqliteEngine, Arc<FakeProvider>, Arc<FakeProvider>) {
    let claude = Arc::new(FakeProvider::new("claudeAgent"));
    let codex = Arc::new(FakeProvider::new("codex").with_history_injection());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![claude.clone(), codex.clone()];
    (SqliteEngine::open(config).unwrap(), claude, codex)
}

fn handoff_of<'a>(p: &'a Value, run: &str) -> &'a Value {
    p["contextHandoffs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["targetRunId"] == run)
        .unwrap_or_else(|| panic!("no handoff for {run}: {p}"))
}

/// A provider switch carries the conversation to the new provider, as T3's `dispatchMessage`
/// does: the first run on Codex gets Claude's history in full (`full_thread_summary`),
/// injected into its native thread; back on Claude, the run gets what happened since Claude's
/// thread last took part (`delta_since_target_last_seen`), inline ahead of the user's text.
#[tokio::test(flavor = "current_thread")]
async fn a_provider_switch_hands_the_history_to_the_new_provider() {
    let db = TempDb::new("switch-handoff");
    let (engine, claude, codex) = open_two_injecting(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "remember the marker blue-17")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;

    dispatch(&engine, model_selection_set("c3", "codex")).await;
    dispatch(&engine, message("t1", "c4", "what is the marker?")).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][1]["status"], "completed");
    let handoff = handoff_of(&p, "run:t1:2");
    assert_eq!(handoff["strategy"], "full_thread_summary");
    assert_eq!(handoff["coveredRunOrdinals"], json!({"from": 1, "to": 1}));
    assert_eq!(
        handoff["fromProviderThreadIds"],
        json!(["provider-thread:t1"])
    );
    assert_eq!(handoff["toProviderThreadId"], "provider-thread:codex:t1");
    assert_eq!(handoff["delivery"]["status"], "injected");
    assert_eq!(p["runs"][1]["contextHandoffId"], handoff["id"]);
    let transfer = p["contextTransfers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["type"] == "provider_handoff")
        .unwrap();
    assert_eq!(transfer["status"], "consumed");
    assert_eq!(transfer["sourceProviderInstanceId"], "claudeAgent");
    assert_eq!(transfer["targetProviderInstanceId"], "codex");
    assert_eq!(transfer["basePoint"], Value::Null);
    assert_eq!(
        transfer["resolution"],
        json!({"strategy": "portable_context", "contextHandoffId": handoff["id"]})
    );
    let item = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "handoff")
        .unwrap();
    assert_eq!(item["title"], "Provider handoff");
    assert_eq!(item["fromProviderInstanceIds"], json!(["claudeAgent"]));
    assert_eq!(item["toProviderInstanceId"], "codex");
    // Codex took the history natively; its prompt is the user's text alone.
    let injected = crate::lock(&codex.injected).clone();
    assert_eq!(injected.len(), 1);
    let history = injected[0].1.to_string();
    assert!(history.contains("remember the marker blue-17"), "{history}");
    assert!(
        history.contains("echo: remember the marker blue-17"),
        "{history}"
    );
    assert_eq!(*crate::lock(&codex.prompts), ["what is the marker?"]);

    // Back on Claude: its own thread resumes and gets only the Codex run.
    dispatch(&engine, model_selection_set("c5", "claudeAgent")).await;
    dispatch(&engine, message("t1", "c6", "and now?")).await;
    let p = run_to_end(&engine, "t1", "run:t1:3").await;
    assert_eq!(p["runs"][2]["status"], "completed");
    assert_eq!(p["runs"][2]["providerThreadId"], "provider-thread:t1");
    let handoff = handoff_of(&p, "run:t1:3");
    assert_eq!(handoff["strategy"], "delta_since_target_last_seen");
    assert_eq!(handoff["coveredRunOrdinals"], json!({"from": 2, "to": 2}));
    assert_eq!(handoff["delivery"]["status"], "inline");
    let prompts = crate::lock(&claude.prompts).clone();
    assert_eq!(prompts.len(), 2);
    let prompt = &prompts[1];
    assert!(prompt.contains("what is the marker?"), "{prompt}");
    assert!(
        !prompt.contains("blue-17"),
        "Claude's thread holds run 1 already: {prompt}"
    );
    assert!(prompt.ends_with("\n\nUser message:\nand now?"), "{prompt}");
    // The Codex exchange reaches Claude once: its user line and its reply, one of each.
    for line in ["what is the marker?", "echo: what is the marker?"] {
        assert_eq!(
            prompt.lines().filter(|l| l.trim() == line).count(),
            1,
            "{line}: {prompt}"
        );
    }
    let transfer = p["contextTransfers"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|t| t["type"] == "provider_handoff")
        .unwrap();
    assert_eq!(transfer["basePoint"]["runId"], "run:t1:1");
    assert_eq!(transfer["resolution"]["strategy"], "delta_context");

    // A run on the same provider carries nothing.
    dispatch(&engine, message("t1", "c7", "plain")).await;
    let p = run_to_end(&engine, "t1", "run:t1:4").await;
    assert_eq!(p["runs"][3]["contextHandoffId"], Value::Null);
    assert_eq!(crate::lock(&claude.prompts).last().unwrap(), "plain");

    // A fresh-context request on another provider carries nothing over.
    dispatch(&engine, model_selection_set("c8", "codex")).await;
    let mut fresh = message("t1", "c9", "start over");
    fresh["freshContext"] = json!(true);
    dispatch(&engine, fresh).await;
    let p = run_to_end(&engine, "t1", "run:t1:5").await;
    assert_eq!(p["runs"][4]["contextHandoffId"], Value::Null);
    assert_eq!(crate::lock(&codex.injected).len(), 1);
    assert_eq!(crate::lock(&codex.prompts).last().unwrap(), "start over");

    // Back on Claude after the clear: a new native thread, never the cleared one
    // (`rootProviderThreadsForProvider` skips threads older than the boundary).
    dispatch(&engine, model_selection_set("c10", "claudeAgent")).await;
    dispatch(&engine, message("t1", "c11", "after the clear")).await;
    let p = run_to_end(&engine, "t1", "run:t1:6").await;
    assert_eq!(p["runs"][5]["status"], "completed");
    assert_eq!(p["runs"][5]["providerThreadId"], "provider-thread:t1:2");
    assert_eq!(
        handoff_of(&p, "run:t1:6")["strategy"],
        "full_thread_summary"
    );
    let prompt = crate::lock(&claude.prompts).last().unwrap().clone();
    assert!(prompt.contains("start over"), "{prompt}");
    assert!(!prompt.contains("blue-17"), "{prompt}");
}

/// A steer that picks another instance than the running turn's does not join that turn: the
/// turn stops and the message restarts on the new provider with the conversation
/// (`dispatchMessage`, `selectionMustApplyNow` for a provider instance change).
#[tokio::test(flavor = "current_thread")]
async fn a_steer_to_another_provider_restarts_there() {
    let db = TempDb::new("steer-switch");
    let (engine, claude, codex) = open_two_injecting(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut steer = message_with(
        "t1",
        "c3",
        "now on codex",
        json!({"type": "steer_active", "targetRunId": "run:t1:1"}),
        None,
    );
    steer["modelSelection"] = json!({"instanceId": "codex", "model": "m"});
    dispatch(&engine, steer).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][0]["status"], "interrupted");
    assert_eq!(p["runs"][1]["providerInstanceId"], "codex");
    assert_eq!(p["runs"][1]["status"], "completed");
    assert!(
        !crate::lock(&claude.prompts)
            .iter()
            .any(|prompt| prompt.contains("now on codex")),
        "the steer never reaches the Claude session"
    );
    assert_eq!(*crate::lock(&codex.prompts), ["now on codex"]);
    let injected = crate::lock(&codex.injected).clone();
    assert_eq!(injected.len(), 1);
    assert!(injected[0].1.to_string().contains("hang"));
}

/// Steer on a queued message keeps that message's provider: a queued Codex message promoted
/// while Claude runs restarts on Codex, as a direct steer does.
#[tokio::test(flavor = "current_thread")]
async fn a_promoted_steer_on_another_provider_restarts_there() {
    let db = TempDb::new("promote-switch");
    let (engine, claude, codex) = open_two_injecting(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut queued = message_with(
        "t1",
        "c3",
        "queued for codex",
        json!({"type": "queue_after_active"}),
        None,
    );
    queued["modelSelection"] = json!({"instanceId": "codex", "model": "m"});
    dispatch(&engine, queued).await;
    dispatch(
        &engine,
        json!({"type": "queued-message.promote-to-steer", "commandId": "c4", "threadId": "t1",
            "queuedRunId": "run:t1:2", "targetRunId": "run:t1:1"}),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    let codex_run = p["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| {
            r["userMessageId"] == "message:c3"
                && r["providerInstanceId"] == "codex"
                && r["status"] != "cancelled"
        })
        .unwrap_or_else(|| panic!("no Codex run for the promoted message: {}", p["runs"]))
        .clone();
    let p = run_to_end(&engine, "t1", codex_run["id"].as_str().unwrap()).await;
    assert_eq!(p["runs"][0]["status"], "interrupted");
    assert_eq!(*crate::lock(&codex.prompts), ["queued for codex"]);
    assert!(
        !crate::lock(&claude.prompts)
            .iter()
            .any(|prompt| prompt.contains("queued for codex"))
    );
    assert!(
        crate::lock(&codex.injected)[0]
            .1
            .to_string()
            .contains("hang")
    );
}

/// A switch to a provider that cannot take the history is refused with T3's text
/// (`ensureContextHandoff`), and the thread keeps no run of it.
#[tokio::test(flavor = "current_thread")]
async fn a_switch_to_a_provider_without_handoff_is_refused() {
    let db = TempDb::new("switch-unsupported");
    let claude = Arc::new(FakeProvider::new("claudeAgent"));
    let codex = Arc::new(FakeProvider::new("codex").without_context_handoff());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![claude, codex];
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hi")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(&engine, model_selection_set("c3", "codex")).await;
    let refused = engine
        .dispatch(from_json(message("t1", "c4", "hi")).unwrap())
        .await;
    assert!(
        matches!(&refused, Err(EngineError::Rejected(e)) if to_json(e).to_string().contains(
            "codex cannot satisfy context_handoff for command c4: providerInstanceId cannot consume handoff summaries"
        )),
        "{refused:?}"
    );
    assert_eq!(
        projection(&engine, "t1").await["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// A queued run on another instance switches when it starts (`startNextQueuedRun`): the
/// stopped run before it reached Claude, so Codex gets it.
#[tokio::test(flavor = "current_thread")]
async fn a_queued_run_on_another_provider_carries_the_history() {
    let db = TempDb::new("switch-queued");
    let (engine, _claude, codex) = open_two_injecting(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut queued = message("t1", "c3", "on codex");
    queued["modelSelection"] = json!({"instanceId": "codex", "model": "gpt"});
    queued["dispatchMode"] = json!({"type": "queue_after_active"});
    dispatch(&engine, queued).await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c4", "threadId": "t1"}),
    )
    .await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    // Stop holds the queue; the user starts the queued run.
    dispatch(
        &engine,
        json!({"type": "queued-run.start", "commandId": "c5", "threadId": "t1", "runId": "run:t1:2"}),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][1]["status"], "completed");
    let handoff = handoff_of(&p, "run:t1:2");
    assert_eq!(handoff["strategy"], "full_thread_summary");
    assert_eq!(handoff["delivery"]["status"], "injected");
    assert_eq!(p["runs"][1]["contextHandoffId"], handoff["id"]);
    let history = crate::lock(&codex.injected)[0].1.to_string();
    assert!(history.contains("run-status=interrupted"), "{history}");
    assert_eq!(*crate::lock(&codex.prompts), ["on codex"]);
}

/// An instance the server does not have fails the run; it never goes to another provider.
#[tokio::test(flavor = "current_thread")]
async fn an_unknown_instance_fails_the_run_even_with_one_provider() {
    let db = TempDb::new("unknown-instance");
    let (engine, provider) = open(&db);
    let mut c = create("t1", "c1");
    c["modelSelection"] = json!({"instanceId": "codex", "model": "gpt"});
    dispatch(&engine, c).await;
    dispatch(&engine, message("t1", "c2", "hi")).await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(p["runs"][0]["status"], "failed");
    assert_eq!(count(&provider.sessions), 0);
}

/// A child's second turn wakes the parent with a new message. Before the fix the wake reused
/// the command and message id, so it overwrote the first result and two queued runs shared it.
#[tokio::test(flavor = "current_thread")]
async fn each_delegated_completion_wakes_with_its_own_message() {
    let db = TempDb::new("delegate-twice");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;

    dispatch(&engine, delegate("d1", "look", Some("always"))).await;
    let child = "thread:delegated-task:d1";
    run_to_end(&engine, child, &format!("run:{child}:1")).await;
    dispatch(&engine, message(child, "c3", "again")).await;
    run_to_end(&engine, child, &format!("run:{child}:2")).await;

    let parent = projection(&engine, "t1").await;
    let wakes: Vec<(String, String)> = parent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["createdBy"] == "agent" && m["role"] == "user")
        .map(|m| {
            (
                m["id"].as_str().unwrap().to_owned(),
                m["text"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(wakes.len(), 2, "{wakes:?}");
    assert!(wakes[0].1.contains("echo: look"), "{wakes:?}");
    assert!(wakes[1].1.contains("echo: again"), "{wakes:?}");
    let users: Vec<_> = parent["runs"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .map(|r| r["userMessageId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(users, [wakes[0].0.clone(), wakes[1].0.clone()]);
}

async fn search(engine: &SqliteEngine, query: &str) -> Vec<String> {
    let found = call(
        engine,
        "orchestration.searchThreads",
        json!({"query": query}),
    )
    .await
    .unwrap();
    found["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["threadId"].as_str().unwrap().to_owned())
        .collect()
}

/// `serializeAssistantCitation`: a quote of `thread:quoted`'s answer, as the client writes it.
pub(crate) fn citation(text: &str, comment: &str, prefix: &str, suffix: &str) -> String {
    // `URLSearchParams` encoding: spaces as `+`, unreserved bytes as they are.
    let form = |value: &str| {
        value
            .bytes()
            .map(|b| match b {
                b' ' => "+".to_owned(),
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                    char::from(b).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    let end = text.encode_utf16().count();
    format!(
        "[Assistant quote](t3-citation://v1/environment%3Alocal/thread%3Aquoted/quoted-answer?text={}&comment={}&start=0&end={end}&prefix={}&suffix={})",
        form(text),
        form(comment),
        form(prefix),
        form(suffix)
    )
}

/// Ports T3's "matches the readable text of quotes and their comments" and "finds accented,
/// CJK, and apostrophe words of a quote through the index" (`ThreadSearch.test.ts`): search
/// reads a citation as its text and comment, never its hidden link.
#[tokio::test(flavor = "current_thread")]
async fn search_reads_a_citation_as_its_text_and_comment() {
    let db = TempDb::new("search-citation");
    let (engine, _) = open(&db);
    write_citations(&engine).await;
    assert_citation_search(&engine).await;
}

/// Stores whose index holds older text read it again on open, once: main at schema 4 or 5
/// with fold 3 (the raw link folded), and a pre-merge build of readable search at 6 (its
/// `search_text` column, readable text unfolded). All end at 5 with the folded readable index.
#[tokio::test(flavor = "current_thread")]
async fn an_older_search_index_is_read_again_on_upgrade() {
    for (from, fold, search_text) in [(4, Some(3), false), (5, Some(3), false), (6, None, true)] {
        let db = TempDb::new(&format!("search-upgrade-{from}"));
        {
            let (engine, _) = open(&db);
            write_citations(&engine).await;
        }
        {
            let conn = rusqlite::Connection::open(db.path()).unwrap();
            // A store at 4 has no receipt owners yet (step 5).
            if from == 4 {
                conn.execute_batch(
                    "ALTER TABLE receipts DROP COLUMN owner_kind;
                     ALTER TABLE receipts DROP COLUMN owner_id;
                     ALTER TABLE receipts DROP COLUMN error;",
                )
                .unwrap();
            }
            if search_text {
                conn.execute_batch("ALTER TABLE message_keys ADD COLUMN search_text TEXT")
                    .unwrap();
            }
            let mark = match fold {
                Some(fold) => format!(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES ('message_search_folded', {fold});"
                ),
                None => "DELETE FROM meta WHERE key = 'message_search_folded';".to_owned(),
            };
            conn.execute_batch(&format!(
                "DELETE FROM message_search;
                 INSERT INTO message_search (rowid, text)
                   SELECT k.id, lower(json_extract(e.body, '$.text')) FROM message_keys k
                   JOIN entities e
                     ON e.thread_id = k.thread_id AND e.kind = 'messages' AND e.id = k.message_id;
                 {mark}
                 PRAGMA user_version = {from};"
            ))
            .unwrap();
            let old: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM message_search WHERE message_search MATCH '\"beacon01\"'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                old, 1,
                "from {from}: the old index holds the hidden context"
            );
        }
        let (engine, _) = open(&db);
        assert_citation_search(&engine).await;
        drop(engine);
        let conn = rusqlite::Connection::open(db.path()).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 5, "from {from}");
        let column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('message_keys') WHERE name = 'search_text'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(column, 0, "from {from}");
    }
}

/// `t1`: a quote with hidden context and a comment, then plain words; `t2`: a quote with
/// accented, CJK and Cyrillic words; `t3`: a quote of accented words with hidden context, then
/// an accented word of its own. Written as T3's tests apply them, without a turn: the
/// fake provider would echo the provider's expansion, whose JSON carries the hidden context.
async fn write_citations(engine: &SqliteEngine) {
    let quote = citation(
        "A lighthouse guides ships safely through the darkness.",
        "what are you talking about",
        "beacon01",
        "harbor",
    );
    let accented = citation(
        "The kittiwake's résumé mentions 灯台の光 twice.",
        "naïve question в логах",
        "",
        "",
    );
    let accented_quote = citation("Le café lumière ferme tard.", "", "beacon02", "quai");
    for (thread, text) in [
        ("t1", format!("{quote} quiet silver lantern")),
        ("t2", accented),
        ("t3", format!("{accented_quote} Déjà vu")),
    ] {
        dispatch(engine, create(thread, &format!("{thread}:c1"))).await;
        let thread = thread.to_owned();
        engine
            .inner()
            .write(move |tx| {
                let now = tx.now().to_owned();
                tx.append(crate::store::Draft::new(
                    &thread,
                    "message.updated",
                    json!({"createdBy": "user", "creationSource": "web",
                        "id": format!("message:{thread}"), "threadId": thread, "runId": null,
                        "nodeId": null, "role": "user", "text": text, "attachments": [],
                        "streaming": false, "createdAt": now, "updatedAt": now}),
                ))?;
                Ok(())
            })
            .await
            .unwrap();
    }
}

async fn assert_citation_search(engine: &SqliteEngine) {
    assert_eq!(search(engine, "what are you talking about").await, ["t1"]);
    assert_eq!(search(engine, "ships safely through").await, ["t1"]);
    assert_eq!(search(engine, "lantern").await, ["t1"]);
    // The hidden selection context and the link's ids are not text the reader sees.
    for hidden in ["beacon01", "harbor", "quoted-answer", "t3-citation"] {
        assert_eq!(
            search(engine, hidden).await,
            Vec::<String>::new(),
            "{hidden}"
        );
    }
    let found = call(
        engine,
        "orchestration.searchThreads",
        json!({"query": "talking about"}),
    )
    .await
    .unwrap();
    let snippet = found["matches"][0]["snippet"].as_str().unwrap();
    assert!(
        snippet.contains("Comment: what are you talking about") && !snippet.contains("t3-citation"),
        "{snippet}"
    );
    for query in [
        "kittiwake's",
        "kittiwake’s",
        "résumé",
        "灯台の光",
        "naïve",
        "логах в",
    ] {
        assert_eq!(search(engine, query).await, ["t2"], "{query}");
    }
    // The index holds the readable text folded: a quote's accented words and the message's
    // own are found without accents, its hidden context is not.
    for query in ["cafe lumiere", "deja vu"] {
        assert_eq!(search(engine, query).await, ["t3"], "{query}");
    }
    for hidden in ["beacon02", "quai"] {
        assert_eq!(
            search(engine, hidden).await,
            Vec::<String>::new(),
            "{hidden}"
        );
    }
}

/// T3 "ThreadSearch short words outside ASCII: finds them in any case or accent", plus the
/// ordinary message of audit 9.5: a query without accents finds an accented message, on a
/// store indexed before folding (after the migration) and for a message sent after it.
#[tokio::test(flavor = "current_thread")]
async fn search_folds_case_and_accents_before_and_after_the_upgrade() {
    let db = TempDb::new("search-accents");
    let (engine, _) = open(&db);
    for (thread, texts) in [
        ("russian", &["В логах ошибка"][..]),
        (
            "french",
            &[
                "École fermée à Lyon. Scope ordinary beacon.",
                "Météo école",
                "Școala închisă",
                "Hồ Chí Minh",
            ][..],
        ),
    ] {
        dispatch(&engine, create(thread, &format!("{thread}:c0"))).await;
        for (n, text) in texts.iter().enumerate() {
            let n = n + 1;
            dispatch(&engine, message(thread, &format!("{thread}:c{n}"), text)).await;
            run_to_end(&engine, thread, &format!("run:{thread}:{n}")).await;
        }
    }
    engine.shutdown().await;
    drop(engine);
    // The index as a store written before folding had it: original text, no fold mark.
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    conn.execute_batch(
        "UPDATE message_search SET text = (
           SELECT COALESCE(json_extract(e.body, '$.text'), '') FROM message_keys k
           JOIN entities e ON e.thread_id = k.thread_id AND e.kind = 'messages'
             AND e.id = k.message_id
           WHERE k.id = message_search.rowid);
         DELETE FROM meta WHERE key = 'message_search_folded';",
    )
    .unwrap();
    let stored: String = conn
        .query_row(
            "SELECT text FROM message_search WHERE text LIKE '%Lyon%' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(stored.starts_with("École"), "{stored}");
    drop(conn);

    let (engine, _) = open(&db);
    let hits = |query: &'static str| {
        let engine = &engine;
        async move {
            call(
                engine,
                "orchestration.searchThreads",
                json!({"query": query}),
            )
            .await
            .unwrap()["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| (m["threadId"].as_str().unwrap().to_owned(), m.clone()))
                .collect::<Vec<_>>()
        }
    };
    let ids = |found: &[(String, Value)]| found.iter().map(|f| f.0.clone()).collect::<Vec<_>>();
    let french = hits("École fermée").await;
    assert_eq!(ids(&french), ["french"]);
    let message_id = french[0].1["messageId"].clone();
    for query in ["ecole fermee", "ecole fermée", "fermée éc", "ECOLE FERMEE"] {
        let found = hits(query).await;
        assert_eq!(ids(&found), ["french"], "{query}");
        assert_eq!(found[0].1["messageId"], message_id, "{query}");
        assert!(
            found[0].1["snippet"]
                .as_str()
                .unwrap()
                .contains("École fermée à Lyon"),
            "the snippet keeps the original text: {query}"
        );
    }
    assert_eq!(ids(&hits("ошибка в").await), ["russian"]);
    assert_eq!(ids(&hits("école me").await), ["french"]);
    assert_eq!(ids(&hits("închisă sc").await), ["french"]);
    assert_eq!(ids(&hits("chí ho").await), ["french"]);
    // Short words still narrow, and an absent word finds nothing.
    assert_eq!(ids(&hits("ошибка я").await), Vec::<String>::new());
    assert_eq!(ids(&hits("fermée ce").await), Vec::<String>::new());
    assert_eq!(ids(&hits("totallyabsent").await), Vec::<String>::new());

    // A message sent after the upgrade is indexed folded too.
    dispatch(&engine, create("later", "later:c1")).await;
    dispatch(&engine, message("later", "later:c2", "Crème brûlée recipe")).await;
    run_to_end(&engine, "later", "run:later:1").await;
    let later = hits("creme brulee").await;
    assert_eq!(ids(&later), ["later"]);
    assert!(
        later[0].1["snippet"]
            .as_str()
            .unwrap()
            .contains("Crème brûlée")
    );
    engine.shutdown().await;
}

/// The index folds as T3's `trigram remove_diacritics 1` and the query is NFC, as
/// `messageSearchTokens`: Latin accents fold, other scripts' marks and other letters stay apart.
/// A store folded by the first, wider fold (mark 1) is folded again once, from the messages.
#[tokio::test(flavor = "current_thread")]
async fn search_folds_latin_accents_only_and_normalizes_the_query() {
    let db = TempDb::new("search-scripts");
    let (engine, _) = open(&db);
    for (thread, text) in [
        ("kana", "かがく の じっけん"),
        ("hangul", "한글 문서 작성"),
        ("french", "Le garçon était déjà prêt"),
        ("letters", "Straße ørsted ﬁle"),
        ("georgian", "თბილისი"),
    ] {
        dispatch(&engine, create(thread, &format!("{thread}:c1"))).await;
        dispatch(&engine, message(thread, &format!("{thread}:c2"), text)).await;
        run_to_end(&engine, thread, &format!("run:{thread}:1")).await;
    }
    let none = Vec::<String>::new();
    assert_eq!(search(&engine, "かがく").await, ["kana"]);
    assert_eq!(
        search(&engine, "かかく").await,
        none,
        "dakuten tells か from が"
    );
    // "한글" typed as decomposed jamo finds the composed syllables.
    let decomposed = "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}";
    assert_eq!(search(&engine, decomposed).await, ["hangul"]);
    assert_eq!(search(&engine, "한글").await, ["hangul"]);
    assert_eq!(search(&engine, "garcon etait deja pret").await, ["french"]);
    assert_eq!(search(&engine, "GARÇON déjà").await, ["french"]);
    for query in ["straße", "ørsted", "ﬁle"] {
        assert_eq!(search(&engine, query).await, ["letters"], "{query}");
    }
    for query in ["strasse", "orsted", "file"] {
        assert_eq!(search(&engine, query).await, none, "{query}");
    }
    // The query is lowercased before the index fold, which leaves Mtavruli capitals alone.
    assert_eq!(search(&engine, "ᲗᲑᲘᲚᲘᲡᲘ").await, ["georgian"]);
    engine.shutdown().await;
    drop(engine);

    // The first fold took dakuten off ("かかく の しっけん") and marked the store 1.
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    conn.execute_batch(
        "UPDATE message_search SET text = 'かかく の しっけん' WHERE text LIKE 'かがく%';
         UPDATE meta SET value = 1 WHERE key = 'message_search_folded';",
    )
    .unwrap();
    drop(conn);
    let (engine, _) = open(&db);
    assert_eq!(search(&engine, "かかく").await, none);
    assert_eq!(search(&engine, "かがく").await, ["kana"]);
    assert_eq!(search(&engine, "じっけん").await, ["kana"]);
    engine.shutdown().await;
}

/// `messageMatcher` in `paletteSearch.ts`: a word shorter than four characters must start a
/// word in the message, so "me" does not find "fermé" and "fts" does not find "drafts". A
/// symbol starts a word only where a letter would (`startsWordAt`): "☀ab" is inside "x☀ab". T3
/// reads an emoji above U+FFFF as two UTF-16 units, so "🚀cd" brings its own boundary.
#[tokio::test(flavor = "current_thread")]
async fn search_short_words_must_start_a_word() {
    let db = TempDb::new("search-word-starts");
    let (engine, _) = open(&db);
    for (thread, text) in [
        ("closed", "marker fermé"),
        ("drafts", "marker drafts"),
        ("sun", "marker x☀ab y🚀cd"),
    ] {
        dispatch(&engine, create(thread, &format!("{thread}:c1"))).await;
        dispatch(&engine, message(thread, &format!("{thread}:c2"), text)).await;
        run_to_end(&engine, thread, &format!("run:{thread}:1")).await;
    }
    let none = Vec::<String>::new();
    assert_eq!(search(&engine, "marker").await.len(), 3);
    assert_eq!(search(&engine, "marker me").await, none);
    assert_eq!(search(&engine, "marker ☀ab").await, none);
    assert_eq!(search(&engine, "marker 🚀cd").await, ["sun"]);
    assert_eq!(search(&engine, "marker ke").await, none);
    assert_eq!(search(&engine, "marker fe").await, ["closed"]);
    assert_eq!(search(&engine, "fts").await, none);
    assert_eq!(search(&engine, "dra").await, ["drafts"]);
    assert_eq!(
        search(&engine, "afts").await,
        ["drafts"],
        "four letters match inside a word"
    );
    engine.shutdown().await;
}

/// `messageMatcher` counts a word's length before the index folds it, and skips hits inside a
/// hex id (`findMessageToken`). "İce" is four characters once lowercased, so it may sit inside
/// "service"; "abc" is not a word of "42abc12".
#[tokio::test(flavor = "current_thread")]
async fn search_word_length_and_hex_ids_as_message_matcher() {
    let db = TempDb::new("search-length-hex");
    let (engine, _) = open(&db);
    for (thread, text) in [
        ("service", "the service runs"),
        ("hex", "commit 42abc12 landed"),
        ("word", "the abc rule"),
    ] {
        dispatch(&engine, create(thread, &format!("{thread}:c1"))).await;
        dispatch(&engine, message(thread, &format!("{thread}:c2"), text)).await;
        run_to_end(&engine, thread, &format!("run:{thread}:1")).await;
    }
    assert_eq!(search(&engine, "İce").await, ["service"]);
    assert_eq!(search(&engine, "abc").await, ["word"]);
    assert_eq!(
        search(&engine, "42abc12").await,
        ["hex"],
        "a pasted id still matches"
    );
    engine.shutdown().await;
}

/// The snippet shows the occurrence that qualified the message: "fts" only counts where it
/// starts a word, not inside "drafts" 320 characters earlier.
#[tokio::test(flavor = "current_thread")]
async fn search_snippet_shows_the_accepted_occurrence() {
    let db = TempDb::new("search-snippet-at");
    let (engine, _) = open(&db);
    let text = format!("drafts {} fts ready", "z".repeat(320));
    dispatch(&engine, create("t", "t:c1")).await;
    dispatch(&engine, message("t", "t:c2", &text)).await;
    run_to_end(&engine, "t", "run:t:1").await;
    let found = call(
        &engine,
        "orchestration.searchThreads",
        json!({"query": "fts ready"}),
    )
    .await
    .unwrap();
    let snippet = found["matches"][0]["snippet"].as_str().unwrap_or_default();
    assert!(snippet.contains("fts ready"), "{snippet}");
    engine.shutdown().await;
}

/// `ThreadSearch.ts` matches a message as it reads (`MARKDOWN_LINK`): a link shows only its label,
/// so its address finds nothing and the snippet shows the label.
#[tokio::test(flavor = "current_thread")]
async fn search_reads_a_markdown_link_as_its_label() {
    let db = TempDb::new("search-link-label");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t", "t:c1")).await;
    let text = "See [release notes](https://docs.example/quartz/changelog).";
    dispatch(&engine, message("t", "t:c2", text)).await;
    run_to_end(&engine, "t", "run:t:1").await;
    assert_eq!(search(&engine, "quartz").await, Vec::<String>::new());
    let found = call(
        &engine,
        "orchestration.searchThreads",
        json!({"query": "release notes"}),
    )
    .await
    .unwrap();
    // The fake provider echoes the message, and its reply is the newest hit.
    assert_eq!(found["matches"][0]["snippet"], "echo: See release notes.");
    engine.shutdown().await;
}

/// Search follows `ThreadSearch.ts`: every long word must match, `%` and `_` are plain
/// characters, short words narrow, two CJK characters count as a word, and deleted or
/// archived threads drop out in SQL.
#[tokio::test(flavor = "current_thread")]
async fn search_matches_words_and_skips_hidden_threads() {
    let db = TempDb::new("search-words");
    let (engine, _) = open(&db);
    for (thread, text) in [
        ("t1", "rate is 100% for snake_case names"),
        ("t2", "rate is 100 for snakeXcase names"),
        ("t3", "東京 weather report"),
        ("t4", "deleted thread mentions zebra"),
        ("t5", "archived thread mentions zebra"),
    ] {
        dispatch(&engine, create(thread, &format!("{thread}:c1"))).await;
        dispatch(&engine, message(thread, &format!("{thread}:c2"), text)).await;
        run_to_end(&engine, thread, &format!("run:{thread}:1")).await;
    }
    assert_eq!(search(&engine, "100%").await, ["t1"]);
    assert_eq!(search(&engine, "snake_case").await, ["t1"]);
    assert_eq!(search(&engine, "SNAKE_CASE names").await, ["t1"]);
    assert_eq!(search(&engine, "names rate").await.len(), 2);
    assert_eq!(search(&engine, "\"names\"").await.len(), 2);
    // A short word only narrows the hits of the long ones.
    assert_eq!(search(&engine, "names is").await.len(), 2);
    assert_eq!(search(&engine, "names zz").await, Vec::<String>::new());
    assert_eq!(search(&engine, "東京").await, ["t3"]);
    assert_eq!(search(&engine, "zebra").await.len(), 2);
    // The server's own options: a project scope and threads to leave out, before the limit.
    let scoped = |input: Value| async {
        call(&engine, "orchestration.searchThreads", input)
            .await
            .unwrap()["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["threadId"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        scoped(json!({"query": "names", "excludedThreadIds": ["t1"]})).await,
        ["t2"]
    );
    assert_eq!(
        scoped(json!({"query": "names", "projectId": project_id()}))
            .await
            .len(),
        2
    );
    assert!(
        scoped(json!({"query": "names", "projectId": "project:other"}))
            .await
            .is_empty()
    );
    dispatch(
        &engine,
        json!({"type": "thread.delete", "commandId": "t4:c3", "threadId": "t4"}),
    )
    .await;
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "t5:c3", "threadId": "t5"}),
    )
    .await;
    assert_eq!(search(&engine, "zebra").await, Vec::<String>::new());
}

/// Codex streams command output as `command_output.delta`. It reaches
/// `subscribeCommandOutput` live through the bounded hub, and the hub forgets the command when
/// its run ends.
#[tokio::test(flavor = "current_thread")]
async fn live_command_output_reaches_subscribers() {
    let db = TempDb::new("live-output");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "command")).await;
    let item_id = "turn-item:cmd:run:t1:1";
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "turn-item.updated" && item["event"]["payload"]["id"] == item_id
        {
            break;
        }
    }
    let mut output = engine
        .open_stream(
            "orchestration.subscribeCommandOutput",
            json!({"threadId": "t1", "itemId": item_id}),
        )
        .await
        .unwrap();
    assert_eq!(
        frame(&mut output).await,
        json!({"kind": "replace", "text": "a\nb\n", "truncated": false, "running": true})
    );
    let hub = &engine.inner().command_output;
    hub.append("t1", item_id, "c\n");
    assert_eq!(
        frame(&mut output).await,
        json!({"kind": "append", "text": "c\n", "truncated": false, "running": true})
    );
    assert_eq!(hub.len(), 1);
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c3", "threadId": "t1"}),
    )
    .await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(
        hub.len(),
        0,
        "the hub drops a thread's commands when its run ends"
    );
}

/// `CommandOutputHub.test.ts` "an interrupted command ends the stream with the output it
/// printed": the live tail goes before the settled item, which has no `output`.
#[tokio::test(flavor = "current_thread")]
async fn an_interrupted_command_ends_on_the_output_it_printed() {
    let db = TempDb::new("output-interrupted");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let item = |status: &str| {
        json!({"id": "turn-item:cmd", "threadId": "t1", "runId": "run:t1:1", "nodeId": "node:run:t1:1:root",
            "providerThreadId": null, "providerTurnId": null, "nativeItemRef": null, "parentItemId": null,
            "ordinal": 0, "status": status, "title": null, "startedAt": "2026-01-01T00:00:00.000Z",
            "completedAt": null, "updatedAt": "2026-01-01T00:00:00.000Z", "type": "command_execution",
            "input": "serve"})
    };
    let write = |value: Value| {
        let inner = engine.inner().clone();
        async move {
            inner
                .write(move |tx| {
                    tx.append(crate::store::Draft::new("t1", "turn-item.updated", value))
                        .map(|_| ())
                })
                .await
                .unwrap()
        }
    };
    write(item("running")).await;
    let hub = &engine.inner().command_output;
    hub.append("t1", "turn-item:cmd", "waiting for server\n");
    let mut output = engine
        .open_stream(
            "orchestration.subscribeCommandOutput",
            json!({"threadId": "t1", "itemId": "turn-item:cmd"}),
        )
        .await
        .unwrap();
    frame(&mut output).await;
    hub.finish("t1", "turn-item:cmd");
    write(item("interrupted")).await;
    assert_eq!(
        frame(&mut output).await,
        json!({"kind": "replace", "text": "waiting for server\n", "truncated": false, "running": false})
    );
    assert!(output.recv().await.is_none());
}

fn snooze(command: &str, thread: &str, until: &str) -> Value {
    json!({"type": "thread.snooze", "commandId": command, "threadId": thread, "snoozedUntil": until})
}

async fn refused(engine: &SqliteEngine, command: Value) -> String {
    match engine.dispatch(from_json(command).unwrap()).await {
        Err(EngineError::Rejected(e)) => to_json(&e)["message"].as_str().unwrap_or("").to_owned(),
        Ok(_) => panic!("expected a refusal"),
        Err(EngineError::Internal(e)) => panic!("internal: {e}"),
    }
}

/// `thread.snooze` as `Orchestrator.ts`: the wake time must be in the future, is stored as UTC,
/// a pending approval refuses it, and a queued delegated-completion wake does not block it
/// while a queued user message does.
#[tokio::test(flavor = "current_thread")]
async fn snooze_follows_the_upstream_rules() {
    let db = TempDb::new("snooze-rules");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let shell_row = |shell: &Value, id: &str| {
        shell["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .cloned()
            .unwrap()
    };

    let past = refused(&engine, snooze("s1", "t1", "2020-01-01T00:00:00.000Z")).await;
    assert!(past.contains("not in the future"), "{past}");
    let bad = refused(&engine, snooze("s2", "t1", "not a time")).await;
    assert!(bad.contains("not in the future"), "{bad}");
    dispatch(&engine, snooze("s3", "t1", "2030-01-01T02:00:00+02:00")).await;
    let r = shell_row(&engine.shell_snapshot().await.unwrap(), "t1");
    assert_eq!(r["snoozedUntil"], "2030-01-01T00:00:00.000Z");

    // A pending approval refuses a snooze.
    dispatch(&engine, create("t2", "c2")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t2"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t2", "c3", "ask")).await;
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "runtime-request.updated" {
            break;
        }
    }
    let pending = refused(&engine, snooze("s4", "t2", "2030-01-01T00:00:00Z")).await;
    assert!(pending.contains("pending approval"), "{pending}");

    // A busy parent with a queued delegated-completion wake can snooze; a queued user message
    // blocks it.
    dispatch(&engine, create("t3", "c4")).await;
    let mut parent = engine
        .subscribe_thread(from_json(json!({"threadId": "t3"})).unwrap())
        .await
        .unwrap();
    next(&mut parent).await;
    dispatch(&engine, message("t3", "c5", "hang")).await;
    until_provider_turn(&mut parent).await;
    let mut task = delegate("d1", "look", Some("always"));
    task["parentThreadId"] = json!("t3");
    task["parentRunId"] = json!("run:t3:1");
    task["parentNodeId"] = json!("node:run:t3:1:root");
    dispatch(&engine, task).await;
    let child = "thread:delegated-task:d1";
    run_to_end(&engine, child, &format!("run:{child}:1")).await;
    assert_eq!(
        projection(&engine, "t3").await["runs"][1]["status"],
        "queued"
    );
    dispatch(&engine, snooze("s5", "t3", "2030-01-01T00:00:00Z")).await;
    dispatch(
        &engine,
        message_with(
            "t3",
            "c6",
            "later",
            json!({"type": "queue_after_active"}),
            None,
        ),
    )
    .await;
    let queued = refused(&engine, snooze("s6", "t3", "2031-01-01T00:00:00Z")).await;
    assert!(queued.contains("queued run"), "{queued}");
}

/// Shutdown closes sessions side by side, and no session opens once it began: a run that
/// starts then stays for the next start to pick up.
#[tokio::test(flavor = "current_thread")]
async fn shutdown_closes_sessions_together_and_opens_no_more() {
    let db = TempDb::new("shutdown");
    let (engine, provider) = open_with(
        &db,
        FakeProvider::new("claudeAgent").with_close_delay(Duration::from_millis(300)),
    );
    for thread in ["t1", "t2", "t3"] {
        dispatch(&engine, create(thread, &format!("{thread}:c1"))).await;
        dispatch(&engine, message(thread, &format!("{thread}:c2"), "hi")).await;
        run_to_end(&engine, thread, &format!("run:{thread}:1")).await;
    }
    assert_eq!(count(&provider.sessions), 3);
    let started = std::time::Instant::now();
    engine.shutdown().await;
    let took = started.elapsed();
    assert_eq!(count(&provider.closed), 3);
    assert!(
        took < Duration::from_millis(800),
        "closed one by one: {took:?}"
    );

    dispatch(&engine, create("t4", "t4:c1")).await;
    dispatch(&engine, message("t4", "t4:c2", "hi")).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        count(&provider.sessions),
        3,
        "no session opens after shutdown began"
    );
    assert_eq!(
        projection(&engine, "t4").await["runs"][0]["status"],
        "starting"
    );
}

#[path = "checkpoint_tests.rs"]
mod checkpoint_tests;

fn fresh_message(thread: &str, command: &str, text: &str, extra: Value) -> Value {
    let mut command = message(thread, command, text);
    command["freshContext"] = json!(true);
    if let (Some(fields), Some(extra)) = (command.as_object_mut(), extra.as_object()) {
        fields.extend(extra.clone());
    }
    command
}

/// `freshContext` (T3's `dispatchMessage`): the run starts a new provider conversation in a
/// new session; the old session's row says it stopped; the next message continues the new one.
#[tokio::test(flavor = "current_thread")]
async fn a_fresh_message_starts_a_new_provider_conversation() {
    let db = TempDb::new("fresh");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "first")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(&engine, fresh_message("t1", "c3", "second", json!({}))).await;
    run_to_end(&engine, "t1", "run:t1:2").await;
    dispatch(&engine, message("t1", "c4", "third")).await;
    let p = run_to_end(&engine, "t1", "run:t1:3").await;

    let runs = p["runs"].as_array().unwrap();
    assert_eq!(runs[1]["freshContext"], true, "{}", runs[1]);
    assert!(runs[0].get("freshContext").is_none());
    assert_ne!(runs[1]["providerThreadId"], runs[0]["providerThreadId"]);
    assert_eq!(
        runs[2]["providerThreadId"], runs[1]["providerThreadId"],
        "the fresh one goes on"
    );
    assert_eq!(
        p["thread"]["activeProviderThreadId"],
        runs[1]["providerThreadId"]
    );
    assert_eq!(
        provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    let item = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["messageId"] == "message:c3")
        .unwrap();
    assert_eq!(item["freshContext"], true, "{item}");
    assert_eq!(
        p["providerSessions"][0]["status"], "stopped",
        "the old session was released"
    );
    let threads = p["providerThreads"].as_array().unwrap();
    let ordinals: Vec<_> = threads
        .iter()
        .map(|t| (t["firstRunOrdinal"].clone(), t["lastRunOrdinal"].clone()))
        .collect();
    assert_eq!(ordinals, [(json!(1), json!(1)), (json!(2), json!(3))]);
}

/// A fresh start never joins a running turn: a steer becomes a queued run.
#[tokio::test(flavor = "current_thread")]
async fn a_fresh_message_never_steers() {
    let db = TempDb::new("fresh-steer");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(
        &engine,
        fresh_message(
            "t1",
            "c3",
            "fresh",
            json!({"dispatchMode": {"type": "steer_active", "targetRunId": "run:t1:1"}}),
        ),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][1]["status"], "queued", "{}", p["runs"]);
    assert_eq!(p["runs"][1]["freshContext"], true);
    assert!(p["runs"][1]["providerThreadId"].is_null());
}

/// A schedule's fresh run is a side conversation: the next plain message continues the
/// thread's own provider thread (`conversationProviderThread`).
#[tokio::test(flavor = "current_thread")]
async fn a_scheduled_fresh_run_is_a_side_conversation() {
    let db = TempDb::new("fresh-scheduled");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "first")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(
        &engine,
        fresh_message(
            "t1",
            "c3",
            "triage",
            json!({"scheduledTaskId": "task:triage", "dispatchMode": {"type": "queue_after_active"}}),
        ),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_ne!(
        p["runs"][1]["providerThreadId"],
        p["runs"][0]["providerThreadId"]
    );
    dispatch(&engine, message("t1", "c4", "back to the thread")).await;
    let p = run_to_end(&engine, "t1", "run:t1:3").await;
    assert_eq!(
        p["runs"][2]["providerThreadId"], p["runs"][0]["providerThreadId"],
        "the thread's own conversation goes on past the schedule's"
    );
    assert_eq!(
        provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
        3
    );
    // A fresh scheduled run delegates: the result wakes the conversation that asked for it
    // (`dispatchProviderThread`), not the thread's own.
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    dispatch(
        &engine,
        fresh_message(
            "t1",
            "c5",
            "hang",
            json!({"scheduledTaskId": "task:triage", "dispatchMode": {"type": "queue_after_active"}}),
        ),
    )
    .await;
    until_provider_turn(&mut stream).await;
    let mut ask = delegate("d1", "look", Some("always"));
    ask["parentRunId"] = json!("run:t1:4");
    ask["parentNodeId"] = json!("node:run:t1:4:root");
    dispatch(&engine, ask).await;
    let child = "thread:delegated-task:d1";
    run_to_end(&engine, child, &format!("run:{child}:1")).await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c6", "threadId": "t1"}),
    )
    .await;
    until_run_ends(&mut stream).await;
    dispatch(
        &engine,
        json!({"type": "queue.resume", "commandId": "r1", "threadId": "t1"}),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:5").await;
    let wake = p["runs"][4]["userMessageId"].as_str().unwrap();
    assert!(wake.starts_with("message:delegated-completion:"), "{wake}");
    assert_eq!(
        p["runs"][4]["providerThreadId"], p["runs"][3]["providerThreadId"],
        "the result goes to the fresh run's conversation"
    );
}

/// `ProviderSwitch.integration.test.ts` "starts a scheduled fresh run while the previous run's
/// session still has background work": the busy session stays open and the second fire
/// starts its own native thread in a new session.
#[tokio::test(flavor = "current_thread")]
async fn a_scheduled_fresh_run_keeps_a_busy_session_open() {
    let db = TempDb::new("fresh-scheduled-busy");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let fire = |command: &str, text: &str| {
        fresh_message(
            "t1",
            command,
            text,
            json!({"scheduledTaskId": "task:busy", "dispatchMode": {"type": "queue_after_active"}}),
        )
    };
    dispatch(&engine, fire("c2", "background-hold")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(&engine, fire("c3", "second")).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    let native = |run: usize| {
        let id = &p["runs"][run]["providerThreadId"];
        p["providerThreads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| &t["id"] == id)
            .map(|t| t["nativeThreadRef"].clone())
            .unwrap()
    };
    assert!(!native(1).is_null());
    assert_ne!(native(1), native(0));
    assert_eq!(
        count(&provider.closed),
        0,
        "closing the busy session would end its work"
    );
    assert_eq!(count(&provider.sessions), 2);
}

/// A busy session a fresh schedule moved aside still ends its native subagents when its
/// process exits on its own, though it is no longer the thread's current session.
#[tokio::test(flavor = "current_thread")]
async fn a_detached_session_that_exits_interrupts_its_native_subagents() {
    let db = TempDb::new("fresh-scheduled-exit");
    let exit = Arc::new(tokio::sync::Notify::new());
    let (engine, provider) = open_with(
        &db,
        FakeProvider::new("claudeAgent").with_process_exit(exit.clone()),
    );
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    let fire = |command: &str, text: &str| {
        fresh_message(
            "t1",
            command,
            text,
            json!({"scheduledTaskId": "task:busy", "dispatchMode": {"type": "queue_after_active"}}),
        )
    };
    dispatch(&engine, fire("c2", "background-hold")).await;
    until_run_ends(&mut thread).await;
    let provider_thread = provider_thread_of_t1(&engine).await;
    seed_native_subagents(&engine, &provider_thread).await;
    dispatch(&engine, fire("c3", "second")).await;
    let ended = until_run_ends(&mut thread).await;
    assert_eq!(ended.last().unwrap().1["id"], "run:t1:2");
    assert_eq!(count(&provider.sessions), 2);
    assert_eq!(count(&provider.closed), 0);
    exit.notify_waiters();
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "subagent.updated"
            && item["event"]["payload"]["id"] == "node:native"
            && item["event"]["payload"]["status"] == "interrupted"
        {
            break;
        }
    }
    assert_orphans_ended(&engine, "interrupted").await;
}

/// Counts the sessions the engine says left, as worktree cleanup hears of them.
#[derive(Default)]
struct ReleaseHost {
    released: std::sync::atomic::AtomicUsize,
    changed: tokio::sync::Notify,
}

impl crate::EngineHost for ReleaseHost {
    fn provision_worktree(
        &self,
        _request: crate::WorktreeRequest,
    ) -> crate::BoxFuture<'_, Result<crate::ProvisionedWorktree, String>> {
        Box::pin(std::future::ready(Err("no worktrees here".into())))
    }
    fn session_released(&self) {
        self.released
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.changed.notify_one();
    }
}

/// #310's review: a busy session a fresh schedule moved aside still runs in the thread's
/// folder, so worktree cleanup must count it after the replacement session closes (T3 checks
/// liveness by provider session, `storageCleanup.ts`). When it then exits on its own, cleanup
/// hears of it.
#[tokio::test(flavor = "current_thread")]
async fn a_detached_session_keeps_its_folder_in_use_until_it_exits() {
    let db = TempDb::new("detached-cwd");
    let exit = Arc::new(tokio::sync::Notify::new());
    let host = Arc::new(ReleaseHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(
        FakeProvider::new("claudeAgent").with_process_exit(exit.clone()),
    )];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    let fire = |command: &str, text: &str| {
        fresh_message(
            "t1",
            command,
            text,
            json!({"scheduledTaskId": "task:busy", "dispatchMode": {"type": "queue_after_active"}}),
        )
    };
    dispatch(&engine, fire("c2", "background-hold")).await;
    until_run_ends(&mut thread).await;
    dispatch(&engine, fire("c3", "second")).await;
    until_run_ends(&mut thread).await;
    // The replacement session closes; the one moved aside still runs its background work.
    engine.inner().close_session("t1").await;
    assert_eq!(engine.open_session_cwds().await.unwrap(), [ROOT]);
    let before = host.released.load(std::sync::atomic::Ordering::SeqCst);
    exit.notify_waiters();
    timeout(Duration::from_secs(5), async {
        while host.released.load(std::sync::atomic::Ordering::SeqCst) == before {
            host.changed.notified().await;
        }
    })
    .await
    .expect("cleanup hears that the detached session ended");
    assert!(engine.open_session_cwds().await.unwrap().is_empty());
}

/// #327's review: archiving deletes the thread's session rows and closes only its current
/// session, so a session a fresh schedule moved aside keeps its folder in use from memory.
#[tokio::test(flavor = "current_thread")]
async fn an_archived_threads_detached_session_keeps_its_folder_in_use() {
    let db = TempDb::new("detached-archived");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    let fire = |command: &str, text: &str| {
        fresh_message(
            "t1",
            command,
            text,
            json!({"scheduledTaskId": "task:busy", "dispatchMode": {"type": "queue_after_active"}}),
        )
    };
    dispatch(&engine, fire("c2", "background-hold")).await;
    until_run_ends(&mut thread).await;
    dispatch(&engine, fire("c3", "second")).await;
    until_run_ends(&mut thread).await;
    dispatch(
        &engine,
        json!({"type": "thread.archive", "commandId": "a1", "threadId": "t1"}),
    )
    .await;
    // The archive's session close ran.
    assert!(
        settled_statuses(&db, "provider-session.detach")
            .await
            .iter()
            .all(|s| s == "succeeded")
    );
    assert_eq!(count(&provider.closed), 1, "the busy session stays open");
    assert_eq!(engine.open_session_cwds().await.unwrap(), [ROOT]);
}

/// Force stop ends every session of the thread: the current one and one a fresh schedule
/// moved aside while it still ran background work.
#[tokio::test(flavor = "current_thread")]
async fn force_stop_closes_a_detached_busy_session() {
    let db = TempDb::new("fresh-scheduled-force-stop");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    let fire = |command: &str, text: &str| {
        fresh_message(
            "t1",
            command,
            text,
            json!({"scheduledTaskId": "task:busy", "dispatchMode": {"type": "queue_after_active"}}),
        )
    };
    dispatch(&engine, fire("c2", "background-hold")).await;
    until_run_ends(&mut thread).await;
    dispatch(&engine, fire("c3", "hang")).await;
    until_provider_turn(&mut thread).await;
    assert_eq!(count(&provider.sessions), 2);
    assert_eq!(count(&provider.closed), 0);
    let stopped = call(
        &engine,
        "orchestration.forceStopThread",
        json!({"threadId": "t1"}),
    )
    .await
    .unwrap();
    assert_eq!(stopped["outcome"], "killed");
    assert_eq!(
        count(&provider.closed),
        2,
        "the detached session closes too"
    );
}

/// `ThreadFork.execution.test.ts` "a fresh send in a fork that has not run yet starts without
/// the fork's context": a schedule's fresh send is refused, the user's supersedes the fork.
#[tokio::test(flavor = "current_thread")]
async fn a_user_fresh_send_in_a_fork_supersedes_the_fork() {
    let db = TempDb::new("fresh-fork");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "work")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(
        &engine,
        json!({
            "type": "thread.fork", "commandId": "f1", "sourceThreadId": "t1",
            "targetThreadId": "t2", "sourcePoint": {"type": "run", "runId": "run:t1:1"},
            "createdBy": "user", "creationSource": "web",
        }),
    )
    .await;
    let scheduled = refused(
        &engine,
        fresh_message(
            "t2",
            "c3",
            "scheduled",
            json!({"scheduledTaskId": "task:fork"}),
        ),
    )
    .await;
    assert!(scheduled.contains("still being applied"), "{scheduled}");
    dispatch(&engine, fresh_message("t2", "c4", "start over", json!({}))).await;
    let p = run_to_end(&engine, "t2", "run:t2:1").await;
    assert_eq!(p["runs"][0]["freshContext"], true);
    let forks: Vec<_> = p["contextTransfers"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["type"] == "fork")
        .map(|t| t["status"].clone())
        .collect();
    assert_eq!(forks, [json!("superseded")]);
    assert!(
        provider.forks.lock().unwrap().is_empty(),
        "nothing forks natively"
    );
}

fn calls(provider: &FakeProvider) -> Vec<String> {
    provider.calls.lock().unwrap().clone()
}

/// T3's effect outbox runs a thread's effects one at a time: a Stop the provider is still
/// finishing holds back the next turn start.
#[tokio::test(flavor = "current_thread")]
async fn a_stop_finishes_before_the_next_send_starts() {
    let db = TempDb::new("lane-stop");
    let (engine, provider) = open_with(
        &db,
        FakeProvider::new("claudeAgent").with_control_delay(Duration::from_millis(200)),
    );
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c3", "threadId": "t1"}),
    )
    .await;
    // The run ends with the provider's terminal, while its Stop still runs.
    until_run_ends(&mut thread).await;
    dispatch(&engine, message("t1", "c4", "next")).await;
    run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(
        calls(&provider),
        [
            "start run:t1:1",
            "interrupt run:t1:1",
            "interrupted run:t1:1",
            "start run:t1:2"
        ]
    );
}

/// Two sends start their turns in order, each after the one before.
#[tokio::test(flavor = "current_thread")]
async fn two_sends_start_in_order() {
    let db = TempDb::new("lane-two");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "first")).await;
    dispatch(&engine, message("t1", "c3", "second")).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(calls(&provider), ["start run:t1:1", "start run:t1:2"]);
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "completed".into()),
            ("run:t1:2".into(), "completed".into())
        ]
    );
}

/// `providerThreadLoadKey`: the session loads the native thread again only when the thread,
/// the selection or the policy changed since its last load.
#[tokio::test(flavor = "current_thread")]
async fn a_turn_start_resumes_the_thread_only_when_its_load_changes() {
    let db = TempDb::new("load-key");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "one")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(&engine, message("t1", "c3", "two")).await;
    run_to_end(&engine, "t1", "run:t1:2").await;
    assert!(provider.resumes.lock().unwrap().is_empty());
    dispatch(
        &engine,
        json!({
            "type": "thread.model-selection.set", "commandId": "c4", "threadId": "t1",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-sonnet-4-5"},
        }),
    )
    .await;
    dispatch(&engine, message("t1", "c5", "three")).await;
    run_to_end(&engine, "t1", "run:t1:3").await;
    dispatch(&engine, message("t1", "c6", "four")).await;
    run_to_end(&engine, "t1", "run:t1:4").await;
    assert_eq!(
        *provider.resumes.lock().unwrap(),
        ["native-1 claude-sonnet-4-5"]
    );
}

/// T3 marks the provider thread `active` at the turn start and `idle` when the run ends
/// (`runningProviderThread`, `finalProviderThreadStatus`).
#[tokio::test(flavor = "current_thread")]
async fn the_provider_thread_is_active_during_a_turn_and_idle_after() {
    let db = TempDb::new("thread-status");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["providerThreads"][0]["status"], "active");
    assert_eq!(p["providerThreads"][0]["lastRunOrdinal"], 1);
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c3", "threadId": "t1"}),
    )
    .await;
    until_run_ends(&mut thread).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["providerThreads"][0]["status"], "idle");
    dispatch(&engine, message("t1", "c4", "done")).await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["providerThreads"][0]["status"], "idle");
    assert_eq!(p["providerThreads"][0]["lastRunOrdinal"], 2);
}

/// T3's `writeFinalRunEvents` writes the run's provider thread at every turn end, also when
/// the provider already reported it `idle` during the turn (before, ours wrote it only from
/// `active`).
#[tokio::test(flavor = "current_thread")]
async fn every_turn_end_writes_the_provider_thread_idle() {
    let db = TempDb::new("thread-idle-every-end");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "thread-idle")).await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(p["providerThreads"][0]["status"], "idle");
    let events = engine.stored_events(0, 10_000).await.unwrap();
    let idle = events
        .iter()
        .filter(|stored| {
            stored["event"]["type"] == "provider-thread.updated"
                && stored["event"]["payload"]["status"] == "idle"
        })
        .count();
    assert_eq!(idle, 2, "the provider's own idle, then the turn end's");
}

/// Allows every instance but `off`.
struct OneInstanceOff;

impl crate::EngineHost for OneInstanceOff {
    fn provider_instance_enabled(&self, _project_id: Option<&str>, instance_id: &str) -> bool {
        instance_id != "off"
    }

    fn current_branch(&self, cwd: &str) -> conn_provider::BoxFuture<'_, Option<String>> {
        let branch = (cwd == ROOT).then(|| "main".to_owned());
        Box::pin(std::future::ready(branch))
    }
}

/// `ThreadLaunchService`: a disabled instance is refused before the thread exists, and a
/// project-folder launch that names no branch records the folder's checkout.
#[tokio::test(flavor = "current_thread")]
async fn a_launch_records_the_folder_branch_and_refuses_a_disabled_instance_first() {
    let db = TempDb::new("launch-branch");
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(Arc::new(OneInstanceOff));
    let engine = SqliteEngine::open(config).unwrap();
    let launch = |id: &str, instance: &str, strategy: Value| {
        json!({
            "commandId": format!("c-{id}"), "threadId": id, "projectId": project_id(),
            "title": "T", "modelSelection": {"instanceId": instance, "model": "m"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "workspaceStrategy": strategy,
        })
    };
    let refused = engine
        .launch_thread(launch("t-off", "off", json!({"type": "root"})))
        .await;
    let Err(EngineError::Rejected(error)) = refused else {
        panic!("expected a refusal");
    };
    assert_eq!(
        error["message"],
        format!(
            "Provider instance \"off\" is disabled for project {}.",
            project_id()
        )
    );
    assert!(
        engine
            .get_thread_projection(conn_contract::ThreadId::from("t-off"))
            .await
            .is_err()
    );
    engine
        .launch_thread(launch("t-root", "claudeAgent", json!({"type": "root"})))
        .await
        .unwrap();
    assert_eq!(
        projection(&engine, "t-root").await["thread"]["branch"],
        "main"
    );
    engine
        .launch_thread(launch(
            "t-named",
            "claudeAgent",
            json!({"type": "root", "branch": "dev"}),
        ))
        .await
        .unwrap();
    assert_eq!(
        projection(&engine, "t-named").await["thread"]["branch"],
        "dev"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_message_to_a_disabled_instance_is_refused_at_dispatch() {
    let db = TempDb::new("instance-off");
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(Arc::new(OneInstanceOff));
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut off = message("t1", "c2", "hello");
    off["modelSelection"] = json!({"instanceId": "off", "model": "m"});
    let refused = engine.dispatch(from_json(off).unwrap()).await;
    let Err(EngineError::Rejected(error)) = refused else {
        panic!("expected a refusal");
    };
    assert_eq!(
        to_json(&error)["message"],
        format!(
            "Provider instance \"off\" is disabled for project {}.",
            project_id()
        )
    );
    // Nothing of the refused message was written; a message to an enabled instance runs.
    assert!(
        projection(&engine, "t1").await["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    dispatch(&engine, message("t1", "c3", "hello")).await;
    assert_eq!(
        projection(&engine, "t1").await["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// `dispatchThreadStop` with no active run: background work that outlives the latest run
/// is the Stop's target, and the provider gets the settled turn (`interruptTurn` with
/// `requestRuntimeRestart`). Without such work, Stop calls no provider.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn stop_without_a_run_reaches_background_work() {
    let db = TempDb::new("bg-stop");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.clock = paused_clock();
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c3", "threadId": "t1"}),
    )
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let calls = crate::lock(&provider.calls).clone();
    assert!(
        !calls.iter().any(|c| c.starts_with("stop background")),
        "{calls:?}"
    );

    dispatch(&engine, message("t1", "c4", "background-reported")).await;
    run_to_end(&engine, "t1", "run:t1:2").await;
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "c5", "threadId": "t1"}),
    )
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let calls = crate::lock(&provider.calls).clone();
    assert_eq!(
        calls
            .iter()
            .filter(|c| c.starts_with("stop background"))
            .count(),
        1,
        "{calls:?}"
    );
}

/// Force stop while the provider still starts the turn: the start's late failure finds the run
/// ended and must not hold the queue (review finding 2.3). `hang` is the control: no late
/// failure.
#[tokio::test(flavor = "current_thread")]
async fn a_late_start_failure_after_force_stop_does_not_hold_the_queue() {
    for (case, text) in [("control", "hang"), ("race", "slowstart")] {
        let db = TempDb::new(&format!("checker-force-{case}"));
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .unwrap();
        next(&mut thread).await;
        dispatch(&engine, message("t1", "c2", text)).await;
        if case == "control" {
            until_provider_turn(&mut thread).await;
        } else {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        dispatch(&engine, message("t1", "c3", "later")).await;
        dispatch(&engine, message("t1", "c4", "even later")).await;
        let stopped = call(
            &engine,
            "orchestration.forceStopThread",
            json!({"threadId": "t1"}),
        )
        .await;
        assert!(stopped.is_ok(), "{case}: {stopped:?}");
        tokio::time::sleep(Duration::from_millis(800)).await;
        let p = projection(&engine, "t1").await;
        let runs: Vec<_> = p["runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["ordinal"].clone(),
                    r["status"].clone(),
                    r["queueHeld"] == true,
                )
            })
            .collect();
        assert_eq!(
            runs,
            [
                (json!(1), json!("interrupted"), false),
                (json!(2), json!("completed"), false),
                (json!(3), json!("completed"), false),
            ],
            "{case}: a late failure of an ended run does not hold the queue"
        );
    }
}

/// A settle close stored by an earlier build (`"reason": "settled"`, before closes named their
/// settlement) still decodes after a restart and reaches the host, which then cannot tell
/// whether its settle script ran.
#[tokio::test(flavor = "current_thread")]
async fn a_settle_close_stored_without_its_settlement_still_runs() {
    let db = TempDb::new("legacy-settle-close");
    // The earlier process, opened off the runtime so its own worker never claims the row.
    let previous = std::thread::spawn({
        let path = db.path();
        move || SqliteEngine::open(EngineConfig::new(path)).unwrap()
    })
    .join()
    .unwrap();
    previous
        .inner()
        .db(|store| {
            store.raw().execute(
                "INSERT INTO effect_outbox (thread_id, lane, effect_type, payload, status,
                   created_at, updated_at)
                 VALUES ('t1', 'thread', 'thread.closed',
                   '{\"type\":\"thread.closed\",\"threadId\":\"t1\",\"reason\":\"settled\"}',
                   'pending', '', '')",
                [],
            )
        })
        .await
        .unwrap();
    drop(previous);

    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    timeout(Duration::from_secs(5), async {
        while host.closed.lock().unwrap().is_empty() {
            host.closed_event.notified().await;
        }
    })
    .await
    .expect("the stored close reached the host");
    let closed = host.closed.lock().unwrap().clone();
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0].0, "t1");
    assert_eq!(format!("{:?}", closed[0].1), "SettledUnnamed");
    drop(engine);
}

/// A thread's effects run in the order their writes committed (T3's outbox claims by row
/// order). A write that rolled back leaves no row and holds nothing.
#[tokio::test(flavor = "current_thread")]
async fn lane_order_is_commit_order() {
    let db = TempDb::new("lane-commit");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    let close = |reason| crate::commands::Effect::ThreadClosed {
        thread_id: "t1".into(),
        reason,
    };
    let hold = engine.test_hold_lane("t1").await;
    let inner = engine.inner().clone();
    let effects = [
        (close(crate::ThreadClose::Archived), true),
        (
            close(crate::ThreadClose::Settled {
                settled_at: String::new(),
            }),
            false,
        ),
        (close(crate::ThreadClose::Deleted), true),
    ];
    for (effect, commits) in effects {
        inner
            .db(move |store| {
                let mut tx = store.tx().unwrap();
                tx.enqueue(None, &[effect]).unwrap();
                if commits {
                    tx.commit(None).unwrap();
                } else {
                    tx.rollback();
                }
            })
            .await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        host.closed.lock().unwrap().is_empty(),
        "waits for the running row"
    );
    engine.test_release_lane(hold).await;
    timeout(Duration::from_secs(5), async {
        while host.closed.lock().unwrap().len() < 2 {
            host.closed_event.notified().await;
        }
    })
    .await
    .expect("both rows ran");
    assert_eq!(
        *host.closed.lock().unwrap(),
        [
            ("t1".to_owned(), crate::ThreadClose::Archived),
            ("t1".to_owned(), crate::ThreadClose::Deleted),
        ]
    );
}

// ---- Stop before the provider accepted the turn (T3's "before provider start") ----

fn stop(thread: &str, command: &str) -> Value {
    json!({"type": "thread.stop", "commandId": command, "threadId": thread})
}

/// The events of the commit at `seq` and the commits before it down to `after`: `(type,
/// payload)`.
async fn events_between(engine: &SqliteEngine, after: u64, through: u64) -> Vec<(String, Value)> {
    engine
        .stored_events(after, 10_000)
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e["sequence"].as_u64().unwrap_or(0) <= through)
        .map(|e| {
            (
                e["event"]["type"].as_str().unwrap_or_default().to_owned(),
                e["event"]["payload"].clone(),
            )
        })
        .collect()
}

fn run_of<'a>(p: &'a Value, id: &str) -> &'a Value {
    p["runs"]
        .as_array()
        .and_then(|runs| runs.iter().find(|r| r["id"] == id))
        .unwrap_or(&Value::Null)
}

fn item_of<'a>(p: &'a Value, id: &str) -> &'a Value {
    p["turnItems"]
        .as_array()
        .and_then(|items| items.iter().find(|i| i["id"] == id))
        .unwrap_or(&Value::Null)
}

/// Stop while the provider still starts the turn (Claude's cold start: the provider turn shows
/// at once, the CLI boots for minutes). The run ends in the Stop's own commit, as T3's
/// `dispatchRunInterrupt` "before provider start": the Stop request, its result, then the
/// attempt, node and run `interrupted`; no capture, the provider thread untouched. The start is
/// abandoned (the provider is told at once, not after the start), the queue is held, and the
/// next send starts cleanly. Before: Stop waited in the lane behind the start (here 500 ms).
#[tokio::test(flavor = "current_thread")]
async fn stop_during_a_slow_start_ends_the_run_at_once() {
    let db = TempDb::new("stop-cold-start");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "coldstart")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, message("t1", "c4", "queued")).await;
    let before = engine.stored_events(0, 100_000).await.unwrap();
    let after = before.last().and_then(|e| e["sequence"].as_u64()).unwrap();
    let started = std::time::Instant::now();
    let seq = dispatch(&engine, stop("t1", "c5")).await;
    let committed = events_between(&engine, after, seq).await;
    let types: Vec<_> = committed.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(
        types,
        [
            "run.updated", // the queued run is held
            "turn-item.updated",
            "turn-item.updated",
            "run-attempt.updated",
            "node.updated",
            "run.updated",
        ],
        "{committed:#?}"
    );
    let p = projection(&engine, "t1").await;
    assert!(started.elapsed() < Duration::from_millis(400), "at once");
    let run = run_of(&p, "run:t1:2");
    assert_eq!(run["status"], "interrupted");
    assert!(run["completedAt"].is_string());
    let request = item_of(&p, "turn-item:run:t1:2:interrupt-request");
    let result = item_of(&p, "turn-item:run:t1:2:interrupt-result");
    assert_eq!(request["message"], "Stopped by user");
    assert_eq!(request["providerTurnId"], Value::Null);
    assert_eq!(result["type"], "run_interrupt_result");
    assert_eq!(result["status"], "interrupted");
    assert_eq!(result["title"], "Interrupted");
    assert_eq!(result["message"], "Run interrupted before provider start");
    assert_eq!(result["parentItemId"], request["id"]);
    assert_eq!(
        result["ordinal"].as_u64(),
        request["ordinal"].as_u64().map(|o| o + 1)
    );
    assert_eq!(run_of(&p, "run:t1:3")["status"], "queued");
    assert_eq!(run_of(&p, "run:t1:3")["queueHeld"], true);
    // The provider heard of it before its start ended, and got no interrupt.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let calls = crate::lock(&provider.calls).clone();
    assert!(calls.contains(&"abandon run:t1:2".to_owned()), "{calls:?}");
    assert!(
        calls.contains(&"start abandoned run:t1:2".to_owned()),
        "{calls:?}"
    );
    assert!(
        !calls.iter().any(|c| c == "interrupt run:t1:2"),
        "{calls:?}"
    );
    // The provider's own end of its early turn changes nothing on the run.
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "interrupted");
    assert_eq!(
        p["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["runId"] == "run:t1:2" && i["type"] == "error")
            .count(),
        0
    );
    // A second Stop changes nothing.
    let seq2 = dispatch(&engine, stop("t1", "c6")).await;
    assert!(
        events_between(&engine, seq, seq2)
            .await
            .iter()
            .all(|(t, _)| t != "turn-item.updated" && t != "run.updated"),
    );
    // The next send releases the queue; both run.
    dispatch(&engine, message("t1", "c7", "after")).await;
    run_to_end(&engine, "t1", "run:t1:4").await;
    let p = run_to_end(&engine, "t1", "run:t1:3").await;
    assert_eq!(run_of(&p, "run:t1:3")["status"], "completed");
    assert_eq!(run_of(&p, "run:t1:4")["status"], "completed");
    assert_eq!(
        crate::lock(&provider.calls)
            .iter()
            .filter(|c| c.as_str() == "abandon run:t1:2")
            .count(),
        1
    );
}

/// Stop while the start still waits in the thread's lane: the run ends at once and the
/// provider never gets the start (T3 cancels the `provider-turn.start` before it executes).
#[tokio::test(flavor = "current_thread")]
async fn stop_before_the_start_runs_never_starts_the_provider() {
    let db = TempDb::new("stop-lane");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let blocker = engine.test_hold_lane("t1").await;
    dispatch(&engine, message("t1", "c3", "hello again")).await;
    dispatch(&engine, stop("t1", "c4")).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "interrupted");
    assert_eq!(
        item_of(&p, "turn-item:run:t1:2:interrupt-result")["message"],
        "Run interrupted before provider start"
    );
    engine.test_release_lane(blocker).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let calls = crate::lock(&provider.calls).clone();
    assert!(!calls.iter().any(|c| c == "start run:t1:2"), "{calls:?}");
    assert_eq!(
        run_of(&projection(&engine, "t1").await, "run:t1:2")["status"],
        "interrupted"
    );
}

/// The race the other way: the provider accepted the turn right after Stop ended the run (a
/// provider that cannot abandon its start). The engine interrupts the turn it then reports, as
/// T3 interrupts a provider turn that starts after Stop.
#[tokio::test(flavor = "current_thread")]
async fn a_turn_accepted_after_stop_is_interrupted() {
    let db = TempDb::new("stop-late-accept");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let mut changes = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut changes).await;
    dispatch(&engine, message("t1", "c3", "latestart")).await;
    provider.late_start_entered.notified().await;
    dispatch(&engine, stop("t1", "c4")).await;
    assert_eq!(
        run_of(&projection(&engine, "t1").await, "run:t1:2")["status"],
        "interrupted"
    );
    loop {
        let item = next(&mut changes).await;
        let event = &item["event"];
        if event["type"] == "provider-turn.updated"
            && event["payload"]["runAttemptId"] == "run:t1:2:attempt:1"
            && event["payload"]["status"] == "interrupted"
        {
            break;
        }
    }
    let calls = crate::lock(&provider.calls).clone();
    assert!(calls.contains(&"abandon run:t1:2".to_owned()), "{calls:?}");
    assert!(
        calls.contains(&"interrupt run:t1:2".to_owned()),
        "{calls:?}"
    );
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "interrupted");
    let turns: Vec<_> = p["providerTurns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["runAttemptId"] == "run:t1:2:attempt:1")
        .map(|t| t["status"].clone())
        .collect();
    assert_eq!(turns, [json!("interrupted")]);
    // The next send runs.
    dispatch(&engine, message("t1", "c5", "after")).await;
    assert_eq!(
        run_of(&run_to_end(&engine, "t1", "run:t1:3").await, "run:t1:3")["status"],
        "completed"
    );
}

/// A Stop after the provider accepted the turn still takes the normal path: the request
/// waits for the provider's own end.
#[tokio::test(flavor = "current_thread")]
async fn stop_after_the_start_was_accepted_interrupts_the_provider() {
    let db = TempDb::new("stop-accepted");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    until_provider_turn(&mut thread).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    dispatch(&engine, stop("t1", "c3")).await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    let result = item_of(&p, "turn-item:run:t1:1:interrupt-result");
    assert_eq!(result["message"], "Stopped by user");
    let calls = crate::lock(&provider.calls).clone();
    assert!(
        calls.contains(&"interrupt run:t1:1".to_owned()),
        "{calls:?}"
    );
    assert!(!calls.iter().any(|c| c.starts_with("abandon")), "{calls:?}");
}

/// Force stop during a slow start: T3 dispatches `run.interrupt` with the Force stop reason,
/// which takes the same branch, then releases the session.
#[tokio::test(flavor = "current_thread")]
async fn force_stop_during_a_slow_start_ends_the_run_before_provider_start() {
    let db = TempDb::new("force-cold-start");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "coldstart")).await;
    until_provider_turn(&mut thread).await;
    let stopped = call(
        &engine,
        "orchestration.forceStopThread",
        json!({"threadId": "t1"}),
    )
    .await;
    assert_eq!(
        stopped,
        Ok(json!({"outcome": "killed", "sharedWithThreadIds": []}))
    );
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "interrupted");
    assert_eq!(
        item_of(&p, "turn-item:run:t1:2:interrupt-request")["message"],
        "Force stopped by user"
    );
    assert_eq!(
        item_of(&p, "turn-item:run:t1:2:interrupt-result")["message"],
        "Run interrupted before provider start"
    );
    assert!(count(&provider.closed) >= 1);
    dispatch(&engine, message("t1", "c4", "after")).await;
    assert_eq!(
        run_of(&run_to_end(&engine, "t1", "run:t1:3").await, "run:t1:3")["status"],
        "completed"
    );
}

/// A model change queued behind the slow start waits for the start to end, and the next turn
/// uses it; a restart send (`restart_active`) during the start ends the run at once and starts
/// the new message.
#[tokio::test(flavor = "current_thread")]
async fn work_queued_behind_an_abandoned_start_runs_after_it() {
    let db = TempDb::new("stop-cold-start-queue");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c3", "coldstart")).await;
    until_provider_turn(&mut thread).await;
    dispatch(&engine, model_selection_set("c4", "claudeAgent")).await;
    let mut restart = message("t1", "c5", "restarted");
    restart["dispatchMode"] = json!({"type": "restart_active", "targetRunId": "run:t1:2"});
    dispatch(&engine, restart).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "interrupted");
    assert_eq!(
        item_of(&p, "turn-item:run:t1:2:interrupt-result")["message"],
        "Run interrupted before provider start"
    );
    let p = run_to_end(&engine, "t1", "run:t1:3").await;
    assert_eq!(run_of(&p, "run:t1:3")["status"], "completed");
    assert_eq!(run_of(&p, "run:t1:3")["modelSelection"]["model"], "m");
    let calls = crate::lock(&provider.calls).clone();
    let abandoned = calls.iter().position(|c| c == "start abandoned run:t1:2");
    let next_start = calls.iter().position(|c| c == "start run:t1:3");
    assert!(abandoned.is_some() && abandoned < next_start, "{calls:?}");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_pending_workflow_stop_does_not_block_another_threads_dispatch() {
    use std::hash::{Hash, Hasher};
    let stripe = |id: &str| {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut hash);
        hash.finish() % 64
    };
    // Exercise two ids that collided in the old stripe table.
    let other = (0..4096)
        .map(|n| format!("other-{n}"))
        .find(|id| stripe(id) == stripe("t1"))
        .unwrap();
    let db = TempDb::new("workflow-stop-isolation");
    let (engine, provider) = open_with(
        &db,
        FakeProvider::new("claudeAgent").with_control_delay(Duration::from_secs(60)),
    );
    let engine = Arc::new(engine);
    dispatch(&engine, create("t1", "create-workflow")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    let _ = next(&mut stream).await;
    dispatch(&engine, message("t1", "start-workflow", "workflow")).await;
    loop {
        if next(&mut stream).await["event"]["type"] == "subagent.updated" {
            break;
        }
    }
    let stopping = engine.clone();
    let mut stop = tokio::spawn(async move {
        stopping
            .call(
                "orchestration.stopWorkflow",
                json!({"threadId":"t1","subagentId":"workflow-coordinator"}),
            )
            .await
    });
    provider.workflow_stop_entered.notified().await;
    tokio::select! {
        biased;
        _ = dispatch(&engine, create(&other, "create-other")) => {},
        result = &mut stop => panic!("another thread waited for workflow Stop: {result:?}"),
    }
    stop.abort();
    assert!(stop.await.unwrap_err().is_cancelled());
    engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn workflow_stop_uses_the_run_session_and_keeps_the_thread_running() {
    let db = TempDb::new("workflow-stop");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "create-workflow")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    let _ = next(&mut stream).await;
    dispatch(&engine, message("t1", "start-workflow", "workflow")).await;
    loop {
        let item = next(&mut stream).await;
        if item["event"]["type"] == "subagent.updated" {
            break;
        }
    }
    let request = json!({"threadId":"t1","subagentId":"workflow-coordinator"});
    let mut limited = request.clone();
    limited["modeLimit"] = json!({"runtimeMode":"auto-accept-edits","interactionMode":"default"});
    let Err(EngineError::Rejected(error)) =
        engine.call("orchestration.stopWorkflow", limited).await
    else {
        panic!("a narrower caller stopped the workflow");
    };
    assert_eq!(error["code"], "runtime_mode_escalation_denied");
    let expected_message = "Thread t1 now runs in full-access/default mode, above this caller's. Its user changed it while this call ran.";
    assert_eq!(error["message"], expected_message);
    let mut limited = request.clone();
    limited["modeLimit"] = json!({"runtimeMode":"full-access","interactionMode":"plan"});
    let Err(EngineError::Rejected(error)) =
        engine.call("orchestration.stopWorkflow", limited).await
    else {
        panic!("a plan caller stopped the workflow");
    };
    assert_eq!(error["code"], "interaction_mode_escalation_denied");
    assert_eq!(error["message"], expected_message);

    assert!(
        !crate::lock(&provider.calls)
            .iter()
            .any(|c| c.starts_with("stop workflow"))
    );
    assert_eq!(
        engine
            .call("orchestration.stopWorkflow", request.clone())
            .await
            .unwrap(),
        Value::Null
    );
    assert!(crate::lock(&provider.calls).contains(&"stop workflow wf1".to_owned()));
    let projection = engine.get_thread_projection("t1".into()).await.unwrap();
    assert_eq!(projection["runs"][0]["status"], "running");
    engine.shutdown().await;
    let Err(EngineError::Rejected(error)) =
        engine.call("orchestration.stopWorkflow", request).await
    else {
        panic!("stopped a released session");
    };
    assert_eq!(error["reason"], "unavailable");
}

#[tokio::test(flavor = "current_thread")]
async fn secret_cards_keep_their_position_and_final_status_and_cancel_on_restart() {
    let db = TempDb::new("secret-cards");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "secret-thread")).await;
        let mut changes = engine
            .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
            .await
            .unwrap();
        next(&mut changes).await;
        dispatch(&engine, message("t1", "secret-run", "hang")).await;
        until_provider_turn(&mut changes).await;
        let p = projection(&engine, "t1").await;
        let run = &p["runs"][0];
        let command = json!({"commandId":"secret-pending","threadId":"t1","runId":run["id"],"nodeId":run["rootNodeId"],"turnItemId":"secret-card","label":"API key","reason":"Test","secretStatus":"pending"});
        // A refused command's id stays refused (its receipt), so the wrong try has its own.
        let mut wrong = command.clone();
        wrong["commandId"] = json!("secret-wrong");
        wrong["nodeId"] = json!("wrong");
        wrong["commandId"] = json!("secret-wrong");
        assert!(engine.record_secret_request(wrong).await.is_err());
        engine.record_secret_request(command.clone()).await.unwrap();
        let p = projection(&engine, "t1").await;
        let initial = p["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == "secret-card")
            .unwrap();
        let mut declined = command.clone();
        declined["commandId"] = json!("secret-declined");
        declined["secretStatus"] = json!("declined");
        engine.record_secret_request(declined).await.unwrap();
        let mut again = command.clone();
        again["commandId"] = json!("secret-again");
        engine.record_secret_request(again).await.unwrap();
        let p = projection(&engine, "t1").await;
        let cards: Vec<_> = p["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["id"] == "secret-card")
            .collect();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["secretStatus"], "declined");
        assert_eq!(cards[0]["ordinal"], initial["ordinal"]);
        assert_eq!(cards[0]["startedAt"], initial["startedAt"]);
        let mut waiting = command;
        waiting["commandId"] = json!("secret-waiting");
        waiting["turnItemId"] = json!("restart-card");
        engine.record_secret_request(waiting).await.unwrap();
        engine.begin_shutdown();
        engine.shutdown().await;
    }
    let (engine, _) = open(&db);
    let p = projection(&engine, "t1").await;
    assert_eq!(
        p["runs"].as_array().unwrap().len(),
        1,
        "a run waiting on a card is never auto-resumed"
    );
    assert_eq!(
        p["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == "restart-card")
            .unwrap()["secretStatus"],
        "cancelled"
    );
    engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn closing_a_secret_card_clears_the_shell_snapshot_and_resume_stream() {
    let db = TempDb::new("secret-shell-close");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "secret-shell-thread")).await;
    let mut changes = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    next(&mut changes).await;
    dispatch(&engine, message("t1", "secret-shell-run", "hang")).await;
    until_provider_turn(&mut changes).await;
    let p = projection(&engine, "t1").await;
    let run = &p["runs"][0];
    for status in ["saved", "declined", "cancelled"] {
        let item = format!("secret-{status}");
        let mut command = json!({"commandId":format!("{item}-pending"),"threadId":"t1","runId":run["id"],"nodeId":run["rootNodeId"],"turnItemId":item,"label":"Key","reason":"Fixture","secretStatus":"pending"});
        engine.record_secret_request(command.clone()).await.unwrap();
        let before = engine.shell_snapshot().await.unwrap();
        assert_eq!(before["threads"][0]["pendingRuntimeRequest"]["id"], item);
        command["commandId"] = json!(format!("{item}-closed"));
        command["secretStatus"] = json!(status);
        engine.record_secret_request(command).await.unwrap();
        let after = engine.shell_snapshot().await.unwrap();
        assert!(
            after["threads"][0]["pendingRuntimeRequest"].is_null(),
            "{status}: {after}"
        );
        let mut shell = engine.subscribe_shell(from_json(json!({"afterSequence":before["snapshotSequence"],"requestCompletionMarker":true})).unwrap()).await.unwrap();
        let changed = next(&mut shell).await;
        assert_eq!(changed["kind"], "thread.updated", "{status}: {changed}");
        assert!(
            changed["thread"]["pendingRuntimeRequest"].is_null(),
            "{status}: {changed}"
        );
    }
    engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn mcp_apps_calls_only_the_source_session_and_stores_context_without_a_session() {
    let db = TempDb::new("mcp-apps");
    struct AppSnapshots;
    impl crate::EngineHost for AppSnapshots {
        fn snapshot_mcp_app(
            &self,
            _thread: String,
            source: conn_provider::mcp_apps::Source,
            contents: Value,
        ) -> crate::BoxFuture<'_, Result<Option<Value>, String>> {
            Box::pin(async move {
                assert_eq!(source.resource_uri, "ui://stub");
                assert_eq!(contents[0]["text"], "<h1>App</h1>");
                Ok(Some(
                    json!({"attachmentId":"snapshot-html","server":source.server,"tool":source.tool,"resourceUri":source.resource_uri}),
                ))
            })
        }
    }
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.host = Some(Arc::new(AppSnapshots));
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    dispatch(&engine, message("t1", "c2", "mcp-app")).await;
    until_run_ends(&mut stream).await;
    let projection = engine.get_thread_projection("t1".into()).await.unwrap();
    let item = projection["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == "app:item")
        .unwrap();
    assert_eq!(item["output"]["t3McpApp"]["attachmentId"], "snapshot-html");
    assert_eq!(
        item["output"]["result"]["content"],
        json!([{"type":"text","text":"Weather"}])
    );
    let live = crate::lock(&engine.inner().live)
        .values()
        .next()
        .unwrap()
        .clone();
    let codex: Value = serde_json::from_str(include_str!(
        "../../conn-provider-codex/testdata/mcp-app.json"
    ))
    .unwrap();
    let native_item = codex["transcript"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["label"] == "item/completed/app-tool")
        .unwrap()["frame"]["params"]["item"]
        .clone();
    let mut failed = item.clone();
    failed["status"] = native_item["status"].clone();
    failed["output"] = native_item["result"].clone();
    let captured = engine
        .inner()
        .capture_app_event(
            &live,
            conn_provider::ProviderEvent::McpAppCapture {
                turn_item: from_json(failed).unwrap(),
                source: conn_provider::mcp_apps::Source {
                    server: "stub".into(),
                    tool: "show".into(),
                    resource_uri: "ui://stub".into(),
                },
            },
        )
        .await;
    let conn_provider::ProviderEvent::TurnItemUpdated {
        turn_item: captured,
    } = captured
    else {
        panic!("expected captured tool");
    };
    let captured = to_json(&captured);
    assert_eq!(captured["status"], "failed");
    assert_eq!(
        captured["output"]["t3McpApp"]["attachmentId"],
        "snapshot-html"
    );
    assert_eq!(
        captured["output"]["result"], codex["result"],
        "T3's failed, deferred tool retains its App and isError result"
    );
    let claude: Value = serde_json::from_str(include_str!(
        "../../conn-provider-claude/testdata/mcp-app-forged.json"
    ))
    .unwrap();
    let forged_output = claude["frames"]
        .as_array()
        .unwrap()
        .iter()
        .find(|frame| frame["type"] == "user")
        .unwrap()["tool_use_result"]
        .clone();
    let mut raw = item.clone();
    raw["toolName"] = json!("mcp__probe_server__refresh_weather");
    raw["output"] = forged_output;
    let sanitized = engine
        .inner()
        .capture_app_event(
            &live,
            conn_provider::ProviderEvent::TurnItemUpdated {
                turn_item: from_json(raw).unwrap(),
            },
        )
        .await;
    let conn_provider::ProviderEvent::TurnItemUpdated { turn_item } = sanitized else {
        panic!("expected plain MCP item");
    };
    assert_eq!(
        to_json(&turn_item)["output"],
        claude["output"],
        "same forged SDK result as T3's adapter test"
    );
    let forged = json!({"attachmentId":"forged-html","server":"weather","tool":"show","resourceUri":"ui://weather"});
    for status in ["completed", "failed"] {
        for run in [Value::Null, json!("run-1")] {
            for output in [
                json!({"t3McpApp":forged}),
                json!({"structuredContent":{"t3McpApp":forged}}),
                json!({"content":[{"type":"text","text":json!({"t3McpApp":forged}).to_string()}]}),
            ] {
                let mut raw = item.clone();
                raw["toolName"] = json!("mcp__weather__show");
                raw["status"] = json!(status);
                raw["runId"] = run.clone();
                raw["output"] = output.clone();
                let sanitized = engine
                    .inner()
                    .capture_app_event(
                        &live,
                        conn_provider::ProviderEvent::TurnItemUpdated {
                            turn_item: from_json(raw).unwrap(),
                        },
                    )
                    .await;
                let conn_provider::ProviderEvent::TurnItemUpdated { turn_item } = sanitized else {
                    panic!("expected plain tool row");
                };
                let sanitized = to_json(&turn_item);
                assert_eq!(
                    sanitized["output"],
                    json!({"result":output}),
                    "strip every forged envelope, status {status}, run {run}"
                );
                assert!(conn_provider::mcp_apps::app_reference(&sanitized).is_none());
            }
        }
    }
    let target = json!({"threadId":"t1","itemId":"app:item","name":"refresh"});
    let info = engine
        .call("mcpApps.toolInfo", target.clone())
        .await
        .unwrap();
    assert_eq!(info["callable"], true);
    assert_eq!(info["readOnly"], true);
    assert_eq!(info["title"], "Refresh");
    let result = engine.call("mcpApps.callTool",json!({"threadId":"t1","itemId":"app:item","name":"refresh","arguments":{"city":"Amsterdam"}})).await.unwrap();
    assert_eq!(
        result["content"],
        json!([{"type":"text","text":"Amsterdam"}])
    );
    let resources = engine
        .call(
            "mcpApps.readResource",
            json!({"threadId":"t1","itemId":"app:item","uri":"ui://other"}),
        )
        .await
        .unwrap();
    assert_eq!(resources["contents"][0]["uri"], "ui://other");
    for name in ["hidden", "missing"] {
        let error = engine
            .call(
                "mcpApps.callTool",
                json!({"threadId":"t1","itemId":"app:item","name":name,"arguments":{}}),
            )
            .await
            .unwrap_err();
        assert!(matches!(error,EngineError::Rejected(v) if v["reason"] == "tool-not-callable"));
    }
    engine.shutdown().await;
    let stopped = engine.call("mcpApps.toolInfo", target).await.unwrap_err();
    assert!(matches!(stopped,EngineError::Rejected(v) if v["reason"] == "session-stopped"));
    let context = |content| json!({"threadId":"t1","itemId":"app:item","conversationThreadId":"t1","content":content});
    engine
        .call(
            "mcpApps.updateModelContext",
            context(json!([{"type":"text","text":"one"}])),
        )
        .await
        .unwrap();
    engine
        .call(
            "mcpApps.updateModelContext",
            context(json!([{"type":"text","text":"two"}])),
        )
        .await
        .unwrap();
    assert_eq!(
        engine.inner().app_context("t1".into()).await.unwrap(),
        vec![conn_provider::AppContextEntry {
            key: "mcp_app_app_item".into(),
            text: "two".into()
        }]
    );
    let mut fork = projection["thread"].clone();
    fork["id"] = json!("fork");
    fork["lineage"] =
        json!({"rootThreadId":"t1","parentThreadId":"t1","relationshipToParent":"fork"});
    let mut unrelated = fork.clone();
    unrelated["id"] = json!("other");
    unrelated["lineage"] =
        json!({"rootThreadId":"other","parentThreadId":null,"relationshipToParent":null});
    engine
        .inner()
        .db(move |s| {
            let mut tx = s.tx()?;
            tx.append(crate::store::Draft::new("fork", "thread.created", fork))?;
            tx.append(crate::store::Draft::new(
                "other",
                "thread.created",
                unrelated,
            ))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    let fork_input = json!({"threadId":"t1","itemId":"app:item","conversationThreadId":"fork","structuredContent":{"city":"Amsterdam"}});
    engine
        .call("mcpApps.updateModelContext", fork_input)
        .await
        .unwrap();
    assert_eq!(
        engine.inner().app_context("fork".into()).await.unwrap()[0].text,
        "{\"city\":\"Amsterdam\"}"
    );
    let unrelated = engine
        .call(
            "mcpApps.updateModelContext",
            json!({"threadId":"t1","itemId":"app:item","conversationThreadId":"other"}),
        )
        .await
        .unwrap_err();
    assert!(matches!(unrelated,EngineError::Rejected(v) if v["reason"] == "not-an-app"));
    let mut run = projection["runs"][0].clone();
    run["status"] = json!("rolled_back");
    engine
        .inner()
        .db(move |s| {
            let mut tx = s.tx()?;
            tx.append(crate::store::Draft::new("t1", "run.updated", run))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    assert!(
        engine
            .inner()
            .app_context("t1".into())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        engine
            .inner()
            .app_context("fork".into())
            .await
            .unwrap()
            .len(),
        1
    );
    for (content, reason) in [
        (json!([{"type":"image"}]), "unsupported-content"),
        (
            json!([{"type":"text","text":"é".repeat(8193)}]),
            "request-failed",
        ),
    ] {
        let error = engine
            .call("mcpApps.updateModelContext", context(content))
            .await
            .unwrap_err();
        assert!(matches!(error,EngineError::Rejected(v) if v["reason"] == reason));
    }
    engine
        .call("mcpApps.updateModelContext", context(json!([])))
        .await
        .unwrap();
    assert!(
        engine
            .inner()
            .app_context("t1".into())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "App requests never open sessions"
    );
}

/// `GET /api/orchestration/threads/:threadId/transcript`: the thread snapshot cut down, and a
/// read that stops at the first row past the limit.
#[tokio::test(flavor = "current_thread")]
async fn a_transcript_is_the_visible_rows_and_stops_at_the_limit() {
    let db = TempDb::new("transcript");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    for (command, text) in [("c2", "first"), ("c3", "second")] {
        dispatch(&engine, message("t1", command, text)).await;
        until_run_ends(&mut thread).await;
    }
    let read = |limit: u64| engine.thread_transcript("t1".into(), "env".into(), limit);
    let crate::ThreadTranscript::Body(body) = read(u64::MAX).await.unwrap() else {
        panic!("no transcript");
    };
    let body: Value = serde_json::from_slice(&body).unwrap();
    let snapshot = engine.thread_snapshot("t1".into()).await.unwrap().unwrap();
    let projection = &snapshot["projection"];
    assert_eq!(
        body,
        json!({"threadId": "t1", "title": projection["thread"]["title"],
            "updatedAt": projection["updatedAt"], "items": projection["visibleTurnItems"]})
    );
    let items = body["items"].as_array().unwrap();
    assert!(items.len() >= 4, "{body}");

    // The file: the header line, then one line per row.
    let header = crate::transcript::header_bytes([
        body["title"].as_str().unwrap(),
        "env",
        "t1",
        body["updatedAt"].as_str().unwrap(),
    ]);
    let line = |row: &Value| serde_json::to_vec(row).unwrap().len() as u64 + 1;
    let file = header + items.iter().map(line).sum::<u64>();
    assert!(matches!(
        read(file).await.unwrap(),
        crate::ThreadTranscript::Body(_)
    ));
    assert_eq!(
        read(file - 1).await.unwrap(),
        crate::ThreadTranscript::TooLarge
    );
    assert_eq!(
        read(header - 1).await.unwrap(),
        crate::ThreadTranscript::TooLarge
    );
    assert_eq!(
        engine
            .thread_transcript("nope".into(), "env".into(), u64::MAX)
            .await
            .unwrap(),
        crate::ThreadTranscript::NotFound
    );

    // A row after the second one that SQLite stores but serde_json refuses (a lone
    // surrogate): a whole read fails on it, a read whose limit ends at the second row answers
    // too large without reaching it.
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    conn.execute(
        r#"INSERT INTO entities (thread_id, kind, id, first_seq, seq, ordinal, body)
         VALUES ('t1', 'turnItems', 'zz-broken', 999999, 999999, 999999999,
                 '{"text":"\ud800"}')"#,
        [],
    )
    .unwrap();
    assert!(read(u64::MAX).await.is_err());
    let two_rows = header + line(&items[0]) + line(&items[1]);
    assert_eq!(
        read(two_rows).await.unwrap(),
        crate::ThreadTranscript::TooLarge
    );
}

/// T3's `buildVisibleTurnItems` for a run fork: before its first message, a fork's transcript is
/// the source's rows through the fork run, then the synthetic marker. A side chat shows only
/// its own rows.
#[tokio::test(flavor = "current_thread")]
async fn a_fork_transcript_inherits_the_source_history_through_the_fork_run() {
    let db = TempDb::new("transcript-fork");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    for (command, text) in [("c2", "first"), ("c3", "second")] {
        dispatch(&engine, message("t1", command, text)).await;
        until_run_ends(&mut thread).await;
    }
    let fork = |target: &str, command: &str, side_chat: bool| {
        json!({
            "type": "thread.fork", "commandId": command, "sourceThreadId": "t1",
            "targetThreadId": target, "sourcePoint": {"type": "run", "runId": "run:t1:1"},
            "sideChat": side_chat, "createdBy": "user", "creationSource": "web",
        })
    };
    dispatch(&engine, fork("t2", "f1", false)).await;
    dispatch(&engine, fork("t3", "f2", true)).await;
    let read = |thread: &str| engine.thread_transcript(thread.into(), "env".into(), u64::MAX);
    let body = |transcript| match transcript {
        crate::ThreadTranscript::Body(body) => serde_json::from_slice::<Value>(&body).unwrap(),
        other => panic!("{other:?}"),
    };

    let source = engine.thread_snapshot("t1".into()).await.unwrap().unwrap();
    let mut expected: Vec<Value> = source["projection"]["visibleTurnItems"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["item"]["runId"] == "run:t1:1")
        .map(|row| {
            let mut row = row.clone();
            row["visibility"] = json!("inherited");
            row
        })
        .collect();
    assert!(!expected.is_empty());
    let fork_view = projection(&engine, "t2").await;
    let created_at = fork_view["thread"]["createdAt"].clone();
    expected.push(json!({
        "visibility": "synthetic", "sourceThreadId": "t1", "sourceItemId": "turn-item:fork:t2",
        "item": {
            "id": "turn-item:fork:t2", "threadId": "t2", "runId": null, "nodeId": null,
            "providerTurnId": null, "nativeItemRef": null, "parentItemId": null, "ordinal": 0,
            "status": "completed", "title": "Forked from conversation", "startedAt": null,
            "completedAt": created_at, "updatedAt": created_at, "type": "fork",
            "source": {"type": "run", "threadId": "t1", "runId": "run:t1:1"},
            "targetThreadId": "t2",
        },
    }));
    for (position, row) in expected.iter_mut().enumerate() {
        row["position"] = json!(position);
    }
    assert_eq!(body(read("t2").await.unwrap())["items"], json!(expected));
    assert_eq!(body(read("t3").await.unwrap())["items"], json!([]));
    // The thread view shows the same rows: the snapshot route, the projection read and the
    // first item of `subscribeThread`, with or without compact turn items.
    let view = |thread: &'static str, compact: bool| {
        let engine = &engine;
        async move {
            let snapshot = engine
                .thread_snapshot(thread.into())
                .await
                .unwrap()
                .unwrap();
            let projection = projection(engine, thread).await;
            let mut stream = engine
                .subscribe_thread(
                    from_json(json!({"threadId": thread, "acceptCompactTurnItems": compact}))
                        .unwrap(),
                )
                .await
                .unwrap();
            let first = next(&mut stream).await;
            assert_eq!(first["kind"], "snapshot");
            let rows = snapshot["projection"]["visibleTurnItems"].clone();
            assert_eq!(projection["visibleTurnItems"], rows, "{thread}");
            assert_eq!(first["projection"]["visibleTurnItems"], rows, "{thread}");
            rows
        }
    };
    for compact in [false, true] {
        assert_eq!(view("t2", compact).await, json!(expected));
        assert_eq!(view("t3", compact).await, json!([]));
    }

    // A fork of the fork, after a turn of its own: the first fork's history, its marker and
    // its own rows, all inherited, then the new marker.
    dispatch(&engine, message("t2", "c4", "third")).await;
    let mut fork_stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t2"})).unwrap())
        .await
        .unwrap();
    next(&mut fork_stream).await;
    until_run_ends(&mut fork_stream).await;
    let t2_rows = view("t2", false).await;
    let t2_rows = t2_rows.as_array().unwrap();
    assert_eq!(t2_rows[..expected.len()], expected[..]);
    let own: Vec<&Value> = t2_rows[expected.len()..].iter().collect();
    assert!(!own.is_empty());
    assert!(own.iter().all(|row| row["visibility"] == "local"));
    let fork_run = own
        .iter()
        .find_map(|row| row["item"]["runId"].as_str())
        .unwrap()
        .to_owned();
    dispatch(
        &engine,
        json!({
            "type": "thread.fork", "commandId": "f3", "sourceThreadId": "t2",
            "targetThreadId": "t4", "sourcePoint": {"type": "run", "runId": fork_run},
            "createdBy": "user", "creationSource": "web",
        }),
    )
    .await;
    let nested = view("t4", false).await;
    let nested = nested.as_array().unwrap();
    let outline: Vec<(String, String)> = nested
        .iter()
        .map(|row| {
            (
                row["visibility"].as_str().unwrap().to_owned(),
                row["sourceThreadId"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let mut wanted: Vec<(String, String)> = vec![];
    // The source's rows and the first fork's marker (which names its source, t1).
    wanted.extend(expected.iter().map(|_| ("inherited".into(), "t1".into())));
    wanted.extend(own.iter().map(|_| ("inherited".into(), "t2".into())));
    wanted.push(("synthetic".into(), "t2".into()));
    assert_eq!(outline, wanted);
    assert!(
        nested
            .iter()
            .enumerate()
            .all(|(at, row)| row["position"] == at)
    );
    assert_eq!(nested.last().unwrap()["item"]["id"], "turn-item:fork:t4");
    // A bounded snapshot of the fork of a fork shows the same rows: the first fork's marker
    // is generated, not stored.
    let mut bounded = engine
        .subscribe_thread(
            from_json(json!({"threadId": "t4", "acceptBoundedSnapshot": true})).unwrap(),
        )
        .await
        .unwrap();
    let first = next(&mut bounded).await;
    assert_eq!(first["kind"], "snapshot", "{first}");
    assert_eq!(first["projection"]["visibleTurnItems"], json!(nested));

    // Deleting the source keeps the fork's inherited history, as in T3. Its side chat goes
    // with it.
    dispatch(
        &engine,
        json!({"type": "thread.delete", "commandId": "d1", "threadId": "t1"}),
    )
    .await;
    assert_eq!(read("t3").await.unwrap(), crate::ThreadTranscript::NotFound);
    assert_eq!(view("t2", false).await, json!(t2_rows));
    let t2_transcript = body(read("t2").await.unwrap())["items"].clone();
    assert_eq!(t2_transcript, json!(t2_rows));

    // The inherited rows count against the limit too.
    assert_eq!(
        engine
            .thread_transcript("t2".into(), "env".into(), 1000)
            .await
            .unwrap(),
        crate::ThreadTranscript::TooLarge
    );
}

/// The transcript reads rows through indexes: no sort of the whole timeline before the first
/// row, and no scan of every item body for Stop requests.
#[test]
fn transcript_queries_use_their_indexes() {
    let db = TempDb::new("transcript-plans");
    drop(open(&db));
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    let plan = |sql: &str| {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let args = vec!["t1"; stmt.parameter_count()];
        stmt.query_map(rusqlite::params_from_iter(args), |row| {
            row.get::<_, String>(3)
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("; ")
    };
    let items = plan(crate::store::TRANSCRIPT_ITEMS_SQL);
    assert!(items.contains("USING INDEX turn_items_in_order"), "{items}");
    assert!(!items.contains("TEMP B-TREE"), "{items}");
    let outline = plan(<crate::outline::Markers as crate::transcript::RowSink>::ITEMS_SQL);
    assert!(
        outline.contains("thread_outline_rows") && !outline.contains("TEMP B-TREE"),
        "{outline}"
    );
    let messages = plan(crate::outline::MESSAGE_PAGE);
    assert!(
        messages.contains("thread_outline_rows") && !messages.contains("TEMP B-TREE"),
        "{messages}"
    );
    let interrupts = plan(crate::store::TRANSCRIPT_INTERRUPTS_SQL);
    assert!(interrupts.contains("turn_item_interrupts"), "{interrupts}");
    assert!(!interrupts.contains("TEMP B-TREE"), "{interrupts}");
}

/// A receipt's thread is a key lookup, not a scan of the event log under the store lock.
#[test]
fn the_receipt_owner_is_a_key_lookup() {
    let db = TempDb::new("receipt-plan");
    drop(open(&db));
    let conn = rusqlite::Connection::open(db.path()).unwrap();
    let mut stmt = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {}", crate::store::RECEIPT_SQL))
        .unwrap();
    let plan = stmt
        .query_map(["c1"], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("; ");
    assert!(!plan.contains("SCAN"), "{plan}");
}

fn remote(command: &str, kind: &str, extra: Value) -> Value {
    let mut c =
        json!({"type": kind, "commandId": command, "threadId": "t1", "parentThreadId": "t1"});
    if let (Some(c), Some(extra)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(extra.clone());
    }
    c
}

/// A task in a linked environment: recorded on the parent without a child thread, completed by
/// its follower (which wakes the parent once), and a Stop of the parent after its result owes
/// its thread there a stop, which a `stopped` report with the current count settles.
#[tokio::test(flavor = "current_thread")]
async fn a_remote_task_is_recorded_completed_and_owes_a_stop() {
    let db = TempDb::new("remote-task");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;

    let request = remote(
        "r1",
        "delegated_task.remote.request",
        json!({
            "parentRunId": "run:t1:1", "parentNodeId": "node:run:t1:1:root", "task": "look there",
            "title": "There", "driver": "remote",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
            "remoteChild": {"environmentId": "env:b", "threadId": "thread:b", "label": "B", "runId": "run:b"},
            "completionWake": "always",
        }),
    );
    engine.remote_task(request.clone()).await.unwrap();
    // A replay of the same command is accepted once and records nothing more.
    engine.remote_task(request).await.unwrap();
    let task = "node:delegated-task:r1";
    let p = projection(&engine, "t1").await;
    let row = p["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == task)
        .unwrap()
        .clone();
    assert_eq!(row["childThreadId"], Value::Null);
    assert_eq!(row["driver"], "remote");
    assert_eq!(row["remoteChild"]["threadId"], "thread:b");
    assert_eq!(row["status"], "running");
    assert_eq!(
        engine.open_remote_tasks(10).await.unwrap(),
        vec![("t1".to_owned(), task.to_owned())]
    );
    // Not a client command.
    assert!(
        engine
            .remote_task(json!({"type": "thread.create"}))
            .await
            .is_err()
    );

    engine
        .remote_task(remote(
            "rc1",
            "delegated_task.remote.complete",
            json!({"taskId": task, "status": "completed", "result": "done there", "stoppedThere": "ran-out"}),
        ))
        .await
        .unwrap();
    let p = projection(&engine, "t1").await;
    let row = p["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == task)
        .unwrap()
        .clone();
    assert_eq!(row["status"], "completed");
    assert_eq!(row["result"], "done there");
    assert_eq!(row["remoteChild"]["stoppedThere"], true);
    assert_eq!(row["completionDelivery"]["state"], "delivered");
    let wakes = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["text"].as_str().is_some_and(|t| t.contains(task)))
        .count();
    assert_eq!(wakes, 1, "the parent is woken once");
    assert!(engine.open_remote_tasks(10).await.unwrap().is_empty());
    // A second report changes nothing, so it is refused; the first result stands.
    assert!(
        engine
            .remote_task(remote(
                "rc2",
                "delegated_task.remote.complete",
                json!({"taskId": task, "status": "failed", "result": "late", "stoppedThere": "ran-out"}),
            ))
            .await
            .is_err()
    );

    // Stopping the parent owes the finished task's thread there a stop.
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "s1", "threadId": "t1", "reason": "enough"}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    let row = p["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == task)
        .unwrap()
        .clone();
    assert_eq!(row["result"], "done there");
    assert_eq!(row["remoteChild"]["stoppedThere"], false);
    assert_eq!(row["remoteChild"]["stopCount"], 1);
    assert_eq!(engine.open_remote_tasks(10).await.unwrap().len(), 1);
    // A stop sent for an older count does not settle it; the current one does.
    let stopped = |command: &str, count: u64| {
        remote(
            command,
            "delegated_task.remote.complete",
            json!({"taskId": task, "status": "completed", "result": "done there",
                   "stoppedThere": "stopped", "stopCount": count}),
        )
    };
    assert!(engine.remote_task(stopped("rs0", 0)).await.is_err());
    engine.remote_task(stopped("rs1", 1)).await.unwrap();
    let p = projection(&engine, "t1").await;
    let row = p["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == task)
        .unwrap()
        .clone();
    assert_eq!(row["remoteChild"]["stoppedThere"], true);
    assert!(engine.open_remote_tasks(10).await.unwrap().is_empty());
}

/// A Stop of the parent ends an open remote task here as interrupted, without a wake.
#[tokio::test(flavor = "current_thread")]
async fn a_parent_stop_interrupts_an_open_remote_task() {
    let db = TempDb::new("remote-stop");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    engine
        .remote_task(remote(
            "r1",
            "delegated_task.remote.request",
            json!({
                "parentRunId": "run:t1:1", "parentNodeId": "node:run:t1:1:root", "task": "x",
                "driver": "remote", "modelSelection": {"instanceId": "claudeAgent", "model": "m"},
                "remoteChild": {"environmentId": "env:b", "threadId": "thread:b", "label": "B"},
            }),
        ))
        .await
        .unwrap();
    dispatch(
        &engine,
        json!({"type": "thread.stop", "commandId": "s1", "threadId": "t1"}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    let row = &p["subagents"][0];
    assert_eq!(row["status"], "interrupted");
    assert_eq!(row["result"], "Stopped with its parent.");
    assert_eq!(row["completionDelivery"]["state"], "disposed");
    // Its follower still owes the stop there.
    assert_eq!(engine.open_remote_tasks(10).await.unwrap().len(), 1);
}

/// `provider.uploadFeedback` (T3's `ws.ts` handler): an unknown thread, a thread before its
/// first session, a running session whose provider has no upload (T3: only Codex), and a
/// session that stopped, each with T3's text.
#[tokio::test(flavor = "current_thread")]
async fn upload_feedback_needs_a_running_session_that_supports_it() {
    let db = TempDb::new("upload-feedback");
    let (engine, _) = open(&db);
    let refusal = |result: Result<Value, EngineError<Value>>| match result {
        Err(EngineError::Rejected(error)) => {
            assert_eq!(error["_tag"], "ProviderUploadFeedbackError");
            error
        }
        other => panic!("expected a refusal: {other:?}"),
    };
    let missing = refusal(
        engine
            .call("provider.uploadFeedback", json!({"threadId": "nope"}))
            .await,
    );
    assert_eq!(missing["threadId"], "nope");

    dispatch(&engine, create("t1", "c1")).await;
    let feedback = json!({"threadId": "t1", "reason": "broken"});
    let fresh = refusal(
        engine
            .call("provider.uploadFeedback", feedback.clone())
            .await,
    );
    assert_eq!(
        fresh["cause"],
        "No provider session has run in this thread yet."
    );

    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    until_run_ends(&mut thread).await;
    let unsupported = refusal(
        engine
            .call("provider.uploadFeedback", feedback.clone())
            .await,
    );
    assert_eq!(
        unsupported["cause"],
        "Provider 'claudeAgent' does not support feedback uploads."
    );

    engine.shutdown().await;
    let stopped = refusal(engine.call("provider.uploadFeedback", feedback).await);
    assert_eq!(
        stopped["cause"],
        "The provider session is no longer running. Send a message first."
    );
}

/// Attention events (`attention.rs`) through real commands and the fake provider.
#[tokio::test(flavor = "current_thread")]
async fn attention_events_follow_approvals_and_turn_ends() {
    let db = TempDb::new("attention");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.attention = true;
    let engine = SqliteEngine::open(config).unwrap();
    let signal = engine.attention_signal().expect("attention on");
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;

    dispatch(&engine, message("t1", "c2", "ask")).await;
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "runtime-request.updated" {
            break;
        }
    }
    timeout(Duration::from_secs(5), signal.notified())
        .await
        .expect("the commit that wrote the event raises the signal");
    dispatch(
        &engine,
        json!({"type": "runtime-request.respond", "commandId": "c3", "threadId": "t1",
        "requestId": "request:1", "decision": "accept"}),
    )
    .await;
    until_run_ends(&mut thread).await;
    dispatch(&engine, message("t1", "c4", "fail")).await;
    until_run_ends(&mut thread).await;

    let rows = engine.attention_due(u64::MAX >> 2, 100).await.unwrap();
    let seen: Vec<(String, Option<&str>, Option<&str>)> = rows
        .iter()
        .map(|row| {
            (
                row.event_type.as_str().to_owned(),
                row.kind.map(|k| k.as_str()),
                row.request_id.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        vec![
            ("attention".into(), Some("approval"), Some("request:1")),
            ("attention_cleared".into(), None, Some("request:1")),
            ("attention".into(), Some("turn_finished"), None),
            ("attention".into(), Some("turn_failed"), None),
        ]
    );
    assert!(rows.iter().all(|row| row.thread_id == "t1"));
    assert_eq!(rows[0].thread_title.as_deref(), Some("New thread"));
}

#[tokio::test(flavor = "current_thread")]
async fn attention_is_off_by_default() {
    let db = TempDb::new("attention-off");
    let (engine, _) = open(&db);
    assert!(engine.attention_signal().is_none());
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "fail")).await;
    until_run_ends(&mut thread).await;
    assert!(
        engine
            .attention_due(u64::MAX >> 2, 100)
            .await
            .unwrap()
            .is_empty()
    );
}

/// T3's `defer_start` with a workspace and `prepared-run.release`/`fail`: the run waits in
/// `preparing` and reaches the provider only once released; a failed preparation fails it with
/// `workspace_preparation_failed`, and neither applies twice.
#[tokio::test(flavor = "current_thread")]
async fn a_prepared_run_starts_only_when_released() {
    let db = TempDb::new("prepared-run");
    let (engine, _) = open(&db);
    let strategy = json!({"type": "worktree", "baseRef": "HEAD", "startFromOrigin": false});
    for thread in ["t1", "t2"] {
        dispatch(&engine, create(thread, &format!("create-{thread}"))).await;
        let mut send = message(thread, &format!("send-{thread}"), "work");
        send["dispatchMode"] = json!({"type": "defer_start", "workspaceStrategy": strategy});
        dispatch(&engine, send).await;
        let held = projection(&engine, thread).await;
        assert_eq!(held["runs"][0]["status"], "preparing");
        assert_eq!(held["runs"][0]["workspacePreparation"], strategy);
        assert!(held["providerThreads"].as_array().unwrap().is_empty());
    }
    let prepared = |kind: &str, thread: &str, id: &str| {
        json!({"type": kind, "commandId": id, "threadId": thread, "runId": format!("run:{thread}:1"),
            "failure": {"class": "validation_error", "message": "Setup script exited with 3.",
                "code": null, "retryable": false}})
    };
    dispatch(&engine, prepared("prepared-run.release", "t1", "go")).await;
    let started = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(started["runs"][0]["status"], "completed");
    dispatch(&engine, prepared("prepared-run.fail", "t2", "stop")).await;
    let failed = projection(&engine, "t2").await;
    assert_eq!(failed["runs"][0]["status"], "failed");
    assert!(failed["providerThreads"].as_array().unwrap().is_empty());
    let error = failed["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "error")
        .unwrap();
    assert_eq!(error["failure"]["code"], "workspace_preparation_failed");
    for (kind, thread) in [("prepared-run.release", "t1"), ("prepared-run.fail", "t2")] {
        let again = engine
            .dispatch(from_json(prepared(kind, thread, "again")).unwrap())
            .await;
        let Err(EngineError::Rejected(error)) = again else {
            panic!("{kind} applied twice")
        };
        assert!(
            to_json(&error)
                .to_string()
                .contains("is not awaiting workspace preparation")
        );
    }
}

/// T3's `startNextQueuedRun` after `prepared-run.fail`: the failure is a `validation_error` and
/// the checkout exists, so a message queued while the setup ran starts next.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_preparation_starts_the_queued_run() {
    let db = TempDb::new("prepared-run-queue");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut send = message("t1", "c2", "work");
    send["dispatchMode"] = json!({"type": "defer_start",
        "workspaceStrategy": {"type": "worktree", "baseRef": "HEAD", "startFromOrigin": false}});
    dispatch(&engine, send).await;
    let queued = message_with(
        "t1",
        "c3",
        "next",
        json!({"type": "queue_after_active"}),
        None,
    );
    dispatch(&engine, queued).await;
    assert_eq!(
        projection(&engine, "t1").await["runs"][1]["status"],
        "queued"
    );
    dispatch(
        &engine,
        json!({"type": "prepared-run.fail", "commandId": "fail", "threadId": "t1",
            "runId": "run:t1:1", "failure": {"class": "validation_error",
            "message": "Setup script exited with 3.", "code": null, "retryable": false}}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][0]["status"], "failed");
    assert_ne!(p["runs"][1]["status"], "queued", "the queue advanced");
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(p["runs"][1]["status"], "completed");
}

/// Removing a queued run leaves the active run's approval answerable (T3's
/// `queuedRunCancellationEvents` touches only the queued run, its attempt and its node).
#[tokio::test(flavor = "current_thread")]
async fn removing_a_queued_run_keeps_the_active_runs_approval() {
    let db = TempDb::new("queued-cancel-approval");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    dispatch(&engine, message("t1", "active", "ask")).await;
    let request = loop {
        let update = next(&mut stream).await;
        if update["event"]["type"] == "runtime-request.updated" {
            break update["event"]["payload"].clone();
        }
    };
    let queued = message_with(
        "t1",
        "queued",
        "Later",
        json!({"type":"queue_after_active"}),
        None,
    );
    dispatch(&engine, queued).await;
    dispatch(
        &engine,
        json!({"type":"queued-run.cancel","threadId":"t1","runId":"run:t1:2","commandId":"cancel"}),
    )
    .await;
    let after = projection(&engine, "t1").await;
    assert_eq!(after["runs"][1]["status"], "cancelled");
    assert_eq!(after["runtimeRequests"][0]["status"], "pending");
    assert_eq!(
        engine.shell_snapshot().await.unwrap()["threads"][0]["pendingRuntimeRequest"]["id"],
        request["id"]
    );
    dispatch(
        &engine,
        json!({"type":"runtime-request.respond","commandId":"answer","threadId":"t1","requestId":request["id"],"decision":"accept"}),
    )
    .await;
    // The stream still holds the queued run's cancellation; read on to the active run's end.
    let mut events = vec![];
    loop {
        let batch = until_run_ends(&mut stream).await;
        let done = batch.last().is_some_and(|(_, run)| run["id"] == "run:t1:1");
        events.extend(batch);
        if done {
            break;
        }
    }
    let answers = events
        .iter()
        .filter(|(ty, p)| ty == "message.updated" && p["text"] == "approval: accept")
        .count();
    assert_eq!(answers, 1);
    assert_eq!(events.last().unwrap().1["status"], "completed");
    let done = projection(&engine, "t1").await;
    assert_eq!(done["runs"][0]["status"], "completed");
    assert_eq!(done["runs"].as_array().unwrap().len(), 2);
    assert_eq!(done["runtimeRequests"][0]["status"], "resolved");
}

/// An async question (`responseCapability: message`), such as one imported from T3 after its
/// provider exited: the answer resolves the card and becomes one user message and one run
/// (T3's "answers an async question after its provider exits and commits the answer once").
#[tokio::test(flavor = "current_thread")]
async fn an_async_question_is_answered_with_one_message_and_one_run() {
    let db = TempDb::new("async-question");
    let (engine, provider) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    seed_async_question(&engine).await;
    let before = projection(&engine, "t1").await;
    let respond = |id: &str, answers: Value| {
        from_json(
            json!({"type":"runtime-request.respond","commandId":id,"threadId":"t1",
            "requestId":"t1:request","answers":answers}),
        )
        .unwrap()
    };
    for (index, answers) in [
        json!({"color":" ","sizes":["Small"]}),
        json!({"color":"Blue","sizes":[]}),
        json!({"color":"Blue","sizes":["Small"," "]}),
        json!({"color":"Blue","sizes":["Small"],"extra":" "}),
    ]
    .into_iter()
    .enumerate()
    {
        let refused = engine
            .dispatch(respond(&format!("invalid:{index}"), answers.clone()))
            .await;
        assert!(
            matches!(refused, Err(EngineError::Rejected(_))),
            "{answers}"
        );
        assert_eq!(projection(&engine, "t1").await, before, "{answers}");
    }

    let answers = json!({"color":"  Blue  ","sizes":["Small","Large"],"note":""});
    let accepted = engine
        .dispatch(respond("answer", answers.clone()))
        .await
        .unwrap();
    let repeated = engine
        .dispatch(respond("answer", answers.clone()))
        .await
        .unwrap();
    assert_eq!(to_json(&repeated), to_json(&accepted));
    let duplicate = engine.dispatch(respond("duplicate", answers.clone())).await;
    assert!(matches!(duplicate, Err(EngineError::Rejected(_))));
    run_to_end(&engine, "t1", "run:t1:1").await;

    drop(engine);
    let (engine, _) = open(&db);
    let after = projection(&engine, "t1").await;
    assert_eq!(after["runtimeRequests"][0]["status"], "resolved");
    assert_eq!(after["runtimeRequests"][0]["answers"], answers);
    let item = &after["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "t1:item")
        .unwrap();
    assert_eq!(item["status"], "completed");
    assert_eq!(
        item["questionAnswer"]["questionTextById"],
        json!({"color":"Which color?","sizes":"Which sizes?","note":"Anything else?"})
    );
    let users: Vec<&Value> = after["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .collect();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0]["id"], "async-answer:t1:request");
    assert_eq!(
        users[0]["text"],
        "Which color?\nBlue\n\nWhich sizes?\nSmall, Large"
    );
    assert_eq!(users[0]["creationSource"], "server");
    assert_eq!(after["runs"].as_array().unwrap().len(), 1);
    assert_eq!(after["runs"][0]["status"], "completed");
    assert_eq!(
        provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

/// A provider failure holds the queue, but a buffered provider notification still starts: it
/// replays output the CLI already produced (T3's "starts a provider wake queued behind a run
/// that fails").
#[tokio::test(flavor = "current_thread")]
async fn a_provider_failure_holds_messages_and_starts_a_buffered_wake() {
    let db = TempDb::new("failure-buffered-wake");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    // Hold only effect execution so every message is queued before the fake provider fails.
    let gate = gate(&engine).await;
    dispatch(&engine, message("t1", "active", "fail")).await;
    let queued =
        |id, text| message_with("t1", id, text, json!({"type":"queue_after_active"}), None);
    dispatch(&engine, queued("later", "Queued by the user")).await;
    let notification = json!({"source":{"kind":"background_task"},"outcome":"updated",
        "summary":"Background activity updated"});
    let mut wake = queued("wake", "Background task completed.");
    wake["createdBy"] = json!("agent");
    wake["creationSource"] = json!("provider");
    wake["notification"] = notification.clone();
    dispatch(&engine, wake).await;
    // A wake the server queued is not provider output: it waits with the user's message.
    let mut server = queued("server", "Monitor fired.");
    server["createdBy"] = json!("agent");
    server["creationSource"] = json!("server");
    server["notification"] = notification;
    dispatch(&engine, server).await;
    drop(gate);
    run_to_end(&engine, "t1", "run:t1:1").await;
    run_to_end(&engine, "t1", "run:t1:3").await;
    // The wake completed without a Stop: nobody reviews the server's wake, so it goes next
    // (T3's `releaseUnattendedHolds`); the user's message stays held.
    let p = run_to_end(&engine, "t1", "run:t1:4").await;
    assert_eq!(
        run_statuses(&p),
        [
            ("run:t1:1".into(), "failed".into()),
            ("run:t1:2".into(), "queued".into()),
            ("run:t1:3".into(), "completed".into()),
            ("run:t1:4".into(), "completed".into()),
        ]
    );
    assert_eq!(p["runs"][1]["queueHeld"], true);
}

/// A pending async question on t1 (`responseCapability: message`), as T3's
/// `seedPendingQuestion` writes one: its node, request and `user_input_request` item.
async fn seed_async_question(engine: &SqliteEngine) {
    let now = "2026-01-01T00:00:00.000Z";
    let seed = vec![
        crate::store::Draft::new(
            "t1",
            "node.updated",
            json!({"id":"t1:node","threadId":"t1","runId":null,"parentNodeId":null,
                "rootNodeId":"t1:node","kind":"user_input_request","status":"waiting",
                "countsForRun":false,"providerThreadId":null,"providerTurnId":null,
                "nativeItemRef":null,"runtimeRequestId":"t1:request","checkpointScopeId":null,
                "startedAt":now,"completedAt":null}),
        )
        .node(Some("t1:node")),
        crate::store::Draft::new(
            "t1",
            "runtime-request.updated",
            json!({"id":"t1:request","nodeId":"t1:node","providerTurnId":null,
                "nativeRequestRef":null,"kind":"user_input","status":"pending",
                "responseCapability":{"type":"message"},"createdAt":now,"resolvedAt":null}),
        )
        .node(Some("t1:node")),
        crate::store::Draft::new(
            "t1",
            "turn-item.updated",
            json!({"id":"t1:item","type":"user_input_request","threadId":"t1","runId":null,
                "nodeId":"t1:node","providerThreadId":null,"providerTurnId":null,
                "nativeItemRef":null,"parentItemId":null,"ordinal":0,"status":"waiting",
                "title":null,"startedAt":now,"completedAt":null,"updatedAt":now,
                "requestId":"t1:request","questions":[
                    {"id":"color","header":"Color","question":"Which color?","options":[]},
                    {"id":"sizes","header":"Sizes","question":"Which sizes?","options":[],"multiSelect":true},
                    {"id":"note","header":"Note","question":"Anything else?","options":[],"required":false}]}),
        )
        .node(Some("t1:node")),
    ];
    engine
        .inner()
        .db(move |s| {
            let mut tx = s.tx()?;
            for draft in seed {
                tx.append(draft)?;
            }
            tx.commit(None)
        })
        .await
        .unwrap();
}

fn async_answer(command: &str) -> Value {
    json!({"type":"runtime-request.respond","commandId":command,"threadId":"t1",
        "requestId":"t1:request","answers":{"color":"Blue","sizes":["Small"]}})
}

/// Holds effect execution, so the commands below land before t1's runs start: a row in t1's
/// outbox lane, behind what is already there. Dropping the release settles it without running.
async fn gate(engine: &SqliteEngine) -> tokio::sync::oneshot::Sender<()> {
    let (release, held) = tokio::sync::oneshot::channel();
    let inner = engine.inner().clone();
    engine
        .inner()
        .db(move |s| {
            let mut tx = s.tx()?;
            tx.enqueue(
                None,
                &[crate::commands::Effect::CloseSession {
                    thread_id: "t1".into(),
                }],
            )?;
            let id = tx
                .sql()
                .query_row("SELECT max(id) FROM effect_outbox", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            // Before the commit, so the worker never claims the row ungated.
            crate::lock(&inner.worker_hooks).gates.insert(id, held);
            tx.commit(None)
        })
        .await
        .unwrap();
    release
}

fn queued(id: &str, text: &str) -> Value {
    message_with("t1", id, text, json!({"type":"queue_after_active"}), None)
}

fn provider_wake(id: &str, text: &str) -> Value {
    let mut wake = queued(id, text);
    wake["createdBy"] = json!("agent");
    wake["creationSource"] = json!("provider");
    wake["notification"] = json!({"source":{"kind":"background_task"},"outcome":"updated",
        "summary":"Background activity updated"});
    wake
}

fn run_for<'p>(p: &'p Value, message_id: &str) -> &'p Value {
    p["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| {
            r["userMessageId"] == message_id
                || r["userMessageId"] == format!("message:{message_id}")
        })
        .unwrap_or_else(|| panic!("no run for {message_id}: {}", p["runs"]))
}

/// Gate finding 1: answering an async question is not a client send, so it leaves a queue
/// the user's Stop or a failure held as it is (T3's `sentByUserFromClient`), also when the
/// answer is replayed and the store reopened.
#[tokio::test(flavor = "current_thread")]
async fn an_async_answer_leaves_a_held_queue_held() {
    let db = TempDb::new("async-answer-held");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "a", "fail")).await;
    dispatch(&engine, queued("b", "Queued by the user")).await;
    drop(hold);
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(run_for(&p, "b")["queueHeld"], true);
    seed_async_question(&engine).await;
    dispatch(&engine, async_answer("answer")).await;
    dispatch(&engine, async_answer("answer")).await;
    let answer = run_for(&projection(&engine, "t1").await, "async-answer:t1:request")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    run_to_end(&engine, "t1", &answer).await;
    drop(engine);
    let (engine, _) = open(&db);
    let p = projection(&engine, "t1").await;
    let answers = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["id"] == "async-answer:t1:request")
        .count();
    assert_eq!(answers, 1);
    assert_eq!(run_for(&p, "b")["status"], "queued");
    assert_eq!(run_for(&p, "b")["queueHeld"], true);
}

/// Gate finding 2: an answer while the active run is still starting queues its own run, as
/// T3 steers only into a live provider turn; it is not promoted into the start.
#[tokio::test(flavor = "current_thread")]
async fn an_async_answer_during_a_start_gets_its_own_run() {
    let db = TempDb::new("async-answer-starting");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    seed_async_question(&engine).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "a", "one")).await;
    assert_eq!(
        projection(&engine, "t1").await["runs"][0]["status"],
        "starting"
    );
    dispatch(&engine, async_answer("answer")).await;
    let p = projection(&engine, "t1").await;
    assert!(run_for(&p, "async-answer:t1:request")["steerWhenReadyRunId"].is_null());
    drop(hold);
    run_to_end(&engine, "t1", "run:t1:1").await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    let answer = run_for(&p, "async-answer:t1:request");
    assert_eq!(answer["id"], "run:t1:2");
    assert_eq!(answer["status"], "completed");
    assert_eq!(run_for(&p, "a")["status"], "completed");
}

/// Gate finding 3: a provider result that arrives while an earlier one replays does not take
/// the user's hold, so both results reach the thread once and the user's message stays held
/// (T3's `wakeSkipsHold`, runtimeLayer.test.ts "lets a provider wake skip a held queue").
#[tokio::test(flavor = "current_thread")]
async fn a_second_buffered_wake_drains_past_a_held_queue() {
    let db = TempDb::new("second-buffered-wake");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let first = gate(&engine).await;
    dispatch(&engine, message("t1", "a", "fail")).await;
    dispatch(&engine, queued("b", "Queued by the user")).await;
    dispatch(
        &engine,
        provider_wake("wake1", "First background task completed."),
    )
    .await;
    // Holds the first wake in its start, after the failure released it.
    let second = gate(&engine).await;
    drop(first);
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(
        &engine,
        provider_wake("wake2", "Background task completed."),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_ne!(run_for(&p, "wake2")["queueHeld"], true, "{}", p["runs"]);
    drop(second);
    run_to_end(&engine, "t1", "run:t1:3").await;
    let p = run_to_end(&engine, "t1", "run:t1:4").await;
    assert_eq!(run_for(&p, "wake1")["status"], "completed");
    assert_eq!(run_for(&p, "wake2")["status"], "completed");
    assert_eq!(run_for(&p, "b")["status"], "queued");
    assert_eq!(run_for(&p, "b")["queueHeld"], true);
    for wake in ["wake1", "wake2"] {
        let seen = p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["id"] == format!("message:{wake}"))
            .count();
        assert_eq!(seen, 1, "{wake}");
    }
}

/// Round-2 gate finding 4: a usage limit blocks only its own provider's queued work, in queue
/// order (T3's `usageLimitHoldsQueue` at automatic start and at `queue.resume`).
#[tokio::test(flavor = "current_thread")]
async fn a_usage_limit_blocks_only_its_provider() {
    let on = |instance: &str, id: &str, text: &str| {
        let mut m = queued(id, text);
        m["modelSelection"] = json!({"instanceId": instance, "model": "m"});
        m
    };
    // Limited Claude, with Claude work queued first: nothing starts on its own, and resuming
    // is refused while the limit stands.
    let db = TempDb::new("usage-limit-same");
    let (engine, _, _) = open_two(&db);
    dispatch(&engine, create("t1", "create")).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "a", "fail-usage-limit")).await;
    dispatch(&engine, on("claudeAgent", "b", "Queued for Claude")).await;
    dispatch(&engine, provider_wake("wake", "Background task completed.")).await;
    drop(hold);
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(p["runs"][0]["status"], "failed");
    for id in ["b", "wake"] {
        assert_eq!(run_for(&p, id)["status"], "queued", "{id}");
    }
    let resume = json!({"type":"queue.resume","commandId":"resume","threadId":"t1"});
    assert!(matches!(
        engine.dispatch(from_json(resume).unwrap()).await,
        Err(EngineError::Rejected(_))
    ));
    drop(engine);

    // Limited Claude, with Codex work queued first: the Codex run starts.
    let db = TempDb::new("usage-limit-other");
    let (engine, _, codex) = open_two(&db);
    dispatch(&engine, create("t1", "create")).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "a", "fail-usage-limit")).await;
    dispatch(&engine, on("codex", "b", "Queued for Codex")).await;
    drop(hold);
    run_to_end(&engine, "t1", "run:t1:1").await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(run_for(&p, "b")["status"], "completed");
    assert_eq!(count(&codex.sessions), 1);
}

/// Round-2 gate finding 1: after a failed worktree setup the thread has no checkout of its
/// own, so an async answer and a provider wake wait held instead of starting in the project
/// root (T3's `worktreeMissingRun` and `worktreeSetupPending`).
#[tokio::test(flavor = "current_thread")]
async fn work_after_a_failed_worktree_setup_waits() {
    let db = TempDb::new("worktree-setup-failed");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    dispatch(&engine, message("t1", "a", "fail")).await;
    let mut failed = run_to_end(&engine, "t1", "run:t1:1").await["runs"][0].clone();
    // As T3 records it, and as `t3_import` copies it.
    failed["workspacePreparation"] = json!({"type": "worktree"});
    engine
        .inner()
        .db(move |s| {
            let mut tx = s.tx()?;
            tx.append(crate::store::Draft::new("t1", "run.updated", failed))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    seed_async_question(&engine).await;
    dispatch(&engine, async_answer("answer")).await;
    dispatch(&engine, provider_wake("wake", "Background task completed.")).await;
    let p = projection(&engine, "t1").await;
    for id in ["async-answer:t1:request", "wake"] {
        assert_eq!(run_for(&p, id)["status"], "queued", "{id}: {}", p["runs"]);
        assert_eq!(run_for(&p, id)["queueHeld"], true, "{id}");
    }
}

/// Round-2 gate finding 2: on a session without live steering the answer queues behind work
/// already waiting, instead of a declined steer putting it first.
#[tokio::test(flavor = "current_thread")]
async fn an_async_answer_queues_in_order_on_a_session_without_steering() {
    let db = TempDb::new("async-answer-no-steering");
    let (engine, _) = open_with(&db, FakeProvider::new("claudeAgent").without_steering());
    dispatch(&engine, create("t1", "create")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    dispatch(&engine, message("t1", "a", "hang")).await;
    until_provider_turn(&mut stream).await;
    dispatch(&engine, queued("b", "Queued by the user")).await;
    seed_async_question(&engine).await;
    dispatch(&engine, async_answer("answer")).await;
    // A declined steer would queue the answer only after its delivery effect ran.
    let answer = loop {
        let item = next(&mut stream).await;
        let payload = &item["event"]["payload"];
        if item["event"]["type"] == "run.created"
            && payload["userMessageId"] == "async-answer:t1:request"
        {
            break payload.clone();
        }
        if item["event"]["type"] == "run.updated"
            && payload["userMessageId"] == "async-answer:t1:request"
            && payload["status"] == "queued"
        {
            break payload.clone();
        }
    };
    let p = projection(&engine, "t1").await;
    let b = run_for(&p, "b");
    assert_eq!(answer["status"], "queued");
    assert!(
        answer["queuePosition"].as_u64() > b["queuePosition"].as_u64(),
        "answer {answer} b {b}"
    );
}

/// Round-3 gate finding 1: "Send now" on a queued run keeps the worktree hold: refused, and
/// the queue stays as it was (T3's `queue.resume` checks on the selected run).
#[tokio::test(flavor = "current_thread")]
async fn send_now_keeps_the_worktree_hold() {
    let db = TempDb::new("send-now-worktree");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    dispatch(&engine, message("t1", "a", "fail")).await;
    let mut failed = run_to_end(&engine, "t1", "run:t1:1").await["runs"][0].clone();
    failed["workspacePreparation"] = json!({"type": "worktree"});
    engine
        .inner()
        .db(move |s| {
            let mut tx = s.tx()?;
            tx.append(crate::store::Draft::new("t1", "run.updated", failed))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    seed_async_question(&engine).await;
    dispatch(&engine, async_answer("answer")).await;
    let before = projection(&engine, "t1").await;
    let run = run_for(&before, "async-answer:t1:request")["id"].clone();
    let start =
        json!({"type":"queued-run.start","commandId":"send-now","threadId":"t1","runId":run});
    assert!(matches!(
        engine.dispatch(from_json(start).unwrap()).await,
        Err(EngineError::Rejected(_))
    ));
    assert_eq!(projection(&engine, "t1").await["runs"], before["runs"]);
}

/// Round-3 gate finding 2: an answer is not steered into a run the user stopped; it is
/// refused and stays answerable (T3's `stopReachedRun` on a steer).
#[tokio::test(flavor = "current_thread")]
async fn an_async_answer_is_not_steered_into_a_stopped_run() {
    let db = TempDb::new("async-answer-stopped");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    dispatch(&engine, message("t1", "a", "hang")).await;
    until_provider_turn(&mut stream).await;
    // Stop reached the run; the provider has not ended it yet.
    engine
        .inner()
        .db(|s| {
            let mut tx = s.tx()?;
            tx.append(
                crate::store::Draft::new(
                    "t1",
                    "turn-item.updated",
                    json!({"id": "turn-item:run:t1:1:interrupt-request", "threadId": "t1",
                        "runId": "run:t1:1", "nodeId": "node:run:t1:1:root",
                        "type": "run_interrupt_request", "status": "completed", "ordinal": 9}),
                )
                .run(Some("run:t1:1")),
            )?;
            tx.commit(None)
        })
        .await
        .unwrap();
    seed_async_question(&engine).await;
    assert!(matches!(
        engine
            .dispatch(from_json(async_answer("answer")).unwrap())
            .await,
        Err(EngineError::Rejected(_))
    ));
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runtimeRequests"][0]["status"], "pending");
}

/// Round-3 gate finding 3, T3's "holds a limited provider's queue through another provider's
/// turn until the user resumes": the limited queue waits through a Codex turn, and the
/// user's resume starts it.
#[tokio::test(flavor = "current_thread")]
async fn a_limited_queue_waits_until_the_user_resumes() {
    let db = TempDb::new("limited-queue-resume");
    let (engine, _, codex) = open_two(&db);
    dispatch(&engine, create("t1", "create")).await;
    let on = |instance: &str, id: &str, text: &str, mode: &str| {
        let mut m = message_with("t1", id, text, json!({"type": mode}), None);
        m["modelSelection"] = json!({"instanceId": instance, "model": "m"});
        m
    };
    let hold = gate(&engine).await;
    dispatch(
        &engine,
        on(
            "claudeAgent",
            "limited",
            "fail-usage-limit",
            "start_immediately",
        ),
    )
    .await;
    dispatch(
        &engine,
        on("claudeAgent", "queued", "Later", "queue_after_active"),
    )
    .await;
    drop(hold);
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(
        &engine,
        on("codex", "switch", "On Codex", "start_immediately"),
    )
    .await;
    let switched = run_for(&projection(&engine, "t1").await, "switch")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let p = run_to_end(&engine, "t1", &switched).await;
    assert_eq!(count(&codex.sessions), 1);
    assert_eq!(
        run_for(&p, "queued")["status"],
        "queued",
        "held through the Codex turn"
    );
    dispatch(
        &engine,
        json!({"type":"queue.resume","commandId":"resume","threadId":"t1"}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_ne!(run_for(&p, "queued")["status"], "queued", "{}", p["runs"]);
}

/// Round-3 gate finding 4: a queued monitor wake follows the thread's current selection, so
/// the provider it was queued on, now limited, does not block it (T3's
/// `queuedRunModelSelection`).
#[tokio::test(flavor = "current_thread")]
async fn a_monitor_wake_follows_the_current_selection() {
    let db = TempDb::new("monitor-wake-selection");
    let (engine, _, codex) = open_two(&db);
    dispatch(&engine, create("t1", "create")).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "limited", "fail-usage-limit")).await;
    let mut wake = queued("wake", "A watched pull request changed.");
    wake["createdBy"] = json!("agent");
    wake["creationSource"] = json!("server");
    wake["notification"] = json!({"source": {"kind": "monitor"}, "outcome": "updated",
        "summary": "#7: checks failed"});
    dispatch(&engine, wake).await;
    drop(hold);
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(&engine, model_selection_set("select", "codex")).await;
    dispatch(
        &engine,
        json!({"type":"queue.resume","commandId":"resume","threadId":"t1"}),
    )
    .await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(run_for(&p, "wake")["status"], "completed");
    assert_eq!(run_for(&p, "wake")["providerInstanceId"], "codex");
    assert_eq!(count(&codex.sessions), 1);
}

/// Round-3 gate finding 5: a provider failure on Claude holds only work that would run on
/// Claude next; queued Codex work starts (T3's `providerFailed` compares instances).
#[tokio::test(flavor = "current_thread")]
async fn a_provider_failure_holds_only_its_provider() {
    let db = TempDb::new("failure-other-provider");
    let (engine, _, codex) = open_two(&db);
    dispatch(&engine, create("t1", "create")).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "a", "fail")).await;
    let mut b = queued("b", "On Codex");
    b["modelSelection"] = json!({"instanceId": "codex", "model": "m"});
    dispatch(&engine, b).await;
    drop(hold);
    run_to_end(&engine, "t1", "run:t1:1").await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(run_for(&p, "b")["status"], "completed");
    assert_eq!(count(&codex.sessions), 1);
}

/// The command feed the pull request watch reads: every thread's `command_execution` item
/// updates and run updates committed after it opened, and nothing else.
#[tokio::test(flavor = "current_thread")]
async fn the_command_feed_carries_command_items_and_run_updates() {
    let db = TempDb::new("command-feed");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let mut feed = engine.subscribe_command_events().await.unwrap();
    engine
        .inner()
        .db(|s| {
            let mut tx = s.tx()?;
            for item in [
                json!({"id": "cmd", "type": "command_execution", "input": "gh pr merge 7", "status": "completed"}),
                json!({"id": "msg", "type": "assistant_message", "status": "completed"}),
            ] {
                tx.append(crate::store::Draft::new("t1", "turn-item.updated", item))?;
            }
            tx.commit(None)
        })
        .await
        .unwrap();
    dispatch(&engine, message("t1", "c2", "one")).await;
    let (thread, event) = timeout(Duration::from_secs(5), feed.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(thread, "t1");
    assert_eq!(event["type"], "turn-item.updated");
    assert_eq!(event["payload"]["input"], "gh pr merge 7");
    let (_, event) = timeout(Duration::from_secs(5), feed.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        event["type"], "run.updated",
        "the assistant message is left out"
    );
}

/// The command feed's page says how far it scanned: past rows that matched nothing, so a
/// commit with no command does not make the next wake read them again.
#[tokio::test(flavor = "current_thread")]
async fn the_command_feed_moves_past_rows_that_match_nothing() {
    let db = TempDb::new("command-feed-cursor");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    let (rows, through, high) = engine
        .inner()
        .db(|s| {
            let (rows, through) = s.command_events_after(0, 64)?;
            Ok::<_, String>((rows.len(), through, s.high_water()))
        })
        .await
        .unwrap();
    assert_eq!(rows, 0, "thread.created is no command");
    assert_eq!(through, high);
}

/// Pass-4 gate finding 1: a monitor wake queued on model A starts on model B after the user
/// picks B on the same instance (T3's `startNextQueuedRun` copies the whole selection).
#[tokio::test(flavor = "current_thread")]
async fn a_monitor_wake_takes_a_new_model_on_the_same_instance() {
    let db = TempDb::new("monitor-wake-same-instance");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "active", "Hello")).await;
    let mut wake = queued("wake", "A watched pull request changed.");
    wake["createdBy"] = json!("agent");
    wake["creationSource"] = json!("server");
    wake["modelSelection"] = json!({"instanceId": "claudeAgent", "model": "model-a"});
    wake["notification"] = json!({"source": {"kind": "monitor"}, "outcome": "updated",
        "summary": "#7: checks failed"});
    dispatch(&engine, wake).await;
    dispatch(
        &engine,
        json!({"type": "thread.model-selection.set", "commandId": "select", "threadId": "t1",
            "modelSelection": {"instanceId": "claudeAgent", "model": "model-b"}}),
    )
    .await;
    drop(hold);
    run_to_end(&engine, "t1", "run:t1:1").await;
    let p = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(run_for(&p, "wake")["status"], "completed");
    assert_eq!(run_for(&p, "wake")["modelSelection"]["model"], "model-b");
}

/// Pass-4 gate finding 2: a stale pull request wake at the head of the queue is dropped
/// before a Claude failure decides what to hold, so queued Codex work still starts (T3 drops
/// stale wakes, then compares `providerFailed` on the runnable run).
#[tokio::test(flavor = "current_thread")]
async fn a_stale_wake_does_not_hold_other_provider_work_after_a_failure() {
    let db = TempDb::new("stale-wake-failure");
    let (engine, _, codex) = open_two(&db);
    dispatch(&engine, create("t1", "create")).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "a", "fail")).await;
    let mut wake = queued("wake", "A watched pull request changed.");
    wake["createdBy"] = json!("agent");
    wake["creationSource"] = json!("server");
    wake["notification"] = json!({"source": {"kind": "monitor", "pullRequest": {
            "host": "github.com", "repository": "o/r", "number": 7,
            "watchStartedAt": "2026-01-01T00:00:00.000Z", "headSha": null}},
        "outcome": "updated", "summary": "#7: checks failed"});
    dispatch(&engine, wake).await;
    let mut b = queued("b", "On Codex");
    b["modelSelection"] = json!({"instanceId": "codex", "model": "m"});
    dispatch(&engine, b).await;
    drop(hold);
    run_to_end(&engine, "t1", "run:t1:1").await;
    let p = projection(&engine, "t1").await;
    assert_eq!(run_for(&p, "wake")["status"], "cancelled", "{}", p["runs"]);
    let b_run = run_for(&p, "b")["id"].as_str().unwrap().to_owned();
    let p = run_to_end(&engine, "t1", &b_run).await;
    assert_eq!(run_for(&p, "b")["status"], "completed");
    assert_eq!(count(&codex.sessions), 1);
}

/// Pass-4 gate finding 3: an old `usage_limit` item no longer holds the queue once the latest
/// session reports another error (T3's `usageLimitHoldsQueue` reads the session's `lastError`).
#[tokio::test(flavor = "current_thread")]
async fn a_newer_session_error_lifts_an_old_usage_limit() {
    let db = TempDb::new("usage-limit-session-error");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let hold = gate(&engine).await;
    dispatch(&engine, message("t1", "a", "fail-usage-limit")).await;
    dispatch(&engine, queued("b", "Later")).await;
    drop(hold);
    run_to_end(&engine, "t1", "run:t1:1").await;
    engine
        .inner()
        .db(|s| {
            let mut tx = s.tx()?;
            let mut session = tx
                .entities("t1", "providerSessions")?
                .into_iter()
                .next()
                .expect("a session");
            session["lastError"] = json!("The provider process exited.");
            session["updatedAt"] = json!(tx.now());
            tx.append(crate::store::Draft::new(
                "t1",
                "provider-session.updated",
                session,
            ))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    dispatch(
        &engine,
        json!({"type":"queue.resume","commandId":"resume","threadId":"t1"}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    assert_ne!(run_for(&p, "b")["status"], "queued", "{}", p["runs"]);
}

/// Records the worktree launches whose first run was handed off.
#[derive(Default)]
struct HandoffHost {
    committed: Mutex<Vec<String>>,
}

impl crate::EngineHost for HandoffHost {
    fn provision_worktree(
        &self,
        request: crate::WorktreeRequest,
    ) -> crate::BoxFuture<'_, Result<crate::ProvisionedWorktree, String>> {
        Box::pin(std::future::ready(Ok(crate::ProvisionedWorktree {
            path: format!("{ROOT}/worktrees/{}", request.thread_id),
            branch: "feature".into(),
        })))
    }
    fn launch_committed(&self, thread_id: &str) {
        self.committed.lock().unwrap().push(thread_id.to_owned());
    }
}

/// T3 `ThreadLaunchService`: once the first run is handed off, setup's agent stage is done and
/// setup can no longer be cancelled, even when the provider then fails before its turn starts.
#[tokio::test]
async fn a_worktree_launch_with_a_first_message_ends_setup_when_the_run_is_handed_off() {
    let db = TempDb::new("launch-handoff");
    let host = Arc::new(HandoffHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    engine
        .launch_thread(json!({
            "commandId": "l1", "threadId": "t1", "projectId": project_id(), "title": "Setup",
            "modelSelection": {"instanceId": "claudeAgent", "model": "m"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "workspaceStrategy": {"type": "worktree", "baseRef": "main", "startFromOrigin": false},
            "initialMessage": {"messageId": "m1", "text": "go", "attachments": []},
        }))
        .await
        .unwrap();
    assert_eq!(*host.committed.lock().unwrap(), vec!["t1".to_owned()]);
}

/// T3's `ThreadFind` reads the visible timeline: a run fork finds the parent messages it
/// shows, through the fork run only, and every message is searched as its Markdown renders
/// (`searches inherited parent messages after a fork`, `searches visible rendered messages and
/// plans in canonical item order`). Both Find RPCs answer the same.
#[tokio::test(flavor = "current_thread")]
async fn find_searches_the_visible_timeline_as_rendered_on_both_rpcs() {
    let db = TempDb::new("find-fork");
    let (engine, _) = open(&db);
    let mut streams = vec![];
    for thread in ["t1", "t2"] {
        dispatch(&engine, create(thread, &format!("create-{thread}"))).await;
        let mut stream = engine
            .subscribe_thread(from_json(json!({"threadId": thread})).unwrap())
            .await
            .unwrap();
        next(&mut stream).await;
        streams.push(stream);
    }
    let markdown = "Check **the build**, then read [the handbook](https://example.test/internal-handle). Paste `https://example.test/literal` too.";
    for (command, text) in [
        ("c1", "Archive lantern"),
        ("c2", markdown),
        ("c3", "After the fork beacon"),
    ] {
        dispatch(&engine, message("t1", command, text)).await;
        until_run_ends(&mut streams[0]).await;
    }
    dispatch(&engine, message("t2", "u1", "Unrelated note")).await;
    until_run_ends(&mut streams[1]).await;
    dispatch(
        &engine,
        json!({
            "type": "thread.fork", "commandId": "f1", "sourceThreadId": "t1",
            "targetThreadId": "t3", "sourcePoint": {"type": "run", "runId": "run:t1:2"},
            "sideChat": false, "createdBy": "user", "creationSource": "web",
        }),
    )
    .await;
    let outline = engine.thread_outline("t3".into()).await.unwrap().unwrap();
    let previews: Vec<_> = outline.markers.iter().map(|m| m.preview.as_str()).collect();
    assert_eq!(previews.len(), 2);
    assert_eq!(previews[0], "Archive lantern");
    assert!(previews[1].starts_with("Check **the build**"));
    let inherited = engine
        .thread_window("t3".into(), outline.markers[1].entry_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(
        inherited["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["visibility"] == "inherited" && row["item"]["text"] == markdown)
    );
    let source = engine.thread_outline("t1".into()).await.unwrap().unwrap();
    assert!(
        engine
            .thread_window("t3".into(), source.markers[2].entry_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    let find = |thread: &str, query: &str| {
        let input = json!({"threadId": thread, "query": query});
        let engine = &engine;
        async move {
            let unary = call(engine, "orchestration.searchThread", input.clone())
                .await
                .unwrap();
            let streamed = stream_items(engine, "orchestration.searchThreadStream", input, 1).await;
            assert_eq!(
                streamed,
                std::slice::from_ref(&unary),
                "the stream's result is the unary one"
            );
            unary
        }
    };
    let entries = |result: &Value| -> Vec<(String, u64)> {
        result["navigation"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    entry["entryId"].as_str().unwrap().to_owned(),
                    entry["count"].as_u64().unwrap(),
                )
            })
            .collect()
    };
    let total = |result: &Value| result["totalMatches"].as_u64().unwrap();

    // The fork finds the parent's message it shows, under its source ids.
    for thread in ["t1", "t3"] {
        let found = find(thread, "archive LANTERN").await;
        assert_eq!(
            entries(&found),
            [
                ("message:c1".to_owned(), 1),
                ("message:run:t1:1:a".to_owned(), 1)
            ],
            "{thread}"
        );
        assert_eq!(
            found["match"],
            json!({"entryId": "message:c1", "runId": "run:t1:1", "occurrence": 0})
        );
        let second = find(thread, "the handbook").await;
        assert_eq!(total(&second), 2, "{thread}");
        assert_eq!(second["match"]["entryId"], "message:c2");
    }
    // A parent message after the fork point stays out of the fork.
    assert_eq!(total(&find("t1", "After the fork beacon").await), 2);
    assert_eq!(total(&find("t3", "After the fork beacon").await), 0);
    assert_eq!(total(&find("t2", "Archive lantern").await), 0);

    // Rendered Markdown: a phrase across emphasis and a code span's URL show; a link target
    // does not; a word nobody wrote finds nothing.
    for (query, count) in [
        ("check the build", 2),
        ("internal-handle", 0),
        ("example.test/literal", 2),
        ("lantern beacon", 0),
    ] {
        let found = find("t1", query).await;
        assert_eq!(total(&found), count, "{query}");
        if count > 0 {
            assert_eq!(found["match"]["entryId"], "message:c2", "{query}");
        }
    }

    // The fork's own messages follow the inherited ones.
    let mut fork = engine
        .subscribe_thread(from_json(json!({"threadId": "t3"})).unwrap())
        .await
        .unwrap();
    next(&mut fork).await;
    dispatch(&engine, message("t3", "c4", "Child lantern")).await;
    until_run_ends(&mut fork).await;
    let found = find("t3", "lantern").await;
    let ids: Vec<String> = entries(&found).into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids[..2], ["message:c1", "message:run:t1:1:a"]);
    assert_eq!(ids[2], "message:c4");
    assert_eq!(total(&found), 4);
    let last = call(
        &engine,
        "orchestration.searchThread",
        json!({"threadId": "t3", "query": "lantern", "index": 3}),
    )
    .await
    .unwrap();
    assert_eq!(last["match"]["entryId"], ids[3]);
    assert_eq!(last["match"]["occurrence"], 0);
}

/// T3's bounded thread snapshot (`buildBoundedThreadStreamSnapshot`), with the flags the GPUI
/// client sends: the newest 10 user turns and a cursor; `/history` reads the 6 before them.
#[tokio::test(flavor = "current_thread")]
async fn a_bounded_snapshot_holds_ten_turns_and_pages_back() {
    let db = TempDb::new("bounded");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    for i in 0..16 {
        dispatch(
            &engine,
            message("t1", &format!("send-{i}"), &format!("turn {i}")),
        )
        .await;
        until_run_ends(&mut stream).await;
    }
    let users = |rows: &Value| {
        rows.as_array()
            .unwrap()
            .iter()
            .filter(|row| row["item"]["type"] == "user_message")
            .map(|row| {
                row["item"]["messageId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect::<Vec<_>>()
    };
    let mut bounded = engine
        .subscribe_thread(
            from_json(json!({"threadId": "t1", "acceptBoundedSnapshot": true,
                "acceptCompactTurnItems": true, "acceptDedupedBodies": true}))
            .unwrap(),
        )
        .await
        .unwrap();
    let view = next(&mut bounded).await;
    let window = users(&view["projection"]["visibleTurnItems"]);
    assert_eq!(window.len(), 10);
    // T3's cohort: only the window's runs travel, with their attempts and nodes.
    for kind in ["runs", "attempts", "nodes"] {
        assert_eq!(
            view["projection"][kind].as_array().unwrap().len(),
            10,
            "{kind}"
        );
    }
    assert_eq!(view["hasMoreHistory"], true);
    dispatch(&engine, create("unrelated", "unrelated-create")).await;
    let mut reconnected = engine.subscribe_thread(
        from_json(json!({"threadId":"t1", "acceptBoundedSnapshot":true, "acceptCompactTurnItems":true, "acceptDedupedBodies":true})).unwrap()
    ).await.unwrap();
    let warm = next(&mut reconnected).await;
    assert!(warm["snapshotSequence"].as_u64() > view["snapshotSequence"].as_u64());
    assert_eq!(
        warm["historyCursor"], view["historyCursor"],
        "an unrelated thread does not invalidate cached bodies"
    );
    // Turns appended while the view is open do not move the cursor: the page still ends
    // right before the window, so window, page and new turns cover every turn once.
    for i in 16..19 {
        dispatch(
            &engine,
            message("t1", &format!("send-{i}"), &format!("turn {i}")),
        )
        .await;
        until_run_ends(&mut stream).await;
    }
    let outline = engine.thread_outline("t1".into()).await.unwrap().unwrap();
    assert_eq!(outline.markers.len(), 19);
    let anchor = &outline.markers[15];
    let jumped = engine
        .thread_window("t1".into(), anchor.entry_id.clone())
        .await
        .unwrap()
        .unwrap();
    let visible = projection(&engine, "t1").await["visibleTurnItems"]
        .as_array()
        .unwrap()
        .clone();
    let target = visible
        .iter()
        .position(|r| r["sourceItemId"] == anchor.entry_id)
        .unwrap();
    let expected = &visible[target.saturating_sub(24)..(target + 76).min(visible.len())];
    let ids = |rows: &[Value]| {
        rows.iter()
            .map(|r| r["sourceItemId"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(jumped["items"].as_array().unwrap()), ids(expected));
    let before = engine
        .thread_history_page(
            "t1".into(),
            jumped["nextCursor"].as_str().unwrap().to_owned(),
            None,
            crate::HistoryView::Timeline,
        )
        .await
        .unwrap();
    let crate::ThreadHistory::Page(before) = before else {
        panic!("window cursor did not page");
    };
    assert_eq!(
        before["items"].as_array().unwrap().last().unwrap()["sourceItemId"],
        visible[target - 25]["sourceItemId"]
    );
    let cursor = view["historyCursor"].as_str().unwrap().to_owned();
    let crate::ThreadHistory::Page(cached) = engine
        .thread_history_page(
            "t1".into(),
            cursor.clone(),
            None,
            crate::HistoryView::Messages,
        )
        .await
        .unwrap()
    else {
        panic!("missing message cache page")
    };
    let first_visible = view["projection"]["visibleTurnItems"][0]["sourceItemId"].clone();
    let boundary = visible
        .iter()
        .position(|row| row["sourceItemId"] == first_visible)
        .unwrap();
    let expected_messages: Vec<_> = visible[..boundary]
        .iter()
        .filter(|row| {
            matches!(
                row["item"]["type"].as_str(),
                Some("user_message" | "assistant_message")
            )
        })
        .cloned()
        .collect();
    assert_eq!(
        ids(cached["items"].as_array().unwrap()),
        ids(&expected_messages)
    );
    assert_eq!(cached["hasMoreHistory"], false);
    let page = engine
        .thread_history_page("t1".into(), cursor, None, crate::HistoryView::Timeline)
        .await
        .unwrap();
    let crate::ThreadHistory::Page(page) = page else {
        panic!("{page:?}")
    };
    let older = users(&page["items"]);
    assert_eq!(older.len(), 6);
    assert_eq!(page["hasMoreHistory"], false);
    let newest = users(&projection(&engine, "t1").await["visibleTurnItems"]);
    let mut seen: Vec<&String> = older.iter().chain(&window).collect();
    seen.extend(newest.iter().skip(16));
    assert_eq!(
        seen,
        newest.iter().collect::<Vec<_>>(),
        "no gap, no duplicate"
    );
    assert_eq!(
        engine
            .thread_history_page(
                "t1".into(),
                "bad".into(),
                None,
                crate::HistoryView::Timeline
            )
            .await
            .unwrap(),
        crate::ThreadHistory::InvalidCursor
    );
}

/// T3's byte budget (`THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes`): on a thread larger than
/// 1 MiB, the bounded snapshot stays within it and fewer than 10 turns fit.
#[tokio::test(flavor = "current_thread")]
async fn a_bounded_snapshot_stays_within_its_byte_budget() {
    let db = TempDb::new("bounded-bytes");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    let text = "x".repeat(40_000);
    for i in 0..30 {
        dispatch(&engine, message("t1", &format!("send-{i}"), &text)).await;
        until_run_ends(&mut stream).await;
    }
    let full = projection(&engine, "t1").await.to_string().len();
    assert!(full > 2_000_000, "{full}");
    let mut bounded = engine
        .subscribe_thread(
            // The flags the GPUI client sends (`conn-client/src/driver.rs`).
            from_json(json!({"threadId": "t1", "acceptBoundedSnapshot": true,
                "acceptCompactTurnItems": true, "acceptDedupedBodies": true}))
            .unwrap(),
        )
        .await
        .unwrap();
    let view = next(&mut bounded).await;
    let sent = view.to_string().len();
    assert!(sent <= 1_048_576, "{sent}");
    assert_eq!(view["hasMoreHistory"], true);
}

/// T3's windowed subagent read: a bounded snapshot sends the live subagents and those of its
/// runs, not an old one outside the window.
#[tokio::test(flavor = "current_thread")]
async fn a_bounded_snapshot_leaves_out_old_subagents() {
    let db = TempDb::new("bounded-subagents");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "create")).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    for i in 0..12 {
        dispatch(
            &engine,
            message("t1", &format!("send-{i}"), &format!("turn {i}")),
        )
        .await;
        until_run_ends(&mut stream).await;
    }
    let subagent = |id: &str, run: &str, status: &str| {
        crate::store::Draft::new(
            "t1",
            "subagent.updated",
            json!({"id": id, "threadId": "t1", "runId": run,
                "parentNodeId": format!("node:{run}:root"), "origin": "provider_native",
                "createdBy": "agent", "driver": "claudeAgent", "providerInstanceId": "claudeAgent",
                "providerThreadId": null, "childThreadId": null, "nativeTaskRef": null,
                "prompt": "p".repeat(10_000), "title": "Task", "model": null, "status": status,
                "result": "done", "startedAt": "2026-01-01T00:00:00.000Z",
                "completedAt": "2026-01-01T00:00:01.000Z",
                "updatedAt": "2026-01-01T00:00:01.000Z"}),
        )
    };
    engine
        .inner()
        .db(move |store| {
            let mut tx = store.tx()?;
            tx.append(subagent("old", "run:t1:1", "completed"))?;
            tx.append(subagent("recent", "run:t1:12", "completed"))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    assert_eq!(
        projection(&engine, "t1").await["subagents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let mut bounded = engine
        .subscribe_thread(
            from_json(json!({"threadId": "t1", "acceptBoundedSnapshot": true})).unwrap(),
        )
        .await
        .unwrap();
    let view = next(&mut bounded).await;
    assert_eq!(view["hasMoreHistory"], true);
    let kept: Vec<&str> = view["projection"]["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["id"].as_str())
        .collect();
    assert_eq!(kept, ["recent"]);
}

/// `Orchestrator.ts:7031`: a delegated result recorded for the thread but not yet delivered as
/// its message keeps the thread busy, so an idle compaction is a no-op until it is delivered.
#[tokio::test(flavor = "current_thread")]
async fn an_idle_compaction_waits_for_an_undelivered_delegated_result() {
    let db = TempDb::new("compaction-undelivered");
    let (engine, _) = open(&db);
    dispatch(&engine, create("t1", "c1")).await;
    dispatch(&engine, message("t1", "c2", "hello")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    // The window before delivery: the result is in, its wake message is not.
    engine
        .inner()
        .db(|store| {
            let mut tx = store.tx()?;
            tx.append(
                crate::store::Draft::new(
                    "t1",
                    "subagent.updated",
                    json!({"id": "node:delegated-task:d1", "origin": "app_owned",
                        "status": "completed", "result": "done", "runId": "run:t1:1",
                        "completionDelivery": {"state": "pending", "observedByRunId": null}}),
                )
                .run(Some("run:t1:1")),
            )?;
            tx.commit(None)
        })
        .await
        .unwrap();
    let compact = |n: u32| {
        json!({"type": "message.dispatch", "commandId": format!("server:idle-compact:t1:{n}"),
            "threadId": "t1", "messageId": format!("idle-compact:t1:{n}"), "text": "/compact",
            "attachments": [], "createdBy": "agent", "creationSource": "server",
            "idleCompaction": "beforeCacheExpires", "dispatchMode": {"type": "start_immediately"}})
    };
    dispatch(&engine, compact(1)).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"].as_array().unwrap().len(), 1, "no compaction run");
    assert!(
        !p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "idle-compact:t1:1")
    );
    // Once the parent has the result, the thread is idle again.
    dispatch(
        &engine,
        json!({"type": "delegated_task.completion-delivery.acknowledge", "commandId": "ack",
            "parentThreadId": "t1", "taskId": "node:delegated-task:d1",
            "observedByRunId": "run:t1:1"}),
    )
    .await;
    dispatch(&engine, compact(2)).await;
    let p = projection(&engine, "t1").await;
    assert!(
        p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "idle-compact:t1:2"),
        "the compaction runs"
    );
}

/// A composer context with one inline file chip per id.
fn chips(ids: &[&str]) -> Value {
    let records: Vec<Value> = ids
        .iter()
        .map(|id| {
            json!({"kind": "file", "label": "notes.txt", "attachmentId": id, "name": "notes.txt",
                "mimeType": "text/plain", "sizeBytes": 3})
        })
        .collect();
    json!({"version": 1, "records": records})
}

fn text_file(id: &str) -> Value {
    json!({"type": "file", "id": id, "name": "notes.txt", "mimeType": "text/plain",
        "sizeBytes": 3})
}

/// `ThreadMessageIntake.test.ts`, "shared intake preserves durable attachment bytes": a queued
/// message's edit claims its new upload and keeps its saved file, once; a stale edit that keeps
/// a removed file is refused.
#[tokio::test(flavor = "current_thread")]
async fn a_queued_edit_claims_its_new_upload_once() {
    let db = TempDb::new("edit-claim");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut later = message_with(
        "t1",
        "c3",
        "later",
        json!({"type": "queue_after_active"}),
        None,
    );
    later["attachments"] = json!([text_file("pending-1")]);
    later["context"] = chips(&["pending-1"]);
    dispatch(&engine, later).await;
    let edit = json!({"type": "queued-run.edit", "commandId": "c4", "threadId": "t1",
        "runId": "run:t1:2", "text": "edited",
        "attachments": [text_file("t1-1"), text_file("pending-2")],
        "context": chips(&["t1-1", "pending-2"])});
    dispatch(&engine, edit.clone()).await;
    let ids = |p: &Value| -> Vec<Value> {
        p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "message:c3")
            .unwrap()["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["id"].clone())
            .collect()
    };
    assert_eq!(
        ids(&projection(&engine, "t1").await),
        [json!("t1-1"), json!("t1-2")]
    );
    // The inline chips name the claimed files, so the client can match them
    // (`remapComposerContextAttachments`).
    let chip_ids: Vec<Value> = projection(&engine, "t1").await["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "message:c3")
        .unwrap()["context"]["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["attachmentId"].clone())
        .collect();
    assert_eq!(chip_ids, [json!("t1-1"), json!("t1-2")]);
    // A retry replays its receipt before any file is looked up or claimed again.
    let claims = host.claims.lock().unwrap().len();
    dispatch(&engine, edit).await;
    assert_eq!(host.claims.lock().unwrap().len(), claims);
    // A stale view that keeps a file another client removed is refused, and changes nothing.
    let stale = json!({"type": "queued-run.edit", "commandId": "c5", "threadId": "t1",
        "runId": "run:t1:2", "text": "stale", "attachments": [text_file("gone-1")]});
    assert!(engine.dispatch(from_json(stale).unwrap()).await.is_err());
    assert_eq!(
        ids(&projection(&engine, "t1").await),
        [json!("t1-1"), json!("t1-2")]
    );
    // A refused edit releases only the copy it made, never the file it kept.
    let refused = json!({"type": "queued-run.edit", "commandId": "c6", "threadId": "t1",
        "runId": "run:t1:9", "text": "no such run",
        "attachments": [text_file("t1-1"), text_file("pending-3")]});
    assert!(engine.dispatch(from_json(refused).unwrap()).await.is_err());
    assert_eq!(
        host.released.lock().unwrap().last().unwrap(),
        &json!([text_file("t1-3")])
    );
}

const RECORDING: &str = "t1-0b9f6c1e-3c1d-4f7a-9d2e-5a6b7c8d9e0f-webm";
const ACP_RECORDING: &str = "t1-1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f-webm";

/// `Orchestrator.ts`, `queued-run.edit`: a file an edit drops is removed after the edit commits
/// (`attachment.cleanup` with `skipReferenced`), unless another message of the thread still
/// names it.
#[tokio::test(flavor = "current_thread")]
async fn a_queued_edit_removes_the_files_it_drops() {
    let db = TempDb::new("edit-drop");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    // An `html_render` page the thread shows, which a queued message also names.
    let page = "t1-00000000-0000-4000-8000-000000000001-html";
    engine
        .inner()
        .db(move |store| {
            let mut tx = store.tx()?;
            tx.append(crate::store::Draft::new("t1", "turn-item.updated", json!({
                "id": "render", "threadId": "t1", "runId": "run:t1:1", "type": "dynamic_tool",
                "toolName": "html_render", "status": "completed", "ordinal": 1,
                "output": {"htmlRender": {"attachmentId": page, "title": "Page", "height": 100}},
            })))?;
            // `TurnStartReads.test.ts`: a `preview_recording_stop` result names its WebM.
            tx.append(crate::store::Draft::new("t1", "turn-item.updated", json!({
                "id": "recording", "threadId": "t1", "runId": "run:t1:1", "type": "dynamic_tool",
                "toolName": "mcp__conn__preview_recording_stop", "status": "completed",
                "ordinal": 2, "input": {},
                "output": [{"type": "text", "text": json!({"id": RECORDING, "mimeType": "video/webm"}).to_string()}],
            })))?;
            // `htmlRender.test.ts`: Antigravity's `acp-mcp-call` puts the result in its stdout.
            let result = json!({"content": [], "structuredContent": {"id": ACP_RECORDING}, "isError": false});
            tx.append(crate::store::Draft::new("t1", "turn-item.updated", json!({
                "id": "acp-recording", "threadId": "t1", "runId": "run:t1:1", "type": "dynamic_tool",
                "toolName": "conn.preview_recording_stop", "status": "completed", "ordinal": 3,
                "output": {"output": format!("Command exited with code 0.\n\nCommand output:\n{result}\r\n"), "exit_code": 0},
            })))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    let queue = json!({"type": "queue_after_active"});
    let mut first = message_with("t1", "c3", "first", queue.clone(), None);
    first["attachments"] = json!([
        text_file("pending-1"),
        text_file(page),
        text_file(RECORDING),
        text_file(ACP_RECORDING)
    ]);
    dispatch(&engine, first).await;
    let mut second = message_with("t1", "c4", "second", queue, None);
    second["attachments"] = json!([text_file("t1-1")]);
    dispatch(&engine, second).await;
    // The second message still names the file, and the timeline shows the page and the
    // recording: all stay.
    let edit = |command: &str, run: &str, attachments: Value| {
        json!({"type": "queued-run.edit", "commandId": command, "threadId": "t1", "runId": run,
            "text": "edited", "attachments": attachments})
    };
    dispatch(&engine, edit("c5", "run:t1:2", json!([]))).await;
    // Now nothing names it: it goes. The new upload stays.
    dispatch(
        &engine,
        edit("c6", "run:t1:3", json!([text_file("pending-2")])),
    )
    .await;
    timeout(Duration::from_secs(5), async {
        while host.deleted.lock().unwrap().is_empty() {
            host.deleted_event.notified().await;
        }
    })
    .await
    .expect("the dropped file is cleaned up");
    assert_eq!(*host.deleted.lock().unwrap(), [vec!["t1-1".to_owned()]]);
}

/// `Orchestrator.ts`, `queued-run.edit`: a steer the provider declined waits in the queue with
/// its timeline item already made; an edit updates that item with its message, so the run
/// starts with the files the edit kept.
#[tokio::test(flavor = "current_thread")]
async fn editing_a_declined_steer_updates_its_timeline_item() {
    let db = TempDb::new("edit-declined-steer");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(
        FakeProvider::new("claudeAgent").without_steering(),
    )];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut steer = message_with(
        "t1",
        "c3",
        "steer me",
        json!({"type": "steer_active", "targetRunId": "run:t1:1"}),
        None,
    );
    steer["attachments"] = json!([text_file("pending-a")]);
    dispatch(&engine, steer).await;
    let run = loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "run.created"
            && item["event"]["payload"]["userMessageId"] == "message:c3"
        {
            break item["event"]["payload"]["id"].clone();
        }
    };
    dispatch(
        &engine,
        json!({"type": "queued-run.edit", "commandId": "c4", "threadId": "t1", "runId": run,
            "text": "steered", "attachments": [text_file("pending-b")]}),
    )
    .await;
    let p = projection(&engine, "t1").await;
    let ids = |row: &Value| -> Vec<Value> {
        row["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["id"].clone())
            .collect()
    };
    let message = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "message:c3")
        .unwrap();
    let item = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "user_message" && i["messageId"] == "message:c3")
        .unwrap();
    assert_eq!(ids(message), [json!("t1-b")]);
    assert_eq!(ids(item), [json!("t1-b")]);
    assert_eq!(item["text"], "steered");
}

/// `Orchestrator.ts`, `queued-run.edit` and the queued run's start: a queued message's
/// `user_message` item is the one with its `messageId`, whatever its id. A thread imported from
/// the TypeScript server keeps that server's item ids.
#[tokio::test(flavor = "current_thread")]
async fn an_imported_queued_items_edit_and_start_find_it_by_message() {
    let db = TempDb::new("edit-imported-item");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut queued = message_with(
        "t1",
        "c3",
        "later",
        json!({"type": "queue_after_active"}),
        None,
    );
    queued["attachments"] = json!([text_file("pending-a")]);
    dispatch(&engine, queued).await;
    // The item as the importer keeps it, under the TypeScript server's id.
    let imported = "turn-item:message:imported-c3";
    engine
        .inner()
        .db(move |store| {
            let mut tx = store.tx()?;
            tx.append(crate::store::Draft::new(
                "t1",
                "turn-item.updated",
                json!({
                    "id": imported, "threadId": "t1", "runId": "run:t1:2", "type": "user_message",
                    "messageId": "message:c3", "text": "later", "ordinal": 0, "status": "completed",
                    "attachments": [text_file("t1-a")],
                }),
            ))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    dispatch(
        &engine,
        json!({"type": "queued-run.edit", "commandId": "c4", "threadId": "t1",
            "runId": "run:t1:2", "text": "edited", "attachments": [text_file("pending-b")]}),
    )
    .await;
    let items = |p: &Value| -> Vec<(Value, Value)> {
        p["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["type"] == "user_message" && i["messageId"] == "message:c3")
            .map(|i| (i["id"].clone(), i["attachments"][0]["id"].clone()))
            .collect()
    };
    let p = projection(&engine, "t1").await;
    assert_eq!(items(&p), [(json!(imported), json!("t1-b"))]);
    // The run starts with that same item, not a second one under the Conn Server's id.
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c5", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    for _ in 0..2 {
        until_run_ends(&mut thread).await;
    }
    assert_eq!(
        items(&projection(&engine, "t1").await),
        [(json!(imported), json!("t1-b"))]
    );
}

/// `Orchestrator.ts`, `queued-run.edit` and the queued run's start: promoting an imported
/// queued message cancels its run and steers it under a new item; when the provider declines,
/// the newer item waits in the queue. Edit and start take the item of the queued run
/// (`candidate.runId === queuedRun.id`), not the cancelled run's.
#[tokio::test(flavor = "current_thread")]
async fn a_declined_promotion_of_an_imported_item_edits_and_starts_the_requeued_item() {
    let db = TempDb::new("promote-imported-declined");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(
        FakeProvider::new("claudeAgent").without_steering(),
    )];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "hang")).await;
    until_provider_turn(&mut thread).await;
    let mut queued = message_with(
        "t1",
        "c3",
        "later",
        json!({"type": "queue_after_active"}),
        None,
    );
    queued["attachments"] = json!([text_file("pending-a")]);
    dispatch(&engine, queued).await;
    // The item as the importer keeps it, under the TypeScript server's id.
    let imported = "turn-item:message:imported-c3";
    engine
        .inner()
        .db(move |store| {
            let mut tx = store.tx()?;
            tx.append(crate::store::Draft::new(
                "t1",
                "turn-item.updated",
                json!({
                    "id": imported, "threadId": "t1", "runId": "run:t1:2", "type": "user_message",
                    "messageId": "message:c3", "text": "later", "ordinal": 0, "status": "completed",
                    "attachments": [text_file("t1-a")],
                }),
            ))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    dispatch(
        &engine,
        json!({"type": "queued-message.promote-to-steer", "commandId": "c4", "threadId": "t1",
            "queuedRunId": "run:t1:2", "targetRunId": "run:t1:1"}),
    )
    .await;
    let requeued = loop {
        let item = next(&mut thread).await;
        let payload = &item["event"]["payload"];
        if item["event"]["type"] == "run.created"
            && payload["userMessageId"] == "message:c3"
            && payload["id"] != "run:t1:2"
        {
            break payload["id"].clone();
        }
    };
    dispatch(
        &engine,
        json!({"type": "queued-run.edit", "commandId": "c5", "threadId": "t1", "runId": requeued,
            "text": "edited", "attachments": [text_file("pending-b")]}),
    )
    .await;
    let items = |p: &Value| -> Vec<(Value, Value, Value)> {
        p["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["type"] == "user_message" && i["messageId"] == "message:c3")
            .map(|i| {
                (
                    i["id"].clone(),
                    i["runId"].clone(),
                    i["attachments"][0]["id"].clone(),
                )
            })
            .collect()
    };
    let steered = json!("turn-item:message:c3");
    let p = projection(&engine, "t1").await;
    assert_eq!(
        items(&p),
        [
            (json!(imported), json!("run:t1:2"), json!("t1-a")),
            (steered.clone(), requeued.clone(), json!("t1-b")),
        ]
    );
    // The requeued run starts with that same item.
    dispatch(
        &engine,
        json!({"type": "run.interrupt", "commandId": "c6", "threadId": "t1", "runId": "run:t1:1"}),
    )
    .await;
    for _ in 0..2 {
        until_run_ends(&mut thread).await;
    }
    assert_eq!(
        items(&projection(&engine, "t1").await),
        [
            (json!(imported), json!("run:t1:2"), json!("t1-a")),
            (steered, requeued, json!("t1-b")),
        ]
    );
}

/// `ThreadMessageIntake.test.ts`, "claims question uploads and passes readable paths": each
/// question's files are claimed for it, its answer reaches the provider with their paths, and a
/// retry delivers neither again.
#[tokio::test(flavor = "current_thread")]
async fn question_answers_claim_their_files_and_pass_their_paths() {
    let db = TempDb::new("answer-claim");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(&engine, message("t1", "c2", "question")).await;
    loop {
        let item = next(&mut thread).await;
        if item["event"]["type"] == "runtime-request.updated" {
            break;
        }
    }
    // The question as a provider adapter records it, so the answer has its history row.
    let request = projection(&engine, "t1").await["runtimeRequests"][0].clone();
    engine
        .inner()
        .db(move |store| {
            let mut tx = store.tx()?;
            tx.append(crate::store::Draft::new("t1", "turn-item.updated", json!({
                "id": "question-item", "threadId": "t1", "runId": "run:t1:1",
                "nodeId": request["nodeId"], "type": "user_input_request", "ordinal": 1,
                "status": "running", "requestId": "question:run:t1:1",
                "questions": [{"id": "q", "question": "Which file?"}, {"id": "r", "question": "Other?"},
                    {"id": "s", "question": "Wrapped?"}],
            })))?;
            tx.commit(None)
        })
        .await
        .unwrap();
    let answer = json!({"type": "runtime-request.respond", "commandId": "c3", "threadId": "t1",
        "requestId": "question:run:t1:1",
        "answers": {"q": ["See file"], "r": "Other", "s": {"answers": ["A"]}},
        "attachmentsByQuestionId": {"q": [text_file("pending-a")], "r": [text_file("pending-b")],
            "s": [text_file("pending-a")]}});
    // A duplicate within one question is refused.
    let mut duplicate = answer.clone();
    duplicate["commandId"] = json!("c-dup");
    duplicate["attachmentsByQuestionId"] =
        json!({"q": [text_file("pending-a"), text_file("pending-a")]});
    assert!(
        engine
            .dispatch(from_json(duplicate).unwrap())
            .await
            .is_err()
    );
    let before = host.claims.lock().unwrap().len();
    dispatch(&engine, answer.clone()).await;
    // The limits see the whole response once (`validateAttachmentLimits`); each question's
    // files are claimed on their own, so two questions may share one upload.
    assert_eq!(
        host.limit_checks.lock().unwrap().last().unwrap(),
        &json!([
            text_file("pending-a"),
            text_file("pending-b"),
            text_file("pending-a")
        ])
    );
    assert_eq!(
        host.claims.lock().unwrap()[before..],
        [
            json!([text_file("pending-a")]),
            json!([text_file("pending-b")]),
            json!([text_file("pending-a")]),
        ]
    );
    until_run_ends(&mut thread).await;
    // A wrapped answer becomes the paths alone, as T3's `appendUserInputAttachmentPaths`
    // makes it: every adapter reads a text.
    assert_eq!(
        *provider.answers.lock().unwrap(),
        [json!({
            "q": ["See file", "saved at /files/t1-a"],
            "r": "Other\n\nsaved at /files/t1-b",
            "s": "saved at /files/t1-a",
        })]
    );
    let p = projection(&engine, "t1").await;
    let item = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "user_input_request")
        .unwrap()
        .clone();
    assert_eq!(
        item["questionAnswer"]["attachmentsByQuestionId"],
        json!({"q": [text_file("t1-a")], "r": [text_file("t1-b")], "s": [text_file("t1-a")]})
    );
    let claims = host.claims.lock().unwrap().len();
    dispatch(&engine, answer).await;
    assert_eq!(host.claims.lock().unwrap().len(), claims);
    assert_eq!(provider.answers.lock().unwrap().len(), 1);
}
