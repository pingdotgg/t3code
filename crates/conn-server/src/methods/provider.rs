//! `provider.*` methods (provider status, models, sign-in, install).
//!
//! No `provider.*` method gates a turn. The client reads providers and their models from
//! `ServerConfig.providers`, which `subscribeServerConfig` delivers at connect, and refreshes
//! them with `server.refreshProviders` (`methods/server.rs`). A provider entry must be enabled,
//! installed and `status: "ready"` (`apps/web/src/providerInstances.ts`), or the composer has
//! no model to send with. [`server_providers`] builds those entries; each provider crate adds
//! its own line there.
//!
//! In an Orbit container the provider CLIs come from Orbit's read-only agent folder and reach
//! models through Orbit's AI router (`ANTHROPIC_BASE_URL`, `~/.codex/config.toml`), so nobody
//! signs in or installs anything. Settings › Providers still subscribes to each instance's
//! sign-in and install state; those streams answer "idle" so the page renders. The flows
//! themselves (`provider.auth.start|respond|complete|cancel|logout|removeMethod`,
//! `provider.install.start|cancel|remove`, ChatGPT profiles, `uploadFeedback`,
//! `consumeResetCredit`) stay unregistered and answer "not supported".

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::Deps;
use crate::table::{Failure, MethodTable};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupInput {
    instance_id: String,
}

pub fn register(table: &mut MethodTable, deps: &Deps) {
    table.stream(
        "provider.auth.subscribe",
        |ctx, input: SetupInput| async move {
            super::server::require(&ctx, "providers:manage")?;
            // `credentialOwner: provider`: the CLI holds its own credentials (or the router's key).
            Ok(open_with(json!({
                "instanceId": input.instance_id,
                "phase": "idle",
                "flowId": null,
                "authorizationUrl": null,
                "expiresAt": null,
                "message": null,
                "interaction": null,
                "credentialOwner": "provider",
            })))
        },
    );
    let deps = deps.clone();
    table.stream(
        "provider.install.subscribe",
        move |ctx, input: SetupInput| {
            let driver = deps
                .providers
                .iter()
                .find(|p| p.instance_id().as_str() == input.instance_id)
                .map(|p| p.driver().to_owned())
                .unwrap_or_else(|| input.instance_id.clone());
            async move {
                super::server::require(&ctx, "orchestration:read")?;
                Ok(open_with(json!({
                    "driver": driver,
                    "operationId": null,
                    "phase": "idle",
                    "downloadedBytes": 0,
                    "totalBytes": null,
                    "version": null,
                    "installedVersion": null,
                    "source": "local",
                    "canRemove": false,
                    "message": null,
                })))
            }
        },
    );
}

/// One state, then open until the client unsubscribes.
fn open_with(state: Value) -> mpsc::Receiver<Result<Value, Failure>> {
    let (tx, rx) = mpsc::channel(1);
    tx.try_send(Ok(state)).expect("room for the first state");
    tokio::spawn(async move { tx.closed().await });
    rx
}

/// `ServerConfig.providers` entries for the configured providers. `checked_at` is ISO-8601.
pub fn server_providers(deps: &Deps, checked_at: &str) -> Vec<Value> {
    deps.providers
        .iter()
        .filter(|p| p.driver() == conn_provider_claude::DRIVER)
        .map(|p| conn_provider_claude::server_provider_entry(p.instance_id().as_str(), checked_at))
        .chain(
            deps.providers
                .iter()
                .filter_map(|p| p.server_provider_entry(checked_at)),
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use conn_provider_claude::{ClaudeConfig, ClaudeProvider};

    use super::*;

    #[test]
    fn a_claude_instance_is_offered_ready_with_models() {
        let deps = Deps {
            engine: None,
            providers: vec![Arc::new(ClaudeProvider::new(
                "claudeAgent".into(),
                ClaudeConfig::default(),
            ))],
            ..Deps::default()
        };
        let entries = server_providers(&deps, "2026-11-13T00:00:00.000Z");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry["instanceId"], "claudeAgent");
        assert_eq!(entry["driver"], "claudeAgent");
        assert_eq!(entry["status"], "ready");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["installed"], true);
        assert!(!entry["models"].as_array().unwrap().is_empty());
    }
}
