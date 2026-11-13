//! Measures memory around one Claude session: the host process (this provider), the `claude`
//! child and everything it spawned (hooks, MCP helpers). Runs real Haiku turns in an empty
//! temporary directory.
//!
//! ```sh
//! cargo run --release -p conn-provider-claude --example rss            # user's settings
//! RSS_SETTINGS=minimal cargo run --release -p conn-provider-claude --example rss
//! RSS_TURNS=10 cargo run --release -p conn-provider-claude --example rss
//! ```
//!
//! `minimal` runs the CLI with `--setting-sources user` and a throwaway `CLAUDE_CONFIG_DIR` that
//! holds only the user's `apiKeyHelper`: no project or local settings, hooks, plugins or MCP
//! helpers. In a container the auth comes from the environment, so there
//! `setting_sources: Some(vec![])` gives the same effect.

use std::{path::PathBuf, process::Command, time::Duration};

use conn_contract::from_json;
use conn_provider::{
    EnsureThreadInput, OpenSessionInput, Provider, ProviderEvent, TurnInput, TurnMessage,
};
use conn_provider_claude::{ClaudeConfig, ClaudeProvider};
use serde_json::{Value, json};

fn ps(args: &[&str]) -> String {
    Command::new("ps")
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn rss_kib(pid: u32) -> u64 {
    ps(&["-o", "rss=", "-p", &pid.to_string()])
        .trim()
        .parse()
        .unwrap_or(0)
}

/// Every descendant of `root`, from one `ps` table.
fn descendants(root: u32) -> Vec<u32> {
    let table: Vec<(u32, u32)> = ps(&["-A", "-o", "pid=,ppid="])
        .lines()
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .collect();
    let mut found = Vec::new();
    let mut queue = vec![root];
    while let Some(parent) = queue.pop() {
        for (pid, ppid) in &table {
            if *ppid == parent {
                found.push(*pid);
                queue.push(*pid);
            }
        }
    }
    found
}

/// macOS `footprint`: the private memory of a process, in KiB.
fn footprint_kib(pid: u32) -> Option<u64> {
    let out = Command::new("footprint")
        .args(["-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("Footprint:"))?;
    let mut words = line
        .split_whitespace()
        .skip_while(|w| *w != "Footprint:")
        .skip(1);
    let value: f64 = words.next()?.parse().ok()?;
    let factor = match words.next()? {
        "KB" => 1.0,
        "MB" => 1024.0,
        "GB" => 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * factor) as u64)
}

fn tree_report(label: &str, host: u32) {
    let pids = descendants(host);
    let rss: u64 = pids.iter().map(|p| rss_kib(*p)).sum();
    let private: u64 = pids.iter().filter_map(|p| footprint_kib(*p)).sum();
    println!(
        "{label:<44} children {:>2}  RSS {:>7} KiB  footprint {:>7} KiB",
        pids.len(),
        rss,
        private
    );
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a tokio runtime");
    runtime.block_on(run());
}

fn throwaway_home(me: u32) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("conn-claude-rss-home-{me}"));
    std::fs::create_dir_all(&dir).expect("temp home");
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let user: Value = std::fs::read_to_string(home.join(".claude/settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let mut settings = json!({});
    if let Some(helper) = user.get("apiKeyHelper") {
        settings["apiKeyHelper"] = helper.clone();
    }
    std::fs::write(dir.join("settings.json"), settings.to_string()).expect("settings");
    dir
}

async fn run() {
    let me = std::process::id();
    let minimal = std::env::var("RSS_SETTINGS").as_deref() == Ok("minimal");
    let turns: u32 = std::env::var("RSS_TURNS")
        .ok()
        .and_then(|t| t.parse().ok())
        .unwrap_or(3);
    let dir = std::env::temp_dir().join(format!("conn-claude-rss-{me}"));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let dir = std::fs::canonicalize(&dir).expect("temp dir path");
    let cwd = dir.to_str().unwrap_or_default().to_string();
    let host = |label: &str| println!("{label:<44} host RSS {:>6} KiB", rss_kib(me));
    println!(
        "settings: {}",
        if minimal { "minimal" } else { "user's own" }
    );
    host("runtime only");

    let home = minimal.then(|| throwaway_home(me));
    let config = ClaudeConfig {
        setting_sources: minimal.then(|| vec!["user".to_string()]),
        home_path: home.clone(),
        idle_timeout: Some(Duration::from_secs(5)),
        ..ClaudeConfig::default()
    };
    let provider = ClaudeProvider::new("claudeAgent".into(), config);
    let policy = json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": cwd});
    let model = json!({"instanceId": "claudeAgent", "model": "haiku"});
    let app_thread = json!({
        "createdBy": "user", "creationSource": "web", "id": "thread-rss", "projectId": "p",
        "title": "rss", "providerInstanceId": "claudeAgent", "modelSelection": model,
        "runtimeMode": "full-access", "interactionMode": "default", "branch": null,
        "worktreePath": null, "activeProviderThreadId": null,
        "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "thread-rss"},
        "forkedFrom": null, "createdAt": "2026-11-13T00:00:00.000Z",
        "updatedAt": "2026-11-13T00:00:00.000Z", "archivedAt": null,
    });
    let opened = provider
        .open_session(OpenSessionInput {
            thread_id: "thread-rss".into(),
            provider_session_id: "provider-session-rss".into(),
            model_selection: from_json(model.clone()).expect("model"),
            runtime_policy: from_json(policy.clone()).expect("policy"),
            resume_from_session: None,
        })
        .await
        .expect("session");
    let (session, mut events) = (opened.session, opened.events);
    let mut thread = session
        .ensure_thread(EnsureThreadInput {
            thread_id: "thread-rss".into(),
            title: None,
            model_selection: from_json(model.clone()).expect("model"),
            runtime_policy: from_json(policy.clone()).expect("policy"),
            existing_provider_thread: None,
        })
        .await
        .expect("thread");
    host("one idle session (no child yet)");

    let mut peak = 0;
    for n in 1..=turns {
        session
            .start_turn(TurnInput {
                app_thread: from_json(app_thread.clone()).expect("app thread"),
                thread_id: "thread-rss".into(),
                run_id: format!("run-{n}").as_str().into(),
                run_ordinal: n,
                provider_turn_ordinal: n,
                attempt_id: format!("attempt-{n}").as_str().into(),
                root_node_id: format!("node-{n}").as_str().into(),
                provider_thread: thread.clone(),
                message: TurnMessage {
                    message_id: format!("message-{n}").as_str().into(),
                    text: "Write a 120-word paragraph about tides. No tools.".into(),
                    attachments: vec![],
                },
                model_selection: from_json(model.clone()).expect("model"),
                runtime_policy: from_json(policy.clone()).expect("policy"),
            })
            .await
            .expect("turn starts");
        let mut sampler = tokio::time::interval(Duration::from_millis(20));
        loop {
            tokio::select! {
                event = events.recv() => {
                    let event = event.expect("events");
                    if let ProviderEvent::ProviderThreadUpdated { provider_thread } = &event {
                        thread = provider_thread.clone();
                    }
                    if let ProviderEvent::TurnTerminal(terminal) = &event {
                        println!("turn {n} ended: {:?}", terminal.status);
                        break;
                    }
                }
                _ = sampler.tick() => peak = peak.max(rss_kib(me)),
            }
        }
        host(&format!("after turn {n}"));
        if n == 1 {
            tree_report("claude child tree after turn 1", me);
        }
    }
    println!(
        "{:<44} host RSS {peak:>6} KiB",
        "peak during turns (20 ms samples)"
    );
    tree_report("claude child tree after the last turn", me);

    // The idle watcher ends the child after 5 s here (30 min by default).
    tokio::time::sleep(Duration::from_secs(7)).await;
    tree_report("after the idle timeout", me);
    host("after the idle timeout");

    session.close().await;
    drop(session);
    drop(events);
    host("after close and drop");

    let _ = std::fs::remove_dir_all(&dir);
    if let Some(home) = home {
        let _ = std::fs::remove_dir_all(home);
    }
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
