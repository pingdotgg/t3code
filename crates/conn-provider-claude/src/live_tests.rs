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
    EnsureThreadInput, ForkThreadInput, InterruptInput, McpServer, OpenSessionInput, OpenedSession,
    Provider, ProviderEvent, ResumeThreadInput, RollbackTarget, RollbackThreadInput,
    RuntimeRequestResponse, Session, SteerInput, TurnInput, TurnMessage,
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
    json!({"instanceId": "claudeAgent", "model": "claude-haiku-5-5"})
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
            mcp_servers: vec![],
            host: None,
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
        app_thread: from_json(json!({
            "createdBy": "user", "creationSource": "web", "id": "thread-live",
            "projectId": "project-live", "title": "Live test", "providerInstanceId": "claudeAgent",
            "modelSelection": model(), "runtimeMode": mode, "interactionMode": "default",
            "branch": null, "worktreePath": null, "activeProviderThreadId": null,
            "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "thread-live"},
            "forkedFrom": null, "createdAt": "2026-11-13T00:00:00.000Z",
            "updatedAt": "2026-11-13T00:00:00.000Z", "archivedAt": null,
        }))
        .unwrap(),
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
    let config = provider().config().clone();
    let helper = crate::Helper::new(config.helper.clone(), "claudeAgent");
    let session = ClaudeSession::open(
        "provider-session-live".into(),
        "claudeAgent",
        config,
        helper,
        tx,
        vec![],
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
    let query = session.live_query();
    assert!(query.is_some());
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
        query,
        session.live_query(),
        "the same query served both turns"
    );
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_resume_in_a_new_process() {
    let scratch = Scratch::new("resume");
    // A fresh word each run, so Claude's auto-memory from an earlier run cannot answer.
    let word = random_word();
    let provider = provider();
    let (session, mut events) = open(&provider, "full-access", &scratch.cwd()).await;
    let thread = new_thread(session.as_ref(), "full-access", &scratch.cwd()).await;
    session
        .start_turn(turn(
            1,
            &thread,
            &format!("Remember the word {word}. Reply only: ok"),
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
    drop(session);
    drop(events);

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
    assert!(assistant_text(&seen).to_lowercase().contains(&word));
    session.close().await;
}

/// A word the model cannot guess: `quokka` plus four random letters.
fn random_word() -> String {
    let id = crate::ids::uuid_v4();
    let letters: String = id
        .bytes()
        .filter(u8::is_ascii_hexdigit)
        .take(4)
        .map(|b| (b'a' + b % 26) as char)
        .collect();
    format!("quokka{letters}")
}

fn last_of<'a>(events: &'a [Value], kind: &str) -> &'a Value {
    events.iter().rfind(|e| e["type"] == kind).unwrap()
}

fn thread_of(events: &[Value]) -> conn_contract::ProviderThread {
    from_json(last_of(events, "provider_thread.updated")["providerThread"].clone()).unwrap()
}

fn concrete(config: ClaudeConfig) -> (ClaudeSession, crate::Helper, mpsc::Receiver<ProviderEvent>) {
    let (tx, events) = mpsc::channel(crate::session::EVENT_CAPACITY);
    let helper = crate::Helper::new(config.helper.clone(), "claudeAgent");
    (
        ClaudeSession::open(
            "provider-session-live".into(),
            "claudeAgent",
            config,
            helper.clone(),
            tx,
            vec![],
        ),
        helper,
        events,
    )
}

async fn run_turn(
    session: &dyn Session,
    events: &mut mpsc::Receiver<ProviderEvent>,
    input: TurnInput,
) -> Vec<Value> {
    session.start_turn(input).await.unwrap();
    let seen = until(events, is_terminal).await;
    assert_eq!(
        seen.last().unwrap()["status"],
        "completed",
        "{:?}",
        seen.last()
    );
    seen
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_steer_is_taken_into_the_running_turn() {
    let scratch = Scratch::new("steer");
    let (session, _helper, mut events) = concrete(provider().config().clone());
    let thread = new_thread(&session, "full-access", &scratch.cwd()).await;
    session
        .start_turn(turn(
            1,
            &thread,
            "Run the Bash command `sleep 4; echo first`, then tell me its output.",
            "full-access",
            &scratch.cwd(),
        ))
        .await
        .unwrap();
    let seen = until(&mut events, |e| {
        e["type"] == "turn_item.updated" && e["turnItem"]["type"] == "command_execution"
    })
    .await;
    let turn_id = last_of(&seen, "provider_turn.updated")["providerTurn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    session
        .steer_turn(SteerInput {
            thread_id: "thread-live".into(),
            run_id: "run-1".into(),
            provider_thread: thread.clone(),
            provider_turn_id: turn_id.as_str().into(),
            message: TurnMessage {
                message_id: "message-steer".into(),
                text: "Also end your reply with the word banana.".into(),
                attachments: vec![],
            },
            model_selection: None,
        })
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    let steers: Vec<&str> = seen
        .iter()
        .filter(|e| e["type"] == "steer.updated")
        .map(|e| e["status"].as_str().unwrap())
        .collect();
    eprintln!("steer statuses: {steers:?}");
    assert_eq!(seen.last().unwrap()["status"], "completed");
    assert!(steers.contains(&"completed"), "{steers:?}");
    assert!(assistant_text(&seen).to_lowercase().contains("banana"));
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_idle_close_then_resume() {
    let scratch = Scratch::new("idle");
    let word = random_word();
    let config = ClaudeConfig {
        idle_timeout: Some(Duration::from_secs(3)),
        ..provider().config().clone()
    };
    let (session, helper, mut events) = concrete(config);
    let thread = new_thread(&session, "full-access", &scratch.cwd()).await;
    let prompt = format!("Remember the word {word}. Reply only: ok");
    let seen = run_turn(
        &session,
        &mut events,
        turn(1, &thread, &prompt, "full-access", &scratch.cwd()),
    )
    .await;
    let first = session.live_query().expect("a live query after the turn");
    let helper_pid = helper.pid().expect("the helper runs during the query");
    // The live test waits on the real idle timer; nothing else can signal it.
    tokio::time::sleep(Duration::from_secs(12)).await;
    assert_eq!(session.live_query(), None, "the idle query was closed");
    assert_eq!(helper.pid(), None, "the idle helper stopped");
    assert!(
        !conn_provider_support::process::pid_alive(helper_pid),
        "the helper exited"
    );
    let seen = run_turn(
        &session,
        &mut events,
        turn(
            2,
            &thread_of(&seen),
            "Which word did I ask you to remember? Reply with the word only.",
            "full-access",
            &scratch.cwd(),
        ),
    )
    .await;
    assert!(assistant_text(&seen).to_lowercase().contains(&word));
    assert_ne!(session.live_query(), Some(first), "a new query resumed it");
    session.close().await;
}

/// A tiny MCP server over Streamable HTTP (JSON answers, no SSE) with one tool,
/// `magic_number`, which answers 4217 plus `seed`. Records the requests' Authorization headers.
mod mcp {
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    pub(super) struct Server {
        pub url: String,
        pub calls: Arc<Mutex<Vec<String>>>,
        pub auth: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    pub(super) async fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let auth = Arc::new(Mutex::new(Vec::new()));
        let (c, a) = (calls.clone(), auth.clone());
        let task = tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let (c, a) = (c.clone(), a.clone());
                tokio::spawn(async move {
                    let _ = serve(sock, c, a).await;
                });
            }
        });
        Server {
            url,
            calls,
            auth,
            task,
        }
    }

    async fn serve(
        sock: tokio::net::TcpStream,
        calls: Arc<Mutex<Vec<String>>>,
        auth: Arc<Mutex<Vec<String>>>,
    ) -> std::io::Result<()> {
        let (r, mut w) = sock.into_split();
        let mut r = BufReader::new(r);
        loop {
            let mut start = String::new();
            if r.read_line(&mut start).await? == 0 {
                return Ok(());
            }
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                r.read_line(&mut h).await?;
                let h = h.trim_end();
                if h.is_empty() {
                    break;
                }
                if let Some((k, v)) = h.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    if k.eq_ignore_ascii_case("authorization") {
                        auth.lock().unwrap().push(v.trim().to_string());
                    }
                }
            }
            let mut body = vec![0u8; len];
            r.read_exact(&mut body).await?;
            let (status, payload) = if !start.starts_with("POST") {
                ("405 Method Not Allowed", String::new())
            } else {
                let msg: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                calls
                    .lock()
                    .unwrap()
                    .push(msg["method"].as_str().unwrap_or("?").to_string());
                match answer(&msg) {
                    Some(v) => ("200 OK", v.to_string()),
                    None => ("202 Accepted", String::new()),
                }
            };
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
                payload.len()
            );
            w.write_all(resp.as_bytes()).await?;
        }
    }

    fn answer(msg: &Value) -> Option<Value> {
        let id = msg.get("id")?.clone();
        let result = match msg["method"].as_str()? {
            "initialize" => json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "probe", "version": "0.1.0"}
            }),
            "tools/list" => json!({"tools": [{
                "name": "magic_number",
                "description": "Returns the magic number for a seed.",
                "inputSchema": {"type": "object", "properties": {"seed": {"type": "integer"}}, "required": ["seed"]}
            }]}),
            "tools/call" => {
                let seed = msg["params"]["arguments"]["seed"].as_i64().unwrap_or(0);
                json!({"content": [{"type": "text", "text": format!("magic number = {}", 4217 + seed)}]})
            }
            "ping" => json!({}),
            _ => {
                return Some(json!({"jsonrpc": "2.0", "id": id,
                    "error": {"code": -32601, "message": "method not found"}}));
            }
        };
        Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_mcp_server_tool_call() {
    let scratch = Scratch::new("mcp");
    let server = mcp::start().await;
    let (session, _helper, mut events) = concrete(provider().config().clone());
    session
        .set_mcp_servers(vec![McpServer {
            name: "probe".into(),
            url: server.url.clone(),
            headers: vec![("Authorization".into(), "Bearer live-test".into())],
        }])
        .await
        .unwrap();
    let thread = new_thread(&session, "full-access", &scratch.cwd()).await;
    let seen = run_turn(
        &session,
        &mut events,
        turn(
            1,
            &thread,
            "Call the magic_number MCP tool with seed 3. Reply with the number only.",
            "full-access",
            &scratch.cwd(),
        ),
    )
    .await;
    let calls = server.calls.lock().unwrap().clone();
    eprintln!("MCP requests: {calls:?}");
    assert!(calls.iter().any(|c| c == "tools/call"), "{calls:?}");
    assert!(
        server
            .auth
            .lock()
            .unwrap()
            .iter()
            .all(|a| a == "Bearer live-test")
    );
    let tool = seen
        .iter()
        .rfind(|e| e["type"] == "turn_item.updated" && e["turnItem"]["type"] == "dynamic_tool")
        .expect("a tool row");
    assert_eq!(tool["turnItem"]["toolName"], "mcp__probe__magic_number");
    assert!(assistant_text(&seen).contains("4220"));
    session.close().await;
}

/// Turn 1 sets word A, turn 2 word B; a fork (or rollback) at turn 1 must know A but not B.
async fn two_words(
    session: &dyn Session,
    events: &mut mpsc::Receiver<ProviderEvent>,
    cwd: &str,
) -> (String, String, conn_contract::ProviderThread, Vec<Value>) {
    let (a, b) = (random_word(), random_word());
    let thread = new_thread(session, "full-access", cwd).await;
    let first = run_turn(
        session,
        events,
        turn(
            1,
            &thread,
            &format!("The first secret word is {a}. Reply only: ok"),
            "full-access",
            cwd,
        ),
    )
    .await;
    let second = run_turn(
        session,
        events,
        turn(
            2,
            &thread_of(&first),
            &format!("The second secret word is {b}. Reply only: ok"),
            "full-access",
            cwd,
        ),
    )
    .await;
    let turns = [&first, &second]
        .iter()
        .map(|seen| last_of(seen, "provider_turn.updated")["providerTurn"].clone())
        .collect();
    (a, b, thread_of(&second), turns)
}

const ASK_WORDS: &str = "List every secret word I told you in this conversation, or reply none.";

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_fork_from_a_turn() {
    let scratch = Scratch::new("fork");
    let (session, _helper, mut events) = concrete(provider().config().clone());
    let (a, b, source, turns) = two_words(&session, &mut events, &scratch.cwd()).await;
    let forked = session
        .fork_thread(ForkThreadInput {
            source_provider_thread: source.clone(),
            source_provider_turns: turns
                .iter()
                .map(|t| from_json(t.clone()).unwrap())
                .collect(),
            provider_turn_id: Some(turns[0]["id"].as_str().unwrap().into()),
            target_thread_id: "thread-fork".into(),
            owner_node_id: None,
            model_selection: None,
            runtime_policy: None,
        })
        .await
        .unwrap();
    let forked_json = to_json(&forked);
    assert_ne!(
        forked_json["nativeThreadRef"]["nativeId"],
        to_json(&source)["nativeThreadRef"]["nativeId"]
    );
    let seen = run_turn(
        &session,
        &mut events,
        turn(1, &forked, ASK_WORDS, "full-access", &scratch.cwd()),
    )
    .await;
    let text = assistant_text(&seen).to_lowercase();
    eprintln!("fork answer: {text}");
    assert!(text.contains(&a), "the fork keeps turn 1");
    assert!(!text.contains(&b), "the fork stops before turn 2");
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_rollback_to_a_turn() {
    let scratch = Scratch::new("rollback");
    let (session, _helper, mut events) = concrete(provider().config().clone());
    let (a, b, thread, turns) = two_words(&session, &mut events, &scratch.cwd()).await;
    let snapshot = session
        .rollback_thread(RollbackThreadInput {
            provider_thread: thread,
            target: RollbackTarget::ProviderTurn {
                checkpoint_id: "checkpoint-1".into(),
                app_run_ordinal: 1,
                provider_turn: from_json(turns[0].clone()).unwrap(),
            },
            provider_thread_turns: turns
                .iter()
                .map(|t| from_json(t.clone()).unwrap())
                .collect(),
        })
        .await
        .unwrap();
    let seen = run_turn(
        &session,
        &mut events,
        turn(
            3,
            &snapshot.provider_thread,
            ASK_WORDS,
            "full-access",
            &scratch.cwd(),
        ),
    )
    .await;
    let text = assistant_text(&seen).to_lowercase();
    eprintln!("rollback answer: {text}");
    assert!(text.contains(&a), "turn 1 stays");
    assert!(!text.contains(&b), "turn 2 is gone");
    // The head is cleared once a turn ran past it, so a later relaunch does not rewind again.
    assert!(to_json(&thread_of(&seen))["nativeConversationHeadRef"].is_null());
    session.close().await;
}

/// A subagent that runs Bash under Full access. Prints every approval Claude forwards, to see
/// whether a subagent's tool call reaches `canUseTool` under bypass (answered with accept).
#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_subagent_runs_bash() {
    let scratch = Scratch::new("subagent");
    let (session, _helper, mut events) = concrete(provider().config().clone());
    let thread = new_thread(&session, "full-access", &scratch.cwd()).await;
    session
        .start_turn(turn(
            1,
            &thread,
            "Use the Agent tool once, in the foreground (run_in_background false), to start a general-purpose subagent. Tell it to run the Bash command `echo subagent-ok` and report the output. Wait for its result, then reply with that output only.",
            "full-access",
            &scratch.cwd(),
        ))
        .await
        .unwrap();
    let mut seen = Vec::new();
    loop {
        let batch = until(&mut events, |e| {
            is_terminal(e)
                || (e["type"] == "runtime_request.updated"
                    && e["runtimeRequest"]["status"] == "pending")
        })
        .await;
        let last = batch.last().unwrap().clone();
        seen.extend(batch);
        if is_terminal(&last) {
            break;
        }
        eprintln!(
            "approval forwarded under full access: {}",
            last["runtimeRequest"]
        );
        session
            .respond_to_runtime_request(RuntimeRequestResponse {
                request_id: last["runtimeRequest"]["id"].as_str().unwrap().into(),
                decision: Some(from_json(json!("accept")).unwrap()),
                feedback: None,
                answers: None,
            })
            .await
            .unwrap();
    }
    assert_eq!(seen.last().unwrap()["status"], "completed");
    assert!(
        seen.iter().any(|e| e["type"] == "subagent.updated"),
        "a subagent ran"
    );
    let bash_rows: Vec<&Value> = seen
        .iter()
        .filter(|e| {
            e["type"] == "turn_item.updated" && e["turnItem"]["type"] == "command_execution"
        })
        .collect();
    eprintln!(
        "command rows: {}",
        bash_rows
            .iter()
            .map(|e| format!("{} {}", e["turnItem"]["status"], e["turnItem"]["threadId"]))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let text = assistant_text(&seen).to_lowercase();
    eprintln!("subagent answer: {text}");
    assert!(text.contains("subagent-ok"));
    session.close().await;
}

/// An image attachment, read from the attachments directory as T3 stores it.
#[tokio::test(flavor = "current_thread")]
#[ignore = "runs the real claude CLI"]
async fn live_image_turn() {
    let scratch = Scratch::new("image");
    let attachments = scratch.0.join("attachments");
    std::fs::create_dir_all(&attachments).unwrap();
    let png = crate::testdata::cli("e15_image")
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|r| {
            r["msg"]["message"]["content"]
                .as_array()?
                .iter()
                .find(|b| b["type"] == "image")
                .and_then(|b| b["source"]["data"].as_str().map(str::to_string))
        })
        .unwrap();
    let bytes = conn_support::base64::decode(&png).unwrap();
    std::fs::write(attachments.join("attach-1.png"), &bytes).unwrap();
    let config = ClaudeConfig {
        attachments_dir: Some(attachments),
        ..provider().config().clone()
    };
    let (session, _helper, mut events) = concrete(config);
    let thread = new_thread(&session, "full-access", &scratch.cwd()).await;
    let mut input = turn(
        1,
        &thread,
        "What colour is this image? One word.",
        "full-access",
        &scratch.cwd(),
    );
    input.message.attachments = vec![
        from_json(json!({"type": "image", "id": "attach-1", "name": "red.png",
            "mimeType": "image/png", "sizeBytes": bytes.len()}))
        .unwrap(),
    ];
    let seen = run_turn(&session, &mut events, input).await;
    let text = assistant_text(&seen).to_lowercase();
    eprintln!("image answer: {text}");
    assert!(text.contains("red"));
    session.close().await;
}
