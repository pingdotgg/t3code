//! The Rust side of `tools/probe-conformance.mjs`: runs our Grok status probe for each
//! scenario of the plan, with the stub CLI as the binary, and writes the entry it builds.
//!
//! `cargo run -p conn-provider-acp --example grok_probe -- <plan.json>`
//!
//! Scenarios run at the same time, as the T3 side runs them, so the timeouts overlap.

use std::path::Path;

use conn_provider_acp::status_testing::{GrokSettings, check};
use serde_json::Value;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let plan_path = std::env::args()
        .nth(1)
        .expect("usage: grok_probe <plan.json>");
    let plan: Value = serde_json::from_str(&std::fs::read_to_string(&plan_path).expect("plan"))
        .expect("plan json");
    let base: Vec<(String, String)> = std::env::vars().collect();
    if let Some(path) = plan["parentEnv"].as_str() {
        let env: serde_json::Map<String, Value> = base
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        std::fs::write(path, Value::Object(env).to_string()).expect("parent env");
    }
    let server_cwd = std::env::current_dir().expect("cwd");
    if let Some(path) = plan["serverCwd"].as_str() {
        std::fs::write(path, server_cwd.display().to_string()).expect("server cwd");
    }
    let runs = plan["scenarios"]
        .as_array()
        .expect("scenarios")
        .iter()
        .map(|scenario| {
            let scenario = scenario.clone();
            let base = base.clone();
            let server_cwd = server_cwd.clone();
            async move {
                let instance = &scenario["rustInstance"];
                let settings = GrokSettings::from_instance(Some(instance));
                let workspace = scenario["workspace"].as_str().map(Path::new);
                let entry = check(
                    "grok",
                    &settings,
                    &base,
                    &server_cwd,
                    workspace,
                    "<checkedAt>",
                )
                .await;
                let out = scenario["rustOut"].as_str().expect("rustOut");
                std::fs::write(out, serde_json::to_string_pretty(&entry).expect("json"))
                    .expect("write entry");
            }
        });
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let handles: Vec<_> = runs.map(tokio::task::spawn_local).collect();
            for handle in handles {
                handle.await.expect("scenario task");
            }
        })
        .await;
}
