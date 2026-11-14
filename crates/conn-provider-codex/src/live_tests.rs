//! Live tests against the installed `codex` CLI and the user's own Codex sign-in. They spend
//! real model calls on the cheapest model, so they are `#[ignore]`:
//!
//! ```sh
//! cargo test -p conn-provider-codex live_ -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Each test works in a fresh temporary folder and deletes it afterwards. Codex keeps its
//! usual session log under `$CODEX_HOME/sessions`; no setting or credential is changed.

use std::time::Duration;

use conn_contract::{ProviderThread, from_json, to_json};
use conn_provider::{
    EnsureThreadInput, InterruptInput, OpenSessionInput, OpenedSession, Provider, ProviderEvent,
    RuntimePolicy, RuntimeRequestResponse, Session, TurnInput, TurnMessage,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{CodexConfig, CodexProvider};

const MODEL: &str = "gpt-6-luna";
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

struct Workspace(std::path::PathBuf);

impl Workspace {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("conn-codex-live-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&path).expect("create the test folder");
        Self(path)
    }
    fn cwd(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn policy(mode: &str, cwd: &str) -> RuntimePolicy {
    from_json(json!({"runtimeMode": mode, "interactionMode": "default", "cwd": cwd}))
        .expect("policy decodes")
}

fn selection() -> conn_contract::ModelSelection {
    from_json(json!({"instanceId": "codex", "model": MODEL})).expect("selection decodes")
}

fn turn(thread: &ProviderThread, n: u32, mode: &str, cwd: &str, text: &str) -> TurnInput {
    TurnInput {
        native_thread_has_turns: None,
        restart_continuation_of_run_id: None,
        app_context: vec![],
        app_thread: from_json(json!({
            "createdBy": "user", "creationSource": "web", "id": "live-thread", "projectId": "p",
            "title": "live", "providerInstanceId": "codex", "modelSelection": to_json(&selection()),
            "runtimeMode": mode, "interactionMode": "default", "branch": null, "worktreePath": null,
            "activeProviderThreadId": null,
            "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "live-thread"},
            "forkedFrom": null, "createdAt": "x", "updatedAt": "x", "archivedAt": null,
        }))
        .expect("app thread decodes"),
        thread_id: "live-thread".into(),
        run_id: format!("run-{n}").as_str().into(),
        run_ordinal: n,
        provider_turn_ordinal: n,
        attempt_id: format!("attempt-{n}").as_str().into(),
        root_node_id: format!("node-{n}").as_str().into(),
        provider_thread: thread.clone(),
        message: TurnMessage {
            created_by: conn_contract::OrchestrationV2Actor::User,
            creation_source: conn_contract::OrchestrationV2CreationSource::Web,
            scheduled_task_id: None,
            sender_thread_id: None,
            message_id: format!("message-{n}").as_str().into(),
            text: text.into(),
            attachments: vec![],
        },
        model_selection: selection(),
        runtime_policy: policy(mode, cwd),
    }
}

async fn open(
    mode: &str,
    cwd: &str,
) -> (
    CodexProvider,
    Box<dyn Session>,
    mpsc::Receiver<ProviderEvent>,
    ProviderThread,
) {
    let provider = CodexProvider::detect("codex".into(), CodexConfig::default())
        .expect("the codex CLI is installed");
    let OpenedSession {
        session, events, ..
    } = provider
        .open_session(OpenSessionInput {
            thread_id: "live-thread".into(),
            provider_session_id: "live-session".into(),
            model_selection: selection(),
            runtime_policy: policy(mode, cwd),
            resume_from_session: None,
            mcp_servers: vec![],
            host: None,
        })
        .await
        .expect("session opens");
    let thread = session
        .ensure_thread(EnsureThreadInput {
            thread_id: "live-thread".into(),
            title: None,
            model_selection: selection(),
            runtime_policy: policy(mode, cwd),
            existing_provider_thread: None,
        })
        .await
        .expect("thread/start succeeds");
    (provider, session, events, thread)
}

/// Events until `stop` returns true, or the turn timeout.
async fn until(
    events: &mut mpsc::Receiver<ProviderEvent>,
    stop: impl Fn(&Value) -> bool,
) -> Vec<Value> {
    let mut seen = Vec::new();
    let read = async {
        while let Some(event) = events.recv().await {
            let value = serde_json::to_value(event).expect("events serialize");
            let done = stop(&value);
            seen.push(value);
            if done {
                return;
            }
        }
    };
    let finished = tokio::time::timeout(TURN_TIMEOUT, read).await.is_ok();
    assert!(
        finished,
        "no matching event within {TURN_TIMEOUT:?}; saw {} events",
        seen.len()
    );
    seen
}

fn terminal(seen: &[Value]) -> &Value {
    seen.last().expect("at least the terminal event")
}

fn rss_kib(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "spends a real Codex turn"]
async fn live_codex_turn() {
    let dir = Workspace::new("turn");
    let (provider, session, mut events, thread) = open("full-access", &dir.cwd()).await;
    session
        .start_turn(turn(
            &thread,
            1,
            "full-access",
            &dir.cwd(),
            "Reply with exactly: pong",
        ))
        .await
        .expect("turn/start succeeds");
    let seen = until(&mut events, |e| e["type"] == "turn.terminal").await;
    let text: Vec<&str> = seen
        .iter()
        .filter(|e| e["type"] == "message.updated")
        .filter_map(|e| e["message"]["text"].as_str())
        .collect();
    eprintln!("terminal: {}\nassistant: {text:?}", terminal(&seen));
    if let Some(pid) = provider.app_server_pid() {
        eprintln!(
            "idle codex app-server pid {pid}: rss {:?} KiB",
            rss_kib(pid)
        );
    }
    assert_eq!(
        terminal(&seen)["status"],
        "completed",
        "{}",
        terminal(&seen)
    );
    assert!(text.iter().any(|t| t.contains("pong")), "{text:?}");
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "spends real Codex turns"]
async fn live_codex_approval_then_interrupt() {
    let dir = Workspace::new("approval");
    let mode = "approval-required";
    let (_provider, session, mut events, thread) = open(mode, &dir.cwd()).await;

    session
        .start_turn(turn(
            &thread,
            1,
            mode,
            &dir.cwd(),
            "Run this shell command and nothing else: touch approved.txt",
        ))
        .await
        .expect("turn/start succeeds");
    let seen = until(&mut events, |e| {
        e["type"] == "turn.terminal"
            || (e["type"] == "runtime_request.updated"
                && e["runtimeRequest"]["status"] == "pending")
    })
    .await;
    let last = terminal(&seen);
    assert_eq!(
        last["type"], "runtime_request.updated",
        "no approval was asked: {last}"
    );
    eprintln!("approval: {}", last["runtimeRequest"]["kind"]);
    session
        .respond_to_runtime_request(RuntimeRequestResponse {
            request_id: from_json(last["runtimeRequest"]["id"].clone()).expect("request id"),
            decision: Some(from_json(json!("accept")).expect("decision")),
            feedback: None,
            answers: None,
        })
        .await
        .expect("the reply is written");
    let seen = until(&mut events, |e| e["type"] == "turn.terminal").await;
    eprintln!("first terminal: {}", terminal(&seen));
    assert_eq!(terminal(&seen)["status"], "completed");
    assert!(
        dir.0.join("approved.txt").exists(),
        "the approved command ran"
    );

    session
        .start_turn(turn(
            &thread,
            2,
            "full-access",
            &dir.cwd(),
            "Run this shell command and wait for it: sleep 60",
        ))
        .await
        .expect("turn/start succeeds");
    let seen = until(&mut events, |e| {
        e["type"] == "turn.terminal"
            || (e["type"] == "turn_item.updated" && e["turnItem"]["type"] == "command_execution")
    })
    .await;
    let provider_turn = seen
        .iter()
        .find_map(|e| e["providerTurn"]["id"].as_str())
        .expect("the turn registered")
        .to_owned();
    assert_ne!(
        terminal(&seen)["type"],
        "turn.terminal",
        "the turn ended before the command"
    );
    session
        .interrupt_turn(InterruptInput {
            provider_thread: thread.clone(),
            provider_turn_id: provider_turn.as_str().into(),
        })
        .await
        .expect("interrupt succeeds");
    let seen = until(&mut events, |e| e["type"] == "turn.terminal").await;
    eprintln!("second terminal: {}", terminal(&seen));
    assert_eq!(terminal(&seen)["status"], "interrupted");
    session.close().await;
}
