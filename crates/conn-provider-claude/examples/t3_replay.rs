//! Replays the T3 server's own Claude transcripts against `ClaudeSession`, with
//! `tools/t3-replay/fake-host.mjs` in place of the SDK host: every frame the session sends must
//! match the transcript's `expect_outbound` frame (T3's projection). No CLI, no model.
//!
//! ```sh
//! t3_replay <fixtures-dir> <fake-host.mjs> <scenarios.json> <policies.json> <out-dir> [scenario...]
//! ```
//!
//! `policies.json` comes from `tools/t3-replay/policies.mjs`: each scenario's runtime policy as
//! T3's replay harness builds it (thread modes plus `runtimePolicyOverride`).
//!
//! Prints one line per scenario (PASS, or FAIL with the first mismatch) and exits 1 on a FAIL.

use std::{path::Path, time::Duration};

use conn_contract::{from_json, to_json};
use conn_provider::{
    EnsureThreadInput, InterruptInput, OpenSessionInput, Provider, ProviderEvent,
    RuntimeRequestResponse, TurnInput, TurnMessage,
};
use conn_provider_claude::{ClaudeConfig, ClaudeProvider, HelperCommand};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const EVENT_TIMEOUT: Duration = Duration::from_secs(10);

fn read_lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

async fn next(events: &mut mpsc::Receiver<ProviderEvent>) -> Option<Value> {
    let event = tokio::time::timeout(EVENT_TIMEOUT, events.recv())
        .await
        .ok()??;
    Some(serde_json::to_value(&event).unwrap_or_default())
}

/// Runs one scenario; returns the fake host's result file.
async fn run(
    name: &str,
    steps: &[Value],
    policy: &Value,
    fixtures: &Path,
    fake: &Path,
    out: &Path,
) -> Value {
    let transcript = fixtures.join(name).join("claude_transcript.ndjson");
    let entries = read_lines(&transcript);
    let meta = entries
        .iter()
        .find(|e| e["type"] == "transcript_start")
        .map(|e| e["metadata"].clone())
        .unwrap_or_default();
    let mut prompts: Vec<String> = entries
        .iter()
        .filter(|e| e["type"] == "expect_outbound" && e["frame"]["type"] == "prompt.offer")
        .filter_map(|e| match &e["frame"]["message"]["message"]["content"] {
            Value::String(text) => Some(text.clone()),
            Value::Array(blocks) => blocks
                .iter()
                .rev()
                .find_map(|b| b["text"].as_str().map(str::to_string)),
            _ => None,
        })
        .collect();
    prompts.reverse();
    let result_file = out.join(format!("{name}.json"));
    let _ = std::fs::remove_file(&result_file);
    let config = ClaudeConfig {
        helper: HelperCommand {
            program: "node".into(),
            args: vec![
                fake.to_string_lossy().into_owned(),
                transcript.to_string_lossy().into_owned(),
                result_file.to_string_lossy().into_owned(),
            ],
        },
        idle_timeout: None,
        ..ClaudeConfig::default()
    };
    let provider = ClaudeProvider::new("claudeAgent".into(), config);
    let mode = policy["runtimeMode"].as_str().unwrap_or("full-access");
    let interaction = policy["interactionMode"].as_str().unwrap_or("default");
    let model = json!({"instanceId": "claudeAgent", "model": meta["model"].as_str().unwrap_or("claude-sonnet-4-6")});
    let cwd = format!("/tmp/claude-replay-{name}");
    let mut policy = policy.clone();
    if let Some(map) = policy.as_object_mut() {
        map.insert("cwd".into(), json!(cwd));
    }
    let Ok(opened) = provider
        .open_session(OpenSessionInput {
            thread_id: "thread-replay".into(),
            provider_session_id: "provider-session-replay".into(),
            model_selection: from_json(model.clone()).unwrap_or_else(|e| panic!("{e}")),
            runtime_policy: from_json(policy.clone()).unwrap_or_else(|e| panic!("{e}")),
            resume_from_session: None,
            mcp_servers: vec![],
            host: None,
        })
        .await
    else {
        return json!({"error": "open_session failed"});
    };
    let (session, mut events) = (opened.session, opened.events);
    // The transcript's native session id, as T3's allocateSessionId gives it.
    let fresh = session
        .ensure_thread(EnsureThreadInput {
            thread_id: "thread-replay".into(),
            title: None,
            model_selection: from_json(model.clone()).unwrap_or_else(|e| panic!("{e}")),
            runtime_policy: from_json(policy.clone()).unwrap_or_else(|e| panic!("{e}")),
            existing_provider_thread: None,
        })
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let mut thread_json = to_json(&fresh);
    thread_json["nativeThreadRef"]["nativeId"] = meta["nativeSessionId"].clone();
    let mut thread: conn_contract::ProviderThread =
        from_json(thread_json).unwrap_or_else(|e| panic!("{e}"));
    let mut approvals: Vec<String> = steps
        .iter()
        .filter_map(|s| s.get("approve").and_then(Value::as_str).map(str::to_string))
        .rev()
        .collect();
    let mut n = 0;
    let mut index = 0;
    'steps: while index < steps.len() {
        let step = &steps[index];
        index += 1;
        if step != "message" {
            continue;
        }
        let Some(text) = prompts.pop() else {
            break;
        };
        n += 1;
        let interrupt = steps.get(index).and_then(|s| s.get("interrupt")).cloned();
        let input = TurnInput {
            app_thread: from_json(json!({
                "createdBy": "user", "creationSource": "web", "id": "thread-replay",
                "projectId": "project-replay", "title": name, "providerInstanceId": "claudeAgent",
                "modelSelection": model, "runtimeMode": mode, "interactionMode": interaction,
                "branch": null, "worktreePath": null, "activeProviderThreadId": null,
                "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "thread-replay"},
                "forkedFrom": null, "createdAt": "2026-11-13T00:00:00.000Z",
                "updatedAt": "2026-11-13T00:00:00.000Z", "archivedAt": null,
            }))
            .unwrap_or_else(|e| panic!("{e}")),
            thread_id: "thread-replay".into(),
            run_id: format!("run-{n}").as_str().into(),
            run_ordinal: n,
            provider_turn_ordinal: n,
            attempt_id: format!("attempt-{n}").as_str().into(),
            root_node_id: format!("node-{n}").as_str().into(),
            provider_thread: thread.clone(),
            message: TurnMessage {
                message_id: format!("message-{n}").as_str().into(),
                text,
                attachments: vec![],
            },
            model_selection: from_json(model.clone()).unwrap_or_else(|e| panic!("{e}")),
            runtime_policy: from_json(policy.clone()).unwrap_or_else(|e| panic!("{e}")),
        };
        if session.start_turn(input).await.is_err() {
            break;
        }
        let mut turn_id: Option<String> = None;
        let mut interrupt_pending = interrupt.is_some();
        loop {
            let Some(event) = next(&mut events).await else {
                break 'steps;
            };
            match event["type"].as_str() {
                Some("provider_thread.updated") => {
                    if let Ok(t) = from_json(event["providerThread"].clone()) {
                        thread = t;
                    }
                }
                Some("provider_turn.updated") => {
                    turn_id = event["providerTurn"]["id"].as_str().map(str::to_string);
                }
                Some("runtime_request.updated")
                    if event["runtimeRequest"]["status"] == "pending" =>
                {
                    let decision = approvals.pop().unwrap_or_else(|| "accept".into());
                    let _ = session
                        .respond_to_runtime_request(RuntimeRequestResponse {
                            request_id: event["runtimeRequest"]["id"]
                                .as_str()
                                .unwrap_or_default()
                                .into(),
                            decision: from_json(json!(decision)).ok(),
                            feedback: None,
                            answers: None,
                        })
                        .await;
                }
                Some("turn.terminal") => break,
                _ => {}
            }
            let wanted = interrupt.as_ref().and_then(Value::as_str);
            let ready = match wanted {
                None => turn_id.is_some(),
                Some(kind) => {
                    event["type"] == "turn_item.updated" && event["turnItem"]["type"] == kind
                }
            };
            if interrupt_pending
                && ready
                && let Some(id) = &turn_id
            {
                interrupt_pending = false;
                let _ = session
                    .interrupt_turn(InterruptInput {
                        provider_thread: thread.clone(),
                        provider_turn_id: id.as_str().into(),
                    })
                    .await;
            }
        }
    }
    session.close().await;
    // The fake host writes its result as it exits.
    for _ in 0..50 {
        if let Ok(text) = std::fs::read_to_string(&result_file)
            && let Ok(value) = serde_json::from_str::<Value>(&text)
        {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    json!({"error": "no result from the fake host"})
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [fixtures, fake, scenarios, policies, out, only @ ..] = args.as_slice() else {
        eprintln!(
            "usage: t3_replay <fixtures-dir> <fake-host.mjs> <scenarios.json> <policies.json> <out-dir> [scenario...]"
        );
        std::process::exit(2);
    };
    let spec: Value = serde_json::from_str(&std::fs::read_to_string(scenarios).unwrap_or_default())
        .unwrap_or_else(|e| panic!("{scenarios}: {e}"));
    let policies: Value =
        serde_json::from_str(&std::fs::read_to_string(policies).unwrap_or_default())
            .unwrap_or_else(|e| panic!("{policies}: {e}"));
    let _ = std::fs::create_dir_all(out);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| panic!("{e}"));
    let mut failed = 0;
    runtime.block_on(async {
        for (name, steps) in spec["scenarios"].as_object().into_iter().flatten() {
            if !only.is_empty() && !only.iter().any(|o| o == name) {
                continue;
            }
            let steps = steps.as_array().cloned().unwrap_or_default();
            let Some(policy) = policies.get(name) else {
                failed += 1;
                println!("FAIL {name} at entry 0 of 0: T3's fixture table has no Claude scenario of this name");
                continue;
            };
            let result = run(
                name,
                &steps,
                policy,
                Path::new(fixtures),
                Path::new(fake),
                Path::new(out),
            )
            .await;
            let pass = result["done"] == json!(true) && result["mismatch"].is_null();
            if pass {
                println!("PASS {name} ({} entries)", result["total"]);
            } else {
                failed += 1;
                println!(
                    "FAIL {name} at entry {} of {}: {}",
                    result["cursor"],
                    result["total"],
                    if result["mismatch"].is_null() {
                        result
                            .get("error")
                            .cloned()
                            .unwrap_or(json!("the replay stopped early"))
                            .to_string()
                    } else {
                        result["mismatch"].to_string()
                    }
                );
            }
        }
    });
    if failed > 0 {
        std::process::exit(1);
    }
}
