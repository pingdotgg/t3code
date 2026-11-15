//! The Codex provider for Conn Server: drives `codex app-server` over JSON-RPC on stdio and
//! implements [`conn_provider::Provider`].
//!
//! - [`protocol`]: JSON-RPC frames.
//! - [`launch`]: argv, environment and the request params that shape threads and turns.
//! - [`mapper`]: notifications and server requests → `ProviderEvent`s and replies (pure,
//!   replay-tested against the TS adapter).
//! - [`client`]: the app-server process shared by the instance's sessions, and routing.
//! - [`session`]: the `Session` implementation.
//!
//! Reference behaviour: `CodexAdapterV2.ts`. See `PROTOCOL.md` and `README.md`.

pub mod client;
pub mod context;
mod elicitation;
#[rustfmt::skip]
pub mod instructions;
pub mod launch;
pub mod mapper;
pub mod network_gate;
pub mod protocol;
pub mod session;
pub mod status;
pub mod text_generation;

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-provider-codex lock poisoned")
}

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod replay_tests;

use std::sync::{Arc, Mutex};

use conn_contract::{ProviderCapabilities, ProviderInstanceId, from_json};
use conn_provider::{
    BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderError, ProviderResult,
};
use conn_provider_support::ids::{Env, SystemEnv};
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub use client::TESTED_CLI_VERSION;
pub use launch::CodexConfig;
pub use session::CodexSession;

/// The contract's `ProviderDriverKind` for Codex.
pub const DRIVER: &str = mapper::DRIVER;

pub struct CodexProvider {
    instance_id: ProviderInstanceId,
    config: CodexConfig,
    server: Arc<client::AppServer>,
    models: Arc<Mutex<Vec<(String, String)>>>,
    /// The instance's `enabled`, `displayName`, `accentColor` and `customModels`.
    settings: status::StatusSettings,
    /// The `ServerProvider` entry: T3's pending one until the first probe ends.
    status: Mutex<Value>,
    /// One probe at a time.
    probing: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for CodexProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexProvider")
            .field("instance_id", &self.instance_id)
            .finish_non_exhaustive()
    }
}

impl CodexProvider {
    pub fn new(instance_id: ProviderInstanceId, config: CodexConfig) -> Self {
        let launch_args = config.launch_args_env();
        let host_has_originator = std::env::var_os(launch::ORIGINATOR_ENV).is_some();
        let spec = launch::launch_spec(&config, launch_args.as_deref(), host_has_originator);
        let models = Arc::new(Mutex::new(
            config
                .effective_home()
                .and_then(|home| cached_models(&home.join("models_cache.json")))
                .unwrap_or_else(fallback_models),
        ));
        // TS reads the gate's variables from `{...process.env, ...spawn environment}`.
        let gate = network_gate::Gate::from_env(|key| {
            spec.env_set
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .or_else(|| std::env::var(key).ok())
        });
        let server = client::AppServer::with_gate(spec, Some(gate));
        let settings = status::StatusSettings {
            enabled: true,
            ..status::StatusSettings::default()
        };
        let pending = pending_status(&instance_id, &config, &settings);
        Self {
            instance_id,
            config,
            server,
            models,
            settings,
            status: Mutex::new(pending),
            probing: tokio::sync::Mutex::new(()),
        }
    }

    /// The provider for one `providerInstances` entry (`None`: the default instance with no
    /// entry), over the server's base configuration. Every instance is listed, as T3 lists
    /// it: until the first probe with T3's pending entry, then with what the probe found (a
    /// missing binary is an error entry). A disabled one is listed disabled and starts
    /// nothing. It may read Codex's model cache: the caller runs it on a blocking thread.
    pub fn for_instance(
        instance_id: ProviderInstanceId,
        base: CodexConfig,
        entry: Option<&Value>,
    ) -> Self {
        let config = base.with_instance(entry);
        let mut provider = Self::new(instance_id, config);
        provider.settings = status::StatusSettings::from_instance(entry);
        *crate::lock(&provider.status) =
            pending_status(&provider.instance_id, &provider.config, &provider.settings);
        provider
    }

    /// One probe with this instance's settings (`checkCodexProviderStatus`). With `defer`, a
    /// failed check over a ready entry keeps that entry and asks for a recheck (`true`).
    async fn probe(&self, defer: bool) -> bool {
        let _one = self.probing.lock().await;
        let cwd = match &self.config.status_cwd {
            Some(cwd) => cwd.clone(),
            None => std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/")),
        };
        let input = status::ProbeInput {
            instance_id: self.instance_id.as_str(),
            config: &self.config,
            settings: &self.settings,
            host_env: conn_support::login_env::child_env(),
            cwd,
            checked_at: conn_support::time::now_iso(),
        };
        let entry = status::check(input).await;
        let mut current = crate::lock(&self.status);
        if defer
            && entry["status"] == "error"
            && entry["auth"]["status"] != "unauthenticated"
            && current["enabled"] == true
            && current["status"] == "ready"
        {
            return true;
        }
        // Titles pick from the models the probe listed (T3 passes the snapshot's models).
        let listed: Vec<(String, String)> = entry["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                Some((
                    m["slug"].as_str()?.to_owned(),
                    m["name"].as_str()?.to_owned(),
                ))
            })
            .collect();
        if !listed.is_empty() {
            *crate::lock(&self.models) = listed;
        }
        *current = entry;
        false
    }

    /// A provider for the configured binary, or `None` when it is not installed.
    pub fn detect(instance_id: ProviderInstanceId, config: CodexConfig) -> Option<Self> {
        config.find_binary()?;
        Some(Self::new(instance_id, config))
    }

    pub fn config(&self) -> &CodexConfig {
        &self.config
    }

    /// The shared app-server's pid while it runs.
    pub fn app_server_pid(&self) -> Option<u32> {
        self.server.pid()
    }
}

impl Provider for CodexProvider {
    fn instance_id(&self) -> &ProviderInstanceId {
        &self.instance_id
    }

    fn driver(&self) -> &str {
        DRIVER
    }

    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
        Box::pin(async {
            from_json(capabilities()).map_err(|e| ProviderError::Protocol {
                detail: e.to_string(),
            })
        })
    }

    fn open_session(
        &self,
        input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async move {
            let (tx, events) = mpsc::channel(session::EVENT_CAPACITY);
            let now = SystemEnv.now();
            let model = conn_contract::to_json(&input.model_selection)["model"].clone();
            let row = json!({
                "id": input.provider_session_id.as_str(),
                "driver": DRIVER,
                "providerInstanceId": self.instance_id.as_str(),
                "status": "ready",
                "cwd": input.runtime_policy.cwd,
                "model": model,
                "capabilities": capabilities(),
                "createdAt": now,
                "updatedAt": now,
                "lastError": null,
            });
            let provider_session = from_json(row).map_err(|e| ProviderError::Protocol {
                detail: e.to_string(),
            })?;
            let session = CodexSession::open(
                input.provider_session_id,
                &self.instance_id,
                self.server.clone(),
                tx,
                &self.config,
                (
                    Some(launch::selection_model(&input.model_selection)),
                    input.runtime_policy.cwd.clone(),
                ),
                input.mcp_servers,
            );
            Ok(OpenedSession {
                session: Box::new(session),
                events,
                provider_session,
                // CodexAdapterV2 does not set it.
                background_tasks_end_with_process: false,
            })
        })
    }

    fn generate_text(
        &self,
        request: conn_provider::TextGenerationRequest,
    ) -> BoxFuture<'_, ProviderResult<Value>> {
        Box::pin(async move {
            let models = crate::lock(&self.models).clone();
            text_generation::generate(&self.config, &models, request).await
        })
    }

    fn server_provider_entry(&self, _checked_at: &str) -> Option<Value> {
        Some(crate::lock(&self.status).clone())
    }

    /// `checkCodexProviderStatus`: starts the instance's `app-server` for the probe and stops
    /// it after. A disabled instance spawns nothing; with the probe off the entry stays
    /// pending. The instance is rebuilt on a settings change, so its own settings apply.
    fn refresh_status(&self, _instance: Option<Value>) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if self.config.status_probe || !self.settings.enabled {
                self.probe(false).await;
            }
        })
    }

    fn refresh_status_on_interval(
        &self,
        _instance: Option<Value>,
        defer: bool,
    ) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            // `shouldRefreshOnInterval`: a disabled instance has nothing to probe.
            if !self.settings.enabled || !self.config.status_probe {
                return false;
            }
            self.probe(defer).await
        })
    }
}

/// T3's pending entry for these settings (`makePendingCodexProvider`, the catalog applied,
/// the instance stamped).
fn pending_status(
    instance_id: &ProviderInstanceId,
    config: &CodexConfig,
    settings: &status::StatusSettings,
) -> Value {
    status::pending_entry(
        instance_id.as_str(),
        config,
        settings,
        &[("HOME".to_owned(), std::env::var("HOME").unwrap_or_default())],
        &conn_support::time::now_iso(),
    )
}

/// `CodexProviderCapabilitiesV2` with what this crate does not do switched off: snapshots,
/// subagents, handoff context, queued messages, dynamic tool callbacks.
pub fn capabilities() -> Value {
    json!({
        "sessions": {
            "supportsMultipleProviderThreadsPerSession": false,
            "supportsModelSwitchInSession": true,
            "supportsProviderSwitchingViaHandoff": false,
            "supportsRuntimeModeSwitchInSession": true,
            "pendingRequestsSurviveRestart": false,
        },
        "threads": {
            "canCreateEmptyThread": true,
            "canReadThreadSnapshot": false,
            "canRollbackThread": true,
            "canForkThread": true,
            "canForkFromTurn": true,
            "canForkFromSubagentThread": false,
            "exposesNativeThreadId": true,
        },
        "turns": {
            "exposesNativeTurnId": true,
            "emitsTurnStarted": true,
            "emitsTurnCompleted": true,
            "supportsInterrupt": true,
            "supportsActiveSteering": true,
            "supportsSteeringByInterruptRestart": false,
            "supportsQueuedMessages": false,
            "terminalStatusQuality": "strong",
        },
        "streaming": {
            "streamsAssistantText": true,
            "streamsReasoning": true,
            "streamsToolOutput": true,
            "streamsPlanText": true,
            "emitsMessageCompleted": true,
        },
        "tools": {
            "exposesToolItemIds": true,
            "emitsToolStarted": true,
            "emitsToolCompleted": true,
            "emitsToolOutput": true,
            "supportsMcpTools": true,
            "supportsDynamicToolCallbacks": false,
        },
        "approvals": {
            "supportsCommandApproval": true,
            "supportsFileReadApproval": true,
            "supportsFileChangeApproval": true,
            "supportsApplyPatchApproval": true,
            "approvalsHaveNativeRequestIds": true,
            "approvalCallbacksAreLiveOnly": true,
            "approvalsCanOriginateFromSubagents": false,
        },
        "planning": {
            "emitsPlanUpdated": true,
            "emitsTodoList": true,
            "emitsProposedPlan": true,
            "supportsStructuredQuestions": true,
            "planDeltasHaveItemIds": true,
        },
        "subagents": {
            "supportsSubagents": false,
            "exposesSubagentThreadIds": false,
            "emitsSubagentLifecycle": false,
            "canWaitForSubagents": false,
            "canCloseSubagents": false,
            "canForkSubagentThread": false,
        },
        "context": {
            "acceptsSystemContext": false,
            "acceptsDeveloperContext": false,
            "acceptsSyntheticUserContext": false,
            "canGenerateSummaries": false,
            "canConsumeHandoffSummaries": false,
            "supportsDeltaHandoff": false,
            "supportsFullThreadHandoff": false,
            "maxRecommendedHandoffChars": null,
        },
        "checkpointing": {
            "appCanCheckpointFilesystem": true,
            "supportsNestedCheckpointScopes": false,
            "providerCanRollbackConversation": true,
            "providerRollbackReturnsSnapshot": true,
            "providerCanReadConversationSnapshot": false,
        },
        "identity": {
            "nativeThreadIds": "strong",
            "nativeTurnIds": "strong",
            "nativeItemIds": "strong",
            "nativeRequestIds": "strong",
        },
        "runtimePolicy": {"enforcement": "native"},
    })
}

/// Offered when Codex has no model cache (the session process sends no `model/list`).
pub fn fallback_models() -> Vec<(String, String)> {
    [
        ("gpt-6.1-sol", "GPT-6.1-Sol"),
        ("gpt-6-astra", "GPT-6-Astra"),
        ("gpt-6-luna", "GPT-6-Luna"),
    ]
    .map(|(slug, name)| (slug.to_owned(), name.to_owned()))
    .into()
}

/// Listed models from Codex's own catalog cache (`$CODEX_HOME/models_cache.json`), by
/// priority. The file is shared by every Codex client on the machine.
pub fn cached_models(path: &std::path::Path) -> Option<Vec<(String, String)>> {
    let text = std::fs::read_to_string(path).ok()?;
    let cache: Value = serde_json::from_str(&text).ok()?;
    let mut models: Vec<(i64, String, String)> = cache["models"]
        .as_array()?
        .iter()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            let slug = m["slug"].as_str()?;
            let name = m["display_name"].as_str().unwrap_or(slug);
            Some((
                m["priority"].as_i64().unwrap_or(i64::MAX),
                slug.to_owned(),
                name.to_owned(),
            ))
        })
        .collect();
    models.sort_by_key(|(priority, _, _)| *priority);
    let models: Vec<(String, String)> = models.into_iter().map(|(_, s, n)| (s, n)).collect();
    (!models.is_empty()).then_some(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Before its first probe the entry is T3's pending one (`makePendingCodexProvider`).
    #[test]
    fn registers_as_a_dyn_provider_with_a_pending_entry() {
        let provider: Box<dyn Provider> =
            Box::new(CodexProvider::new("codex".into(), CodexConfig::default()));
        assert_eq!(provider.driver(), "codex");
        let entry = provider
            .server_provider_entry("2026-11-13T00:00:00.000Z")
            .unwrap();
        assert_eq!(entry["status"], "warning");
        assert_eq!(entry["installed"], false);
        assert_eq!(
            entry["message"],
            "Codex provider status has not been checked in this session yet."
        );
        let _: conn_contract::ServerProvidersItemItem = from_json(entry).unwrap();
        let _: ProviderCapabilities = from_json(capabilities()).unwrap();
    }

    #[test]
    fn reads_the_codex_model_cache() {
        let dir = std::env::temp_dir().join(format!("conn-codex-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("models_cache.json");
        std::fs::write(
            &path,
            r#"{"models":[{"slug":"b","display_name":"B","visibility":"list","priority":2},
            {"slug":"h","visibility":"hide","priority":0},
            {"slug":"a","display_name":"A","visibility":"list","priority":1}]}"#,
        )
        .unwrap();
        let models = cached_models(&path).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(models, [("a".into(), "A".into()), ("b".into(), "B".into())]);
    }

    /// T3 lists an enabled instance whose binary is missing, with an error entry.
    #[tokio::test(flavor = "current_thread")]
    async fn a_missing_binary_is_listed_with_an_error() {
        let config = CodexConfig {
            binary: "/nonexistent/codex".into(),
            ..CodexConfig::default()
        };
        assert!(CodexProvider::detect("codex".into(), config.clone()).is_none());
        // The binary goes through the entry: an entry without one means `codex` on PATH.
        let entry =
            serde_json::json!({"driver": "codex", "config": {"binaryPath": "/nonexistent/codex"}});
        let provider = CodexProvider::for_instance("codex".into(), config, Some(&entry));
        provider.refresh_status(None).await;
        let entry = provider.server_provider_entry("").unwrap();
        assert_eq!(entry["status"], "error");
        assert_eq!(entry["installed"], false);
        assert!(
            entry["message"]
                .as_str()
                .unwrap()
                .starts_with("Could not start Codex CLI (`/nonexistent/codex`)."),
            "{entry}"
        );
        let _: conn_contract::ServerProvidersItemItem = from_json(entry).unwrap();
    }
}
