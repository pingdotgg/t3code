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
    assert_eq!(replayed["event"]["type"], "thread.visited");
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

#[tokio::test(flavor = "current_thread")]
async fn a_restart_sends_an_undelivered_message_again() {
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
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(p["runs"][0]["status"], "completed");
    assert_eq!(p["messages"][1]["text"], "echo: late");
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
    let retry = engine.launch_thread(input).await.unwrap();
    assert_eq!(retry["resumed"], true);
    assert_eq!(retry["sequence"], result["sequence"]);

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

    let renamed = call(
        &engine,
        "projects.mutate",
        json!({"type": "project.update", "commandId": "p3", "projectId": "project:new",
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
    assert_eq!(handled, 45);
    assert_eq!(conn_contract::COMMAND_TYPES.len(), 58);
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
    json!({"text": format!("Update on pull request #{number}\n\nLook into each item and act on it as your task requires. This PR stays linked and watched, so do not link, watch, or list it again. End your turn when you are done, and T3 Code wakes you on the next change. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox."),
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

    dispatch(
        &engine,
        cmd(
            8,
            "thread.snooze",
            json!({"snoozedUntil": "2030-01-01T00:00:00.000Z"}),
        ),
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
        crate::commands::refusal("thread.merge_back").contains("merge a fork back"),
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
    for (thread, title) in [("t1", "Fix the login bug"), ("t2", "Write docs")] {
        let mut c = create(thread, &format!("create-{thread}"));
        c["title"] = json!(title);
        c["worktreePath"] = json!("/tmp/wt");
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
        json!({"worktreePath": "/tmp/wt"}),
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
        dispatch(&engine, create(&id, &format!("c{id}"))).await;
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
    closed: Mutex<Vec<(String, crate::ThreadClose)>>,
    html_cleanup: Mutex<Vec<(String, String)>>,
    closed_event: tokio::sync::Notify,
}

impl crate::EngineHost for RecordingHost {
    fn agent_tools(&self, session: crate::AgentSession) -> Option<crate::AgentTools> {
        self.sessions.lock().unwrap().push(session.clone());
        Some(crate::AgentTools {
            servers: vec![conn_provider::McpServer {
                name: "t3-code".into(),
                url: "http://127.0.0.1:1/mcp".into(),
                headers: vec![(
                    "Authorization".into(),
                    format!("Bearer {}", session.thread_id),
                )],
            }],
            key: format!("key:{}", session.thread_id),
        })
    }
    fn session_closed(&self, key: &str) {
        self.revoked.lock().unwrap().push(key.to_owned());
    }
    fn claim_attachments(
        &self,
        thread_id: String,
        attachments: Value,
    ) -> crate::BoxFuture<'_, Result<Value, String>> {
        Box::pin(async move {
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
    fn cleanup_html_attachments(&self, ids: Vec<(String, String)>) -> crate::BoxFuture<'_, ()> {
        self.html_cleanup.lock().unwrap().extend(ids);
        Box::pin(async {})
    }
    fn thread_closed(&self, thread_id: &str, reason: crate::ThreadClose) {
        self.closed
            .lock()
            .unwrap()
            .push((thread_id.to_owned(), reason));
        self.closed_event.notify_one();
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
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, create("t1", "c1")).await;
    let image = json!({"type": "image", "id": "pending-1", "name": "a.png",
        "mimeType": "image/png", "sizeBytes": 3});
    let mut first = message("t1", "c2", "look");
    first["attachments"] = json!([image]);
    dispatch(&engine, first).await;
    let p = run_to_end(&engine, "t1", "run:t1:1").await;
    assert_eq!(p["messages"][0]["attachments"][0]["id"], "t1-1");
    assert_eq!(provider.mcp_servers.lock().unwrap()[0].name, "t3-code");
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
    let bad = refused(&engine, snooze("s2", "t1", "2030-02-31T00:00:00.000Z")).await;
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

/// A thread's effects run in the order their lane slots were taken, not the order they were
/// started (review finding 2.1: dispatch takes the slot inside the store closure, so lane order
/// is commit order). A slot given up without running (its commit failed) keeps that order.
#[tokio::test(flavor = "current_thread")]
async fn lane_order_is_reservation_order() {
    let db = TempDb::new("lane-reserve");
    let host = Arc::new(RecordingHost::default());
    let mut config = EngineConfig::new(db.path());
    config.host = Some(host.clone());
    let engine = SqliteEngine::open(config).unwrap();
    let inner = engine.inner();
    let close = |reason| crate::commands::Effect::ThreadClosed {
        thread_id: "t1".into(),
        reason,
    };
    let first = inner.reserve_effect(close(crate::ThreadClose::Archived));
    let given_up = inner.reserve_effect(close(crate::ThreadClose::Settled));
    let last = inner.reserve_effect(close(crate::ThreadClose::Deleted));
    drop(given_up);
    last.start();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        host.closed.lock().unwrap().is_empty(),
        "waits for the first"
    );
    first.start();
    tokio::time::sleep(Duration::from_millis(20)).await;
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
    let inner = engine.inner();
    let blocker = inner.reserve_effect(crate::commands::Effect::ThreadClosed {
        thread_id: "t1".into(),
        reason: crate::ThreadClose::Settled,
    });
    dispatch(&engine, message("t1", "c3", "hello again")).await;
    dispatch(&engine, stop("t1", "c4")).await;
    let p = projection(&engine, "t1").await;
    assert_eq!(run_of(&p, "run:t1:2")["status"], "interrupted");
    assert_eq!(
        item_of(&p, "turn-item:run:t1:2:interrupt-result")["message"],
        "Run interrupted before provider start"
    );
    blocker.start();
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
        let mut wrong = command.clone();
        wrong["nodeId"] = json!("wrong");
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

    // Deleting the source keeps the fork's inherited history, as in T3.
    dispatch(
        &engine,
        json!({"type": "thread.delete", "commandId": "d1", "threadId": "t1"}),
    )
    .await;
    assert_eq!(body(read("t2").await.unwrap())["items"], json!(expected));

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
        stmt.query_map(["t1"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("; ")
    };
    let items = plan(crate::store::TRANSCRIPT_ITEMS_SQL);
    assert!(items.contains("USING INDEX turn_items_in_order"), "{items}");
    assert!(!items.contains("TEMP B-TREE"), "{items}");
    let interrupts = plan(crate::store::TRANSCRIPT_INTERRUPTS_SQL);
    assert!(interrupts.contains("turn_item_interrupts"), "{interrupts}");
    assert!(!interrupts.contains("TEMP B-TREE"), "{interrupts}");
}
