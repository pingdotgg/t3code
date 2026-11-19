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

/// A scratch git repository with one commit, for the checkpoint scenarios.
fn scratch_repo(dir: &std::path::Path) -> String {
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(&repo)
            .env("GIT_AUTHOR_NAME", "export")
            .env("GIT_AUTHOR_EMAIL", "export@example.com")
            .env("GIT_COMMITTER_NAME", "export")
            .env("GIT_COMMITTER_EMAIL", "export@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-qm", "init"]);
    std::fs::canonicalize(&repo)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

/// Two turns that write files on an engine that takes checkpoints, a rewind, and a fork of the
/// first turn with one message. Returns the source's items, the fork's items and the shell rows.
async fn checkpoint_scenario(dir: &std::path::Path) -> (Vec<Value>, Vec<Value>, Value) {
    let root = scratch_repo(dir);
    let mut config = EngineConfig::new(dir.join("checkpoints.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Repo".into(),
        workspace_root: root.clone(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.checkpoints = true;
    let engine = SqliteEngine::open(config).expect("open engine");
    let project_id = SqliteEngine::project_id_for(&root);
    engine
        .launch_thread(json!({
            "commandId": "launch-cp", "creationSource": "web", "threadId": "thread-cp",
            "projectId": project_id, "title": "Edit files",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "workspaceStrategy": {"type": "root"},
            "initialMessage": {"messageId": "message:cp-1", "text": "write a.txt one", "attachments": []},
        }))
        .await
        .unwrap();
    // A snapshot first, then every event of both turns, as an open thread view gets them.
    let mut items = vec![];
    let mut follow = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-cp", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    read(&mut follow, &mut items, run_ended).await;
    read_checkpoint(&mut follow, &mut items, 1).await;
    engine
        .dispatch(
            from_json(json!({
                "type": "message.dispatch", "commandId": "cp-2", "threadId": "thread-cp",
                "messageId": "message:cp-2", "text": "write b.txt two", "attachments": [],
                "dispatchMode": {"type": "start_immediately"}, "createdBy": "user", "creationSource": "web",
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    read(&mut follow, &mut items, |item| {
        run_ended(item) && item["event"]["payload"]["id"] == "run:thread-cp:2"
    })
    .await;
    read_checkpoint(&mut follow, &mut items, 2).await;
    drain(&mut follow, &mut items).await;
    // Rewind the conversation to the first turn (a root thread keeps its files).
    let projection = engine
        .get_thread_projection("thread-cp".into())
        .await
        .unwrap();
    let first = projection["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["appRunOrdinal"] == 1)
        .cloned()
        .unwrap();
    engine
        .dispatch(
            from_json(json!({
                "type": "checkpoint.rollback", "commandId": "cp-rollback", "threadId": "thread-cp",
                "scopeId": first["scopeId"], "checkpointId": first["id"], "restoreFiles": false,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    read(&mut follow, &mut items, |item| {
        item["event"]["type"] == "run.updated"
            && item["event"]["payload"]["status"] == "rolled_back"
    })
    .await;
    drain(&mut follow, &mut items).await;

    // A fork of the first turn, then its first message: a native fork.
    engine
        .dispatch(
            from_json(json!({
                "type": "thread.fork", "commandId": "cp-fork", "sourceThreadId": "thread-cp",
                "targetThreadId": "thread-cp-fork", "sourcePoint": {"type": "latest_stable"},
                "createdBy": "user", "creationSource": "web",
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let mut fork_items = vec![];
    let mut fork = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-cp-fork", "requestCompletionMarker": true}))
                .unwrap(),
        )
        .await
        .unwrap();
    read(&mut fork, &mut fork_items, |item| {
        item["kind"] == "synchronized"
    })
    .await;
    engine
        .dispatch(
            from_json(json!({
                "type": "message.dispatch", "commandId": "cp-fork-1", "threadId": "thread-cp-fork",
                "messageId": "message:cp-fork-1", "text": "go on", "attachments": [],
                "dispatchMode": {"type": "start_immediately"}, "createdBy": "user", "creationSource": "web",
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    read(&mut fork, &mut fork_items, run_ended).await;
    drain(&mut fork, &mut fork_items).await;
    let shell = engine.shell_snapshot().await.unwrap();
    (items, fork_items, shell["threads"].clone())
}

/// Reads items until `done` holds for one. A slow runner can pause longer than any quiet
/// window mid-turn, so this waits on the event itself and fails loudly after 30 s.
async fn read<T: serde::Serialize, E: serde::Serialize>(
    stream: &mut Subscription<T, E>,
    out: &mut Vec<Value>,
    done: impl Fn(&Value) -> bool,
) {
    let wait = async {
        loop {
            if done(&next(stream, out).await.expect("stream ended")) {
                return;
            }
        }
    };
    timeout(Duration::from_secs(30), wait)
        .await
        .expect("expected item never came");
}

/// Reads the trailing items until the stream is quiet for 300 ms.
async fn drain<T: serde::Serialize, E: serde::Serialize>(
    stream: &mut Subscription<T, E>,
    out: &mut Vec<Value>,
) {
    while let Ok(Some(_)) = timeout(Duration::from_millis(300), next(stream, out)).await {}
}

async fn next<T: serde::Serialize, E: serde::Serialize>(
    stream: &mut Subscription<T, E>,
    out: &mut Vec<Value>,
) -> Option<Value> {
    let item = match stream.recv().await? {
        Ok(item) => to_json(&item),
        Err(e) => panic!("stream failed: {}", to_json(&e)),
    };
    out.push(item.clone());
    Some(item)
}

/// Reads until checkpoint `ordinal` is captured: an event, or a snapshot already read that
/// holds it. Capture runs after the turn ends, so `run_ended` alone can miss it.
async fn read_checkpoint<T: serde::Serialize, E: serde::Serialize>(
    stream: &mut Subscription<T, E>,
    out: &mut Vec<Value>,
    ordinal: u64,
) {
    let captured = |item: &Value| {
        (item["event"]["type"] == "checkpoint.captured"
            && item["event"]["payload"]["appRunOrdinal"] == ordinal)
            || item["projection"]["checkpoints"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["appRunOrdinal"] == ordinal))
    };
    if !out.iter().any(captured) {
        read(stream, out, captured).await;
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
    drain(&mut thread, &mut thread_items).await;
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
    drain(&mut queue, &mut queue_items).await;

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
    drain(&mut stuck, &mut stop_items).await;
    drop(stuck);

    // A Stop while the provider still starts the turn (a cold start): the run ends at once.
    let mut cold_stop_items = vec![];
    engine
        .launch_thread(launch_input("launch-6", "thread-6", "coldstart"))
        .await
        .unwrap();
    let mut cold = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-6", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    read(&mut cold, &mut cold_stop_items, |item| {
        item["event"]["type"] == "provider-turn.updated"
    })
    .await;
    let cold_stop_at = cold_stop_items.len();
    engine
        .dispatch(
            from_json(
                json!({"type": "thread.stop", "commandId": "stop-6", "threadId": "thread-6"}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    read(&mut cold, &mut cold_stop_items, run_ended).await;
    drain(&mut cold, &mut cold_stop_items).await;
    drop(cold);

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

    // Pull request links on thread-1, as T3 keys them: a GitHub link, a stack member, then
    // the member unlinked (a tombstone) and linked again by hand.
    let mut links_items = vec![];
    let mut links = engine
        .subscribe_thread(
            from_json(json!({"threadId": "thread-1", "requestCompletionMarker": true})).unwrap(),
        )
        .await
        .unwrap();
    read(&mut links, &mut links_items, |item| {
        item["kind"] == "synchronized"
    })
    .await;
    for (index, command) in [
        json!({"type": "thread.pull-request.link", "host": "GitHub.com", "repository": "O/R",
               "number": 4, "url": "https://github.com/O/R/pull/4", "source": "manual"}),
        json!({"type": "thread.pull-request.link", "host": "github.com", "repository": "o/r",
               "number": 9, "url": "https://github.com/o/r/pull/9", "source": "stack"}),
        json!({"type": "thread.pull-request.unlink", "host": "GitHub.com", "repository": "O/R",
               "number": 9}),
        json!({"type": "thread.pull-request.link", "host": "github.com", "repository": "o/r",
               "number": 9, "url": "https://github.com/o/r/pull/9", "source": "manual"}),
        // The link sweep's writes: #4's snapshot, then the branch's pull request.
        json!({"type": "thread.pull-request-link.sync", "host": "github.com", "repository": "o/r",
               "number": 4, "stack": null, "snapshot": {"state": "open", "title": "Fix the chip",
                   "headBranch": "fix", "baseBranch": "main", "isDraft": false,
                   "updatedAt": "2026-11-19T08:00:00.000Z", "syncedAt": "2026-11-19T09:00:00.000Z",
                   "closedAt": null, "mergedAt": null, "checksState": "failing",
                   "reviewDecision": "review-required", "mergeability": "mergeable"}}),
        json!({"type": "thread.pull-request.sync", "projectId": project_id, "snapshotSequence": 0,
               "expected": {"workspaceRoot": ROOT, "branch": null, "worktreePath": null,
                   "linkedPullRequest": null, "branchPullRequest": null},
               "branchPullRequest": {"projectId": project_id, "repository": "o/r", "number": 4,
                   "url": "https://github.com/O/R/pull/4"}}),
    ]
    .into_iter()
    .enumerate()
    {
        let mut command = command;
        command["commandId"] = json!(format!("pr-link-{index}"));
        command["threadId"] = json!("thread-1");
        engine.dispatch(from_json(command).unwrap()).await.unwrap();
    }
    let synced = std::cell::Cell::new(0);
    read(&mut links, &mut links_items, |item| {
        if item["event"]["type"] == "thread.pull-request-synced" {
            synced.set(synced.get() + 1);
        }
        synced.get() == 6
    })
    .await;
    drop(links);

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

    let (checkpoint_items, fork_items, checkpoint_shell) = checkpoint_scenario(&dir).await;

    let parent = engine
        .get_thread_projection("thread-1".into())
        .await
        .unwrap();
    let parent_run = parent["runs"].as_array().unwrap().first().unwrap();
    let mut created_stream = engine
        .subscribe_thread(
            from_json(json!({"threadId":"thread-1","requestCompletionMarker":true})).unwrap(),
        )
        .await
        .unwrap();
    let mut created_items = Vec::new();
    read(&mut created_stream, &mut created_items, |item| {
        item["kind"] == "synchronized"
    })
    .await;
    engine.dispatch(from_json(json!({
        "type":"thread.create","commandId":"batch-child","threadId":"thread-created",
        "projectId":parent["thread"]["projectId"],"title":"Created by an agent",
        "modelSelection":parent["thread"]["modelSelection"],"runtimeMode":"full-access","interactionMode":"default",
        "branch":null,"worktreePath":null,"createdBy":"agent","creationSource":"mcp",
        "initialMessage":{"messageId":"batch-message","senderThreadId":"thread-1","text":"hello","attachments":[]},
    })).unwrap()).await.unwrap();
    engine.dispatch(from_json(json!({
        "type":"thread.created.record","commandId":"record-batch-child",
        "parentThreadId":"thread-1","parentRunId":parent_run["id"],"parentNodeId":parent_run["rootNodeId"],
        "targetThreadId":"thread-created","targetRunId":"run:thread-created:1",
    })).unwrap()).await.unwrap();
    read(&mut created_stream, &mut created_items, |item| {
        item["event"]["payload"]["type"] == "thread_created"
    })
    .await;
    let created_child = engine
        .thread_snapshot("thread-created".into())
        .await
        .unwrap()
        .unwrap();

    let export = json!({
        "createdThreadItems":created_items,
        "createdThreadSnapshot":created_child,
        "checkpointItems": checkpoint_items,
        "forkItems": fork_items,
        "checkpointShellThreads": checkpoint_shell,
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
        "coldStopItems": cold_stop_items,
        "coldStopAt": cold_stop_at,
        "restartShellItems": restart_shell,
        "restartThreadItems": restart_thread,
        "pullRequestLinkItems": links_items,
    });
    std::fs::write(&out, serde_json::to_string_pretty(&export).unwrap()).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    eprintln!(
        "wrote {out}: {} shell items, {} thread items",
        export["shellItems"].as_array().unwrap().len(),
        export["threadItems"].as_array().unwrap().len()
    );
}
