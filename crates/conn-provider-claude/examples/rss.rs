//! Measures this provider's own memory: the resident set of a host process with one session,
//! apart from the `claude` child. Runs one real Haiku turn in an empty temporary directory.
//!
//! ```sh
//! cargo run --release -p conn-provider-claude --example rss
//! ```

use std::{path::PathBuf, time::Duration};

use conn_contract::from_json;
use conn_provider::{
    EnsureThreadInput, OpenSessionInput, Provider, ProviderEvent, TurnInput, TurnMessage,
};
use conn_provider_claude::{ClaudeConfig, ClaudeProvider};
use serde_json::{Value, json};

fn rss_kib(pid: u32) -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok();
    out.and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0)
}

fn child_pid(parent: u32) -> Option<u32> {
    let out = std::process::Command::new("pgrep")
        .args(["-P", &parent.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(run());
}

async fn run() {
    let me = std::process::id();
    let dir = std::env::temp_dir().join(format!("conn-claude-rss-{me}"));
    std::fs::create_dir_all(&dir).unwrap();
    let dir = std::fs::canonicalize(&dir).unwrap();
    let cwd = dir.to_str().unwrap().to_string();
    let report = |label: &str| {
        println!("{label:<44} host RSS {:>6} KiB", rss_kib(me));
    };
    report("runtime only");

    let provider = ClaudeProvider::new("claudeAgent".into(), ClaudeConfig::default());
    let policy = json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": cwd});
    let model = json!({"instanceId": "claudeAgent", "model": "haiku"});
    let opened = provider
        .open_session(OpenSessionInput {
            thread_id: "thread-rss".into(),
            provider_session_id: "provider-session-rss".into(),
            model_selection: from_json(model.clone()).unwrap(),
            runtime_policy: from_json(policy.clone()).unwrap(),
            resume_from_session: None,
        })
        .await
        .unwrap();
    let (session, mut events) = (opened.session, opened.events);
    let thread = session
        .ensure_thread(EnsureThreadInput {
            thread_id: "thread-rss".into(),
            title: None,
            model_selection: from_json(model.clone()).unwrap(),
            runtime_policy: from_json(policy.clone()).unwrap(),
            existing_provider_thread: None,
        })
        .await
        .unwrap();
    report("one idle session (no child yet)");

    session
        .start_turn(TurnInput {
            app_thread: from_json(json!({"id": "thread-rss", "title": "rss"})).unwrap(),
            thread_id: "thread-rss".into(),
            run_id: "run-1".into(),
            run_ordinal: 1,
            provider_turn_ordinal: 1,
            attempt_id: "attempt-1".into(),
            root_node_id: "node-1".into(),
            provider_thread: thread,
            message: TurnMessage {
                message_id: "message-1".into(),
                text: "Write a 120-word paragraph about tides. No tools.".into(),
                attachments: vec![],
            },
            model_selection: from_json(model).unwrap(),
            runtime_policy: from_json(policy).unwrap(),
        })
        .await
        .unwrap();
    let mut peak = 0;
    let mut count = 0;
    let mut sampler = tokio::time::interval(Duration::from_millis(20));
    loop {
        tokio::select! {
            event = events.recv() => {
                let event = event.expect("events");
                count += 1;
                let value: Value = serde_json::to_value(&event).unwrap();
                if matches!(event, ProviderEvent::TurnTerminal(_)) {
                    println!("turn ended: {} after {count} events", value["status"]);
                    break;
                }
            }
            _ = sampler.tick() => peak = peak.max(rss_kib(me)),
        }
    }
    println!(
        "{:<44} host RSS {peak:>6} KiB",
        "peak during the turn (20 ms samples)"
    );
    report("after the turn, idle session, child alive");
    if let Some(child) = child_pid(me) {
        println!(
            "{:<44} RSS {:>6} KiB",
            "claude child (not ours)",
            rss_kib(child)
        );
    }
    session.close().await;
    report("after close");

    let _ = std::fs::remove_dir_all(&dir);
    let slug: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if let Some(home) = std::env::var_os("HOME") {
        let projects = PathBuf::from(home).join(".claude/projects");
        if slug.contains("conn-claude-rss-") {
            let _ = std::fs::remove_dir_all(projects.join(slug));
        }
    }
}
