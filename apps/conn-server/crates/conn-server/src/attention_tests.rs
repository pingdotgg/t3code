use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conn_contract::attention::{ConnAttentionEventType, ConnAttentionKind};
use conn_contract::from_json;
use conn_engine::{Engine, EngineConfig, ManualClock, ProjectConfig, SqliteEngine};
use serde_json::json;

use super::*;

const ROOT: &str = "/tmp/conn-attention-project";
const T0: u64 = 1_795_000_000_000;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("conn-attention-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn open(dir: &TempDir, clock: &Arc<ManualClock>) -> SqliteEngine {
    let mut config = EngineConfig::new(dir.0.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(conn_engine::fake::FakeProvider::new(
        "claudeAgent",
    ))];
    config.clock = clock.clone();
    config.attention = true;
    SqliteEngine::open(config).unwrap()
}

/// Runs one turn with `text` (the fake provider's script) and waits for its event.
async fn turn(engine: &SqliteEngine, thread: &str, text: &str) {
    let signal = engine.attention_signal().unwrap();
    start_turn(engine, thread, text).await;
    tokio::time::timeout(Duration::from_secs(5), signal.notified())
        .await
        .expect("the turn's end writes an attention event");
}

/// Starts one turn with `text`, without waiting for it.
async fn start_turn(engine: &SqliteEngine, thread: &str, text: &str) {
    let create = json!({
        "type": "thread.create", "commandId": format!("{thread}:create"), "threadId": thread,
        "projectId": SqliteEngine::project_id_for(ROOT), "title": "Fix the build",
        "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
    });
    let message = json!({
        "type": "message.dispatch", "commandId": format!("{thread}:send"), "threadId": thread,
        "messageId": format!("message:{thread}"), "text": text, "attachments": [],
        "dispatchMode": {"type": "start_immediately"}, "createdBy": "user", "creationSource": "web",
    });
    for command in [create, message] {
        engine
            .dispatch(from_json(command).unwrap())
            .await
            .ok()
            .unwrap();
    }
}

/// A sender that records each event and answers from a script, then with success.
#[derive(Default)]
struct FakeSender {
    sent: Mutex<Vec<ConnAttentionEvent>>,
    answers: Mutex<VecDeque<Result<(), SendError>>>,
    arrived: tokio::sync::Notify,
}

impl FakeSender {
    fn answering(answers: Vec<Result<(), SendError>>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into()),
            ..Self::default()
        })
    }

    fn sent(&self) -> Vec<ConnAttentionEvent> {
        self.sent.lock().unwrap().clone()
    }
}

impl AttentionSender for FakeSender {
    fn send(&self, event: ConnAttentionEvent) -> BoxFuture<'static, Result<(), SendError>> {
        self.sent.lock().unwrap().push(event);
        let answer = self.answers.lock().unwrap().pop_front().unwrap_or(Ok(()));
        self.arrived.notify_one();
        Box::pin(std::future::ready(answer))
    }
}

fn retry() -> Result<(), SendError> {
    Err(SendError::RetryLater("429 conn.rate_limited".into()))
}

#[tokio::test(flavor = "current_thread")]
async fn an_event_is_sent_with_the_environment_and_then_removed() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    turn(&engine, "t1", "done").await;
    turn(&engine, "t2", "fail").await;
    let sender = FakeSender::answering(vec![]);
    let pass = drain_once(&engine, sender.as_ref(), "env-1").await.unwrap();
    assert_eq!((pass.sent, pass.next_due), (2, None));
    let sent = sender.sent();
    let kinds: Vec<_> = sent
        .iter()
        .map(|e| (e.thread_id.as_str(), e.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            ("t1", Some(ConnAttentionKind::TurnFinished)),
            ("t2", Some(ConnAttentionKind::TurnFailed))
        ]
    );
    let first = &sent[0];
    assert_eq!(first.event_type, ConnAttentionEventType::Attention);
    assert_eq!(first.environment_id, "env-1");
    assert_eq!(first.thread_title.as_deref(), Some("Fix the build"));
    assert_eq!(first.request_id, None);
    assert_eq!(first.event_id.len(), 26);
    // The body holds only the contract's fields: no message text leaves the server.
    let body = serde_json::to_value(first).unwrap();
    let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "environment_id",
            "event_id",
            "kind",
            "occurred_at",
            "request_id",
            "thread_id",
            "thread_title",
            "type"
        ]
    );
    assert!(!body.to_string().contains("echo"), "{body}");
    let again = drain_once(&engine, sender.as_ref(), "env-1").await.unwrap();
    assert_eq!(again, Pass::default());
    assert_eq!(sender.sent().len(), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn failed_sends_back_off_1_5_30_then_300_seconds() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    turn(&engine, "t1", "done").await;
    let sender = FakeSender::answering(vec![retry(), retry(), retry(), retry(), retry()]);
    let mut waits = vec![];
    for _ in 0..5 {
        let now = engine.now_millis();
        let pass = drain_once(&engine, sender.as_ref(), "env").await.unwrap();
        assert_eq!(pass.retried, 1);
        let wait = pass.next_due.unwrap() - now;
        // Not sent again before it is due.
        clock.advance(Duration::from_millis(wait - 1));
        assert_eq!(
            drain_once(&engine, sender.as_ref(), "env")
                .await
                .unwrap()
                .retried,
            0
        );
        clock.advance(Duration::from_millis(1));
        waits.push(wait / 1000);
    }
    assert_eq!(waits, [1, 5, 30, 300, 300]);
    let pass = drain_once(&engine, sender.as_ref(), "env").await.unwrap();
    assert_eq!(pass.sent, 1);
    let ids: Vec<_> = sender.sent().into_iter().map(|e| e.event_id).collect();
    assert_eq!(ids.len(), 6);
    assert!(
        ids.iter().all(|id| *id == ids[0]),
        "every retry sends the same event id"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_refused_event_is_dropped() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    turn(&engine, "t1", "done").await;
    let sender = FakeSender::answering(vec![Err(SendError::Rejected("422 conn.invalid".into()))]);
    let pass = drain_once(&engine, sender.as_ref(), "env").await.unwrap();
    assert_eq!((pass.rejected, pass.next_due), (1, None));
}

#[test]
fn rate_limits_server_errors_and_no_answer_are_retried() {
    use crate::managed::gateway::GatewayError;
    let refused = |status| GatewayError::Refused {
        status,
        code: "c".into(),
    };
    assert!(matches!(classify(refused(429)), SendError::RetryLater(_)));
    assert!(matches!(classify(refused(503)), SendError::RetryLater(_)));
    assert!(matches!(
        classify(GatewayError::Transport("timeout".into())),
        SendError::RetryLater(_)
    ));
    assert!(matches!(classify(refused(403)), SendError::Rejected(_)));
    assert!(matches!(classify(refused(422)), SendError::Rejected(_)));
}

#[tokio::test(flavor = "current_thread")]
async fn events_older_than_an_hour_are_dropped_unsent() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    turn(&engine, "t1", "done").await;
    clock.advance(MAX_AGE + Duration::from_millis(1));
    let sender = FakeSender::answering(vec![]);
    let pass = drain_once(&engine, sender.as_ref(), "env").await.unwrap();
    assert_eq!((pass.stale, pass.sent, pass.next_due), (1, 0, None));
    assert!(sender.sent().is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn the_outbox_is_sent_after_a_restart() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    turn(&engine, "t1", "done").await;
    let failing = FakeSender::answering(vec![retry()]);
    drain_once(&engine, failing.as_ref(), "env").await.unwrap();
    engine.shutdown().await;
    drop(engine);
    clock.advance(Duration::from_secs(1));
    let engine = open(&dir, &clock);
    let sender = FakeSender::answering(vec![]);
    let pass = drain_once(&engine, sender.as_ref(), "env").await.unwrap();
    assert_eq!(pass.sent, 1);
    assert_eq!(sender.sent()[0].event_id, failing.sent()[0].event_id);
}

#[tokio::test(flavor = "current_thread")]
async fn the_sender_task_wakes_on_a_new_event() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = Arc::new(open(&dir, &clock));
    let sender = FakeSender::answering(vec![]);
    let task = spawn(engine.clone(), sender.clone(), "env".into()).unwrap();
    let arrived = sender.arrived.notified();
    // Only the sender task waits on the engine's signal, as in the server.
    start_turn(&engine, "t1", "done").await;
    tokio::time::timeout(Duration::from_secs(5), arrived)
        .await
        .expect("the sender sends the new event");
    assert_eq!(sender.sent().len(), 1);
    task.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn no_sender_task_starts_when_attention_is_off() {
    let dir = TempDir::new();
    let mut config = EngineConfig::new(dir.0.join("engine.sqlite"));
    config.attention = false;
    let engine = Arc::new(SqliteEngine::open(config).unwrap());
    assert!(spawn(engine, FakeSender::answering(vec![]), "env".into()).is_none());
}
