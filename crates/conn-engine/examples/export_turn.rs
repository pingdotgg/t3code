//! Records what a Conn client receives for one new thread and one turn, for
//! `tools/client-check.mjs`. Runs the engine with the scripted fake provider.
//!
//! `cargo run -p conn-engine --features fake-provider --example export_turn -- <out.json>`
//!
//! The calls follow the client: the shell subscribes with `requestCompletionMarker`; a new
//! thread starts with `orchestration.launchThread`; the thread view loads the HTTP snapshot and
//! subscribes after its sequence with `requestCompletionMarker` and `acceptDedupedBodies`.

#![expect(
    clippy::unwrap_used,
    reason = "an example run by the client check: a failure should stop it"
)]

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

    // A client that opts in to compact snapshots gets the same thread.
    let mut compact_items = vec![];
    let mut compact = engine
        .subscribe_thread(
            from_json(
                json!({"threadId": "thread-1", "requestCompletionMarker": true,
                "acceptDedupedBodies": true, "acceptCompactTurnItems": true}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    read(&mut compact, &mut compact_items, |item| {
        item["kind"] == "synchronized"
    })
    .await;

    // A message sent while a turn runs waits in the queue and runs after it.
    let mut queue_items = vec![];
    engine
        .launch_thread(launch_input("launch-3", "thread-3", "hang"))
        .await
        .unwrap();
    let mut queue = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-3", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    read(&mut queue, &mut queue_items, |item| {
        item["event"]["type"] == "provider-turn.updated"
    })
    .await;
    engine
        .dispatch(
            from_json(json!({
                "type": "message.dispatch", "commandId": "queued-1", "threadId": "thread-3",
                "messageId": "message:queued-1", "text": "after that", "attachments": [],
                "dispatchMode": {"type": "queue_after_active"}, "createdBy": "user", "creationSource": "web",
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    engine
        .dispatch(
            from_json(
                json!({"type": "run.interrupt", "commandId": "stop-3", "threadId": "thread-3",
                "runId": "run:thread-3:1"}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    read(&mut queue, &mut queue_items, |item| {
        run_ended(item) && item["event"]["payload"]["id"] == "run:thread-3:2"
    })
    .await;
    read(&mut queue, &mut queue_items, |_| false).await;

    // A Stop the provider never confirms, then Force stop.
    let mut stop_items = vec![];
    engine
        .launch_thread(launch_input("launch-4", "thread-4", "stuck"))
        .await
        .unwrap();
    let mut stuck = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-4", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    read(&mut stuck, &mut stop_items, |item| {
        item["event"]["type"] == "provider-turn.updated"
    })
    .await;
    engine
        .dispatch(
            from_json(
                json!({"type": "thread.stop", "commandId": "stop-4", "threadId": "thread-4"}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    read(&mut stuck, &mut stop_items, |item| {
        item["event"]["payload"]["type"] == "run_interrupt_request"
            && item["event"]["payload"]["unresponsiveAt"].is_string()
    })
    .await;
    let unresponsive_at = stop_items.len();
    engine
        .call(
            "orchestration.forceStopThread",
            json!({"threadId": "thread-4"}),
        )
        .await
        .unwrap();
    read(&mut stuck, &mut stop_items, run_ended).await;
    read(&mut stuck, &mut stop_items, |_| false).await;
    drop(stuck);

    // A turn that leaves a background command running after it completed.
    let mut background_items = vec![];
    engine
        .launch_thread(launch_input("launch-5", "thread-5", "background-reported"))
        .await
        .unwrap();
    let mut background = engine
        .subscribe_thread(from_json(json!({"threadId": "thread-5"})).unwrap())
        .await
        .unwrap();
    read(&mut background, &mut vec![], run_ended).await;
    drop(background);
    let mut background = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-5", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    read(&mut background, &mut background_items, |item| {
        item["kind"] == "synchronized"
    })
    .await;
    drop(background);
    let background_shell = engine.shell_snapshot().await.unwrap()["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "thread-5")
        .cloned()
        .unwrap();

    // A client adds a project and removes it again.
    let added =
        std::env::temp_dir().join(format!("conn-engine-export-added-{}", std::process::id()));
    std::fs::create_dir_all(&added).unwrap();
    engine
        .call(
            "projects.mutate",
            json!({"type": "project.create", "commandId": "project-1", "projectId": "project:added",
                   "title": "Added", "workspaceRoot": added.to_string_lossy()}),
        )
        .await
        .unwrap();
    read(&mut shell, &mut shell_items, |item| {
        item["kind"] == "project.updated"
    })
    .await;
    engine
        .call(
            "projects.mutate",
            json!({"type": "project.delete", "commandId": "project-2", "projectId": "project:added"}),
        )
        .await
        .unwrap();
    read(&mut shell, &mut shell_items, |item| {
        item["kind"] == "project.removed"
    })
    .await;
    let _ = std::fs::remove_dir_all(&added);

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
    drop((shell, thread, socket, compact, queue, hang, engine));

    let engine = open(&db);
    // The cut turn continues in a new run; open the views once it has finished.
    let mut follow = engine
        .subscribe_thread(from_json(json!({"threadId": "thread-2"})).unwrap())
        .await
        .unwrap();
    read(&mut follow, &mut vec![], |item| {
        run_ended(item) && item["event"]["payload"]["id"] == "run:thread-2:2"
    })
    .await;
    drop(follow);
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
        "compactItems": compact_items,
        "queueItems": queue_items,
        "stopItems": stop_items,
        "backgroundItems": background_items,
        "backgroundShell": background_shell,
        "stopUnresponsiveAt": unresponsive_at,
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
