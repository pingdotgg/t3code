//! Our half of `tools/probe-conformance/run.mjs`: runs Claude's status probe
//! ([`conn_provider_claude::status::check`]) for every scenario of a plan, against stub CLIs,
//! with the SDK host of this checkout, and writes each entry.
//!
//! `cargo run -p conn-provider-claude --example claude_probe -- <plan.json> <out.json>`
//!
//! The plan: `{"baseEnv": {..}, "scenarios": [{"name", "instance", "cwd"}]}`. Each scenario's
//! `instance` is a `providerInstances` entry whose `config.binaryPath` names its stub.

#![expect(
    clippy::print_stderr,
    reason = "a test tool: its errors go to the check's log"
)]

use conn_provider::Provider;
use conn_provider_claude::status::{ProbeInput, StatusSettings, check};
use conn_provider_claude::{ClaudeConfig, ClaudeProvider, HelperCommand, helper};
use serde_json::{Map, Value, json};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(plan_path), Some(out_path)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: claude_probe <plan.json> <out.json>");
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
    let base_env: Vec<(String, String)> = plan["baseEnv"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect();
    let host = helper::claude_host(HelperCommand::discover(), "claudeAgent");
    let mut results = Map::new();
    for scenario in plan["scenarios"].as_array().into_iter().flatten() {
        let name = scenario["name"].as_str().unwrap_or("unnamed").to_owned();
        let settings = StatusSettings::from_instance(scenario.get("instance"));
        if scenario["title"].is_object() {
            results.insert(name, title(scenario, &settings).await);
            continue;
        }
        let input = ProbeInput {
            instance_id: "claudeAgent",
            settings: &settings,
            host_env: base_env.clone(),
            settings_entrypoint: None,
            settings_base_url: None,
            cwd: scenario["cwd"].as_str().map(std::path::PathBuf::from),
            checked_at: "2026-01-01T00:00:00.000Z".to_owned(),
            manifest: &Default::default(),
        };
        let host = &host;
        let entry = check(input, |options, extra, timeout| async move {
            host.function("probeCapabilities", json!([options, extra]), None, timeout)
                .await
                .map_err(|e| e.to_string())
        })
        .await;
        results.insert(name, entry);
    }
    host.stop().await;
    if let Err(e) = std::fs::write(out_path, Value::Object(results).to_string()) {
        eprintln!("{out_path}: {e}");
        std::process::exit(2);
    }
}

/// A thread title through [`Provider::generate_text`], with the prompt and schema T3's side
/// built for the same message.
async fn title(scenario: &Value, settings: &StatusSettings) -> Value {
    let t3: Value = scenario["tsOut"]
        .as_str()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    // The server's path: the instance entry applied to the defaults.
    let _ = settings;
    let config = ClaudeConfig::default().with_instance(scenario.get("instance"));
    let provider = ClaudeProvider::new("claudeAgent".into(), config);
    let selection = match serde_json::from_value(scenario["title"]["modelSelection"].clone()) {
        Ok(selection) => selection,
        Err(e) => return json!({"ok": false, "title": null, "failure": format!("selection: {e}")}),
    };
    let guide = scenario["title"]["guide"] == true;
    let request = conn_provider::TextGenerationRequest {
        operation: if guide {
            "generateReviewGuide"
        } else {
            "generateThreadTitle"
        }
        .into(),
        cwd: scenario["cwd"].as_str().unwrap_or_default().to_owned(),
        prompt: t3["request"]["prompt"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        output_schema: t3["request"]["outputSchema"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        model_selection: selection,
        image_paths: Vec::new(),
        // `INVESTIGATION_TIMEOUT_MS` for a review guide.
        timeout: guide.then(|| std::time::Duration::from_secs(15 * 60)),
        investigate: guide,
    };
    match provider.generate_text(request).await {
        Ok(output) if guide => json!({"ok": true, "title": output, "failure": null}),
        Ok(output) => json!({"ok": true, "title": output["title"], "failure": null}),
        Err(conn_provider::ProviderError::Failed { detail, .. }) => {
            json!({"ok": false, "title": null, "failure": detail})
        }
        Err(e) => json!({"ok": false, "title": null, "failure": e.to_string()}),
    }
}
