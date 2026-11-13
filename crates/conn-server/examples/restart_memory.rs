//! Live check (Claude Haiku, two short turns): the agent keeps its context over a Conn Server
//! restart. Each phase is its own process on the same state folder, so nothing survives in
//! memory between them.
//!
//! ```sh
//! cargo run -p conn-server --example restart_memory -- tell /tmp/conn-restart
//! cargo run -p conn-server --example restart_memory -- ask  /tmp/conn-restart
//! ```

use std::{sync::Arc, time::Duration};

use conn_contract::{from_json, to_json};
use conn_engine::{Engine, EngineConfig, ProjectConfig, SqliteEngine};
use conn_provider_claude::{ClaudeConfig, ClaudeProvider};
use serde_json::{Value, json};

const THREAD: &str = "restart-memory";

async fn answer(engine: &SqliteEngine, run: &str) -> Value {
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": THREAD})).unwrap())
        .await
        .unwrap();
    loop {
        let item = tokio::time::timeout(Duration::from_secs(120), stream.recv())
            .await
            .expect("the turn ends within two minutes")
            .expect("stream open")
            .map(|item| to_json(&item))
            .unwrap_or_else(|e| panic!("{}", to_json(&e)));
        let runs = item["projection"]["runs"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![item["event"]["payload"].clone()]);
        let ended = runs.iter().any(|r| {
            r["id"] == run
                && matches!(
                    r["status"].as_str(),
                    Some("completed" | "failed" | "interrupted")
                )
        });
        if ended && (item["kind"] == "snapshot" || item["event"]["type"] == "run.updated") {
            return engine.get_thread_projection(THREAD.into()).await.unwrap();
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let phase = args.next().expect("tell or ask");
    let dir = std::path::PathBuf::from(args.next().expect("state folder"));
    std::fs::create_dir_all(&dir).unwrap();
    let mut config = EngineConfig::new(dir.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Restart".into(),
        workspace_root: dir.to_string_lossy().into_owned(),
    }];
    config.providers = vec![Arc::new(ClaudeProvider::new(
        "claudeAgent".into(),
        ClaudeConfig::default(),
    ))];
    let engine = SqliteEngine::open(config).unwrap();
    let project_id = SqliteEngine::project_id_for(&dir.to_string_lossy());
    let model = json!({"instanceId": "claudeAgent", "model": "haiku"});

    let (text, run) = match phase.as_str() {
        "tell" => {
            engine
                .launch_thread(json!({
                    "commandId": "tell", "threadId": THREAD, "projectId": project_id,
                    "title": "Restart memory", "modelSelection": model,
                    "runtimeMode": "full-access", "interactionMode": "default",
                    "workspaceStrategy": {"type": "root"},
                    "initialMessage": {"messageId": "message:tell", "attachments": [],
                        "text": "Remember this word for later: PERIWINKLE. Reply with just OK."},
                }))
                .await
                .unwrap();
            ("tell", format!("run:{THREAD}:1"))
        }
        "ask" => {
            engine
                .dispatch(from_json(json!({
                    "type": "message.dispatch", "commandId": "ask", "threadId": THREAD,
                    "messageId": "message:ask", "attachments": [],
                    "text": "What was the word I asked you to remember? Reply with just the word.",
                    "dispatchMode": {"type": "start_immediately"},
                    "createdBy": "user", "creationSource": "web",
                }))
                .unwrap())
                .await
                .unwrap();
            ("ask", format!("run:{THREAD}:2"))
        }
        other => panic!("unknown phase {other}"),
    };
    let projection = answer(&engine, &run).await;
    let reply = projection["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "assistant" && m["runId"] == run.as_str())
        .map(|m| m["text"].clone())
        .unwrap_or(Value::Null);
    let pt = &projection["providerThreads"][0];
    println!(
        "{text}: run {run} {} | reply {reply} | native session {}",
        projection["runs"].as_array().unwrap().last().unwrap()["status"],
        pt["nativeThreadRef"]["nativeId"]
    );
}
