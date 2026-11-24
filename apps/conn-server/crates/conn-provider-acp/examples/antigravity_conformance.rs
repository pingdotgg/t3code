//! The Rust side of `tools/antigravity-conformance.mjs`: runs each scenario on
//! `AntigravityProvider` with the stub `agy` as its binary, as the T3 side runs T3's driver
//! and adapter.
//!
//! `cargo run -p conn-provider-acp --example antigravity_conformance -- <plan.json>`

use std::time::Duration;

use conn_contract::from_json;
use conn_provider::{EnsureThreadInput, OpenSessionInput, Provider};
use conn_provider_acp::{AntigravityConfig, AntigravityProvider, testing::turn_input};
use serde_json::{Value, json};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let plan_path = std::env::args()
        .nth(1)
        .expect("usage: antigravity_conformance <plan.json>");
    let plan: Value = serde_json::from_str(&std::fs::read_to_string(&plan_path).expect("plan"))
        .expect("plan json");
    if let Some(path) = plan["parentEnv"].as_str() {
        let env: serde_json::Map<String, Value> = std::env::vars()
            .map(|(k, v)| (k, Value::String(v)))
            .collect();
        std::fs::write(path, Value::Object(env).to_string()).expect("parent env");
    }
    for scenario in plan["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().unwrap_or("?");
        if let Err(error) = run(scenario).await {
            eprintln!("{name}: {error}");
        }
    }
}

fn policy(scenario: &Value, runtime_mode: &str) -> Value {
    json!({
        "runtimeMode": runtime_mode,
        "interactionMode": "default",
        "cwd": scenario["rust"]["workspace"],
    })
}

/// `makeTurnInput` of T3's ACP adapter testkit.
fn turn(
    scenario: &Value,
    thread: &Value,
    ordinal: u64,
    text: &str,
    model: &str,
    mode: &str,
) -> Value {
    let thread_id = "thread-agy-conformance";
    let suffix = format!("{thread_id}:{ordinal}");
    let selection = json!({"instanceId": "antigravity", "model": model});
    json!({
        "appThread": {
            "createdBy": "user", "creationSource": "web", "id": thread_id,
            "projectId": format!("project:{thread_id}"), "title": "ACP adapter test",
            "providerInstanceId": "antigravity", "modelSelection": selection,
            "runtimeMode": "approval-required", "interactionMode": "default",
            "branch": null, "worktreePath": null, "activeProviderThreadId": thread["id"],
            "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": thread_id},
            "forkedFrom": null, "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z", "archivedAt": null, "settledOverride": null,
            "settledAt": null, "lastVisitedAt": null, "deletedAt": null,
        },
        "threadId": thread_id,
        "runId": format!("run:{suffix}"),
        "runOrdinal": ordinal,
        "providerTurnOrdinal": ordinal,
        "attemptId": format!("attempt:{suffix}"),
        "rootNodeId": format!("node:{suffix}"),
        "providerThread": thread,
        "message": {
            "createdBy": "user", "creationSource": "web",
            "messageId": format!("message:{suffix}"), "text": text, "attachments": [],
        },
        "modelSelection": selection,
        "runtimePolicy": policy(scenario, mode),
    })
}

async fn run(scenario: &Value) -> Result<(), String> {
    let state = scenario["rust"]["state"].as_str().ok_or("state")?;
    let attachments = std::path::Path::new(state).join("attachments");
    std::fs::create_dir_all(&attachments).map_err(|e| e.to_string())?;
    let entry = json!({
        "driver": "antigravity",
        "enabled": true,
        "config": {
            "authMethod": "gemini-api-key",
            "apiKey": scenario["apiKey"],
            "binaryPath": scenario["rust"]["binary"],
        },
    });
    let provider = AntigravityProvider::for_instance(
        "antigravity".into(),
        AntigravityConfig {
            state_dir: state.into(),
            attachments_dir: Some(attachments),
            self_command: Some("/conn-server".into()),
            model_manifest: Default::default(),
            status_notifier: Default::default(),
        },
        Some(&entry),
    );
    let turns = scenario["turns"].as_array().ok_or("turns")?;
    let first = turns.first().ok_or("no turns")?;
    let model = |t: &Value| t["model"].as_str().unwrap_or("").to_owned();
    let mode = |t: &Value| {
        t["runtimeMode"]
            .as_str()
            .unwrap_or("full-access")
            .to_owned()
    };
    let selection = |m: &str| from_json(json!({"instanceId": "antigravity", "model": m}));
    let opened = provider
        .open_session(OpenSessionInput {
            thread_id: "thread-agy-conformance".into(),
            provider_session_id: "provider-session-agy-conformance".into(),
            model_selection: selection(&model(first)).map_err(|e| e.to_string())?,
            runtime_policy: from_json(policy(scenario, &mode(first))).map_err(|e| e.to_string())?,
            resume_from_session: None,
            mcp_servers: Vec::new(),
            host: None,
        })
        .await
        .map_err(|e| format!("open: {e}"))?;
    let session = opened.session;
    let mut events = opened.events;
    let thread = session
        .ensure_thread(EnsureThreadInput {
            thread_id: "thread-agy-conformance".into(),
            model_selection: selection(&model(first)).map_err(|e| e.to_string())?,
            runtime_policy: from_json(policy(scenario, &mode(first))).map_err(|e| e.to_string())?,
            existing_provider_thread: None,
            title: None,
        })
        .await
        .map_err(|e| format!("ensure: {e}"))?;
    let thread = serde_json::to_value(&thread).map_err(|e| e.to_string())?;
    for (index, t) in turns.iter().enumerate() {
        let ordinal = u64::try_from(index).unwrap_or(0) + 1;
        let input = turn(
            scenario,
            &thread,
            ordinal,
            t["text"].as_str().unwrap_or(""),
            &model(t),
            &mode(t),
        );
        session
            .start_turn(turn_input(&input))
            .await
            .map_err(|e| format!("turn {ordinal}: {e}"))?;
        loop {
            let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
                .await
                .map_err(|_| format!("turn {ordinal}: no terminal"))?
                .ok_or("events ended")?;
            let value = serde_json::to_value(&event).unwrap_or(Value::Null);
            if value["type"] == "turn.terminal" {
                break;
            }
        }
    }
    session.close().await;
    Ok(())
}
