//! Records what a Conn client receives for one new thread and one turn, for
//! `tools/client-check.mjs`. Runs the engine with the scripted fake provider.
//!
//! `cargo run -p conn-engine --features fake-provider --example export_turn -- <out.json>`
//!
//! The calls follow the client: the shell subscribes with `requestCompletionMarker`; a new
//! thread starts with `orchestration.launchThread`; the thread view loads the HTTP snapshot and
//! subscribes after its sequence with `requestCompletionMarker` and `acceptDedupedBodies`.

use std::{sync::Arc, time::Duration};

use conn_contract::{from_json, to_json};
use conn_engine::{
    Engine, EngineConfig, ProjectConfig, SqliteEngine, Subscription, fake::FakeProvider,
};
use serde_json::{Value, json};
use tokio::time::timeout;

const ROOT: &str = "/tmp/conn-engine-export-project";

fn open(path: &std::path::Path) -> SqliteEngine {
    let mut config = EngineConfig::new(path);
    config.projects = vec![ProjectConfig {
        title: "Export".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    SqliteEngine::open(config).expect("open engine")
}

/// Reads items until `done` holds for one, or the stream is quiet for 300 ms.
async fn read<T: serde::Serialize, E: serde::Serialize>(
    stream: &mut Subscription<T, E>,
    out: &mut Vec<Value>,
    done: impl Fn(&Value) -> bool,
) {
    while let Ok(Some(item)) = timeout(Duration::from_millis(300), stream.recv()).await {
        let item = match item {
            Ok(item) => to_json(&item),
            Err(e) => panic!("stream failed: {}", to_json(&e)),
        };
        let stop = done(&item);
        out.push(item);
        if stop {
            return;
        }
    }
}

fn run_ended(item: &Value) -> bool {
    item["event"]["type"] == "run.updated"
        && matches!(
            item["event"]["payload"]["status"].as_str(),
            Some("completed" | "failed" | "interrupted")
        )
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let out = std::env::args()
        .nth(1)
        .expect("usage: export_turn <out.json>");
    let dir = std::env::temp_dir().join(format!("conn-engine-export-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("engine.sqlite");
    let project_id = SqliteEngine::project_id_for(ROOT);
    let launch_input = |command: &str, thread: &str, text: &str| {
        json!({
            "commandId": command, "creationSource": "web", "threadId": thread,
            "projectId": project_id, "title": "Say hello", "generateTitle": true,
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "workspaceStrategy": {"type": "root"},
            "initialMessage": {"messageId": format!("message:{command}"), "text": text, "attachments": []},
        })
    };

    let engine = open(&db);
    let mut shell_items = vec![];
    let mut shell = engine
        .subscribe_shell(from_json(json!({"requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    read(&mut shell, &mut shell_items, |item| {
        item["kind"] == "synchronized"
    })
    .await;

    let launch = engine
        .launch_thread(launch_input("launch-1", "thread-1", "Say hello"))
        .await
        .unwrap();
    let thread_http = engine
        .thread_snapshot("thread-1".into())
        .await
        .unwrap()
        .unwrap();
    let mut thread_items = vec![];
    let mut thread = engine
        .subscribe_thread(
            from_json(json!({
                "threadId": "thread-1",
                "afterSequence": thread_http["snapshotSequence"],
                "requestCompletionMarker": true,
                "acceptDedupedBodies": true,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    read(&mut thread, &mut thread_items, run_ended).await;
    // The root node's final update follows the run's, as in TS.
    read(&mut thread, &mut thread_items, |_| false).await;
    read(&mut shell, &mut shell_items, |item| {
        item["thread"]["status"] == "completed"
    })
    .await;

    // A second client opening the finished thread over the socket only.
    let mut socket_items = vec![];
    let mut socket = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-1", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    read(&mut socket, &mut socket_items, |item| {
        item["kind"] == "synchronized"
    })
    .await;

    // A turn that is still running when the server stops.
    engine
        .launch_thread(launch_input("launch-2", "thread-2", "hang"))
        .await
        .unwrap();
    let mut hang = engine
        .subscribe_thread(from_json(json!({"threadId": "thread-2", "afterSequence": 0})).unwrap())
        .await
        .unwrap();
    read(&mut hang, &mut vec![], |item| {
        item["event"]["type"] == "provider-turn.updated"
    })
    .await;
    drop((shell, thread, socket, hang, engine));

    let engine = open(&db);
    let mut restart_shell = vec![];
    let mut shell = engine
        .subscribe_shell(from_json(json!({"requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    read(&mut shell, &mut restart_shell, |item| {
        item["kind"] == "synchronized"
    })
    .await;
    let mut restart_thread = vec![];
    let mut thread = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-2", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    read(&mut thread, &mut restart_thread, |item| {
        item["kind"] == "synchronized"
    })
    .await;

    let export = json!({
        "shellItems": shell_items,
        "launch": launch,
        "threadHttp": thread_http,
        "threadItems": thread_items,
        "socketItems": socket_items,
        "restartShellItems": restart_shell,
        "restartThreadItems": restart_thread,
    });
    std::fs::write(&out, serde_json::to_string_pretty(&export).unwrap()).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    eprintln!(
        "wrote {out}: {} shell items, {} thread items",
        export["shellItems"].as_array().unwrap().len(),
        export["threadItems"].as_array().unwrap().len()
    );
}
