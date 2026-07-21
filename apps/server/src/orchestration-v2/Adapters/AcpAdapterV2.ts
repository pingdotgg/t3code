import {
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRequestKind,
  type ProviderThreadId,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionUpdateEvent,
  type AcpPlanUpdate,
  type AcpToolCallState,
} from "../../provider/acp/AcpRuntimeModel.ts";
import type {
  AcpSessionRuntimeOptions,
  AcpSessionRuntimeStartResult,
} from "../../provider/acp/AcpSessionRuntime.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { t3OrchestrationPromptForFirstRun } from "../../provider/T3OrchestrationInstructions.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import { type ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { acpSelectionTransition } from "../ProviderSelectionTransition.ts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "../SubagentProjection.ts";
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
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2EnsureThreadInput,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";

export const ACP_PROTOCOL = "acp.ndjson-jsonrpc" as const;

export interface AcpAdapterV2RuntimeInput {
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly interruptPromptOnCancel?: boolean;
  readonly clientCapabilities: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: AcpSessionRuntimeOptions["clientInfo"];
  readonly requestLogger?: NonNullable<AcpSessionRuntimeOptions["requestLogger"]>;
  readonly protocolLogging: NonNullable<AcpSessionRuntimeOptions["protocolLogging"]>;
  readonly onIncomingRequest?: AcpSessionRuntimeOptions["onIncomingRequest"];
  readonly onTermination: NonNullable<AcpSessionRuntimeOptions["onTermination"]>;
  readonly onOutgoingResponseFailure?: AcpSessionRuntimeOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: AcpSessionRuntimeOptions["onOutgoingResponse"];
}

export type AcpAdapterV2NativeLogging = Pick<
  AcpSessionRuntimeOptions,
  "requestLogger" | "protocolLogging"
>;

export interface AcpAdapterV2UserInputRequest {
  readonly nativeItemId: string;
  readonly nativeMethod?: string;
  readonly nativeRequestId: string;
  readonly nativeSessionId?: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}

export interface AcpAdapterV2ExtensionContext {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  /**
   * Session-scoped background-task lifecycle reported via extension
   * notifications (e.g. Grok `x.ai/task_backgrounded`; older builds use the
   * underscore alias). Mutations for non-root sessions are ignored.
   */
  readonly applyBackgroundTaskMutation: (mutation: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
  }) => Effect.Effect<void>;
  readonly requestUserInput: (input: AcpAdapterV2UserInputRequest) => Effect.Effect<
    {
      readonly acknowledgeNativeResponse: Effect.Effect<void, EffectAcpErrors.AcpError>;
      readonly answers: ProviderUserInputAnswers | null;
    },
    EffectAcpErrors.AcpError
  >;
}

export interface AcpRootTurnIdleSnapshot {
  readonly finalized: boolean;
  readonly interrupted: boolean;
  readonly assistantStreamOpen: boolean;
  readonly reasoningStreamOpen: boolean;
  readonly hasRunningTool: boolean;
  readonly hasPendingRuntimeRequest: boolean;
  readonly hasToolHistory: boolean;
  readonly hasRunningSubagent: boolean;
  readonly hasOutput: boolean;
}

/**
 * Debounce used if a flavor re-enables speculative idle settlement.
 * Kept for tests and future root-matched recovery; Grok no longer idle-settles.
 */
export const acpRootTurnSettleDebounceMs = 2_000;

/** Let trailing root session chunks land before terminalizing a settled turn. */
export const acpRootTurnCompletionDrainMs = 100;

/**
 * True when root-session streaming is quiescent enough for speculative settle.
 *
 * Always false today: settling on "assistant text then quiet" over-settles Grok
 * preamble-before-tools turns, and settling after tools drops later tool waves
 * while `session/prompt` is still open. Terminalize from the prompt RPC (or a
 * future root-matched completion signal), not from local silence.
 */
export function acpRootTurnIsIdle(snapshot: AcpRootTurnIdleSnapshot): boolean {
  if (snapshot.finalized || snapshot.interrupted) return false;
  if (snapshot.assistantStreamOpen || snapshot.reasoningStreamOpen) return false;
  if (snapshot.hasRunningTool || snapshot.hasPendingRuntimeRequest) return false;
  if (snapshot.hasRunningSubagent) return false;
  if (!snapshot.hasOutput) return false;
  // Structural gates above stay for unit tests / future re-enable. Speculative
  // idle completion is intentionally disabled.
  return false;
}

/** True when idle settle should be (re-)scheduled after pending runtime work clears. */
export function acpRootTurnShouldRearmRecoveryTimers(context: {
  readonly finalized: boolean;
  readonly interrupted: boolean;
}): boolean {
  return !context.finalized && !context.interrupted;
}

export interface AcpAdapterV2Flavor {
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly makeRuntime: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly resolveModelId?: (selection: ModelSelection) => string | undefined;
  readonly registerExtensions?: (
    context: AcpAdapterV2ExtensionContext,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly extractSubagentUpdate?: (
    toolCall: AcpToolCallState,
  ) => AcpAdapterV2SubagentUpdate | undefined;
  /**
   * Optional Grok-style rewrite before tool projection (e.g. keep monitor start
   * ACKs in the running state until stream end).
   */
  readonly normalizeToolCall?: (toolCall: AcpToolCallState) => AcpToolCallState;
  /**
   * Optional mapping from a long-lived background tool start ACK to a task id
   * (e.g. monitor task uuid) so later synthetic text events can update it.
   */
  readonly extractBackgroundTaskId?: (toolCall: AcpToolCallState) => string | undefined;
  /**
   * Optional parse of root-session synthetic text (monitor-event lines, monitor
   * ended reminders). Returns every task mutation in the chunk so coalesced
   * progress / end notices are not dropped.
   */
  readonly extractBackgroundToolMutation?: (text: string) => ReadonlyArray<{
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly appendOutput: string;
  }>;
  /**
   * Optional parse of root-session synthetic text announcing a background
   * subagent's end ("Background subagent "<uuid>" ... completed successfully").
   * Older builds may never hydrate via get_command_or_subagent_output, so this
   * remains a terminal fallback. Current Grok additionally emits structured
   * `subagent_finished` session notifications.
   */
  readonly extractSubagentEndNotice?: (text: string) =>
    | {
        readonly childSessionId: string;
        readonly status: "completed" | "failed";
      }
    | undefined;
  /**
   * Optional hydration when a later tool (e.g. get_command TaskOutput) completes
   * previously registered background task id(s).
   */
  readonly extractBackgroundTaskCompletion?: (toolCall: AcpToolCallState) => ReadonlyArray<{
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly appendOutput: string;
  }>;
  /**
   * Persistent monitors (e.g. Grok `persistent: true`) should not hold root-turn
   * deferred finalize open forever. Still tracked for post-settle wake.
   */
  readonly isPersistentBackgroundTool?: (toolCall: AcpToolCallState) => boolean;
  /**
   * When true, keep the active turn open after session/prompt returns while
   * background tools/subagents are still running so later monitor/wake traffic
   * can project (Grok monitors finish after the root prompt settles).
   */
  readonly deferFinalizeForBackgroundWork?: boolean;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * When true, schedule speculative local settlement after root session
   * quiet. Disabled for Grok: short idle windows over-settle preamble-before-
   * tools turns and `session/cancel` from that path freezes projection while
   * the agent keeps working. Prefer `session/prompt` return (or a future
   * root-matched terminal signal).
   */
  readonly settleRootTurnWhenIdle?: boolean;
  /** Interrupt the local prompt fiber before `session/cancel` (Grok wedged prompts). */
  readonly interruptPromptOnCancel?: boolean;
  /**
   * Kill and respawn the ACP child process before the next `session/prompt` after a
   * user interrupt. Grok can keep `task_already_running` state until the process exits.
   */
  readonly restartRuntimeAfterInterrupt?: boolean;
  /**
   * When true, every interrupt restarts the runtime, not just those carrying
   * `requestRuntimeRestart` (user Stop). Leave unset to keep non-Stop
   * interrupts (steering, restart_active) soft: `session/cancel` plus session
   * reuse in the same process.
   */
  readonly restartRuntimeOnEveryInterrupt?: boolean;
  readonly terminateRuntimeProcessGroupOnInterrupt?: boolean;
  /**
   * When true, an interrupt without `requestRuntimeRestart` (steering restart)
   * on a turn whose native prompt already settled skips the hard process-group
   * kill, the ACP cancel, and the runtime respawn entirely: the turn
   * terminalizes locally while background subagents keep running in the same
   * process and carry over into the replacement turn. Verified against the
   * real Grok CLI (tmp/grok-acp-experiments E1): a new session/prompt is
   * accepted concurrently while a fire-and-forget subagent is still running,
   * with no task_already_running. User Stop (`requestRuntimeRestart: true`)
   * keeps the hard teardown; mid-prompt non-Stop interrupts go soft
   * (`session/cancel` plus same-session re-prompt) unless
   * `restartRuntimeOnEveryInterrupt` is set.
   */
  readonly preserveRuntimeOnSettledInterrupt?: boolean;
  /**
   * When true (with continuationRequests), post-settle root session/update traffic
   * buffers and requests a provider continuation run instead of being dropped or
   * only appended to loaded history.
   */
  readonly enablePostSettleContinuation?: boolean;
  /**
   * When true, send image attachment content blocks even if the ACP agent
   * advertises `promptCapabilities.image: false`. Grok CLI currently accepts
   * and vision-processes image blocks while still reporting the capability as
   * false; without this override, screenshot turns fail before `session/prompt`.
   */
  readonly supportsImagePrompts?: boolean;
}

/** Whether image attachment blocks may be included in session/prompt. */
export function acpSupportsImagePrompts(input: {
  readonly flavorSupportsImagePrompts?: boolean | undefined;
  readonly negotiatedImage?: boolean | undefined;
}): boolean {
  return input.flavorSupportsImagePrompts === true || input.negotiatedImage === true;
}

export interface AcpAdapterV2SubagentUpdate {
  readonly nativeTaskId: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly status: "running" | "completed" | "failed" | "interrupted" | "cancelled";
  readonly childSessionId: string | null;
  readonly result: string | null;
  /**
   * When false, still project a normal tool turn item after the subagent update
   * (hydration tools like get_command_or_subagent_output). Defaults to true.
   */
  readonly suppressNormalTool?: boolean;
}

export interface AcpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly flavor: AcpAdapterV2Flavor;
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly serverConfig: ServerConfig["Service"];
  readonly nativeLogging?: (threadId: ThreadId) => AcpAdapterV2NativeLogging;
  /**
   * Shared with ProviderContinuationService so post-settle wake traffic can start
   * a continuation run. Optional: adapters that omit it keep pre-continuation drop
   * / history-only behavior for null-activeTurn updates.
   */
  readonly continuationRequests?: {
    readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  };
  readonly testHooks?: {
    readonly afterNativeResponseTransportClosed?: () => Effect.Effect<void>;
    readonly afterHardTeardownTransportDrained?: () => Effect.Effect<void>;
    readonly beforeNativeResponseAdmissionCheck?: (
      generation: number,
      requestId: string,
    ) => Effect.Effect<void>;
    readonly onNativeResponseLifecycle?: (event: {
      readonly generation?: number;
      readonly requestId?: string;
      readonly type:
        | "admission_rejected"
        | "failed"
        | "late_noop"
        | "registered"
        | "removed"
        | "timer_exited"
        | "timer_started"
        | "watcher_exited"
        | "watcher_started";
    }) => Effect.Effect<void>;
  };
}

export const AcpProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
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
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

function negotiatedCapabilities(
  base: OrchestrationV2ProviderCapabilities,
  started: AcpSessionRuntimeStartResult,
): OrchestrationV2ProviderCapabilities {
  const agent = started.initializeResult.agentCapabilities ?? {};
  const session = agent.sessionCapabilities;
  const setup = started.sessionSetupResult;
  const hasModelConfig =
    setup.configOptions?.some((option) => option.category === "model") === true;
  const hasModeConfig = setup.configOptions?.some((option) => option.category === "mode") === true;
  const supportsMcp = agent.mcpCapabilities?.http === true || agent.mcpCapabilities?.sse === true;
  const canLoad = agent.loadSession === true;
  const canFork = session?.fork != null;
  return {
    ...base,
    sessions: {
      ...base.sessions,
      supportsModelSwitchInSession: setup.models != null || hasModelConfig,
      supportsRuntimeModeSwitchInSession: setup.modes != null || hasModeConfig,
    },
    threads: {
      ...base.threads,
      canReadThreadSnapshot: canLoad,
      canForkThread: canFork,
      canForkFromTurn: false,
    },
    tools: {
      ...base.tools,
      supportsMcpTools: supportsMcp,
    },
    checkpointing: {
      ...base.checkpointing,
      providerCanReadConversationSnapshot: canLoad,
    },
  };
}

function acpMcpServers(threadId: ThreadId | null): ReadonlyArray<EffectAcpSchema.McpServer> {
  if (threadId === null) return [];
  const session = McpProviderSession.readMcpProviderSession(threadId);
  if (session === undefined) {
    return [];
  }
  return [
    {
      type: "http",
      name: "t3-code",
      url: session.endpoint,
      headers: [
        {
          name: "Authorization",
          value: session.authorizationHeader,
        },
      ],
    },
  ];
}

function nativeThreadId(driver: ProviderDriverKind, thread: OrchestrationV2ProviderThread): string {
  const id = thread.nativeThreadRef?.nativeId;
  if (id === null || id === undefined || id.trim().length === 0) {
    throw new ProviderAdapterProtocolError({
      driver,
      detail: `Provider thread ${thread.id} is missing its ACP session id`,
    });
  }
  return id;
}

function makeProviderThread(input: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: input.driver,
      nativeThreadId: input.nativeThreadId,
    }),
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: input.driver,
      nativeId: input.nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function acpCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(acpCanonicalJson).join(",")}]`;
  }
  const record = unknownRecord(value);
  if (record !== undefined) {
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${acpCanonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function acpNativeUserInputRequestMatches(
  request: Pick<
    AcpAdapterV2UserInputRequest,
    "nativeMethod" | "nativeRequestId" | "nativeSessionId"
  >,
  transport: { readonly method: string; readonly payload: unknown },
): boolean {
  if (
    request.nativeMethod === undefined ||
    request.nativeMethod.trim().length === 0 ||
    request.nativeRequestId.trim().length === 0 ||
    request.nativeSessionId === undefined ||
    request.nativeSessionId.trim().length === 0
  ) {
    return false;
  }
  if (
    transport.method !== "x.ai/ask_user_question" &&
    transport.method !== "_x.ai/ask_user_question"
  ) {
    return false;
  }
  if (transport.method !== request.nativeMethod) {
    return false;
  }
  const payloadRecord = unknownRecord(transport.payload);
  const paramsRecord = unknownRecord(payloadRecord?.params) ?? payloadRecord;
  return (
    paramsRecord?.toolCallId !== undefined &&
    String(paramsRecord.toolCallId).trim().length > 0 &&
    String(paramsRecord.toolCallId) === request.nativeRequestId &&
    paramsRecord.sessionId !== undefined &&
    String(paramsRecord.sessionId).trim().length > 0 &&
    String(paramsRecord.sessionId) === request.nativeSessionId
  );
}

export function acpClaimNativeTransportRequest<
  T extends {
    readonly generation: number;
    readonly requestId: string;
    readonly sequence: number;
  },
>(
  requests: ReadonlyArray<T>,
  generation: number,
  predicate: (request: T) => boolean,
): readonly [string | undefined, Array<T>] {
  let claimedIndex = -1;
  let claimedSequence = Number.POSITIVE_INFINITY;
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    if (
      request.generation === generation &&
      request.sequence < claimedSequence &&
      predicate(request)
    ) {
      claimedIndex = index;
      claimedSequence = request.sequence;
    }
  }
  if (claimedIndex < 0) return [undefined, [...requests]];
  return [
    requests[claimedIndex]!.requestId,
    [...requests.slice(0, claimedIndex), ...requests.slice(claimedIndex + 1)],
  ];
}

function nonEmptyText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function decodeByteText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((entry) => typeof entry === "number" && Number.isInteger(entry))) {
    return undefined;
  }
  try {
    // Preserve leading/trailing whitespace like the string path in textFromUnknown.
    const text = new TextDecoder().decode(Uint8Array.from(value as number[]));
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const fromBytes = decodeByteText(value);
  if (fromBytes !== undefined) {
    return fromBytes;
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      const text = textFromUnknown(entry);
      return text === undefined || text.length === 0 ? [] : [text];
    });
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  const record = unknownRecord(value);
  if (record === undefined) {
    return undefined;
  }
  // Prefer prompt-facing Grok fields before nested envelopes.
  for (const key of [
    "output_for_prompt",
    "stdout",
    "stderr",
    "output",
    "content",
    "text",
    "message",
  ]) {
    const direct = record[key];
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }
    const decoded = decodeByteText(direct);
    if (decoded !== undefined) {
      return decoded;
    }
    const text = textFromUnknown(direct);
    if (text !== undefined && text.length > 0) {
      return text;
    }
  }
  const result = unknownRecord(record.Result) ?? unknownRecord(record.result);
  if (result !== undefined) {
    return textFromUnknown(result);
  }
  return undefined;
}

function commandExitCode(value: unknown): number | undefined {
  const record = unknownRecord(value);
  for (const key of ["exitCode", "exit_code", "code"]) {
    const candidate = record?.[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Project an exit code only when the tool has a terminal native status.
 * Mid-stream Grok Bash re-reports carry exit_code 0 while still in progress;
 * interrupted tools must not retain that stale success code.
 */
export function acpProjectedCommandExitCode(
  status: "pending" | "running" | "completed" | "failed" | "interrupted",
  rawOutput: unknown,
): number | undefined {
  if (status !== "completed" && status !== "failed") {
    return undefined;
  }
  return commandExitCode(rawOutput);
}

function pathFromToolCall(toolCall: AcpToolCallState): string | undefined {
  const locations = toolCall.data.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = unknownRecord(location)?.path;
      if (typeof path === "string" && path.trim().length > 0) {
        return path.trim();
      }
    }
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  for (const key of ["path", "filePath", "file_path", "url", "query", "pattern"]) {
    const candidate = rawInput?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function providerRequestKind(kind: string | "unknown"): ProviderRequestKind {
  switch (kind) {
    case "execute":
      return "command";
    case "read":
    case "search":
    case "fetch":
      return "file-read";
    case "edit":
    case "delete":
    case "move":
      return "file-change";
    default:
      return "command";
  }
}

function toolStatus(
  status: AcpToolCallState["status"],
): "pending" | "running" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "running";
  }
}

type ProjectedToolStatus = ReturnType<typeof toolStatus> | "interrupted";

function nodeStatus(status: ProjectedToolStatus): OrchestrationV2ExecutionNode["status"] {
  return status === "pending" ? "running" : status;
}

function completedAtForStatus(status: ProjectedToolStatus, now: DateTime.Utc): DateTime.Utc | null {
  return status === "completed" || status === "failed" || status === "interrupted" ? now : null;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

export type AcpPermissionDisposition = "allow" | "ask" | "deny";

export function acpPermissionDisposition(
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  const approvalPolicy = runtimePolicy.approvalPolicy;
  const requiresApproval =
    approvalPolicy === undefined
      ? runtimePolicy.runtimeMode === "approval-required"
      : approvalPolicy !== "never";
  if (requiresApproval) {
    return "ask";
  }

  const sandboxPolicy = unknownRecord(runtimePolicy.sandboxPolicy);
  const sandboxType = sandboxPolicy?.type;
  const toolKind = request.toolCall.kind ?? "other";
  switch (sandboxType) {
    case "readOnly":
      return toolKind === "read" || toolKind === "search" || toolKind === "think"
        ? "allow"
        : "deny";
    case "workspaceWrite":
      return toolKind === "read" ||
        toolKind === "search" ||
        toolKind === "think" ||
        toolKind === "edit" ||
        toolKind === "delete" ||
        toolKind === "move"
        ? "allow"
        : "deny";
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    case undefined:
      return runtimePolicy.runtimeMode === "approval-required" ? "deny" : "allow";
    default:
      return "deny";
  }
}

function elicitationContent(
  answers: ProviderUserInputAnswers,
  allowedKeys: ReadonlySet<string>,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      content[key] = value;
    } else if (Array.isArray(value)) {
      content[key] = value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return content;
}

interface ActiveTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  text: string;
}

interface ActiveTextStream {
  current: ActiveTextSegment | null;
  nextSegment: number;
}

interface ActiveAcpTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeTurnId: string;
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void, never>;
  readonly assistant: ActiveTextStream;
  readonly reasoning: ActiveTextStream;
  readonly tools: Map<string, AcpToolCallState>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly subagents: Map<string, ActiveAcpSubagent>;
  readonly subagentsBySessionId: Map<string, ActiveAcpSubagent>;
  readonly pendingSubagentNotifications: Map<string, Array<EffectAcpSchema.SessionNotification>>;
  /** Background monitor/task id → toolCallId for synthetic root text updates. */
  readonly toolCallIdsByBackgroundTaskId: Map<string, string>;
  /**
   * Persistent monitors registered this turn. Excluded from deferred-finalize
   * holds so the root turn can settle while they keep streaming post-settle.
   */
  readonly persistentBackgroundTaskIds: Set<string>;
  /**
   * Monitor end events often only say "use get_command…"; keep the turn open
   * until TaskOutput hydration arrives (or the safety timeout elapses).
   */
  readonly awaitingBackgroundHydration: Set<string>;
  /**
   * A monitor end notice landed after the prompt settled: the CLI runs an
   * injected turn whose report never gets a turn_completed marker, so the
   * report chunk races the deferred-finalize debounce (thread a8e8b0a9 run 5
   * dropped the listing this way). Hold finalize until the report streams or
   * the safety timeout elapses.
   */
  readonly pendingInjectedReport: Set<string>;
  plan: {
    readonly id: OrchestrationV2PlanArtifact["id"];
    readonly startedAt: DateTime.Utc;
  } | null;
  interrupted: boolean;
  finalized: boolean;
  settleScheduleGeneration: number;
  /** session/prompt already returned; finalize deferred for background work. */
  promptSettled: boolean;
  promptSettledStatus: "completed" | "interrupted" | "failed" | "cancelled" | null;
  /**
   * Completed the moment `runtime.prompt` resolves on the wire, before the
   * completion callback requests `runtimeCallbackPermit`. Failure does not
   * complete this; settled-soft classification ORs it with `promptSettled`.
   */
  readonly promptWireSettled: Deferred.Deferred<void, never>;
  backgroundFinalizeGeneration: number;
}

type AcpRuntimeTeardownState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "InProgress";
      readonly completed: Deferred.Deferred<void, ProviderAdapterProtocolError>;
    }
  | { readonly _tag: "Failed"; readonly error: ProviderAdapterProtocolError };

export function acpRootTurnHasIngestedOutput(context: {
  readonly assistant: ActiveTextStream;
  readonly reasoning: ActiveTextStream;
  readonly tools: ReadonlyMap<string, AcpToolCallState>;
  readonly plan: unknown;
}): boolean {
  return (
    context.assistant.nextSegment > 0 ||
    context.reasoning.nextSegment > 0 ||
    context.tools.size > 0 ||
    context.plan !== null
  );
}

/** True when a root session/update carries ingestible turn output, not keepalive noise. */
export function acpRootSessionUpdateIngestsOutput(
  notification: EffectAcpSchema.SessionNotification,
): boolean {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return update.content.type === "text" && update.content.text.length > 0;
    case "tool_call":
    case "tool_call_update":
    case "plan":
      return parseSessionUpdateEvent(notification).events.some(
        (event) => event._tag === "ToolCallUpdated" || event._tag === "PlanUpdated",
      );
    default:
      return false;
  }
}

/**
 * Post-settle traffic that should be *buffered* for a continuation attach.
 * Excludes monitor end/event chatter that must not become ghost history.
 * Broader than {@link acpPostSettleContinuationOfferEvidence}: incremental
 * tool progress may still need replay once a real completion offers a run.
 */
export function acpPostSettleWakeEvidence(
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation"> = {},
): boolean {
  if (!acpRootSessionUpdateIngestsOutput(notification)) return false;
  const update = notification.update;
  if (
    (update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_message_chunk") &&
    update.content.type === "text"
  ) {
    const text = update.content.text;
    if ((flavor.extractBackgroundToolMutation?.(text) ?? []).length > 0) return false;
    if (/<monitor-event\b/i.test(text) || /Monitor\s+["']?[0-9a-f-]{8,}["']?\s+ended/i.test(text)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether buffered post-settle traffic should *offer* a continuation run now.
 * Still-running tool streams often land farther apart than the deferred-finalize
 * quiet window; treating every tool_call_update as offer evidence re-opens a
 * synthetic "Background task completed." run on each chunk. Only completion-like
 * frames (real agent text, or a terminal tool status) should open a new run.
 */
export function acpPostSettleContinuationOfferEvidence(
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation" | "normalizeToolCall"> = {},
): boolean {
  if (!acpPostSettleWakeEvidence(notification, flavor)) {
    return false;
  }
  const update = notification.update;
  // Assistant text only. Thought/reasoning bursts alone must not open synthetic
  // "Background task completed." runs (duplicate-run spam after monitors).
  if (update.sessionUpdate === "agent_message_chunk") {
    return update.content.type === "text" && update.content.text.length > 0;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return parseSessionUpdateEvent(notification).events.some((event) => {
      if (event._tag !== "ToolCallUpdated") return false;
      // Normalize first: a Grok monitor start ACK arrives with raw status
      // "completed" but is a still-running background task, not completion.
      const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
      return toolCall.status === "completed" || toolCall.status === "failed";
    });
  }
  return false;
}

export function acpPostSettleWakeShouldBuffer(
  notification: EffectAcpSchema.SessionNotification,
  backgroundWorkRunning: boolean,
): boolean {
  if (!backgroundWorkRunning) return true;
  const update = notification.update;
  return (
    update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk"
  );
}

export function acpPostSettleMonitorPromptShouldSuppress(
  mutation:
    | {
        readonly taskId: string;
        readonly status: "running" | "completed" | "failed";
      }
    | undefined,
): boolean {
  return mutation?.status === "running";
}

export function acpCompletedTurnShouldTerminalizeTool(
  tool: AcpToolCallState,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundTaskId" | "extractSubagentUpdate">,
): boolean {
  const status = toolStatus(tool.status);
  if (status !== "pending" && status !== "running") return false;
  if (flavor.extractBackgroundTaskId?.(tool) !== undefined) return false;
  return flavor.extractSubagentUpdate?.(tool) === undefined;
}

interface ActiveAcpSubagent {
  task: OrchestrationV2Subagent;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  /** Turn that spawned the subagent; carryover updates keep this lineage. */
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly parentProviderThreadId: ProviderThreadId;
  childSessionId: string | null;
  assistantText: string;
  nextChildOrdinal: number;
}

function acpTurnHasPendingRuntimeRequest(
  providerTurnId: OrchestrationV2ProviderTurn["id"],
  pending: ReadonlyMap<string, PendingRuntimeRequest>,
): boolean {
  return [...pending.values()].some(
    (request) =>
      request.runtimeRequest.providerTurnId === providerTurnId &&
      request.runtimeRequest.status === "pending",
  );
}

type PendingRuntimeRequest = {
  readonly generation: number;
  readonly nativeResponseAcknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>;
  readonly transportRequestId: string;
  readonly requestId: RuntimeRequestId;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
} & (
  | {
      readonly type: "approval";
      readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
    }
  | {
      readonly type: "user_input";
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers | null>;
    }
);

interface SnapshotMessageState {
  readonly order: Array<string>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  loadingRole: "user" | "assistant" | null;
  loadingIndex: number;
}

export function makeAcpAdapterV2(options: AcpAdapterV2Options): ProviderAdapterV2Shape {
  const { flavor, fileSystem, idAllocator, serverConfig } = options;
  const driver = flavor.driver;
  const continuationRequests = options.continuationRequests;
  const postSettleContinuationEnabled =
    flavor.enablePostSettleContinuation === true && continuationRequests !== undefined;

  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(flavor.capabilities),
    planSelectionTransition: (input) => Effect.succeed(acpSelectionTransition(input)),
    openSession: Effect.fn("AcpAdapterV2.openSession")(
      function* (input: ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const activeTurn = yield* Ref.make<ActiveAcpTurn | null>(null);
        const activeSessionId = yield* Ref.make<string | null>(null);
        const activeSessionSetup = yield* Ref.make<AcpSessionRuntimeStartResult | null>(null);
        const activeSelection = yield* Ref.make<ModelSelection | null>(null);
        const runtimeRestartRequired = yield* Ref.make(false);
        const runtimeTeardownState = yield* Ref.make<AcpRuntimeTeardownState>({ _tag: "Idle" });
        const runtimeCallbackGeneration = yield* Ref.make(0);
        const runtimeCallbackPermit = yield* Semaphore.make(1);
        const runtimeTransitionPermit = yield* Semaphore.make(1);
        const nativeTransportRequests = yield* Ref.make<
          Array<{
            readonly generation: number;
            readonly method: string;
            readonly payload: unknown;
            readonly requestId: string;
            readonly sequence: number;
          }>
        >([]);
        const nextNativeTransportSequence = yield* Ref.make(0);
        const nativeResponseAcknowledgements = yield* Ref.make(
          new Map<
            string,
            {
              readonly acknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>;
              readonly generation: number;
            }
          >(),
        );
        const pendingRuntimeRequests = yield* Ref.make(new Map<string, PendingRuntimeRequest>());
        const emitNativeResponseLifecycle =
          options.testHooks?.onNativeResponseLifecycle ?? (() => Effect.void);
        const nextElicitationOrdinal = yield* Ref.make(0);
        const itemOrdinals = yield* Ref.make(new Map<string, number>());
        const nextItemOrdinalsByTurn = yield* Ref.make(new Map<string, number>());
        const providerTurns = yield* Ref.make(new Map<string, OrchestrationV2ProviderTurn>());
        const snapshot = yield* Ref.make<SnapshotMessageState>({
          order: [],
          messages: new Map(),
          loadingRole: null,
          loadingIndex: 0,
        });

        const awaitRuntimeTeardown = Effect.fnUntraced(function* () {
          const state = yield* Ref.get(runtimeTeardownState);
          if (state._tag === "InProgress") {
            yield* Deferred.await(state.completed);
          } else if (state._tag === "Failed") {
            return yield* state.error;
          }
        });
        const runRuntimeCallbackAtGeneration = <A, E, R>(
          generation: number,
          effect: Effect.Effect<A, E, R>,
        ) =>
          runtimeCallbackPermit.withPermit(
            Effect.gen(function* () {
              if ((yield* Ref.get(runtimeTeardownState))._tag !== "Idle") {
                return Option.none<A>();
              }
              if ((yield* Ref.get(runtimeCallbackGeneration)) !== generation) {
                return Option.none<A>();
              }
              return Option.some(yield* effect);
            }),
          );
        const claimNativeTransportRequest = (
          generation: number,
          predicate: (request: { readonly method: string; readonly payload: unknown }) => boolean,
        ) =>
          Ref.modify(
            nativeTransportRequests,
            (
              requests,
            ): readonly [
              string | undefined,
              Array<{
                readonly generation: number;
                readonly method: string;
                readonly payload: unknown;
                readonly requestId: string;
                readonly sequence: number;
              }>,
            ] => acpClaimNativeTransportRequest(requests, generation, predicate),
          );
        const registerNativeResponseAcknowledgement = (
          generation: number,
          transportRequestId: string,
          acknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>,
        ) =>
          Effect.gen(function* () {
            yield* Ref.update(nativeResponseAcknowledgements, (current) => {
              const updated = new Map(current);
              updated.set(transportRequestId, { acknowledgement, generation });
              return updated;
            });
            yield* emitNativeResponseLifecycle({
              type: "registered",
              generation,
              requestId: transportRequestId,
            });
            if (!(yield* Deferred.isDone(acknowledgement))) return;
            yield* Ref.update(nativeResponseAcknowledgements, (current) => {
              if (current.get(transportRequestId)?.acknowledgement !== acknowledgement) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(transportRequestId);
              return updated;
            });
          });
        const acknowledgeNativeResponse = (generation: number, transportRequestId: string) =>
          (
            options.testHooks?.beforeNativeResponseAdmissionCheck?.(
              generation,
              transportRequestId,
            ) ?? Effect.void
          ).pipe(
            Effect.andThen(runRuntimeCallbackAtGeneration(generation, Effect.void)),
            Effect.flatMap((registered) =>
              Option.isSome(registered)
                ? Effect.void
                : emitNativeResponseLifecycle({
                    type: "admission_rejected",
                    generation,
                    requestId: transportRequestId,
                  }).pipe(
                    Effect.andThen(
                      new EffectAcpErrors.AcpTransportError({
                        detail: "The ACP runtime closed before its response could be admitted",
                        cause: "Native response registration rejected during teardown",
                      }),
                    ),
                  ),
            ),
          );
        const awaitNativeResponseAcknowledgements = Effect.fnUntraced(function* (
          acknowledgements: ReadonlyArray<
            readonly [string | undefined, Deferred.Deferred<void, EffectAcpErrors.AcpError>]
          >,
        ) {
          if (acknowledgements.length === 0) return true;
          const completed = yield* Deferred.make<"settled" | "timeout">();
          yield* emitNativeResponseLifecycle({ type: "watcher_started" });
          const acknowledgementFiber = yield* Effect.forEach(
            acknowledgements,
            ([, acknowledgement]) => Deferred.await(acknowledgement).pipe(Effect.exit),
            { concurrency: "unbounded", discard: true },
          ).pipe(
            Effect.andThen(Deferred.succeed(completed, "settled")),
            Effect.interruptible,
            Effect.ensuring(emitNativeResponseLifecycle({ type: "watcher_exited" })),
            Effect.forkDetach,
          );
          yield* emitNativeResponseLifecycle({ type: "timer_started" });
          const timerFiber = yield* Effect.sleep("2 seconds").pipe(
            Effect.andThen(Deferred.succeed(completed, "timeout")),
            Effect.interruptible,
            Effect.ensuring(emitNativeResponseLifecycle({ type: "timer_exited" })),
            Effect.forkDetach,
          );
          const outcome = yield* Deferred.await(completed);
          yield* Fiber.interrupt(acknowledgementFiber);
          yield* Fiber.interrupt(timerFiber);
          if (outcome === "settled") return true;

          yield* Ref.update(nativeResponseAcknowledgements, (current) => {
            const updated = new Map(current);
            for (const [requestId, acknowledgement] of acknowledgements) {
              if (
                requestId !== undefined &&
                updated.get(requestId)?.acknowledgement === acknowledgement
              ) {
                updated.delete(requestId);
              }
            }
            return updated;
          });
          yield* Effect.forEach(
            acknowledgements,
            ([requestId]) =>
              emitNativeResponseLifecycle({
                type: "removed",
                ...(requestId === undefined ? {} : { requestId }),
              }),
            { concurrency: "unbounded", discard: true },
          );
          const timeoutError = new EffectAcpErrors.AcpTransportError({
            detail: "Timed out waiting for an admitted ACP response to reach the transport queue",
            cause: "Native response acknowledgement timed out",
          });
          yield* Effect.forEach(
            acknowledgements,
            ([requestId, acknowledgement]) =>
              Deferred.fail(acknowledgement, timeoutError).pipe(
                Effect.andThen(
                  emitNativeResponseLifecycle({
                    type: "failed",
                    ...(requestId === undefined ? {} : { requestId }),
                  }),
                ),
              ),
            { concurrency: "unbounded", discard: true },
          );
          return false;
        });
        const awaitAdmittedNativeResponses = Effect.gen(function* () {
          yield* awaitNativeResponseAcknowledgements(
            [...(yield* Ref.get(nativeResponseAcknowledgements)).entries()].map(
              ([requestId, entry]) => [requestId, entry.acknowledgement] as const,
            ),
          );
        });
        const quarantineNativeTransportAtGeneration = Effect.fnUntraced(function* (
          generation: number,
        ) {
          yield* Ref.update(nativeTransportRequests, (requests) =>
            requests.filter((request) => request.generation !== generation),
          );
          const quarantined = yield* Ref.modify(nativeResponseAcknowledgements, (current) => {
            const updated = new Map(current);
            const acknowledgements: Array<Deferred.Deferred<void, EffectAcpErrors.AcpError>> = [];
            for (const [requestId, entry] of updated) {
              if (entry.generation !== generation) continue;
              updated.delete(requestId);
              acknowledgements.push(entry.acknowledgement);
            }
            return [acknowledgements, updated] as const;
          });
          const error = new EffectAcpErrors.AcpTransportError({
            detail: "The ACP runtime was replaced before its response reached the transport queue",
            cause: "ACP runtime transport was quarantined during teardown",
          });
          yield* Effect.forEach(
            quarantined,
            (acknowledgement) => Deferred.fail(acknowledgement, error),
            { concurrency: "unbounded", discard: true },
          );
        });
        const closeNativeTransport = runtimeCallbackPermit.withPermit(
          Effect.gen(function* () {
            yield* Ref.update(runtimeCallbackGeneration, (generation) => generation + 1);
            yield* Ref.set(nativeTransportRequests, []);
            const acknowledgements = yield* Ref.getAndSet(
              nativeResponseAcknowledgements,
              new Map(),
            );
            const error = new EffectAcpErrors.AcpTransportError({
              detail: "The ACP session closed before its admitted response reached the transport",
              cause: "ACP session transport closed",
            });
            yield* Effect.forEach(
              acknowledgements,
              ([requestId, entry]) =>
                Deferred.fail(entry.acknowledgement, error).pipe(
                  Effect.andThen(
                    emitNativeResponseLifecycle({
                      type: "removed",
                      generation: entry.generation,
                      requestId,
                    }),
                  ),
                  Effect.andThen(
                    emitNativeResponseLifecycle({
                      type: "failed",
                      generation: entry.generation,
                      requestId,
                    }),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            );
            return acknowledgements.size > 0;
          }),
        );
        // Post-settle wake support (Grok async subagent/monitor follow-up). After
        // the root turn finalizes, later root session/update traffic buffers here
        // until a provider continuation run attaches and drains it.
        const lastTurnRoute = yield* Ref.make<{
          readonly threadId: ThreadId;
          readonly providerThreadId: ProviderThreadId;
        } | null>(null);
        const wakeBuffer = yield* Ref.make<Array<EffectAcpSchema.SessionNotification>>([]);
        const continuationRequested = yield* Ref.make(false);
        const continuationGeneration = yield* Ref.make(0);
        const continuationPermit = yield* Semaphore.make(1);
        const continuationClosed = yield* Ref.make(false);
        // Direct Stop (requestRuntimeRestart) quarantines residual events from the
        // stopped run so they cannot wake or attach to a later prompt/run.
        const stoppedRunQuarantine = yield* Ref.make(false);
        // A steering restart (or any interrupt) can finalize a turn while its
        // spawned subagents are still running natively. Carry the live
        // lineages into the next turn on the same session so their terminal
        // signals can still flip the original turn items instead of leaving
        // them running forever.
        const carryoverSubagents = yield* Ref.make<{
          readonly sessionId: string;
          readonly subagents: ReadonlyArray<ActiveAcpSubagent>;
        } | null>(null);
        const handledBackgroundTaskIdsInActiveTurn = yield* Ref.make<ReadonlySet<string>>(
          new Set(),
        );
        // Background tasks that reached a genuine terminal mutation while a root
        // turn was still streaming and were not yet marked handled in-turn. The
        // mid-turn offer is suppressed (active turn owns the work); on finalize
        // these ids re-arm a single continuation when the agent never hydrated
        // or reported them before settle (regression: mid-turn complete + no
        // get_command must still wake after finalize).
        const midTurnUnreportedCompletedTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
        // A monitor-event can arrive after its task and the user-facing provider
        // turn already completed. Grok starts another internal prompt for that
        // stale notification; suppress its agent output until a genuine terminal
        // mutation or the next app turn so it cannot create a redundant app
        // continuation. Tool frames continue through normal hydration.
        const suppressPostSettleMonitorPrompt = yield* Ref.make(false);
        // Background tasks (Grok monitors) known to still run at session level.
        // Turn contexts are too short-lived to carry this: a continuation run
        // finalizes between monitor events, and the next commentary burst must
        // not reopen a run while the monitor is still streaming.
        const runningBackgroundTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
        // Task ids with a GENUINE end signal (monitor-ended reminder or
        // TaskOutput completion). Normalized tool statuses are not genuine:
        // Grok Bash re-reports carry exit_code 0 mid-stream. A straggler
        // monitor-event can land after the real end (the CLI keeps streaming
        // while the agent already consumed the output via
        // get_command_or_subagent_output); without the tombstone it would
        // resurrect the running set and pin offers/idle-release forever.
        // A tool-level failed get_command tombstones too: failing open to a
        // single continuation beats failing closed to a dead thread.
        const endedBackgroundTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
        const endedBackgroundTaskIdLimit = 128;

        const setBackgroundTaskRunning = (taskId: string, running: boolean) =>
          Effect.gen(function* () {
            if (running && (yield* Ref.get(endedBackgroundTaskIds)).has(taskId)) {
              return;
            }
            yield* Ref.update(runningBackgroundTaskIds, (current) => {
              if (current.has(taskId) === running) return current;
              const next = new Set(current);
              if (running) {
                next.add(taskId);
              } else {
                next.delete(taskId);
              }
              return next;
            });
          });

        const markBackgroundTaskEnded = (taskId: string) =>
          Ref.update(endedBackgroundTaskIds, (current) => {
            if (current.has(taskId)) return current;
            const next = new Set(current).add(taskId);
            for (const oldest of next) {
              if (next.size <= endedBackgroundTaskIdLimit) break;
              next.delete(oldest);
            }
            return next;
          }).pipe(Effect.andThen(setBackgroundTaskRunning(taskId, false)));

        const applyBackgroundTaskMutationRunning = (mutation: {
          readonly taskId: string;
          readonly status: "running" | "completed" | "failed";
        }) =>
          mutation.status === "running"
            ? setBackgroundTaskRunning(mutation.taskId, true)
            : markBackgroundTaskEnded(mutation.taskId);

        const trackRunningBackgroundTools = (
          notification: EffectAcpSchema.SessionNotification,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (flavor.extractBackgroundTaskId === undefined) return;
            for (const event of parseSessionUpdateEvent(notification).events) {
              if (event._tag !== "ToolCallUpdated") continue;
              const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
              const taskId = flavor.extractBackgroundTaskId(toolCall);
              if (taskId === undefined) continue;
              const status = toolStatus(toolCall.status);
              yield* setBackgroundTaskRunning(taskId, status === "pending" || status === "running");
            }
          });

        const emitProviderEvent = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        let scheduleSettleRootTurnWhenIdle = (_context: ActiveAcpTurn) => Effect.void;
        let rearmRootTurnRecoveryTimers = (_context: ActiveAcpTurn) => Effect.void;
        let scheduleDeferredFinalize: (context: ActiveAcpTurn) => Effect.Effect<void> = () =>
          Effect.void;

        const nativeLogging = options.nativeLogging?.(input.threadId);
        const makeRuntimeInput = (runtimeGeneration: number): AcpAdapterV2RuntimeInput => ({
          cwd: input.runtimePolicy.cwd ?? process.cwd(),
          mcpServers: acpMcpServers(input.threadId),
          interruptPromptOnCancel: flavor.interruptPromptOnCancel ?? false,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            elicitation: { form: {} },
          },
          clientInfo: { name: "t3-code", version: "0.0.0" },
          onIncomingRequest: (requestId, method, payload) =>
            runRuntimeCallbackAtGeneration(
              runtimeGeneration,
              Effect.gen(function* () {
                const sequence = yield* Ref.getAndUpdate(
                  nextNativeTransportSequence,
                  (current) => current + 1,
                );
                yield* Ref.update(nativeTransportRequests, (current) => [
                  ...current,
                  { generation: runtimeGeneration, method, payload, requestId, sequence },
                ]);
              }),
            ).pipe(Effect.asVoid),
          onTermination: () =>
            runRuntimeCallbackAtGeneration(
              runtimeGeneration,
              Ref.set(runtimeRestartRequired, true),
            ).pipe(Effect.asVoid),
          onOutgoingResponseFailure: (requestId, error) =>
            Ref.modify(nativeResponseAcknowledgements, (current) => {
              const entry = current.get(requestId);
              if (entry === undefined || entry.generation !== runtimeGeneration) {
                return [
                  emitNativeResponseLifecycle({
                    type: "late_noop",
                    generation: runtimeGeneration,
                    requestId,
                  }),
                  current,
                ] as const;
              }
              const updated = new Map(current);
              updated.delete(requestId);
              return [
                Deferred.fail(entry.acknowledgement, error).pipe(
                  Effect.andThen(
                    emitNativeResponseLifecycle({
                      type: "removed",
                      generation: runtimeGeneration,
                      requestId,
                    }),
                  ),
                  Effect.asVoid,
                ),
                updated,
              ] as const;
            }).pipe(Effect.flatten),
          onOutgoingResponse: (requestId) =>
            Ref.modify(nativeResponseAcknowledgements, (current) => {
              const entry = current.get(requestId);
              if (entry === undefined || entry.generation !== runtimeGeneration) {
                return [
                  emitNativeResponseLifecycle({
                    type: "late_noop",
                    generation: runtimeGeneration,
                    requestId,
                  }),
                  current,
                ] as const;
              }
              const updated = new Map(current);
              updated.delete(requestId);
              return [
                Deferred.succeed(entry.acknowledgement, undefined).pipe(
                  Effect.andThen(
                    emitNativeResponseLifecycle({
                      type: "removed",
                      generation: runtimeGeneration,
                      requestId,
                    }),
                  ),
                  Effect.asVoid,
                ),
                updated,
              ] as const;
            }).pipe(Effect.flatten),
          ...(nativeLogging?.requestLogger === undefined
            ? {}
            : { requestLogger: nativeLogging.requestLogger }),
          protocolLogging: nativeLogging?.protocolLogging ?? {
            logIncoming: true,
            logOutgoing: true,
            logger: () => Effect.void,
          },
        });
        let runtimeScope: Scope.Closeable | undefined;
        let runtime!: AcpSessionRuntime.AcpSessionRuntime["Service"];
        yield* Effect.addFinalizer(() =>
          runtimeScope === undefined
            ? Effect.void
            : Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore),
        );

        const resolveItemOrdinal = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          nativeItemId: string,
        ) {
          const existing = (yield* Ref.get(itemOrdinals)).get(nativeItemId);
          if (existing !== undefined) return existing;
          const nextWithinTurn = yield* Ref.modify(nextItemOrdinalsByTurn, (current) => {
            const next = (current.get(context.nativeTurnId) ?? 0) + 1;
            const updated = new Map(current);
            updated.set(context.nativeTurnId, next);
            return [next, updated] as const;
          });
          const ordinal = context.input.providerTurnOrdinal * 100 + nextWithinTurn;
          yield* Ref.update(itemOrdinals, (current) => {
            const updated = new Map(current);
            updated.set(nativeItemId, ordinal);
            return updated;
          });
          return ordinal;
        });

        const rememberSnapshotMessage = (message: OrchestrationV2ConversationMessage) =>
          Ref.update(snapshot, (current) => {
            const key = String(message.id);
            const exists = current.messages.has(key);
            const messages = new Map(current.messages);
            messages.set(key, message);
            return {
              ...current,
              order: exists ? current.order : [...current.order, key],
              messages,
            };
          });

        const emitTextSegment = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "assistant" | "reasoning",
          completed: boolean,
        ) {
          const stream = kind === "assistant" ? context.assistant : context.reasoning;
          const segment = stream.current;
          if (segment === null || segment.text.length === 0) return;
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(context, segment.nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver,
            nativeItemId: segment.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver,
            nativeItemId: segment.nativeItemId,
          });
          const nativeItemRef = {
            driver,
            nativeId: segment.nativeItemId,
            strength: "weak" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: kind === "assistant" ? "assistant_message" : "reasoning",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
            },
          });
          if (kind === "assistant") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver,
              nativeItemId: segment.nativeItemId,
            });
            const message: OrchestrationV2ConversationMessage = {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              role: "assistant",
              text: segment.text,
              attachments: [],
              streaming: !completed,
              createdAt: segment.startedAt,
              updatedAt: now,
            };
            yield* emitProviderEvent({ type: "message.updated", driver, message });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: turnItemId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef,
                parentItemId: null,
                ordinal,
                status: completed ? "completed" : "running",
                title: null,
                startedAt: segment.startedAt,
                completedAt: completed ? now : null,
                updatedAt: now,
                type: "assistant_message",
                messageId,
                text: segment.text,
                streaming: !completed,
              },
            });
            if (completed) yield* rememberSnapshotMessage(message);
            return;
          }
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "reasoning",
              text: segment.text,
              streaming: !completed,
            },
          });
        });

        const closeTextStream = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "assistant" | "reasoning",
        ) {
          const stream = kind === "assistant" ? context.assistant : context.reasoning;
          if (stream.current === null) return;
          yield* emitTextSegment(context, kind, true);
          stream.current = null;
          if (kind === "assistant") {
            yield* scheduleSettleRootTurnWhenIdle(context);
          }
        });

        const closeTextStreams = Effect.fnUntraced(function* (context: ActiveAcpTurn) {
          yield* closeTextStream(context, "reasoning");
          yield* closeTextStream(context, "assistant");
        });

        const appendText = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "assistant" | "reasoning",
          text: string,
        ) {
          if (text.length === 0) return;
          const other = kind === "assistant" ? "reasoning" : "assistant";
          yield* closeTextStream(context, other);
          const stream = kind === "assistant" ? context.assistant : context.reasoning;
          if (stream.current === null) {
            const now = yield* DateTime.now;
            stream.current = {
              nativeItemId: `${context.nativeTurnId}:${kind}:${stream.nextSegment}`,
              startedAt: now,
              text: "",
            };
            stream.nextSegment += 1;
          }
          stream.current.text += text;
          yield* emitTextSegment(context, kind, false);
        });

        const emitSubagentAssistant = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          text: string,
        ) {
          if (text.length === 0) return;
          subagent.assistantText += text;
          const now = yield* DateTime.now;
          const nativeItemId = `${subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id}:result`;
          const artifacts = makeSubagentConversationArtifacts({
            messageId: idAllocator.derive.messageFromProviderItem({ driver, nativeItemId }),
            turnItemId: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
            threadId: subagent.childThreadId,
            rootNodeId: subagent.childRootNodeId,
            providerThreadId: subagent.task.providerThreadId,
            providerTurnId: null,
            nativeItemRef: { driver, nativeId: nativeItemId, strength: "weak" },
            role: "assistant",
            text: subagent.assistantText,
            ordinal: subagent.nextChildOrdinal,
            now,
          });
          yield* emitProviderEvent({ type: "message.updated", driver, message: artifacts.message });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: artifacts.turnItem,
          });
        });

        const projectSubagentNotification = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          notification: EffectAcpSchema.SessionNotification,
        ) {
          const update = notification.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            yield* emitSubagentAssistant(subagent, update.content.text);
          }
        });

        const emitSubagent = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          update: AcpAdapterV2SubagentUpdate,
        ) {
          // Hydration tools (get_command_or_subagent_output) use a new toolCallId
          // but reference the child via subagent_id / task id.
          const existing =
            context.subagents.get(update.nativeTaskId) ??
            (update.childSessionId !== null
              ? context.subagentsBySessionId.get(update.childSessionId)
              : undefined);
          // get_command_or_subagent_output may target monitors/bash tasks. Only
          // hydrate when we already have a matching subagent lineage. Spawn ACKs
          // (non-empty prompt) may create a new lineage; empty-prompt hydration
          // with suppressNormalTool must not invent a phantom subagent.
          if (existing === undefined) {
            const isHydrationOnly = update.prompt === "" && update.title === null;
            if (isHydrationOnly || update.suppressNormalTool === false) {
              return;
            }
          }
          const now = yield* DateTime.now;
          const nativeTaskId = existing?.task.nativeTaskRef?.nativeId ?? update.nativeTaskId;
          const nativeItemRef = {
            driver,
            nativeId: nativeTaskId,
            strength: "strong" as const,
          };
          const nodeId =
            existing?.task.id ??
            idAllocator.derive.nodeFromProviderItem({
              driver,
              nativeItemId: nativeTaskId,
            });
          const childThreadId =
            existing?.childThreadId ??
            idAllocator.derive.threadFromProviderThread({
              driver,
              nativeThreadId: `${nativeThreadId(driver, context.input.providerThread)}:task:${nativeTaskId}`,
            });
          const childRootNodeId =
            existing?.childRootNodeId ??
            idAllocator.derive.nodeFromProviderItem({
              driver,
              nativeItemId: `${nativeTaskId}:child-root`,
            });
          const turnItemId =
            existing?.turnItemId ??
            idAllocator.derive.turnItemFromProviderItem({
              driver,
              nativeItemId: nativeTaskId,
            });
          const turnItemOrdinal =
            existing?.turnItemOrdinal ?? (yield* resolveItemOrdinal(context, nativeTaskId));
          const taskStatus = update.status;
          const task: OrchestrationV2Subagent = {
            ...(existing?.task ?? {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              origin: "provider_native" as const,
              createdBy: "agent" as const,
              driver,
              providerInstanceId: context.input.modelSelection.instanceId,
              providerThreadId: null,
              childThreadId,
              nativeTaskRef: nativeItemRef,
              prompt: update.prompt,
              title: update.title,
              model: update.model,
              result: null,
              startedAt: now,
            }),
            status: taskStatus,
            result: existing?.assistantText || update.result,
            completedAt: taskStatus === "running" ? null : now,
            updatedAt: now,
          };
          const subagent: ActiveAcpSubagent = existing ?? {
            task,
            childThreadId,
            childRootNodeId,
            turnItemId,
            turnItemOrdinal,
            providerTurnId: context.providerTurnId,
            parentProviderThreadId: context.input.providerThread.id,
            childSessionId: null,
            assistantText: "",
            nextChildOrdinal: 101,
          };
          subagent.task = task;
          context.subagents.set(nativeTaskId, subagent);

          if (existing === undefined) {
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver,
              appThread: makeSubagentChildThread({
                parentThread: context.input.appThread,
                childThreadId,
                parentNodeId: nodeId,
                activeProviderThreadId: null,
                providerInstanceId: context.input.modelSelection.instanceId,
                modelSelection: {
                  ...context.input.modelSelection,
                  model: update.model ?? context.input.modelSelection.model,
                },
                title: subagentThreadTitle({
                  parentTitle: context.input.appThread.title,
                  title: update.title,
                  prompt: update.prompt,
                  ordinal: context.subagents.size,
                }),
                now,
                createdBy: "agent",
                creationSource: "provider",
              }),
            });
            const promptNativeItemId = `${nativeTaskId}:prompt`;
            const promptArtifacts = makeSubagentConversationArtifacts({
              messageId: idAllocator.derive.messageFromProviderItem({
                driver,
                nativeItemId: promptNativeItemId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver,
                nativeItemId: promptNativeItemId,
              }),
              threadId: childThreadId,
              rootNodeId: childRootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: { driver, nativeId: promptNativeItemId, strength: "weak" },
              role: "user",
              text: update.prompt,
              ordinal: 100,
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver,
              message: promptArtifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver,
              turnItem: promptArtifacts.turnItem,
            });
          }

          if (update.childSessionId !== null && subagent.childSessionId === null) {
            subagent.childSessionId = update.childSessionId;
            context.subagentsBySessionId.set(update.childSessionId, subagent);
            const providerThread = makeProviderThread({
              driver,
              providerInstanceId: context.input.modelSelection.instanceId,
              idAllocator,
              appThreadId: childThreadId,
              providerSessionId: input.providerSessionId,
              nativeThreadId: update.childSessionId,
              forkedFrom: {
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
              },
              now,
            });
            subagent.task = { ...subagent.task, providerThreadId: providerThread.id };
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver,
              providerThread: { ...providerThread, status: "idle" },
            });
            const buffered = context.pendingSubagentNotifications.get(update.childSessionId) ?? [];
            context.pendingSubagentNotifications.delete(update.childSessionId);
            yield* Effect.forEach(
              buffered,
              (notification) => projectSubagentNotification(subagent, notification),
              { concurrency: 1, discard: true },
            );
          }

          if (
            taskStatus !== "running" &&
            subagent.assistantText.length === 0 &&
            update.result !== null
          ) {
            yield* emitSubagentAssistant(subagent, update.result);
          }
          const result = subagent.assistantText || update.result;
          subagent.task = {
            ...subagent.task,
            status: taskStatus,
            result,
            completedAt: taskStatus === "running" ? null : now,
            updatedAt: now,
          };
          const providerThreadId = subagent.task.providerThreadId;
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: subagent.task.runId,
              parentNodeId: subagent.task.parentNodeId,
              rootNodeId: subagent.task.parentNodeId,
              kind: "subagent",
              status: taskStatus,
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: subagent.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: subagent.task.startedAt,
              completedAt: subagent.task.completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: childRootNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: childRootNodeId,
              kind: "root_turn",
              status: taskStatus,
              countsForRun: false,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: subagent.task.startedAt,
              completedAt: subagent.task.completedAt,
            },
          });
          yield* emitProviderEvent({ type: "subagent.updated", driver, subagent: subagent.task });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: subagent.task.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: subagent.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: turnItemOrdinal,
              status: taskStatus,
              title: subagent.task.title,
              startedAt: subagent.task.startedAt,
              completedAt: subagent.task.completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: subagent.task.id,
              origin: "provider_native",
              driver,
              providerInstanceId: context.input.modelSelection.instanceId,
              childThreadId,
              prompt: subagent.task.prompt,
              result,
            },
          });
        });

        const toolOutputText = (toolCall: AcpToolCallState): string => {
          if (typeof toolCall.data.rawOutput === "string") {
            return toolCall.data.rawOutput;
          }
          if (
            typeof (toolCall.data.rawOutput as { text?: unknown } | undefined)?.text === "string"
          ) {
            return String((toolCall.data.rawOutput as { text: string }).text);
          }
          return textFromUnknown(toolCall.data.rawOutput) ?? "";
        };

        const setToolOutputText = (toolCall: AcpToolCallState, text: string): AcpToolCallState => ({
          ...toolCall,
          data: {
            ...toolCall.data,
            rawOutput: {
              type: "Text",
              text,
            },
          },
        });

        const appendToolOutputText = (
          toolCall: AcpToolCallState,
          appendOutput: string,
        ): AcpToolCallState => {
          if (appendOutput.length === 0) return toolCall;
          return setToolOutputText(toolCall, `${toolOutputText(toolCall)}${appendOutput}`);
        };

        const isMonitorEndNoticeText = (text: string): boolean =>
          /Monitor\s+["']?[0-9a-f-]{8,}/i.test(text) && /ended/i.test(text);

        const hasDeferredBackgroundWork = (context: ActiveAcpTurn): boolean => {
          if (context.awaitingBackgroundHydration.size > 0) return true;
          if (context.pendingInjectedReport.size > 0) return true;
          for (const [taskId, toolCallId] of context.toolCallIdsByBackgroundTaskId) {
            // Persistent monitors stream after root settle; do not pin finalize.
            if (context.persistentBackgroundTaskIds.has(taskId)) continue;
            const tool = context.tools.get(toolCallId);
            if (tool === undefined) continue;
            const status = toolStatus(tool.status);
            if (status === "pending" || status === "running") return true;
          }
          for (const subagent of context.subagents.values()) {
            if (subagent.task.status === "running" || subagent.task.status === "pending") {
              return true;
            }
          }
          return false;
        };

        // scheduleDeferredFinalize is declared above openSession body start and
        // assigned after finalizeTurn so forked finalize Effect typing stays clean.
        const rearmDeferredFinalize = (context: ActiveAcpTurn) =>
          Effect.gen(function* () {
            if (!flavor.deferFinalizeForBackgroundWork) return;
            if (!context.promptSettled || context.finalized) return;
            if (hasDeferredBackgroundWork(context)) return;
            yield* scheduleDeferredFinalize(context);
          });

        // `let` breaks circular inference from monitor hydration re-entry.
        let emitTool: (
          context: ActiveAcpTurn,
          incoming: AcpToolCallState,
          projectedStatus?: ProjectedToolStatus,
        ) => Effect.Effect<void> = () => Effect.void;

        const markAwaitingBackgroundHydration = (context: ActiveAcpTurn, taskId: string) =>
          Effect.gen(function* () {
            if (context.awaitingBackgroundHydration.has(taskId)) return;
            context.awaitingBackgroundHydration.add(taskId);
            // Safety: do not hold the root turn forever if the agent never hydrates.
            yield* Effect.gen(function* () {
              yield* Effect.sleep("60000 millis");
              if (context.finalized || !context.awaitingBackgroundHydration.has(taskId)) return;
              context.awaitingBackgroundHydration.delete(taskId);
              // End notices keep the tool running until hydration; force-complete so
              // deferred finalize can proceed when get_command never arrives.
              const toolCallId = context.toolCallIdsByBackgroundTaskId.get(taskId);
              const tool = toolCallId !== undefined ? context.tools.get(toolCallId) : undefined;
              if (tool !== undefined) {
                const status = toolStatus(tool.status);
                if (status === "pending" || status === "running") {
                  yield* emitTool(context, { ...tool, status: "completed" });
                }
              }
              yield* rearmDeferredFinalize(context);
            }).pipe(Effect.forkIn(sessionScope), Effect.asVoid);
          });

        const markPendingInjectedReport = (context: ActiveAcpTurn, taskId: string) =>
          Effect.gen(function* () {
            // Only the settled-and-held window has the race; mid-turn reports
            // are protected by the prompt RPC still being open.
            if (!context.promptSettled) return;
            if (context.pendingInjectedReport.has(taskId)) return;
            context.pendingInjectedReport.add(taskId);
            // Safety: the injected turn may end without a report chunk.
            yield* Effect.gen(function* () {
              yield* Effect.sleep("25000 millis");
              if (context.finalized || !context.pendingInjectedReport.has(taskId)) return;
              context.pendingInjectedReport.delete(taskId);
              yield* rearmDeferredFinalize(context);
            }).pipe(Effect.forkIn(sessionScope), Effect.asVoid);
          });

        emitTool = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          incoming: AcpToolCallState,
          projectedStatus?: ProjectedToolStatus,
        ) {
          yield* closeTextStreams(context);
          const previous = context.tools.get(incoming.toolCallId);
          const merged = mergeToolCallState(previous, incoming);
          const toolCall = flavor.normalizeToolCall?.(merged) ?? merged;
          context.tools.set(toolCall.toolCallId, toolCall);
          const backgroundTaskId = flavor.extractBackgroundTaskId?.(toolCall);
          if (backgroundTaskId !== undefined) {
            context.toolCallIdsByBackgroundTaskId.set(backgroundTaskId, toolCall.toolCallId);
            if (flavor.isPersistentBackgroundTool?.(toolCall) === true) {
              context.persistentBackgroundTaskIds.add(backgroundTaskId);
            }
            const backgroundStatus = projectedStatus ?? toolStatus(toolCall.status);
            yield* setBackgroundTaskRunning(
              backgroundTaskId,
              backgroundStatus === "pending" || backgroundStatus === "running",
            );
            // Background tool that reaches a terminal status while the root
            // prompt is still open (completed, failed, or interrupted) was
            // consumed in-turn. Mark handled so late CLI re-reports and residual
            // agent chatter do not open synthetic "Background task completed."
            // runs. get_command TaskOutput still marks handled below.
            // Only before promptSettled: after STARTED the deferred-finalize
            // hold can let a monitor finish while the turn is still active;
            // marking then would suppress the legitimate post-settle TaskOutput
            // continuation (live: grok-post-settle-continuation-poll).
            // Terminal statuses only after normalizeToolCall (start ACKs stay
            // inProgress/running).
            //
            // Tradeoff: a pre-settle false "completed" normalization (Bash-
            // shaped re-report with exit_code 0, or the hydration safety
            // force-complete firing pre-settle) would permanently mark the task
            // handled and suppress its injected report chatter. The deleted
            // handled-id removal on late monitor-event mutations used to rescue
            // that case; likelihood is low because mid-turn monitor ends
            // normally arrive as reminder mutations that force inProgress, and
            // re-reports are documented post-settle traffic.
            if (
              !context.promptSettled &&
              backgroundStatus !== "pending" &&
              backgroundStatus !== "running"
            ) {
              yield* Ref.update(handledBackgroundTaskIdsInActiveTurn, (current) =>
                new Set(current).add(backgroundTaskId),
              );
              yield* Ref.update(midTurnUnreportedCompletedTaskIds, (current) => {
                if (!current.has(backgroundTaskId)) return current;
                const next = new Set(current);
                next.delete(backgroundTaskId);
                return next;
              });
            }
          }

          // get_command TaskOutput for registered monitor(s): hydrate those tools.
          const backgroundCompletions =
            projectedStatus === undefined
              ? (flavor.extractBackgroundTaskCompletion?.(toolCall) ?? [])
              : [];
          let hydratedRegisteredMonitor = false;
          for (const backgroundCompletion of backgroundCompletions) {
            // Genuine end signal when terminal: tombstone so straggler
            // monitor-event chatter cannot resurrect the running set after the
            // task truly ended. A still-running poll keeps the id running.
            yield* applyBackgroundTaskMutationRunning(backgroundCompletion);
            if (backgroundCompletion.status !== "running") {
              yield* Ref.update(handledBackgroundTaskIdsInActiveTurn, (current) =>
                new Set(current).add(backgroundCompletion.taskId),
              );
              yield* Ref.update(midTurnUnreportedCompletedTaskIds, (current) => {
                if (!current.has(backgroundCompletion.taskId)) return current;
                const next = new Set(current);
                next.delete(backgroundCompletion.taskId);
                return next;
              });
            }
            // A still-running fetch must keep the hydration hold (and its
            // safety timer) alive until output actually lands.
            if (backgroundCompletion.status !== "running") {
              context.awaitingBackgroundHydration.delete(backgroundCompletion.taskId);
            }
            const targetToolCallId = context.toolCallIdsByBackgroundTaskId.get(
              backgroundCompletion.taskId,
            );
            // Known background-task id (monitor registration) — never open a
            // phantom subagent for the same get_output poll.
            if (targetToolCallId !== undefined) {
              hydratedRegisteredMonitor = true;
            }
            const target =
              targetToolCallId !== undefined ? context.tools.get(targetToolCallId) : undefined;
            if (target !== undefined && target.toolCallId !== toolCall.toolCallId) {
              const nextStatus =
                backgroundCompletion.status === "running"
                  ? ("inProgress" as const)
                  : backgroundCompletion.status === "failed"
                    ? ("failed" as const)
                    : ("completed" as const);
              const hydrated =
                backgroundCompletion.appendOutput.length > 0
                  ? // TaskOutput is the real stdout; replace end-notice boilerplate
                    // so the timeline shows the listing, not only "Monitor ended…".
                    isMonitorEndNoticeText(toolOutputText(target)) ||
                    toolOutputText(target).trim().length === 0
                    ? setToolOutputText(
                        { ...target, status: nextStatus },
                        backgroundCompletion.appendOutput,
                      )
                    : appendToolOutputText(
                        { ...target, status: nextStatus },
                        backgroundCompletion.appendOutput,
                      )
                  : { ...target, status: nextStatus };
              yield* emitTool(context, hydrated);
            }
          }

          // Monitor TaskOutput shares the get_command tool shape with subagent
          // hydration; do not spawn a phantom subagent for a registered monitor.
          const subagentUpdate = hydratedRegisteredMonitor
            ? undefined
            : flavor.extractSubagentUpdate?.(toolCall);
          if (subagentUpdate !== undefined) {
            yield* emitSubagent(context, subagentUpdate);
            if (subagentUpdate.suppressNormalTool !== false) {
              yield* rearmDeferredFinalize(context);
              return;
            }
          }
          const status = projectedStatus ?? toolStatus(toolCall.status);
          const now = yield* DateTime.now;
          const nativeItemId = `${nativeThreadId(driver, context.input.providerThread)}:tool:${toolCall.toolCallId}`;
          const ordinal = yield* resolveItemOrdinal(context, nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver,
            nativeItemId,
          });
          const nativeItemRef = {
            driver,
            nativeId: toolCall.toolCallId,
            strength: "strong" as const,
          };
          const startedAt = context.toolStartedAt.get(toolCall.toolCallId) ?? now;
          context.toolStartedAt.set(toolCall.toolCallId, startedAt);
          const completedAt = completedAtForStatus(status, now);
          const title = toolCall.title ?? null;
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "tool_call",
              status: nodeStatus(status),
              countsForRun: true,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            },
          });

          const base = {
            id: turnItemId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status,
            title,
            startedAt,
            completedAt,
            updatedAt: now,
          } as const;
          const rawInput = toolCall.data.rawInput;
          const rawOutput = toolCall.data.rawOutput ?? toolCall.data.content;
          const path = pathFromToolCall(toolCall);
          const rawInputRecord = unknownRecord(rawInput);
          const inputVariant =
            typeof rawInputRecord?.variant === "string"
              ? rawInputRecord.variant.trim().toLowerCase()
              : "";
          const rawOutputRecord = unknownRecord(rawOutput);
          const outputCommand =
            typeof rawOutputRecord?.command === "string" &&
            rawOutputRecord.command.trim().length > 0
              ? rawOutputRecord.command.trim()
              : undefined;
          const monitorCommand =
            (typeof rawInputRecord?.command === "string" && rawInputRecord.command.trim().length > 0
              ? rawInputRecord.command.trim()
              : undefined) ?? outputCommand;
          const outputIsBashResult =
            typeof rawOutputRecord?.type === "string" &&
            rawOutputRecord.type.trim().toLowerCase() === "bash" &&
            commandExitCode(rawOutput) !== undefined;
          // Grok Monitor tools arrive as generic kind + variant; project like shell
          // so stdout is plain text in the timeline (not JSON {type:Text,text:...}).
          // Post-settle wake re-reports of a finished monitor carry no rawInput at
          // all, only a structured Bash result; project those as commands too.
          const projectAsCommandExecution = inputVariant === "monitor" || outputIsBashResult;
          let turnItem: OrchestrationV2TurnItem;
          switch (toolCall.kind) {
            case "read":
            case "search":
              turnItem = {
                ...base,
                type: "file_search",
                ...(path === undefined ? {} : { pattern: path }),
                ...(path === undefined
                  ? {}
                  : {
                      results: [
                        {
                          fileName: path,
                          ...(textFromUnknown(rawOutput) === undefined
                            ? {}
                            : { preview: textFromUnknown(rawOutput) }),
                        },
                      ],
                    }),
              };
              break;
            case "execute": {
              const exitCode = acpProjectedCommandExitCode(status, rawOutput);
              turnItem = {
                ...base,
                type: "command_execution",
                input: toolCall.command ?? monitorCommand ?? toolCall.title ?? "Command",
                ...(textFromUnknown(rawOutput) === undefined
                  ? {}
                  : { output: textFromUnknown(rawOutput) }),
                ...(exitCode === undefined ? {} : { exitCode }),
              };
              break;
            }
            case "edit":
            case "delete":
            case "move":
              turnItem = {
                ...base,
                type: "file_change",
                fileName: path ?? toolCall.title ?? "File change",
                ...(textFromUnknown(rawOutput) === undefined
                  ? {}
                  : { diffStr: textFromUnknown(rawOutput) }),
              };
              break;
            case "fetch":
              turnItem = {
                ...base,
                type: "web_search",
                ...(path === undefined ? {} : { patterns: [path] }),
                ...(path === undefined
                  ? {}
                  : {
                      results: [
                        {
                          url: path,
                          ...(textFromUnknown(rawOutput) === undefined
                            ? {}
                            : { snippet: textFromUnknown(rawOutput) }),
                        },
                      ],
                    }),
              };
              break;
            default:
              if (projectAsCommandExecution) {
                const exitCode = acpProjectedCommandExitCode(status, rawOutput);
                turnItem = {
                  ...base,
                  type: "command_execution",
                  input:
                    toolCall.command ??
                    monitorCommand ??
                    toolCall.title ??
                    (inputVariant === "monitor" ? "Monitor" : "Command"),
                  ...(textFromUnknown(rawOutput) === undefined
                    ? {}
                    : { output: textFromUnknown(rawOutput) }),
                  ...(exitCode === undefined ? {} : { exitCode }),
                };
              } else {
                turnItem = {
                  ...base,
                  type: "dynamic_tool",
                  toolName: toolCall.title ?? toolCall.kind ?? null,
                  input: rawInput ?? {},
                  ...(rawOutput === undefined ? {} : { output: rawOutput }),
                };
              }
          }
          yield* emitProviderEvent({ type: "turn_item.updated", driver, turnItem });
          yield* rearmDeferredFinalize(context);
        });

        const emitPlan = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          update: AcpPlanUpdate,
        ) {
          yield* closeTextStreams(context);
          const nativeItemId = `${context.nativeTurnId}:plan`;
          const ordinal = yield* resolveItemOrdinal(context, nativeItemId);
          const now = yield* DateTime.now;
          const nodeId = idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver,
            nativeItemId,
          });
          if (context.plan === null) {
            context.plan = {
              id: yield* idAllocator.allocate.plan({
                threadId: context.input.threadId,
                runId: context.input.runId,
                driver,
              }),
              startedAt: now,
            };
          }
          const planId = context.plan.id;
          const steps: ReadonlyArray<OrchestrationV2PlanStep> = update.plan.map((step, index) => ({
            id: `acp-step-${index + 1}`,
            text: nonEmptyText(step.step, `Step ${index + 1}`),
            status:
              step.status === "inProgress"
                ? "running"
                : step.status === "completed"
                  ? "completed"
                  : "pending",
          }));
          const completed = steps.length > 0 && steps.every((step) => step.status === "completed");
          const nativeItemRef = { driver, nativeId: nativeItemId, strength: "weak" as const };
          const plan: OrchestrationV2PlanArtifact = {
            id: planId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId,
            status: completed ? "completed" : "active",
            kind: "todo_list",
            steps,
            ...(update.explanation == null ? {} : { explanation: update.explanation }),
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "todo_list",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: context.plan.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({ type: "plan.updated", driver, plan });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: context.plan.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "todo_list",
              planId,
              steps,
              ...(update.explanation == null ? {} : { explanation: update.explanation }),
            },
          });
        });

        const appendLoadedHistory = (
          notification: EffectAcpSchema.SessionNotification,
          role: "user" | "assistant",
          text: string,
        ) =>
          Effect.gen(function* () {
            if (text.length === 0) return;
            const now = yield* DateTime.now;
            yield* Ref.update(snapshot, (current) => {
              const startsNew = current.loadingRole !== role;
              const loadingIndex = startsNew ? current.loadingIndex + 1 : current.loadingIndex;
              const nativeItemId = `${notification.sessionId}:history:${role}:${loadingIndex}`;
              const messageId = idAllocator.derive.messageFromProviderItem({
                driver,
                nativeItemId,
              });
              const key = String(messageId);
              const previous = current.messages.get(key);
              const messages = new Map(current.messages);
              messages.set(key, {
                createdBy: previous?.createdBy ?? (role === "user" ? "user" : "agent"),
                creationSource: previous?.creationSource ?? "provider",
                id: messageId,
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                role,
                text: `${previous?.text ?? ""}${text}`,
                attachments: [],
                streaming: false,
                createdAt: previous?.createdAt ?? now,
                updatedAt: now,
              });
              return {
                order: current.order.includes(key) ? current.order : [...current.order, key],
                messages,
                loadingRole: role,
                loadingIndex,
              };
            });
          });

        const offerContinuationRun = Effect.fnUntraced(function* (_sessionId: string) {
          if (continuationRequests === undefined) {
            return;
          }
          const pending = yield* continuationPermit.withPermit(
            Effect.gen(function* () {
              if (yield* Ref.get(continuationClosed)) return Option.none();
              if (yield* Ref.get(stoppedRunQuarantine)) return Option.none();
              if (yield* Ref.get(continuationRequested)) return Option.none();
              const route = yield* Ref.get(lastTurnRoute);
              if (route === null) return Option.none();
              yield* Ref.set(continuationRequested, true);
              const generation = yield* Ref.updateAndGet(
                continuationGeneration,
                (value) => value + 1,
              );
              return Option.some({ route, generation });
            }),
          );
          if (Option.isNone(pending)) return;
          const { route, generation } = pending.value;
          yield* Effect.logInfo("orchestration-v2.acp-wake-turn-detected", {
            driver,
            providerSessionId: input.providerSessionId,
            threadId: route.threadId,
            providerThreadId: route.providerThreadId,
          });
          yield* continuationRequests.offer({
            threadId: route.threadId,
            providerThreadId: route.providerThreadId,
            driver,
            detail: null,
            clearIfCurrent: () =>
              continuationPermit.withPermit(
                Effect.gen(function* () {
                  if ((yield* Ref.get(continuationGeneration)) === generation) {
                    yield* Ref.set(continuationRequested, false);
                  }
                }),
              ),
            dispatchIfCurrent: (effect) =>
              continuationPermit.withPermit(
                Effect.gen(function* () {
                  const clearIfOwner = Effect.gen(function* () {
                    if ((yield* Ref.get(continuationGeneration)) === generation) {
                      yield* Ref.set(continuationRequested, false);
                    }
                  });
                  if (yield* Ref.get(stoppedRunQuarantine)) {
                    yield* clearIfOwner;
                    return Option.none();
                  }
                  if ((yield* Ref.get(continuationGeneration)) !== generation) {
                    // Superseded by a newer offer; do not clear its flag.
                    return Option.none();
                  }
                  if (!(yield* Ref.get(continuationRequested))) return Option.none();
                  // A successful durable dispatch owns the sticky flag until its
                  // continuation turn starts. Clearing here opens a dispatch-to-
                  // start race where every late ACP frame can enqueue another
                  // synthetic continuation. Failures clear immediately because
                  // no turn will arrive to do so.
                  const exit = yield* Effect.exit(effect);
                  if (Exit.isFailure(exit)) {
                    yield* clearIfOwner;
                    return yield* Effect.failCause(exit.cause);
                  }
                  return Option.some(exit.value);
                }),
              ),
          });
        });

        const applyLateBackgroundMutation = Effect.fnUntraced(function* (
          sessionId: string,
          mutation: {
            readonly taskId: string;
            readonly status: "running" | "completed" | "failed";
          },
        ) {
          const taskAlreadyEnded = (yield* Ref.get(endedBackgroundTaskIds)).has(mutation.taskId);
          yield* applyBackgroundTaskMutationRunning(mutation);
          if (mutation.status === "running") {
            // Straggler running notice after a genuine end: suppress residual
            // monitor-prompt agent chatter so it cannot open a synthetic wake.
            if (taskAlreadyEnded && acpPostSettleMonitorPromptShouldSuppress(mutation)) {
              yield* Ref.set(suppressPostSettleMonitorPrompt, true);
            }
            return;
          }
          // First genuine terminal: allow subsequent agent output. Re-delivery
          // of an already-ended terminal must not un-suppress residual ack
          // chatter from the injected monitor-event turn.
          if (!taskAlreadyEnded) {
            yield* Ref.set(suppressPostSettleMonitorPrompt, false);
          }
          // Keep handledBackgroundTaskIdsInActiveTurn intact. Erasing the mark
          // on a late monitor-event mutation defeated the in-turn chatter guard
          // and let injected-turn acks arm wakeBuffer for a later spurious
          // "Background task completed." run (multiturn live repro). Monitors
          // the agent settled without reporting never enter that set, so their
          // injected report still streams via pendingInjectedReport / hold.
          const activeContext = yield* Ref.get(activeTurn);
          // Completions that land while a root turn is still streaming are
          // owned by in-turn machinery (emitTool handled marks, deferred
          // finalize, injected-report hold). Do not open a synthetic wake mid-
          // turn; finalizeTurn re-checks wakeBuffer / midTurnUnreported once
          // the turn leaves the active slot so legitimate unhandled evidence
          // still offers after finalize.
          if (activeContext !== null && !activeContext.finalized) {
            const handled = yield* Ref.get(handledBackgroundTaskIdsInActiveTurn);
            // Only arm deferred wake when this turn registered the task (monitor
            // tool started in-turn) and the root prompt is still open. Completions
            // that land in the settled-held window (promptSettled, deferred
            // finalize holding for injected report) fall back to the pre-existing
            // post-finalize injected-turn path; arming here would spuriously
            // offer "Background task completed." after the report streams into
            // the held turn. Residual cancel-backgrounded completions from a
            // prior interrupt must not open a synthetic continuation.
            if (
              !activeContext.promptSettled &&
              !handled.has(mutation.taskId) &&
              activeContext.toolCallIdsByBackgroundTaskId.has(mutation.taskId)
            ) {
              yield* Ref.update(midTurnUnreportedCompletedTaskIds, (current) =>
                new Set(current).add(mutation.taskId),
              );
            }
            return;
          }
          if (
            postSettleContinuationEnabled &&
            (yield* Ref.get(activeSessionId)) === sessionId &&
            (yield* Ref.get(runningBackgroundTaskIds)).size === 0 &&
            ((yield* Ref.get(wakeBuffer)).length > 0 ||
              (yield* Ref.get(midTurnUnreportedCompletedTaskIds)).size > 0)
          ) {
            yield* offerContinuationRun(sessionId);
          }
        });

        const bufferPostSettleWake = Effect.fnUntraced(function* (
          notification: EffectAcpSchema.SessionNotification,
        ) {
          if (!postSettleContinuationEnabled || continuationRequests === undefined) {
            return false;
          }
          // Direct Stop quarantine: drop residual wake evidence instead of
          // buffering it for a later continuation or follow-up run.
          if (yield* Ref.get(stoppedRunQuarantine)) {
            return true;
          }
          const rootSessionId = yield* Ref.get(activeSessionId);
          if (rootSessionId === null || notification.sessionId !== rootSessionId) {
            return false;
          }
          if (!acpPostSettleWakeEvidence(notification, flavor)) {
            return false;
          }
          const update = notification.update;
          let alreadyHandledToolUpdate = false;
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            yield* trackRunningBackgroundTools(notification);
            // When the agent consumes the monitor output itself via
            // get_command_or_subagent_output (long timeout), the TaskOutput
            // completion is the ONLY end signal: no "Monitor ended" reminder
            // follows. Without applying it here the running set never clears,
            // every offer stays suppressed, and the wake buffer never drains
            // (observed live 2026-07-12, thread 8dbe607f). The completion
            // frame itself is offer evidence, so clearing the id before the
            // gate below lets it open the single continuation run.
            for (const event of parseSessionUpdateEvent(notification).events) {
              if (event._tag !== "ToolCallUpdated") continue;
              const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
              const toolTaskId = flavor.extractBackgroundTaskId?.(toolCall);
              if (
                toolTaskId !== undefined &&
                (yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).has(toolTaskId)
              ) {
                alreadyHandledToolUpdate = true;
              }
              if (flavor.extractBackgroundTaskCompletion !== undefined) {
                for (const completion of flavor.extractBackgroundTaskCompletion(toolCall)) {
                  alreadyHandledToolUpdate =
                    alreadyHandledToolUpdate ||
                    (yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).has(completion.taskId);
                  yield* applyBackgroundTaskMutationRunning(completion);
                }
              }
            }
          }
          const backgroundWorkRunning = (yield* Ref.get(runningBackgroundTaskIds)).size > 0;
          // Residual Grok agent/thought chatter after in-turn-handled background
          // work must not be retained as wake evidence. Tool-path alreadyHandled
          // covers re-reports with a task id; this covers agent_message_chunk /
          // agent_thought_chunk frames that carry no task id (live:
          // grok-in-turn-monitor-no-wake, multiturn stale-buffer arm). Check
          // before buffering so the frames cannot dirty wakeBuffer and later
          // arm a mid-turn offer when a second monitor completes.
          const handledInTurnCount = (yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).size;
          const isInTurnHandledAgentChatter =
            handledInTurnCount > 0 &&
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk");
          // Grok prompts itself for every monitor event after the root turn
          // settles. Its assistant/reasoning replies are progress chatter, not
          // separate wake results. Retaining them would replay the entire burst
          // into the single continuation once the monitor finishes. Keep tool
          // state so the final command card still hydrates, then begin retaining
          // agent output again after the genuine end signal clears the running
          // set. With multiple tasks, text remains best-effort until every task
          // ends; their retained tool cards are the authoritative results.
          //
          // Skip retaining frames for tasks already hydrated in the root turn
          // (`handledBackgroundTaskIdsInActiveTurn`). Those re-reports must not
          // pin `hasPendingBackgroundWork` via a wake buffer that never drains
          // (the already-handled gate below intentionally skips
          // `offerContinuationRun` to avoid synthetic "Background task
          // completed." spam).
          if (
            !alreadyHandledToolUpdate &&
            !isInTurnHandledAgentChatter &&
            acpPostSettleWakeShouldBuffer(notification, backgroundWorkRunning)
          ) {
            yield* Ref.update(wakeBuffer, (current) => [...current, notification]);
          }
          // Buffer progress without offering; only completion-like frames open a run.
          if (!acpPostSettleContinuationOfferEvidence(notification, flavor)) {
            return true;
          }
          // While a monitor is still streaming, tool re-reports buffer without
          // offering and per-event agent commentary is consumed without being
          // retained. Grok re-reports a running monitor as Bash frames that
          // already carry exit_code 0 mid-stream, so a "terminal" normalized
          // status is not evidence the task ended; each burst would otherwise
          // reopen a synthetic "Background task completed." run. Retained tool
          // frames drain into the single continuation offered once the monitor
          // actually ends (end-notice mutation below, or the first frame after
          // it).
          if (backgroundWorkRunning) {
            return true;
          }
          if (alreadyHandledToolUpdate) {
            // Drop leftover wake noise for in-turn-handled work so idle release
            // is not pinned forever. Leave the buffer alone when a continuation
            // is already outstanding: its startTurn will drain legitimate frames
            // from other tasks.
            if (!(yield* Ref.get(continuationRequested))) {
              yield* Ref.set(wakeBuffer, []);
            }
            return true;
          }
          // Same in-turn-handled agent chatter: do not open a synthetic wake.
          // Do not clear wakeBuffer here: frames for other still-tracked tasks
          // must remain drainable when a real (tool) completion later offers.
          if (isInTurnHandledAgentChatter) {
            return true;
          }
          yield* offerContinuationRun(notification.sessionId);
          return true;
        });

        const handleSessionUpdate = Effect.fnUntraced(function* (
          notification: EffectAcpSchema.SessionNotification,
        ) {
          const context = yield* Ref.get(activeTurn);
          const update = notification.update;
          // Only while a finalized turn is still the active context. When
          // activeTurn is null, post-settle agent frames must reach
          // bufferPostSettleWake so continuation can attach (context?.finalized
          // !== false incorrectly treated null as finalized and dropped them).
          if (
            context !== null &&
            context.finalized &&
            (yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).size > 0 &&
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk")
          ) {
            yield* Ref.set(suppressPostSettleMonitorPrompt, true);
            return;
          }
          if (
            context !== null &&
            (yield* Ref.get(suppressPostSettleMonitorPrompt)) &&
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk")
          ) {
            return;
          }
          if (
            context?.finalized === true &&
            update.sessionUpdate === "user_message_chunk" &&
            update.content.type === "text"
          ) {
            const mutations = flavor.extractBackgroundToolMutation?.(update.content.text) ?? [];
            for (const mutation of mutations) {
              yield* applyLateBackgroundMutation(notification.sessionId, mutation);
            }
            return;
          }
          if (context === null) {
            // Direct Stop: quarantine residual events from the stopped run so
            // they cannot become history, wake buffers, or a later run attach.
            if (yield* Ref.get(stoppedRunQuarantine)) {
              return;
            }
            // Prefer continuation buffering over history append so the same
            // frames are not double-counted once a continuation run attaches.
            if (yield* bufferPostSettleWake(notification)) {
              return;
            }
            if (
              (update.sessionUpdate === "user_message_chunk" ||
                update.sessionUpdate === "agent_message_chunk") &&
              update.content.type === "text"
            ) {
              // Late monitor end/event reminders must not become ghost user/assistant
              // history (or OS-facing chatter) after the root turn already finalized.
              const text = update.content.text;
              const lateBackgroundMutations = flavor.extractBackgroundToolMutation?.(text) ?? [];
              for (const lateBackgroundMutation of lateBackgroundMutations) {
                yield* applyLateBackgroundMutation(notification.sessionId, lateBackgroundMutation);
              }
              const lateMonitorChatter =
                /<monitor-event\b/i.test(text) ||
                /Monitor\s+["']?[0-9a-f-]{8,}["']?\s+ended/i.test(text);
              if (lateBackgroundMutations.length === 0 && !lateMonitorChatter) {
                yield* appendLoadedHistory(
                  notification,
                  update.sessionUpdate === "user_message_chunk" ? "user" : "assistant",
                  text,
                );
              }
            } else if (
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update" ||
              update.sessionUpdate === "plan"
            ) {
              yield* Ref.update(snapshot, (current) => ({ ...current, loadingRole: null }));
            }
            return;
          }
          if (context.finalized) return;
          if (notification.sessionId !== (yield* Ref.get(activeSessionId))) {
            // Finalize may have completed during the activeSessionId yield.
            if (context.finalized) return;
            if (flavor.extractSubagentUpdate === undefined) return;
            if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
              return;
            }
            const subagent = context.subagentsBySessionId.get(notification.sessionId);
            if (subagent !== undefined) {
              yield* projectSubagentNotification(subagent, notification);
              return;
            }
            const buffered = context.pendingSubagentNotifications.get(notification.sessionId) ?? [];
            buffered.push(notification);
            context.pendingSubagentNotifications.set(notification.sessionId, buffered);
            return;
          }
          // Re-check after the activeSessionId yield: idle/prompt settle can
          // finalize the same context object while we waited.
          if (context.finalized) return;
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (update.content.type === "text") {
                // The injected-turn report is streaming; the normal debounce
                // after the last chunk takes over from here. Drop matching
                // mid-turn armed ids so finalize does not open a duplicate
                // wake after the report already projected into this turn.
                if (context.pendingInjectedReport.size > 0) {
                  const reportedTaskIds = [...context.pendingInjectedReport];
                  context.pendingInjectedReport.clear();
                  yield* Ref.update(midTurnUnreportedCompletedTaskIds, (current) => {
                    let next: Set<string> | null = null;
                    for (const taskId of reportedTaskIds) {
                      if (!current.has(taskId)) continue;
                      if (next === null) next = new Set(current);
                      next.delete(taskId);
                    }
                    return next ?? current;
                  });
                }
                yield* appendText(context, "assistant", update.content.text);
              }
              break;
            case "agent_thought_chunk":
              if (update.content.type === "text") {
                yield* appendText(context, "reasoning", update.content.text);
              }
              break;
            case "user_message_chunk":
              if (update.content.type === "text" && flavor.extractBackgroundToolMutation) {
                for (const mutation of flavor.extractBackgroundToolMutation(update.content.text)) {
                  const toolCallId = context.toolCallIdsByBackgroundTaskId.get(mutation.taskId);
                  const previous =
                    toolCallId !== undefined ? context.tools.get(toolCallId) : undefined;
                  if (previous !== undefined) {
                    let nextStatus =
                      mutation.status === "running"
                        ? ("inProgress" as const)
                        : mutation.status === "failed"
                          ? ("failed" as const)
                          : ("completed" as const);
                    // End notices typically omit full stdout (no get_command mention
                    // either). Keep the tool running and hold finalize until
                    // TaskOutput hydrates, or the safety timer force-completes.
                    if (nextStatus !== "inProgress") {
                      yield* markAwaitingBackgroundHydration(context, mutation.taskId);
                      nextStatus = "inProgress";
                    }
                    yield* emitTool(
                      context,
                      appendToolOutputText(
                        { ...previous, status: nextStatus },
                        mutation.appendOutput,
                      ),
                    );
                  }
                  // After emitTool: the hydration hold keeps the tool row at
                  // inProgress past an end notice, but the offer gate must see
                  // the mutation's semantic status. Also tracks monitors that
                  // never surfaced a tool_call row at all.
                  yield* applyBackgroundTaskMutationRunning(mutation);
                  if (mutation.status !== "running") {
                    yield* markPendingInjectedReport(context, mutation.taskId);
                  }
                }
              }
              if (update.content.type === "text" && flavor.extractSubagentEndNotice) {
                const notice = flavor.extractSubagentEndNotice(update.content.text);
                const subagent =
                  notice !== undefined
                    ? context.subagentsBySessionId.get(notice.childSessionId)
                    : undefined;
                if (
                  notice !== undefined &&
                  subagent !== undefined &&
                  (subagent.task.status === "running" || subagent.task.status === "pending")
                ) {
                  // The agent is free to answer with text only and never call
                  // get_command_or_subagent_output; without this, the subagent
                  // row stays running and holds deferred finalize open forever.
                  yield* emitSubagent(context, {
                    nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? notice.childSessionId,
                    prompt: subagent.task.prompt,
                    title: subagent.task.title,
                    model: subagent.task.model,
                    status: notice.status,
                    childSessionId: notice.childSessionId,
                    result: null,
                    suppressNormalTool: true,
                  });
                }
              }
              break;
            default: {
              const parsed = parseSessionUpdateEvent(notification);
              for (const event of parsed.events) {
                if (event._tag === "ToolCallUpdated") {
                  yield* emitTool(context, event.toolCall);
                } else if (event._tag === "PlanUpdated") {
                  yield* emitPlan(context, event.payload);
                }
              }
            }
          }
          if (acpRootSessionUpdateIngestsOutput(notification)) {
            yield* scheduleSettleRootTurnWhenIdle(context);
          }
          // Keep deferred finalize quiet-window fresh while wake traffic lands.
          yield* rearmDeferredFinalize(context);
        });

        const activeContext = Effect.gen(function* () {
          const context = yield* Ref.get(activeTurn);
          if (context === null) {
            return yield* new EffectAcpErrors.AcpTransportError({
              detail: "ACP agent requested input without an active turn",
              cause: "No active ACP turn",
            });
          }
          return context;
        });

        const beginApprovalRequest = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          params: EffectAcpSchema.RequestPermissionRequest,
          generation: number,
          transportRequestId: string,
        ) {
          yield* closeTextStreams(context);
          const parsed = parsePermissionRequest(params);
          const nativeRequestId = params.toolCall.toolCallId;
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver,
            providerTurnId: context.providerTurnId,
            nativeRequestId,
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision>();
          const nativeResponseAcknowledgement = yield* Deferred.make<
            void,
            EffectAcpErrors.AcpError
          >();
          yield* registerNativeResponseAcknowledgement(
            generation,
            transportRequestId,
            nativeResponseAcknowledgement,
          );
          const now = yield* DateTime.now;
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const requestKind = providerRequestKind(parsed.kind);
          const nativeItemRef = { driver, nativeId: nativeRequestId, strength: "weak" as const };
          const ordinal = yield* resolveItemOrdinal(
            context,
            `${context.nativeTurnId}:approval:${nativeRequestId}`,
          );
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: context.providerTurnId,
            nativeRequestRef: nativeItemRef,
            kind: requestKind,
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: input.providerSessionId,
            },
            createdAt: now,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            parentNodeId: context.input.rootNodeId,
            rootNodeId: context.input.rootNodeId,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          };
          const turnItem: OrchestrationV2TurnItem = {
            id: idAllocator.derive.approvalTurnItem({ requestId }),
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "approval_request",
            requestId,
            requestKind,
            ...(parsed.detail === undefined ? {} : { prompt: parsed.detail }),
          };
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(requestId), {
              type: "approval",
              generation,
              nativeResponseAcknowledgement,
              requestId,
              transportRequestId,
              decision,
              runtimeRequest,
              node,
              turnItem,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver,
            threadId: context.input.threadId,
            runtimeRequest,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem,
          });
          return {
            context,
            decision,
            nativeResponseAcknowledgement,
            requestId,
            transportRequestId,
          } as const;
        });

        const beginUserInputRequest = Effect.fnUntraced(function* (
          request: AcpAdapterV2UserInputRequest,
          generation: number,
          transportRequestId: string,
        ) {
          const context = yield* activeContext;
          yield* closeTextStreams(context);
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver,
            providerTurnId: context.providerTurnId,
            nativeRequestId: request.nativeRequestId,
          });
          const answers = yield* Deferred.make<ProviderUserInputAnswers | null>();
          const nativeResponseAcknowledgement = yield* Deferred.make<
            void,
            EffectAcpErrors.AcpError
          >();
          yield* registerNativeResponseAcknowledgement(
            generation,
            transportRequestId,
            nativeResponseAcknowledgement,
          );
          const now = yield* DateTime.now;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver,
            nativeItemId: request.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver,
            nativeItemId: request.nativeItemId,
          });
          const nativeItemRef = {
            driver,
            nativeId: request.nativeItemId,
            strength: "weak" as const,
          };
          const ordinal = yield* resolveItemOrdinal(context, request.nativeItemId);
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: context.providerTurnId,
            nativeRequestRef: {
              driver,
              nativeId: request.nativeRequestId,
              strength: "weak",
            },
            kind: "user_input",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: input.providerSessionId,
            },
            createdAt: now,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            parentNodeId: context.input.rootNodeId,
            rootNodeId: context.input.rootNodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          };
          const turnItem: OrchestrationV2TurnItem = {
            id: turnItemId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [...request.questions],
          };
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(requestId), {
              type: "user_input",
              generation,
              nativeResponseAcknowledgement,
              requestId,
              transportRequestId,
              answers,
              runtimeRequest,
              node,
              turnItem,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver,
            threadId: context.input.threadId,
            runtimeRequest,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem,
          });
          return {
            answers,
            context,
            nativeResponseAcknowledgement,
            requestId,
            transportRequestId,
          } as const;
        });

        const requestUserInputWithAdmission = (
          generation: number,
          request: Effect.Effect<AcpAdapterV2UserInputRequest>,
          transportRequestId: string,
        ) =>
          runRuntimeCallbackAtGeneration(
            generation,
            request.pipe(
              Effect.flatMap((value) =>
                beginUserInputRequest(value, generation, transportRequestId),
              ),
            ),
          ).pipe(
            Effect.flatMap((pending) => {
              if (Option.isNone(pending)) return Effect.never;
              const { answers, context, requestId, transportRequestId } = pending.value;
              return Deferred.await(answers).pipe(
                Effect.flatMap((result) =>
                  runRuntimeCallbackAtGeneration(generation, Effect.succeed(result)).pipe(
                    Effect.flatMap((checked) =>
                      Option.isSome(checked)
                        ? Effect.succeed({
                            acknowledgeNativeResponse: acknowledgeNativeResponse(
                              generation,
                              transportRequestId,
                            ),
                            answers: checked.value,
                          })
                        : Effect.never,
                    ),
                  ),
                ),
                Effect.ensuring(
                  runRuntimeCallbackAtGeneration(
                    generation,
                    Effect.gen(function* () {
                      yield* Ref.update(pendingRuntimeRequests, (current) => {
                        const updated = new Map(current);
                        updated.delete(String(requestId));
                        return updated;
                      });
                      yield* rearmRootTurnRecoveryTimers(context);
                    }),
                  ).pipe(Effect.asVoid),
                ),
              );
            }),
            Effect.mapError(
              (cause) =>
                new EffectAcpErrors.AcpTransportError({
                  detail: "Failed to handle ACP user input request",
                  cause,
                }),
            ),
          );

        const cancelPendingRuntimeRequests = Effect.fnUntraced(function* () {
          const requests = yield* Ref.modify(pendingRuntimeRequests, (current) => [
            [...current.values()],
            new Map<string, PendingRuntimeRequest>(),
          ]);
          if (requests.length === 0) return;

          const now = yield* DateTime.now;
          yield* Effect.forEach(
            requests,
            (request) =>
              Effect.gen(function* () {
                const cancelled = yield* request.type === "approval"
                  ? Deferred.succeed(request.decision, "cancel")
                  : Deferred.succeed(request.answers, null);
                if (!cancelled) return;

                yield* emitProviderEvent({
                  type: "runtime_request.updated",
                  driver,
                  threadId: request.node.threadId,
                  runtimeRequest: {
                    ...request.runtimeRequest,
                    status: "cancelled",
                    resolvedAt: now,
                  },
                });
                yield* emitProviderEvent({
                  type: "node.updated",
                  driver,
                  node: {
                    ...request.node,
                    status: "cancelled",
                    completedAt: now,
                  },
                });
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...request.turnItem,
                    status: "cancelled",
                    completedAt: now,
                    updatedAt: now,
                  },
                });
              }),
            { concurrency: 1, discard: true },
          );
        });

        /**
         * Direct Stop after a soft steer clears carryover without an active turn.
         * Emit the same interrupted terminal events terminalizeOpenRunOwnedItems
         * would have, context-free (no ActiveAcpTurn).
         */
        const terminalizeCarryoverSubagents = Effect.fnUntraced(function* (
          carryover: {
            readonly sessionId: string;
            readonly subagents: ReadonlyArray<ActiveAcpSubagent>;
          } | null,
        ) {
          if (carryover === null) return;
          const now = yield* DateTime.now;
          for (const subagent of carryover.subagents) {
            if (subagent.task.status !== "running" && subagent.task.status !== "pending") {
              continue;
            }
            const nativeTaskId = subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id;
            const nativeItemRef = {
              driver,
              nativeId: nativeTaskId,
              strength: "strong" as const,
            };
            const parentProviderThreadId = subagent.parentProviderThreadId;
            const result = subagent.assistantText || subagent.task.result;
            subagent.task = {
              ...subagent.task,
              status: "interrupted",
              result,
              completedAt: now,
              updatedAt: now,
            };
            yield* emitProviderEvent({
              type: "node.updated",
              driver,
              node: {
                id: subagent.task.id,
                threadId: subagent.task.threadId,
                runId: subagent.task.runId,
                parentNodeId: subagent.task.parentNodeId,
                rootNodeId: subagent.task.parentNodeId,
                kind: "subagent",
                status: "interrupted",
                countsForRun: false,
                providerThreadId: parentProviderThreadId,
                providerTurnId: subagent.providerTurnId,
                nativeItemRef,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: subagent.task.startedAt,
                completedAt: now,
              },
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver,
              node: {
                id: subagent.childRootNodeId,
                threadId: subagent.childThreadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: subagent.childRootNodeId,
                kind: "root_turn",
                status: "interrupted",
                countsForRun: false,
                providerThreadId: subagent.task.providerThreadId,
                providerTurnId: null,
                nativeItemRef,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: subagent.task.startedAt,
                completedAt: now,
              },
            });
            yield* emitProviderEvent({
              type: "subagent.updated",
              driver,
              subagent: subagent.task,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: subagent.turnItemId,
                threadId: subagent.task.threadId,
                runId: subagent.task.runId,
                nodeId: subagent.task.id,
                providerThreadId: parentProviderThreadId,
                providerTurnId: subagent.providerTurnId,
                nativeItemRef,
                parentItemId: null,
                ordinal: subagent.turnItemOrdinal,
                status: "interrupted",
                title: subagent.task.title,
                startedAt: subagent.task.startedAt,
                completedAt: now,
                updatedAt: now,
                type: "subagent",
                subagentId: subagent.task.id,
                origin: "provider_native",
                driver,
                providerInstanceId: subagent.task.providerInstanceId,
                childThreadId: subagent.childThreadId,
                prompt: subagent.task.prompt,
                result,
              },
            });
          }
        });

        const wireAcpRuntimeHandlers = Effect.fnUntraced(function* () {
          const handlerGeneration = yield* Ref.get(runtimeCallbackGeneration);
          const requestUserInput = (request: AcpAdapterV2UserInputRequest) =>
            Effect.gen(function* () {
              const transportRequestId = yield* claimNativeTransportRequest(
                handlerGeneration,
                (transport) => acpNativeUserInputRequestMatches(request, transport),
              );
              const correlated = yield* runRuntimeCallbackAtGeneration(
                handlerGeneration,
                transportRequestId === undefined
                  ? new EffectAcpErrors.AcpTransportError({
                      detail:
                        "Could not correlate the ACP user input request with its transport ID",
                      cause: "Could not correlate xAI user input transport request",
                    })
                  : Effect.succeed(transportRequestId),
              );
              if (Option.isNone(correlated)) return yield* Effect.never;
              return yield* requestUserInputWithAdmission(
                handlerGeneration,
                Effect.succeed(request),
                correlated.value,
              );
            });
          yield* runtime.handleSessionUpdate((notification) =>
            runRuntimeCallbackAtGeneration(
              handlerGeneration,
              handleSessionUpdate(notification),
            ).pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to project an ACP session update",
                    cause,
                  }),
              ),
            ),
          );
          yield* runtime.handleRequestPermission((params) =>
            Effect.gen(function* () {
              const transportRequestId = yield* claimNativeTransportRequest(
                handlerGeneration,
                ({ method, payload }) =>
                  method === "session/request_permission" &&
                  unknownRecord(payload)?.sessionId === params.sessionId &&
                  unknownRecord(unknownRecord(payload)?.toolCall)?.toolCallId ===
                    params.toolCall.toolCallId,
              );
              const correlated = yield* runRuntimeCallbackAtGeneration(
                handlerGeneration,
                transportRequestId === undefined
                  ? new EffectAcpErrors.AcpTransportError({
                      detail:
                        "Could not correlate the ACP permission request with its transport ID",
                      cause: "Could not correlate session/request_permission transport request",
                    })
                  : Effect.succeed(transportRequestId),
              );
              if (Option.isNone(correlated)) return yield* Effect.never;
              const correlatedTransportRequestId = correlated.value;
              const admitted = yield* runRuntimeCallbackAtGeneration(
                handlerGeneration,
                Effect.gen(function* () {
                  const context = yield* activeContext;
                  const disposition = acpPermissionDisposition(context.input.runtimePolicy, params);
                  if (disposition === "allow") {
                    const optionId = selectAutoApprovedPermissionOption(params);
                    return {
                      _tag: "Immediate" as const,
                      response:
                        optionId === undefined
                          ? ({ outcome: { outcome: "cancelled" } } as const)
                          : ({ outcome: { outcome: "selected", optionId } } as const),
                    };
                  }
                  if (disposition === "deny") {
                    const optionId = selectPermissionOptionId(params, "decline");
                    return {
                      _tag: "Immediate" as const,
                      response:
                        optionId === undefined
                          ? ({ outcome: { outcome: "cancelled" } } as const)
                          : ({ outcome: { outcome: "selected", optionId } } as const),
                    };
                  }
                  return {
                    _tag: "Pending" as const,
                    pending: yield* beginApprovalRequest(
                      context,
                      params,
                      handlerGeneration,
                      correlatedTransportRequestId,
                    ),
                  };
                }),
              );
              if (Option.isNone(admitted)) {
                return yield* Effect.never;
              }
              if (admitted.value._tag === "Immediate") {
                const response = admitted.value.response;
                const checked = yield* runRuntimeCallbackAtGeneration(
                  handlerGeneration,
                  Effect.gen(function* () {
                    const nativeResponseAcknowledgement = yield* Deferred.make<
                      void,
                      EffectAcpErrors.AcpError
                    >();
                    yield* registerNativeResponseAcknowledgement(
                      handlerGeneration,
                      correlatedTransportRequestId,
                      nativeResponseAcknowledgement,
                    );
                    return response;
                  }),
                );
                return Option.isSome(checked) ? checked.value : yield* Effect.never;
              }
              const {
                context,
                decision: pendingDecision,
                requestId,
                transportRequestId: pendingTransportRequestId,
              } = admitted.value.pending;
              const decision = yield* Deferred.await(pendingDecision).pipe(
                Effect.ensuring(
                  runRuntimeCallbackAtGeneration(
                    handlerGeneration,
                    Effect.gen(function* () {
                      yield* Ref.update(pendingRuntimeRequests, (current) => {
                        const updated = new Map(current);
                        updated.delete(String(requestId));
                        return updated;
                      });
                      yield* rearmRootTurnRecoveryTimers(context);
                    }),
                  ).pipe(Effect.asVoid),
                ),
              );
              const response = (() => {
                if (decision === "cancel") {
                  return { outcome: { outcome: "cancelled" } } as const;
                }
                const optionId = selectPermissionOptionId(params, decision);
                return optionId === undefined
                  ? ({ outcome: { outcome: "cancelled" } } as const)
                  : ({ outcome: { outcome: "selected", optionId } } as const);
              })();
              const checked = yield* runRuntimeCallbackAtGeneration(
                handlerGeneration,
                Effect.succeed(response),
              );
              if (Option.isNone(checked)) return yield* Effect.never;
              yield* acknowledgeNativeResponse(handlerGeneration, pendingTransportRequestId);
              return checked.value;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to handle an ACP permission request",
                    cause,
                  }),
              ),
            ),
          );
          yield* runtime.handleElicitation((params) =>
            Effect.gen(function* () {
              const transportRequestId = yield* claimNativeTransportRequest(
                handlerGeneration,
                ({ method, payload }) => {
                  const record = unknownRecord(payload);
                  return (
                    method === "session/elicitation" &&
                    record?.sessionId === params.sessionId &&
                    record.message === params.message &&
                    record.mode === params.mode &&
                    (params.mode === "url"
                      ? record.elicitationId === params.elicitationId && record.url === params.url
                      : acpCanonicalJson(record.requestedSchema) ===
                        acpCanonicalJson(params.requestedSchema))
                  );
                },
              );
              const correlated = yield* runRuntimeCallbackAtGeneration(
                handlerGeneration,
                transportRequestId === undefined
                  ? new EffectAcpErrors.AcpTransportError({
                      detail:
                        "Could not correlate the ACP elicitation request with its transport ID",
                      cause: "Could not correlate session/elicitation transport request",
                    })
                  : Effect.succeed(transportRequestId),
              );
              if (Option.isNone(correlated)) return yield* Effect.never;
              const correlatedTransportRequestId = correlated.value;
              if (params.mode === "url") {
                const admitted = yield* runRuntimeCallbackAtGeneration(
                  handlerGeneration,
                  Effect.gen(function* () {
                    const nativeResponseAcknowledgement = yield* Deferred.make<
                      void,
                      EffectAcpErrors.AcpError
                    >();
                    yield* registerNativeResponseAcknowledgement(
                      handlerGeneration,
                      correlatedTransportRequestId,
                      nativeResponseAcknowledgement,
                    );
                    return { action: { action: "decline" } } as const;
                  }),
                );
                if (Option.isNone(admitted)) return yield* Effect.never;
                return admitted.value;
              }
              const questions = Object.entries(params.requestedSchema.properties ?? {}).map(
                ([id, property], index): OrchestrationV2UserInputQuestion => {
                  const record = unknownRecord(property);
                  const enumValues = Array.isArray(record?.enum)
                    ? record.enum.filter((value): value is string => typeof value === "string")
                    : [];
                  const options =
                    enumValues.length > 0
                      ? enumValues.map((value) => ({ label: value, description: value }))
                      : record?.type === "boolean"
                        ? [
                            { label: "true", description: "Yes" },
                            { label: "false", description: "No" },
                          ]
                        : [];
                  return {
                    id,
                    header: nonEmptyText(record?.title, `Question ${index + 1}`),
                    question: nonEmptyText(record?.description, params.message),
                    options,
                  };
                },
              );
              const userInput = yield* requestUserInputWithAdmission(
                handlerGeneration,
                Effect.gen(function* () {
                  const ordinal = yield* Ref.getAndUpdate(
                    nextElicitationOrdinal,
                    (current) => current + 1,
                  );
                  const nativeRequestId = `${params.sessionId}:elicitation:${ordinal}`;
                  return {
                    nativeItemId: nativeRequestId,
                    nativeRequestId,
                    questions,
                  };
                }),
                correlatedTransportRequestId,
              );
              const response =
                userInput.answers === null
                  ? ({ action: { action: "cancel" } } as const)
                  : ({
                      action: {
                        action: "accept",
                        content: elicitationContent(
                          userInput.answers,
                          new Set(Object.keys(params.requestedSchema.properties ?? {})),
                        ),
                      },
                    } as const);
              yield* userInput.acknowledgeNativeResponse;
              return response;
            }),
          );
          if (flavor.registerExtensions !== undefined) {
            yield* flavor.registerExtensions({
              runtime,
              requestUserInput,
              applyBackgroundTaskMutation: (mutation) =>
                Effect.gen(function* () {
                  // Direct Stop quarantine: drop residual task lifecycle from
                  // the stopped run instead of mutating wake machinery.
                  if (yield* Ref.get(stoppedRunQuarantine)) return;
                  // Root-session tasks only: a cancelled subagent's re-run in
                  // its child session must not gate root wake machinery.
                  if ((yield* Ref.get(activeSessionId)) !== mutation.sessionId) return;
                  yield* applyLateBackgroundMutation(mutation.sessionId, mutation);
                }),
            });
          }
        });

        const spawnAcpRuntime = Effect.fnUntraced(function* () {
          if (runtimeScope !== undefined) {
            yield* Scope.close(runtimeScope, Exit.void);
          }
          runtimeScope = yield* Scope.make();
          const runtimeGeneration = yield* Ref.get(runtimeCallbackGeneration);
          runtime = yield* flavor
            .makeRuntime(makeRuntimeInput(runtimeGeneration))
            .pipe(
              Effect.provideService(Scope.Scope, runtimeScope),
              Effect.provideService(Crypto.Crypto, options.crypto),
            );
        });

        const restartAcpRuntime = Effect.fnUntraced(function* () {
          yield* spawnAcpRuntime();
          yield* wireAcpRuntimeHandlers();
        });

        yield* spawnAcpRuntime();
        yield* wireAcpRuntimeHandlers();

        const started = yield* runtime.start();
        yield* Ref.set(activeSessionId, started.sessionId);
        yield* Ref.set(activeSessionSetup, started);
        const capabilities = negotiatedCapabilities(flavor.capabilities, started);
        const canLoadSession = started.initializeResult.agentCapabilities?.loadSession === true;
        const canResumeSession =
          started.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
        const supportsImagePrompts = acpSupportsImagePrompts({
          flavorSupportsImagePrompts: flavor.supportsImagePrompts,
          negotiatedImage:
            started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
        });

        const activateSession = Effect.fnUntraced(function* (
          sessionId: string,
          threadId: ThreadId | null,
        ) {
          const activationOptions = { mcpServers: acpMcpServers(threadId) };
          if (canLoadSession) {
            return yield* runtime.loadSession(sessionId, activationOptions);
          }
          if (canResumeSession) {
            return yield* runtime.resumeSession(sessionId, activationOptions);
          }
          return yield* new ProviderAdapterProtocolError({
            driver,
            detail: `ACP driver cannot load or resume session ${sessionId}`,
          });
        });

        const configureSession = Effect.fnUntraced(function* (
          startResult: AcpSessionRuntimeStartResult,
          modelSelection: ModelSelection,
          runtimePolicy: ProviderAdapterV2RuntimePolicy,
        ) {
          const requestedModel = flavor.resolveModelId?.(modelSelection) ?? modelSelection.model;
          if (
            requestedModel.length > 0 &&
            requestedModel !== "auto" &&
            requestedModel !== "default"
          ) {
            const currentModel = startResult.sessionSetupResult.models?.currentModelId;
            if (currentModel !== requestedModel) {
              if (startResult.sessionSetupResult.models != null) {
                yield* runtime.setSessionModel(requestedModel);
              } else if (
                startResult.sessionSetupResult.configOptions?.some(
                  (option) => option.category === "model",
                ) === true
              ) {
                yield* runtime.setModel(requestedModel);
              }
            }
          }
          const configOptions = yield* runtime.getConfigOptions;
          const availableConfigIds = new Set(configOptions.map((option) => option.id));
          const unsupportedConfigIds = (modelSelection.options ?? [])
            .map((selection) => selection.id)
            .filter((id) => !availableConfigIds.has(id));
          if (unsupportedConfigIds.length > 0) {
            return yield* new ProviderAdapterProtocolError({
              driver,
              detail: `ACP session ${startResult.sessionId} does not expose requested configuration option(s): ${unsupportedConfigIds.join(", ")}`,
            });
          }
          for (const selection of modelSelection.options ?? []) {
            yield* runtime.setConfigOption(selection.id, selection.value);
          }
          const modeState = yield* runtime.getModeState;
          if (runtimePolicy.interactionMode === "plan" && modeState !== undefined) {
            const planMode = modeState.availableModes.find(
              (mode) => mode.id === "plan" || mode.id === "architect",
            );
            if (planMode !== undefined) yield* runtime.setMode(planMode.id);
          }
        });

        yield* configureSession(started, input.modelSelection, input.runtimePolicy);
        yield* Ref.set(activeSelection, input.modelSelection);
        const createdAt = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities,
          createdAt,
          updatedAt: createdAt,
          lastError: null,
        };

        const providerTurnPayload = (
          context: ActiveAcpTurn,
          status: OrchestrationV2ProviderTurn["status"],
          completedAt: DateTime.Utc | null,
        ): OrchestrationV2ProviderTurn => ({
          id: context.providerTurnId,
          providerThreadId: context.input.providerThread.id,
          nodeId: context.input.rootNodeId,
          runAttemptId: context.input.attemptId,
          nativeTurnRef: {
            driver,
            nativeId: context.nativeTurnId,
            strength: "weak",
          },
          ordinal: context.input.providerTurnOrdinal,
          status,
          startedAt: context.startedAt,
          completedAt,
        });

        const drainTrailingRootTurnChunks = Effect.fnUntraced(function* () {
          if (!flavor.settleRootTurnWhenIdle) return;
          // Projected via handleSessionUpdate, not getEvents(). Cooperative yield
          // only — replay uses TestClock; Effect.sleep here would stall settlement.
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
        });

        const terminalizeOpenRunOwnedItems = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          options: { readonly terminalizeSubagents: boolean },
        ) {
          for (const tool of context.tools.values()) {
            const status = toolStatus(tool.status);
            if (status === "pending" || status === "running") {
              yield* emitTool(context, tool, "interrupted");
            }
          }
          if (!options.terminalizeSubagents) return;
          for (const subagent of context.subagents.values()) {
            if (subagent.task.status !== "running" && subagent.task.status !== "pending") {
              continue;
            }
            yield* emitSubagent(context, {
              nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
              prompt: subagent.task.prompt,
              title: subagent.task.title,
              model: subagent.task.model,
              status: "interrupted",
              childSessionId: subagent.childSessionId,
              result: subagent.task.result,
              suppressNormalTool: true,
            });
          }
        });

        const terminalizeOpenForegroundTools = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
        ) {
          for (const tool of context.tools.values()) {
            if (!acpCompletedTurnShouldTerminalizeTool(tool, flavor)) continue;
            yield* emitTool(context, tool, "completed");
          }
        });

        const quarantineStoppedRun = Effect.fnUntraced(function* () {
          yield* continuationPermit.withPermit(
            Effect.gen(function* () {
              yield* Ref.update(continuationGeneration, (value) => value + 1);
              yield* Ref.set(stoppedRunQuarantine, true);
              yield* Ref.set(wakeBuffer, []);
              yield* Ref.set(continuationRequested, false);
              yield* Ref.set(runningBackgroundTaskIds, new Set());
              yield* Ref.set(midTurnUnreportedCompletedTaskIds, new Set());
              yield* Ref.set(carryoverSubagents, null);
              yield* Ref.set(lastTurnRoute, null);
            }),
          );
        });

        const finalizeTurn = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          status: "completed" | "interrupted" | "failed" | "cancelled",
          failure?: OrchestrationV2ProviderFailure,
          options?: { readonly drainTrailingChunks?: boolean },
        ) {
          if (context.finalized) return;
          const settledStatus = context.interrupted ? "interrupted" : status;
          context.finalized = true;
          if (options?.drainTrailingChunks === true) {
            yield* drainTrailingRootTurnChunks();
          }
          const directStopQuarantine = yield* Ref.get(stoppedRunQuarantine);
          if (settledStatus === "completed") {
            yield* terminalizeOpenForegroundTools(context);
          } else if (settledStatus === "interrupted") {
            // Direct Stop terminalizes every visible run-owned item. restart_active
            // keeps live subagent lineages for in-process replacement carryover.
            yield* terminalizeOpenRunOwnedItems(context, {
              terminalizeSubagents: directStopQuarantine,
            });
          }
          yield* closeTextStreams(context);
          const now = yield* DateTime.now;
          const turn = providerTurnPayload(context, settledStatus, now);
          yield* Ref.update(providerTurns, (current) => {
            const updated = new Map(current);
            updated.set(String(turn.id), turn);
            return updated;
          });
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver,
            threadId: context.input.threadId,
            providerTurn: turn,
          });
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver,
            providerThread: {
              ...context.input.providerThread,
              providerSessionId: input.providerSessionId,
              status: "active",
              lastRunOrdinal: context.input.runOrdinal,
              firstRunOrdinal:
                context.input.providerThread.firstRunOrdinal ?? context.input.runOrdinal,
              updatedAt: now,
            },
          });
          yield* emitProviderEvent(
            settledStatus === "failed"
              ? {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: context.input.providerThread.id,
                  providerTurnId: context.providerTurnId,
                  runOrdinal: context.input.runOrdinal,
                  failureItemOrdinal: yield* resolveItemOrdinal(
                    context,
                    `terminal-failure:${context.providerTurnId}`,
                  ),
                  status: settledStatus,
                  failure: failure ?? makeProviderFailure({ class: "provider_error" }),
                  threadDisposition: "reusable",
                }
              : {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: context.input.providerThread.id,
                  providerTurnId: context.providerTurnId,
                  runOrdinal: context.input.runOrdinal,
                  status: settledStatus,
                  failure: null,
                  threadDisposition: "reusable",
                },
          );
          const liveSubagents = [...context.subagents.values()].filter(
            (subagent) => subagent.task.status === "running" || subagent.task.status === "pending",
          );
          // Direct Stop must not carry residual subagents into a later run.
          if (liveSubagents.length > 0 && !directStopQuarantine) {
            const sessionId = yield* Ref.get(activeSessionId);
            if (sessionId !== null) {
              yield* Ref.set(carryoverSubagents, { sessionId, subagents: liveSubagents });
            }
          }
          yield* Ref.set(activeTurn, null);
          // A mid-turn background completion may have deferred its offer while
          // this root turn was still streaming. Once the turn leaves the active
          // slot, re-check: empty running set + residual wake evidence (or a
          // mid-turn unreported completion) means a legitimate unhandled
          // completion can open exactly one continuation. Sticky
          // continuationRequested prevents double-offer if a later frame also
          // races into offerContinuationRun.
          if (
            postSettleContinuationEnabled &&
            settledStatus === "completed" &&
            !directStopQuarantine &&
            (yield* Ref.get(runningBackgroundTaskIds)).size === 0 &&
            ((yield* Ref.get(wakeBuffer)).length > 0 ||
              (yield* Ref.get(midTurnUnreportedCompletedTaskIds)).size > 0)
          ) {
            const sessionId = yield* Ref.get(activeSessionId);
            if (sessionId !== null) {
              yield* offerContinuationRun(sessionId);
            }
          }
          // Clear mid-turn unreported marks unless a completed turn still has
          // running background work: keep them so the post-finalize gate can
          // offer once when the last task ends. Interrupted/failed turns must
          // not leave marks that open a wake after interrupt (quarantine owns
          // that path). Non-continuation turn start also clears (~user turn).
          if (
            settledStatus !== "completed" ||
            (yield* Ref.get(runningBackgroundTaskIds)).size === 0
          ) {
            yield* Ref.set(midTurnUnreportedCompletedTaskIds, new Set());
          }
          yield* Deferred.succeed(context.completed, undefined).pipe(Effect.ignore);
        });

        const trySettleRootTurnWhenIdle = Effect.fnUntraced(function* (context: ActiveAcpTurn) {
          const pending = yield* Ref.get(pendingRuntimeRequests);
          const hasPendingRuntimeRequest = acpTurnHasPendingRuntimeRequest(
            context.providerTurnId,
            pending,
          );
          const hasRunningTool = [...context.tools.values()].some((tool) => {
            const status = toolStatus(tool.status);
            return status === "pending" || status === "running";
          });
          // Debounce already proved root-session quiescence; open segment handles
          // without an explicit close should not block settlement.
          const hasRunningSubagent = [...context.subagents.values()].some(
            (subagent) => subagent.task.status === "running",
          );
          if (
            !acpRootTurnIsIdle({
              finalized: context.finalized,
              interrupted: context.interrupted,
              assistantStreamOpen: false,
              reasoningStreamOpen: false,
              hasRunningTool,
              hasPendingRuntimeRequest,
              hasToolHistory: context.tools.size > 0,
              hasRunningSubagent,
              hasOutput: context.assistant.nextSegment > 0,
            })
          ) {
            return;
          }
          // Never session/cancel here. Speculative settle must not kill in-flight
          // Grok work; late tools would arrive with activeTurn null and drop.
          yield* finalizeTurn(context, "completed", undefined, { drainTrailingChunks: true });
        });

        scheduleDeferredFinalize = (context) =>
          Effect.gen(function* () {
            if (!flavor.deferFinalizeForBackgroundWork) return;
            if (!context.promptSettled || context.finalized || context.interrupted) return;
            if (hasDeferredBackgroundWork(context)) return;
            context.backgroundFinalizeGeneration += 1;
            const generation = context.backgroundFinalizeGeneration;
            // Minimal quiet for all models (no per-model carveouts). Defer +
            // awaitingBackgroundHydration hold the turn through monitors; this
            // is only a short debounce after the last rearm so a slightly late
            // post-hydration assistant chunk stays in the same continuation.
            // Grok commonly sends its final summary just over two seconds after
            // the hydrated tool frame; two seconds split that tail into a second
            // synthetic wake. Longer floors (4–20s) only prolonged Working.
            yield* Effect.gen(function* () {
              yield* Effect.sleep("3000 millis");
              if (
                context.finalized ||
                context.interrupted ||
                context.backgroundFinalizeGeneration !== generation
              ) {
                return;
              }
              if (hasDeferredBackgroundWork(context)) return;
              const status = context.promptSettledStatus ?? "completed";
              yield* finalizeTurn(context, status, undefined, { drainTrailingChunks: true });
            }).pipe(Effect.forkIn(sessionScope), Effect.asVoid);
          });

        scheduleSettleRootTurnWhenIdle = (context) =>
          Effect.gen(function* () {
            if (!flavor.settleRootTurnWhenIdle) return;
            context.settleScheduleGeneration += 1;
            const generation = context.settleScheduleGeneration;
            yield* Effect.gen(function* () {
              yield* Effect.sleep(`${acpRootTurnSettleDebounceMs} millis`);
              if (context.finalized || context.interrupted) return;
              if (context.settleScheduleGeneration !== generation) return;
              const active = yield* Ref.get(activeTurn);
              if (active !== context) return;
              yield* trySettleRootTurnWhenIdle(context);
            }).pipe(Effect.forkIn(sessionScope), Effect.asVoid);
          });

        rearmRootTurnRecoveryTimers = (context) =>
          Effect.gen(function* () {
            if (!acpRootTurnShouldRearmRecoveryTimers(context)) return;
            yield* scheduleSettleRootTurnWhenIdle(context);
          });

        const resolvePromptParts = Effect.fnUntraced(function* (
          turnInput: ProviderAdapterV2TurnInput,
        ) {
          const prompt: Array<EffectAcpSchema.ContentBlock> = [];
          const text = t3OrchestrationPromptForFirstRun({
            prompt: turnInput.message.text,
            runOrdinal: turnInput.runOrdinal,
            hasT3Mcp: acpMcpServers(turnInput.threadId).length > 0,
          });
          if (text.length > 0) {
            prompt.push({ type: "text", text });
          }
          if (turnInput.message.attachments.length > 0 && !supportsImagePrompts) {
            return yield* new ProviderAdapterProtocolError({
              driver,
              detail: "ACP driver did not negotiate image prompt support",
            });
          }
          for (const attachment of turnInput.message.attachments) {
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: attachment as ChatAttachment,
            });
            if (path === null) {
              return yield* new ProviderAdapterProtocolError({
                driver,
                detail: `Invalid attachment id '${attachment.id}'`,
              });
            }
            const bytes = yield* fileSystem.readFile(path).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProtocolError({
                    driver,
                    detail: `Failed to read attachment '${attachment.id}'`,
                    payload: cause,
                  }),
              ),
            );
            prompt.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
          if (prompt.length === 0) {
            return yield* new ProviderAdapterProtocolError({
              driver,
              detail: "ACP turn requires non-empty text or attachments",
            });
          }
          return prompt;
        });

        const restartRuntimeAfterTeardownIfRequired = Effect.fnUntraced(function* () {
          const restartRequired = yield* Ref.get(runtimeRestartRequired);
          if (!restartRequired) return false;
          yield* restartAcpRuntime();
          yield* Ref.set(runtimeRestartRequired, false);
          yield* Ref.set(activeSessionId, null);
          yield* Ref.set(activeSessionSetup, null);
          yield* Ref.set(activeSelection, null);
          yield* Ref.set(snapshot, {
            order: [],
            messages: new Map(),
            loadingRole: null,
            loadingIndex: 0,
          });
          return true;
        });

        const startTurnUnlocked = Effect.fn("AcpAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapterV2TurnInput) {
            yield* awaitRuntimeTeardown();
            const existing = yield* Ref.get(activeTurn);
            if (existing !== null) {
              return yield* new ProviderAdapterProtocolError({
                driver,
                detail: `ACP provider turn ${existing.providerTurnId} is still active`,
              });
            }
            const requestedSessionId = nativeThreadId(driver, turnInput.providerThread);
            const restartAfterInterrupt = yield* restartRuntimeAfterTeardownIfRequired();
            const needsSessionActivation =
              (yield* Ref.get(activeSessionId)) !== requestedSessionId || restartAfterInterrupt;
            if (needsSessionActivation) {
              const activated = yield* activateSession(requestedSessionId, turnInput.threadId);
              yield* Ref.set(activeSessionId, activated.sessionId);
              yield* Ref.set(activeSessionSetup, activated);
              yield* configureSession(activated, turnInput.modelSelection, turnInput.runtimePolicy);
              yield* Ref.set(activeSelection, turnInput.modelSelection);
            } else {
              const configuredSelection = yield* Ref.get(activeSelection);
              if (
                configuredSelection === null ||
                !modelSelectionsEqual(configuredSelection, turnInput.modelSelection)
              ) {
                const currentSessionSetup = yield* Ref.get(activeSessionSetup);
                if (currentSessionSetup === null) {
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: `ACP session ${requestedSessionId} has no active setup metadata`,
                  });
                }
                yield* configureSession(
                  currentSessionSetup,
                  turnInput.modelSelection,
                  turnInput.runtimePolicy,
                );
                yield* Ref.set(activeSelection, turnInput.modelSelection);
              }
            }
            yield* Ref.set(lastTurnRoute, {
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
            });
            yield* Ref.set(suppressPostSettleMonitorPrompt, false);
            yield* Ref.set(handledBackgroundTaskIdsInActiveTurn, new Set());
            yield* Ref.set(midTurnUnreportedCompletedTaskIds, new Set());
            // Continuation turns attach to wake traffic the agent already produced
            // after the prior root turn settled; do not re-prompt the ACP session.
            const isContinuationTurn =
              postSettleContinuationEnabled &&
              turnInput.message.createdBy === "agent" &&
              turnInput.message.creationSource === "provider";
            // User turns must not inherit prior-turn wake residue. Stale injected-
            // turn ack chatter buffered for in-turn-handled work can otherwise
            // arm a mid-turn offer when a later monitor completes (multiturn
            // live repro). Continuation turns keep the buffer so attach mode can
            // drain it. Still-running tasks remain in runningBackgroundTaskIds
            // and re-buffer evidence when they complete; a user message means
            // this turn owns the conversation, so prior wake frames cannot be
            // legitimate for a synthetic continuation of the previous turn.
            if (!isContinuationTurn) {
              yield* Ref.set(wakeBuffer, []);
            }
            // Drop a sticky continuation offer when any new turn starts so idle
            // pin and further offers cannot wed on a completed or failed dispatch.
            yield* continuationPermit.withPermit(
              Effect.gen(function* () {
                yield* Ref.update(continuationGeneration, (value) => value + 1);
                yield* Ref.set(continuationRequested, false);
              }),
            );
            const prompt = isContinuationTurn ? null : yield* resolvePromptParts(turnInput);
            const startedAt = yield* DateTime.now;
            const nativeTurnId = `${requestedSessionId}:turn:${turnInput.providerTurnOrdinal}`;
            const providerTurnId = idAllocator.derive.providerTurn({ driver, nativeTurnId });
            const completed = yield* Deferred.make<void, never>();
            const promptWireSettled = yield* Deferred.make<void, never>();
            const context: ActiveAcpTurn = {
              input: turnInput,
              providerTurnId,
              nativeTurnId,
              startedAt,
              completed,
              assistant: { current: null, nextSegment: 0 },
              reasoning: { current: null, nextSegment: 0 },
              tools: new Map(),
              toolStartedAt: new Map(),
              subagents: new Map(),
              subagentsBySessionId: new Map(),
              pendingSubagentNotifications: new Map(),
              toolCallIdsByBackgroundTaskId: new Map(),
              persistentBackgroundTaskIds: new Set(),
              awaitingBackgroundHydration: new Set(),
              pendingInjectedReport: new Set(),
              plan: null,
              interrupted: false,
              finalized: false,
              settleScheduleGeneration: 0,
              promptSettled: false,
              promptSettledStatus: null,
              promptWireSettled,
              backgroundFinalizeGeneration: 0,
            };
            const carryover = yield* Ref.getAndSet(carryoverSubagents, null);
            if (carryover !== null && carryover.sessionId === requestedSessionId) {
              for (const subagent of carryover.subagents) {
                const nativeId = subagent.task.nativeTaskRef?.nativeId ?? null;
                if (nativeId !== null) {
                  context.subagents.set(nativeId, subagent);
                }
                if (subagent.childSessionId !== null) {
                  context.subagentsBySessionId.set(subagent.childSessionId, subagent);
                }
              }
            }
            yield* Ref.set(activeTurn, context);
            // Direct Stop closes and recreates the old runtime before reaching
            // this reset. The quarantine remains session-scoped by design.
            yield* Ref.set(stoppedRunQuarantine, false);
            const runningTurn = providerTurnPayload(context, "running", null);
            yield* Ref.update(providerTurns, (current) => {
              const updated = new Map(current);
              updated.set(String(runningTurn.id), runningTurn);
              return updated;
            });
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver,
              threadId: turnInput.threadId,
              providerTurn: runningTurn,
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver,
              providerThread: {
                ...turnInput.providerThread,
                providerSessionId: input.providerSessionId,
                status: "active",
                updatedAt: startedAt,
              },
            });
            yield* rememberSnapshotMessage({
              createdBy: turnInput.message.createdBy,
              creationSource: turnInput.message.creationSource,
              id: turnInput.message.messageId,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              role: "user",
              text: turnInput.message.text,
              attachments: [...turnInput.message.attachments],
              streaming: false,
              createdAt: startedAt,
              updatedAt: startedAt,
            });
            if (isContinuationTurn) {
              const drained = yield* Ref.modify(wakeBuffer, (current) => {
                const next: Array<EffectAcpSchema.SessionNotification> = [];
                return [current.slice(), next] as const;
              });
              yield* Ref.set(continuationRequested, false);
              // Treat attach mode as prompt-settled so deferred finalize / quiet
              // windows can complete the continuation after wake traffic drains.
              context.promptSettled = true;
              context.promptSettledStatus = "completed";
              if (drained.length === 0) {
                // Empty wakeBuffer (midTurn-only offer): wait the quiet window
                // so late CLI frames can attach. scheduleDeferredFinalize
                // no-ops without deferFinalizeForBackgroundWork; fall back to
                // immediate finalize so the turn cannot wedge.
                if (flavor.deferFinalizeForBackgroundWork === true) {
                  if (hasDeferredBackgroundWork(context)) {
                    yield* rearmDeferredFinalize(context);
                  } else {
                    yield* scheduleDeferredFinalize(context);
                  }
                } else {
                  yield* finalizeTurn(context, "completed", undefined, {
                    drainTrailingChunks: true,
                  });
                }
                return;
              }
              for (const notification of drained) {
                yield* handleSessionUpdate(notification);
              }
              if (!context.finalized) {
                if (hasDeferredBackgroundWork(context)) {
                  yield* rearmDeferredFinalize(context);
                } else {
                  yield* scheduleDeferredFinalize(context);
                }
              }
              return;
            }
            const promptGeneration = yield* Ref.get(runtimeCallbackGeneration);
            yield* runtime.prompt({ prompt: prompt! }).pipe(
              // Wire settlement precedes the completion callback's permit request so
              // settled-soft classification can observe the native return even when
              // the completion fiber has not yet set promptSettled under the permit.
              Effect.tap(() =>
                Deferred.succeed(context.promptWireSettled, undefined).pipe(Effect.asVoid),
              ),
              Effect.flatMap((result) =>
                runRuntimeCallbackAtGeneration(
                  promptGeneration,
                  Effect.gen(function* () {
                    if (context.finalized) return;
                    const status =
                      result.stopReason === "cancelled"
                        ? context.interrupted
                          ? "interrupted"
                          : "cancelled"
                        : "completed";
                    // Grok monitors (and async subagents) keep working after the root
                    // prompt RPC returns. Defer finalize so their later updates and
                    // wake-turn traffic still project onto this run.
                    if (
                      flavor.deferFinalizeForBackgroundWork === true &&
                      !context.interrupted &&
                      hasDeferredBackgroundWork(context)
                    ) {
                      context.promptSettled = true;
                      context.promptSettledStatus = status;
                      return;
                    }
                    // Only completed turns drain trailing chunks. Interrupted turns
                    // must not wait for residual output from a stopped prompt.
                    yield* finalizeTurn(context, status, undefined, {
                      drainTrailingChunks: status === "completed",
                    });
                  }),
                ).pipe(Effect.asVoid),
              ),
              // Prompt failure is not wire-settled: only a successful resolve marks
              // the signal. catchCause must not complete promptWireSettled.
              Effect.catchCause((cause) =>
                runRuntimeCallbackAtGeneration(
                  promptGeneration,
                  Effect.gen(function* () {
                    if (context.finalized) return;
                    yield* finalizeTurn(
                      context,
                      context.interrupted ? "interrupted" : "failed",
                      makeProviderFailure({
                        cause: Cause.squash(cause),
                        class: "provider_error",
                      }),
                    ).pipe(
                      Effect.andThen(
                        Effect.logWarning("orchestration-v2.acp-prompt-failed", {
                          driver,
                          providerSessionId: input.providerSessionId,
                          providerThreadId: turnInput.providerThread.id,
                          providerTurnId,
                          cause,
                        }),
                      ),
                    );
                  }),
                ).pipe(Effect.asVoid),
              ),
              Effect.forkIn(sessionScope),
            );
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        );

        const startTurn = Effect.fn("AcpAdapterV2.startTurn.transition")(function* (
          turnInput: ProviderAdapterV2TurnInput,
        ) {
          return yield* runtimeTransitionPermit.withPermit(startTurnUnlocked(turnInput));
        });

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* continuationPermit.withPermit(
              Effect.gen(function* () {
                yield* Ref.set(continuationClosed, true);
                yield* Ref.update(continuationGeneration, (value) => value + 1);
              }),
            );
            const requests = [...(yield* Ref.get(pendingRuntimeRequests)).values()];
            yield* Effect.forEach(
              requests,
              (request) =>
                request.type === "approval"
                  ? Deferred.succeed(request.decision, "cancel").pipe(Effect.ignore)
                  : Deferred.succeed(request.answers, null).pipe(Effect.ignore),
              { discard: true },
            );
            const closingError = new EffectAcpErrors.AcpTransportError({
              detail: "The ACP session closed before its admitted response reached the transport",
              cause: "ACP session transport closed",
            });
            yield* Effect.forEach(
              requests,
              (request) => Deferred.fail(request.nativeResponseAcknowledgement, closingError),
              { discard: true },
            );
            const transportHadOutstandingResponses = yield* closeNativeTransport;
            yield* options.testHooks?.afterNativeResponseTransportClosed?.() ?? Effect.void;
            const sessionCapabilities =
              started.initializeResult.agentCapabilities?.sessionCapabilities;
            if (sessionCapabilities?.close != null) {
              yield* runtimeTransitionPermit.withPermitsIfAvailable(1)(
                Effect.gen(function* () {
                  const teardownState = yield* Ref.get(runtimeTeardownState);
                  const restartRequired = yield* Ref.get(runtimeRestartRequired);
                  if (
                    teardownState._tag === "Idle" &&
                    !restartRequired &&
                    !transportHadOutstandingResponses
                  ) {
                    yield* runtime.closeSession().pipe(Effect.ignore);
                  }
                }),
              );
            }
            if (flavor.assertComplete !== undefined) {
              yield* flavor.assertComplete.pipe(Effect.orDie);
            }
            if (runtimeScope !== undefined) {
              yield* Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore);
            }
          }),
        );

        const sessionRuntime: ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ...(postSettleContinuationEnabled
            ? {
                hasPendingBackgroundWork: Effect.gen(function* () {
                  if ((yield* Ref.get(wakeBuffer)).length > 0) return true;
                  if (yield* Ref.get(continuationRequested)) return true;
                  if ((yield* Ref.get(runningBackgroundTaskIds)).size > 0) return true;
                  return false;
                }),
              }
            : {}),
          ensureThread: Effect.fn("AcpAdapterV2.ensureThread")(
            function* (threadInput: ProviderAdapterV2EnsureThreadInput) {
              const now = yield* DateTime.now;
              const sessionId = yield* Ref.get(activeSessionId);
              if (sessionId === null) {
                return yield* new ProviderAdapterProtocolError({
                  driver,
                  detail: "ACP runtime did not produce a session id",
                });
              }
              return makeProviderThread({
                driver,
                providerInstanceId: options.instanceId,
                idAllocator,
                appThreadId: threadInput.threadId,
                providerSessionId: input.providerSessionId,
                nativeThreadId: sessionId,
                now,
              });
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterEnsureThreadError({
                      driver,
                      threadId: threadInput.threadId,
                      cause,
                    }),
                ),
              ),
          ),
          resumeThread: Effect.fn("AcpAdapterV2.resumeThread")(
            function* (threadInput: {
              readonly providerThread: OrchestrationV2ProviderThread;
              readonly modelSelection?: ModelSelection;
              readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
            }) {
              return yield* runtimeTransitionPermit.withPermit(
                Effect.gen(function* () {
                  yield* awaitRuntimeTeardown();
                  const restartAfterInterrupt = yield* restartRuntimeAfterTeardownIfRequired();
                  const sessionId = nativeThreadId(driver, threadInput.providerThread);
                  if ((yield* Ref.get(activeSessionId)) !== sessionId || restartAfterInterrupt) {
                    yield* Ref.set(snapshot, {
                      order: [],
                      messages: new Map(),
                      loadingRole: null,
                      loadingIndex: 0,
                    });
                    const activated = yield* activateSession(
                      sessionId,
                      threadInput.providerThread.appThreadId,
                    );
                    yield* Ref.set(activeSessionId, activated.sessionId);
                    yield* Ref.set(activeSessionSetup, activated);
                    const nextSelection = threadInput.modelSelection ?? input.modelSelection;
                    yield* configureSession(
                      activated,
                      nextSelection,
                      threadInput.runtimePolicy ?? input.runtimePolicy,
                    );
                    yield* Ref.set(activeSelection, nextSelection);
                  }
                  const now = yield* DateTime.now;
                  return {
                    ...threadInput.providerThread,
                    providerSessionId: input.providerSessionId,
                    status: "idle" as const,
                    updatedAt: now,
                  };
                }),
              );
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterResumeThreadError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          startTurn,
          steerTurn: (turnInput) =>
            Effect.fail(
              new ProviderAdapterSteerRunUnsupportedError({
                driver,
                providerThreadId: turnInput.providerThread.id,
              }),
            ),
          interruptTurn: Effect.fn("AcpAdapterV2.interruptTurn")(
            function* (turnInput: ProviderAdapterV2InterruptInput) {
              return yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  yield* restore(runtimeTransitionPermit.take(1));
                  return yield* Effect.gen(function* () {
                    const transition = yield* Effect.gen(function* () {
                      const interruptContext = yield* Ref.get(activeTurn);
                      // Settled steering restart: the native prompt already
                      // returned and this is not a user Stop, so keep the
                      // process (and its background subagents) alive instead
                      // of hard-killing it. The turn still terminalizes below.
                      const softSteerCandidate =
                        flavor.preserveRuntimeOnSettledInterrupt === true &&
                        turnInput.requestRuntimeRestart !== true &&
                        interruptContext?.providerTurnId === turnInput.providerTurnId;
                      // Settlement is read under the callback permit after
                      // draining admitted responses: the native prompt can have
                      // returned on the wire while its completion callback has
                      // not yet run, and a cancel sent in that window is exactly
                      // what settled-soft mode exists to avoid. Also treat the
                      // turn as settled when the wire signal is already done
                      // (non-blocking; do not await under the permit).
                      let settledSoftInterrupt = false;
                      if (softSteerCandidate && interruptContext !== null) {
                        const promptSettledUnderPermit = yield* runtimeCallbackPermit.withPermit(
                          awaitAdmittedNativeResponses.pipe(
                            Effect.andThen(
                              Effect.sync(() => interruptContext.promptSettled === true),
                            ),
                          ),
                        );
                        const wireSettled = yield* Deferred.isDone(
                          interruptContext.promptWireSettled,
                        );
                        settledSoftInterrupt = promptSettledUnderPermit || wireSettled;
                      }
                      const restartRuntime =
                        !settledSoftInterrupt &&
                        (turnInput.requestRuntimeRestart === true ||
                          flavor.restartRuntimeOnEveryInterrupt === true);
                      const hardRestart =
                        restartRuntime && flavor.terminateRuntimeProcessGroupOnInterrupt === true;
                      if (hardRestart) {
                        const teardownState = yield* Ref.get(runtimeTeardownState);
                        if (teardownState._tag === "Failed") {
                          return yield* teardownState.error;
                        }
                        if (teardownState._tag === "InProgress") {
                          // Concurrent Stop/restart: wait for the in-flight hard
                          // teardown instead of failing the durable effect.
                          yield* Effect.logInfo(
                            "ACP interrupt awaiting in-progress hard teardown",
                            {
                              driver,
                              providerTurnId: turnInput.providerTurnId,
                            },
                          );
                          yield* Deferred.await(teardownState.completed);
                          return undefined;
                        }
                      }
                      const context = interruptContext;
                      if (context?.providerTurnId !== turnInput.providerTurnId) {
                        // A soft steering interrupt can clear the turn while
                        // intentionally leaving the process alive. A queued user
                        // Stop must still contain that orphan runtime. With a
                        // different live turn active this stays a pure no-op
                        // success instead: quarantine and teardown are
                        // session-global and would maim the replacement turn.
                        const containOrphanRuntime =
                          context === null &&
                          hardRestart &&
                          turnInput.requestRuntimeRestart === true;
                        // Transport death or a prior Stop already cleared the
                        // turn. Failing here caused effect-worker retries while
                        // the process was already gone; treat as success.
                        yield* Effect.logWarning(
                          containOrphanRuntime
                            ? "ACP Stop raced a soft interrupt that cleared the turn; containing the orphan runtime"
                            : "ACP interrupt raced transport teardown or a prior Stop; treating as already interrupted",
                          {
                            driver,
                            requestedProviderTurnId: turnInput.providerTurnId,
                            activeProviderTurnId: context?.providerTurnId ?? null,
                            hardRestart,
                            requestRuntimeRestart: turnInput.requestRuntimeRestart === true,
                            teardownState: (yield* Ref.get(runtimeTeardownState))._tag,
                          },
                        );
                        if (containOrphanRuntime) {
                          const teardownBarrier = yield* Deferred.make<
                            void,
                            ProviderAdapterProtocolError
                          >();
                          yield* runtimeCallbackPermit.withPermit(
                            Effect.gen(function* () {
                              yield* awaitAdmittedNativeResponses;
                              const stoppedGeneration = yield* Ref.get(runtimeCallbackGeneration);
                              yield* quarantineNativeTransportAtGeneration(stoppedGeneration);
                              yield* Ref.set(runtimeTeardownState, {
                                _tag: "InProgress",
                                completed: teardownBarrier,
                              });
                              yield* Ref.update(
                                runtimeCallbackGeneration,
                                (generation) => generation + 1,
                              );
                            }),
                          );
                          // Capture before quarantineStoppedRun clears carryover.
                          const orphanCarryover = yield* Ref.getAndSet(carryoverSubagents, null);
                          yield* quarantineStoppedRun();
                          // Match the main hard-restart path: cancel pending
                          // approvals/elicitations after quarantine, before kill.
                          yield* cancelPendingRuntimeRequests();
                          yield* terminalizeCarryoverSubagents(orphanCarryover);
                          if (runtime.terminateProcessGroup === undefined) {
                            const error = new ProviderAdapterProtocolError({
                              driver,
                              detail:
                                "ACP runtime does not expose its required process-group teardown; the session is poisoned",
                            });
                            yield* Ref.set(runtimeTeardownState, { _tag: "Failed", error });
                            yield* Deferred.fail(teardownBarrier, error).pipe(Effect.ignore);
                            return yield* error;
                          }
                          const teardownExit = yield* runtime.terminateProcessGroup.pipe(
                            Effect.exit,
                          );
                          if (Exit.isFailure(teardownExit)) {
                            const error = new ProviderAdapterProtocolError({
                              driver,
                              detail:
                                "ACP orphan runtime process-group teardown failed; the session is poisoned",
                              payload: Cause.squash(teardownExit.cause),
                            });
                            yield* Ref.set(runtimeTeardownState, { _tag: "Failed", error });
                            yield* Deferred.fail(teardownBarrier, error).pipe(Effect.ignore);
                            return yield* error;
                          }
                          yield* Ref.set(runtimeRestartRequired, true);
                          yield* Ref.set(runtimeTeardownState, { _tag: "Idle" });
                          yield* Deferred.succeed(teardownBarrier, undefined).pipe(Effect.ignore);
                        }
                        return undefined;
                      }
                      const teardownBarrier = hardRestart
                        ? yield* Deferred.make<void, ProviderAdapterProtocolError>()
                        : null;
                      if (teardownBarrier !== null) {
                        yield* runtimeCallbackPermit.withPermit(
                          Effect.gen(function* () {
                            yield* awaitAdmittedNativeResponses;
                            const stoppedGeneration = yield* Ref.get(runtimeCallbackGeneration);
                            yield* quarantineNativeTransportAtGeneration(stoppedGeneration);
                            yield* Ref.set(runtimeTeardownState, {
                              _tag: "InProgress",
                              completed: teardownBarrier,
                            });
                            yield* Ref.update(
                              runtimeCallbackGeneration,
                              (generation) => generation + 1,
                            );
                            yield* (
                              options.testHooks?.afterHardTeardownTransportDrained?.() ??
                                Effect.void
                            );
                          }),
                        );
                      }
                      return {
                        context,
                        restartRuntime,
                        hardRestart,
                        teardownBarrier,
                        settledSoftInterrupt,
                      };
                    });
                    // Concurrent hard teardown already completed above.
                    if (transition === undefined) return;
                    const {
                      context,
                      restartRuntime,
                      hardRestart,
                      teardownBarrier,
                      settledSoftInterrupt,
                    } = transition;
                    const poisonTeardown = Effect.fnUntraced(function* (
                      detail: string,
                      payload?: unknown,
                    ) {
                      const error = new ProviderAdapterProtocolError({
                        driver,
                        detail,
                        ...(payload === undefined ? {} : { payload }),
                      });
                      yield* Ref.set(runtimeTeardownState, { _tag: "Failed", error });
                      yield* Deferred.fail(teardownBarrier!, error).pipe(Effect.ignore);
                      return error;
                    });
                    const runTransition = Effect.gen(function* () {
                      context.interrupted = true;
                      // Quarantine only when this run is discarded (user Stop /
                      // hard process kill). Soft in-process restarts must keep
                      // carryoverSubagents so a still-running subagent can
                      // complete into the replacement turn.
                      if (hardRestart || turnInput.requestRuntimeRestart === true) {
                        yield* quarantineStoppedRun();
                      }
                      yield* cancelPendingRuntimeRequests();
                      // Finalize before process-group kill so projection/UI cannot
                      // lag a dead transport, and concurrent interrupt effects see
                      // activeTurn cleared (idempotent success) rather than racing.
                      if (
                        (hardRestart || context.promptSettled || settledSoftInterrupt) &&
                        !context.finalized
                      ) {
                        // hardRestart: always terminalize locally.
                        // promptSettled / settledSoftInterrupt (incl. wire-settled):
                        // native prompt already returned; only deferred background
                        // work remains, so session/cancel has nothing to acknowledge.
                        yield* finalizeTurn(context, "interrupted");
                      }
                      if (hardRestart) {
                        if (runtime.terminateProcessGroup === undefined) {
                          return yield* poisonTeardown(
                            "ACP runtime does not expose its required process-group teardown; the session is poisoned",
                          ).pipe(Effect.flatMap(Effect.fail));
                        }
                        const teardownExit = yield* runtime.terminateProcessGroup!.pipe(
                          Effect.exit,
                        );
                        if (Exit.isFailure(teardownExit)) {
                          return yield* poisonTeardown(
                            "ACP runtime process-group teardown failed; the session is poisoned",
                            Cause.squash(teardownExit.cause),
                          ).pipe(Effect.flatMap(Effect.fail));
                        }
                        // Process group is gone; the next turn must spawn a
                        // replacement even if the flavor only set hardRestart
                        // without restartRuntimeAfterInterrupt.
                        yield* Ref.set(runtimeRestartRequired, true);
                        yield* Ref.set(runtimeTeardownState, { _tag: "Idle" });
                        yield* Deferred.succeed(teardownBarrier!, undefined).pipe(Effect.ignore);
                      } else {
                        // Settled soft interrupt: the native prompt already
                        // returned, so session/cancel has nothing to
                        // acknowledge and would only threaten still-running
                        // background subagents. Skip it and leave the runtime
                        // untouched for the replacement turn.
                        if (!settledSoftInterrupt) {
                          yield* runtime.cancel;
                        }
                        if (restartRuntime && flavor.restartRuntimeAfterInterrupt === true) {
                          yield* Ref.set(runtimeRestartRequired, true);
                        }
                      }
                      const stopped = yield* Deferred.await(context.completed).pipe(
                        Effect.timeoutOption("10 seconds"),
                      );
                      if (Option.isNone(stopped)) {
                        if (!context.finalized) {
                          yield* finalizeTurn(context, "interrupted");
                        }
                        return yield* new ProviderAdapterProtocolError({
                          driver,
                          detail: `ACP provider turn ${turnInput.providerTurnId} did not acknowledge cancellation before the interrupt timeout`,
                        });
                      }
                    });
                    if (!hardRestart) {
                      return yield* restore(runTransition);
                    }
                    return yield* runTransition.pipe(
                      Effect.catchCause((cause) =>
                        Effect.gen(function* () {
                          const state = yield* Ref.get(runtimeTeardownState);
                          if (state._tag === "InProgress") {
                            yield* poisonTeardown(
                              "ACP hard teardown failed unexpectedly; the session is poisoned",
                              Cause.squash(cause),
                            );
                          }
                          return yield* Effect.failCause(cause);
                        }),
                      ),
                    );
                  }).pipe(Effect.ensuring(runtimeTransitionPermit.release(1)));
                }),
              );
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                yield* restore(runtimeTransitionPermit.take(1));
                return yield* Effect.gen(function* () {
                  yield* awaitRuntimeTeardown();
                  const generation = yield* Ref.get(runtimeCallbackGeneration);
                  const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
                    String(requestInput.requestId),
                  );
                  if (pending === undefined || pending.generation !== generation) {
                    return yield* new ProviderAdapterProtocolError({
                      driver,
                      detail: `No pending ACP runtime request ${requestInput.requestId}`,
                    });
                  }
                  const settled =
                    pending.type === "user_input"
                      ? yield* Deferred.succeed(pending.answers, requestInput.answers ?? null)
                      : requestInput.decision === undefined
                        ? yield* new ProviderAdapterProtocolError({
                            driver,
                            detail: `ACP approval request ${requestInput.requestId} requires a decision`,
                          })
                        : yield* Deferred.succeed(pending.decision, requestInput.decision);
                  if (!settled) {
                    return yield* new ProviderAdapterProtocolError({
                      driver,
                      detail: `ACP runtime request ${requestInput.requestId} was already resolved`,
                    });
                  }
                  yield* awaitNativeResponseAcknowledgements([
                    [pending.transportRequestId, pending.nativeResponseAcknowledgement],
                  ]);
                  yield* Deferred.await(pending.nativeResponseAcknowledgement);
                }).pipe(Effect.ensuring(runtimeTransitionPermit.release(1)));
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRuntimeRequestResponseError({
                    driver,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
          readThreadSnapshot: Effect.fn("AcpAdapterV2.readThreadSnapshot")(
            function* (snapshotInput) {
              return yield* runtimeTransitionPermit.withPermit(
                Effect.gen(function* () {
                  yield* awaitRuntimeTeardown();
                  yield* restartRuntimeAfterTeardownIfRequired();
                  const sessionId = nativeThreadId(driver, snapshotInput.providerThread);
                  if ((yield* Ref.get(activeSessionId)) !== sessionId) {
                    if (!capabilities.threads.canReadThreadSnapshot) {
                      return yield* new ProviderAdapterProtocolError({
                        driver,
                        detail: "ACP driver does not support session/load snapshots",
                      });
                    }
                    yield* Ref.set(snapshot, {
                      order: [],
                      messages: new Map(),
                      loadingRole: null,
                      loadingIndex: 0,
                    });
                    const activated = yield* runtime.loadSession(sessionId, {
                      mcpServers: acpMcpServers(snapshotInput.providerThread.appThreadId),
                    });
                    yield* Ref.set(activeSessionId, activated.sessionId);
                    yield* Ref.set(activeSessionSetup, activated);
                    yield* Ref.set(activeSelection, null);
                  }
                  const state = yield* Ref.get(snapshot);
                  const now = yield* DateTime.now;
                  return {
                    providerThread: {
                      ...snapshotInput.providerThread,
                      providerSessionId: input.providerSessionId,
                      status: "idle" as const,
                      updatedAt: now,
                    },
                    providerTurns: [...(yield* Ref.get(providerTurns)).values()],
                    messages: state.order.flatMap((key) => {
                      const message = state.messages.get(key);
                      return message === undefined ? [] : [message];
                    }),
                    runtimeRequests: [],
                    providerPayload: { protocol: ACP_PROTOCOL, sessionId },
                  };
                }),
              );
            },
            (effect, snapshotInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterReadThreadSnapshotError({
                      driver,
                      providerThreadId: snapshotInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          rollbackThread: (rollbackInput) =>
            Effect.fail(
              new ProviderAdapterRollbackThreadError({
                driver,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause: "ACP does not define conversation rollback.",
              }),
            ),
          forkThread: Effect.fn("AcpAdapterV2.forkThread")(
            function* (forkInput) {
              return yield* runtimeTransitionPermit.withPermit(
                Effect.gen(function* () {
                  yield* awaitRuntimeTeardown();
                  yield* restartRuntimeAfterTeardownIfRequired();
                  if (!capabilities.threads.canForkThread) {
                    return yield* new ProviderAdapterProtocolError({
                      driver,
                      detail: "ACP driver did not negotiate session/fork",
                    });
                  }
                  if (forkInput.providerTurnId !== undefined) {
                    return yield* new ProviderAdapterProtocolError({
                      driver,
                      detail: "ACP session/fork can only fork the current session head",
                    });
                  }
                  const sourceSessionId = nativeThreadId(driver, forkInput.sourceProviderThread);
                  const forked = yield* runtime.forkSession(sourceSessionId, {
                    mcpServers: acpMcpServers(forkInput.targetThreadId),
                  });
                  yield* Ref.set(activeSessionId, forked.sessionId);
                  yield* Ref.set(activeSessionSetup, forked);
                  yield* Ref.set(activeSelection, null);
                  const now = yield* DateTime.now;
                  return makeProviderThread({
                    driver,
                    providerInstanceId: options.instanceId,
                    idAllocator,
                    appThreadId: forkInput.targetThreadId,
                    providerSessionId: input.providerSessionId,
                    nativeThreadId: forked.sessionId,
                    ...(forkInput.ownerNodeId === undefined
                      ? {}
                      : { ownerNodeId: forkInput.ownerNodeId }),
                    forkedFrom: {
                      providerThreadId: forkInput.sourceProviderThread.id,
                      ...(forkInput.providerTurnId === undefined
                        ? {}
                        : { providerTurnId: forkInput.providerTurnId }),
                    },
                    now,
                  });
                }),
              );
            },
            (effect, forkInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterForkThreadError({
                      driver,
                      providerThreadId: forkInput.sourceProviderThread.id,
                      cause,
                    }),
                ),
              ),
          ),
        };
        return sessionRuntime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
}

export type AcpAdapterV2Env = FileSystem.FileSystem | IdAllocatorV2;
