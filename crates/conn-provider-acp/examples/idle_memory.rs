//! The live heap one idle ACP session holds on our side: a Grok session against the stub agent
//! of `tools/conformance.mjs`, after one finished turn.
//!
//! `node crates/conn-provider-acp/tools/conformance.mjs --keep simple` keeps a work folder with
//! a `plan.json`; then
//! `cargo run -p conn-provider-acp --example idle_memory -- <work>/plan.json [scenario]`.
//!
//! Prints the live heap bytes before the session opens, while it is idle after the turn, and
//! after it closes. The agent process is not counted: it is the stub, not Grok.

#![expect(
    clippy::print_stdout,
    reason = "a measuring tool: its result goes to the terminal"
)]

use std::alloc::System;
use std::time::Duration;

use conn_contract::from_json;
use conn_provider::{EnsureThreadInput, OpenSessionInput, Provider};
use conn_provider_acp::{AcpConfig, AcpProvider, GROK, testing::turn_input};
use serde_json::Value;
use stats_alloc::{INSTRUMENTED_SYSTEM, StatsAlloc};

#[global_allocator]
static ALLOCATOR: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;

fn live() -> isize {
    let stats = ALLOCATOR.stats();
    stats.bytes_allocated.cast_signed() - stats.bytes_deallocated.cast_signed()
}

fn field<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    from_json(v.clone()).expect("a T3 call input field")
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let plan_path = args
        .next()
        .expect("usage: idle_memory <plan.json> [scenario]");
    let wanted = args.next().unwrap_or_else(|| "simple".into());
    let plan: Value =
        serde_json::from_str(&std::fs::read_to_string(&plan_path).expect("plan")).expect("json");
    let scenario = plan["scenarios"]
        .as_array()
        .expect("scenarios")
        .iter()
        .find(|s| s["name"] == wanted.as_str())
        .expect("the scenario is in the plan");
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(scenario["golden"].as_str().expect("golden")).expect("golden"),
    )
    .expect("golden json");
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
    let calls = calls.as_array().cloned().unwrap_or_default();
    let call = |method: &str| {
        calls
            .iter()
            .find(|c| c["method"] == method)
            .map(|c| c["input"].clone())
            .expect("the call is recorded")
    };
    let provider = AcpProvider::new(
        "grok".into(),
        &GROK,
        AcpConfig {
            binary: scenario["binary"].as_str().expect("binary").to_owned(),
            ..AcpConfig::default()
        },
    );
    let before = live();
    let open = call("openSession");
    let opened = provider
        .open_session(OpenSessionInput {
            thread_id: field(&open["threadId"]),
            provider_session_id: field(&open["providerSessionId"]),
            model_selection: field(&open["modelSelection"]),
            runtime_policy: field(&open["runtimePolicy"]),
            resume_from_session: None,
            mcp_servers: Vec::new(),
            host: None,
        })
        .await
        .expect("open");
    let session = opened.session;
    let mut events = opened.events;
    let ensure = call("ensureThread");
    session
        .ensure_thread(EnsureThreadInput {
            thread_id: field(&ensure["threadId"]),
            title: ensure["title"].as_str().map(str::to_owned),
            model_selection: field(&ensure["modelSelection"]),
            runtime_policy: field(&ensure["runtimePolicy"]),
            existing_provider_thread: None,
        })
        .await
        .expect("ensureThread");
    session
        .start_turn(turn_input(&call("startTurn")))
        .await
        .expect("startTurn");
    // The engine reads every event; so does this tool, until the turn ends.
    loop {
        let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
            .await
            .expect("the turn ends")
            .expect("events");
        if serde_json::to_value(&event).unwrap_or(Value::Null)["type"] == "turn.terminal" {
            break;
        }
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let idle = live();
    session.close().await;
    drop(session);
    drop(events);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let closed = live();
    println!(
        "{wanted}: live heap before open {before} B, idle after one turn {idle} B (+{} B), after close {closed} B (+{} B)",
        idle - before,
        closed - before
    );
}
