//! Memory of the SDK helper and of this process around one Claude session, with any `claude`
//! executable (the real CLI, or `tools/conformance/stub-claude` with a transcript of N turns).
//!
//! ```sh
//! helper_memory <claude-binary> <cwd> [turns]
//! ```
//!
//! Prints RSS (`ps`) and private memory of the helper and of this process (`footprint` on
//! macOS; `Rss`, `Pss`, `Pss_Anon` and `Private_Dirty` from `/proc/<pid>/smaps_rollup` on Linux): once the
//! query is open, after the first turn, after the last turn, and after the session closed
//! (when the helper must be gone).

use std::{path::PathBuf, process::Command, time::Duration};

use conn_contract::from_json;
use conn_provider::{
    EnsureThreadInput, OpenSessionInput, Provider, ProviderEvent, TurnInput, TurnMessage,
};
use conn_provider_claude::{ClaudeConfig, ClaudeProvider};
use serde_json::{Value, json};

fn rss_mib(pid: u32) -> f64 {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    out.parse::<f64>().unwrap_or(0.0) / 1024.0
}

/// `Rss`, `Pss`, `Pss_Anon` and `Private_Dirty` in MiB, from `smaps_rollup`.
#[cfg(target_os = "linux")]
fn footprint(pid: u32) -> String {
    let text = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).unwrap_or_default();
    let mib = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<f64>().ok())
            .map_or_else(|| "-".into(), |kb| format!("{:.1} MiB", kb / 1024.0))
    };
    format!(
        "Rss {}, Pss {}, Pss_Anon {}, Private_Dirty {}",
        mib("Rss:"),
        mib("Pss:"),
        mib("Pss_Anon:"),
        mib("Private_Dirty:")
    )
}

#[cfg(not(target_os = "linux"))]
fn footprint(pid: u32) -> String {
    let out = Command::new("footprint")
        .args(["-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    out.lines()
        .find_map(|l| l.split("phys_footprint:").nth(1))
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| "-".into())
}

fn report(label: &str, helper: Option<u32>) {
    let me = std::process::id();
    let helper_text = match helper {
        Some(pid) => format!(
            "helper rss {:.1} MiB, footprint {}",
            rss_mib(pid),
            footprint(pid)
        ),
        None => "no helper".into(),
    };
    println!(
        "{label}: {helper_text}; conn rss {:.1} MiB, footprint {}",
        rss_mib(me),
        footprint(me)
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [binary, cwd, rest @ ..] = args.as_slice() else {
        eprintln!("usage: helper_memory <claude-binary> <cwd> [turns]");
        std::process::exit(2);
    };
    let turns: u32 = rest.first().and_then(|t| t.parse().ok()).unwrap_or(10);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| panic!("runtime: {e}"));
    runtime.block_on(async {
        let provider = ClaudeProvider::new(
            "claudeAgent".into(),
            ClaudeConfig {
                binary: PathBuf::from(binary),
                idle_timeout: None,
                ..ClaudeConfig::default()
            },
        );
        report("before any session", provider.helper().pid());
        let model = json!({"instanceId": "claudeAgent", "model": "claude-haiku-5-5"});
        let policy = json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": cwd});
        let opened = provider
            .open_session(OpenSessionInput {
                thread_id: "thread-memory".into(),
                provider_session_id: "provider-session-memory".into(),
                model_selection: from_json(model.clone()).unwrap_or_else(|e| panic!("{e}")),
                runtime_policy: from_json(policy.clone()).unwrap_or_else(|e| panic!("{e}")),
                resume_from_session: None,
            })
            .await
            .unwrap_or_else(|e| panic!("open: {e}"));
        let (session, mut events) = (opened.session, opened.events);
        let mut thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "thread-memory".into(),
                title: None,
                model_selection: from_json(model.clone()).unwrap_or_else(|e| panic!("{e}")),
                runtime_policy: from_json(policy.clone()).unwrap_or_else(|e| panic!("{e}")),
                existing_provider_thread: None,
            })
            .await
            .unwrap_or_else(|e| panic!("ensure: {e}"));
        for n in 1..=turns {
            let input = TurnInput {
                app_thread: from_json(json!({
                    "createdBy": "user", "creationSource": "web", "id": "thread-memory",
                    "projectId": "project-memory", "title": "Memory", "providerInstanceId": "claudeAgent",
                    "modelSelection": model, "runtimeMode": "full-access", "interactionMode": "default",
                    "branch": null, "worktreePath": null, "activeProviderThreadId": null,
                    "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "thread-memory"},
                    "forkedFrom": null, "createdAt": "2026-11-13T00:00:00.000Z",
                    "updatedAt": "2026-11-13T00:00:00.000Z", "archivedAt": null,
                }))
                .unwrap_or_else(|e| panic!("{e}")),
                thread_id: "thread-memory".into(),
                run_id: format!("run-{n}").as_str().into(),
                run_ordinal: n,
                provider_turn_ordinal: n,
                attempt_id: format!("attempt-{n}").as_str().into(),
                root_node_id: format!("node-{n}").as_str().into(),
                provider_thread: thread.clone(),
                message: TurnMessage {
                    message_id: format!("message-{n}").as_str().into(),
                    text: "Reply with exactly: pong".into(),
                    attachments: vec![],
                },
                model_selection: from_json(model.clone()).unwrap_or_else(|e| panic!("{e}")),
                runtime_policy: from_json(policy.clone()).unwrap_or_else(|e| panic!("{e}")),
            };
            session
                .start_turn(input)
                .await
                .unwrap_or_else(|e| panic!("turn {n}: {e}"));
            if n == 1 {
                report("query open, turn 1 running", provider.helper().pid());
            }
            loop {
                let event = tokio::time::timeout(Duration::from_secs(120), events.recv())
                    .await
                    .unwrap_or_else(|_| panic!("timed out"))
                    .unwrap_or_else(|| panic!("closed"));
                let value: Value = serde_json::to_value(&event).unwrap_or_default();
                if value["type"] == "provider_thread.updated" {
                    thread = from_json(value["providerThread"].clone())
                        .unwrap_or_else(|e| panic!("{e}"));
                }
                if matches!(event, ProviderEvent::TurnTerminal { .. }) {
                    break;
                }
            }
            if n == 1 || n == turns {
                report(&format!("after turn {n}"), provider.helper().pid());
            }
        }
        let helper_pid = provider.helper().pid();
        session.close().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let alive = helper_pid.is_some_and(conn_provider_support::process::pid_alive);
        report(
            &format!("after close (helper pid {helper_pid:?} alive: {alive})"),
            provider.helper().pid(),
        );
    });
}
