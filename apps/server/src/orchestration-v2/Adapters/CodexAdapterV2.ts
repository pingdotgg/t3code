import { revertCodexThread } from "../../provider/CodexThreadRevert.ts";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderTextDeltaCoalescer } from "./ProviderTextDeltaCoalescer.ts";
import {
  mcpToolPresentation,
  type McpToolPresentation,
} from "../../provider/CodexToolPresentation.ts";
import {
  makeCodexTurnTokenUsageState,
  getCodexTurnAccumulator,
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  type CodexTurnTokenUsageState,
} from "../../provider/CodexTurnTokenUsage.ts";
import type { ServerProviderShape } from "@t3tools/provider-core/server/snapshot";
import type { CodexEffectiveRuntime } from "../../provider/CodexManagedRuntime.ts";
import { buildCodexInitializeParams } from "../../provider/CodexProvider.ts";
import {
  codexRateLimitsToUpdate,
  mergeCodexRateLimits,
  codexUsageLimitResetAt,
  type CodexRateLimitSnapshot,
} from "../../provider/codexUsageLimits.ts";
import {
  CodexSettings,
  defaultInstanceIdForDriver,
  isOrchestrationV2WorkActive,
  OrchestrationV2ProviderGoal,
  ProviderDriverKind,
  type ProviderSetupError,
} from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { dynamicToolTitle } from "@t3tools/shared/toolActivity";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type {
  ChatAttachment,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  ModelSelection,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2PlanStep,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  ProviderThreadId,
  ProviderTurnId,
  ProviderInstanceId,
  RuntimeMode,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { resolveAttachmentPath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "../../provider/CodexDeveloperInstructions.ts";
import {
  describeMcpElicitation,
  toMcpElicitationResponse,
} from "../../provider/CodexMcpElicitation.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../provider/Drivers/CodexHomeLayout.ts";
import {
  boundProviderEventForLogging,
  type EventNdjsonLogger,
  shouldPersistProviderEvent,
} from "../../provider/EventNdjsonLogger.ts";
import { ProviderEventLoggers } from "../../provider/ProviderEventLoggers.ts";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_MIME_TYPE,
  MCP_APP_OUTPUT_KEY,
  MCP_APP_RESOURCE_SCHEME,
} from "@t3tools/shared/mcpApp";
import { snapshotMcpApp } from "../../mcpApps/McpAppSnapshot.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "@t3tools/provider-core/server/IdAllocator";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "@t3tools/provider-core/server/continuationRequests";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2ForkThreadInput,
  type ProviderAdapterV2RollbackThreadInput,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2McpApps,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "../SubagentProjection.ts";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");
export const CODEX_DRIVER_KIND = CODEX_PROVIDER;
export const CODEX_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER_KIND);

/** Describe approval scope even when Codex omits or blanks the optional reason. */
export function codexFileChangeApprovalPrompt(input: {
  readonly reason?: string | null;
  readonly grantRoot?: string | null;
  readonly fileChanges?: CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"];
}): string | undefined {
  const reason = input.reason?.trim();
  if (reason) return reason;
  const entries = Object.entries(input.fileChanges ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length > 0) {
    const described = entries.slice(0, 20).map(([path, change]) => {
      const movePath = change.type === "update" ? change.move_path : undefined;
      return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
    });
    const remaining = entries.length - described.length;
    return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
  }
  return input.grantRoot?.trim() || undefined;
}

// Reasoning effort changes future generation, not the existing context's tokenizer
// or model window. All other option changes remain untrusted until new telemetry.
export function canReuseCodexContextUsage(previous: ModelSelection, next: ModelSelection): boolean {
  return modelSelectionsEqual(
    {
      ...previous,
      options: (previous.options ?? []).filter((option) => option.id !== "reasoningEffort"),
    },
    { ...next, options: (next.options ?? []).filter((option) => option.id !== "reasoningEffort") },
  );
}

export function codexProviderTurnTokenUsage(
  tokenUsage: CodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
  updatedAt: string,
) {
  return {
    usedTokens: Math.max(0, tokenUsage.last.totalTokens),
    maxTokens: tokenUsage.modelContextWindow ?? null,
    inputTokens: Math.max(0, tokenUsage.last.inputTokens),
    cachedInputTokens: Math.max(0, tokenUsage.last.cachedInputTokens),
    outputTokens: Math.max(0, tokenUsage.last.outputTokens),
    reasoningOutputTokens: Math.max(0, tokenUsage.last.reasoningOutputTokens),
    updatedAt,
  };
}
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS = 50;
const CodexBackgroundTerminalTerminateResponse = Schema.Struct({
  terminated: Schema.Boolean,
});
const CodexBackgroundTerminalsListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      processId: Schema.String,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
type CodexBackgroundTerminalsListPage = typeof CodexBackgroundTerminalsListResponse.Type;
const decodeCodexBackgroundTerminalTerminateResponse = Schema.decodeUnknownEffect(
  CodexBackgroundTerminalTerminateResponse,
);
const decodeCodexBackgroundTerminalsListResponse = Schema.decodeUnknownEffect(
  CodexBackgroundTerminalsListResponse,
);
const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: true,
  optOutNotificationMethods: ["turn/diff/updated"],
  // Declares MCP Apps support (SEP-1724 extension negotiation), so servers
  // attach their UI resources and Codex reports them on tool call items.
  extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
} as const;

export const CodexProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

function toProtocolError(detail: string, payload?: unknown): ProviderAdapterProtocolError {
  return new ProviderAdapterProtocolError({
    driver: CODEX_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

function normalizeCodexCause(error: unknown): unknown {
  return error;
}

function codexTimestamp(seconds: number | null | undefined): DateTime.Utc {
  return seconds === null || seconds === undefined
    ? DateTime.nowUnsafe()
    : DateTime.makeUnsafe(seconds * 1000);
}

function codexUserMessageText(
  content: ReadonlyArray<CodexSchema.V2ItemCompletedNotification__UserInput>,
): string {
  return content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
    .trim();
}

function mapCodexTurnStatus(
  status: CodexSchema.V2TurnCompletedNotification__TurnStatus,
): OrchestrationV2ProviderTurn["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "inProgress":
      return "running";
  }
}

function providerTurnStatusToTerminal(
  status: OrchestrationV2ProviderTurn["status"],
): Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "running":
      return "failed";
  }
}

function codexItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly turnItem: OrchestrationV2TurnItem["status"];
  readonly completed: boolean;
} {
  switch (status) {
    case "inProgress":
      return { node: "running", turnItem: "running", completed: false };
    case "completed":
      return {
        node: "completed",
        turnItem: "completed",
        completed: true,
      };
    case "failed":
      return { node: "failed", turnItem: "failed", completed: true };
    case "declined":
      return {
        node: "cancelled",
        turnItem: "cancelled",
        completed: true,
      };
  }
}

/**
 * The composers let a skill be typed with any currency sigil (`€review`), but
 * Codex only parses `$name` as a skill mention. Rewrite the sigil so the skill
 * runs; currency amounts like `€20` do not match and stay prose.
 */
export function codexSkillMentionText(text: string): string {
  return text.replace(SKILL_MENTION_PATTERN, "$1$$$2");
}

const BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH = 200;
const BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH = 1_000;

export function codexBackgroundCommandDetail(item: {
  readonly command: string;
  readonly exitCode?: number | null | undefined;
  readonly aggregatedOutput?: string | null | undefined;
}): string {
  const command =
    item.command.length > BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH
      ? `${item.command.slice(0, BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH)}...`
      : item.command;
  const exit =
    item.exitCode === null || item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`;
  const output = (item.aggregatedOutput ?? "").trimEnd();
  const outputTail =
    output.length > BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH
      ? `...${output.slice(-BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH)}`
      : output;
  const header = `Background command completed${exit}: ${command}`;
  return outputTail.length === 0 ? header : `${header}\n\nOutput tail:\n${outputTail}`;
}

export interface CodexDynamicToolProjection extends McpToolPresentation {
  readonly toolName: string;
  readonly title?: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly status: OrchestrationV2TurnItem["status"];
}

function codexMcpToolOutput(
  item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
): unknown | undefined {
  const resultOutput =
    item.result === null || item.result === undefined
      ? undefined
      : item.result.structuredContent !== null && item.result.structuredContent !== undefined
        ? item.result.structuredContent
        : item.result.content;

  if (item.error === null || item.error === undefined) {
    return resultOutput;
  }
  return resultOutput === undefined
    ? { error: item.error.message }
    : { error: item.error.message, result: resultOutput };
}

// Reading an app's resource is one MCP round trip; a server that hangs must not
// hold the item (and the run's ingestion) open.
const MCP_APP_CAPTURE_TIMEOUT = "20 seconds";

/** The UI resource a completed Codex MCP tool call names, under any field Codex reports it in. */
function codexMcpAppResourceUri(item: CodexDynamicToolItem): string | undefined {
  if (item.type !== "mcpToolCall") return undefined;
  const uri = item.mcpAppUi?.resourceUri ?? item.mcpAppResourceUri ?? item.appContext?.resourceUri;
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}

function codexDynamicToolOutput(
  item: Extract<CodexDynamicToolItem, { readonly type: "dynamicToolCall" }>,
): unknown | undefined {
  if (item.contentItems !== null && item.contentItems !== undefined) {
    return item.contentItems;
  }
  return item.success === false ? { success: false } : undefined;
}

export const projectCodexDynamicToolItem = Effect.fn("CodexAdapterV2.projectDynamicToolItem")(
  function* (
    item: CodexDynamicToolItem,
  ): Effect.fn.Return<CodexDynamicToolProjection, never, Crypto.Crypto> {
    const output =
      item.type === "mcpToolCall" ? codexMcpToolOutput(item) : codexDynamicToolOutput(item);
    const toolName =
      item.type === "mcpToolCall"
        ? `${item.server}.${item.tool}`
        : [trimText(item.namespace), item.tool].filter(Boolean).join(".");
    const presentation: McpToolPresentation =
      item.type === "mcpToolCall" ? yield* mcpToolPresentation(item) : {};
    const title = dynamicToolTitle(toolName, item.arguments) ?? presentation.title;
    const projection: CodexDynamicToolProjection = {
      ...presentation,
      toolName,
      ...(title ? { title } : {}),
      input: item.arguments,
      status: codexItemStatus(item.status).turnItem,
    };
    return output === undefined ? projection : { ...projection, output };
  },
);

function codexNativeItemRef(nativeItemId: string) {
  return {
    driver: CODEX_PROVIDER,
    nativeId: nativeItemId,
    strength: "strong" as const,
  };
}

function trimText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function nonEmptyText(value: string | null | undefined, fallback: string): string {
  return trimText(value) ?? fallback;
}

function codexPlanStepStatus(
  status: CodexSchema.V2TurnPlanUpdatedNotification__TurnPlanStepStatus,
): OrchestrationV2PlanStep["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "inProgress":
      return "running";
    case "pending":
      return "pending";
  }
}

function approvalDecisionToLegacyReviewDecision(
  decision: ProviderApprovalDecision,
): CodexSchema.ExecCommandApprovalResponse__ReviewDecision {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
    case "acceptAlways":
      return "approved_for_session";
    case "decline":
      return { denied: { rejection: "User declined the request." } };
    case "cancel":
      return "abort";
  }
}

function providerRequestKindFromPermissions(
  permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): ProviderRequestKind {
  if ((permissions.fileSystem?.write?.length ?? 0) > 0) {
    return "file-change";
  }
  if ((permissions.fileSystem?.read?.length ?? 0) > 0) {
    return "file-read";
  }
  return "command";
}

function permissionsResponseFromDecision(input: {
  readonly decision: ProviderApprovalDecision;
  readonly permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"];
}): CodexSchema.PermissionsRequestApprovalResponse {
  if (input.decision !== "accept" && input.decision !== "acceptForSession") {
    return { permissions: {}, scope: "turn" };
  }

  return {
    permissions: input.permissions,
    scope: input.decision === "acceptForSession" ? "session" : "turn",
  };
}

function answerValueToStrings(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [JSON.stringify(value)];
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
  allowedQuestionIds: ReadonlySet<string>,
): CodexSchema.ToolRequestUserInputResponse["answers"] {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) =>
      allowedQuestionIds.has(questionId)
        ? [[questionId, { answers: [...answerValueToStrings(value)] }]]
        : [],
    ),
  );
}

function compactStrings(values: ReadonlyArray<string | null | undefined>): ReadonlyArray<string> {
  return values.flatMap((value) => {
    const trimmed = trimText(value);
    return trimmed === undefined ? [] : [trimmed];
  });
}

function webSearchPatterns(item: CodexWebSearchItem): ReadonlyArray<string> {
  if (item.action === null || item.action === undefined) {
    return compactStrings([item.query]);
  }

  switch (item.action.type) {
    case "search":
      return compactStrings([...(item.action.queries ?? []), item.action.query, item.query]);
    case "openPage":
      return compactStrings([item.action.url, item.query]);
    case "findInPage":
      return compactStrings([item.action.pattern, item.action.url, item.query]);
    case "other":
      return compactStrings([item.query]);
  }
}

const decodeTurnApprovalPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__AskForApproval, Schema.Null]),
);
const decodeTurnSandboxPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__SandboxPolicy, Schema.Null]),
);
const decodeTurnReasoningEffort = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__ReasoningEffort, Schema.Null]),
);

const CodexTurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(CodexSchema.ClientRequest__CollaborationMode),
    additionalContext: Schema.optionalKey(
      Schema.Record(Schema.String, CodexSchema.V2TurnStartParams__AdditionalContextEntry),
    ),
  }),
);
type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);
const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapterRuntimeRequestResponseError,
);

function codexRuntimeModeTurnDefaults(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexSchema.V2TurnStartParams__AskForApproval;
  readonly approvalsReviewer: CodexSchema.V2TurnStartParams__ApprovalsReviewer;
  readonly sandboxPolicy: CodexSchema.V2TurnStartParams__SandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "readOnly",
        },
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      };
  }
}

export function buildCodexTurnStartParams(input: {
  readonly nativeThreadId: string;
  readonly codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly hasT3Mcp?: boolean;
  readonly browserToolsAvailable?: boolean;
  readonly deviceToolsAvailable?: boolean;
  /** ChatGPT token sharing does not accept service tiers. */
  readonly omitServiceTier?: boolean;
  /** What the thread's MCP Apps want the agent to know (`ui/update-model-context`). */
  readonly appContext?: ProviderAdapterV2TurnInput["appContext"];
}) {
  return Effect.gen(function* () {
    const runtimeModeDefaults = codexRuntimeModeTurnDefaults(input.runtimePolicy.runtimeMode);
    const approvalPolicy =
      input.runtimePolicy.approvalPolicy === undefined
        ? runtimeModeDefaults.approvalPolicy
        : yield* decodeTurnApprovalPolicy(input.runtimePolicy.approvalPolicy);
    const sandboxPolicy =
      input.runtimePolicy.sandboxPolicy === undefined
        ? runtimeModeDefaults.sandboxPolicy
        : yield* decodeTurnSandboxPolicy(input.runtimePolicy.sandboxPolicy);
    const selectedEffort = getModelSelectionStringOptionValue(
      input.modelSelection,
      "reasoningEffort",
    );
    const effort =
      selectedEffort === undefined ? undefined : yield* decodeTurnReasoningEffort(selectedEffort);
    const serviceTier =
      input.omitServiceTier === true
        ? undefined
        : getCodexServiceTierOptionValue(input.modelSelection);
    const developerInstructions =
      input.hasT3Mcp !== true
        ? undefined
        : buildCodexDeveloperInstructions(input.runtimePolicy.interactionMode);
    // An app's context is text an MCP server wrote, so it goes in as untrusted
    // context: Codex renders it as quoted user-side input, never as developer
    // instructions. Codex resends it only when it changes.
    const appContext = Object.fromEntries(
      (input.appContext ?? []).map((entry) => [
        entry.key,
        { kind: "untrusted" as const, value: entry.text },
      ]),
    );
    const t3Context =
      input.hasT3Mcp === true
        ? buildCodexAdditionalContext(
            { model: input.modelSelection.model, reasoningEffort: effort ?? "medium" },
            {
              browser: input.browserToolsAvailable ?? true,
              device: input.deviceToolsAvailable ?? false,
            },
          )
        : undefined;
    const additionalContext =
      t3Context === undefined && Object.keys(appContext).length === 0
        ? undefined
        : { ...t3Context, ...appContext };
    const collaborationMode: CodexSchema.ClientRequest__CollaborationMode | undefined =
      input.runtimePolicy.interactionMode !== "plan" && developerInstructions === undefined
        ? undefined
        : {
            mode: input.runtimePolicy.interactionMode === "plan" ? "plan" : "default",
            settings: {
              model: input.modelSelection.model,
              reasoning_effort: effort ?? "medium",
              ...(developerInstructions === undefined
                ? {}
                : { developer_instructions: developerInstructions }),
            },
          };

    return yield* decodeCodexTurnStartParamsWithCollaborationMode({
      threadId: input.nativeThreadId,
      input: input.codexInput,
      ...(additionalContext ? { additionalContext } : {}),
      cwd: input.runtimePolicy.cwd,
      model: input.modelSelection.model,
      // Model catalogues can default summaries to "none". Request them on every
      // turn, including resumed threads, for T3's reasoning timeline.
      summary: "detailed",
      // Always explicit: omitting this on resume leaves Codex's previous
      // reviewer sticky after switching away from Auto mode.
      approvalsReviewer: runtimeModeDefaults.approvalsReviewer,
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(effort === undefined ? {} : { effort }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...(collaborationMode === undefined ? {} : { collaborationMode }),
    });
  });
}

function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function getNativeThreadId(providerThread: OrchestrationV2ProviderThread) {
  return Effect.gen(function* () {
    const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
    if (nativeThreadId === undefined || nativeThreadId === null) {
      return yield* toProtocolError(
        `Provider thread ${providerThread.id} is missing a native Codex thread id.`,
      );
    }
    return nativeThreadId;
  });
}

function providerThreadFromCodexThread(input: {
  readonly appThreadId: ThreadId | null;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly ownerNodeId: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly thread: {
    readonly createdAt: number;
    readonly forkedFromId?: string | null;
    readonly id: string;
    readonly updatedAt: number;
  };
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_PROVIDER,
      nativeThreadId: input.thread.id,
    }),
    driver: CODEX_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId,
    nativeThreadRef: {
      driver: CODEX_PROVIDER,
      nativeId: input.thread.id,
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: codexTimestamp(input.thread.createdAt),
    updatedAt: codexTimestamp(input.thread.updatedAt),
  };
}

// Counts toward native rollback. `/goal` control turns never reach Codex and
// carry no native ref, so they must not consume a native turn on revert.
const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
  turn.nativeTurnRef !== null &&
  (turn.status === "completed" ||
    turn.status === "interrupted" ||
    turn.status === "failed" ||
    turn.status === "cancelled");

export type CodexGoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

/**
 * Parses a `/goal` message the way the Codex TUI does: `clear`, `pause` and
 * `resume` control the current goal, a bare `/goal` shows it, and any other
 * text becomes the new objective. Returns null for every other message.
 */
export function parseCodexGoalCommand(text: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "edit":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument };
  }
}

type CodexThreadGoal = CodexSchema.V2ThreadGoalUpdatedNotification["goal"];

const CODEX_GOAL_STATUSES = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage_limited",
  budgetLimited: "budget_limited",
  complete: "complete",
} as const satisfies Record<CodexThreadGoal["status"], OrchestrationV2ProviderGoal["status"]>;

function providerGoalFromCodex(goal: CodexThreadGoal): OrchestrationV2ProviderGoal | null {
  const objective = goal.objective.trim();
  if (objective.length === 0) return null;
  return {
    objective,
    status: CODEX_GOAL_STATUSES[goal.status],
    tokensUsed: Math.max(0, goal.tokensUsed),
    tokenBudget: goal.tokenBudget ?? null,
    timeUsedSeconds: Math.max(0, goal.timeUsedSeconds),
  };
}

const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));

function describeCodexGoal(goal: OrchestrationV2ProviderGoal): string {
  return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}

// Codex starts the next goal turn milliseconds after the last one completes.
// A run waits this long for it before settling, in case Codex declines.
const CODEX_GOAL_CONTINUATION_GRACE = "5 seconds";

const providerTurnsForThread = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThread: OrchestrationV2ProviderThread,
): ReadonlyArray<OrchestrationV2ProviderTurn> =>
  providerTurns.filter((turn) => turn.providerThreadId === providerThread.id);

const countTerminalTurnsAfterBoundary = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerTurnId: ProviderTurnId,
): number | null => {
  const boundaryTurn = providerTurns.find((turn) => turn.id === providerTurnId);
  if (boundaryTurn === undefined) {
    return null;
  }

  return providerTurns.filter(
    (turn) => turn.ordinal > boundaryTurn.ordinal && isTerminalProviderTurn(turn),
  ).length;
};

const resolveCodexForkRollbackTurnCount = Effect.fn("CodexAdapterV2.resolveForkRollbackTurnCount")(
  function* (input: ProviderAdapterV2ForkThreadInput) {
    if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
      return 0;
    }

    const rollbackTurnCount = countTerminalTurnsAfterBoundary(
      providerTurnsForThread(input.sourceProviderTurns, input.sourceProviderThread),
      input.providerTurnId,
    );
    if (rollbackTurnCount === null) {
      return yield* new ProviderAdapterForkThreadError({
        driver: CODEX_PROVIDER,
        providerThreadId: input.sourceProviderThread.id,
        cause: `Cannot fork Codex thread from provider turn ${input.providerTurnId}: source turn was not found in provider thread ${input.sourceProviderThread.id}.`,
      });
    }

    return rollbackTurnCount;
  },
);

/**
 * Prefer a native `thread/fork` turn boundary over the fork-then-rollback
 * fallback. `lastTurnId` is inclusive on the Codex side, so a fork requested at
 * the selected turn omits every later turn atomically. That matters for
 * paginated threads. The count fallback resolves a `thread/revert` boundary
 * only for source turns that predate native turn references.
 */
export const resolveCodexForkBoundary = Effect.fn("CodexAdapterV2.resolveForkBoundary")(function* (
  input: ProviderAdapterV2ForkThreadInput,
) {
  const rollbackTurnCount = yield* resolveCodexForkRollbackTurnCount(input);
  if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
    return { lastTurnId: undefined, rollbackTurnCount };
  }

  const boundaryTurn = providerTurnsForThread(
    input.sourceProviderTurns,
    input.sourceProviderThread,
  ).find((turn) => turn.id === input.providerTurnId);
  const nativeTurnId = boundaryTurn?.nativeTurnRef?.nativeId;
  if (nativeTurnId === null || nativeTurnId === undefined) {
    return { lastTurnId: undefined, rollbackTurnCount };
  }

  return { lastTurnId: nativeTurnId, rollbackTurnCount: 0 };
});

/**
 * The generated `thread/read` response schema does not surface `historyMode`,
 * so the probe goes through the raw request channel with a permissive decode.
 */
const CodexThreadHistoryMetadata = Schema.Struct({
  thread: Schema.Struct({
    historyMode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
    status: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
  }),
});
const decodeCodexThreadHistoryMetadata = Schema.decodeUnknownEffect(CodexThreadHistoryMetadata);

const readCodexThreadHistoryMetadata = Effect.fn("CodexAdapterV2.readThreadHistoryMetadata")(
  function* (
    raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">,
    threadId: string,
  ) {
    const response = yield* raw.request("thread/read", { threadId, includeTurns: false });
    const metadata = yield* decodeCodexThreadHistoryMetadata(response).pipe(
      Effect.mapError((error) =>
        CodexErrors.CodexAppServerRequestError.invalidPayload(
          "thread/read",
          "decode-payload",
          error,
        ),
      ),
    );
    return {
      historyMode: metadata.thread.historyMode,
      loaded: metadata.thread.status?.type !== "notLoaded",
    };
  },
);

export const resolveCodexRollbackTurnCount = Effect.fn("CodexAdapterV2.resolveRollbackTurnCount")(
  function* (input: ProviderAdapterV2RollbackThreadInput) {
    const providerTurns = input.providerThreadTurns;
    switch (input.target.type) {
      case "thread_start":
        return providerTurns.filter(isTerminalProviderTurn).length;
      case "provider_turn": {
        if (input.target.providerTurn.providerThreadId !== input.providerThread.id) {
          return yield* new ProviderAdapterRollbackThreadError({
            driver: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
            cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${input.target.providerTurn.id}: target turn belongs to provider thread ${input.target.providerTurn.providerThreadId}.`,
          });
        }

        const rollbackTurnCount = countTerminalTurnsAfterBoundary(
          providerTurns,
          input.target.providerTurn.id,
        );
        if (rollbackTurnCount === null) {
          return yield* new ProviderAdapterRollbackThreadError({
            driver: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
            cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${input.target.providerTurn.id}: target turn was not found in durable provider turn history.`,
          });
        }

        return rollbackTurnCount;
      }
    }
  },
);

function parseCodexRetryProgress(
  message: string,
): Pick<OrchestrationV2ProviderRetry, "attempt" | "maxAttempts"> | null {
  const match = /\b(\d+)\s*\/\s*(\d+)\b/u.exec(message);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const attempt = Number.parseInt(match[1], 10);
  const maxAttempts = Number.parseInt(match[2], 10);
  if (attempt < 1 || maxAttempts < 1) {
    return null;
  }
  return { attempt, maxAttempts };
}

function codexErrorInfoCode(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return Object.keys(value)[0] ?? null;
}

interface ActiveCodexTurnContext {
  latestProviderFailure?: {
    readonly nativeMessage: string;
    readonly failure: OrchestrationV2ProviderFailure;
  };
  readonly nativeStartReady?: Deferred.Deferred<void>;
  readonly input: ProviderAdapterV2TurnInput;
  readonly projectionAppThread: OrchestrationV2AppThread;
  readonly projectionThreadId: ThreadId;
  readonly projectionRunId: ProviderAdapterV2TurnInput["runId"] | null;
  readonly nativeTurnId: string;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly providerTurnOrdinal: number;
  readonly providerNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerNodeKind: OrchestrationV2ExecutionNode["kind"];
  readonly providerNodeStartedAt: DateTime.Utc | null;
  readonly itemParentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly subagent: CodexSubagentThreadContext | null;
  readonly startedAt: DateTime.Utc;
  // Item positions allocated in this turn. Later turns never look items up
  // here: late background items resolve their settled turn's context, and a
  // subagent's approvals allocate on the owning root turn.
  readonly itemPositions: Map<
    string,
    { readonly ordinal: number; readonly startedAt: DateTime.Utc }
  >;
}

interface ActiveCodexProviderRetry {
  readonly nativeMessage: string;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

/** Snapshot of a still-running commandExecution item for interrupt/fail terminalization. */
interface TrackedRunningCommandItem {
  readonly id: string;
  readonly command: string;
  readonly aggregatedOutput?: string;
  readonly processId?: string;
}

function isPersistentCodexDynamicTool(item: CodexDynamicToolItem): boolean {
  const input = item.arguments;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

type CodexRootTerminalEvent = Extract<ProviderAdapterV2Event, { readonly type: "turn.terminal" }>;

/** A completed root turn whose run stays open for the goal turn Codex starts next. */
interface CodexGoalHold {
  readonly context: ActiveCodexTurnContext;
  readonly event: Extract<CodexRootTerminalEvent, { readonly failure: null }>;
  /** Sent when the hold resolves, so until then Stop and steering still target this turn. */
  readonly completedTurn: OrchestrationV2ProviderTurn;
  /** The turn Codex continued with, or undefined when the run settled instead. */
  readonly next: Deferred.Deferred<ActiveCodexTurnContext | undefined>;
}

interface DeferredCodexRootTerminal {
  readonly context: ActiveCodexTurnContext;
  readonly event: CodexRootTerminalEvent;
}

interface CodexSubagentThreadContext {
  parentContext: ActiveCodexTurnContext;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly childThread: OrchestrationV2AppThread;
  readonly subagentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childThreadId: ThreadId;
  readonly nativeToolCallId: string;
  readonly ordinal: number;
  readonly nativeTurnIds: Set<string>;
  startedAt: DateTime.Utc;
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  task: OrchestrationV2Subagent;
}

/**
 * The top-level turn a (possibly nested) subagent turn runs under, and the
 * subagent on that turn's thread that leads to it. Native subagent threads are
 * hidden from the sidebar, so their approvals are asked there instead.
 */
const approvalOwnerCodexTurn = (
  context: ActiveCodexTurnContext,
): {
  readonly owner: ActiveCodexTurnContext;
  readonly subagent: CodexSubagentThreadContext | null;
} => {
  let owner = context;
  let subagent: CodexSubagentThreadContext | null = null;
  while (owner.subagent !== null) {
    subagent = owner.subagent;
    owner = owner.subagent.parentContext;
  }
  return { owner, subagent };
};

const isDescendantCodexTurn = (
  candidate: ActiveCodexTurnContext,
  ancestor: ActiveCodexTurnContext,
): boolean => {
  let parent = candidate.subagent?.parentContext;
  while (parent !== undefined) {
    if (parent === ancestor) {
      return true;
    }
    parent = parent.subagent?.parentContext;
  }
  return false;
};

interface PendingCodexSubagentTurnStarted {
  readonly nativeTurnId: string;
  readonly startedAt: DateTime.Utc;
}

type PendingCodexRuntimeRequest =
  | {
      readonly type: "approval";
      readonly requestId: RuntimeRequestId;
      readonly requestKind: ProviderRequestKind;
      readonly decision: Deferred.Deferred<ProviderApprovalDecision, never>;
    }
  | {
      readonly type: "user_input";
      readonly requestId: RuntimeRequestId;
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers, never>;
    };

type CodexWebSearchItem = {
  readonly id: string;
  readonly type: "webSearch";
  readonly query?: string | null;
  readonly action?:
    | CodexSchema.V2ItemStartedNotification__WebSearchAction
    | CodexSchema.V2ItemCompletedNotification__WebSearchAction
    | null;
};

export type CodexDynamicToolItem = Extract<
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "mcpToolCall" | "dynamicToolCall" }
>;

type CodexCollabAgentToolCallItem = Extract<
  CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "collabAgentToolCall" }
>;

type CodexSubAgentActivityItem = Extract<
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "subAgentActivity" }
>;

export interface CodexAppServerClientFactoryShape {
  readonly open: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
    readonly settings: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) => Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    ProviderAdapterOpenSessionError,
    Scope.Scope
  >;
}

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryShape
>()("t3/orchestration-v2/Adapters/CodexAdapterV2/CodexAppServerClientFactory") {}

/**
 * Config overrides sent with every `thread/start`, `thread/resume` and `thread/fork`.
 * Codex 0.152 made the `update_plan` checklist tool opt-in; T3 renders it as the
 * todo list. Codex layers these above the user's and project's `config.toml`.
 */
export const CODEX_THREAD_CONFIG = { "tools.update_plan.enabled": true } as const;

export function codexThreadRuntimeParams(input: {
  readonly threadId: ThreadId | null;
  readonly modelSelection?: { readonly model: string };
  readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
}): {
  readonly cwd?: string;
  readonly model?: string;
  readonly config: Readonly<Record<string, Schema.Json>>;
} {
  const mcpSession =
    input.threadId === null ? undefined : McpProviderSession.readMcpProviderSession(input.threadId);
  return {
    ...(input.runtimePolicy?.cwd == null ? {} : { cwd: input.runtimePolicy.cwd }),
    ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),
    config: {
      ...CODEX_THREAD_CONFIG,
      ...(mcpSession === undefined
        ? {}
        : {
            mcp_servers: {
              "t3-code": {
                url: mcpSession.endpoint,
                http_headers: {
                  Authorization: mcpSession.authorizationHeader,
                },
              },
            },
          }),
    },
  };
}

const decodeCodexResumeMetadata = Schema.decodeUnknownEffect(
  Schema.Struct({ thread: Schema.Struct({ id: Schema.String, updatedAt: Schema.Number }) }),
);

const CodexChildSelection = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  model: Schema.NullOr(Schema.String),
  reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
  serviceTier: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeCodexChildModel = Schema.decodeUnknownEffect(CodexChildSelection);

const decodeCodexChildThread = Schema.decodeUnknownEffect(
  Schema.Struct({
    thread: Schema.Struct({
      id: Schema.String,
      model: Schema.optional(Schema.NullOr(Schema.String)),
      reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
);

export const makeCodexAppServerSpawnCommand = Effect.fn(
  "CodexAdapterV2.makeCodexAppServerSpawnCommand",
)(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extendEnv?: boolean | undefined;
}) {
  const spawnCommand = yield* resolveSpawnCommand(input.command, input.args, {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
  });
  return ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
    shell: spawnCommand.shell,
  });
});

const layerCodexAppServerClientFactoryCommand = (
  options: CodexClient.CodexAppServerClientOptions & {
    readonly command: string;
    readonly args?: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Layer.Layer<CodexAppServerClientFactory, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    CodexAppServerClientFactory,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return CodexAppServerClientFactory.of({
        open: (input) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const command = yield* makeCodexAppServerSpawnCommand({
              command: options.command,
              args: [...(options.args ?? [])],
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
            });
            const handle = yield* spawner.spawn(command).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterOpenSessionError({
                    driver: CODEX_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            );
            const context = yield* Layer.build(CodexClient.layerChildProcess(handle, options));
            return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.provide(context),
            );
          }),
      });
    }),
  );

export function makeCodexAppServerProtocolLogger(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): CodexClient.CodexAppServerClientOptions["logger"] | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) => {
    if (!shouldPersistProviderEvent("native", event)) return Effect.void;
    return nativeEventLogger
      .write(
        {
          provider: CODEX_PROVIDER,
          protocol: "codex.app-server",
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event: redactCodexProtocolValue(boundProviderEventForLogging(event)),
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
  };
}

function redactCodexProtocolValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCodexProtocolValue);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") {
      return value;
    }
    if (/^Bearer\s+/i.test(value)) {
      return "[REDACTED]";
    }
    const trimmed = value.trim();
    if (
      !(
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      )
    ) {
      return value;
    }
    try {
      return JSON.stringify(
        redactCodexProtocolValue(boundProviderEventForLogging(JSON.parse(trimmed) as unknown)),
      );
    } catch {
      return value;
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveCodexProtocolKey(key) ? "[REDACTED]" : redactCodexProtocolValue(nested),
    ]),
  );
}

function isSensitiveCodexProtocolKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized.endsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret")
  );
}

export const layerAppServerClientFactory: Layer.Layer<
  CodexAppServerClientFactory,
  never,
  ChildProcessSpawner.ChildProcessSpawner | ProviderEventLoggers
> = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { native: nativeEventLogger } = yield* ProviderEventLoggers;

    return CodexAppServerClientFactory.of({
      open: (input) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const environment = {
            ...input.environment,
            ...(input.settings.homePath ? { CODEX_HOME: input.settings.homePath } : {}),
          };
          const command = yield* makeCodexAppServerSpawnCommand({
            command: input.settings.binaryPath || "codex",
            args: codexAppServerArgs(
              resolveCodexLaunchArgs(input.settings.launchArgs, input.environment),
            ),
            env: environment,
          });
          const handle = yield* spawner.spawn(command).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  driver: CODEX_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          const protocolLogger = makeCodexAppServerProtocolLogger({
            nativeEventLogger,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          });
          const clientOptions: CodexClient.CodexAppServerClientOptions =
            protocolLogger === undefined
              ? {}
              : {
                  logIncoming: true,
                  logOutgoing: true,
                  logger: protocolLogger,
                };
          const context = yield* Layer.build(CodexClient.layerChildProcess(handle, clientOptions));
          return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
        }),
    });
  }),
);

export type CodexAdapterV2DriverEnv =
  | CodexAppServerClientFactory
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocatorV2
  | Path.Path
  | ServerConfig;

export const createCodexAdapterV2 = (
  { instanceId, environment, enabled, config }: ProviderAdapterDriverCreateInput<CodexSettings>,
  hooks: Pick<CodexAdapterV2Options, "onUsageLimits" | "resolveRuntime"> = {},
) =>
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const continuationRequests = yield* ProviderContinuationRequests;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcessEnvironment;
    const idAllocator = yield* IdAllocatorV2;
    const serverConfig = yield* ServerConfig;
    const homeLayout = yield* resolveCodexHomeLayout(config);

    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: CODEX_DRIVER_KIND,
            instanceId,
            detail: "Failed to materialize the Codex shadow home.",
            cause,
          }),
      ),
    );

    const settings = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath),
      homePath: homeLayout.effectiveHomePath ?? "",
    } satisfies CodexSettings;

    return makeCodexAdapterV2({
      instanceId,
      settings,
      environment: mergeProviderInstanceEnvironment(environment, hostEnvironment),
      clientFactory,
      crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests,
      ...hooks,
    });
  });

export const CodexAdapterV2Driver: ProviderAdapterDriver<CodexSettings, CodexAdapterV2DriverEnv> = {
  driverKind: CODEX_DRIVER_KIND,
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => DEFAULT_CODEX_SETTINGS,
  create: createCodexAdapterV2,
};

const layer: Layer.Layer<
  ProviderAdapterV2,
  never,
  CodexAppServerClientFactory | Crypto.Crypto | FileSystem.FileSystem | IdAllocatorV2 | ServerConfig
> = Layer.effect(
  ProviderAdapterV2,
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const continuationRequests = yield* ProviderContinuationRequests;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcessEnvironment;
    const idAllocator = yield* IdAllocatorV2;
    const serverConfig = yield* ServerConfig;

    return makeCodexAdapterV2({
      instanceId: CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: hostEnvironment,
      clientFactory,
      crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests,
    });
  }),
);

export interface CodexAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly clientFactory: CodexAppServerClientFactoryShape;
  readonly onUsageLimits?: ServerProviderShape["applyUsageLimits"];
  /**
   * Resolves launch settings when each session opens, replacing `settings` and
   * `environment`. Managed ChatGPT sign-in uses it to launch the T3-installed
   * Codex with a current access token.
   */
  readonly resolveRuntime?: Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>;
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly serverConfig: ServerConfig["Service"];
  /**
   * Sink for post-settle background command completions so the orchestrator
   * can start a continuation run. Optional: adapters that omit it keep
   * projection-only handling for late item completions.
   */
  readonly continuationRequests?: {
    readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  };
}

export function makeCodexAdapterV2(adapterOptions: CodexAdapterV2Options): ProviderAdapterV2Shape {
  const { clientFactory, crypto, fileSystem, idAllocator, serverConfig } = adapterOptions;
  const continuationRequests = adapterOptions.continuationRequests;

  return ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: CODEX_PROVIDER,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: (input) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const resolvedRuntime =
          adapterOptions.resolveRuntime === undefined
            ? undefined
            : yield* adapterOptions.resolveRuntime.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterOpenSessionError({
                      driver: CODEX_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
        const client = yield* clientFactory.open({
          instanceId: adapterOptions.instanceId,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
          runtimePolicy: input.runtimePolicy,
          settings: resolvedRuntime?.config ?? adapterOptions.settings,
          environment: resolvedRuntime?.environment ?? adapterOptions.environment,
        });
        const additionalContextByThread = yield* Ref.make(
          new Map<
            string,
            NonNullable<CodexTurnStartParamsWithCollaborationMode["additionalContext"]>
          >(),
        );
        // Codex drops client developer messages during compaction but only
        // resends additionalContext when it changes. Restore the current entries.
        const restoreAdditionalContext = (threadId: string) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(additionalContextByThread)).get(threadId);
            if (!context) return;
            yield* client.request("thread/inject_items", {
              threadId,
              // Restored as Codex sent them: application context as developer
              // input, untrusted context as quoted user-side input.
              items: Object.entries(context).map(([key, entry]) =>
                entry.kind === "untrusted"
                  ? {
                      type: "message",
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text: `<external_${key}>${entry.value}</external_${key}>`,
                        },
                      ],
                    }
                  : {
                      type: "message",
                      role: "developer",
                      content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                    },
              ),
            });
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.catch((cause) =>
              Effect.logWarning("Failed to restore Codex additional context after compaction.", {
                cause,
              }),
            ),
          );
        const initialized = yield* Ref.make(false);
        // Threads share this app-server, and Codex rejects a second
        // `initialize`. Callers wait for an in-flight handshake instead of
        // starting their own; a failed handshake leaves the flag unset so the
        // next caller retries.
        const initializePermit = yield* Semaphore.make(1);
        const ensureInitialized = initializePermit.withPermit(
          Effect.gen(function* () {
            const alreadyInitialized = yield* Ref.get(initialized);
            if (alreadyInitialized) {
              return;
            }

            yield* client
              .request("initialize", {
                // Codex uses the client name as the request originator, so sessions
                // identify themselves exactly like the provider probe.
                clientInfo: buildCodexInitializeParams().clientInfo,
                capabilities: CODEX_CLIENT_CAPABILITIES,
              })
              .pipe(
                Effect.catchTags({
                  // A caller interrupted after its `initialize` reached Codex
                  // leaves the app-server initialized but the flag unset.
                  CodexAppServerRequestError: (error) =>
                    error.code === -32600 && error.errorMessage === "Already initialized"
                      ? Effect.void
                      : Effect.fail(error),
                }),
              );
            yield* client.notify("initialized", undefined);
            yield* Ref.set(initialized, true);
          }),
        );
        const now = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          providerInstanceId: adapterOptions.instanceId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const rateLimitSnapshot = yield* Ref.make<CodexRateLimitSnapshot | undefined>(undefined);
        const limitedTurnItems = yield* Ref.make(
          new Map<ProviderThreadId, Extract<OrchestrationV2TurnItem, { type: "error" }>>(),
        );
        const activeTurns = yield* Ref.make(new Map<string, ActiveCodexTurnContext>());
        const turnTokenUsageByThread = new Map<string, CodexTurnTokenUsageState>();
        const usageStateForThread = (nativeThreadId: string) => {
          let state = turnTokenUsageByThread.get(nativeThreadId);
          if (!state) {
            state = makeCodexTurnTokenUsageState();
            turnTokenUsageByThread.set(nativeThreadId, state);
          }
          return state;
        };
        const beginTurnTokenUsage = (context: ActiveCodexTurnContext) => {
          const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
          if (!nativeThreadId) return;
          const state = usageStateForThread(nativeThreadId);
          if (state.activeTurnId !== context.nativeTurnId) {
            state.byTurnId.clear();
            state.activeTurnId = context.nativeTurnId;
            getCodexTurnAccumulator(state, context.nativeTurnId);
          }
        };
        const markSubagentUsage = (context: ActiveCodexTurnContext) => {
          const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
          if (!nativeThreadId) return;
          getCodexTurnAccumulator(
            usageStateForThread(nativeThreadId),
            context.nativeTurnId,
          ).hasSubagents = true;
        };
        const pendingRootTurns = yield* Ref.make(new Map<string, ProviderAdapterV2TurnInput>());
        const turnWaiters = yield* Ref.make(new Map<string, Deferred.Deferred<void, never>>());
        const subagentThreads = yield* Ref.make(new Map<string, CodexSubagentThreadContext>());
        const subagentSelections = new Map<string, Omit<ModelSelection, "instanceId">>();
        const pendingSubagentTurns = yield* Ref.make(
          new Map<string, ReadonlyArray<PendingCodexSubagentTurnStarted>>(),
        );
        const nextProviderTurnOrdinals = yield* Ref.make(new Map<string, number>());
        const providerRetries = yield* Ref.make(
          new Map<ProviderTurnId, ActiveCodexProviderRetry>(),
        );
        // Streamed plan text per plan item, dropped when the item completes.
        const planDeltas = new Map<string, string>();
        const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());
        const pendingRuntimeRequests = yield* Ref.make(
          new Map<string, PendingCodexRuntimeRequest>(),
        );
        /**
         * Turn contexts retained past turn/completed while background command
         * items started in that turn are still running, so late item events
         * keep projecting instead of being dropped.
         */
        const settledTurns = yield* Ref.make(new Map<string, ActiveCodexTurnContext>());
        const runningCommandItemsByTurn = yield* Ref.make(
          new Map<string, Map<string, TrackedRunningCommandItem>>(),
        );
        const runningDynamicToolsByTurn = yield* Ref.make(
          new Map<string, Map<string, CodexDynamicToolItem>>(),
        );
        const interruptingNativeTurns = yield* Ref.make(new Set<string>());
        const terminalizedNonCompletedNativeTurns = yield* Ref.make(new Set<string>());
        // Keep the run event stream open until descendant provider state is
        // terminal, otherwise the root terminal can strand child projections.
        const deferredRootTerminals = yield* Ref.make(new Map<string, DeferredCodexRootTerminal>());
        const offeredContinuationItemsByTurn = yield* Ref.make(new Map<string, Set<string>>());
        const finalAnswerItemIdsByTurn = yield* Ref.make(new Map<string, Set<string>>());
        const completedFinalAnswerTextsByTurn = yield* Ref.make(new Map<string, Set<string>>());
        // Native completion and the interrupt timeout share one finalization
        // path. Serialize the race so only one can publish terminal events.
        const turnTerminalizationPermit = yield* Semaphore.make(1);
        // Native goals by Codex thread, and the root provider thread snapshot
        // each goal change is written onto.
        const goalsByNativeThread = new Map<string, OrchestrationV2ProviderGoal | null>();
        const rootProviderThreads = new Map<string, OrchestrationV2ProviderThread>();
        // A completed root turn whose goal is still active. Its run stays open
        // for the turn Codex starts next, so goal phases do not read as Done.
        const goalHolds = new Map<string, CodexGoalHold>();
        // The root turns of each continued goal run, keyed by each of its turns.
        // A Stop or steer that names an earlier turn reaches the newest one, and
        // Stop also reaches work an earlier turn left running. Dropped when the
        // run settles.
        const goalRuns = new Map<ProviderTurnId, Array<ActiveCodexTurnContext>>();
        // `/goal` runs whose goal turns active after the first turn starts.
        const goalActivations = new Map<string, { stopped: boolean }>();
        // Stops in progress by native thread. Until a Stop resolves its target,
        // a held run must not settle as completed.
        const goalStops = new Map<string, number>();
        const latestGoalTurnId = (providerTurnId: ProviderTurnId) =>
          goalRuns.get(providerTurnId)?.at(-1)?.providerTurnId ?? providerTurnId;

        const emitProviderEvent = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        /** Writes the thread's current native goal onto its root provider thread. */
        const emitGoalUpdate = Effect.fnUntraced(function* (nativeThreadId: string) {
          const providerThread = rootProviderThreads.get(nativeThreadId);
          if (providerThread === undefined || !goalsByNativeThread.has(nativeThreadId)) return;
          const goal = goalsByNativeThread.get(nativeThreadId) ?? null;
          if (providerGoalsEqual(providerThread.goal ?? null, goal)) return;
          const updated = { ...providerThread, goal, updatedAt: yield* DateTime.now };
          rootProviderThreads.set(nativeThreadId, updated);
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver: CODEX_PROVIDER,
            providerThread: updated,
          });
        });

        const rememberRootProviderThread = Effect.fnUntraced(function* (
          providerThread: OrchestrationV2ProviderThread,
        ) {
          const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
          if (nativeThreadId == null) return;
          rootProviderThreads.set(nativeThreadId, providerThread);
          yield* emitGoalUpdate(nativeThreadId);
        });

        // Call only for new model-output activity. A local item/completed can
        // arrive while the upstream response stream is still retrying.
        const completeProviderRetry = Effect.fn("CodexAdapterV2.completeProviderRetry")(function* (
          context: ActiveCodexTurnContext,
          updatedAt: DateTime.Utc,
        ) {
          const providerRetry = yield* Ref.modify(providerRetries, (current) => {
            const retry = current.get(context.providerTurnId);
            if (retry === undefined) {
              return [undefined, current] as const;
            }
            const updated = new Map(current);
            updated.delete(context.providerTurnId);
            return [retry, updated] as const;
          });
          if (providerRetry === undefined) {
            return;
          }
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: makeProviderRetryTurnItem({
              idAllocator,
              driver: CODEX_PROVIDER,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId: context.providerNodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              itemOrdinal: providerRetry.itemOrdinal,
              failure: providerRetry.failure,
              retry: providerRetry.retry,
              status: "completed",
              startedAt: providerRetry.startedAt,
              updatedAt,
            }),
          });
        });

        const registerRootTurn = (input: {
          readonly turnInput: ProviderAdapterV2TurnInput;
          readonly nativeTurnId: string;
          readonly startedAt: DateTime.Utc;
          readonly waitForNativeStart?: boolean;
        }) =>
          Effect.gen(function* () {
            const existing = (yield* Ref.get(activeTurns)).get(input.nativeTurnId);
            if (existing !== undefined) {
              return existing;
            }
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: CODEX_PROVIDER,
              nativeTurnId: input.nativeTurnId,
            });
            const context: ActiveCodexTurnContext = {
              ...(input.waitForNativeStart
                ? { nativeStartReady: yield* Deferred.make<void>() }
                : {}),
              input: input.turnInput,
              projectionAppThread: input.turnInput.appThread,
              projectionThreadId: input.turnInput.threadId,
              projectionRunId: input.turnInput.runId,
              nativeTurnId: input.nativeTurnId,
              providerThread: input.turnInput.providerThread,
              providerTurnId,
              providerTurnOrdinal: input.turnInput.providerTurnOrdinal,
              providerNodeId: input.turnInput.rootNodeId,
              providerNodeKind: "root_turn",
              providerNodeStartedAt: input.startedAt,
              itemParentNodeId: input.turnInput.rootNodeId,
              rootNodeId: input.turnInput.rootNodeId,
              subagent: null,
              startedAt: input.startedAt,
              itemPositions: new Map(),
            };
            yield* Ref.update(limitedTurnItems, (current) => {
              const next = new Map(current);
              next.delete(context.providerThread.id);
              return next;
            });
            beginTurnTokenUsage(context);
            yield* Ref.update(activeTurns, (current) => {
              const updated = new Map(current);
              updated.set(input.nativeTurnId, context);
              return updated;
            });
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CODEX_PROVIDER,
              threadId: input.turnInput.threadId,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: input.turnInput.providerThread.id,
                nodeId: input.turnInput.rootNodeId,
                runAttemptId: input.turnInput.attemptId,
                nativeTurnRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: input.nativeTurnId,
                  strength: "strong",
                },
                ordinal: input.turnInput.providerTurnOrdinal,
                status: "running",
                startedAt: input.startedAt,
                completedAt: null,
              },
            });
            yield* rememberRootProviderThread(input.turnInput.providerThread);
            return context;
          });

        const findActiveTurnByNativeThreadId = (nativeThreadId: string) =>
          Effect.gen(function* () {
            const turns = Array.from((yield* Ref.get(activeTurns)).values());
            return turns.find(
              (context) => context.providerThread.nativeThreadRef?.nativeId === nativeThreadId,
            );
          });

        const awaitActiveTurn = (
          nativeTurnId: string,
          attemptsRemaining = 1_000,
        ): Effect.Effect<ActiveCodexTurnContext | undefined> =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(nativeTurnId);
            if (context !== undefined || attemptsRemaining <= 0) {
              return context;
            }
            yield* Effect.yieldNow;
            return yield* awaitActiveTurn(nativeTurnId, attemptsRemaining - 1);
          });

        /**
         * Like awaitActiveTurn, but item lifecycle events for a turn that
         * already settled (background command completions) resolve the
         * retained settled context instead of dropping.
         */
        const resolveItemEventContext = (nativeTurnId: string) =>
          Effect.gen(function* () {
            const settled = (yield* Ref.get(settledTurns)).get(nativeTurnId);
            if (settled !== undefined) {
              return { context: settled, settled: true } as const;
            }
            const context = yield* awaitActiveTurn(nativeTurnId);
            return context === undefined ? undefined : ({ context, settled: false } as const);
          });

        const trackRunningCommandItem = (nativeTurnId: string, item: TrackedRunningCommandItem) =>
          Ref.update(runningCommandItemsByTurn, (current) => {
            const updated = new Map(current);
            const items = new Map(updated.get(nativeTurnId) ?? []);
            items.set(item.id, item);
            updated.set(nativeTurnId, items);
            return updated;
          });

        /** Returns true when the turn has no running command items left. */
        const clearRunningCommandItem = (nativeTurnId: string, nativeItemId: string) =>
          Ref.modify(runningCommandItemsByTurn, (current) => {
            const items = current.get(nativeTurnId);
            if (items === undefined || !items.has(nativeItemId)) {
              return [items === undefined || items.size === 0, current] as const;
            }
            const remaining = new Map(items);
            remaining.delete(nativeItemId);
            const updated = new Map(current);
            if (remaining.size === 0) {
              updated.delete(nativeTurnId);
            } else {
              updated.set(nativeTurnId, remaining);
            }
            return [remaining.size === 0, updated] as const;
          });

        // MCP app captures still reading their resource, by native turn and
        // item. Each counts as retained background work, so the turn's context
        // and the run's ingestion stay open until its app lands on the item.
        // A turn that ends badly cancels its captures and settles their items
        // itself (terminalizeMcpAppCaptures).
        interface PendingMcpAppCapture {
          readonly item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>;
          readonly fiber: Fiber.Fiber<void>;
        }
        const pendingMcpAppCaptures = yield* Ref.make(
          new Map<string, ReadonlyMap<string, PendingMcpAppCapture>>(),
        );
        /** Removes a capture; true when this call removed it (each settles once). */
        const takePendingMcpAppCapture = (nativeTurnId: string, nativeItemId: string) =>
          Ref.modify(pendingMcpAppCaptures, (current) => {
            const captures = current.get(nativeTurnId);
            if (captures === undefined || !captures.has(nativeItemId)) {
              return [false, current] as const;
            }
            const remaining = new Map(captures);
            remaining.delete(nativeItemId);
            const updated = new Map(current);
            if (remaining.size === 0) updated.delete(nativeTurnId);
            else updated.set(nativeTurnId, remaining);
            return [true, updated] as const;
          });

        const trackRunningDynamicTool = (nativeTurnId: string, item: CodexDynamicToolItem) =>
          Ref.update(runningDynamicToolsByTurn, (current) => {
            const updated = new Map(current);
            const items = new Map(updated.get(nativeTurnId) ?? []);
            items.set(item.id, item);
            updated.set(nativeTurnId, items);
            return updated;
          });

        const clearRunningDynamicTool = (nativeTurnId: string, nativeItemId: string) =>
          Ref.update(runningDynamicToolsByTurn, (current) => {
            const items = current.get(nativeTurnId);
            if (items === undefined || !items.has(nativeItemId)) {
              return current;
            }
            const remaining = new Map(items);
            remaining.delete(nativeItemId);
            const updated = new Map(current);
            if (remaining.size === 0) {
              updated.delete(nativeTurnId);
            } else {
              updated.set(nativeTurnId, remaining);
            }
            return updated;
          });

        const turnHasRetainedBackgroundWork = (nativeTurnId: string) =>
          Effect.gen(function* () {
            const commands = (yield* Ref.get(runningCommandItemsByTurn)).get(nativeTurnId);
            if (commands !== undefined && commands.size > 0) {
              return true;
            }
            if ((yield* Ref.get(pendingMcpAppCaptures)).has(nativeTurnId)) {
              return true;
            }
            const tools = (yield* Ref.get(runningDynamicToolsByTurn)).get(nativeTurnId);
            if (tools === undefined) {
              return false;
            }
            for (const item of tools.values()) {
              if (isPersistentCodexDynamicTool(item)) {
                return true;
              }
            }
            return false;
          });

        const releaseSettledTurnIfIdle = (nativeTurnId: string) =>
          Effect.gen(function* () {
            if (yield* turnHasRetainedBackgroundWork(nativeTurnId)) {
              return;
            }
            yield* Ref.update(settledTurns, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(nativeTurnId);
              return updated;
            });
            yield* Ref.update(offeredContinuationItemsByTurn, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(nativeTurnId);
              return updated;
            });
            yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(nativeTurnId);
              return updated;
            });
            yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(nativeTurnId);
              return updated;
            });
          });

        /**
         * When a turn is interrupted or failed, Codex often leaves commandExecution
         * items mid-flight (no item/completed). Emit terminal turn items before
         * turn.terminal so the projection never keeps a forever-running command card.
         * Does not retain settled context: late completions must not wake the run.
         */
        const terminalizeRunningCommandItems = (
          context: ActiveCodexTurnContext,
          nativeTurnId: string,
          status: "interrupted" | "failed",
          completedAt: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
            const items = (yield* Ref.get(runningCommandItemsByTurn)).get(nativeTurnId);
            if (items === undefined || items.size === 0) {
              return;
            }
            for (const tracked of items.values()) {
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: tracked.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: tracked.id,
              });
              const { ordinal, startedAt } = yield* resolveItemPosition(context, tracked.id);
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: context.projectionThreadId,
                runId: context.projectionRunId,
                parentNodeId: context.itemParentNodeId,
                rootNodeId: context.rootNodeId,
                kind: "tool_call",
                status,
                countsForRun: false,
                providerThreadId: context.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(tracked.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: context.projectionThreadId,
                runId: context.projectionRunId,
                nodeId,
                providerThreadId: context.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(tracked.id),
                parentItemId: null,
                ordinal,
                status,
                title: null,
                startedAt,
                completedAt,
                updatedAt: completedAt,
                type: "command_execution",
                input: tracked.command,
                ...(tracked.aggregatedOutput === undefined
                  ? {}
                  : { output: tracked.aggregatedOutput }),
              };
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem,
              });
            }
          });

        const terminateBackgroundTerminal = Effect.fn("CodexAdapterV2.terminateBackgroundTerminal")(
          function* (nativeThreadId: string, processId: string) {
            const response = yield* client.raw
              .request("thread/backgroundTerminals/terminate", {
                threadId: nativeThreadId,
                processId,
              })
              .pipe(
                // The app-server that ran the terminal is gone, and with it
                // the only handle to the terminal: nothing is left to stop.
                Effect.catchTags({
                  CodexAppServerProcessExitedError: () => Effect.succeed({ terminated: true }),
                  CodexAppServerInputStreamEndedError: () => Effect.succeed({ terminated: true }),
                  // The thread is unloaded, as Codex does a minute after a
                  // settle or archive unsubscribes it. Unloading kills the
                  // thread's terminals, so nothing is left to stop.
                  CodexAppServerRequestError: (error) =>
                    error.code === -32600 && error.errorMessage.startsWith("thread not found:")
                      ? Effect.succeed({ terminated: true })
                      : Effect.fail(error),
                }),
              );
            const result = yield* decodeCodexBackgroundTerminalTerminateResponse(response);
            if (result.terminated) return;
            let cursor: string | null = null;
            while (true) {
              const response: unknown = yield* client.raw.request(
                "thread/backgroundTerminals/list",
                {
                  threadId: nativeThreadId,
                  ...(cursor === null ? {} : { cursor }),
                },
              );
              const page: CodexBackgroundTerminalsListPage =
                yield* decodeCodexBackgroundTerminalsListResponse(response);
              if (page.data.some((terminal) => terminal.processId === processId)) {
                return yield* toProtocolError(
                  `Codex background terminal ${processId} remained active after termination.`,
                );
              }
              if (page.nextCursor === null) return;
              cursor = page.nextCursor;
            }
          },
          Effect.timeout("10 seconds"),
        );

        /**
         * Yielded exec cells can start MCP / dynamic tools that never receive
         * item/completed when functions.wait terminates the cell. Terminalize
         * leftover nonpersistent tools before turn.terminal. Persistent tools
         * can outlive the root turn and must stay running.
         */
        const terminalizeRunningDynamicTools = (
          context: ActiveCodexTurnContext,
          nativeTurnId: string,
          status: "cancelled" | "interrupted" | "failed",
          completedAt: DateTime.Utc,
          includePersistent: boolean,
        ) =>
          Effect.gen(function* () {
            const items = (yield* Ref.get(runningDynamicToolsByTurn)).get(nativeTurnId);
            if (items === undefined || items.size === 0) {
              return;
            }
            for (const tracked of items.values()) {
              if (!includePersistent && isPersistentCodexDynamicTool(tracked)) {
                continue;
              }
              const artifacts = yield* buildDynamicToolArtifacts(context, tracked);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: {
                  ...artifacts.node,
                  status,
                  completedAt,
                },
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: {
                  ...artifacts.turnItem,
                  status,
                  completedAt,
                  updatedAt: completedAt,
                },
              });
            }
            yield* Ref.update(runningDynamicToolsByTurn, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const remaining = new Map(current.get(nativeTurnId) ?? []);
              for (const tracked of remaining.values()) {
                if (includePersistent || !isPersistentCodexDynamicTool(tracked)) {
                  remaining.delete(tracked.id);
                }
              }
              const updated = new Map(current);
              if (remaining.size === 0) {
                updated.delete(nativeTurnId);
              } else {
                updated.set(nativeTurnId, remaining);
              }
              return updated;
            });
          });

        /**
         * Allocates an item's ordinal and start time on first sight. `item/started` seeds
         * Codex's own start time; items that stream without it start when first seen.
         */
        const resolveItemPosition = (
          context: ActiveCodexTurnContext,
          nativeItemId: string,
          startedAt?: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
            // Read the clock first so the lookup and the insert run without yielding.
            const now = startedAt ?? (yield* DateTime.now);
            const existing = context.itemPositions.get(nativeItemId);
            if (existing !== undefined) {
              return existing;
            }
            const position = {
              ordinal: context.providerTurnOrdinal * 100 + context.itemPositions.size + 1,
              startedAt: now,
            };
            context.itemPositions.set(nativeItemId, position);
            return position;
          });

        const resolveItemOrdinal = (context: ActiveCodexTurnContext, nativeItemId: string) =>
          resolveItemPosition(context, nativeItemId).pipe(
            Effect.map((position) => position.ordinal),
          );

        const nextProviderTurnOrdinal = (
          providerThreadId: OrchestrationV2ProviderThread["id"],
          minimum: number,
        ) =>
          Ref.modify(nextProviderTurnOrdinals, (current) => {
            const previous = current.get(String(providerThreadId));
            const next = previous === undefined ? minimum : Math.max(previous + 1, minimum);
            const updated = new Map(current);
            updated.set(String(providerThreadId), next);
            return [next, updated];
          });

        const emitSubagentTaskUpdate = (input: {
          readonly subagent: CodexSubagentThreadContext;
          readonly status: OrchestrationV2Subagent["status"];
          readonly result?: string | null;
          readonly completedAt?: DateTime.Utc | null;
          readonly startedAt?: DateTime.Utc;
          readonly reopen?: boolean;
        }) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const prior = input.subagent.task;
            const settled = !isOrchestrationV2WorkActive(prior.status);
            // Snapshots can arrive after completion. Only an actual new turn
            // may reopen the reusable child identity.
            if (settled && isOrchestrationV2WorkActive(input.status) && !input.reopen) return;
            const status = settled && !input.reopen ? prior.status : input.status;
            const completedAt = isOrchestrationV2WorkActive(status)
              ? null
              : (prior.completedAt ?? input.completedAt ?? now);
            const task = {
              ...prior,
              status,
              ...(input.reopen
                ? {
                    runId: input.subagent.parentContext.projectionRunId,
                    parentNodeId: input.subagent.parentContext.itemParentNodeId,
                  }
                : {}),
              startedAt: input.startedAt ?? prior.startedAt,
              result: input.result === undefined ? input.subagent.task.result : input.result,
              completedAt,
              updatedAt: now,
            } satisfies OrchestrationV2Subagent;
            input.subagent.task = task;
            if (input.startedAt !== undefined) input.subagent.startedAt = input.startedAt;

            yield* emitProviderEvent({
              type: "subagent.updated",
              driver: CODEX_PROVIDER,
              subagent: task,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: {
                id: input.subagent.turnItemId,
                threadId: task.threadId,
                runId: task.runId,
                nodeId: task.id,
                providerThreadId: task.providerThreadId,
                providerTurnId: input.subagent.parentContext.providerTurnId,
                nativeItemRef: task.nativeTaskRef,
                parentItemId: null,
                ordinal: input.subagent.turnItemOrdinal,
                status: task.status,
                title: task.title,
                startedAt: task.startedAt,
                completedAt: task.completedAt,
                updatedAt: task.updatedAt,
                type: "subagent",
                subagentId: task.id,
                origin: task.origin,
                driver: task.driver,
                providerInstanceId: task.providerInstanceId,
                childThreadId: task.childThreadId,
                prompt: task.prompt,
                result: task.result,
              },
            });
          });

        const emitSubagentProviderTurnStarted = (
          subagent: CodexSubagentThreadContext,
          turn: PendingCodexSubagentTurnStarted,
        ) =>
          Effect.gen(function* () {
            if (subagent.nativeTurnIds.has(turn.nativeTurnId)) return;
            subagent.nativeTurnIds.add(turn.nativeTurnId);
            const parentNativeThreadId = yield* getNativeThreadId(
              subagent.parentContext.providerThread,
            );
            const currentParent = yield* findActiveTurnByNativeThreadId(parentNativeThreadId);
            if (currentParent !== undefined) subagent.parentContext = currentParent;
            const terminalizedNativeTurns = yield* Ref.get(terminalizedNonCompletedNativeTurns);
            let ancestor: ActiveCodexTurnContext | undefined = subagent.parentContext;
            while (ancestor !== undefined) {
              if (terminalizedNativeTurns.has(ancestor.nativeTurnId)) {
                const nativeThreadId = yield* getNativeThreadId(subagent.providerThread);
                const interrupted = yield* client
                  .request("turn/interrupt", {
                    threadId: nativeThreadId,
                    turnId: turn.nativeTurnId,
                  })
                  .pipe(
                    Effect.as(true),
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration-v2.codex-late-subagent-interrupt-failed", {
                        nativeThreadId,
                        nativeTurnId: turn.nativeTurnId,
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                    Effect.timeoutOption("10 seconds"),
                  );
                if (Option.isNone(interrupted)) {
                  yield* Effect.logWarning(
                    "orchestration-v2.codex-late-subagent-interrupt-timeout",
                    {
                      nativeThreadId,
                      nativeTurnId: turn.nativeTurnId,
                    },
                  );
                }
                return;
              }
              ancestor = ancestor.subagent?.parentContext;
            }
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: CODEX_PROVIDER,
              nativeTurnId: turn.nativeTurnId,
            });
            const providerTurnOrdinal = yield* nextProviderTurnOrdinal(
              subagent.providerThread.id,
              1,
            );
            const providerNodeId =
              providerTurnOrdinal === 1
                ? subagent.childRootNodeId
                : idAllocator.derive.nodeFromProviderItem({
                    driver: CODEX_PROVIDER,
                    nativeItemId: `${turn.nativeTurnId}:thread-root`,
                  });
            const activeContext: ActiveCodexTurnContext = {
              input: subagent.parentContext.input,
              projectionAppThread: subagent.childThread,
              projectionThreadId: subagent.childThreadId,
              projectionRunId: null,
              nativeTurnId: turn.nativeTurnId,
              providerThread: subagent.providerThread,
              providerTurnId,
              providerTurnOrdinal,
              providerNodeId,
              providerNodeKind: "root_turn",
              providerNodeStartedAt: turn.startedAt,
              itemParentNodeId: providerNodeId,
              rootNodeId: providerNodeId,
              subagent,
              startedAt: turn.startedAt,
              itemPositions: new Map(),
            };
            beginTurnTokenUsage(activeContext);
            yield* Ref.update(activeTurns, (current) => {
              const updated = new Map(current);
              updated.set(turn.nativeTurnId, activeContext);
              return updated;
            });
            yield* emitSubagentTaskUpdate({
              subagent,
              status: "running",
              startedAt: turn.startedAt,
              ...(providerTurnOrdinal > 1 ? { reopen: true, result: null } : {}),
            });
            const now = yield* DateTime.now;
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: CODEX_PROVIDER,
              providerThread: {
                ...subagent.providerThread,
                status: "active",
                updatedAt: now,
              },
            });
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CODEX_PROVIDER,
              threadId: subagent.childThreadId,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: subagent.providerThread.id,
                nodeId: providerNodeId,
                runAttemptId: null,
                nativeTurnRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: turn.nativeTurnId,
                  strength: "strong",
                },
                ordinal: activeContext.providerTurnOrdinal,
                status: "running",
                startedAt: turn.startedAt,
                completedAt: null,
              },
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: {
                id: providerNodeId,
                threadId: subagent.childThreadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: providerNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: false,
                providerThreadId: subagent.providerThread.id,
                providerTurnId,
                nativeItemRef: subagent.task.nativeTaskRef,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: turn.startedAt,
                completedAt: null,
              },
            });
          });

        const rememberSubagentTurnStarted = (input: {
          readonly nativeThreadId: string;
          readonly nativeTurnId: string;
          readonly startedAt: DateTime.Utc;
        }) =>
          Effect.gen(function* () {
            const subagent = (yield* Ref.get(subagentThreads)).get(input.nativeThreadId);
            if (subagent !== undefined) {
              yield* emitSubagentProviderTurnStarted(subagent, input);
              return;
            }
            yield* Ref.update(pendingSubagentTurns, (current) => {
              const updated = new Map(current);
              updated.set(input.nativeThreadId, [
                ...(updated.get(input.nativeThreadId) ?? []),
                { nativeTurnId: input.nativeTurnId, startedAt: input.startedAt },
              ]);
              return updated;
            });
          });

        const updateSubagentSelection = Effect.fnUntraced(function* (
          nativeThreadId: string,
          value: string | null,
          effort?: string | null,
          tier?: string | null,
        ) {
          const model = value?.trim();
          if (!model) return;
          const previous = subagentSelections.get(nativeThreadId);
          const previousOptions = previous?.options;
          const options =
            effort === undefined && tier === undefined
              ? previousOptions
              : [
                  ...(previousOptions ?? []).filter(({ id }) =>
                    id === "reasoningEffort"
                      ? effort === undefined
                      : id === "serviceTier" && tier === undefined,
                  ),
                  ...[
                    { id: "reasoningEffort", value: effort },
                    { id: "serviceTier", value: tier },
                  ].flatMap(({ id, value }) =>
                    value?.trim() ? [{ id, value: value.trim() }] : [],
                  ),
                ];
          const selection = {
            model,
            ...(options === undefined ? {} : { options }),
          };
          subagentSelections.set(nativeThreadId, selection);
          const subagent = (yield* Ref.get(subagentThreads)).get(nativeThreadId);
          if (subagent === undefined) return;
          const modelSelection = { instanceId: subagent.task.providerInstanceId, ...selection };
          if (
            subagent.task.modelSelection &&
            modelSelectionsEqual(subagent.task.modelSelection, modelSelection)
          )
            return;
          subagent.task = {
            ...subagent.task,
            model,
            modelSelection,
            updatedAt: yield* DateTime.now,
          };
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: CODEX_PROVIDER,
            subagent: subagent.task,
          });
        });

        const registerSubagentThread = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeThreadId: string;
          readonly nativeItemId: string;
          readonly nativeToolCallId: string;
          readonly prompt: string;
          readonly title: string | null;
          readonly model: string | null;
          readonly reasoningEffort?: string | null | undefined;
          readonly ordinal: number;
          readonly emitInitialPrompt: boolean;
        }) =>
          Effect.gen(function* () {
            const registeredSubagents = yield* Ref.get(subagentThreads);
            if (registeredSubagents.has(input.nativeThreadId)) {
              return;
            }
            if (input.model && !subagentSelections.has(input.nativeThreadId)) {
              yield* updateSubagentSelection(
                input.nativeThreadId,
                input.model,
                input.reasoningEffort,
              );
            }

            const now = yield* DateTime.now;
            const subagentNodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const childRootNodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: `${input.nativeItemId}:thread-root`,
            });
            const childThreadId = idAllocator.derive.threadFromProviderThread({
              driver: CODEX_PROVIDER,
              nativeThreadId: input.nativeThreadId,
            });
            const turnItemOrdinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
            const providerThread = {
              id: idAllocator.derive.providerThread({
                driver: CODEX_PROVIDER,
                nativeThreadId: input.nativeThreadId,
              }),
              driver: CODEX_PROVIDER,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              providerSessionId: input.context.providerThread.providerSessionId,
              appThreadId: childThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: CODEX_PROVIDER,
                nativeId: input.nativeThreadId,
                strength: "strong" as const,
              },
              nativeConversationHeadRef: null,
              status: "idle" as const,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: {
                providerThreadId: input.context.providerThread.id,
                providerTurnId: input.context.providerTurnId,
              },
              createdAt: now,
              updatedAt: now,
            } satisfies OrchestrationV2ProviderThread;
            const reportedSelection = subagentSelections.get(input.nativeThreadId);
            const task = {
              id: subagentNodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver: CODEX_PROVIDER,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              providerThreadId: providerThread.id,
              childThreadId,
              nativeTaskRef: codexNativeItemRef(input.nativeItemId),
              prompt: input.prompt,
              title: input.title,
              model: reportedSelection?.model ?? input.model,
              modelSelection: reportedSelection
                ? {
                    instanceId: input.context.input.modelSelection.instanceId,
                    ...reportedSelection,
                  }
                : undefined,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            } satisfies OrchestrationV2Subagent;
            const childThread = makeSubagentChildThread({
              parentThread: input.context.projectionAppThread,
              childThreadId,
              parentNodeId: subagentNodeId,
              activeProviderThreadId: providerThread.id,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              modelSelection: {
                ...input.context.input.modelSelection,
                model: task.model ?? input.context.input.modelSelection.model,
              },
              title: subagentThreadTitle({
                parentTitle: input.context.projectionAppThread.title,
                prompt: task.prompt,
                title: task.title,
                ordinal: input.ordinal,
              }),
              now,
              createdBy: "agent",
              creationSource: "provider",
            });
            const subagent = {
              parentContext: input.context,
              providerThread,
              childThread,
              subagentNodeId,
              childRootNodeId,
              childThreadId,
              nativeToolCallId: input.nativeToolCallId,
              ordinal: input.ordinal,
              nativeTurnIds: new Set<string>(),
              startedAt: now,
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              }),
              turnItemOrdinal,
              task,
            } satisfies CodexSubagentThreadContext;

            yield* Ref.update(subagentThreads, (current) => {
              const updated = new Map(current);
              updated.set(input.nativeThreadId, subagent);
              return updated;
            });
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver: CODEX_PROVIDER,
              appThread: childThread,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: {
                id: subagentNodeId,
                threadId: input.context.projectionThreadId,
                runId: input.context.projectionRunId,
                parentNodeId: input.context.itemParentNodeId,
                rootNodeId: input.context.rootNodeId,
                kind: "subagent",
                status: "running",
                countsForRun: false,
                providerThreadId: providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeToolCallId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: {
                id: childRootNodeId,
                threadId: childThreadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: childRootNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: false,
                providerThreadId: providerThread.id,
                providerTurnId: null,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: CODEX_PROVIDER,
              providerThread,
            });
            if (input.emitInitialPrompt && input.prompt.length > 0) {
              const promptNativeItemId = `${input.nativeItemId}:prompt`;
              const promptArtifacts = makeSubagentConversationArtifacts({
                senderThreadId: input.context.projectionThreadId,
                messageId: idAllocator.derive.messageFromProviderItem({
                  driver: CODEX_PROVIDER,
                  nativeItemId: promptNativeItemId,
                }),
                turnItemId: idAllocator.derive.turnItemFromProviderItem({
                  driver: CODEX_PROVIDER,
                  nativeItemId: promptNativeItemId,
                }),
                threadId: childThreadId,
                rootNodeId: childRootNodeId,
                providerThreadId: providerThread.id,
                providerTurnId: null,
                nativeItemRef: codexNativeItemRef(promptNativeItemId),
                role: "user",
                text: input.prompt,
                ordinal: 100,
                now,
              });
              yield* emitProviderEvent({
                type: "message.updated",
                driver: CODEX_PROVIDER,
                message: promptArtifacts.message,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: promptArtifacts.turnItem,
              });
            }
            yield* emitSubagentTaskUpdate({
              subagent,
              status: "running",
            });

            const pendingTurns = yield* Ref.modify(pendingSubagentTurns, (current) => {
              const pending = current.get(input.nativeThreadId) ?? [];
              const updated = new Map(current);
              updated.delete(input.nativeThreadId);
              return [pending, updated];
            });
            for (const pendingTurn of pendingTurns) {
              yield* emitSubagentProviderTurnStarted(subagent, pendingTurn);
            }
            if (task.model === null) {
              yield* client.raw
                .request("thread/read", { threadId: input.nativeThreadId, includeTurns: false })
                .pipe(
                  Effect.flatMap(decodeCodexChildThread),
                  Effect.map((response): typeof CodexChildSelection.Type | null =>
                    response.thread.id === input.nativeThreadId && response.thread.model?.trim()
                      ? {
                          thread: response.thread,
                          model: response.thread.model,
                          reasoningEffort: response.thread.reasoningEffort,
                        }
                      : null,
                  ),
                  Effect.catch(() => Effect.succeed(null)),
                  Effect.flatMap((response) =>
                    response === null
                      ? client.raw
                          .request("thread/resume", {
                            threadId: input.nativeThreadId,
                            excludeTurns: true,
                          })
                          .pipe(Effect.flatMap(decodeCodexChildModel))
                      : Effect.succeed(response),
                  ),
                  Effect.timeout("5 seconds"),
                  Effect.flatMap((response) =>
                    response.thread.id === input.nativeThreadId &&
                    !subagentSelections.has(input.nativeThreadId)
                      ? updateSubagentSelection(
                          input.nativeThreadId,
                          response.model,
                          response.reasoningEffort,
                          response.serviceTier,
                        )
                      : Effect.void,
                  ),
                  Effect.catch(() => Effect.void),
                  Effect.forkIn(scope),
                );
            }
          });

        const registerSubagentThreads = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly item: CodexCollabAgentToolCallItem;
        }) =>
          Effect.gen(function* () {
            if (input.item.tool !== "spawnAgent" || input.item.receiverThreadIds.length === 0) {
              return;
            }

            for (const [index, nativeThreadId] of input.item.receiverThreadIds.entries()) {
              const model =
                typeof input.item.model === "string" && input.item.model.length > 0
                  ? input.item.model
                  : null;
              yield* registerSubagentThread({
                context: input.context,
                nativeThreadId,
                nativeItemId: `${input.item.id}:${nativeThreadId}`,
                nativeToolCallId: input.item.id,
                prompt: input.item.prompt ?? "",
                title: null,
                model,
                reasoningEffort: input.item.reasoningEffort,
                ordinal: index + 1,
                emitInitialPrompt: true,
              });
            }
          });

        const registerSubagentActivity = (input: {
          readonly context?: ActiveCodexTurnContext;
          readonly item: CodexSubAgentActivityItem;
        }) =>
          Effect.gen(function* () {
            if (input.item.kind === "started") {
              const context = input.context;
              if (context === undefined) return;
              const registeredSubagents = yield* Ref.get(subagentThreads);
              const ordinal =
                Array.from(registeredSubagents.values()).filter(
                  (subagent) => subagent.parentContext.rootNodeId === context.rootNodeId,
                ).length + 1;
              yield* registerSubagentThread({
                context,
                nativeThreadId: input.item.agentThreadId,
                nativeItemId: `${input.item.id}:${input.item.agentThreadId}`,
                nativeToolCallId: input.item.id,
                prompt: "",
                title: input.item.agentPath,
                model: null,
                ordinal,
                emitInitialPrompt: false,
              });
              return;
            }

            const subagent = (yield* Ref.get(subagentThreads)).get(input.item.agentThreadId);
            if (subagent === undefined) {
              return;
            }

            if (input.item.kind === "interrupted" || input.item.kind === "completed") {
              yield* emitSubagentTaskUpdate({
                subagent,
                status: input.item.kind,
              });
            }
          });

        const updateSubagentStates = (input: { readonly item: CodexCollabAgentToolCallItem }) =>
          Effect.gen(function* () {
            const subagents = yield* Ref.get(subagentThreads);
            for (const [nativeThreadId, state] of Object.entries(input.item.agentsStates)) {
              const subagent = subagents.get(nativeThreadId);
              if (subagent === undefined) {
                continue;
              }
              const statuses = {
                pendingInit: "pending",
                running: "running",
                interrupted: "interrupted",
                completed: "completed",
                errored: "failed",
                shutdown: "cancelled",
                notFound: "failed",
              } as const satisfies Record<
                CodexSchema.ServerNotification__CollabAgentStatus,
                OrchestrationV2Subagent["status"]
              >;
              const status = statuses[state.status];
              yield* emitSubagentTaskUpdate({
                subagent,
                status,
                ...(state.message === null ? {} : { result: state.message }),
              });
            }
          });

        const resolvePlanId = (context: ActiveCodexTurnContext, planKey: string) =>
          Effect.gen(function* () {
            const existing = (yield* Ref.get(planIds)).get(planKey);
            if (existing !== undefined) {
              return existing;
            }
            const planId = yield* idAllocator.allocate.plan({
              threadId: context.projectionThreadId,
              ...(context.projectionRunId === null ? {} : { runId: context.projectionRunId }),
              driver: CODEX_PROVIDER,
            });
            yield* Ref.update(planIds, (current) => {
              const updated = new Map(current);
              updated.set(planKey, planId);
              return updated;
            });
            return planId;
          });

        const resolveCodexAttachment = (attachment: ChatAttachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (attachmentPath === null) {
              return yield* toProtocolError(`Invalid attachment id '${attachment.id}'`);
            }
            const bytes = yield* fileSystem
              .readFile(attachmentPath)
              .pipe(
                Effect.mapError((cause) =>
                  toProtocolError(`Failed to read attachment '${attachment.id}'.`, cause),
                ),
              );
            return {
              type: "image" as const,
              url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
            } satisfies CodexSchema.V2TurnStartParams__UserInput;
          });

        const toCodexInput = (
          turnInput: Pick<ProviderAdapterV2TurnInput | ProviderAdapterV2SteerInput, "message">,
        ) =>
          Effect.gen(function* () {
            const inputItems: Array<CodexSchema.V2TurnStartParams__UserInput> = [];
            const text = providerMessageTextWithAttachmentPaths({
              text: codexSkillMentionText(turnInput.message.text),
              attachments: turnInput.message.attachments,
              resolveAttachmentPath: (attachment) =>
                resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
            });
            if (text.length > 0) {
              inputItems.push({
                type: "text",
                text,
              });
            }
            const attachmentItems = yield* Effect.forEach(
              turnInput.message.attachments.filter(isProviderNativeImageAttachment),
              resolveCodexAttachment,
              { concurrency: 1 },
            );
            inputItems.push(...attachmentItems);
            if (inputItems.length === 0) {
              return yield* toProtocolError("Turn requires non-empty text or attachments.");
            }
            return inputItems;
          });

        const buildAgentMessageArtifacts = (
          context: ActiveCodexTurnContext,
          item: { readonly id: string; readonly text: string },
          completed: boolean,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const completedAt = completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "assistant_message",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const message: OrchestrationV2ConversationMessage = {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming: !completed,
              createdAt: startedAt,
              updatedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "assistant_message",
              messageId,
              text: item.text,
              streaming: !completed,
            };
            return { node, message, turnItem };
          });

        // Summary and raw reasoning are separate streams, with independently indexed parts.
        // Reuse the text coalescer so token bursts do not create one database write per token.
        const reasoningParts = new Map<
          string,
          { turnId: string; nativeItemId: string; stream: "summary" | "content"; index: number }
        >();
        const reasoningDeltas = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS,
          emit: (update) =>
            Effect.gen(function* () {
              const part = reasoningParts.get(update.itemId);
              if (part === undefined) return;
              const context = yield* awaitActiveTurn(update.turnId);
              if (context === undefined) return;
              const artifacts = yield* buildAgentMessageArtifacts(
                context,
                { id: update.itemId, text: update.text },
                update.completed,
              );
              const interrupted = (yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(
                update.turnId,
              );
              const { messageId: _messageId, ...item } = artifacts.turnItem;
              const nativeItemRef = codexNativeItemRef(part.nativeItemId);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: {
                  ...artifacts.node,
                  kind: "reasoning",
                  nativeItemRef,
                  ...(interrupted ? { status: "interrupted" as const } : {}),
                },
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: {
                  ...item,
                  type: "reasoning",
                  nativeItemRef,
                  ...(interrupted ? { status: "interrupted" as const } : {}),
                },
              });
            }),
        });
        const reasoningPartKey = (
          turnId: string,
          nativeItemId: string,
          stream: "summary" | "content",
          index: number,
        ) => {
          const key = JSON.stringify([turnId, nativeItemId, stream, index]);
          reasoningParts.set(key, { turnId, nativeItemId, stream, index });
          return key;
        };
        const appendReasoning = Effect.fn("CodexAdapterV2.appendReasoning")(function* (
          payload: { turnId: string; itemId: string; delta: string },
          stream: "summary" | "content",
          index: number,
        ) {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined || payload.delta.length === 0) return;
          yield* completeProviderRetry(context, yield* DateTime.now);
          const itemId = reasoningPartKey(payload.turnId, payload.itemId, stream, index);
          // Reserve the position before the delayed flush, ahead of later tool items.
          yield* resolveItemOrdinal(context, itemId);
          yield* reasoningDeltas.append({ turnId: payload.turnId, itemId, delta: payload.delta });
        });
        const completeReasoning = Effect.fn("CodexAdapterV2.completeReasoning")(function* (
          turnId: string,
          item: { id: string; summary?: ReadonlyArray<string>; content?: ReadonlyArray<string> },
        ) {
          for (const stream of ["summary", "content"] as const) {
            for (const [index] of (item[stream] ?? []).entries()) {
              reasoningPartKey(turnId, item.id, stream, index);
            }
          }
          for (const [key, part] of reasoningParts) {
            if (part.turnId !== turnId || part.nativeItemId !== item.id) continue;
            const finalText = item[part.stream]?.[part.index];
            yield* reasoningDeltas.complete({
              turnId,
              itemId: key,
              ...(finalText ? { finalText } : {}),
              emitEmpty: false,
            });
            reasoningParts.delete(key);
          }
        });

        const agentMessageDeltas = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS,
          emit: (update) =>
            Effect.gen(function* () {
              const context = yield* awaitActiveTurn(update.turnId);
              if (context === undefined) {
                return;
              }
              const finalAnswerItem = (yield* Ref.get(finalAnswerItemIdsByTurn))
                .get(update.turnId)
                ?.has(update.itemId);
              if (finalAnswerItem) {
                const finalAnswerItemIds = (yield* Ref.get(finalAnswerItemIdsByTurn)).get(
                  update.turnId,
                );
                const completedTexts =
                  (yield* Ref.get(completedFinalAnswerTextsByTurn)).get(update.turnId) ??
                  new Set<string>();
                const firstFinalAnswerItemId = finalAnswerItemIds?.values().next().value;
                const duplicateCompletion =
                  update.completed &&
                  completedTexts.size > 0 &&
                  (update.text.length === 0 || completedTexts.has(update.text));
                const deferredStreamingUpdate =
                  !update.completed &&
                  (completedTexts.size > 0 || firstFinalAnswerItemId !== update.itemId);
                if (deferredStreamingUpdate || duplicateCompletion) {
                  return;
                }
              }
              const artifacts = yield* buildAgentMessageArtifacts(
                context,
                { id: update.itemId, text: update.text },
                update.completed,
              );
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              // Clients render streaming text from the turn item, so the
              // message only carries the final text. flushTurn completes every
              // buffered item when a turn ends, interrupted or not.
              if (update.completed) {
                yield* emitProviderEvent({
                  type: "message.updated",
                  driver: CODEX_PROVIDER,
                  message: artifacts.message,
                });
              }
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              if (finalAnswerItem && update.completed) {
                yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
                  const updated = new Map(current);
                  const texts = new Set(updated.get(update.turnId) ?? []);
                  texts.add(update.text);
                  updated.set(update.turnId, texts);
                  return updated;
                });
              }
            }),
        });

        const emitSubagentUserMessage = (
          context: ActiveCodexTurnContext,
          item: Extract<
            | CodexSchema.V2ItemStartedNotification__ThreadItem
            | CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "userMessage" }
          >,
          nativeStartedAt?: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
            if (context.subagent === null || context.providerTurnOrdinal === 1) {
              return false;
            }
            const text = codexUserMessageText(item.content);
            if (text.length === 0) {
              return false;
            }
            const { ordinal, startedAt } = yield* resolveItemPosition(
              context,
              item.id,
              nativeStartedAt,
            );
            const artifacts = makeSubagentConversationArtifacts({
              senderThreadId: context.subagent.parentContext.projectionThreadId,
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: item.id,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: item.id,
              }),
              threadId: context.projectionThreadId,
              rootNodeId: context.rootNodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              role: "user",
              text,
              ordinal,
              now: startedAt,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver: CODEX_PROVIDER,
              message: artifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            return true;
          });

        const buildCommandExecutionArtifacts = (
          context: ActiveCodexTurnContext,
          item: Extract<
            | CodexSchema.V2ItemStartedNotification__ThreadItem
            | CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "commandExecution" }
          >,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const status = codexItemStatus(item.status);
            const completedAt = status.completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status: status.node,
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              status: status.turnItem,
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "command_execution",
              input: item.command,
              ...(item.aggregatedOutput === null || item.aggregatedOutput === undefined
                ? {}
                : { output: item.aggregatedOutput }),
              ...(item.exitCode === null || item.exitCode === undefined
                ? {}
                : { exitCode: item.exitCode }),
            };
            return { node, turnItem };
          });

        const buildFileChangeArtifacts = (
          context: ActiveCodexTurnContext,
          item: Extract<
            CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "fileChange" }
          >,
        ) =>
          Effect.gen(function* () {
            const firstChange = item.changes[0];
            if (firstChange === undefined) {
              return null;
            }

            const updatedAt = yield* DateTime.now;
            const status = codexItemStatus(item.status);
            const completedAt = status.completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status: status.node,
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              status: status.turnItem,
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "file_change",
              fileName: firstChange.path,
              diffStr: firstChange.diff,
            };
            return { node, turnItem };
          });

        const buildWebSearchArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly item: CodexWebSearchItem;
          readonly completed: boolean;
        }) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const completedAt = input.completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(input.context, input.item.id);
            const patterns = webSearchPatterns(input.item);
            const status = input.completed ? "completed" : "running";
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "tool_call",
              status,
              countsForRun: false,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.item.id),
              parentItemId: null,
              ordinal,
              status,
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "web_search",
              ...(patterns.length === 0 ? {} : { patterns: [...patterns] }),
            };
            return { node, turnItem };
          });

        const buildDynamicToolArtifacts = (
          context: ActiveCodexTurnContext,
          item: CodexDynamicToolItem,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const status = codexItemStatus(item.status);
            const completedAt = status.completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const projection = yield* projectCodexDynamicToolItem(item).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
            );
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status: status.node,
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              title: projection.title ?? null,
              startedAt,
              completedAt,
              updatedAt,
              type: "dynamic_tool",
              ...projection,
            };
            return { node, turnItem };
          });

        /**
         * Completes an MCP tool call whose tool names a UI resource: reads the
         * resource through Codex's MCP client, stores it, and records the app
         * in the item's output. The item stays running until then, which keeps
         * the run's event ingestion open past turn/completed; it runs off the
         * notification reader so a slow server cannot stall other events.
         */
        const captureMcpApp = (
          context: ActiveCodexTurnContext,
          nativeTurnId: string,
          item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
          resourceUri: string,
        ) =>
          Effect.gen(function* () {
            // Registered before it can run, so a turn ending right away sees it.
            const started = yield* Deferred.make<void>();
            const fiber = yield* Deferred.await(started).pipe(
              Effect.andThen(captureMcpAppItem(context, nativeTurnId, item, resourceUri)),
              Effect.forkIn(scope, { startImmediately: true }),
            );
            yield* Ref.update(pendingMcpAppCaptures, (current) => {
              const updated = new Map(current);
              updated.set(
                nativeTurnId,
                new Map(current.get(nativeTurnId) ?? []).set(item.id, { item, fiber }),
              );
              return updated;
            });
            yield* Deferred.succeed(started, undefined);
          });

        const captureMcpAppItem = (
          context: ActiveCodexTurnContext,
          nativeTurnId: string,
          item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
          resourceUri: string,
        ) =>
          // Only reading and storing the document can be cancelled; a write
          // cut short removes its file. Once a document is stored, the capture
          // either lands it on the item or, when its turn already settled the
          // item, removes it, so no stored app goes unreferenced.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const reference =
                item.status === "completed" && item.result != null && item.error == null
                  ? yield* restore(
                      getNativeThreadId(context.providerThread).pipe(
                        Effect.flatMap((threadId) =>
                          client.request("mcpServer/resource/read", {
                            threadId,
                            server: item.server,
                            uri: resourceUri,
                          }),
                        ),
                        Effect.timeout(MCP_APP_CAPTURE_TIMEOUT),
                        Effect.flatMap((response) =>
                          snapshotMcpApp({
                            attachmentsDir: serverConfig.attachmentsDir,
                            threadId: context.projectionThreadId,
                            server: item.server,
                            tool: item.tool,
                            resourceUri,
                            contents: response.contents,
                          }),
                        ),
                        Effect.provideService(FileSystem.FileSystem, fileSystem),
                        // Every failure and defect becomes a plain tool row,
                        // so a crashed read never holds the turn open; only
                        // interruption, the turn cancelling the capture, ends
                        // the fiber here. Nothing typed is left for orDie.
                        Effect.catchCauseIf(
                          (cause) => !Cause.hasInterruptsOnly(cause),
                          (cause) =>
                            Effect.logWarning(
                              "Failed to capture an MCP app; showing a plain tool row.",
                              { server: item.server, tool: item.tool, resourceUri, cause },
                            ).pipe(Effect.as(undefined)),
                        ),
                        Effect.orDie,
                      ),
                    )
                  : undefined;
              const artifacts = yield* buildDynamicToolArtifacts(context, item);
              // Cleared before the final emit: ingestion re-checks pending work
              // after each event, and must see this capture done by then. A turn
              // that already ended badly took the capture and settled its item.
              if (!(yield* takePendingMcpAppCapture(nativeTurnId, item.id))) {
                if (reference !== undefined) {
                  const filePath = resolveAttachmentPathById({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachmentId: reference.attachmentId,
                  });
                  if (filePath !== null) {
                    yield* fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore);
                  }
                }
                return;
              }
              const turnItem =
                reference === undefined || artifacts.turnItem.type !== "dynamic_tool"
                  ? artifacts.turnItem
                  : {
                      ...artifacts.turnItem,
                      // The full CallToolResult the app replays, beside the app.
                      output: { [MCP_APP_OUTPUT_KEY]: reference, result: item.result },
                    };
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem,
              });
              // Only a turn that already ended is released; an active one
              // still needs its final-answer bookkeeping.
              if ((yield* Ref.get(settledTurns)).has(nativeTurnId)) {
                yield* releaseSettledTurnIfIdle(nativeTurnId);
              }
            }),
          );

        /**
         * Settles the items of app captures still running when their turn is
         * interrupted or fails: the capture is cancelled and its tool call is
         * reported as it completed, without the app, before the turn's
         * terminal event closes ingestion.
         */
        const terminalizeMcpAppCaptures = (context: ActiveCodexTurnContext, nativeTurnId: string) =>
          Effect.gen(function* () {
            const captures = (yield* Ref.get(pendingMcpAppCaptures)).get(nativeTurnId);
            if (captures === undefined) return;
            for (const { item, fiber } of captures.values()) {
              if (!(yield* takePendingMcpAppCapture(nativeTurnId, item.id))) continue;
              yield* Fiber.interrupt(fiber);
              const artifacts = yield* buildDynamicToolArtifacts(context, item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }
          });

        const buildProposedPlanArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly status: OrchestrationV2PlanArtifact["status"];
          readonly markdown: string;
          readonly completed?: boolean;
        }) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const completedAt = input.completed === true ? updatedAt : null;
            const planId = yield* resolvePlanId(input.context, input.nativeItemId);
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(
              input.context,
              input.nativeItemId,
            );
            const plan: OrchestrationV2PlanArtifact = {
              id: planId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              kind: "proposed_plan",
              status: input.status,
              markdown: input.markdown,
            };
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "plan",
              status: input.completed === true ? "completed" : "running",
              countsForRun: false,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              parentItemId: null,
              ordinal,
              status: input.completed === true ? "completed" : "running",
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "proposed_plan",
              planId,
              markdown: input.markdown,
              streaming: input.completed !== true,
            };
            return { node, plan, turnItem };
          });

        const buildTodoListArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly status: OrchestrationV2PlanArtifact["status"];
          readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
          readonly explanation?: string;
          readonly completed?: boolean;
        }) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const completedAt = input.completed === true ? updatedAt : null;
            const planId = yield* resolvePlanId(input.context, input.nativeItemId);
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(
              input.context,
              input.nativeItemId,
            );
            const plan: OrchestrationV2PlanArtifact = {
              id: planId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              kind: "todo_list",
              status: input.status,
              steps: [...input.steps],
              ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
            };
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "todo_list",
              status: input.completed === true ? "completed" : "running",
              countsForRun: false,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              parentItemId: null,
              ordinal,
              status: input.completed === true ? "completed" : "running",
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "todo_list",
              planId,
              steps: [...input.steps],
              ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
            };
            return { node, plan, turnItem };
          });

        const buildApprovalRequestArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly nativeRequestId: string;
          readonly requestKind: ProviderRequestKind;
          readonly prompt?: string | null;
          readonly appName?: string;
          readonly options?: ReadonlyArray<ProviderApprovalOption>;
        }) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            // A subagent's approval is asked on the top-level thread and run,
            // under the subagent that asked, where the user can see and answer it.
            const { owner, subagent } = approvalOwnerCodexTurn(input.context);
            const parentNodeId =
              subagent?.subagentNodeId ??
              idAllocator.derive.nodeFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
            const ordinal = yield* resolveItemOrdinal(
              owner,
              `${input.nativeItemId}:approval:${input.nativeRequestId}`,
            );
            const requestId = yield* idAllocator.allocate.runtimeRequest({
              driver: CODEX_PROVIDER,
              providerTurnId: owner.providerTurnId,
              nativeRequestId: input.nativeRequestId,
            });
            const nodeId = idAllocator.derive.approvalNode({ requestId });
            const providerSessionId = owner.input.providerThread.providerSessionId;
            if (providerSessionId === null) {
              return yield* toProtocolError(
                `Provider thread ${owner.providerThread.id} is missing a provider session id.`,
              );
            }
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: owner.projectionThreadId,
              runId: owner.projectionRunId,
              parentNodeId,
              rootNodeId: owner.rootNodeId,
              kind: "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: owner.providerThread.id,
              providerTurnId: owner.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: createdAt,
              completedAt: null,
            };
            const request: OrchestrationV2RuntimeRequest = {
              id: requestId,
              nodeId,
              providerTurnId: owner.providerTurnId,
              nativeRequestRef: {
                driver: CODEX_PROVIDER,
                nativeId: input.nativeRequestId,
                strength: "strong",
              },
              kind: input.requestKind,
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId,
              },
              createdAt,
              resolvedAt: null,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: idAllocator.derive.approvalTurnItem({ requestId }),
              threadId: owner.projectionThreadId,
              runId: owner.projectionRunId,
              nodeId,
              providerThreadId: owner.providerThread.id,
              providerTurnId: owner.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              parentItemId: null,
              ordinal,
              status: "waiting",
              title: null,
              startedAt: createdAt,
              completedAt: null,
              updatedAt: createdAt,
              type: "approval_request",
              requestId,
              requestKind: input.requestKind,
              ...(input.prompt === null || input.prompt === undefined
                ? {}
                : { prompt: input.prompt }),
              ...(input.appName === undefined ? {} : { appName: input.appName }),
              ...(input.options === undefined ? {} : { options: input.options }),
            };
            return { node, request, turnItem };
          });

        const buildUserInputRequestArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly nativeRequestId: string;
          readonly questions: ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion>;
          readonly responseMode?: "message";
        }) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            const requestId = yield* idAllocator.allocate.runtimeRequest({
              driver: CODEX_PROVIDER,
              providerTurnId: input.context.providerTurnId,
              nativeRequestId: input.nativeRequestId,
            });
            const providerSessionId = input.context.input.providerThread.providerSessionId;
            if (providerSessionId === null) {
              return yield* toProtocolError(
                `Provider thread ${input.context.providerThread.id} is missing a provider session id.`,
              );
            }
            const questions = input.questions.map((question, index) => ({
              id: nonEmptyText(question.id, `question-${index + 1}`),
              header: nonEmptyText(question.header, "Question"),
              question: nonEmptyText(question.question, "Choose an answer."),
              options:
                question.options?.map((option, optionIndex) => ({
                  label: nonEmptyText(option.label, `Option ${optionIndex + 1}`),
                  description: nonEmptyText(option.description, option.label),
                })) ?? [],
            }));
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "user_input_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: createdAt,
              completedAt: null,
            };
            const request: OrchestrationV2RuntimeRequest = {
              id: requestId,
              nodeId,
              providerTurnId: input.context.providerTurnId,
              nativeRequestRef: {
                driver: CODEX_PROVIDER,
                nativeId: input.nativeRequestId,
                strength: "strong",
              },
              kind: "user_input",
              status: "pending",
              responseCapability:
                input.responseMode === "message"
                  ? { type: "message" }
                  : { type: "live", providerSessionId },
              createdAt,
              resolvedAt: null,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              parentItemId: null,
              ordinal,
              status: "waiting",
              title: null,
              startedAt: createdAt,
              completedAt: null,
              updatedAt: createdAt,
              type: "user_input_request",
              requestId,
              questions,
              ...(input.responseMode === undefined ? {} : { responseMode: input.responseMode }),
            };
            return { node, request, turnItem };
          });

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
            if (context !== undefined) {
              yield* completeProviderRetry(context, yield* DateTime.now);
            }
            yield* agentMessageDeltas.append({
              turnId: payload.turnId,
              itemId: payload.itemId,
              delta: payload.delta,
            });
          }),
        );

        yield* client.handleServerNotification("item/reasoning/summaryTextDelta", (payload) =>
          appendReasoning(payload, "summary", payload.summaryIndex),
        );
        yield* client.handleServerNotification("item/reasoning/textDelta", (payload) =>
          appendReasoning(payload, "content", payload.contentIndex),
        );

        yield* client.handleServerNotification("item/plan/delta", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            yield* completeProviderRetry(context, yield* DateTime.now);
            const markdown = `${planDeltas.get(payload.itemId) ?? ""}${payload.delta}`;
            planDeltas.set(payload.itemId, markdown);
            const artifacts = yield* buildProposedPlanArtifacts({
              context,
              nativeItemId: payload.itemId,
              status: "active",
              markdown,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "plan.updated",
              driver: CODEX_PROVIDER,
              plan: artifacts.plan,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("turn/plan/updated", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            yield* completeProviderRetry(context, yield* DateTime.now);
            const steps = payload.plan.map((step, index) => ({
              id: `step-${index + 1}`,
              text: nonEmptyText(step.step, `Step ${index + 1}`),
              status: codexPlanStepStatus(step.status),
            }));
            const explanation = trimText(payload.explanation);
            const artifacts = yield* buildTodoListArtifacts({
              context,
              nativeItemId: `turn-plan:${payload.turnId}`,
              status: "active",
              ...(explanation === undefined ? {} : { explanation }),
              steps,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "plan.updated",
              driver: CODEX_PROVIDER,
              plan: artifacts.plan,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("account/rateLimits/updated", (payload) =>
          Effect.gen(function* () {
            yield* Ref.update(rateLimitSnapshot, (previous) =>
              mergeCodexRateLimits(previous, payload.rateLimits),
            );
            const resetAt = codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot));
            for (const item of (yield* Ref.get(limitedTurnItems)).values()) {
              // Fill late reset data once; later account windows do not change this stopped turn.
              if (resetAt === null || item.failure.resetAt != null) continue;
              const updated = {
                ...item,
                updatedAt: yield* DateTime.now,
                failure: { ...item.failure, resetAt },
              };
              yield* Ref.update(limitedTurnItems, (current) =>
                new Map(current).set(item.providerThreadId!, updated),
              );
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: updated,
              });
            }
            const update = codexRateLimitsToUpdate(payload.rateLimits);
            if (update && adapterOptions.onUsageLimits) {
              const checkedAt = DateTime.formatIso(yield* DateTime.now);
              yield* adapterOptions.onUsageLimits({ ...update, checkedAt });
            }
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("thread/tokenUsage/updated", (payload) =>
          Effect.gen(function* () {
            accumulateCodexTurnTokenUsage(
              usageStateForThread(payload.threadId),
              payload.turnId,
              payload.tokenUsage,
            );
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            const now = yield* DateTime.now;
            // Live context usage rides on the provider turn (#8144): the turn
            // is the natural owner and re-emitting it never disturbs items.
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CODEX_PROVIDER,
              threadId: context.projectionThreadId,
              providerTurn: {
                id: context.providerTurnId,
                providerThreadId: context.providerThread.id,
                nodeId: context.providerNodeId,
                runAttemptId: context.subagent === null ? context.input.attemptId : null,
                nativeTurnRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: payload.turnId,
                  strength: "strong",
                },
                ordinal: context.providerTurnOrdinal,
                status: "running",
                startedAt: context.startedAt,
                completedAt: null,
                tokenUsage: codexProviderTurnTokenUsage(
                  payload.tokenUsage,
                  DateTime.formatIso(now),
                ),
              },
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("thread/settings/updated", (payload) =>
          updateSubagentSelection(
            payload.threadId,
            payload.threadSettings.model,
            payload.threadSettings.effort,
            payload.threadSettings.serviceTier,
          ),
        );
        yield* client.handleServerNotification("model/rerouted", (payload) =>
          updateSubagentSelection(payload.threadId, payload.toModel),
        );

        yield* client.handleServerNotification("turn/started", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
            if (context !== undefined) {
              if (context.nativeStartReady !== undefined) {
                yield* Deferred.succeed(context.nativeStartReady, undefined);
              }
              return;
            }
            const pendingRootTurn = (yield* Ref.get(pendingRootTurns)).get(payload.threadId);
            if (pendingRootTurn !== undefined) {
              yield* registerRootTurn({
                turnInput: pendingRootTurn,
                nativeTurnId: payload.turn.id,
                startedAt: codexTimestamp(payload.turn.startedAt),
              });
              yield* Ref.update(pendingRootTurns, (current) => {
                const updated = new Map(current);
                updated.delete(payload.threadId);
                return updated;
              });
              return;
            }
            // Codex continues an active goal on its own. The next turn joins the
            // run its previous turn belongs to.
            const goalHold = goalHolds.get(payload.threadId);
            if (goalHold !== undefined) {
              goalHolds.delete(payload.threadId);
              yield* emitProviderEvent({
                type: "provider_turn.updated",
                driver: CODEX_PROVIDER,
                threadId: goalHold.context.projectionThreadId,
                providerTurn: goalHold.completedTurn,
              });
              const next = yield* registerRootTurn({
                turnInput: {
                  ...goalHold.context.input,
                  providerTurnOrdinal: goalHold.context.providerTurnOrdinal + 1,
                },
                nativeTurnId: payload.turn.id,
                startedAt: codexTimestamp(payload.turn.startedAt),
              });
              const goalRun = goalRuns.get(goalHold.context.providerTurnId) ?? [goalHold.context];
              goalRun.push(next);
              goalRuns.set(goalHold.context.providerTurnId, goalRun);
              goalRuns.set(next.providerTurnId, goalRun);
              yield* Deferred.succeed(goalHold.next, next);
              return;
            }
            // A goal turn with no run to own it (Codex continued after the run
            // settled, or raced a Stop): stop it and pause the goal rather than
            // work out of sight.
            if (
              rootProviderThreads.has(payload.threadId) &&
              (goalsByNativeThread.get(payload.threadId)?.status === "active" ||
                goalStops.has(payload.threadId))
            ) {
              yield* Effect.logWarning("orchestration-v2.codex-goal-turn-without-run", {
                nativeThreadId: payload.threadId,
                nativeTurnId: payload.turn.id,
              });
              yield* client
                .request("thread/goal/set", { threadId: payload.threadId, status: "paused" })
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration-v2.codex-goal-pause-failed", { cause }),
                  ),
                  Effect.andThen(
                    client.request("turn/interrupt", {
                      threadId: payload.threadId,
                      turnId: payload.turn.id,
                    }),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration-v2.codex-goal-turn-stop-failed", { cause }),
                  ),
                  Effect.forkIn(scope),
                );
              return;
            }
            yield* rememberSubagentTurnStarted({
              nativeThreadId: payload.threadId,
              nativeTurnId: payload.turn.id,
              startedAt: codexTimestamp(payload.turn.startedAt),
            });
          }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
        );

        // A goal that stops being active ends any run held open for its next turn.
        yield* client.handleServerNotification("thread/goal/updated", (payload) =>
          Effect.gen(function* () {
            goalsByNativeThread.set(payload.threadId, providerGoalFromCodex(payload.goal));
            yield* emitGoalUpdate(payload.threadId);
            if (payload.goal.status !== "active") yield* releaseGoalHold(payload.threadId);
          }).pipe(turnTerminalizationPermit.withPermits(1)),
        );
        yield* client.handleServerNotification("thread/goal/cleared", (payload) =>
          Effect.gen(function* () {
            goalsByNativeThread.set(payload.threadId, null);
            yield* emitGoalUpdate(payload.threadId);
            yield* releaseGoalHold(payload.threadId);
          }).pipe(turnTerminalizationPermit.withPermits(1)),
        );

        yield* client.handleServerNotification("error", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            const notificationCode = codexErrorInfoCode(payload.error.codexErrorInfo);
            if (!payload.willRetry) {
              context.latestProviderFailure = {
                nativeMessage: payload.error.message,
                failure: makeProviderFailure({
                  message: payload.error.additionalDetails?.trim() || payload.error.message,
                  code: notificationCode,
                  class:
                    notificationCode === "usageLimitExceeded" ||
                    notificationCode === "rateLimitExceeded"
                      ? "usage_limit"
                      : "provider_error",
                }),
              };
              return;
            }
            const updatedAt = yield* DateTime.now;
            const previous = (yield* Ref.get(providerRetries)).get(context.providerTurnId);
            const progress = parseCodexRetryProgress(payload.error.message);
            const retry: OrchestrationV2ProviderRetry = {
              attempt: progress?.attempt ?? (previous?.retry.attempt ?? 0) + 1,
              maxAttempts: progress?.maxAttempts ?? previous?.retry.maxAttempts ?? null,
              retryDelayMs: null,
            };
            const code = codexErrorInfoCode(payload.error.codexErrorInfo);
            const additionalDetails = payload.error.additionalDetails?.trim();
            const failure = makeProviderFailure({
              message:
                additionalDetails === undefined || additionalDetails.length === 0
                  ? payload.error.message
                  : additionalDetails,
              code,
              class:
                code === "usageLimitExceeded" || code === "rateLimitExceeded"
                  ? "usage_limit"
                  : code?.startsWith("http") === true || code?.startsWith("responseStream") === true
                    ? "transport_error"
                    : "provider_error",
              retryable: true,
            });
            const itemOrdinal =
              previous?.itemOrdinal ??
              (yield* resolveItemOrdinal(context, `terminal-failure:${context.providerTurnId}`));
            const state: ActiveCodexProviderRetry = {
              nativeMessage: payload.error.message,
              retry,
              failure,
              startedAt: previous?.startedAt ?? updatedAt,
              itemOrdinal,
            };
            yield* Ref.update(providerRetries, (current) => {
              const updated = new Map(current);
              updated.set(context.providerTurnId, state);
              return updated;
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: makeProviderRetryTurnItem({
                idAllocator,
                driver: CODEX_PROVIDER,
                threadId: context.projectionThreadId,
                runId: context.projectionRunId,
                nodeId: context.providerNodeId,
                providerThreadId: context.providerThread.id,
                providerTurnId: context.providerTurnId,
                itemOrdinal,
                failure,
                retry,
                status: "running",
                startedAt: state.startedAt,
                updatedAt,
              }),
            });
          }).pipe(Effect.orDie),
        );

        const emitCompactionItem = Effect.fn("CodexAdapterV2.emitCompactionItem")(function* (
          context: ActiveCodexTurnContext,
          nativeItemId: string,
          status: "running" | "completed",
          nativeStartedAt?: DateTime.Utc,
        ) {
          const now = yield* DateTime.now;
          const { ordinal, startedAt } = yield* resolveItemPosition(
            context,
            nativeItemId,
            nativeStartedAt,
          );
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId,
              }),
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId: context.providerNodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(nativeItemId),
              parentItemId: null,
              ordinal,
              type: "compaction",
              driver: CODEX_PROVIDER,
              status,
              title: status === "completed" ? "Context compacted" : "Compacting context",
              startedAt,
              completedAt: status === "completed" ? now : null,
              updatedAt: now,
            },
          });
        });

        yield* client.handleServerNotification("item/started", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }

            if (payload.item.type === "contextCompaction") {
              yield* emitCompactionItem(
                context,
                payload.item.id,
                "running",
                DateTime.makeUnsafe(payload.startedAtMs),
              );
              return;
            }

            if (payload.item.type === "userMessage") {
              yield* emitSubagentUserMessage(
                context,
                payload.item,
                DateTime.makeUnsafe(payload.startedAtMs),
              );
              return;
            }

            if (payload.item.type === "subAgentActivity") {
              markSubagentUsage(context);
              yield* registerSubagentActivity({
                context,
                item: payload.item,
              });
              return;
            }

            yield* completeProviderRetry(context, yield* DateTime.now);
            // Reasoning streams per part, so its parts take their own first-seen times.
            if (payload.item.type !== "reasoning") {
              yield* resolveItemPosition(
                context,
                payload.item.id,
                DateTime.makeUnsafe(payload.startedAtMs),
              );
            }

            if (payload.item.type === "agentMessage") {
              if (payload.item.phase !== "commentary") {
                yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                  const updated = new Map(current);
                  const itemIds = new Set(updated.get(payload.turnId) ?? []);
                  itemIds.add(payload.item.id);
                  updated.set(payload.turnId, itemIds);
                  return updated;
                });
              }
              return;
            }

            if (payload.item.type === "commandExecution") {
              if (!codexItemStatus(payload.item.status).completed) {
                yield* trackRunningCommandItem(payload.turnId, {
                  id: payload.item.id,
                  command: payload.item.command,
                  ...(payload.item.aggregatedOutput === null ||
                  payload.item.aggregatedOutput === undefined
                    ? {}
                    : { aggregatedOutput: payload.item.aggregatedOutput }),
                  ...(typeof payload.item.processId === "string"
                    ? { processId: payload.item.processId }
                    : {}),
                });
              }
              const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "mcpToolCall" || payload.item.type === "dynamicToolCall") {
              if (!codexItemStatus(payload.item.status).completed) {
                yield* trackRunningDynamicTool(payload.turnId, payload.item);
              }
              const artifacts = yield* buildDynamicToolArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type !== "webSearch") {
              return;
            }

            const artifacts = yield* buildWebSearchArtifacts({
              context,
              item: payload.item,
              completed: false,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
        );

        yield* client.handleServerNotification("item/completed", (payload) =>
          Effect.gen(function* () {
            if (payload.item.type === "contextCompaction")
              // The notification callback runs on the input reader. Let it read
              // the injection response while the session-scoped request waits.
              yield* restoreAdditionalContext(payload.threadId).pipe(
                Effect.forkIn(scope, { startImmediately: true }),
              );
            if (
              (payload.item.type === "subAgentActivity" ||
                payload.item.type === "collabAgentToolCall") &&
              (yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(payload.turnId)
            )
              return;
            // Child lifecycle notifications outlive the parent's turn context.
            if (payload.item.type === "subAgentActivity" && payload.item.kind !== "started") {
              yield* registerSubagentActivity({ item: payload.item });
              return;
            }
            if (payload.item.type === "collabAgentToolCall" && payload.item.tool !== "spawnAgent") {
              yield* updateSubagentStates({ item: payload.item });
              return;
            }
            const resolved = yield* resolveItemEventContext(payload.turnId);
            if (resolved === undefined) {
              return;
            }
            const { context, settled } = resolved;

            if (payload.item.type === "reasoning") {
              yield* completeReasoning(payload.turnId, payload.item);
              return;
            }

            if (payload.item.type === "contextCompaction") {
              yield* emitCompactionItem(context, payload.item.id, "completed");
              return;
            }

            if (payload.item.type === "userMessage") {
              if (yield* emitSubagentUserMessage(context, payload.item)) {
                return;
              }
            }

            if (payload.item.type === "commandExecution") {
              const turnDrained = yield* clearRunningCommandItem(payload.turnId, payload.item.id);
              const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              if (settled) {
                if (
                  context.subagent === null &&
                  continuationRequests !== undefined &&
                  !(yield* Ref.get(interruptingNativeTurns)).has(payload.turnId)
                ) {
                  const alreadyOffered = yield* Ref.modify(
                    offeredContinuationItemsByTurn,
                    (current) => {
                      const items = current.get(payload.turnId);
                      if (items !== undefined && items.has(payload.item.id)) {
                        return [true, current] as const;
                      }
                      const updated = new Map(current);
                      const updatedItems = new Set(items ?? []);
                      updatedItems.add(payload.item.id);
                      updated.set(payload.turnId, updatedItems);
                      return [false, updated] as const;
                    },
                  );
                  if (!alreadyOffered) {
                    yield* continuationRequests.offer({
                      threadId: context.projectionThreadId,
                      providerThreadId: context.providerThread.id,
                      driver: CODEX_PROVIDER,
                      detail: codexBackgroundCommandDetail(payload.item),
                      notification: {
                        ...backgroundWorkNotification([
                          {
                            kind: "command",
                            label: payload.item.command,
                            outcome:
                              payload.item.exitCode === 0
                                ? "completed"
                                : payload.item.exitCode == null
                                  ? "unknown"
                                  : "failed",
                            exitCode: payload.item.exitCode ?? undefined,
                          },
                        ]),
                        detail: payload.item.command,
                      },
                    });
                  }
                }
                if (turnDrained) {
                  yield* releaseSettledTurnIfIdle(payload.turnId);
                }
              }
              return;
            }

            if (payload.item.type === "mcpToolCall" || payload.item.type === "dynamicToolCall") {
              yield* clearRunningDynamicTool(payload.turnId, payload.item.id);
              const appResourceUri = codexMcpAppResourceUri(payload.item);
              if (appResourceUri !== undefined && payload.item.type === "mcpToolCall") {
                yield* captureMcpApp(context, payload.turnId, payload.item, appResourceUri);
                return;
              }
              const artifacts = yield* buildDynamicToolArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              if (settled) {
                yield* releaseSettledTurnIfIdle(payload.turnId);
              }
              return;
            }

            if (payload.item.type === "fileChange") {
              const artifacts = yield* buildFileChangeArtifacts(context, payload.item);
              if (artifacts === null) {
                return;
              }
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "webSearch") {
              const artifacts = yield* buildWebSearchArtifacts({
                context,
                item: payload.item,
                completed: true,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "plan") {
              const markdown =
                payload.item.text.length > 0
                  ? payload.item.text
                  : (planDeltas.get(payload.item.id) ?? "");
              planDeltas.delete(payload.item.id);
              // A finished proposal stays active until Implement consumes it.
              const artifacts = yield* buildProposedPlanArtifacts({
                context,
                nativeItemId: payload.item.id,
                status: "active",
                markdown,
                completed: true,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "plan.updated",
                driver: CODEX_PROVIDER,
                plan: artifacts.plan,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "collabAgentToolCall") {
              if (payload.item.tool === "spawnAgent") markSubagentUsage(context);
              yield* registerSubagentThreads({
                context,
                item: payload.item,
              });
              yield* updateSubagentStates({
                item: payload.item,
              });
              return;
            }

            if (payload.item.type === "subAgentActivity") {
              markSubagentUsage(context);
              yield* registerSubagentActivity({
                context,
                item: payload.item,
              });
              return;
            }

            if (payload.item.type !== "agentMessage") {
              return;
            }

            if (payload.item.delivery === "async" && payload.item.questions?.length) {
              const artifacts = yield* buildUserInputRequestArtifacts({
                context,
                nativeItemId: payload.item.id,
                nativeRequestId: `async:${payload.item.id}`,
                responseMode: "message",
                questions: payload.item.questions.map((question, index) => ({
                  id: String(index),
                  header: "Question",
                  question: question.title,
                  options: (question.options ?? []).map((label) => ({ label, description: "" })),
                })),
              });
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                driver: CODEX_PROVIDER,
                threadId: artifacts.node.threadId,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                const ids = current.get(payload.turnId);
                if (!ids?.has(payload.item.id)) return current;
                const next = new Map(current);
                const remaining = new Set(ids);
                remaining.delete(payload.item.id);
                if (remaining.size === 0) next.delete(payload.turnId);
                else next.set(payload.turnId, remaining);
                return next;
              });
              return;
            }

            const finalAnswer = payload.item.phase !== "commentary";
            if (finalAnswer) {
              yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                const updated = new Map(current);
                const itemIds = new Set(updated.get(payload.turnId) ?? []);
                itemIds.add(payload.item.id);
                updated.set(payload.turnId, itemIds);
                return updated;
              });
            }
            const completedTextsBefore =
              (yield* Ref.get(completedFinalAnswerTextsByTurn)).get(payload.turnId) ??
              new Set<string>();
            const text = yield* agentMessageDeltas.complete({
              turnId: payload.turnId,
              itemId: payload.item.id,
              finalText: payload.item.text,
            });
            yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
              const itemIds = current.get(payload.turnId);
              if (itemIds === undefined || !itemIds.has(payload.item.id)) {
                return current;
              }
              const updated = new Map(current);
              const remainingItemIds = new Set(itemIds);
              remainingItemIds.delete(payload.item.id);
              if (remainingItemIds.size === 0) {
                updated.delete(payload.turnId);
              } else {
                updated.set(payload.turnId, remainingItemIds);
              }
              return updated;
            });
            const emitted =
              !finalAnswer ||
              completedTextsBefore.size === 0 ||
              (text.length > 0 && !completedTextsBefore.has(text));
            if (emitted && context.subagent !== null && finalAnswer) {
              yield* emitSubagentTaskUpdate({
                subagent: context.subagent,
                status: context.subagent.task.status,
                result: text,
              });
            }
          }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
        );

        yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for approval turn ${payload.turnId}.`,
                payload,
              );
            }

            const nativeRequestId = payload.approvalId ?? payload.itemId;
            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.itemId,
              nativeRequestId,
              requestKind: "command",
              ...((payload.reason ?? payload.command) === undefined
                ? {}
                : { prompt: payload.reason ?? payload.command }),
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "command",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return {
              decision: resolved === "acceptAlways" ? "acceptForSession" : resolved,
            } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for file change approval turn ${payload.turnId}.`,
                payload,
              );
            }

            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.itemId,
              nativeRequestId: payload.itemId,
              requestKind: "file-change",
              prompt: codexFileChangeApprovalPrompt(payload) ?? null,
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "file-change",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return {
              decision: resolved === "acceptAlways" ? "acceptForSession" : resolved,
            } satisfies CodexSchema.FileChangeRequestApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/permissions/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for permissions approval turn ${payload.turnId}.`,
                payload,
              );
            }

            const requestKind = providerRequestKindFromPermissions(payload.permissions);
            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.itemId,
              nativeRequestId: payload.itemId,
              requestKind,
              ...(payload.reason === undefined ? {} : { prompt: payload.reason }),
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind,
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return permissionsResponseFromDecision({
              decision: resolved,
              permissions: payload.permissions,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("mcpServer/elicitation/request", (payload) =>
          Effect.gen(function* () {
            // Unsupported elicitation shapes cannot express an approval, so
            // decline instead of presenting a request the user cannot answer.
            if (toMcpElicitationResponse(payload, "accept").action !== "accept") {
              yield* Effect.logWarning("Declined an unsupported MCP elicitation.", {
                serverName: payload.serverName,
                mode: payload.mode,
              });
              return {
                action: "decline",
              } satisfies CodexSchema.McpServerElicitationRequestResponse;
            }
            const context =
              payload.turnId === undefined || payload.turnId === null
                ? undefined
                : yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              yield* Effect.logWarning(
                "Declined an MCP elicitation without an active Codex turn context.",
                { serverName: payload.serverName },
              );
              return {
                action: "decline",
              } satisfies CodexSchema.McpServerElicitationRequestResponse;
            }

            const nativeRequestId =
              payload.mode === "url"
                ? payload.elicitationId
                : `mcp-elicitation:${payload.serverName}`;
            const described = describeMcpElicitation(payload);
            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: nativeRequestId,
              nativeRequestId,
              requestKind: "mcp-elicitation",
              prompt: payload.message,
              appName: described.appName,
              options: described.options,
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "mcp-elicitation",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return toMcpElicitationResponse(payload, resolved);
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("execCommandApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* findActiveTurnByNativeThreadId(payload.conversationId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for exec approval thread ${payload.conversationId}.`,
                payload,
              );
            }

            const nativeRequestId = payload.approvalId ?? payload.callId;
            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.callId,
              nativeRequestId,
              requestKind: "command",
              prompt: payload.reason ?? payload.command.join(" "),
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "command",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return {
              decision: approvalDecisionToLegacyReviewDecision(resolved),
            } satisfies CodexSchema.ExecCommandApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("applyPatchApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* findActiveTurnByNativeThreadId(payload.conversationId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for apply patch approval thread ${payload.conversationId}.`,
                payload,
              );
            }

            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.callId,
              nativeRequestId: payload.callId,
              requestKind: "file-change",
              prompt: codexFileChangeApprovalPrompt(payload) ?? null,
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "file-change",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return {
              decision: approvalDecisionToLegacyReviewDecision(resolved),
            } satisfies CodexSchema.ApplyPatchApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for user input request turn ${payload.turnId}.`,
                payload,
              );
            }

            const artifacts = yield* buildUserInputRequestArtifacts({
              context,
              nativeItemId: payload.itemId,
              nativeRequestId: payload.itemId,
              questions: payload.questions,
            });
            const answers = yield* Deferred.make<ProviderUserInputAnswers, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "user_input",
                requestId: artifacts.request.id,
                answers,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });

            const resolved = yield* Deferred.await(answers).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return {
              answers: toCodexUserInputAnswers(
                resolved,
                new Set(payload.questions.map((question) => question.id)),
              ),
            } satisfies CodexSchema.ToolRequestUserInputResponse;
          }).pipe(Effect.orDie),
        );

        const makeRootTerminalEvent = Effect.fn("CodexAdapterV2.makeRootTerminalEvent")(
          function* (input: {
            readonly context: ActiveCodexTurnContext;
            readonly status: OrchestrationV2ProviderTurn["status"];
            readonly failureMessage?: string;
            readonly failureCode?: string | null;
            readonly providerRetry?: ActiveCodexProviderRetry;
          }): Effect.fn.Return<CodexRootTerminalEvent> {
            const terminalStatus = providerTurnStatusToTerminal(input.status);
            if (terminalStatus === "failed") {
              const previousFailure = input.context.latestProviderFailure ?? input.providerRetry;
              const failure =
                previousFailure !== undefined &&
                (input.failureMessage === undefined ||
                  input.failureMessage === previousFailure.nativeMessage) &&
                (input.failureCode === undefined ||
                  input.failureCode === previousFailure.failure.code)
                  ? previousFailure.failure
                  : makeProviderFailure({
                      message: input.failureMessage,
                      code: input.failureCode,
                      class:
                        input.failureCode === "usageLimitExceeded" ||
                        input.failureCode === "rateLimitExceeded"
                          ? "usage_limit"
                          : "provider_error",
                    });
              return {
                type: "turn.terminal",
                driver: CODEX_PROVIDER,
                providerThreadId: input.context.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                runOrdinal: input.context.input.runOrdinal,
                failureItemOrdinal: yield* resolveItemOrdinal(
                  input.context,
                  `terminal-failure:${input.context.providerTurnId}`,
                ),
                status: terminalStatus,
                failure:
                  failure.class === "usage_limit"
                    ? {
                        ...failure,
                        resetAt: codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot)),
                      }
                    : failure,
                ...(input.providerRetry === undefined
                  ? {}
                  : {
                      retry: input.providerRetry.retry,
                      retryStartedAt: input.providerRetry.startedAt,
                    }),
                threadDisposition: "reusable",
              };
            }
            return {
              type: "turn.terminal",
              driver: CODEX_PROVIDER,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              runOrdinal: input.context.input.runOrdinal,
              status: terminalStatus,
              failure: null,
              threadDisposition: "reusable",
            };
          },
        );

        const emitRootTerminal = Effect.fnUntraced(function* (
          context: ActiveCodexTurnContext,
          event: CodexRootTerminalEvent,
        ) {
          const current =
            event.status === "failed" && event.failure.class === "usage_limit"
              ? {
                  ...event,
                  failure: {
                    ...event.failure,
                    resetAt:
                      event.failure.resetAt ??
                      codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot)),
                  },
                }
              : event;
          yield* emitProviderEvent(current);
          for (const turn of goalRuns.get(context.providerTurnId) ?? []) {
            goalRuns.delete(turn.providerTurnId);
          }
          // Later goal updates must not mark the settled thread active again.
          const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
          const rootProviderThread =
            nativeThreadId == null ? undefined : rootProviderThreads.get(nativeThreadId);
          if (nativeThreadId != null && rootProviderThread !== undefined) {
            rootProviderThreads.set(nativeThreadId, { ...rootProviderThread, status: "idle" });
          }
          if (current.status === "failed" && current.failure.class === "usage_limit") {
            const item = makeProviderFailureTurnItem({
              idAllocator,
              driver: CODEX_PROVIDER,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId: context.input.rootNodeId,
              providerThreadId: current.providerThreadId,
              providerTurnId: current.providerTurnId,
              itemOrdinal: current.failureItemOrdinal,
              failure: current.failure,
              occurredAt: yield* DateTime.now,
            });
            yield* Ref.update(limitedTurnItems, (items) =>
              new Map(items).set(context.providerThread.id, item),
            );
          }
        });

        const emitOrDeferRootTerminal = Effect.fn("CodexAdapterV2.emitOrDeferRootTerminal")(
          function* (input: {
            readonly context: ActiveCodexTurnContext;
            readonly nativeTurnId: string;
            readonly status: OrchestrationV2ProviderTurn["status"];
            readonly failureMessage?: string;
            readonly failureCode?: string | null;
            readonly providerRetry?: ActiveCodexProviderRetry;
            readonly goalHoldTurn?: OrchestrationV2ProviderTurn;
          }) {
            const event = yield* makeRootTerminalEvent(input);
            const hasActiveDescendants = Array.from((yield* Ref.get(activeTurns)).values()).some(
              (candidate) => isDescendantCodexTurn(candidate, input.context),
            );
            if (event.status !== "completed" && hasActiveDescendants) {
              yield* Ref.update(deferredRootTerminals, (current) => {
                const updated = new Map(current);
                updated.set(input.nativeTurnId, { context: input.context, event });
                return updated;
              });
              return;
            }
            const nativeThreadId = input.context.providerThread.nativeThreadRef?.nativeId;
            if (
              input.goalHoldTurn !== undefined &&
              event.status === "completed" &&
              nativeThreadId != null
            ) {
              goalHolds.set(nativeThreadId, {
                context: input.context,
                event,
                completedTurn: input.goalHoldTurn,
                next: yield* Deferred.make<ActiveCodexTurnContext | undefined>(),
              });
              yield* Effect.sleep(CODEX_GOAL_CONTINUATION_GRACE).pipe(
                Effect.andThen(
                  turnTerminalizationPermit.withPermits(1)(releaseGoalHold(nativeThreadId, event)),
                ),
                Effect.forkIn(scope),
              );
              return;
            }
            yield* emitRootTerminal(input.context, event);
          },
        );

        /**
         * Settles a held goal run with its last turn. Call with the
         * terminalization permit, after removing the hold from `goalHolds`.
         */
        const settleGoalHold = Effect.fnUntraced(function* (
          hold: CodexGoalHold,
          status: "completed" | "interrupted",
        ) {
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CODEX_PROVIDER,
            threadId: hold.context.projectionThreadId,
            providerTurn: hold.completedTurn,
          });
          yield* emitRootTerminal(hold.context, { ...hold.event, status });
          yield* Deferred.succeed(hold.next, undefined);
        });

        /** Settles a held goal run unless Stop owns it or a newer hold replaced it. */
        const releaseGoalHold = Effect.fnUntraced(function* (
          nativeThreadId: string,
          expected?: CodexRootTerminalEvent,
        ) {
          const hold = goalHolds.get(nativeThreadId);
          if (hold === undefined || goalStops.has(nativeThreadId)) return;
          if (expected !== undefined && hold.event !== expected) return;
          goalHolds.delete(nativeThreadId);
          yield* settleGoalHold(hold, "completed");
        });

        const flushReadyRootTerminals = Effect.fn("CodexAdapterV2.flushReadyRootTerminals")(
          function* () {
            const activeTurnContexts = Array.from((yield* Ref.get(activeTurns)).values());
            const readyEvents = yield* Ref.modify(deferredRootTerminals, (current) => {
              const updated = new Map(current);
              const ready: Array<{
                context: ActiveCodexTurnContext;
                event: CodexRootTerminalEvent;
              }> = [];
              for (const [nativeTurnId, deferred] of current) {
                if (
                  !activeTurnContexts.some((candidate) =>
                    isDescendantCodexTurn(candidate, deferred.context),
                  )
                ) {
                  updated.delete(nativeTurnId);
                  ready.push(deferred);
                }
              }
              return [ready, updated] as const;
            });
            for (const ready of readyEvents) {
              yield* emitRootTerminal(ready.context, ready.event);
            }
          },
        );

        const finalizeCodexTurn = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeTurnId: string;
          readonly status: OrchestrationV2ProviderTurn["status"];
          readonly completedAt: DateTime.Utc;
          readonly failureMessage?: string;
          readonly failureCode?: string | null;
        }) =>
          turnTerminalizationPermit.withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* Ref.get(activeTurns)).get(input.nativeTurnId);
              if (current !== input.context) {
                return false;
              }
              const providerRetry = yield* Ref.modify(providerRetries, (current) => {
                const retry = current.get(input.context.providerTurnId);
                if (retry === undefined) {
                  return [undefined, current] as const;
                }
                const updated = new Map(current);
                updated.delete(input.context.providerTurnId);
                return [retry, updated] as const;
              });
              if (
                providerRetry !== undefined &&
                (input.status !== "failed" || input.context.subagent !== null)
              ) {
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  driver: CODEX_PROVIDER,
                  turnItem: makeProviderRetryTurnItem({
                    idAllocator,
                    driver: CODEX_PROVIDER,
                    threadId: input.context.projectionThreadId,
                    runId: input.context.projectionRunId,
                    nodeId: input.context.providerNodeId,
                    providerThreadId: input.context.providerThread.id,
                    providerTurnId: input.context.providerTurnId,
                    itemOrdinal: providerRetry.itemOrdinal,
                    failure: providerRetry.failure,
                    retry: providerRetry.retry,
                    status: providerTurnStatusToTerminal(input.status),
                    startedAt: providerRetry.startedAt,
                    updatedAt: input.completedAt,
                  }),
                });
              }
              if (input.status !== "completed") {
                yield* Ref.update(terminalizedNonCompletedNativeTurns, (current) => {
                  const updated = new Set(current);
                  updated.add(input.nativeTurnId);
                  return updated;
                });
              }
              yield* agentMessageDeltas.flushTurn(input.nativeTurnId);
              yield* reasoningDeltas.flushTurn(input.nativeTurnId);
              for (const [key, part] of reasoningParts) {
                if (part.turnId === input.nativeTurnId) reasoningParts.delete(key);
              }
              const nativeThreadId = input.context.providerThread.nativeThreadRef?.nativeId;
              // Codex continues an active goal with another turn, so the run stays
              // open and this turn reads as running until that turn starts.
              const activation =
                nativeThreadId == null ? undefined : goalActivations.get(nativeThreadId);
              const holdsForGoal =
                input.context.subagent === null &&
                input.status === "completed" &&
                nativeThreadId != null &&
                (goalsByNativeThread.get(nativeThreadId)?.status === "active" ||
                  (activation !== undefined && !activation.stopped));
              const completedTurn: OrchestrationV2ProviderTurn = {
                id: input.context.providerTurnId,
                providerThreadId: input.context.providerThread.id,
                nodeId: input.context.providerNodeId,
                runAttemptId:
                  input.context.subagent === null ? input.context.input.attemptId : null,
                nativeTurnRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: input.nativeTurnId,
                  strength: "strong",
                },
                ordinal: input.context.providerTurnOrdinal,
                status: input.status,
                startedAt: input.context.startedAt,
                completedAt: input.completedAt,
                turnTokenUsage: completeCodexTurnTokenUsage(
                  usageStateForThread(
                    input.context.providerThread.nativeThreadRef?.nativeId ??
                      String(input.context.providerThread.id),
                  ),
                  input.nativeTurnId,
                  input.status === "completed",
                ),
              };
              if (!holdsForGoal) {
                yield* emitProviderEvent({
                  type: "provider_turn.updated",
                  driver: CODEX_PROVIDER,
                  threadId: input.context.projectionThreadId,
                  providerTurn: completedTurn,
                });
              }
              if (input.context.subagent !== null) {
                yield* emitProviderEvent({
                  type: "node.updated",
                  driver: CODEX_PROVIDER,
                  node: {
                    id: input.context.providerNodeId,
                    threadId: input.context.projectionThreadId,
                    runId: null,
                    parentNodeId: null,
                    rootNodeId: input.context.rootNodeId,
                    kind: "root_turn",
                    status: input.status,
                    countsForRun: false,
                    providerThreadId: input.context.providerThread.id,
                    providerTurnId: input.context.providerTurnId,
                    nativeItemRef: input.context.subagent.task.nativeTaskRef,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: input.context.providerNodeStartedAt,
                    completedAt: input.completedAt,
                  },
                });
                yield* emitProviderEvent({
                  type: "provider_thread.updated",
                  driver: CODEX_PROVIDER,
                  providerThread: {
                    ...input.context.providerThread,
                    status: "idle",
                    updatedAt: input.completedAt,
                  },
                });
                yield* emitProviderEvent({
                  type: "node.updated",
                  driver: CODEX_PROVIDER,
                  node: {
                    id: input.context.subagent.subagentNodeId,
                    threadId: input.context.subagent.parentContext.projectionThreadId,
                    runId: input.context.subagent.parentContext.projectionRunId,
                    parentNodeId: input.context.subagent.parentContext.itemParentNodeId,
                    rootNodeId: input.context.subagent.parentContext.rootNodeId,
                    kind: "subagent",
                    status: input.status,
                    countsForRun: false,
                    providerThreadId: input.context.providerThread.id,
                    providerTurnId: input.context.subagent.parentContext.providerTurnId,
                    nativeItemRef: input.context.subagent.task.nativeTaskRef,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: input.context.subagent.startedAt,
                    completedAt: input.completedAt,
                  },
                });
                yield* emitSubagentTaskUpdate({
                  subagent: input.context.subagent,
                  status: input.status,
                  completedAt: input.completedAt,
                });
              }
              if (input.status === "interrupted" || input.status === "failed") {
                yield* terminalizeRunningCommandItems(
                  input.context,
                  input.nativeTurnId,
                  input.status,
                  input.completedAt,
                );
                yield* terminalizeMcpAppCaptures(input.context, input.nativeTurnId);
              }
              const dynamicToolStatus: "cancelled" | "interrupted" | "failed" =
                input.status === "interrupted" || input.status === "failed"
                  ? input.status
                  : "cancelled";
              yield* terminalizeRunningDynamicTools(
                input.context,
                input.nativeTurnId,
                dynamicToolStatus,
                input.completedAt,
                input.status === "interrupted" || input.status === "failed",
              );
              if (input.context.subagent === null) {
                yield* emitOrDeferRootTerminal({
                  ...input,
                  ...(providerRetry === undefined ? {} : { providerRetry }),
                  ...(holdsForGoal ? { goalHoldTurn: completedTurn } : {}),
                });
              }
              const waiter = (yield* Ref.get(turnWaiters)).get(input.nativeTurnId);
              if (waiter !== undefined) {
                yield* Deferred.succeed(waiter, undefined);
              }
              const interruptInProgress = (yield* Ref.get(interruptingNativeTurns)).has(
                input.nativeTurnId,
              );
              // Completed turns can retain late background command context and
              // leftover persistent dynamic tools. Interrupted and failed turns
              // never wake from late item events.
              const retainSettledContext =
                input.status === "completed" &&
                (yield* turnHasRetainedBackgroundWork(input.nativeTurnId));
              if (retainSettledContext) {
                yield* Ref.update(settledTurns, (current) => {
                  const updated = new Map(current);
                  updated.set(input.nativeTurnId, input.context);
                  return updated;
                });
                // Background work that finished between the check above and
                // the turn being recorded as settled saw no settled turn to
                // release, so it is re-checked once recorded.
                yield* releaseSettledTurnIfIdle(input.nativeTurnId);
              }
              yield* Ref.update(activeTurns, (current) => {
                const updated = new Map(current);
                updated.delete(input.nativeTurnId);
                return updated;
              });
              if (input.context.nativeStartReady !== undefined) {
                yield* Deferred.succeed(input.context.nativeStartReady, undefined);
              }
              yield* flushReadyRootTerminals();
              if (!retainSettledContext && !interruptInProgress) {
                yield* Ref.update(runningCommandItemsByTurn, (current) => {
                  if (!current.has(input.nativeTurnId)) {
                    return current;
                  }
                  const updated = new Map(current);
                  updated.delete(input.nativeTurnId);
                  return updated;
                });
                yield* Ref.update(runningDynamicToolsByTurn, (current) => {
                  if (!current.has(input.nativeTurnId)) {
                    return current;
                  }
                  const updated = new Map(current);
                  updated.delete(input.nativeTurnId);
                  return updated;
                });
              }
              if (!retainSettledContext) {
                yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
                  if (!current.has(input.nativeTurnId)) {
                    return current;
                  }
                  const updated = new Map(current);
                  updated.delete(input.nativeTurnId);
                  return updated;
                });
                yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                  if (!current.has(input.nativeTurnId)) {
                    return current;
                  }
                  const updated = new Map(current);
                  updated.delete(input.nativeTurnId);
                  return updated;
                });
              }
              return true;
            }),
          );

        yield* client.handleServerNotification("turn/completed", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
            if (context === undefined) {
              return;
            }
            const nativeStatus = mapCodexTurnStatus(payload.turn.status);
            const status =
              nativeStatus === "completed" &&
              (yield* Ref.get(interruptingNativeTurns)).has(payload.turn.id)
                ? "interrupted"
                : nativeStatus;
            yield* finalizeCodexTurn({
              context,
              nativeTurnId: payload.turn.id,
              status,
              completedAt: codexTimestamp(payload.turn.completedAt),
              ...(payload.turn.error?.message === undefined
                ? {}
                : {
                    failureMessage: payload.turn.error.message,
                    ...(payload.turn.error.codexErrorInfo == null
                      ? {}
                      : {
                          failureCode: codexErrorInfoCode(payload.turn.error.codexErrorInfo),
                        }),
                  }),
            });
          }),
        );

        /**
         * Settles a `/goal` run that started no Codex turn. Its reply is plain
         * assistant text, as Claude's own `/goal` output is.
         */
        const completeGoalCommandTurn = Effect.fnUntraced(function* (
          turnInput: ProviderAdapterV2TurnInput,
          reply: string,
        ) {
          const now = yield* DateTime.now;
          const nativeId = `goal-command:${turnInput.attemptId}`;
          const context: ActiveCodexTurnContext = {
            input: turnInput,
            projectionAppThread: turnInput.appThread,
            projectionThreadId: turnInput.threadId,
            projectionRunId: turnInput.runId,
            nativeTurnId: nativeId,
            providerThread: turnInput.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_PROVIDER,
              nativeTurnId: nativeId,
            }),
            providerTurnOrdinal: turnInput.providerTurnOrdinal,
            providerNodeId: turnInput.rootNodeId,
            providerNodeKind: "root_turn",
            providerNodeStartedAt: now,
            itemParentNodeId: turnInput.rootNodeId,
            rootNodeId: turnInput.rootNodeId,
            subagent: null,
            startedAt: now,
            itemPositions: new Map(),
          };
          const providerTurn = {
            id: context.providerTurnId,
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: null,
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt: now,
            completedAt: null,
          } satisfies OrchestrationV2ProviderTurn;
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CODEX_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* rememberRootProviderThread(turnInput.providerThread);
          const artifacts = yield* buildAgentMessageArtifacts(
            context,
            { id: nativeId, text: reply },
            true,
          );
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "message.updated",
            driver: CODEX_PROVIDER,
            message: artifacts.message,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CODEX_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn: { ...providerTurn, status: "completed", completedAt: now },
          });
          yield* emitRootTerminal(context, {
            type: "turn.terminal",
            driver: CODEX_PROVIDER,
            providerThreadId: turnInput.providerThread.id,
            providerTurnId: context.providerTurnId,
            runOrdinal: turnInput.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        });

        /** The goal hold whose run still reports this provider turn as running. */
        const heldGoalTurn = (
          providerThread: OrchestrationV2ProviderThread,
          providerTurnId: ProviderTurnId,
        ) => {
          const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
          const hold = nativeThreadId == null ? undefined : goalHolds.get(nativeThreadId);
          return hold?.context.providerTurnId === providerTurnId && nativeThreadId != null
            ? { nativeThreadId, hold }
            : undefined;
        };

        /**
         * Like the Codex TUI, Stop pauses an active goal first so Codex starts
         * no further goal turn. Codex can end or continue the turn while the
         * pause is in flight, so the target resolves after it: a held run
         * settles here and leaves only its retained work to stop, and a
         * continued run moves Stop to its newest turn. `goalTurns` lists the
         * run's root turns, seen before and after the pause, whose descendants
         * Stop also reaches.
         */
        const resolveGoalStopTarget = Effect.fnUntraced(function* (
          turnInput: ProviderAdapterV2InterruptInput,
        ) {
          const goalThreadId = turnInput.providerThread.nativeThreadRef?.nativeId;
          if (goalThreadId == null) {
            return { turnInput, goalTurns: [] as ReadonlyArray<ActiveCodexTurnContext> };
          }
          goalStops.set(goalThreadId, (goalStops.get(goalThreadId) ?? 0) + 1);
          return yield* Effect.gen(function* () {
            // The run can settle while the pause is in flight, which drops its record.
            const requestedTurnId = latestGoalTurnId(turnInput.providerTurnId);
            const heldBefore = goalHolds.get(goalThreadId)?.context;
            const turnsBefore = [
              ...(goalRuns.get(requestedTurnId) ?? []),
              ...Array.from((yield* Ref.get(activeTurns)).values()).filter(
                (context) => context.providerTurnId === requestedTurnId,
              ),
              ...(heldBefore?.providerTurnId === requestedTurnId ? [heldBefore] : []),
            ];
            const activation = goalActivations.get(goalThreadId);
            if (activation !== undefined) activation.stopped = true;
            if (goalsByNativeThread.get(goalThreadId)?.status === "active") {
              yield* client
                .request("thread/goal/set", { threadId: goalThreadId, status: "paused" })
                .pipe(
                  Effect.tap(({ goal }) =>
                    Effect.sync(() =>
                      goalsByNativeThread.set(goalThreadId, providerGoalFromCodex(goal)),
                    ),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration-v2.codex-goal-pause-failed", { cause }),
                  ),
                );
            }
            return yield* turnTerminalizationPermit.withPermits(1)(
              Effect.gen(function* () {
                const providerTurnId = latestGoalTurnId(turnInput.providerTurnId);
                const hold = goalHolds.get(goalThreadId);
                const held = hold !== undefined && hold.context.providerTurnId === providerTurnId;
                const goalTurns: ReadonlyArray<ActiveCodexTurnContext> = Array.from(
                  new Set([
                    ...turnsBefore,
                    ...(goalRuns.get(providerTurnId) ?? []),
                    ...(held ? [hold.context] : []),
                  ]),
                );
                if (!held) return { turnInput: { ...turnInput, providerTurnId }, goalTurns };
                goalHolds.delete(goalThreadId);
                yield* settleGoalHold(hold, "interrupted");
                return {
                  turnInput: { ...turnInput, providerTurnId, requestRuntimeRestart: true },
                  goalTurns,
                };
              }),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                const stops = (goalStops.get(goalThreadId) ?? 1) - 1;
                if (stops > 0) goalStops.set(goalThreadId, stops);
                else goalStops.delete(goalThreadId);
              }),
            ),
          );
        });

        /** Starts a native turn with this run's full turn configuration. */
        const startNativeTurn = (
          turnInput: ProviderAdapterV2TurnInput,
          codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>,
        ) =>
          Effect.gen(function* () {
            const threadId = yield* getNativeThreadId(turnInput.providerThread);
            const mcpSession = McpProviderSession.readMcpProviderSession(turnInput.threadId);
            const turnStartParams = yield* buildCodexTurnStartParams({
              nativeThreadId: threadId,
              codexInput,
              runtimePolicy: turnInput.runtimePolicy,
              modelSelection: turnInput.modelSelection,
              hasT3Mcp: mcpSession !== undefined,
              browserToolsAvailable: mcpSession?.browserToolsAvailable ?? true,
              deviceToolsAvailable: mcpSession?.capabilities?.has("device") ?? false,
              omitServiceTier: adapterOptions.resolveRuntime !== undefined,
              ...(turnInput.appContext === undefined ? {} : { appContext: turnInput.appContext }),
            });
            yield* Ref.update(pendingRootTurns, (current) => {
              const updated = new Map(current);
              updated.set(threadId, turnInput);
              return updated;
            });
            yield* Ref.update(additionalContextByThread, (current) => {
              const next = new Map(current);
              if (turnStartParams.additionalContext)
                next.set(threadId, turnStartParams.additionalContext);
              else next.delete(threadId);
              return next;
            });
            const started = yield* client.request("turn/start", turnStartParams);
            yield* registerRootTurn({
              turnInput,
              nativeTurnId: started.turn.id,
              startedAt: codexTimestamp(started.turn.startedAt),
              waitForNativeStart: started.turn.startedAt === null,
            });
          }).pipe(
            Effect.ensuring(
              Effect.flatMap(getNativeThreadId(turnInput.providerThread), (threadId) =>
                Ref.update(pendingRootTurns, (current) => {
                  const updated = new Map(current);
                  updated.delete(threadId);
                  return updated;
                }),
              ).pipe(Effect.ignore),
            ),
          );

        /**
         * Runs `/goal` through Codex's native goal API, as the Codex TUI does.
         * Setting or resuming a goal starts the first goal turn with this run's
         * turn configuration (approvals, sandbox, model, plan mode), since a
         * turn Codex starts on its own reuses the last turn's settings. Codex
         * continues later goal turns itself. Other commands settle with a reply.
         */
        const runGoalCommand = (turnInput: ProviderAdapterV2TurnInput, command: CodexGoalCommand) =>
          Effect.gen(function* () {
            const threadId = yield* getNativeThreadId(turnInput.providerThread);
            // Goal notifications during the command belong to this run's snapshot.
            rootProviderThreads.set(threadId, turnInput.providerThread);
            const readGoal = client
              .request("thread/goal/get", { threadId })
              .pipe(
                Effect.map((response) =>
                  response.goal == null ? null : providerGoalFromCodex(response.goal),
                ),
              );
            const current = yield* readGoal;
            goalsByNativeThread.set(threadId, current);
            if (command.type === "show") {
              return yield* completeGoalCommandTurn(
                turnInput,
                current === null ? "No goal is set." : describeCodexGoal(current),
              );
            }
            if (command.type === "clear") {
              const { cleared } = yield* client.request("thread/goal/clear", { threadId });
              goalsByNativeThread.set(threadId, null);
              return yield* completeGoalCommandTurn(
                turnInput,
                cleared ? "Goal cleared." : "No goal to clear.",
              );
            }
            if (current === null && command.type !== "set") {
              return yield* completeGoalCommandTurn(turnInput, "No goal is set.");
            }
            if (command.type === "pause") {
              const { goal } = yield* client.request("thread/goal/set", {
                threadId,
                status: "paused",
              });
              goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
              return yield* completeGoalCommandTurn(
                turnInput,
                "Goal paused. Send /goal resume to continue.",
              );
            }
            if (command.type === "set") {
              // A new objective replaces the goal and its accounting, like the TUI.
              if (current !== null) yield* client.request("thread/goal/clear", { threadId });
              // Paused until our turn runs, so Codex does not start one first.
              const { goal } = yield* client.request("thread/goal/set", {
                threadId,
                objective: command.objective,
                status: "paused",
              });
              goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
            }
            // Until the goal is active, a fast first turn still holds the run,
            // and Stop cancels the activation.
            const activation = { stopped: false };
            goalActivations.set(threadId, activation);
            yield* Effect.gen(function* () {
              // The first goal turn carries the objective; a resume continues from history.
              yield* startNativeTurn(
                turnInput,
                command.type === "set"
                  ? yield* toCodexInput({
                      ...turnInput,
                      message: { ...turnInput.message, text: command.objective },
                    })
                  : [],
              );
              if (activation.stopped) return;
              const { goal } = yield* client.request("thread/goal/set", {
                threadId,
                status: "active",
              });
              goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
              if (activation.stopped) {
                const paused = yield* client.request("thread/goal/set", {
                  threadId,
                  status: "paused",
                });
                goalsByNativeThread.set(threadId, providerGoalFromCodex(paused.goal));
              }
            }).pipe(
              Effect.ensuring(
                turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    if (goalActivations.get(threadId) === activation) {
                      goalActivations.delete(threadId);
                    }
                    // A run held for an activation that did not happen settles now.
                    if (goalsByNativeThread.get(threadId)?.status !== "active") {
                      yield* releaseGoalHold(threadId);
                    }
                  }),
                ),
              ),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterTurnStartError({
                  driver: CODEX_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          );

        // MCP Apps reach their server through Codex's own MCP client, so any
        // server the user configured for Codex works without T3 connecting to it.
        const mcpAppsError = (detail: string) => (cause: unknown) =>
          new ProviderAdapterProtocolError({ driver: CODEX_PROVIDER, detail, payload: cause });
        const mcpApps: ProviderAdapterV2McpApps = {
          listTools: (toolsInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(toolsInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("mcpServerStatus/list", {
                    threadId,
                    serverName: toolsInput.server,
                    detail: "toolsAndAuthOnly",
                  }),
                ),
              );
              const server = response.data.find((entry) => entry.name === toolsInput.server);
              return Object.values(server?.tools ?? {});
            }).pipe(Effect.mapError(mcpAppsError("Failed to list Codex MCP tools."))),
          callTool: (callInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(callInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("mcpServer/tool/call", {
                    threadId,
                    server: callInput.server,
                    tool: callInput.tool,
                    arguments: callInput.arguments as Schema.Json,
                  }),
                ),
              );
              return {
                content: response.content,
                ...(response.structuredContent === undefined
                  ? {}
                  : { structuredContent: response.structuredContent }),
                ...(response.isError === true ? { isError: true } : {}),
                ...(response._meta === undefined ? {} : { _meta: response._meta }),
              };
            }).pipe(Effect.mapError(mcpAppsError("Codex MCP tool call failed."))),
          readResource: (readInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(readInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("mcpServer/resource/read", {
                    threadId,
                    server: readInput.server,
                    uri: readInput.uri,
                  }),
                ),
              );
              return { contents: response.contents };
            }).pipe(Effect.mapError(mcpAppsError("Codex MCP resource read failed."))),
        };

        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          driver: CODEX_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          canReuseContextUsage: canReuseCodexContextUsage,
          // Known gap: a subagent that Codex resumes later reads as completed
          // (not pending) between turns, so idle release can win the race
          // against a long-delayed resume. Codex emits no resume-expected
          // signal to pin on.
          hasPendingBackgroundWork: Effect.gen(function* () {
            for (const items of (yield* Ref.get(runningCommandItemsByTurn)).values()) {
              if (items.size > 0) {
                return true;
              }
            }
            for (const items of (yield* Ref.get(runningDynamicToolsByTurn)).values()) {
              if (items.size > 0) {
                return true;
              }
            }
            if ((yield* Ref.get(pendingMcpAppCaptures)).size > 0) {
              return true;
            }
            for (const subagent of (yield* Ref.get(subagentThreads)).values()) {
              if (subagent.task.status === "running") {
                return true;
              }
            }
            return false;
          }),
          hasPendingBackgroundWorkForThread: (providerThread) =>
            Effect.gen(function* () {
              const contexts = [
                ...(yield* Ref.get(activeTurns)).values(),
                ...(yield* Ref.get(settledTurns)).values(),
              ];
              const roots = contexts.filter(
                (context) => context.providerThread.id === providerThread.id,
              );
              for (const context of contexts) {
                if (!roots.some((root) => context === root || isDescendantCodexTurn(context, root)))
                  continue;
                if (yield* turnHasRetainedBackgroundWork(context.nativeTurnId)) return true;
                if (
                  context.subagent !== null &&
                  (yield* Ref.get(activeTurns)).has(context.nativeTurnId)
                )
                  return true;
              }
              return false;
            }),
          ensureThread: (threadInput) =>
            ensureInitialized.pipe(
              Effect.andThen(
                client.request(
                  "thread/start",
                  codexThreadRuntimeParams({
                    threadId: threadInput.threadId,
                    modelSelection: threadInput.modelSelection,
                    runtimePolicy: threadInput.runtimePolicy,
                  }),
                ),
              ),
              Effect.map((response): OrchestrationV2ProviderThread =>
                providerThreadFromCodexThread({
                  appThreadId: threadInput.threadId,
                  idAllocator,
                  ownerNodeId: null,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: adapterOptions.instanceId,
                  thread: response.thread,
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterEnsureThreadError({
                    driver: CODEX_PROVIDER,
                    threadId: threadInput.threadId,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          resumeThread: (threadInput) =>
            Effect.gen(function* () {
              const nativeThreadId = yield* getNativeThreadId(threadInput.providerThread);
              // excludeTurns is not in the generated request schema yet.
              const resume = client.raw.request("thread/resume", {
                threadId: nativeThreadId,
                excludeTurns: true,
                ...codexThreadRuntimeParams({
                  threadId: threadInput.threadId ?? threadInput.providerThread.appThreadId,
                  ...(threadInput.modelSelection === undefined
                    ? {}
                    : { modelSelection: threadInput.modelSelection }),
                  ...(threadInput.runtimePolicy === undefined
                    ? {}
                    : { runtimePolicy: threadInput.runtimePolicy }),
                }),
              });
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  resume.pipe(
                    Effect.catchTags({
                      CodexAppServerRequestError: (cause) => {
                        if (
                          !/\bsession \S+ is archived\b|\bcodex unarchive\b/i.test(
                            cause.errorMessage,
                          )
                        ) {
                          return Effect.fail(cause);
                        }
                        // Keep the session's history without decoding the unarchive response.
                        return client.raw
                          .request("thread/unarchive", { threadId: nativeThreadId })
                          .pipe(Effect.andThen(resume));
                      },
                    }),
                  ),
                ),
                Effect.flatMap(decodeCodexResumeMetadata),
              );
              // Codex follows a resume with a goal snapshot notification; the
              // run's first turn writes it if it differs from the stored goal.
              return {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                providerInstanceId: adapterOptions.instanceId,
                status: "idle",
                nativeThreadRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: response.thread.id,
                  strength: "strong",
                },
                nativeConversationHeadRef: threadInput.providerThread.nativeConversationHeadRef,
                updatedAt: codexTimestamp(response.thread.updatedAt),
              } satisfies OrchestrationV2ProviderThread;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterResumeThreadError({
                    driver: CODEX_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: threadInput.providerThread.id,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          compactThread: (turnInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(turnInput.providerThread);
              yield* Ref.update(pendingRootTurns, (current) =>
                new Map(current).set(threadId, turnInput),
              );
              // Cleared on interrupt too, as startTurn does: an interrupted start
              // must not adopt the native turn that a late turn/started reports.
              yield* client.request("thread/compact/start", { threadId }).pipe(
                Effect.onError(() =>
                  Ref.update(pendingRootTurns, (current) => {
                    const next = new Map(current);
                    next.delete(threadId);
                    return next;
                  }),
                ),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: CODEX_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
          injectHistory: (input) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(input.providerThread);
              return yield* client
                .request("thread/inject_items", {
                  threadId,
                  items: historyResponseItems(input.messages, input.context),
                })
                .pipe(
                  Effect.as(true),
                  // Older app servers reject unknown methods before mutating history.
                  // Transport errors and invalid payloads are ambiguous and must not
                  // fall through to a second delivery in the current user message.
                  Effect.catchTags({
                    CodexAppServerRequestError: (error) =>
                      error.code === -32601 ? Effect.succeed(false) : Effect.fail(error),
                  }),
                );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProtocolError({
                    driver: CODEX_PROVIDER,
                    detail: "Failed to inject historical context",
                    cause,
                  }),
              ),
            ),
          startTurn: (turnInput) => {
            const goalCommand =
              turnInput.message.attachments.length === 0 &&
              turnInput.restartContinuationOfRunId === undefined
                ? parseCodexGoalCommand(turnInput.message.text)
                : null;
            if (goalCommand !== null) return runGoalCommand(turnInput, goalCommand);
            return Effect.gen(function* () {
              yield* startNativeTurn(
                turnInput,
                turnInput.restartContinuationOfRunId === undefined
                  ? yield* toCodexInput(turnInput)
                  : [],
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: CODEX_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            );
          },
          steerTurn: (turnInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(turnInput.providerThread);
              // Between goal turns, steer the turn Codex continues with.
              const latestTurnId = latestGoalTurnId(turnInput.providerTurnId);
              const held = heldGoalTurn(turnInput.providerThread, latestTurnId);
              const providerTurnId =
                held === undefined
                  ? latestTurnId
                  : ((yield* Deferred.await(held.hold.next))?.providerTurnId ?? latestTurnId);
              const activeTurn = Array.from((yield* Ref.get(activeTurns)).values()).find(
                (candidate) => candidate.providerTurnId === providerTurnId,
              );
              if (activeTurn === undefined) {
                return yield* toProtocolError(
                  `Provider turn ${turnInput.providerTurnId} is not active and cannot be steered.`,
                );
              }

              const codexInput = yield* toCodexInput(turnInput);
              yield* client.request("turn/steer", {
                expectedTurnId: activeTurn.nativeTurnId,
                input: codexInput,
                threadId,
              });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterSteerRunError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId: turnInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
          // Dropping this connection's subscription lets the shared app-server
          // shut the native thread (and its MCP servers) down once it is idle.
          // `notLoaded` / `notSubscribed` mean there is nothing left to unload.
          unloadThread: (unloadInput) =>
            Effect.gen(function* () {
              const nativeThreadId = yield* getNativeThreadId(unloadInput.providerThread);
              yield* client.request("thread/unsubscribe", { threadId: nativeThreadId });
            }).pipe(
              Effect.mapError((cause) =>
                cause._tag === "ProviderAdapterProtocolError"
                  ? cause
                  : new ProviderAdapterProtocolError({
                      driver: CODEX_PROVIDER,
                      detail: `Failed to unload Codex thread for provider thread ${unloadInput.providerThread.id}`,
                      cause: normalizeCodexCause(cause),
                    }),
              ),
            ),
          interruptTurn: (requestedInput) =>
            Effect.gen(function* () {
              const { turnInput, goalTurns } = yield* resolveGoalStopTarget(requestedInput);
              const [activeTurnContexts, settledTurnContexts] =
                yield* turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    return [
                      Array.from((yield* Ref.get(activeTurns)).values()),
                      Array.from((yield* Ref.get(settledTurns)).values()),
                    ] as const;
                  }),
                );
              const activeTurn =
                activeTurnContexts.find(
                  (candidate) => candidate.providerTurnId === turnInput.providerTurnId,
                ) ??
                (turnInput.requestRuntimeRestart === true
                  ? settledTurnContexts.find(
                      (candidate) => candidate.providerThread.id === turnInput.providerThread.id,
                    )
                  : undefined);
              // A goal run spans several root turns, and work an earlier one
              // started can outlive it.
              const lineageRoots = Array.from(
                new Set([...(activeTurn === undefined ? [] : [activeTurn]), ...goalTurns]),
              );
              const inLineage = (context: ActiveCodexTurnContext) =>
                lineageRoots.some(
                  (root) => context === root || isDescendantCodexTurn(context, root),
                );
              const interruptTargetContexts = [
                ...(activeTurn === undefined ? [] : [activeTurn]),
                ...activeTurnContexts.filter(
                  (candidate) => candidate !== activeTurn && inLineage(candidate),
                ),
                ...settledTurnContexts.filter(
                  (candidate) =>
                    candidate !== activeTurn &&
                    ((turnInput.requestRuntimeRestart === true &&
                      candidate.providerThread.id === turnInput.providerThread.id) ||
                      inLineage(candidate)),
                ),
              ];
              if (interruptTargetContexts.length === 0) {
                // Stop on a settled turn this process retains nothing for
                // (released, restarted, or every command already reported).
                if (turnInput.requestRuntimeRestart === true) return;
                return yield* toProtocolError(
                  `Provider turn ${turnInput.providerTurnId} is not active and cannot be interrupted.`,
                );
              }
              const interruptTargets: Array<{
                readonly context: ActiveCodexTurnContext;
                readonly completion: Deferred.Deferred<void, never>;
              }> = [];
              for (const context of interruptTargetContexts) {
                interruptTargets.push({ context, completion: yield* Deferred.make<void>() });
              }
              yield* Ref.update(turnWaiters, (current) => {
                const updated = new Map(current);
                for (const target of interruptTargets) {
                  updated.set(target.context.nativeTurnId, target.completion);
                }
                return updated;
              });
              yield* Ref.update(interruptingNativeTurns, (current) => {
                const updated = new Set(current);
                for (const target of interruptTargets) {
                  updated.add(target.context.nativeTurnId);
                }
                return updated;
              });
              const registeredActiveTurns = yield* Ref.get(activeTurns);
              for (const target of interruptTargets) {
                if (registeredActiveTurns.get(target.context.nativeTurnId) !== target.context) {
                  yield* Deferred.succeed(target.completion, undefined);
                }
              }

              const cleanupInterruptState = Effect.gen(function* () {
                yield* Ref.update(turnWaiters, (current) => {
                  const updated = new Map(current);
                  for (const target of interruptTargets) {
                    updated.delete(target.context.nativeTurnId);
                  }
                  return updated;
                });
                yield* Ref.update(interruptingNativeTurns, (current) => {
                  const updated = new Set(current);
                  for (const target of interruptTargets) {
                    updated.delete(target.context.nativeTurnId);
                  }
                  return updated;
                });
                yield* Ref.update(runningCommandItemsByTurn, (current) => {
                  const updated = new Map(current);
                  for (const target of interruptTargets) {
                    if (settledTurnContexts.includes(target.context)) continue;
                    updated.delete(target.context.nativeTurnId);
                  }
                  return updated;
                });
              });

              const trackedInterruptNativeTurnIds = new Set(
                interruptTargets.map((target) => target.context.nativeTurnId),
              );
              const finalizeRemainingInterruptLineage = Effect.gen(function* () {
                while (true) {
                  const newlyDiscovered: Array<ActiveCodexTurnContext> = [];
                  const activeLineage = yield* turnTerminalizationPermit.withPermits(1)(
                    Effect.gen(function* () {
                      const lineage = Array.from((yield* Ref.get(activeTurns)).values()).filter(
                        inLineage,
                      );
                      for (const context of lineage) {
                        if (trackedInterruptNativeTurnIds.has(context.nativeTurnId)) {
                          continue;
                        }
                        const completion = yield* Deferred.make<void>();
                        interruptTargets.push({ context, completion });
                        trackedInterruptNativeTurnIds.add(context.nativeTurnId);
                        newlyDiscovered.push(context);
                        yield* Ref.update(turnWaiters, (current) => {
                          const updated = new Map(current);
                          updated.set(context.nativeTurnId, completion);
                          return updated;
                        });
                        yield* Ref.update(interruptingNativeTurns, (current) => {
                          const updated = new Set(current);
                          updated.add(context.nativeTurnId);
                          return updated;
                        });
                      }
                      return lineage;
                    }),
                  );
                  if (activeLineage.length === 0) {
                    return;
                  }
                  if (newlyDiscovered.length > 0) {
                    const completed = yield* Effect.forEach(
                      newlyDiscovered,
                      (context) =>
                        Effect.flatMap(getNativeThreadId(context.providerThread), (threadId) =>
                          client.request("turn/interrupt", {
                            threadId,
                            turnId: context.nativeTurnId,
                          }),
                        ).pipe(
                          Effect.catch((cause) =>
                            Effect.logWarning(
                              "orchestration-v2.codex-remaining-lineage-interrupt-failed",
                              {
                                nativeTurnId: context.nativeTurnId,
                                providerSessionId: input.providerSessionId,
                                cause,
                              },
                            ),
                          ),
                        ),
                      { concurrency: "unbounded", discard: true },
                    ).pipe(Effect.timeoutOption("10 seconds"));
                    if (Option.isNone(completed)) {
                      yield* Effect.logWarning(
                        "orchestration-v2.codex-remaining-lineage-interrupt-timeout",
                        {
                          nativeTurnIds: newlyDiscovered.map((context) => context.nativeTurnId),
                          providerSessionId: input.providerSessionId,
                        },
                      );
                    }
                  }
                  const completedAt = yield* DateTime.now;
                  for (const context of activeLineage) {
                    yield* finalizeCodexTurn({
                      context,
                      nativeTurnId: context.nativeTurnId,
                      status: "interrupted",
                      completedAt,
                    });
                  }
                }
              });

              const interruptLateDescendants = Effect.gen(function* () {
                const activeLineage = yield* turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    const lineage = Array.from((yield* Ref.get(activeTurns)).values()).filter(
                      (context) =>
                        !lineageRoots.includes(context) &&
                        inLineage(context) &&
                        !trackedInterruptNativeTurnIds.has(context.nativeTurnId),
                    );
                    for (const context of lineage) {
                      const completion = yield* Deferred.make<void>();
                      interruptTargets.push({ context, completion });
                      trackedInterruptNativeTurnIds.add(context.nativeTurnId);
                      yield* Ref.update(turnWaiters, (current) => {
                        const updated = new Map(current);
                        updated.set(context.nativeTurnId, completion);
                        return updated;
                      });
                      yield* Ref.update(interruptingNativeTurns, (current) => {
                        const updated = new Set(current);
                        updated.add(context.nativeTurnId);
                        return updated;
                      });
                    }
                    return lineage;
                  }),
                );
                const completed = yield* Effect.forEach(
                  activeLineage,
                  (context) =>
                    Effect.flatMap(getNativeThreadId(context.providerThread), (threadId) =>
                      client.request("turn/interrupt", {
                        threadId,
                        turnId: context.nativeTurnId,
                      }),
                    ),
                  { concurrency: "unbounded", discard: true },
                ).pipe(Effect.timeoutOption("10 seconds"));
                if (Option.isNone(completed)) {
                  yield* Effect.logWarning(
                    "orchestration-v2.codex-late-descendant-interrupt-timeout",
                    {
                      nativeTurnIds: activeLineage.map((context) => context.nativeTurnId),
                      providerSessionId: input.providerSessionId,
                    },
                  );
                }
              });

              yield* Effect.gen(function* () {
                for (const target of interruptTargets) {
                  const context = target.context;
                  // A null start timestamp acknowledges a queued turn; Codex cannot interrupt it
                  // until turn/started confirms that the native task exists.
                  if (context.nativeStartReady !== undefined) {
                    const ready = yield* Deferred.await(context.nativeStartReady).pipe(
                      Effect.timeoutOption("10 seconds"),
                    );
                    if (Option.isNone(ready)) {
                      return yield* toProtocolError(
                        "Codex did not start the queued turn within 10 seconds; Stop could not be delivered.",
                      );
                    }
                  }
                  if ((yield* Ref.get(activeTurns)).get(context.nativeTurnId) !== context) {
                    continue;
                  }
                  yield* client.request("turn/interrupt", {
                    threadId: yield* getNativeThreadId(context.providerThread),
                    turnId: context.nativeTurnId,
                  });
                }
                const containedTerminalKeys = new Set<string>();
                const attemptedTerminalKeys = new Set<string>();
                const collectTrackedTerminals = (targets: typeof interruptTargets) =>
                  Effect.gen(function* () {
                    const trackedTerminals = new Map<
                      string,
                      { readonly nativeThreadId: string; readonly processId: string }
                    >();
                    const runningItems = yield* Ref.get(runningCommandItemsByTurn);
                    for (const target of targets) {
                      const nativeThreadId = yield* getNativeThreadId(
                        target.context.providerThread,
                      );
                      const items = runningItems.get(target.context.nativeTurnId);
                      for (const item of items?.values() ?? []) {
                        if (item.processId !== undefined) {
                          trackedTerminals.set(`${nativeThreadId}:${item.processId}`, {
                            nativeThreadId,
                            processId: item.processId,
                          });
                        }
                      }
                    }
                    return trackedTerminals;
                  });
                const terminateTrackedTerminals = (targets: typeof interruptTargets) =>
                  Effect.gen(function* () {
                    const trackedTerminals = yield* collectTrackedTerminals(targets);
                    const pendingTerminals = Array.from(trackedTerminals.entries())
                      .filter(([key]) => !containedTerminalKeys.has(key))
                      .sort(
                        ([leftKey], [rightKey]) =>
                          Number(attemptedTerminalKeys.has(leftKey)) -
                          Number(attemptedTerminalKeys.has(rightKey)),
                      );
                    return yield* Effect.forEach(
                      pendingTerminals,
                      ([key, { nativeThreadId, processId }]) =>
                        Effect.gen(function* () {
                          attemptedTerminalKeys.add(key);
                          yield* terminateBackgroundTerminal(nativeThreadId, processId);
                          containedTerminalKeys.add(key);
                        }).pipe(
                          Effect.as({ success: true as const }),
                          Effect.catch((error) =>
                            Effect.succeed({ success: false as const, error }),
                          ),
                        ),
                    );
                  });

                const [, completed] = yield* Effect.all(
                  [
                    terminateTrackedTerminals(interruptTargets),
                    Effect.forEach(
                      interruptTargets,
                      (target) => Deferred.await(target.completion),
                      { concurrency: "unbounded", discard: true },
                    ).pipe(Effect.timeoutOption("10 seconds")),
                  ],
                  { concurrency: "unbounded" },
                );
                if (Option.isNone(completed)) {
                  for (const target of interruptTargets) {
                    const context = target.context;
                    if ((yield* Ref.get(activeTurns)).get(context.nativeTurnId) !== context) {
                      continue;
                    }
                    yield* Effect.logWarning("orchestration-v2.codex-interrupt-timeout", {
                      providerSessionId: input.providerSessionId,
                      providerThreadId: context.providerThread.id,
                      providerTurnId: context.providerTurnId,
                      nativeTurnId: context.nativeTurnId,
                    });
                  }
                }

                yield* interruptLateDescendants;
                yield* finalizeRemainingInterruptLineage;

                const terminationResults = yield* terminateTrackedTerminals(interruptTargets);
                const failedTermination = terminationResults.find((result) => !result.success);
                if (failedTermination !== undefined && !failedTermination.success) {
                  return yield* Effect.fail(failedTermination.error);
                }
                // Stop the retained items without rewriting the completed root turn.
                yield* turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    const completedAt = yield* DateTime.now;
                    for (const target of interruptTargets) {
                      const context = target.context;
                      if ((yield* Ref.get(settledTurns)).get(context.nativeTurnId) !== context)
                        continue;
                      yield* terminalizeRunningCommandItems(
                        context,
                        context.nativeTurnId,
                        "interrupted",
                        completedAt,
                      );
                      yield* terminalizeRunningDynamicTools(
                        context,
                        context.nativeTurnId,
                        "interrupted",
                        completedAt,
                        true,
                      );
                      yield* terminalizeMcpAppCaptures(context, context.nativeTurnId);
                      yield* Ref.update(runningCommandItemsByTurn, (current) => {
                        const updated = new Map(current);
                        updated.delete(context.nativeTurnId);
                        return updated;
                      });
                      yield* releaseSettledTurnIfIdle(context.nativeTurnId);
                    }
                  }),
                );
              }).pipe(
                Effect.onError(() => finalizeRemainingInterruptLineage),
                Effect.ensuring(cleanupInterruptState),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: requestedInput.providerThread.id,
                    providerTurnId: requestedInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.gen(function* () {
              const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
                String(requestInput.requestId),
              );
              if (pending === undefined) {
                return yield* new ProviderAdapterRuntimeRequestResponseError({
                  driver: CODEX_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: toProtocolError(
                    `No pending Codex runtime request ${requestInput.requestId}.`,
                  ),
                });
              }
              if (pending.type === "user_input") {
                if (requestInput.answers === undefined) {
                  return yield* new ProviderAdapterRuntimeRequestResponseError({
                    driver: CODEX_PROVIDER,
                    requestId: requestInput.requestId,
                    cause: toProtocolError(
                      `Codex user input request ${requestInput.requestId} requires answers.`,
                    ),
                  });
                }
                yield* Deferred.succeed(pending.answers, requestInput.answers);
                return;
              }
              if (requestInput.decision === undefined) {
                return yield* new ProviderAdapterRuntimeRequestResponseError({
                  driver: CODEX_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: toProtocolError(
                    `Codex ${pending.requestKind} request ${requestInput.requestId} requires an approval decision.`,
                  ),
                });
              }
              yield* Deferred.succeed(pending.decision, requestInput.decision);
            }).pipe(
              Effect.mapError((cause) =>
                isProviderAdapterRuntimeRequestResponseError(cause)
                  ? cause
                  : new ProviderAdapterRuntimeRequestResponseError({
                      driver: CODEX_PROVIDER,
                      requestId: requestInput.requestId,
                      cause,
                    }),
              ),
            ),
          uploadFeedback: (feedbackInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(feedbackInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("feedback/upload", {
                    classification: "bug",
                    includeLogs: true,
                    ...(feedbackInput.reason ? { reason: feedbackInput.reason } : {}),
                    threadId,
                  }),
                ),
              );
              return { feedbackId: response.threadId };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProtocolError({
                    driver: CODEX_PROVIDER,
                    detail: "Failed to upload Codex thread feedback.",
                    payload: cause,
                  }),
              ),
            ),
          mcpApps,
          readThreadSnapshot: (threadInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(threadInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(client.request("thread/read", { threadId, includeTurns: true })),
              );
              return {
                providerThread: {
                  ...threadInput.providerThread,
                  nativeThreadRef: {
                    driver: CODEX_PROVIDER,
                    nativeId: response.thread.id,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef: threadInput.providerThread.nativeConversationHeadRef,
                  updatedAt: codexTimestamp(response.thread.updatedAt),
                },
                providerTurns: [],
                messages: [],
                runtimeRequests: [],
                providerPayload: response.thread,
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterReadThreadSnapshotError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          rollbackThread: (threadInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(threadInput.providerThread);
              const numTurns = yield* resolveCodexRollbackTurnCount(threadInput);
              const nativeConversationHeadRef =
                threadInput.target.type === "provider_turn"
                  ? threadInput.target.providerTurn.nativeTurnRef
                  : null;
              if (numTurns === 0) {
                return {
                  providerThread: {
                    ...threadInput.providerThread,
                    nativeConversationHeadRef,
                    status: "idle" as const,
                  },
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                };
              }
              // Codex 0.156 can revert paginated history at a turn boundary.
              // Legacy history no longer has a rollback endpoint.
              const { historyMode, loaded } = yield* ensureInitialized.pipe(
                Effect.andThen(readCodexThreadHistoryMetadata(client.raw, threadId)),
              );
              if (historyMode !== "paginated") {
                return yield* new ProviderAdapterRollbackThreadError({
                  driver: CODEX_PROVIDER,
                  providerThreadId: threadInput.providerThread.id,
                  cause: `Cannot roll back Codex thread ${threadId}: the thread uses legacy history, which Codex 0.156 cannot revert.`,
                });
              }
              // `thread/revert` only acts on a thread loaded in this app-server
              // process. After a restart or idle release, load it the same way
              // the next turn would before reverting.
              if (!loaded) {
                yield* client.raw.request("thread/resume", {
                  threadId,
                  excludeTurns: true,
                  ...codexThreadRuntimeParams({
                    threadId: threadInput.providerThread.appThreadId,
                    modelSelection: input.modelSelection,
                    runtimePolicy: input.runtimePolicy,
                  }),
                });
              }
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(revertCodexThread(client, threadId, numTurns)),
              );
              turnTokenUsageByThread.delete(threadId);
              return {
                providerThread: {
                  ...threadInput.providerThread,
                  nativeThreadRef: {
                    driver: CODEX_PROVIDER,
                    nativeId: response.thread.id,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef,
                  status: "idle" as const,
                  updatedAt: codexTimestamp(response.thread.updatedAt),
                },
                providerTurns: [],
                messages: [],
                runtimeRequests: [],
                providerPayload: response.thread,
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRollbackThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.providerThread.id,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          forkThread: (threadInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(threadInput.sourceProviderThread);
              const boundary = yield* resolveCodexForkBoundary(threadInput);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("thread/fork", {
                    threadId,
                    ...(boundary.lastTurnId === undefined
                      ? {}
                      : { lastTurnId: boundary.lastTurnId }),
                    ...codexThreadRuntimeParams({
                      threadId: threadInput.targetThreadId,
                      ...(threadInput.modelSelection === undefined
                        ? {}
                        : { modelSelection: threadInput.modelSelection }),
                      ...(threadInput.runtimePolicy === undefined
                        ? {}
                        : { runtimePolicy: threadInput.runtimePolicy }),
                    }),
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterForkThreadError({
                      driver: CODEX_PROVIDER,
                      providerThreadId: threadInput.sourceProviderThread.id,
                      cause: normalizeCodexCause(cause),
                    }),
                ),
              );
              let forkedThread = response.thread;
              if (boundary.rollbackTurnCount > 0) {
                // Reached only when the selected source turn has no native
                // turn reference, so the fork had to be taken at head and then
                // trimmed with the paginated history API.
                const { historyMode } = yield* ensureInitialized.pipe(
                  Effect.andThen(readCodexThreadHistoryMetadata(client.raw, response.thread.id)),
                );
                if (historyMode !== "paginated") {
                  return yield* new ProviderAdapterForkThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.sourceProviderThread.id,
                    cause: `Cannot fork Codex thread ${threadId} at provider turn ${threadInput.providerTurnId}: the source turn has no native Codex turn reference, and the forked thread uses legacy history which Codex 0.156 cannot revert.`,
                  });
                }
                forkedThread = (yield* ensureInitialized.pipe(
                  Effect.andThen(
                    revertCodexThread(client, response.thread.id, boundary.rollbackTurnCount),
                  ),
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterForkThreadError({
                        driver: CODEX_PROVIDER,
                        providerThreadId: threadInput.sourceProviderThread.id,
                        cause: normalizeCodexCause(cause),
                      }),
                  ),
                )).thread;
              }
              return providerThreadFromCodexThread({
                appThreadId: threadInput.targetThreadId,
                idAllocator,
                ownerNodeId: threadInput.ownerNodeId ?? null,
                providerSessionId: input.providerSessionId,
                providerInstanceId: adapterOptions.instanceId,
                thread: forkedThread,
                forkedFrom: {
                  providerThreadId: threadInput.sourceProviderThread.id,
                  ...(threadInput.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: threadInput.providerTurnId }),
                },
              });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterForkThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.sourceProviderThread.id,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
        };
        return runtime;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterOpenSessionError({
              driver: CODEX_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  });
}
