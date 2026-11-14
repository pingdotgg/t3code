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
pub mod mapper;
pub mod ordered;
pub mod protocol;
pub mod session;

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-provider-claude lock poisoned")
}

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
        }
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
        Some(server_provider_entry(self.instance_id.as_str(), checked_at))
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

/// Models offered before the CLI is asked. T3 reads the live list from the CLI's
/// `initialize` answer (`models`); this static list keeps the picker usable until then.
pub const MODELS: &[(&str, &str)] = &[
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
];

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
        "models": MODELS
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
    fn registers_as_a_dyn_provider() {
        let provider: Box<dyn Provider> = Box::new(ClaudeProvider::new(
            "claudeAgent".into(),
            ClaudeConfig::default(),
        ));
        assert_eq!(provider.driver(), DRIVER);
        assert_eq!(provider.instance_id().as_str(), "claudeAgent");
    }
}
