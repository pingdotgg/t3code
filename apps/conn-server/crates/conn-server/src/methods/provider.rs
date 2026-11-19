//! `provider.*` methods (provider status, models, sign-in, install).
//!
//! No `provider.*` method gates a turn. The client reads providers and their models from
//! `ServerConfig.providers`, which `subscribeServerConfig` delivers at connect, and refreshes
//! them with `server.refreshProviders` (`methods/server.rs`). A provider entry must be enabled,
//! installed and `status: "ready"` (`apps/web/src/providerInstances.ts`), or the composer has
//! no model to send with. [`server_providers`] builds those entries; each provider crate adds
//! its own line there.
//!
//! Sign-in (`provider.auth.*`): the T3 server has no in-app sign-in for the providers this
//! server offers. Claude, Codex (`setupMode` other than `managed`) and Grok are CLI-owned: their
//! T3 instances carry no `ProviderAuthController`, their entries say
//! `setup.canAuthenticate: false`, and the clients show no sign-in for them (users run
//! `claude auth login` or `codex login` on the machine; the `auth.json` watch and the status
//! probe pick the result up). So every `provider.auth.*` method, the stream included, answers
//! T3's `ProviderSetupError` from `ProviderAuthService.getController`. No CLI starts.
//! `crates/conn-server/tools/provider-auth-diff.mjs` compares both servers.
//!
//! In an Orbit container the provider CLIs come from Orbit's read-only agent folder and reach
//! models through Orbit's AI router (`ANTHROPIC_BASE_URL`, `~/.codex/config.toml`), so nobody
//! signs in or installs anything. `provider.install.subscribe` answers "idle". The install
//! flows (`provider.install.start|cancel|remove`), ChatGPT profiles (T3's managed Codex
//! sign-in, which stores tokens itself), `uploadFeedback` and `consumeResetCredit` stay
//! unregistered and answer "not supported".

use std::sync::Arc;
use std::time::Duration;

use conn_support::time::Mark;

use conn_contract::{
    ProviderAuthCancelInput, ProviderAuthCompleteInput, ProviderAuthRespondInput,
    ProviderAuthStartInput, ProviderSetupError, ProviderSetupInput, lit,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use super::Deps;
use crate::table::{Failure, MethodTable};

/// `ProviderAuthRemoveMethodInput` (not exported by the contract, so not generated).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveMethodInput {
    instance_id: String,
    /// Required, as in T3; no controller reads it.
    #[serde(rename = "methodId")]
    _method_id: String,
}

/// `ProviderAuthService.getController` for an instance without a sign-in controller: T3's
/// `ProviderSetupError`, with `operation` as T3 names it.
fn no_sign_in(deps: &Deps, instance_id: String, operation: &str) -> Failure {
    let detail = if deps.providers.get(&instance_id).is_some() {
        "This provider does not support sign-in in T3 Code."
    } else {
        "This provider instance is no longer available."
    };
    Failure::fail(&ProviderSetupError {
        tag: lit::ProviderSetupError,
        instance_id,
        operation: operation.to_owned(),
        detail: detail.to_owned(),
        cause: None,
    })
}

/// Registers one `provider.auth.*` unary method that answers [`no_sign_in`].
macro_rules! no_sign_in_method {
    ($table:expr, $deps:expr, $tag:literal, $operation:literal, $input:ty) => {{
        let deps = $deps.clone();
        $table.unary($tag, move |_, input: $input| {
            let failure = no_sign_in(&deps, input.instance_id, $operation);
            async move { Err::<Value, _>(failure) }
        });
    }};
}

pub fn register(table: &mut MethodTable, deps: &Deps) {
    no_sign_in_method!(
        table,
        deps,
        "provider.auth.start",
        "start",
        ProviderAuthStartInput
    );
    no_sign_in_method!(
        table,
        deps,
        "provider.auth.respond",
        "respond",
        ProviderAuthRespondInput
    );
    no_sign_in_method!(
        table,
        deps,
        "provider.auth.complete",
        "complete",
        ProviderAuthCompleteInput
    );
    no_sign_in_method!(
        table,
        deps,
        "provider.auth.cancel",
        "cancel",
        ProviderAuthCancelInput
    );
    no_sign_in_method!(
        table,
        deps,
        "provider.auth.removeMethod",
        "removeMethod",
        RemoveMethodInput
    );
    no_sign_in_method!(
        table,
        deps,
        "provider.auth.logout",
        "logout",
        ProviderSetupInput
    );
    {
        let deps = deps.clone();
        table.stream(
            "provider.auth.subscribe",
            move |_, input: ProviderSetupInput| {
                let failure = no_sign_in(&deps, input.instance_id, "subscribe");
                async move { Err(failure) }
            },
        );
    }
    let deps = deps.clone();
    table.stream(
        "provider.install.subscribe",
        move |_, input: ProviderSetupInput| {
            let driver = deps
                .providers
                .get(&input.instance_id)
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
    /// When it was taken, on both clocks: T3 expires leases by the wall clock
    /// (`isLeaseActive`), so a lease taken before a container froze ends on wake.
    since: Mark,
    ttl: Duration,
    /// `isForegroundLease`: visible, and focused or recently used.
    foreground: bool,
    /// `provider-status` scopes: `None` for every instance, else the instance id.
    scopes: Vec<Option<String>>,
}

impl Lease {
    /// Neither clock has passed the TTL.
    fn active_at(&self, now: &Mark) -> bool {
        self.since.elapsed_to(now) < self.ttl
    }
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
        self.report_activity_at(input, Mark::now());
    }

    fn report_activity_at(&self, input: &Value, now: Mark) {
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
            since: now,
            ttl,
            foreground: input["visible"] == true
                && (input["focused"] == true || input["recentlyInteracted"] == true),
            scopes,
        };
        let mut leases = self.leases();
        leases.retain(|l| l.active_at(&now) && l.client_id != lease.client_id);
        if leases.len() >= MAX_LEASES {
            leases.remove(0);
        }
        leases.push(lease);
    }

    /// `shouldRunScopeWork` for `provider-status` (generic or this instance): an active lease
    /// with the scope, in the foreground unless the profile is `performance`.
    fn wants(&self, instance_id: &str, performance: bool) -> bool {
        self.wants_at(instance_id, performance, &Mark::now())
    }

    fn wants_at(&self, instance_id: &str, performance: bool, now: &Mark) -> bool {
        self.leases().iter().any(|lease| {
            lease.active_at(now)
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
    for provider in deps.providers.snapshot() {
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

/// The `performance` background profile lets a lease run scoped work in the background.
fn performance_profile(deps: &Deps) -> bool {
    let Some(environment) = deps.environment.as_ref() else {
        return false;
    };
    // `raw()` is a `Map`: indexing it with a missing key panics, so read with `get`. Orbit's
    // settings hold neither key, and the panic aborted the server at the first 5-minute tick.
    let settings = environment.settings.raw();
    let is_performance =
        |value: Option<&Value>| value.and_then(Value::as_str) == Some("performance");
    is_performance(
        settings
            .get("backgroundActivity")
            .and_then(|activity| activity.get("profile")),
    ) || is_performance(settings.get("backgroundActivityProfile"))
}

/// The periodic probe (`refreshOnInterval`): only the providers a client wants
/// (`shouldRefreshOnInterval`), so an idle server with no client starts no provider CLI; each
/// on its own rule. `recheck` is the probe 30 s after a deferred failure. Returns whether a
/// provider asks for that recheck.
async fn refresh_on_interval(deps: &Deps, recheck: bool) -> bool {
    let performance = performance_profile(deps);
    let mut again = false;
    let mut any = false;
    for provider in deps.providers.snapshot() {
        let id = provider.instance_id().as_str();
        if deps.provider_status.wants(id, performance) {
            again |= provider
                .refresh_status_on_interval(instance_settings(deps, id), !recheck)
                .await;
            any = true;
        }
    }
    if any {
        deps.provider_status.bump();
    }
    again
}

/// T3's managed provider loop: probe once the server listens, again when an instance's
/// settings entry changes, and every `providerHealthRefreshInterval` (5 minutes by default)
/// while a client in the foreground asks for provider status (T3's `BackgroundPolicy`
/// demand gate, with leases from `server.reportClientActivity`). A failed periodic check over
/// a ready provider is rechecked after 30 s before it shows (`FAILED_CHECK_RECHECK_DELAY`),
/// and a disabled instance is not probed on the interval. Not ported: host power and client
/// low-power pauses.
pub fn start_status_refresh(deps: &Deps) {
    let deps = deps.clone();
    tokio::spawn(async move {
        let mut settings = deps.environment.as_ref().map(|e| e.settings.subscribe());
        // What each instance's settings entry was at the last look, by id. Instances come and
        // go with the settings, so this holds one entry per live instance.
        let snapshot = |deps: &Deps| -> Vec<(String, Option<Value>)> {
            deps.providers
                .snapshot()
                .iter()
                .map(|p| {
                    let id = p.instance_id().as_str().to_owned();
                    let entry = instance_settings(deps, &id);
                    (id, entry)
                })
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
                    // New, changed and removed Claude and Codex instances first; a new
                    // provider is probed with its entry.
                    let rebuilt = match (&deps.instances, &deps.environment) {
                        (Some(instances), Some(environment)) => {
                            instances.reconcile(&deps.providers, &environment.settings.raw()).await
                        }
                        _ => Vec::new(),
                    };
                    let next = snapshot(&deps);
                    for (id, after) in &next {
                        let before = last.iter().find(|(b, _)| b == id).map(|(_, e)| e);
                        if (rebuilt.contains(id) || before != Some(after))
                            && let Some(provider) = deps.providers.get(id)
                        {
                            provider.refresh_status(after.clone()).await;
                        }
                    }
                    if !rebuilt.is_empty() || next != last {
                        deps.provider_status.bump();
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
        .snapshot()
        .iter()
        .filter_map(|p| p.server_provider_entry(checked_at))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use conn_provider_claude::{ClaudeConfig, ClaudeProvider};

    use super::*;

    /// T3's `ProviderAuthService` for CLI-owned instances: every sign-in method, the stream
    /// too, fails with `ProviderSetupError`; an unknown instance gets the other text. The
    /// comparison with the T3 server itself is `tools/provider-auth-diff.mjs`.
    #[tokio::test(flavor = "current_thread")]
    async fn sign_in_methods_answer_t3s_setup_error() {
        use crate::table::{CallContext, Handler};
        let deps = Deps {
            engine: None,
            providers: vec![Arc::new(ClaudeProvider::new(
                "claudeAgent".into(),
                ClaudeConfig::default(),
            )) as Arc<dyn conn_provider::Provider>]
            .into(),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        let calls = [
            ("provider.auth.start", "start", json!({"methodId": "x"})),
            (
                "provider.auth.respond",
                "respond",
                json!({"flowId": "f", "interactionId": "i",
                       "response": {"type": "browser", "action": "accept"}}),
            ),
            (
                "provider.auth.complete",
                "complete",
                json!({"flowId": "f", "callbackUrl": "http://localhost/cb"}),
            ),
            ("provider.auth.cancel", "cancel", json!({"flowId": "f"})),
            (
                "provider.auth.removeMethod",
                "removeMethod",
                json!({"methodId": "m"}),
            ),
            ("provider.auth.logout", "logout", json!({})),
            ("provider.auth.subscribe", "subscribe", json!({})),
        ];
        for (instance, detail) in [
            (
                "claudeAgent",
                "This provider does not support sign-in in T3 Code.",
            ),
            ("nope", "This provider instance is no longer available."),
        ] {
            for (tag, operation, input) in &calls {
                let mut input = input.clone();
                input["instanceId"] = json!(instance);
                let failure = match table.get(tag) {
                    Some(Handler::Unary(call)) => call(CallContext::default(), input).await.err(),
                    Some(Handler::Stream(call)) => call(CallContext::default(), input).await.err(),
                    None => panic!("{tag} is not registered"),
                };
                assert_eq!(
                    failure,
                    Some(Failure::Fail(json!({
                        "_tag": "ProviderSetupError",
                        "instanceId": instance,
                        "operation": operation,
                        "detail": detail,
                    }))),
                    "{tag} {instance}"
                );
            }
        }
    }

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
            providers: vec![flaky.clone() as Arc<dyn conn_provider::Provider>].into(),
            ..Deps::default()
        };
        // The periodic probe runs only while a client in the foreground asks for provider status.
        deps.provider_status
            .report_activity(&json!({"clientId": "web-1", "visible": true,
            "focused": true, "ttlMs": 120_000, "scopes": [{"type": "provider-status"}]}));
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

    /// Deps with a real environment whose `settings.json` holds `settings`.
    fn deps_with_settings(settings: &Value) -> (Deps, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "conn-server-provider-{}",
            crate::auth::random_hex(6)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
        let environment = crate::environment::Environment::load(
            &dir,
            Some("Test".into()),
            dir.clone(),
            Default::default(),
        )
        .unwrap();
        let flaky = Arc::new(Flaky {
            id: "grok".into(),
            calls: std::sync::Mutex::new(Vec::new()),
        });
        let deps = Deps {
            engine: None,
            environment: Some(Arc::new(environment)),
            providers: vec![flaky as Arc<dyn conn_provider::Provider>].into(),
            ..Deps::default()
        };
        (deps, dir)
    }

    /// The periodic tick reads the background profile from the stored settings. Orbit's
    /// settings (`{"linkedEnvironmentsEnabled": true}`) name no profile; the tick panicked on
    /// that missing key and, with `panic = "abort"`, stopped the server 5 minutes after start
    /// (found on Beast, at the thaw of a 10-minute container pause).
    #[tokio::test(flavor = "current_thread")]
    async fn the_periodic_tick_reads_settings_without_a_background_profile() {
        let (deps, dir) = deps_with_settings(&json!({"linkedEnvironmentsEnabled": true}));
        assert!(!performance_profile(&deps));
        // Awaited here, not spawned, so a panic fails the test.
        assert!(!refresh_on_interval(&deps, false).await);
        std::fs::remove_dir_all(dir).unwrap();

        for (settings, performance) in [
            (
                json!({"backgroundActivity": {"profile": "performance"}}),
                true,
            ),
            (json!({"backgroundActivityProfile": "performance"}), true),
            (
                json!({"backgroundActivity": {"profile": "balanced"}}),
                false,
            ),
            (json!({"backgroundActivity": "performance"}), false),
            (json!({"backgroundActivity": {}}), false),
        ] {
            let (deps, dir) = deps_with_settings(&settings);
            assert_eq!(performance_profile(&deps), performance, "{settings}");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    /// Before its first probe the Claude entry is T3's pending one (`makePendingClaudeProvider`);
    /// the probe itself is proven by `tools/probe-conformance` in `conn-provider-claude`.
    #[test]
    fn a_claude_instance_is_pending_with_models_before_its_probe() {
        let deps = Deps {
            engine: None,
            providers: vec![Arc::new(ClaudeProvider::new(
                "claudeAgent".into(),
                ClaudeConfig::default(),
            )) as Arc<dyn conn_provider::Provider>]
            .into(),
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
            )) as Arc<dyn conn_provider::Provider>]
            .into(),
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

    fn lease_input() -> Value {
        json!({"clientId": "web-1", "visible": true, "focused": true, "ttlMs": 45_000,
               "scopes": [{"type": "provider-status"}]})
    }

    /// A lease taken before Orbit froze the container ends on wake by the wall clock, as T3's
    /// `isLeaseActive` (`BackgroundPolicy.ts`), whether or not the monotonic clock moved. A
    /// wall clock stepped back does not keep it alive.
    #[test]
    fn a_lease_ends_after_a_jump_on_either_clock() {
        let status = ProviderStatus::default();
        let taken = Mark::now();
        status.report_activity_at(&lease_input(), taken);
        let wall = |secs: u64| Mark {
            wall_ms: taken.wall_ms + secs * 1000,
            mono: taken.mono,
        };
        let mono = |secs: u64| Mark {
            wall_ms: taken.wall_ms,
            mono: taken.mono + Duration::from_secs(secs),
        };
        assert!(status.wants_at("grok", false, &wall(30)));
        for jump in [10 * 60, 2 * 3600, 3 * 86_400] {
            assert!(
                !status.wants_at("grok", false, &wall(jump)),
                "wall +{jump}s"
            );
            assert!(
                !status.wants_at("grok", false, &mono(jump)),
                "monotonic +{jump}s"
            );
        }
        let stepped_back = Mark {
            wall_ms: taken.wall_ms - 3_600_000,
            mono: taken.mono + Duration::from_secs(60),
        };
        assert!(!status.wants_at("grok", false, &stepped_back));
        // A renewal after the wake counts again.
        status.report_activity_at(&lease_input(), wall(3 * 86_400));
        assert!(status.wants_at("grok", false, &wall(3 * 86_400 + 1)));
    }

    /// Counts the periodic probes.
    struct Counted {
        id: conn_contract::ProviderInstanceId,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl conn_provider::Provider for Counted {
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
            _defer: bool,
        ) -> conn_provider::BoxFuture<'_, bool> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { false })
        }
    }

    /// A thaw after a long freeze in which the monotonic clock ran on: the 5-minute interval
    /// fires once, not once per missed interval, as T3's `Effect.sleep` loop
    /// (`managedProvider.ts`). The lease here is renewed on wake.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn the_probe_interval_fires_once_after_a_long_freeze() {
        let counted = Arc::new(Counted {
            id: "grok".into(),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let deps = Deps {
            engine: None,
            providers: conn_provider::ProviderSet::from(vec![
                counted.clone() as Arc<dyn conn_provider::Provider>
            ]),
            ..Deps::default()
        };
        start_status_refresh(&deps);
        tokio::task::yield_now().await;
        for (jump, total) in [(10 * 60, 1), (2 * 3600, 2), (3 * 86_400, 3)] {
            deps.provider_status.report_activity(&lease_input());
            tokio::time::advance(Duration::from_secs(jump)).await;
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
            assert_eq!(
                counted.calls.load(std::sync::atomic::Ordering::SeqCst),
                total,
                "after +{jump}s"
            );
        }
    }
}
