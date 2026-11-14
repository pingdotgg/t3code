/**
 * Environment-derived flags and mutable session state for the ACP mock agent.
 * Kept in one import-free module so the agent script and its prompt/option parts share
 * live state without importing each other.
 */
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/schema";

export const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
export const antigravityProfile = process.env.T3_ACP_ANTIGRAVITY === "1";
// GitHub Copilot CLI advertises URL-shaped session mode ids.
export const copilotModesProfile = process.env.T3_ACP_COPILOT_MODES === "1";
export const copilotModeId = (name: string) =>
  `https://agentclientprotocol.com/protocol/session-modes#${name}`;
export const modeOptionCategory = process.env.T3_ACP_MODE_OPTION_CATEGORY ?? "mode";
export const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
export const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
export const emitV2Fidelity = process.env.T3_ACP_EMIT_V2_FIDELITY === "1";
export const emitNotice = process.env.T3_ACP_EMIT_NOTICE === "1";
export const vibeRetryOutcome = process.env.T3_ACP_VIBE_RETRY_OUTCOME;
export const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
export const emitInTurnTaskOutputThenLateDuplicate =
  process.env.T3_ACP_EMIT_IN_TURN_TASKOUTPUT_THEN_LATE_DUPLICATE === "1";
export const emitBackgroundToolDuringAnswer =
  process.env.T3_ACP_EMIT_BACKGROUND_TOOL_DURING_ANSWER === "1";
export const emitMcpToolApprovalElicitation =
  process.env.T3_ACP_EMIT_MCP_TOOL_APPROVAL_ELICITATION === "1";
export const grokKillTaskShape = process.env.T3_ACP_GROK_KILL_TASK_SHAPE;
export const emitGrokBackgroundTaskPoll = process.env.T3_ACP_GROK_BACKGROUND_TASK_COMPLETION === "poll";
export const emitForeignSessionUpdates = process.env.T3_ACP_EMIT_FOREIGN_SESSION_UPDATES === "1";
export const omitInitializeModelState = process.env.T3_ACP_OMIT_INITIALIZE_MODEL_STATE === "1";
export const completeFirstPromptOnCancel = process.env.T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL === "1";
export const floodStderr = process.env.T3_ACP_FLOOD_STDERR === "1";
export const hangPromptForever = process.env.T3_ACP_HANG_PROMPT_FOREVER === "1";
export const emitTrackedToolCallKindThenHang = process.env.T3_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG;
export const clientFsProbePath = process.env.T3_ACP_CLIENT_FS_PROBE_PATH;
export const clientFsProbeLogPath = process.env.T3_ACP_CLIENT_FS_PROBE_LOG_PATH;
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const emitEmptySuccessfulBash = process.env.T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH === "1";
export const emitEmptySuccessfulBashThenHang =
  process.env.T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH_THEN_HANG === "1";
export const failLoadSession = process.env.T3_ACP_FAIL_LOAD_SESSION === "1";
export const failLoadSessionAfterConfigReplay =
  process.env.T3_ACP_FAIL_LOAD_SESSION_AFTER_CONFIG_REPLAY === "1";
export const emitLoadReplay = process.env.T3_ACP_EMIT_LOAD_REPLAY === "1";
export const failPrompt = process.env.T3_ACP_FAIL_PROMPT === "1";
export const failPromptOrdinal = Number(process.env.T3_ACP_FAIL_PROMPT_ORDINAL);
export const compactionPromptOrdinals = new Set(
  (process.env.T3_ACP_COMPACTION_PROMPT_ORDINALS ?? "").split(",").map(Number),
);
export const failSetModeConfigOption = process.env.T3_ACP_FAIL_SET_MODE_CONFIG_OPTION === "1";
export const emitEmptyDefaultAgentOption = process.env.T3_ACP_EMIT_EMPTY_DEFAULT_AGENT_OPTION === "1";
export const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
export const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0");
export const terminalOutputBytes = Number(process.env.T3_ACP_EMIT_TERMINAL_OUTPUT_BYTES ?? "0");
export const supportsSessionLifecycle = process.env.T3_ACP_SESSION_LIFECYCLE === "1";
export const supportsAcpMcp = process.env.T3_ACP_MCP_ACP === "1";
export const supportsHttpMcp = process.env.T3_ACP_MCP_HTTP === "1";
export const supportsV2Management = process.env.T3_ACP_V2_MANAGEMENT === "1";
export const advertisedAuthMethodId = process.env.T3_ACP_AUTH_METHOD_ID?.trim();
export const initializeAuthMethodId =
  advertisedAuthMethodId ?? (supportsSessionLifecycle ? "test" : undefined);
export const requiresAuthentication = process.env.T3_ACP_REQUIRE_AUTH === "1";
export const permissionOptionIds = {
  allowOnce: "allow-once",
  allowAlways: "allow-always",
  rejectOnce: "reject-once",
};
export const sessionId = "mock-session-1";

export const cancelledSessions = new Set<string>();

export const runtime: {
  currentModeId: string;
  currentModelId: string;
  parameterizedModelPicker: boolean;
  currentReasoning: string;
  currentContext: string;
  currentFast: boolean;
  currentAgent: string;
  authenticated: boolean;
  promptCount: number;
  configuredProvider: AcpSchema.ProviderCurrentConfig | null;
} = {
  currentModeId: antigravityProfile
    ? "default"
    : copilotModesProfile
      ? copilotModeId("agent")
      : "ask",
  currentModelId: antigravityProfile ? "gemini-test-low" : "default",
  parameterizedModelPicker: false,
  currentReasoning: "medium",
  currentContext: "272k",
  currentFast: false,
  currentAgent: "",
  authenticated: !requiresAuthentication,
  promptCount: 0,
  configuredProvider: null,
};
