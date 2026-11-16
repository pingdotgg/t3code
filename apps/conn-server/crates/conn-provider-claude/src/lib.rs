//! The Claude provider: runs Claude through the official Claude Agent SDK in a small Node
//! SDK host (`helpers/sdk-host`), as the T3 server does, and implements
//! [`conn_provider::Provider`].
//!
//! - [`helper`]: the shared helper process and its JSON-lines protocol.
//! - [`launch`]: the `query()` option object and environment, as `ClaudeAdapterV2` builds them.
//! - [`protocol`]: typed SDK messages with a raw-JSON fallback.
//! - [`mapper`]: SDK messages → `ProviderEvent`s and callback answers (pure, replay-tested).
//! - [`session`]: the `Session` implementation. The helper child and ids come from
//!   `conn-provider-support`.
//!
//! Reference behaviour: `ClaudeAdapterV2.ts` in `apps/server/src/orchestration-v2/Adapters`.
//! See `README.md` in this crate for the event mapping and its known differences.

pub mod attachments;
pub mod catalog;
pub mod helper;
pub mod launch;
pub mod launch_args;
pub mod mapper;
pub mod ordered;
pub mod protocol;
pub mod session;
pub mod status;
mod tail;
pub mod text_generation;

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-provider-claude lock poisoned")
}

#[cfg(test)]
mod interrupt_tests;
#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod replay_tests;
#[cfg(test)]
pub(crate) mod testdata;

use conn_contract::{ProviderCapabilities, ProviderInstanceId, from_json};
use conn_provider::{
    BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderError, ProviderResult,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub use conn_provider_support::ids;
pub use helper::{Helper, HelperCommand};
pub use launch::ClaudeConfig;
pub use session::ClaudeSession;

/// The contract's `ProviderDriverKind` for Claude.
pub const DRIVER: &str = "claudeAgent";

pub struct ClaudeProvider {
    instance_id: ProviderInstanceId,
    config: ClaudeConfig,
    /// One SDK host for all sessions; it runs only while a query is open.
    helper: Helper,
    /// The entry the last status probe built; `None` before the first one.
    status: std::sync::Mutex<Option<Value>>,
    applied_titles: session::AppliedTitles,
}

impl std::fmt::Debug for ClaudeProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeProvider")
            .field("instance_id", &self.instance_id)
            .finish_non_exhaustive()
    }
}

impl ClaudeProvider {
    pub fn new(instance_id: ProviderInstanceId, config: ClaudeConfig) -> Self {
        let helper = helper::claude_host(config.helper.clone(), instance_id.as_str());
        Self {
            instance_id,
            config,
            helper,
            status: std::sync::Mutex::new(None),
            applied_titles: Default::default(),
        }
    }

    /// The provider for one `providerInstances` entry (`None`: the default instance with no
    /// entry), over the server's base configuration. Until the first status probe its entry
    /// is T3's pending snapshot for these settings (`makePendingClaudeProvider` with
    /// `withInstanceIdentity`), disabled when the instance is.
    ///
    /// `helper` is the server's one SDK host; this instance's messages carry its id.
    pub fn for_instance(
        instance_id: ProviderInstanceId,
        base: ClaudeConfig,
        entry: Option<&Value>,
        helper: &Helper,
    ) -> Self {
        let config = base.with_instance(entry);
        let settings = status::StatusSettings::from_instance(entry);
        let pending = pending_entry_for(
            instance_id.as_str(),
            &settings,
            &config,
            &conn_support::time::now_iso(),
        );
        let helper = helper.for_instance(instance_id.as_str());
        Self {
            instance_id,
            config,
            helper,
            status: std::sync::Mutex::new(Some(pending)),
            applied_titles: Default::default(),
        }
    }

    /// The instance settings for the status probe: the stored `providerInstances` entry, and
    /// this provider's own launch configuration where the entry says nothing.
    fn status_settings(&self, instance: Option<&Value>) -> status::StatusSettings {
        let mut settings = status::StatusSettings::from_instance(instance);
        let config = instance.and_then(|i| i.get("config"));
        if config
            .and_then(|c| c["binaryPath"].as_str())
            .is_none_or(|b| b.trim().is_empty())
        {
            settings.binary_path = self.config.binary.to_string_lossy().into_owned();
        }
        if settings.home_path.is_empty()
            && let Some(home) = &self.config.home_path
        {
            settings.home_path = home.to_string_lossy().into_owned();
        }
        if settings.environment.is_empty() {
            settings.environment = self.config.instance_env.clone();
        }
        settings
    }

    pub fn config(&self) -> &ClaudeConfig {
        &self.config
    }

    pub fn helper(&self) -> &Helper {
        &self.helper
    }
}

impl Provider for ClaudeProvider {
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

    fn server_provider_entry(&self, checked_at: &str) -> Option<Value> {
        let probed = lock(&self.status).clone();
        Some(probed.unwrap_or_else(|| pending_entry(self.instance_id.as_str(), checked_at)))
    }

    /// `ClaudeTextGeneration`: the `claude` CLI directly, outside any session and the SDK
    /// host (see [`text_generation`]).
    fn generate_text(
        &self,
        request: conn_provider::TextGenerationRequest,
    ) -> BoxFuture<'_, ProviderResult<Value>> {
        Box::pin(async move {
            let config_dir = launch::config_dir(&self.config, &serde_json::Map::new());
            let entrypoint =
                tokio::task::spawn_blocking(move || launch::settings_entrypoint(&config_dir))
                    .await
                    .unwrap_or_default();
            let env = launch::process_environment(
                &self.config,
                conn_support::login_env::child_env(),
                entrypoint,
            );
            let managed = tokio::task::spawn_blocking(status::managed_mcp_config)
                .await
                .unwrap_or(false);
            let program = self.config.binary.to_string_lossy().into_owned();
            text_generation::generate(&program, &env, managed, request).await
        })
    }

    /// `checkClaudeProviderStatus` with this instance's settings: `claude --version`, then
    /// the capabilities probe in the SDK host (which starts for it and stops again).
    fn refresh_status(&self, instance: Option<Value>) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let settings = self.status_settings(instance.as_ref());
            // A disabled instance spawns nothing, so its entry is built even with the probe off.
            if !self.config.status_probe && settings.enabled {
                return;
            }
            let config_dir = launch::config_dir(
                &ClaudeConfig {
                    home_path: (!settings.home_path.is_empty())
                        .then(|| launch::expand_home(&settings.home_path)),
                    ..ClaudeConfig::default()
                },
                &serde_json::Map::new(),
            );
            // Claude's user and managed settings: only the entrypoint and the API base URL.
            let (entrypoint, base_url) = tokio::task::spawn_blocking(move || {
                (
                    launch::settings_entrypoint(&config_dir),
                    launch::settings_env_value(&config_dir, "ANTHROPIC_BASE_URL"),
                )
            })
            .await
            .unwrap_or_default();
            let input = status::ProbeInput {
                instance_id: self.instance_id.as_str(),
                settings: &settings,
                host_env: conn_support::login_env::child_env(),
                settings_entrypoint: entrypoint,
                settings_base_url: base_url,
                cwd: self.config.status_cwd.clone(),
                checked_at: conn_support::time::now_iso(),
            };
            let helper = &self.helper;
            let entry = status::check(input, |options, extra, timeout| async move {
                helper
                    .function("probeCapabilities", json!([options, extra]), None, timeout)
                    .await
                    .map_err(|e| e.to_string())
            })
            .await;
            *lock(&self.status) = Some(entry);
        })
    }

    fn open_session(
        &self,
        input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async move {
            let (tx, events) = mpsc::channel(session::EVENT_CAPACITY);
            let now = ids::Env::now(&mut ids::SystemEnv);
            let model = conn_contract::to_json(&input.model_selection)["model"].clone();
            let provider_session = json!({
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
            let provider_session =
                from_json(provider_session).map_err(|e| ProviderError::Protocol {
                    detail: e.to_string(),
                })?;
            let session = ClaudeSession::open(
                input.provider_session_id,
                self.instance_id.as_str(),
                self.config.clone(),
                self.helper.clone(),
                tx,
                input.mcp_servers,
                self.applied_titles.clone(),
            );
            Ok(OpenedSession {
                session: Box::new(session),
                events,
                provider_session,
                // `backgroundTasksEndWithProcess: true` in ClaudeAdapterV2.
                background_tasks_end_with_process: true,
            })
        })
    }
}

/// `ClaudeProviderCapabilitiesV2`, with what this crate does not do switched off: handoff and
/// context injection, queued messages, dynamic tool callbacks, nested checkpoint scopes.
pub fn capabilities() -> Value {
    json!({
        "sessions": {
            "supportsMultipleProviderThreadsPerSession": false,
            "supportsModelSwitchInSession": true,
            "supportsProviderSwitchingViaHandoff": false,
            "supportsRuntimeModeSwitchInSession": false,
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
            "exposesNativeTurnId": false,
            "emitsTurnStarted": true,
            "emitsTurnCompleted": true,
            "supportsInterrupt": true,
            "supportsActiveSteering": true,
            "activeSteeringInterruptsTools": true,
            "supportsSteeringByInterruptRestart": false,
            "supportsQueuedMessages": false,
            "terminalStatusQuality": "strong",
        },
        "streaming": {
            "streamsAssistantText": true,
            "streamsReasoning": true,
            "streamsToolOutput": false,
            "streamsPlanText": false,
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
            "supportsApplyPatchApproval": false,
            "approvalsHaveNativeRequestIds": true,
            "approvalCallbacksAreLiveOnly": true,
            "approvalsCanOriginateFromSubagents": false,
        },
        "planning": {
            "emitsPlanUpdated": true,
            "emitsTodoList": true,
            "emitsProposedPlan": true,
            "supportsStructuredQuestions": true,
            "planDeltasHaveItemIds": false,
        },
        "subagents": {
            "supportsSubagents": true,
            "exposesSubagentThreadIds": false,
            "emitsSubagentLifecycle": true,
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
            "nativeTurnIds": "weak",
            "nativeItemIds": "strong",
            "nativeRequestIds": "strong",
        },
        "runtimePolicy": {"enforcement": "native"},
    })
}

/// `makePendingClaudeProvider`: the entry before the first status probe finished.
pub fn pending_entry(instance_id: &str, checked_at: &str) -> Value {
    json!({
        "displayName": "Claude",
        "showInteractionModeToggle": true,
        "reportsContextWindow": true,
        "enabled": true,
        "installed": false,
        "version": null,
        "status": "warning",
        "auth": {"status": "unknown"},
        "setup": {"canAuthenticate": false, "canInstall": false},
        "checkedAt": checked_at,
        "message": "Claude provider status has not been checked in this session yet.",
        "models": catalog::provider_models(),
        "slashCommands": [],
        "skills": [],
        "instanceId": instance_id,
        "driver": DRIVER,
        "continuation": {"groupKey": format!(
            "claude:home:{}",
            launch::config_dir(&ClaudeConfig::default(), &serde_json::Map::new()).to_string_lossy()
        )},
    })
}

/// [`pending_entry`] for an instance's settings: its config folder as the continuation
/// group, `displayName` and `accentColor` when set, and T3's disabled snapshot when off.
pub fn pending_entry_for(
    instance_id: &str,
    settings: &status::StatusSettings,
    config: &ClaudeConfig,
    checked_at: &str,
) -> Value {
    let mut entry = pending_entry(instance_id, checked_at);
    let env = launch::query_env(
        config,
        "",
        false,
        conn_support::login_env::child_env(),
        None,
    );
    entry["continuation"] = json!({"groupKey": format!(
        "claude:home:{}",
        launch::config_dir(config, &env).to_string_lossy()
    )});
    if !settings.enabled {
        entry["enabled"] = json!(false);
        entry["status"] = json!("disabled");
        entry["message"] = json!("Claude is disabled in T3 Code settings.");
    }
    if let Some(name) = &settings.display_name {
        entry["displayName"] = json!(name);
    }
    if let Some(color) = &settings.accent_color {
        entry["accentColor"] = json!(color);
    }
    entry
}

/// The `ServerProvider` entry (`packages/contracts/src/server.ts`) a client needs to offer
/// Claude in its model picker and enable Send: enabled, installed, `status: "ready"`.
/// It belongs in `ServerConfig.providers`, which `subscribeServerConfig` delivers.
pub fn server_provider_entry(instance_id: &str, checked_at: &str) -> Value {
    json!({
        "instanceId": instance_id,
        "driver": DRIVER,
        "displayName": "Claude",
        "enabled": true,
        "installed": true,
        "version": null,
        "status": "ready",
        "auth": {"status": "unknown"},
        "checkedAt": checked_at,
        // T3 filters its catalog by the CLI's version; this server offers every model in it.
        "models": catalog::provider_models(),
        "slashCommands": [],
        "skills": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_as_a_dyn_provider() {
        let provider: Box<dyn Provider> = Box::new(ClaudeProvider::new(
            "claudeAgent".into(),
            ClaudeConfig::default(),
        ));
        assert_eq!(provider.driver(), DRIVER);
        assert_eq!(provider.instance_id().as_str(), "claudeAgent");
    }

    /// The picker offers what the T3 server offers: every model of its bundled catalog, with
    /// the option descriptors that give the effort menu, and the legacy models.
    #[test]
    fn the_provider_entry_offers_t3s_catalog_models() {
        let entry = server_provider_entry("claudeAgent", "2026-11-14T00:00:00.000Z");
        let models = entry["models"].as_array().expect("models is a list");
        let slugs: Vec<&str> = models.iter().filter_map(|m| m["slug"].as_str()).collect();
        assert!(slugs.contains(&"claude-haiku-5-5"), "{slugs:?}");
        assert!(
            slugs.contains(&"claude-haiku-4-5"),
            "the legacy Haiku is offered: {slugs:?}"
        );
        let haiku = models
            .iter()
            .find(|m| m["slug"] == "claude-haiku-5-5")
            .expect("Haiku 5.5 is listed");
        assert_eq!(haiku["name"], "Claude Haiku 5.5");
        assert_eq!(haiku["isCustom"], false);
        let effort = haiku["capabilities"]["optionDescriptors"]
            .as_array()
            .and_then(|d| d.iter().find(|d| d["id"] == "effort"))
            .expect("Haiku 5.5 has an effort selector");
        assert_eq!(effort["type"], "select");
        let decoded: Result<conn_contract::ServerProvidersItemItem, _> =
            conn_contract::from_json(entry);
        assert!(
            decoded.is_ok(),
            "the entry decodes as a ServerProvider: {decoded:?}"
        );
    }
}
