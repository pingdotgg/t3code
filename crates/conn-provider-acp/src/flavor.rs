//! What differs between ACP agents (`AcpAdapterV2Flavor` in T3): the launch, the handshake
//! extras, prompt metadata, Stop, approval choices and failure text. One `static` per agent.

use serde_json::{Value, json};

use crate::ordered::{J, obj};

/// The launch the T3 driver builds (`buildGrokAcpSpawnInput` and peers).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    /// Added to the inherited environment, in order.
    pub env: Vec<(String, String)>,
}

/// How Stop reaches the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopStyle {
    /// `session/cancel` with this `_meta`, the agent stays (`runtime.cancel`).
    Cancel,
    /// `terminateRuntimeProcessGroupOnInterrupt`: the process group is stopped and the next
    /// turn starts a new agent that loads the session.
    KillProcessGroup,
}

/// How a prompt can settle besides its reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Completion {
    /// Only the `session/prompt` reply.
    Reply,
    /// Grok: also `_x.ai/session/prompt_complete` or a `turn_completed` session notification
    /// for the prompt's id (`makeXAiPromptCompletionRuntime`).
    XAiPromptComplete,
}

pub struct Flavor {
    /// `ProviderDriverKind`.
    pub driver: &'static str,
    /// `runtimeHarness`, the name in the runtime notes.
    pub harness: &'static str,
    /// argv and environment for a runtime mode (`None`: the policy has none).
    pub(crate) launch: fn(&str, Option<&str>, &[(String, String)]) -> Launch,
    /// `initializeMeta`.
    pub(crate) initialize_meta: Option<fn() -> J>,
    /// `cancelMeta`, sent on `session/cancel`.
    pub(crate) cancel_meta: Option<fn() -> J>,
    pub(crate) stop: StopStyle,
    pub(crate) completion: Completion,
    /// `approvalOptions`: the decisions a permission request offers.
    pub(crate) approval_options: fn(&[(String, String)]) -> Value,
    /// `promptFailure`: the `ProviderFailure` for a failed prompt (message, code).
    pub(crate) prompt_failure: fn(&str, Option<i64>) -> Value,
    /// The default model slug that selects the agent's current model.
    pub(crate) default_model: &'static str,
    /// `capabilities` (`OrchestrationV2ProviderCapabilities`) for the session row.
    pub(crate) capabilities: fn() -> Value,
}

impl std::fmt::Debug for Flavor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Flavor")
            .field("driver", &self.driver)
            .finish_non_exhaustive()
    }
}

/// `makeProviderFailure` with an explicit message, class and code.
pub(crate) fn provider_failure(message: &str, class: &str, code: Option<i64>) -> Value {
    let message = conn_provider_support::redact::redact(message);
    let mut failure = json!({"class": class, "message": message});
    if let Some(code) = code {
        failure["code"] = json!(code.to_string());
    }
    failure
}

/// `AcpProviderCapabilitiesV2` (`packages/provider-acp/src/server/adapter.ts`).
pub(crate) fn acp_capabilities() -> Value {
    json!({
        "sessions": {
            "supportsMultipleProviderThreadsPerSession": false,
            "supportsModelSwitchInSession": false,
            "supportsProviderSwitchingViaHandoff": false,
            "supportsRuntimeModeSwitchInSession": false,
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
            "exposesNativeTurnId": false,
            "emitsTurnStarted": true,
            "emitsTurnCompleted": true,
            "supportsInterrupt": true,
            "supportsActiveSteering": false,
            "activeSteeringInterruptsTools": false,
            "supportsSteeringByInterruptRestart": true,
            "supportsQueuedMessages": false,
            "terminalStatusQuality": "strong",
        },
        "streaming": {
            "streamsAssistantText": true,
            "streamsReasoning": true,
            "streamsToolOutput": true,
            "streamsPlanText": false,
            "emitsMessageCompleted": true,
        },
        "tools": {
            "exposesToolItemIds": true,
            "emitsToolStarted": true,
            "emitsToolCompleted": true,
            "emitsToolOutput": true,
            "supportsMcpTools": false,
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
            "emitsProposedPlan": false,
            "supportsStructuredQuestions": false,
            "planDeltasHaveItemIds": false,
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
            "nativeTurnIds": "weak",
            "nativeItemIds": "strong",
            "nativeRequestIds": "strong",
        },
        "runtimePolicy": {"enforcement": "native"},
    })
}

// ---- Grok -------------------------------------------------------------------------------

/// `grokAcpSpawnArgs`, with `grokLaunchRuntimeMode` applied by the caller.
pub fn grok_spawn_args(runtime_mode: Option<&str>) -> Vec<String> {
    let args: &[&str] = match runtime_mode {
        None => &["agent", "stdio"],
        Some("auto") => &["--permission-mode", "auto", "agent", "stdio"],
        Some("full-access") => &["agent", "--always-approve", "stdio"],
        Some(_) => &["--permission-mode", "default", "agent", "stdio"],
    };
    args.iter().map(|s| (*s).to_owned()).collect()
}

fn grok_launch(
    binary: &str,
    runtime_mode: Option<&str>,
    environment: &[(String, String)],
) -> Launch {
    let mut env: Vec<(String, String)> = environment.to_vec();
    env.retain(|(k, _)| k != "GROK_OAUTH2_REFERRER");
    env.push(("GROK_OAUTH2_REFERRER".into(), "t3code".into()));
    Launch {
        program: if binary.is_empty() {
            "grok".into()
        } else {
            binary.to_owned()
        },
        args: grok_spawn_args(runtime_mode),
        env,
    }
}

/// `grokApprovalOptions`.
fn grok_approval_options(options: &[(String, String)]) -> Value {
    let has = |kind: &str, id: Option<&str>| {
        options
            .iter()
            .any(|(option_id, k)| k == kind && id.is_none_or(|id| option_id.trim() == id))
    };
    let mut decisions = vec![json!({"decision": "cancel", "label": "Cancel"})];
    if has("reject_once", None) {
        decisions.push(json!({"decision": "decline", "label": "Decline"}));
    }
    if has("allow_always", Some("allow-edits-session")) {
        decisions
            .push(json!({"decision": "acceptForSession", "label": "Allow all edits this session"}));
    }
    if has("allow_once", None) {
        decisions.push(json!({"decision": "accept", "label": "Approve"}));
    }
    Value::Array(decisions)
}

/// `xAiRateLimitedErrorCode`.
const XAI_RATE_LIMITED: i64 = -32003;

fn grok_prompt_failure(message: &str, code: Option<i64>) -> Value {
    let class = if code == Some(XAI_RATE_LIMITED) {
        "usage_limit"
    } else {
        "provider_error"
    };
    provider_failure(message, class, code)
}

fn grok_capabilities() -> Value {
    let mut caps = acp_capabilities();
    caps["sessions"]["supportsModelSwitchInSession"] = json!(true);
    caps["sessions"]["supportsRuntimeModeSwitchInSession"] = json!(false);
    caps["threads"]["canReadThreadSnapshot"] = json!(true);
    caps["threads"]["canForkThread"] = json!(false);
    caps["threads"]["canForkFromTurn"] = json!(false);
    caps["subagents"]["supportsSubagents"] = json!(true);
    caps["subagents"]["exposesSubagentThreadIds"] = json!(true);
    caps["subagents"]["emitsSubagentLifecycle"] = json!(true);
    caps["tools"]["supportsMcpTools"] = json!(true);
    caps["checkpointing"]["providerCanReadConversationSnapshot"] = json!(true);
    caps["turns"]["supportsSteeringByInterruptRestart"] = json!(false);
    caps
}

pub static GROK: Flavor = Flavor {
    driver: "grok",
    harness: "Grok",
    launch: grok_launch,
    initialize_meta: Some(|| obj().with("clientType", "extension")),
    cancel_meta: Some(|| obj().with("cancelTrigger", "ctrl_c")),
    stop: StopStyle::KillProcessGroup,
    completion: Completion::XAiPromptComplete,
    approval_options: grok_approval_options,
    prompt_failure: grok_prompt_failure,
    default_model: "grok-build",
    capabilities: grok_capabilities,
};
