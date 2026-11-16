//! Our half of `tools/probe-conformance/run.mjs`: runs Codex's status probe
//! ([`conn_provider_codex::status::check`]) for every scenario of a plan, against stub CLIs,
//! all at once (as T3's side runs them), and writes each entry.
//!
//! `cargo run -p conn-provider-codex --example codex_probe -- <plan.json> <out.json>`
//!
//! The plan: `{"cwdOut": <file>, "scenarios": [{"name", "instance"}]}`. Each scenario's
//! `instance` is a `providerInstances` entry; the environment is this process's own, and
//! the working folder (written to `cwdOut`) is the probe's, as T3's `process.cwd()`.

#![expect(
    clippy::print_stderr,
    reason = "a test tool: its errors go to the check's log"
)]

use conn_provider_codex::CodexConfig;
use conn_provider_codex::status::{ProbeInput, StatusSettings, check};
use serde_json::{Map, Value};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(plan_path), Some(out_path)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: codex_probe <plan.json> <out.json>");
        std::process::exit(2);
    };
    let plan: Value = match std::fs::read_to_string(plan_path)
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
    {
        Ok(plan) => plan,
        Err(e) => {
            eprintln!("{plan_path}: {e}");
            std::process::exit(2);
        }
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    if let Some(out) = plan["cwdOut"].as_str() {
        let _ = std::fs::write(out, cwd.to_string_lossy().as_bytes());
    }
    let host_env = conn_support::login_env::child_env();
    let mut tasks = Vec::new();
    for scenario in plan["scenarios"].as_array().into_iter().flatten() {
        let name = scenario["name"].as_str().unwrap_or("unnamed").to_owned();
        let instance = scenario.get("instance").cloned();
        let (cwd, host_env) = (cwd.clone(), host_env.clone());
        tasks.push(tokio::spawn(async move {
            // The server's path: the instance entry over the defaults.
            let config = CodexConfig::default().with_instance(instance.as_ref());
            let settings = StatusSettings::from_instance(instance.as_ref());
            let input = ProbeInput {
                instance_id: "codex",
                config: &config,
                settings: &settings,
                host_env,
                cwd,
                checked_at: "2026-01-01T00:00:00.000Z".to_owned(),
            };
            (name, check(input).await)
        }));
    }
    let mut results = Map::new();
    for task in tasks {
        match task.await {
            Ok((name, entry)) => {
                results.insert(name, entry);
            }
            Err(e) => eprintln!("codex_probe: a scenario failed: {e}"),
        }
    }
    if let Err(e) = std::fs::write(out_path, Value::Object(results).to_string()) {
        eprintln!("{out_path}: {e}");
        std::process::exit(2);
    }
}
