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

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

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
        |_, input: SetupInput| async move {
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
    table.stream("provider.install.subscribe", move |_, input: SetupInput| {
        let driver = deps
            .providers
            .iter()
            .find(|p| p.instance_id().as_str() == input.instance_id)
            .map(|p| p.driver().to_owned())
            .unwrap_or_else(|| input.instance_id.clone());
        async move {
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
    });
}

/// One state, then open until the client unsubscribes.
fn open_with(state: Value) -> mpsc::Receiver<Result<Value, Failure>> {
    let (tx, rx) = mpsc::channel(1);
    tx.try_send(Ok(state)).expect("room for the first state");
    tokio::spawn(async move { tx.closed().await });
    rx
}

/// Tells config streams that a provider entry changed (T3's `ProviderRegistry.streamChanges`).
#[derive(Clone, Debug)]
pub struct ProviderStatus(Arc<watch::Sender<u64>>);

impl Default for ProviderStatus {
    fn default() -> Self {
        Self(Arc::new(watch::channel(0).0))
    }
}

impl ProviderStatus {
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.0.subscribe()
    }

    fn bump(&self) {
        self.0
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }
}

/// `DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL`.
const DEFAULT_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The `providerInstances[id]` entry from the stored settings.
fn instance_settings(deps: &Deps, instance_id: &str) -> Option<Value> {
    let settings = deps.environment.as_ref()?.settings.raw();
    settings.get("providerInstances")?.get(instance_id).cloned()
}

/// `providerHealthRefreshInterval` (milliseconds); `None` turns the periodic probe off.
fn refresh_interval(deps: &Deps) -> Option<Duration> {
    let Some(environment) = deps.environment.as_ref() else {
        return Some(DEFAULT_REFRESH_INTERVAL);
    };
    match environment
        .settings
        .raw()
        .get("providerHealthRefreshInterval")
        .and_then(Value::as_f64)
    {
        None => Some(DEFAULT_REFRESH_INTERVAL),
        Some(ms) if ms > 0.0 && ms.is_finite() => Some(Duration::from_millis(ms as u64)),
        Some(_) => None,
    }
}

/// Probes the providers (all, or the one named) with their current settings, then tells the
/// config streams.
pub async fn refresh(deps: &Deps, only: Option<&str>) {
    for provider in &deps.providers {
        let id = provider.instance_id().as_str();
        if only.is_some_and(|only| only != id) {
            continue;
        }
        provider.refresh_status(instance_settings(deps, id)).await;
    }
    deps.provider_status.bump();
}

/// T3's managed provider loop: probe once the server listens, again when an instance's
/// settings entry changes, and every `providerHealthRefreshInterval` (5 minutes by default).
/// Not ported: the background-work demand gate (T3 skips the periodic probe while no client
/// wants background work) and the 30 s recheck after a failed check.
pub fn start_status_refresh(deps: &Deps) {
    let deps = deps.clone();
    tokio::spawn(async move {
        let mut settings = deps.environment.as_ref().map(|e| e.settings.subscribe());
        let snapshot = |deps: &Deps| -> Vec<Option<Value>> {
            deps.providers
                .iter()
                .map(|p| instance_settings(deps, p.instance_id().as_str()))
                .collect()
        };
        let mut last = snapshot(&deps);
        refresh(&deps, None).await;
        loop {
            let interval = refresh_interval(&deps);
            let changed = async {
                match settings.as_mut() {
                    Some(rx) => rx.changed().await.is_ok(),
                    None => std::future::pending().await,
                }
            };
            let tick = async {
                match interval {
                    Some(interval) => tokio::time::sleep(interval).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                alive = changed => {
                    if !alive {
                        return;
                    }
                    let next = snapshot(&deps);
                    for (provider, (before, after)) in deps.providers.iter().zip(last.iter().zip(&next)) {
                        if before != after {
                            provider.refresh_status(after.clone()).await;
                            deps.provider_status.bump();
                        }
                    }
                    last = next;
                }
                () = tick => refresh(&deps, None).await,
            }
        }
    });
}

/// `ServerConfig.providers` entries for the configured providers. `checked_at` is ISO-8601.
pub fn server_providers(deps: &Deps, checked_at: &str) -> Vec<Value> {
    deps.providers
        .iter()
        .filter_map(|p| p.server_provider_entry(checked_at))
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

    /// T3's default `grok` instance: listed, off, and probed with nothing until settings
    /// enable it. A refresh tells the config streams.
    #[tokio::test]
    async fn the_default_grok_instance_is_listed_disabled() {
        use conn_provider_acp::{AcpConfig, AcpProvider, GROK, GrokSettings};
        let deps = Deps {
            providers: vec![Arc::new(AcpProvider::with_settings(
                "grok".into(),
                &GROK,
                AcpConfig::default(),
                GrokSettings::default(),
            ))],
            ..Deps::default()
        };
        let changes = deps.provider_status.subscribe();
        refresh(&deps, None).await;
        assert!(changes.has_changed().unwrap());
        let entries = server_providers(&deps, "2026-11-14T00:00:00.000Z");
        let entry = &entries[0];
        assert_eq!(entry["instanceId"], "grok");
        assert_eq!(entry["status"], "disabled");
        assert_eq!(entry["enabled"], false);
        assert_eq!(entry["message"], "Grok is disabled in T3 Code settings.");
        let _: conn_contract::ServerProvidersItemItem =
            conn_contract::from_json(entry.clone()).unwrap();
    }
}
