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
#[rustfmt::skip]
pub mod instructions;
pub mod launch;
pub mod mapper;
pub mod network_gate;
pub mod protocol;
pub mod session;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod replay_tests;

use std::sync::{Arc, Mutex};

use conn_contract::{ProviderCapabilities, ProviderInstanceId, from_json};
use conn_provider::{
    BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderError, ProviderEvent,
    ProviderResult,
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
}

impl CodexProvider {
    pub fn new(instance_id: ProviderInstanceId, config: CodexConfig) -> Self {
        let launch_args = std::env::var(launch::LAUNCH_ARGS_ENV).ok();
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
        Self {
            instance_id,
            config,
            server,
            models,
        }
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
            // The trait returns no ProviderSession; the engine learns it from this event.
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
            let event = ProviderEvent::ProviderSessionUpdated {
                provider_session: from_json(row).map_err(|e| ProviderError::Protocol {
                    detail: e.to_string(),
                })?,
            };
            tx.try_send(event)
                .map_err(|_| ProviderError::SessionStopped)?;
            let session = CodexSession::open(
                input.provider_session_id,
                &self.instance_id,
                self.server.clone(),
                tx,
                self.config.attachments_dir.clone(),
            );
            Ok(OpenedSession {
                session: Box::new(session),
                events,
            })
        })
    }

    fn server_provider_entry(&self, checked_at: &str) -> Option<Value> {
        let models = self.models.lock().ok()?.clone();
        Some(server_provider_entry(
            self.instance_id.as_str(),
            checked_at,
            self.server.version(),
            &models,
        ))
    }
}

/// `CodexProviderCapabilitiesV2` with what this crate does not do switched off: rollback,
/// fork, snapshots, subagents, handoff context, queued messages, dynamic tool callbacks.
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
            "canRollbackThread": false,
            "canForkThread": false,
            "canForkFromTurn": false,
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
            "providerCanRollbackConversation": false,
            "providerRollbackReturnsSnapshot": false,
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

/// Offered before an app-server has answered `model/list`, when Codex has no model cache.
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

/// The `ServerProvider` entry a client needs to offer Codex and enable Send: enabled,
/// installed, `status: "ready"`.
pub fn server_provider_entry(
    instance_id: &str,
    checked_at: &str,
    version: Option<String>,
    models: &[(String, String)],
) -> Value {
    json!({
        "instanceId": instance_id,
        "driver": DRIVER,
        "displayName": "Codex",
        "enabled": true,
        "installed": true,
        "version": version,
        "status": "ready",
        "auth": {"status": "unknown"},
        "checkedAt": checked_at,
        "models": models
            .iter()
            .map(|(slug, name)| json!({"slug": slug, "name": name, "isCustom": false, "capabilities": null}))
            .collect::<Vec<_>>(),
        "slashCommands": [],
        "skills": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_as_a_dyn_provider_with_a_ready_entry() {
        let provider: Box<dyn Provider> =
            Box::new(CodexProvider::new("codex".into(), CodexConfig::default()));
        assert_eq!(provider.driver(), "codex");
        let entry = provider
            .server_provider_entry("2026-11-13T00:00:00.000Z")
            .unwrap();
        assert_eq!(entry["status"], "ready");
        assert!(!entry["models"].as_array().unwrap().is_empty());
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

    #[test]
    fn a_missing_binary_is_not_offered() {
        let config = CodexConfig {
            binary: "/nonexistent/codex".into(),
            ..CodexConfig::default()
        };
        assert!(CodexProvider::detect("codex".into(), config).is_none());
    }
}
