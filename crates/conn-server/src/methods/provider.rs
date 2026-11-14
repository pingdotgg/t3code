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

/// `FAILED_CHECK_RECHECK_DELAY`.
const FAILED_CHECK_RECHECK: Duration = Duration::from_secs(30);

/// The periodic probe: each provider on its own rule (`refreshOnInterval`); `recheck` is the
/// probe 30 s after a deferred failure. Returns whether a provider asks for that recheck.
async fn refresh_on_interval(deps: &Deps, recheck: bool) -> bool {
    let mut again = false;
    for provider in &deps.providers {
        let id = provider.instance_id().as_str();
        again |= provider
            .refresh_status_on_interval(instance_settings(deps, id), !recheck)
            .await;
    }
    deps.provider_status.bump();
    again
}

/// T3's managed provider loop: probe once the server listens, again when an instance's
/// settings entry changes, and every `providerHealthRefreshInterval` (5 minutes by default).
/// A failed periodic check over a ready provider is rechecked after 30 s before it shows
/// (`FAILED_CHECK_RECHECK_DELAY`), and a disabled instance is not probed on the interval.
/// Not ported: the background-work demand gate (T3 skips the periodic probe while no client
/// wants provider status; it needs T3's client activity leases, which this server lacks).
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
        let mut recheck = false;
        loop {
            let interval = if recheck {
                Some(FAILED_CHECK_RECHECK)
            } else {
                refresh_interval(&deps)
            };
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
                () = tick => recheck = refresh_on_interval(&deps, recheck).await,
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

    /// Records the periodic probes; the first one fails over a ready entry.
    struct Flaky {
        id: conn_contract::ProviderInstanceId,
        calls: std::sync::Mutex<Vec<bool>>,
    }

    impl conn_provider::Provider for Flaky {
        fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            "grok"
        }
        fn capabilities(
            &self,
        ) -> conn_provider::BoxFuture<
            '_,
            conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
        > {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "capabilities",
                })
            })
        }
        fn open_session(
            &self,
            _input: conn_provider::OpenSessionInput,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
        {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "open_session",
                })
            })
        }
        fn refresh_status_on_interval(
            &self,
            _instance: Option<Value>,
            defer: bool,
        ) -> conn_provider::BoxFuture<'_, bool> {
            Box::pin(async move {
                let mut calls = self.calls.lock().unwrap();
                calls.push(defer);
                calls.len() == 1
            })
        }
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_failed_periodic_probe_is_rechecked_after_30_seconds() {
        let flaky = Arc::new(Flaky {
            id: "grok".into(),
            calls: std::sync::Mutex::new(Vec::new()),
        });
        let deps = Deps {
            engine: None,
            providers: vec![flaky.clone()],
            ..Deps::default()
        };
        start_status_refresh(&deps);
        tokio::time::sleep(Duration::from_secs(5 * 60) + Duration::from_millis(10)).await;
        assert_eq!(
            *flaky.calls.lock().unwrap(),
            vec![true],
            "the 5-minute probe defers"
        );
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert_eq!(
            *flaky.calls.lock().unwrap(),
            vec![true, false],
            "the recheck publishes"
        );
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(
            flaky.calls.lock().unwrap().len(),
            2,
            "then back to the interval"
        );
    }

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
