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
use std::time::{Duration, Instant};

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

/// Tells config streams that a provider entry changed (T3's `ProviderRegistry.streamChanges`),
/// and holds the clients' activity leases that let the periodic probe run
/// (`BackgroundPolicy`: `reportClientActivity`, `shouldRunScopeWork`).
#[derive(Clone, Debug)]
pub struct ProviderStatus {
    revision: Arc<watch::Sender<u64>>,
    leases: Arc<std::sync::Mutex<Vec<Lease>>>,
}

/// One client's `ClientActivityLease`, as far as provider status needs it.
#[derive(Clone, Debug)]
struct Lease {
    client_id: String,
    expires: Instant,
    /// `isForegroundLease`: visible, and focused or recently used.
    foreground: bool,
    /// `provider-status` scopes: `None` for every instance, else the instance id.
    scopes: Vec<Option<String>>,
}

/// `DEFAULT_LEASE_TTL_MS` and `MAX_LEASE_TTL_MS`.
const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(45);
const MAX_LEASE_TTL: Duration = Duration::from_secs(120);
/// Clients with a lease at once; the oldest goes first.
const MAX_LEASES: usize = 64;

impl Default for ProviderStatus {
    fn default() -> Self {
        Self {
            revision: Arc::new(watch::channel(0).0),
            leases: Arc::default(),
        }
    }
}

impl ProviderStatus {
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    fn bump(&self) {
        self.revision
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    fn leases(&self) -> std::sync::MutexGuard<'_, Vec<Lease>> {
        self.leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `server.reportClientActivity` (`ClientActivityReportInput`): renews the client's lease.
    pub fn report_activity(&self, input: &Value) {
        let Some(client_id) = input["clientId"]
            .as_str()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        else {
            return;
        };
        let ttl = input["ttlMs"]
            .as_f64()
            .filter(|ms| ms.is_finite())
            .map_or(DEFAULT_LEASE_TTL, |ms| {
                Duration::from_millis(ms.max(1_000.0) as u64)
            })
            .min(MAX_LEASE_TTL);
        let scopes = input["scopes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|scope| scope["type"] == "provider-status")
            .map(|scope| scope["instanceId"].as_str().map(str::to_owned))
            .collect();
        let lease = Lease {
            client_id: client_id.to_owned(),
            expires: Instant::now() + ttl,
            foreground: input["visible"] == true
                && (input["focused"] == true || input["recentlyInteracted"] == true),
            scopes,
        };
        let mut leases = self.leases();
        let now = Instant::now();
        leases.retain(|l| l.expires > now && l.client_id != lease.client_id);
        if leases.len() >= MAX_LEASES {
            leases.remove(0);
        }
        leases.push(lease);
    }

    /// `shouldRunScopeWork` for `provider-status` (generic or this instance): an active lease
    /// with the scope, in the foreground unless the profile is `performance`.
    fn wants(&self, instance_id: &str, performance: bool) -> bool {
        let now = Instant::now();
        self.leases().iter().any(|lease| {
            lease.expires > now
                && (performance || lease.foreground)
                && lease
                    .scopes
                    .iter()
                    .any(|s| s.as_deref().is_none_or(|id| id == instance_id))
        })
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

/// The `performance` background profile lets a lease run scoped work in the background.
fn performance_profile(deps: &Deps) -> bool {
    let Some(environment) = deps.environment.as_ref() else {
        return false;
    };
    let settings = environment.settings.raw();
    settings["backgroundActivity"]["profile"] == "performance"
        || settings["backgroundActivityProfile"] == "performance"
}

/// The periodic probe (`refreshOnInterval`): only the providers a client wants
/// (`shouldRefreshOnInterval`), so an idle server with no client starts no provider CLI.
async fn refresh_wanted(deps: &Deps) {
    let performance = performance_profile(deps);
    let mut any = false;
    for provider in &deps.providers {
        let id = provider.instance_id().as_str();
        if deps.provider_status.wants(id, performance) {
            provider.refresh_status(instance_settings(deps, id)).await;
            any = true;
        }
    }
    if any {
        deps.provider_status.bump();
    }
}

/// T3's managed provider loop: probe once the server listens, again when an instance's
/// settings entry changes, and every `providerHealthRefreshInterval` (5 minutes by default)
/// while a client in the foreground asks for provider status (T3's `BackgroundPolicy`
/// demand gate, with leases from `server.reportClientActivity`). Not ported: the 30 s recheck
/// after a failed check, host power and client low-power pauses.
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
                () = tick => refresh_wanted(&deps).await,
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

    /// Before its first probe the Claude entry is T3's pending one (`makePendingClaudeProvider`);
    /// the probe itself is proven by `tools/probe-conformance` in `conn-provider-claude`.
    #[test]
    fn a_claude_instance_is_pending_with_models_before_its_probe() {
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
        assert_eq!(entry["status"], "warning");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["installed"], false);
        assert_eq!(
            entry["message"],
            "Claude provider status has not been checked in this session yet."
        );
        assert!(!entry["models"].as_array().unwrap().is_empty());
    }

    /// `BackgroundPolicy.shouldRunScopeWork` for `provider-status`: a foreground lease with the
    /// scope (generic or the instance's) lets the periodic probe run; a background one only
    /// under the `performance` profile; none at all, nothing.
    #[test]
    fn client_activity_leases_gate_the_periodic_probe() {
        let status = ProviderStatus::default();
        assert!(!status.wants("claudeAgent", true));
        status.report_activity(
            &json!({"clientId": "web-1", "visible": true, "focused": false,
            "recentlyInteracted": false, "scopes": [{"type": "provider-status"}]}),
        );
        assert!(!status.wants("claudeAgent", false));
        assert!(status.wants("claudeAgent", true));
        status.report_activity(&json!({"clientId": "web-1", "visible": true, "focused": true,
            "recentlyInteracted": false, "scopes": [{"type": "provider-status", "instanceId": "grok"}]}));
        assert!(status.wants("grok", false));
        assert!(!status.wants("claudeAgent", false));
        status.report_activity(
            &json!({"clientId": "web-1", "visible": true, "focused": true,
            "recentlyInteracted": true, "scopes": [{"type": "thread", "threadId": "t"}]}),
        );
        assert!(!status.wants("grok", false));
        for n in 0..100 {
            status.report_activity(&json!({"clientId": format!("c{n}"), "scopes": []}));
        }
        assert!(status.leases().len() <= MAX_LEASES);
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
