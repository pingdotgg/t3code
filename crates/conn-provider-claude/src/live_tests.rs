//! Live tests against the real `claude` CLI. Ignored by default; they spend money.
//!
//! ```sh
//! cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1
//! ```
//!
//! Haiku, tiny prompts, an empty temporary working directory. Each test removes its folder and
//! the session folder the CLI wrote under `~/.claude/projects`. Set `CLAUDE_BIN` to pick the
//! executable.

use std::{path::PathBuf, time::Duration};

use conn_contract::{from_json, to_json};
use conn_provider::{
    EnsureThreadInput, InterruptInput, OpenSessionInput, OpenedSession, Provider, ProviderEvent,
    ResumeThreadInput, RuntimeRequestResponse, Session, TurnInput, TurnMessage,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{ClaudeConfig, ClaudeProvider, ClaudeSession};

const TURN_TIMEOUT: Duration = Duration::from_secs(180);

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("conn-claude-live-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(std::fs::canonicalize(&dir).unwrap())
    }

    fn cwd(&self) -> String {
        self.0.to_str().unwrap().to_string()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        // The CLI keeps sessions in ~/.claude/projects/<cwd with every non-alphanumeric as '-'>.
        let slug: String = self
            .cwd()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        if let Some(home) = std::env::var_os("HOME") {
            let projects = PathBuf::from(home).join(".claude/projects");
            let folder = projects.join(&slug);
            if slug.contains("conn-claude-live-") && folder.starts_with(&projects) {
                let _ = std::fs::remove_dir_all(folder);
            }
        }
    }
}

/// A throwaway `CLAUDE_CONFIG_DIR` (the instance's `homePath`) with only the user's
/// `apiKeyHelper`: no permission rules, no hooks. Removed on drop with its sessions.
struct IsolatedConfig(PathBuf);

impl IsolatedConfig {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("conn-claude-live-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
        let user: Value = std::fs::read_to_string(home.join(".claude/settings.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let mut settings = json!({});
        if let Some(helper) = user.get("apiKeyHelper") {
            settings["apiKeyHelper"] = helper.clone();
        }
        std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
        Self(dir)
    }
}

impl Drop for IsolatedConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn provider() -> ClaudeProvider {
    let binary = std::env::var_os("CLAUDE_BIN").map_or_else(|| "claude".into(), PathBuf::from);
    ClaudeProvider::new(
        "claudeAgent".into(),
        ClaudeConfig {
            binary,
            ..ClaudeConfig::default()
        },
    )
}

fn policy(mode: &str, cwd: &str) -> Value {
    json!({"runtimeMode": mode, "interactionMode": "default", "cwd": cwd})
}

fn model() -> Value {
    json!({"instanceId": "claudeAgent", "model": "haiku"})
}

async fn open(
    provider: &ClaudeProvider,
    mode: &str,
    cwd: &str,
) -> (Box<dyn Session>, mpsc::Receiver<ProviderEvent>) {
    let OpenedSession { session, events } = provider
        .open_session(OpenSessionInput {
            thread_id: "thread-live".into(),
            provider_session_id: "provider-session-live".into(),
            model_selection: from_json(model()).unwrap(),
            runtime_policy: from_json(policy(mode, cwd)).unwrap(),
            resume_from_session: None,
        })
        .await
        .unwrap();
    (session, events)
}

fn turn(
    n: u32,
    thread: &conn_contract::ProviderThread,
    text: &str,
    mode: &str,
    cwd: &str,
) -> TurnInput {
    TurnInput {
        app_thread: from_json(json!({"id": "thread-live", "title": "Live test"})).unwrap(),
        thread_id: "thread-live".into(),
        run_id: format!("run-{n}").as_str().into(),
        run_ordinal: n,
        provider_turn_ordinal: n,
        attempt_id: format!("attempt-{n}").as_str().into(),
        root_node_id: format!("node-{n}").as_str().into(),
        provider_thread: thread.clone(),
        message: TurnMessage {
            message_id: format!("message-{n}").as_str().into(),
            text: text.into(),
            attachments: vec![],
        },
        model_selection: from_json(model()).unwrap(),
        runtime_policy: from_json(policy(mode, cwd)).unwrap(),
    }
}

/// Collects events until `stop` matches one. Returns them all, the matching one last.
async fn until(
    events: &mut mpsc::Receiver<ProviderEvent>,
    stop: impl Fn(&Value) -> bool,
) -> Vec<Value> {
    let mut seen = Vec::new();
    loop {
        let event = tokio::time::timeout(TURN_TIMEOUT, events.recv())
            .await
            .expect("timed out waiting for a provider event")
            .expect("event channel closed");
        let value = serde_json::to_value(&event).unwrap();
        let done = stop(&value);
        seen.push(value);
        if done {
            return seen;
        }
    }
}

fn is_terminal(e: &Value) -> bool {
    e["type"] == "turn.terminal"
}

fn assistant_text(events: &[Value]) -> String {
    events
        .iter()
        .filter(|e| e["type"] == "message.updated")
        .filter_map(|e| e["message"]["text"].as_str())
        .next_back()
        .unwrap_or_default()
        .to_string()
}

async fn new_thread(session: &dyn Session, mode: &str, cwd: &str) -> conn_contract::ProviderThread {
    session
        .ensure_thread(EnsureThreadInput {
            thread_id: "thread-live".into(),
            title: None,
            model_selection: from_json(model()).unwrap(),
            runtime_policy: from_json(policy(mode, cwd)).unwrap(),
            existing_provider_thread: None,
        })
        .await
        .unwrap()
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_one_turn() {
    let scratch = Scratch::new("turn");
    let provider = provider();
    let (session, mut events) = open(&provider, "full-access", &scratch.cwd()).await;
    let first = events.recv().await.unwrap();
    assert!(matches!(
        first,
        ProviderEvent::ProviderSessionUpdated { .. }
    ));
    let thread = new_thread(session.as_ref(), "full-access", &scratch.cwd()).await;
    session
        .start_turn(turn(
            1,
            &thread,
            "Reply with exactly: pong",
            "full-access",
            &scratch.cwd(),
        ))
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    let terminal = seen.last().unwrap();
    assert_eq!(terminal["status"], "completed", "{terminal}");
    assert!(assistant_text(&seen).to_lowercase().contains("pong"));
    eprintln!(
        "live_one_turn: {} events, types {:?}",
        seen.len(),
        seen.iter()
            .map(|e| e["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    );
    session.close().await;
    assert!(events.recv().await.is_none(), "channel closes after close");
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_permission_round_trip() {
    let scratch = Scratch::new("perm");
    // The user's own allow rules would answer the prompt before T3 sees it.
    let config = IsolatedConfig::new();
    let provider = ClaudeProvider::new(
        "claudeAgent".into(),
        ClaudeConfig {
            home_path: Some(config.0.clone()),
            ..provider().config().clone()
        },
    );
    let mode = "approval-required";
    let (session, mut events) = open(&provider, mode, &scratch.cwd()).await;
    let thread = new_thread(session.as_ref(), mode, &scratch.cwd()).await;
    session
        .start_turn(turn(
            1,
            &thread,
            "Use the Bash tool once to run `touch allowed.txt`. Then reply: done",
            mode,
            &scratch.cwd(),
        ))
        .await
        .unwrap();
    let seen = until(&mut events, |e| {
        e["type"] == "runtime_request.updated" || is_terminal(e)
    })
    .await;
    let request = seen.last().unwrap();
    assert_eq!(
        request["type"], "runtime_request.updated",
        "no approval asked"
    );
    assert_eq!(request["runtimeRequest"]["kind"], "command");
    let request_id = request["runtimeRequest"]["id"].as_str().unwrap();
    session
        .respond_to_runtime_request(RuntimeRequestResponse {
            request_id: request_id.into(),
            decision: Some(from_json(json!("accept")).unwrap()),
            feedback: None,
            answers: None,
        })
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "completed");
    assert!(
        scratch.0.join("allowed.txt").exists(),
        "the approved command ran"
    );
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_interrupt_then_continue() {
    let scratch = Scratch::new("interrupt");
    // The concrete session, to check which process served each turn.
    let (tx, mut events) = mpsc::channel(crate::session::EVENT_CAPACITY);
    let session = ClaudeSession::open(
        "provider-session-live".into(),
        provider().config().clone(),
        tx,
    );
    let thread = new_thread(&session, "full-access", &scratch.cwd()).await;
    session
        .start_turn(turn(
            1,
            &thread,
            "Write the numbers 1 to 300 as English words, one per line, no tools, no other text.",
            "full-access",
            &scratch.cwd(),
        ))
        .await
        .unwrap();
    // Wait for usage of the first API response: the model is generating.
    let seen = until(&mut events, |e| {
        e["type"] == "provider_turn.updated" && e["providerTurn"]["tokenUsage"].is_object()
    })
    .await;
    let turn_id = seen.last().unwrap()["providerTurn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    session
        .interrupt_turn(InterruptInput {
            provider_thread: thread.clone(),
            provider_turn_id: turn_id.as_str().into(),
        })
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "interrupted");
    let thread: conn_contract::ProviderThread = from_json(
        seen.iter()
            .rfind(|e| e["type"] == "provider_thread.updated")
            .unwrap()["providerThread"]
            .clone(),
    )
    .unwrap();
    let pid = session.live_pid();
    assert!(pid.is_some());
    session
        .start_turn(turn(
            2,
            &thread,
            "Reply only: alive",
            "full-access",
            &scratch.cwd(),
        ))
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "completed");
    assert!(assistant_text(&seen).to_lowercase().contains("alive"));
    assert_eq!(
        pid,
        session.live_pid(),
        "the same process served both turns"
    );
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_resume_in_a_new_process() {
    let scratch = Scratch::new("resume");
    let provider = provider();
    let (session, mut events) = open(&provider, "full-access", &scratch.cwd()).await;
    let thread = new_thread(session.as_ref(), "full-access", &scratch.cwd()).await;
    session
        .start_turn(turn(
            1,
            &thread,
            "Remember the word kumquat. Reply only: ok",
            "full-access",
            &scratch.cwd(),
        ))
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "completed");
    let thread_value = seen
        .iter()
        .rfind(|e| e["type"] == "provider_thread.updated")
        .unwrap()["providerThread"]
        .clone();
    session.close().await;

    // A new session, as after a server restart: resume the thread by its native id.
    let (session, mut events) = open(&provider, "full-access", &scratch.cwd()).await;
    let resumed = session
        .resume_thread(ResumeThreadInput {
            provider_thread: from_json(thread_value).unwrap(),
            thread_id: Some("thread-live".into()),
            model_selection: None,
            runtime_policy: None,
        })
        .await
        .unwrap();
    assert_eq!(
        to_json(&resumed)["providerSessionId"],
        "provider-session-live"
    );
    session
        .start_turn(turn(
            2,
            &resumed,
            "Which word did I ask you to remember? Reply with the word only.",
            "full-access",
            &scratch.cwd(),
        ))
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "completed");
    assert!(assistant_text(&seen).to_lowercase().contains("kumquat"));
    session.close().await;
}
