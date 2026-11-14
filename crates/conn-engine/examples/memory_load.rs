//! Memory under many turns, with the scripted fake provider (no model calls).
//!
//! `cargo run --release -p conn-engine --features fake-provider --example memory_load -- <turns> <threads>`
//!
//! Runs `<turns>` turns spread round-robin over `<threads>` threads, one at a time, with a shell
//! and a thread subscription open as a client would have. Prints the process RSS (from `ps`)
//! every tenth of the run, then again after closing every provider session.

#![expect(
    clippy::unwrap_used,
    reason = "a measurement example: a failure should stop it"
)]

use std::{alloc::System, sync::Arc, time::Duration};

use stats_alloc::{INSTRUMENTED_SYSTEM, StatsAlloc};

use conn_contract::{from_json, to_json};
use conn_engine::{Engine, EngineConfig, ProjectConfig, SqliteEngine, fake::FakeProvider};
use serde_json::json;
use tokio::time::timeout;

const ROOT: &str = "/tmp/conn-engine-memory-project";

fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

// Counts live heap bytes, so the run reports what is allocated, not what the OS allocator
// keeps after a free (macOS keeps freed pages in RSS).
#[global_allocator]
static ALLOCATOR: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;

fn heap_kib() -> usize {
    let stats = ALLOCATOR.stats();
    // A realloc already counts in `bytes_allocated` or `bytes_deallocated`.
    stats
        .bytes_allocated
        .saturating_sub(stats.bytes_deallocated)
        / 1024
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let turns: usize = args.next().map_or(1000, |a| a.parse().unwrap());
    let threads: usize = args.next().map_or(1, |a| a.parse().unwrap());
    let dir = std::env::temp_dir().join(format!("conn-engine-memory-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut config = EngineConfig::new(dir.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Memory".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.stream_flush = Duration::from_millis(5);
    // `IDLE_MS` closes provider sessions idle that long (default: the engine's 10 minutes).
    let idle = std::env::var("IDLE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_millis);
    if idle.is_some() {
        config.idle_session = idle;
    }
    let engine = SqliteEngine::open(config).unwrap();
    let project = SqliteEngine::project_id_for(ROOT);

    let mut shell = engine
        .subscribe_shell(from_json(json!({"requestCompletionMarker": true})).unwrap())
        .await
        .unwrap();
    for t in 0..threads {
        engine
            .dispatch(
                from_json(json!({
                    "type": "thread.create", "commandId": format!("create-{t}"), "threadId": format!("t{t}"),
                    "projectId": project, "title": format!("Thread {t}"),
                    "modelSelection": {"instanceId": "claudeAgent", "model": "fake"},
                    "runtimeMode": "full-access", "interactionMode": "default",
                    "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
                }))
                .unwrap(),
            )
            .await
            .unwrap();
    }
    // Drain the shell as the client would, in the background.
    tokio::spawn(async move { while shell.recv().await.is_some() {} });

    println!(
        "turns={turns} threads={threads} start_rss_kib={} heap_kib={}",
        rss_kib(),
        heap_kib()
    );
    // `REOPEN=0` keeps one thread view open for the whole run instead of reopening it per turn.
    let reopen = std::env::var("REOPEN").map_or(true, |v| v != "0");
    let mut kept = None;
    let text = "Explain the borrow checker in a few sentences, with one short example.";
    for n in 0..turns {
        let thread = format!("t{}", n % threads);
        let ordinal = n / threads + 1;
        // The open thread view, as a client keeps it while a turn runs.
        if reopen || kept.is_none() {
            kept = Some(
                engine
                    .subscribe_thread(from_json(json!({"threadId": thread, "requestCompletionMarker": true, "acceptDedupedBodies": true, "acceptCompactTurnItems": true})).unwrap())
                    .await
                    .unwrap(),
            );
        }
        let view = kept.as_mut().unwrap();
        engine
            .dispatch(
                from_json(json!({
                    "type": "message.dispatch", "commandId": format!("m{n}"), "threadId": thread,
                    "messageId": format!("message:m{n}"), "text": text, "attachments": [],
                    "dispatchMode": {"type": "start_immediately"}, "createdBy": "user", "creationSource": "web",
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let run = format!("run:{thread}:{ordinal}");
        loop {
            let item = timeout(Duration::from_secs(10), view.recv())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let item = to_json(&item);
            if item["kind"] == "event"
                && item["event"]["type"] == "run.updated"
                && item["event"]["payload"]["id"] == run.as_str()
                && item["event"]["payload"]["status"] == "completed"
            {
                break;
            }
        }
        if reopen {
            kept = None;
        }
        if (n + 1) % (turns / 10).max(1) == 0 {
            println!(
                "turn={} rss_kib={} heap_kib={}",
                n + 1,
                rss_kib(),
                heap_kib()
            );
        }
    }
    let size = std::fs::metadata(dir.join("engine.sqlite"))
        .map(|m| m.len())
        .unwrap_or(0);
    let snapshot = engine.get_thread_projection("t0".into()).await.unwrap();
    println!(
        "end rss_kib={} db_bytes={size} t0_projection_bytes={}",
        rss_kib(),
        snapshot.to_string().len()
    );
    drop(snapshot);
    if let Some(idle) = idle {
        tokio::time::sleep(idle * 3).await;
        println!("after_idle rss_kib={} heap_kib={}", rss_kib(), heap_kib());
    }
    drop(engine);
    tokio::time::sleep(Duration::from_millis(200)).await;
    println!("after_close rss_kib={} heap_kib={}", rss_kib(), heap_kib());
    let _ = std::fs::remove_dir_all(&dir);
}
