//! Engine tests: commands into a temp-file store, stream items out, and a restart.

use std::{path::PathBuf, sync::Arc, time::Duration};

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
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.stream_flush = Duration::from_millis(20);
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

#[tokio::test(flavor = "current_thread")]
async fn a_restart_ends_the_running_turn_and_keeps_the_thread() {
    let db = TempDb::new("restart");
    {
        let (engine, _) = open(&db);
        dispatch(&engine, create("t1", "c1")).await;
        dispatch(&engine, message("t1", "c2", "done")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "t1", "afterSequence": 1})).unwrap())
            .await
            .unwrap();
        until_run_ends(&mut thread).await;
        dispatch(&engine, message("t1", "c3", "hang")).await;
        loop {
            if next(&mut thread).await["event"]["type"] == "provider-turn.updated" {
                break;
            }
        }
        // The process dies here: no provider, no terminal.
    }

    let (engine, provider) = open(&db);
    let shell = engine.shell_snapshot().await.unwrap();
    let row = &shell["threads"][0];
    assert_eq!(row["status"], "failed");
    assert_eq!(row["activeRunId"], Value::Null);
    assert!(row["lastError"].as_str().unwrap().contains("restarted"));

    let mut thread = engine
        .subscribe_thread(
            from_json(json!({"threadId": "t1", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    let snapshot = next(&mut thread).await;
    let projection = &snapshot["projection"];
    let runs: Vec<_> = projection["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].clone())
        .collect();
    assert_eq!(runs, [json!("completed"), json!("failed")]);
    let texts: Vec<_> = projection["visibleTurnItems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["item"]["type"].clone(), row["position"].clone()))
        .collect();
    assert_eq!(
        texts,
        [
            (json!("user_message"), json!(0)),
            (json!("assistant_message"), json!(1)),
            (json!("user_message"), json!(2)),
            (json!("error"), json!(3)),
        ]
    );
    assert_eq!(next(&mut thread).await["kind"], "synchronized");

    // The thread takes a new turn on a new session, resuming the stored provider thread.
    dispatch(&engine, message("t1", "c4", "again")).await;
    let events = until_run_ends(&mut thread).await;
    assert_eq!(events.last().unwrap().1["status"], "completed");
    assert_eq!(
        provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
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
