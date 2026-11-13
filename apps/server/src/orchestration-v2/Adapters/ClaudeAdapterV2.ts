// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { makeProviderTextDeltaCoalescer } from "./ProviderTextDeltaCoalescer.ts";

import { claudeTaskOutputRoot, tailClaudeTaskOutput } from "./ClaudeTaskOutputTail.ts";

import {
  dynamicToolTitle,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";

import { field, text } from "../unknownField.ts";

import { mergeWorkflowAgentMetadata } from "../workflowAgentAnswers.ts";
import type { WorkflowAgentMetadata } from "../workflowAgentAnswers.ts";

import {
  initialWorkflowAgentTranscriptCursor,
  readWorkflowAgentTranscript,
} from "../workflowAgentTranscript.ts";
import type { WorkflowAgentTranscriptCursor } from "../workflowAgentTranscript.ts";

import {
  CLAUDE_WORKFLOW_TASK_TYPE,
  hasClaudeWorkflowSnapshot,
  mergeClaudeWorkflowProgress,
  parseClaudeWorkflowRunHandles,
} from "./claudeWorkflowProgress.ts";

import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

import {
  addClaudeLedgerUsage,
  claudeLedgerDelta,
  claudeModelLedger,
  claudeReportedContextWindows,
  normalizeClaudeTurnTokenUsage,
} from "../../provider/ClaudeTurnTokenUsage.ts";
import type { ClaudeLedgerUsage } from "../../provider/ClaudeTurnTokenUsage.ts";

import { query, resolveSettings as resolveClaudeSettings } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  ForkSessionOptions,
  ForkSessionResult,
  Options as ClaudeQueryOptions,
  PermissionResult,
  Settings as ClaudeSdkSettings,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";

import {
  CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER,
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  formatClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";

import {
  ClaudeSettings,
  isCompactionCommandMessage,
  OrchestrationV2ProviderGoal,
  resolveIdleCompaction,
} from "@t3tools/contracts";
import type {
  ModelSelection,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderFailure,
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowRunHandles,
  OrchestrationV2TurnItem,
  ProviderApprovalOption,
  ProviderRequestKind,
  ProviderUserInputAnswers,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import * as Cause from "effect/Cause";

import * as Clock from "effect/Clock";

import * as Context from "effect/Context";

import * as SecureRandom from "effect/crypto/SecureRandom";

import * as DateTime from "effect/DateTime";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Equal from "effect/Equal";

import * as Fiber from "effect/Fiber";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as Queue from "effect/Queue";

import * as Ref from "effect/Ref";

import * as Semaphore from "effect/Semaphore";

import * as Stream from "effect/Stream";

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { resolveClaudeSdkExecutablePath } from "../../provider/Drivers/ClaudeExecutable.ts";

import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";

import * as ServerConfig from "../../config.ts";

import * as PortScanner from "../../preview/PortScanner.ts";

import * as ServerSettings from "../../serverSettings.ts";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import {
  claudeSignedOutMessage,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "../../provider/Drivers/ClaudeHome.ts";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
  scopeClaudeModelCatalog,
} from "../../provider/ClaudeModelCatalog.ts";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";

import { claudeRateLimitEventToUpdate } from "../../provider/claudeUsageLimits.ts";

import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";

import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import type { ProviderAdapterDriverCreateInput } from "@t3tools/provider-core/server/adapterDriver";

import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import type { BackgroundWorkReport } from "@t3tools/provider-core/server/notification";

import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";

import type { ActiveClaudeProviderRetry } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeSubagent } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeToolCall } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import { BACKGROUND_MOVE_TIMEOUT_MS } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_ATTACHMENT_MAX_BYTES } from "./ClaudeUserMessage.ts";
import { CLAUDE_ATTACHMENT_MAX_PAGES } from "./ClaudeUserMessage.ts";
import { CLAUDE_CODE_PRESET_TOOLS } from "./ClaudeQueryRunnerTypes.ts";
import { CLAUDE_DEFAULT_INSTANCE_ID } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_GOAL_DEFERRING_TASK_TYPES } from "./ClaudeToolClassification.ts";
import { CLAUDE_MCP_ELICITATION_OPTIONS } from "./ClaudeApprovals.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_READ_ONLY_ALLOWED_TOOLS } from "./ClaudeQueryRunnerTypes.ts";
import { CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS } from "./ClaudeQueryLaunchArgs.ts";
import { CLAUDE_STOP_CONFIRM_TIMEOUT_MS } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_T3_MCP_TOOL_TIMEOUT_MS } from "./ClaudeQueryLaunchArgs.ts";
import { CLAUDE_T3_MCP_TOOL_WILDCARD } from "./ClaudeQueryLaunchArgs.ts";
import { CLAUDE_TASK_TOOL_NAMES } from "./ClaudeSessionTypes.ts";
import { CLAUDE_WAKE_TURN_START_DEADLINE } from "./ClaudeProviderIdentity.ts";
import type { ClaudeAdapterV2Options } from "./ClaudeSessionTypes.ts";
import type { ClaudeAgentSdkLoggedQueryOptions } from "./ClaudeQueryRunnerProtocol.ts";
import type { ClaudeAgentSdkProtocolLogEvent } from "./ClaudeQueryRunnerProtocol.ts";
import type { ClaudeAgentSdkProtocolLogger } from "./ClaudeQueryRunnerProtocol.ts";
import type { ClaudeAgentSdkQueryOpenInput } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQueryOptions } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQueryPresetTools } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeAgentSdkQueryRunnerError } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQuerySession } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQueryToolList } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQueryTools } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkSessionForkInput } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkSubagentLookupInput } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeAppendSystemPromptFileError } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeAppendSystemPromptMissingValueError } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeApprovalResponse } from "./ClaudeSessionTypes.ts";
import { ClaudeBackgroundWorkBlocksQueryReplacementError } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeBypassAvailability } from "./ClaudeRuntimePolicy.ts";
import { ClaudeBypassSettings } from "./ClaudeRuntimePolicy.ts";
import type { ClaudeLiveQueryContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeMessageUsage } from "./ClaudeProviderIdentity.ts";
import type { ClaudeNativeToolInput } from "./ClaudeToolClassification.ts";
import type { ClaudeNativeToolOutput } from "./ClaudeToolClassification.ts";
import { ClaudeProviderCapabilitiesV2 } from "./ClaudeProviderIdentity.ts";
import type { ClaudeQueryStreamExit } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeRuntimeQueryPolicy } from "./ClaudeRuntimePolicy.ts";
import { ClaudeSettingsLaunchArgError } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeSubagentProjectionTarget } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeTaskList } from "./ClaudeSessionTypes.ts";
import type { ClaudeToolClassification } from "./ClaudeToolClassification.ts";
import type { ClaudeToolPresentation } from "./ClaudeToolClassification.ts";
import type { ClaudeToolResultContentBlock } from "./ClaudeRuntimePolicy.ts";
import { EMPTY_CLAUDE_NATIVE_TOOL_INPUT } from "./ClaudeToolClassification.ts";
import { NO_CLAUDE_NATIVE_TOOL_OUTPUT } from "./ClaudeToolClassification.ts";
import { PENDING_CLAUDE_SUBAGENT_CAP } from "./ClaudeSessionTypes.ts";
import { PENDING_CLAUDE_SUBAGENT_FRAME_CAP } from "./ClaudeSessionTypes.ts";
import type { PendingClaudeRuntimeRequest } from "./ClaudeSessionTypes.ts";
import type { PendingClaudeSubagentLaunch } from "./ClaudeSessionTypes.ts";
import { WEB_FETCH_SNIPPET_MAX_CHARS } from "./ClaudeToolClassification.ts";
import { WORKFLOW_MEMBER_TRANSCRIPT_FLUSH_MS } from "./ClaudeProviderIdentity.ts";
import { applyClaudeTaskTool } from "./ClaudeSessionTypes.ts";
import { assistantTextFromSdkMessage } from "./ClaudeProviderMessages.ts";
import { awaitClaudeApprovalDecision } from "./ClaudeApprovals.ts";
import { awaitClaudeUserInputAnswers } from "./ClaudeApprovals.ts";
import { buildAssistantArtifacts } from "./ClaudeAssistantArtifacts.ts";
import { canApplyClaudeSelectionLive } from "./ClaudeQueryOptions.ts";
import { canonicalClaudeSubagentModel } from "./ClaudeSessionTypes.ts";
import { classifyClaudeNativeTool } from "./ClaudeToolClassification.ts";
import { claudeApprovalPresentation } from "./ClaudeApprovals.ts";
import { claudeBypassAvailability } from "./ClaudeRuntimePolicy.ts";
import { claudeCommandOutputText } from "./ClaudeToolClassification.ts";
import { claudeEchoedPromptUuids } from "./ClaudeApprovals.ts";
import { claudeEffectiveQueryPolicyKey } from "./ClaudeRuntimePolicy.ts";
import { claudeFileChangeText } from "./ClaudeToolClassification.ts";
import { claudeFocusRequestedPanePlugin } from "./ClaudeSessionTypes.ts";
import { claudeFrameToolUseIds } from "./ClaudeApprovals.ts";
import { claudeLiveSelectionFlagSettings } from "./ClaudeQueryOptions.ts";
import { claudeMcpElicitationAcceptance } from "./ClaudeApprovals.ts";
import { claudeMcpQueryOverrides } from "./ClaudeQueryLaunchArgs.ts";
import { claudeMessageInputTokens } from "./ClaudeProviderIdentity.ts";
import { claudeNativeToolInputFromRecord } from "./ClaudeToolClassification.ts";
import { claudeNativeToolInputFromUnknown } from "./ClaudeToolClassification.ts";
import { claudeNativeToolInputValue } from "./ClaudeToolClassification.ts";
import { claudeNativeToolOutputText } from "./ClaudeToolClassification.ts";
import { claudeNativeToolOutputValue } from "./ClaudeToolClassification.ts";
import { claudePendingBackgroundTask } from "./ClaudeToolClassification.ts";
import { claudePendingBackgroundTasksFromRoster } from "./ClaudeToolClassification.ts";
import { claudePromptLifecycle } from "./ClaudeApprovals.ts";
import { claudeProposedPlan } from "./ClaudeSessionTypes.ts";
import { claudeProviderTurnTokenUsage } from "./ClaudeProviderIdentity.ts";
import { claudeQueryEnvironment } from "./ClaudeQueryOptions.ts";
import { claudeQueryMessages } from "./ClaudeQueryRunnerProtocol.ts";
import { claudeRuntimeQueryPolicyForRuntimePolicy } from "./ClaudeRuntimePolicy.ts";
import { claudeSdkBypassSettings } from "./ClaudeRuntimePolicy.ts";
import { claudeSdkLaunchArgSettings } from "./ClaudeRuntimePolicy.ts";
import { claudeSdkUserInputAnswers } from "./ClaudeSessionTypes.ts";
import { claudeSubagentModelSelection } from "./ClaudeSessionTypes.ts";
import { claudeSubagentResultText } from "./ClaudeToolClassification.ts";
import { claudeTaskField } from "./ClaudeSessionTypes.ts";
import { claudeTaskSteps } from "./ClaudeSessionTypes.ts";
import { claudeTaskTypeFromSdkMessage } from "./ClaudeToolClassification.ts";
import { claudeTodoSteps } from "./ClaudeSessionTypes.ts";
import { claudeToolNonExecutionKind } from "./ClaudeToolClassification.ts";
import { claudeToolPresentationsFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { claudeToolResultBlocksFromUserMessage } from "./ClaudeToolClassification.ts";
import { claudeToolResultEntriesFromMessage } from "./ClaudeToolClassification.ts";
import { claudeToolSearchOverride } from "./ClaudeQueryOptions.ts";
import { claudeToolUseBlocksFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { claudeUsageLimitResetAt } from "./ClaudeApprovals.ts";
import { claudeUserInputQuestions } from "./ClaudeSessionTypes.ts";
import { claudeWritesUpdatesAsThinking } from "./ClaudeProviderMessages.ts";
import { commandInputFromClaudeTool } from "./ClaudeToolClassification.ts";
import { decodeClaudeBypassSettings } from "./ClaudeRuntimePolicy.ts";
import { decodeClaudeEnvSettings } from "./ClaudeRuntimePolicy.ts";
import { decodeClaudeLaunchArgBypassSettings } from "./ClaudeRuntimePolicy.ts";
import { decodeClaudePromptCacheTtl } from "./ClaudeRuntimePolicy.ts";
import { decodeClaudeSubagentCacheSettings } from "./ClaudeRuntimePolicy.ts";
import { describeClaudeUsageLimit } from "./ClaudeAssistantArtifacts.ts";
import { fileNameFromClaudeTool } from "./ClaudeToolClassification.ts";
import { firstStringInputField } from "./ClaudeToolClassification.ts";
import { getNativeConversationHeadId } from "./ClaudeProviderMessages.ts";
import { getNativeThreadId } from "./ClaudeProviderMessages.ts";
import { inputRecordValue } from "./ClaudeToolClassification.ts";
import { isClaudeActiveSteeringAbortResult } from "./ClaudeApprovals.ts";
import { isClaudeBackgroundTasksChangedMessage } from "./ClaudeToolClassification.ts";
import { isClaudeBlockedAssistantRateLimit } from "./ClaudeApprovals.ts";
import { isClaudeConversationLine } from "./ClaudeProviderMessages.ts";
import { isClaudeGoalAcknowledgement } from "./ClaudeProviderMessages.ts";
import { isClaudeNonSubagentTask } from "./ClaudeToolClassification.ts";
import { isClaudePromptEchoGatedFrame } from "./ClaudeApprovals.ts";
import { isClaudePromptUuid } from "./ClaudeUserMessage.ts";
import { isClaudeProviderContinuationTurn } from "./ClaudeApprovals.ts";
import { isClaudeResultForOtherTurn } from "./ClaudeApprovals.ts";
import { isClaudeRootTurnFrame } from "./ClaudeToolClassification.ts";
import { isClaudeSubagentAsyncLaunchAck } from "./ClaudeToolClassification.ts";
import { isClaudeTaskNotificationOriginResult } from "./ClaudeApprovals.ts";
import { isClaudeToolResultError } from "./ClaudeToolClassification.ts";
import { isClaudeTranscriptConversationLine } from "./ClaudeSessionTypes.ts";
import { isClaudeTranscriptTurnEnd } from "./ClaudeSessionTypes.ts";
import { isClaudeTurnStartMessage } from "./ClaudeToolClassification.ts";
import { isProviderAdapterRollbackThreadError } from "./ClaudeQueryRunnerProtocol.ts";
import { isProviderAdapterRuntimeRequestResponseError } from "./ClaudeQueryRunnerProtocol.ts";
import { loggedClaudeQueryOptions } from "./ClaudeQueryRunnerProtocol.ts";
import { makeClaudeAttachmentBudget } from "./ClaudeUserMessage.ts";
import { makeClaudeQueryOptions } from "./ClaudeQueryOptions.ts";
import { makeClaudeQueryRunnerLayer } from "./ClaudeQueryRunnerLayer.ts";
import { makeClaudeUserMessage } from "./ClaudeUserMessage.ts";
import { makeClaudeUserMessageWithAttachments } from "./ClaudeUserMessage.ts";
import { makeProviderThread } from "./ClaudeProviderMessages.ts";
import { mergeClaudeStreamUsage } from "./ClaudeProviderIdentity.ts";
import { nextClaudeGoal } from "./ClaudeProviderMessages.ts";
import { normalizeClaudeResultText } from "./ClaudeProviderMessages.ts";
import { parentToolUseIdFromSdkMessage } from "./ClaudeToolClassification.ts";
import { parseClaudeBackgroundTaskEntry } from "./ClaudeToolClassification.ts";
import { permissionModeForClaudeRuntimePolicy } from "./ClaudeRuntimePolicy.ts";
import { permissionResultFromDecision } from "./ClaudeApprovals.ts";
import { providerFailureFromApiRetry } from "./ClaudeApprovals.ts";
import { providerFailureFromResult } from "./ClaudeApprovals.ts";
import { providerGoalsEqual } from "./ClaudeProviderMessages.ts";
import { providerRequestKindFromClaudeTool } from "./ClaudeToolClassification.ts";
import { providerSession } from "./ClaudeProviderMessages.ts";
import { readClaudeAppendSystemPromptFile } from "./ClaudeQueryLaunchArgs.ts";
import { readClaudeLaunchArgSettings } from "./ClaudeQueryLaunchArgs.ts";
import { readClaudeTaskList } from "./ClaudeSessionTypes.ts";
import { rememberClaudeSubagentLaunch } from "./ClaudeSessionTypes.ts";
import { rememberPendingClaudeSubagentLaunch } from "./ClaudeSessionTypes.ts";
import { requiresClaudeApproval } from "./ClaudeRuntimePolicy.ts";
import { reserveClaudePdfBudget } from "./ClaudeUserMessage.ts";
import { resolveClaudeForkUpToMessageId } from "./ClaudeProviderMessages.ts";
import { resolveClaudeRollbackResumeSessionAt } from "./ClaudeProviderMessages.ts";
import { resultTextFromSdkMessage } from "./ClaudeProviderMessages.ts";
import { sandboxPolicyKindForClaudeRuntimePolicy } from "./ClaudeRuntimePolicy.ts";
import { spawnClaudeProcessGroup } from "./ClaudeProviderIdentity.ts";
import { summarizeClaudeToolRequest } from "./ClaudeToolClassification.ts";
import { terminalStatusFromResult } from "./ClaudeApprovals.ts";
import { textFromClaudeContent } from "./ClaudeProviderMessages.ts";
import { toolNameFromClaudeToolResult } from "./ClaudeToolClassification.ts";
import { webSearchPatternsFromClaudeTool } from "./ClaudeToolClassification.ts";
import { webSearchResultsFromClaudeOutput } from "./ClaudeToolClassification.ts";
import { makeClaudeAdapterEnv } from "./ClaudeAdapterEnv.ts";
import { makeClaudeSessionState } from "./ClaudeSessionState.ts";
import { installWake } from "./claudeSessionWake.ts";
import { installRoster } from "./claudeSessionRoster.ts";
import { installTurnItems } from "./claudeSessionTurnItems.ts";
import { installSubagents } from "./claudeSessionSubagents.ts";
import { installWorkflow } from "./claudeSessionWorkflow.ts";
import { installSubagentNode } from "./claudeSessionSubagentNode.ts";
import { installSubagentRecovery } from "./claudeSessionSubagentRecovery.ts";
import { installFinalize } from "./claudeSessionFinalize.ts";
import { installWakeBuffer } from "./claudeSessionWakeBuffer.ts";
import { installFrameA } from "./claudeSessionFrameA.ts";
import { installFrameB } from "./claudeSessionFrameB.ts";
import { installFrameC } from "./claudeSessionFrameC.ts";
import { installFrame } from "./claudeSessionFrame.ts";
import { installFrameTail } from "./claudeSessionFrameTail.ts";
import { installApprovals } from "./claudeSessionApprovals.ts";
import { installQuery } from "./claudeSessionQuery.ts";
import { installTurns } from "./claudeSessionTurns.ts";
import { installControl } from "./claudeSessionControl.ts";
import { makeClaudeSessionRuntime } from "./claudeSessionRuntime.ts";
export {
  CLAUDE_PROVIDER,
  claudeProviderTurnTokenUsage,
  CLAUDE_DEFAULT_INSTANCE_ID,
  spawnClaudeProcessGroup,
  ClaudeProviderCapabilitiesV2,
} from "./ClaudeProviderIdentity.ts";

export {
  CLAUDE_READ_ONLY_ALLOWED_TOOLS,
  ClaudeAgentSdkQueryRunnerError,
  ClaudeBackgroundWorkBlocksQueryReplacementError,
  ClaudeAppendSystemPromptFileError,
  ClaudeAppendSystemPromptMissingValueError,
  ClaudeSettingsLaunchArgError,
} from "./ClaudeQueryRunnerTypes.ts";
export type {
  ClaudeAgentSdkQueryToolList,
  ClaudeAgentSdkQueryPresetTools,
  ClaudeAgentSdkQueryTools,
  ClaudeAgentSdkQueryOptions,
  ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQuerySession,
  ClaudeAgentSdkSessionForkInput,
  ClaudeAgentSdkSubagentLookupInput,
} from "./ClaudeQueryRunnerTypes.ts";
export interface ClaudeAgentSdkQueryRunnerShape {
  readonly allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError>;
  readonly open: (
    input: ClaudeAgentSdkQueryOpenInput,
  ) => Effect.Effect<ClaudeAgentSdkQuerySession, ClaudeAgentSdkQueryRunnerError>;
  readonly forkSession: (
    input: ClaudeAgentSdkSessionForkInput,
  ) => Effect.Effect<
    ForkSessionResult & { readonly headMessageId?: string },
    ClaudeAgentSdkQueryRunnerError
  >;
  readonly subagentLaunchToolUseId: (
    input: ClaudeAgentSdkSubagentLookupInput,
  ) => Effect.Effect<string | null, ClaudeAgentSdkQueryRunnerError>;
  readonly assertComplete: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export class ClaudeAgentSdkQueryRunner extends Context.Service<
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerShape
>()("t3/orchestration-v2/Adapters/ClaudeAdapterV2/ClaudeAgentSdkQueryRunner") {}

export { claudeQueryMessages, loggedClaudeQueryOptions } from "./ClaudeQueryRunnerProtocol.ts";
export type {
  ClaudeAgentSdkLoggedQueryOptions,
  ClaudeAgentSdkProtocolLogEvent,
  ClaudeAgentSdkProtocolLogger,
} from "./ClaudeQueryRunnerProtocol.ts";

export const layerQueryRunner: Layer.Layer<
  ClaudeAgentSdkQueryRunner,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | Path.Path
  | PortScanner.PortDiscovery
  | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(ClaudeAgentSdkQueryRunner, makeClaudeQueryRunnerLayer);
export { makeClaudeQueryRunnerLayer } from "./ClaudeQueryRunnerLayer.ts";

export {
  claudeQueryEnvironment,
  claudeToolSearchOverride,
  makeClaudeQueryOptions,
} from "./ClaudeQueryOptions.ts";
export {
  CLAUDE_T3_MCP_TOOL_WILDCARD,
  CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
  CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
  claudeMcpQueryOverrides,
} from "./ClaudeQueryLaunchArgs.ts";

export { makeClaudeUserMessage, isClaudePromptUuid } from "./ClaudeUserMessage.ts";
export {
  claudeRuntimeQueryPolicyForRuntimePolicy,
  claudeEffectiveQueryPolicyKey,
} from "./ClaudeRuntimePolicy.ts";
export type { ClaudeRuntimeQueryPolicy } from "./ClaudeRuntimePolicy.ts";

export {
  claudeApprovalPresentation,
  permissionResultFromDecision,
  awaitClaudeApprovalDecision,
  claudeMcpElicitationAcceptance,
} from "./ClaudeApprovals.ts";

export { claudeUserInputQuestions, claudeSdkUserInputAnswers } from "./ClaudeSessionTypes.ts";
export type { ClaudeAdapterV2Options } from "./ClaudeSessionTypes.ts";
export const makeClaudeAdapterV2 = Effect.fn("makeClaudeAdapterV2")(function* (
  adapterOptions: ClaudeAdapterV2Options,
) {
  const env = yield* makeClaudeAdapterEnv(adapterOptions);

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: CLAUDE_PROVIDER,
    getCapabilities: Effect.fn("ClaudeAdapterV2.getCapabilities")(function () {
      return Effect.succeed(ClaudeProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("ClaudeAdapterV2.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("ClaudeAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const state = yield* makeClaudeSessionState({ ...env, input });
        const s1 = { ...state, ...installWake(state) };
        const s2 = { ...s1, ...installRoster(s1) };
        const s3 = { ...s2, ...installTurnItems(s2) };
        const s4 = { ...s3, ...installSubagents(s3) };
        const s5 = { ...s4, ...installWorkflow(s4) };
        const s6 = { ...s5, ...installSubagentNode(s5) };
        const s7 = { ...s6, ...installSubagentRecovery(s6) };
        const s8 = { ...s7, ...installFinalize(s7) };
        const s9 = { ...s8, ...installWakeBuffer(s8) };
        const s10 = { ...s9, ...installFrameA(s9) };
        const s11 = { ...s10, ...installFrameB(s10) };
        const s12 = { ...s11, ...installFrameC(s11) };
        const s13 = { ...s12, ...installFrame(s12) };
        const s14 = { ...s13, ...installFrameTail(s13) };
        const s15 = { ...s14, ...installApprovals(s14) };
        const s16 = { ...s15, ...installQuery(s15) };
        const s17 = { ...s16, ...installTurns(s16) };
        const s18 = { ...s17, ...installControl(s17) };
        const session = s18;
        yield* Effect.addFinalizer(() => session.closeSession());
        return makeClaudeSessionRuntime(session, input);
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CLAUDE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});

export type ClaudeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | ClaudeAgentSdkQueryRunner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ServerConfig.ServerConfig;

export const createClaudeAdapterV2 = Effect.fn("ClaudeAdapterV2Driver.create")(
  function* (
    input: ProviderAdapterDriverCreateInput<ClaudeSettings>,
    hooks: Pick<ClaudeAdapterV2Options, "scopedLimitNames" | "onUsageLimits"> = {},
  ) {
    const { instanceId, environment, enabled, config } = input;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcess.Environment;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const queryRunner = yield* ClaudeAgentSdkQueryRunner;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const baseEnvironment = yield* mergeClaudeProcessEnvironment(
      config,
      environment,
      hostEnvironment,
    );
    const claudeEnvironment = yield* makeClaudeEnvironment(config, baseEnvironment);
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const binaryPath = yield* resolveClaudeSdkExecutablePath(
      expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      claudeEnvironment,
    );
    return yield* makeClaudeAdapterV2({
      instanceId,
      settings: { ...config, enabled, binaryPath },
      environment: claudeEnvironment,
      attachmentsDir: serverConfig.attachmentsDir,
      fileSystem,
      path,
      random,
      idAllocator,
      queryRunner,
      continuationRequests,
      ...hooks,
    });
  },
  (effect, input, _hooks) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: CLAUDE_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create Claude Agent SDK adapter.",
            cause,
          }),
      ),
    ),
);
