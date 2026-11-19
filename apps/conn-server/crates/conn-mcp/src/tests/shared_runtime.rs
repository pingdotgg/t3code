//! A worktree handoff on Codex's shared `app-server`: the process outlives the caller's
//! session, so its MCP credential stays valid and the continuation reuses it, as T3's
//! `ProviderSessionManager` keeps and reuses a credential across a shared-session handoff.
//! The real Codex provider runs against a scripted app-server; no CLI or model runs.

use std::sync::OnceLock;

use conn_engine::{AgentSession, AgentTools};
use conn_provider_codex::{CodexConfig, CodexProvider};

use super::*;

/// Issues and revokes real `/mcp` credentials, as the server's host does.
#[derive(Default)]
struct CredentialHost(OnceLock<Arc<McpService>>);

fn request(session: &AgentSession) -> ThreadCredentialRequest {
    ThreadCredentialRequest {
        thread_id: session.thread_id.clone(),
        provider_instance_id: session.provider_instance_id.clone(),
        subagent: session.subagent,
        preview: true,
    }
}

impl conn_engine::EngineHost for CredentialHost {
    fn agent_tools(&self, session: AgentSession) -> Option<AgentTools> {
        let entry = self.0.get()?.issue_thread_credential(request(&session));
        Some(AgentTools {
            servers: vec![conn_provider::McpServer {
                name: crate::SERVER_NAME.to_owned(),
                url: entry.url,
                headers: vec![("Authorization".to_owned(), entry.authorization)],
            }],
            key: entry.provider_session_id,
        })
    }

    fn agent_tools_fit(&self, session: &AgentSession, key: &str) -> bool {
        self.0
            .get()
            .is_some_and(|mcp| mcp.thread_credential_fits(key, &request(session)))
    }

    fn session_closed(&self, key: &str) {
        if let Some(mcp) = self.0.get() {
            mcp.revoke_provider_session(key);
        }
    }
}

/// An app-server that numbers its threads, keeps `hang` turns open, completes other turns at
/// once, and logs every line it reads to `<script>.stdin`.
const APP_SERVER: &str = r#"#!/bin/sh
n=0
emit() { printf '%s\n' "$1"; }
field() { printf '%s' "$line" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$0.stdin"
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) emit "{\"id\":$id,\"result\":{\"userAgent\":\"t3code_desktop/0.167.0 (x)\"}}" ;;
    *'"method":"model/list"'*) emit "{\"id\":$id,\"result\":{\"data\":[],\"nextCursor\":null}}" ;;
    *'"method":"mcpServerStatus/list"'*) emit "{\"id\":$id,\"result\":{\"data\":[]}}" ;;
    *'"method":"config/read"'*) emit "{\"id\":$id,\"result\":{\"config\":{}}}" ;;
    *'"method":"thread/start"'*)
      n=$((n+1))
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"th$n\",\"createdAt\":1,\"updatedAt\":2}}}" ;;
    *'"method":"thread/resume"'*)
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"$(field threadId)\"}}}" ;;
    *'"method":"turn/start"'*'"text":"hang"'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"hang$id\",\"startedAt\":null}}}" ;;
    *'"method":"turn/start"'*)
      th=$(field threadId)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu$id\",\"startedAt\":null}}}"
      emit "{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"$th\",\"turn\":{\"id\":\"tu$id\",\"status\":\"completed\",\"completedAt\":3}}}" ;;
    *'"method":"turn/interrupt"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit "{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"$(field threadId)\",\"turn\":{\"id\":\"$(field turnId)\",\"status\":\"interrupted\",\"completedAt\":3}}}" ;;
    '{"id":'*'"method":'*) emit "{\"id\":$id,\"result\":{}}" ;;
  esac
done
"#;

/// The `t3-code` bearer tokens the app-server got, one per `thread/start` or
/// `thread/resume` line, in order.
fn tokens(log: &std::path::Path, method: &str) -> Vec<String> {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    text.lines()
        .filter(|line| line.contains(&format!("\"method\":\"{method}\"")))
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            let config = &value["params"]["config"];
            let auth = config["mcp_servers.t3-code"]["http_headers"]["Authorization"].as_str()?;
            Some(auth.strip_prefix("Bearer ")?.to_owned())
        })
        .collect()
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

fn agent(f: &Fixture, token: &str) -> Option<Caller> {
    f.service.resolve_thread_token(token).map(Caller::Thread)
}

#[tokio::test(flavor = "current_thread")]
async fn a_handoff_on_a_shared_codex_process_keeps_and_reuses_the_credential() {
    let dir = std::env::temp_dir().join(format!("conn-codex-app-server-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("codex");
    conn_support::test_util::executable(&script, APP_SERVER).unwrap();
    let log = dir.join("codex.stdin");
    let codex = CodexProvider::new(
        "codex".into(),
        CodexConfig {
            binary: script,
            home_path: Some(dir.clone()),
            status_probe: false,
            ..CodexConfig::default()
        },
    );
    let host = Arc::new(CredentialHost::default());
    let f = fixture_with_provider("shared-codex", Some(host.clone()), Arc::new(codex));
    host.0.set(f.service.clone()).ok().unwrap();
    super::threads_handoff::git_project(&f).await;

    let mut c = Client::open(&f.service, client(true)).await;
    let mut launch = async |title: &str| {
        c.ok(
            "t3_thread_launch",
            json!({
                "projectId": project_id(), "title": title, "message": "hang",
                "modelSelection": {"instanceId": "codex", "model": "gpt-6-luna"},
                "runtimeMode": "auto", "clientRequestId": title,
            }),
        )
        .await["threadId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let one = launch("One").await;
    until("the first thread to start", || {
        tokens(&log, "thread/start").len() == 1
    })
    .await;
    launch("Two").await;
    until("the second thread to start on the same app-server", || {
        tokens(&log, "thread/start").len() == 2
    })
    .await;
    let started = tokens(&log, "thread/start");
    let (first, second) = (started[0].clone(), started[1].clone());
    assert_ne!(first, second);

    let caller = agent(&f, &first).expect("the first thread's credential works");
    let mut moving = Client::open(&f.service, caller).await;
    let moved = moving
        .ok(
            "t3_worktree_handoff",
            json!({"branch": "feature/shared", "startFromOrigin": false, "continuationPrompt": "go on"}),
        )
        .await;
    assert_eq!(moved["continuation"]["status"], "scheduled");
    let ended = c
        .ok(
            "t3_thread_wait",
            json!({"threadId": one, "timeoutMs": 10000}),
        )
        .await;
    assert_eq!(
        ended["status"], "completed",
        "the continuation ran: {ended}"
    );
    let text = std::fs::read_to_string(&log).unwrap();
    assert!(
        text.contains("\"method\":\"thread/unsubscribe\""),
        "the old session left the shared process: {text}"
    );
    assert_eq!(
        text.matches("\"method\":\"initialize\"").count(),
        1,
        "one app-server"
    );

    // The continuation's session reuses the credential the live process holds.
    let resumed = tokens(&log, "thread/resume");
    assert_eq!(resumed, std::slice::from_ref(&first), "{text}");
    let caller = agent(&f, &first).expect("the credential survives the handoff");
    let mut continuation = Client::open(&f.service, caller).await;
    let status = continuation.ok("t3_worktree_status", json!({})).await;
    assert_eq!(status["worktreePath"], moved["worktreePath"]);
    assert_eq!(status["branch"], "feature/shared");
    assert!(
        agent(&f, &second).is_some(),
        "the other thread keeps its own"
    );

    // Deleting the thread closes its session; the shared process still runs, yet T3 revokes
    // a deleted thread's credentials (`revokeMcpCredential`).
    dispatch(
        &f,
        json!({"type": "thread.delete", "commandId": "delete-one", "threadId": one}),
    )
    .await;
    until("the deleted thread's credential to go", || {
        agent(&f, &first).is_none()
    })
    .await;
    assert!(agent(&f, &second).is_some());
    let _ = std::fs::remove_dir_all(&dir);
}
