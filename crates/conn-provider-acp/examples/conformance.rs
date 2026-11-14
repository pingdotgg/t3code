//! The Rust side of `tools/conformance.mjs`: replays T3's adapter calls for each scenario
//! through `AcpProvider`, with the real process spawn and the stub agent as its binary.
//!
//! `cargo run -p conn-provider-acp --example conformance -- <plan.json>`
//!
//! The plan lists scenarios: the golden file (T3's calls), the stub wrapper to use as the
//! binary, and the workspace folder. Each scenario runs the calls in order, waits for the
//! agent to go quiet between them, and closes the session at the end, as T3's fixture scope
//! does.

use std::time::Duration;

use conn_contract::from_json;
use conn_provider::{
    EnsureThreadInput, InterruptInput, OpenSessionInput, Provider, RuntimeRequestResponse,
};
use conn_provider_acp::{AcpConfig, AcpProvider, GROK, testing::turn_input};
use serde_json::Value;

fn field<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    from_json(v.clone()).expect("a T3 call input field")
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let plan_path = std::env::args()
        .nth(1)
        .expect("usage: conformance <plan.json>");
    let plan: Value = serde_json::from_str(&std::fs::read_to_string(&plan_path).expect("plan"))
        .expect("plan json");
    // The tool compares the stub's environment with the one it inherits from here.
    if let Some(path) = plan["parentEnv"].as_str() {
        let env: serde_json::Map<String, Value> = std::env::vars()
            .map(|(k, v)| (k, Value::String(v)))
            .collect();
        std::fs::write(path, Value::Object(env).to_string()).expect("parent env");
    }
    for scenario in plan["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().unwrap_or("?");
        let golden: Value = serde_json::from_str(
            &std::fs::read_to_string(scenario["golden"].as_str().expect("golden")).expect("golden"),
        )
        .expect("golden json");
        // T3's calls name T3's workspace; ours runs in its own.
        let ts_workspace = golden["calls"][0]["input"]["runtimePolicy"]["cwd"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let workspace = scenario["workspace"].as_str().expect("workspace");
        let calls: Value = serde_json::from_str(
            &golden["calls"]
                .to_string()
                .replace(&ts_workspace, workspace),
        )
        .expect("calls");
        let provider = AcpProvider::new(
            "grok".into(),
            &GROK,
            AcpConfig {
                binary: scenario["binary"].as_str().expect("binary").to_owned(),
                environment: Vec::new(),
                ..AcpConfig::default()
            },
        );
        if let Err(error) = run(&provider, calls.as_array().cloned().unwrap_or_default()).await {
            eprintln!("{name}: {error}");
        }
    }
}

async fn run(provider: &AcpProvider, calls: Vec<Value>) -> Result<(), String> {
    let open = calls
        .iter()
        .find(|c| c["method"] == "openSession")
        .ok_or("no openSession")?;
    let input = &open["input"];
    let opened = provider
        .open_session(OpenSessionInput {
            thread_id: field(&input["threadId"]),
            provider_session_id: field(&input["providerSessionId"]),
            model_selection: field(&input["modelSelection"]),
            runtime_policy: field(&input["runtimePolicy"]),
            resume_from_session: None,
            mcp_servers: Vec::new(),
            host: None,
        })
        .await
        .map_err(|e| format!("open: {e}"))?;
    let session = opened.session;
    let mut events = opened.events;
    let mut pending: Vec<String> = Vec::new();
    let mut answered = 0usize;
    // Collects events until none came for `quiet`.
    async fn drain(
        events: &mut tokio::sync::mpsc::Receiver<conn_provider::ProviderEvent>,
        pending: &mut Vec<String>,
        quiet: Duration,
    ) {
        while let Ok(Some(event)) = tokio::time::timeout(quiet, events.recv()).await {
            let value = serde_json::to_value(&event).unwrap_or(Value::Null);
            if value["type"] == "runtime_request.updated"
                && value["runtimeRequest"]["status"] == "pending"
                && let Some(id) = value["runtimeRequest"]["id"].as_str()
            {
                pending.push(id.to_owned());
            }
        }
    }
    for call in &calls {
        drain(&mut events, &mut pending, Duration::from_millis(400)).await;
        let input = &call["input"];
        match call["method"].as_str().unwrap_or("") {
            "ensureThread" => {
                session
                    .ensure_thread(EnsureThreadInput {
                        thread_id: field(&input["threadId"]),
                        title: input["title"].as_str().map(str::to_owned),
                        model_selection: field(&input["modelSelection"]),
                        runtime_policy: field(&input["runtimePolicy"]),
                        existing_provider_thread: None,
                    })
                    .await
                    .map_err(|e| format!("ensureThread: {e}"))?;
            }
            "startTurn" => session
                .start_turn(turn_input(input))
                .await
                .map_err(|e| format!("startTurn: {e}"))?,
            // T3's `compactThread` starts the turn with the text `/compact`.
            "compactThread" => {
                let mut input = input.clone();
                input["message"]["text"] = Value::from("/compact");
                session
                    .start_turn(turn_input(&input))
                    .await
                    .map_err(|e| format!("compactThread: {e}"))?;
            }
            "respondToRuntimeRequest" => {
                let id = pending.get(answered).cloned().ok_or("no pending request")?;
                answered += 1;
                session
                    .respond_to_runtime_request(RuntimeRequestResponse {
                        request_id: id.as_str().into(),
                        decision: from_json(input["decision"].clone()).ok(),
                        feedback: None,
                        answers: from_json(input["answers"].clone()).ok(),
                    })
                    .await
                    .map_err(|e| format!("respond: {e}"))?;
            }
            "interruptTurn" => {
                let _ = session
                    .interrupt_turn(InterruptInput {
                        provider_thread: field(&input["providerThread"]),
                        provider_turn_id: field(&input["providerTurnId"]),
                    })
                    .await;
            }
            _ => {}
        }
    }
    drain(&mut events, &mut pending, Duration::from_millis(400)).await;
    session.close().await;
    Ok(())
}
