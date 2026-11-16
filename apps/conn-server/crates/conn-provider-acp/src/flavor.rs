//! What differs between ACP agents (`AcpAdapterV2Flavor` in T3): the launch, the handshake
//! extras, prompt metadata, Stop, approval choices and failure text. One `static` per agent.

use serde_json::{Value, json};

use crate::grok_background::{Lifecycle, SubagentUpdate, TaskMutation};
use crate::ordered::{J, obj};
use crate::tools::ToolState;

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
    #[expect(
        dead_code,
        reason = "the Stop path of agents that survive Stop (Kiro, fx, registry); no built flavor uses it yet"
    )]
    /// `session/cancel` with this `_meta`, the agent stays (`runtime.cancel`).
    Cancel,
    /// `terminateRuntimeProcessGroupOnInterrupt`: the process group is stopped and the next
    /// turn starts a new agent that loads the session.
    KillProcessGroup,
}

/// How a prompt can settle besides its reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Completion {
    #[expect(
        dead_code,
        reason = "every flavor but Grok settles on the reply alone; none is built yet"
    )]
    /// Only the `session/prompt` reply.
    Reply,
    /// Grok: also `_x.ai/session/prompt_complete` or a `turn_completed` session notification
    /// for the prompt's id (`makeXAiPromptCompletionRuntime`).
    XAiPromptComplete,
}

/// The executable setting, the launch runtime mode and the instance environment → the launch.
/// Setup, initialize result, model, effort → the `session/set_model` model id and effort.
pub(crate) type SelectModelFn =
    fn(&Value, &Value, &str, Option<&str>) -> Option<(String, Option<String>)>;

pub(crate) type LaunchFn = fn(&str, Option<&str>, &[(String, String)]) -> Launch;

pub struct Flavor {
    /// `ProviderDriverKind`.
    pub driver: &'static str,
    /// `runtimeHarness`, the name in the runtime notes.
    pub harness: &'static str,
    /// argv and environment for a runtime mode (`None`: the policy has none).
    pub(crate) launch: LaunchFn,
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
    /// `permissionDisposition` ahead of the shared rules, when the flavor decides.
    pub(crate) permission_override: fn(&Value) -> Option<crate::mapper::Disposition>,
    /// `applyModelSelection` / the model config option: the model id to send with
    /// `session/set_model`, or `None` when the session keeps its model.
    /// The selection's `reasoningEffort` goes along when the flavor sends it.
    pub(crate) select_model: SelectModelFn,
    /// `normalizeToolCall`, applied to each incoming tool update of the root turn.
    pub(crate) normalize_tool: Option<fn(crate::tools::ToolState) -> crate::tools::ToolState>,
    /// `capabilities` (`OrchestrationV2ProviderCapabilities`) for the session row.
    pub(crate) capabilities: fn() -> Value,
    /// `supportsCompaction`: `/compact` goes to the agent as a prompt, and its success (or
    /// the agent's own `compaction_update`) makes the next prompt resend T3's notes.
    pub(crate) supports_compaction: bool,
    /// Background work: `deferFinalizeForBackgroundWork` and `enablePostSettleContinuation`
    /// with the hooks that find background tasks. `None` for an agent without them.
    pub(crate) background: Option<BackgroundHooks>,
    /// `mcpOverHttp`: the `/mcp` entry goes as HTTP when the agent offers HTTP; otherwise
    /// it is the stdio bridge. In T3: Grok, Kiro and fx no; Antigravity yes; the registry
    /// only for Copilot.
    pub(crate) mcp_over_http: bool,
    /// `supportsImagePrompts`: image blocks go even when `promptCapabilities.image` is
    /// false (Grok accepts them).
    pub(crate) supports_image_prompts: bool,
}

/// `extractBackgroundTaskId`, `isBackgroundCommandTool`, `extractBackgroundTaskCompletion`,
/// `extractBackgroundToolMutation`, `isPersistentBackgroundTool`, `isProviderWakeNotification`
/// and the lifecycle notifications of `registerExtensions`.
#[derive(Clone, Copy)]
pub(crate) struct BackgroundHooks {
    pub task_id: fn(&ToolState) -> Option<String>,
    pub is_command: fn(&ToolState) -> bool,
    pub completions: fn(&ToolState) -> Vec<TaskMutation>,
    pub text_mutations: fn(&str) -> Vec<TaskMutation>,
    pub is_persistent: fn(&ToolState) -> bool,
    pub is_wake: fn(&Value) -> bool,
    /// A notification method and its params → a task lifecycle change.
    pub lifecycle: fn(&str, &Value) -> Option<Lifecycle>,
    /// `extractSubagentUpdate`.
    pub subagent: fn(&ToolState) -> Option<SubagentUpdate>,
}

impl std::fmt::Debug for BackgroundHooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BackgroundHooks")
    }
}

/// `registerXAiBackgroundTaskTracking`: `x.ai/task_backgrounded` and `x.ai/task_completed`,
/// with their legacy `_x.ai/` forms.
fn grok_lifecycle(method: &str, params: &Value) -> Option<Lifecycle> {
    match method {
        "x.ai/task_backgrounded" | "_x.ai/task_backgrounded" => {
            crate::grok_background::lifecycle(params, false)
        }
        "x.ai/task_completed" | "_x.ai/task_completed" => {
            crate::grok_background::lifecycle(params, true)
        }
        _ => None,
    }
}

const GROK_BACKGROUND: BackgroundHooks = BackgroundHooks {
    task_id: crate::grok_background::background_task_id,
    is_command: |tool| crate::grok_background::background_shell_task_id(tool).is_some(),
    completions: crate::grok_background::background_task_completions,
    text_mutations: crate::grok_background::background_tool_mutations,
    is_persistent: crate::grok_background::is_persistent_monitor,
    is_wake: crate::grok_background::is_task_completed_wake,
    lifecycle: grok_lifecycle,
    subagent: crate::grok_background::subagent_update,
};

impl std::fmt::Debug for Flavor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Flavor")
            .field("driver", &self.driver)
            .finish_non_exhaustive()
    }
}

/// `makeProviderFailure` with an explicit message, class and code.
pub(crate) fn provider_failure(message: &str, class: &str, code: Option<i64>) -> Value {
    use conn_provider_support::redact::bounded;
    let mut message = bounded(message, 4_096);
    if message.is_empty() {
        message = "Provider turn failed.".into();
    }
    let code = code
        .map(|c| bounded(&c.to_string(), 128))
        .filter(|c| !c.is_empty());
    json!({"class": class, "message": message, "code": code, "retryable": null})
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
    permission_override: grok_permission_override,
    normalize_tool: Some(crate::grok::normalize_tool),
    // Protocol 1 sends the effort as `session/set_model` metadata; newer protocols are not
    // built (Grok answers protocol 1), so there no effort goes.
    select_model: |setup, initialize, model, effort| {
        let effort = effort.filter(|_| initialize["protocolVersion"] == 1);
        crate::grok::model_switch(setup, model, effort)
    },
    capabilities: grok_capabilities,
    supports_compaction: true,
    background: Some(GROK_BACKGROUND),
    mcp_over_http: false,
    supports_image_prompts: true,
};

/// `grokLaunchRuntimeMode`.
pub(crate) fn grok_launch_runtime_mode(policy: &Value) -> String {
    if policy.get("approvalPolicy").is_none_or(Value::is_null)
        && policy.get("sandboxPolicy").is_none_or(Value::is_null)
    {
        policy["runtimeMode"]
            .as_str()
            .unwrap_or("full-access")
            .to_owned()
    } else {
        "approval-required".into()
    }
}

/// Grok: auto mode prompts are classifier refusals and must reach the user.
fn grok_permission_override(policy: &Value) -> Option<crate::mapper::Disposition> {
    (grok_launch_runtime_mode(policy) == "auto").then_some(crate::mapper::Disposition::Ask)
}
