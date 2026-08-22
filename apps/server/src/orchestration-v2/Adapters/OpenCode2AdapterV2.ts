/**
 * OpenCode 2.x ("OpenCode 2") orchestration adapter.
 *
 * A separate adapter rather than a mode of `OpenCodeAdapterV2`: 2.x shares the
 * vendor name and the tool vocabulary with 1.x and nothing else. Concretely,
 *
 *   - the wire surface is `/api/*` only, reached through `@opencode-ai/client`;
 *   - every response is double-wrapped, `{ data: { data: … } }`, because the
 *     SDK's own `.data` is the parsed body and the body carries its own
 *     envelope;
 *   - the event vocabulary is a flat stream of typed lifecycle events
 *     (`session.step.*` / `session.text.*`) rather than 1.x's
 *     `message.part.updated` carrying a whole part object;
 *   - the model binds at session create via `ModelRef`, not per prompt;
 *   - permission asks can still arrive under the legacy `permission.asked`
 *     name, but replies always use the `/api` session-scoped
 *     `client.session.*` / `client.permission.*` routes. Threads attach to one
 *     T3-owned OpenCode 2 process per binary and managed data home. T3 MCP is
 *     registered after connect with `mcp.add`.
 *
 * `live-scenarios/tests/opencode2-drive-probe.mjs` in the parent workspace is
 * the executable statement of this contract against a real binary.
 *
 * Event stream durability: OpenCode 2 documents `/api/event` as volatile (a
 * slow consumer overflows and fails the stream). This adapter keeps protocol
 * logging off the pull path, resubscribes after stream failure or a stall
 * while a turn is active, and force-finalizes on Stop when the interrupt
 * terminal event never arrives.
 *
 * @module orchestration-v2/Adapters/OpenCode2AdapterV2
 */
import {
  isSessionNotFoundError,
  isShellNotFoundError,
  type AgentInfo,
  type ModelInfo,
  type SessionInfo,
  type SessionMessageInfo,
  type V2Event,
} from "@opencode-ai/client";
import {
  normalizeOpenCode2WireType,
  openCode2StepFinishSettlesTurn,
  openCode2WireAdmittedInput,
  openCode2WireCallID,
  openCode2WireCreatedMs,
  openCode2WireData,
  openCode2WireErrorCode,
  openCode2WireErrorMessage,
  openCode2WireInputID,
  openCode2WireSession,
  openCode2WireSessionID,
  openCode2WireTextDelta,
  type OpenCode2WireSession as OpenCode2NativeSession,
  openCode2WireToolMetadata,
  openCode2WireToolName,
  unwrapOpenCode2Payload,
} from "./openCode2Wire.ts";

type AgentInfoV2 = AgentInfo;
type SessionInfoV2 = SessionInfo;
type PromptInputFileAttachment = {
  readonly uri: string;
  readonly name?: string;
};
type QuestionV2Info = {
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiple?: boolean;
};
type SessionPendingInfo = {
  readonly sessionID: string;
  readonly type?: string;
  readonly id?: string;
};
/**
 * Shape of `form.created` payloads on current 2.x builds. The beta SDK does not
 * type this event, but the question tool surfaces here (not via question.v2.asked).
 */
type FormInfo = {
  readonly id: string;
  readonly title: string;
  readonly sessionID?: string;
  readonly fields: ReadonlyArray<{
    readonly key: string;
    readonly title?: string;
    readonly description?: string;
    readonly type?: string;
    readonly custom?: boolean;
    readonly options?: ReadonlyArray<{
      readonly label: string;
      readonly value: string;
      readonly description?: string;
    }>;
  }>;
};
type ShellInfoV2 = {
  readonly id: string;
  readonly status: "running" | "exited" | "timeout" | "killed" | string;
  readonly command?: string;
  readonly exit?: number;
  readonly metadata: { readonly sessionID?: string; readonly [key: string]: unknown };
  readonly time?: { readonly started?: number; readonly completed?: number };
};
type McpServer = {
  readonly name: string;
  readonly status: { readonly status?: string } | string;
};
function mcpServerStatus(server: McpServer): string {
  return typeof server.status === "string" ? server.status : (server.status?.status ?? "missing");
}
type WireEvent = {
  readonly type: string;
  readonly id?: string;
  readonly created?: number;
  readonly data?: unknown;
};
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { extractOpenCode2ExecuteT3McpToolName } from "@t3tools/shared/t3McpToolPresentation";
import {
  type ChatAttachment,
  type ModelSelection,
  type OpenCode2Settings,
  OpenCode2Settings as OpenCode2SettingsSchema,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeURL from "node:url";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import {
  structuralProtocolMethod,
  summarizeNativeProtocolPayload,
} from "../../provider/NativeProtocolLogging.ts";
import {
  normalizeOpenCode2Variant,
  OPENCODE2_AUTO_AGENT,
  OpenCode2Runtime,
  OpenCode2RuntimeError,
  runOpenCode2Sdk,
  type OpenCode2RuntimeOperation,
} from "../../provider/opencode2Runtime.ts";
import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/T3OrchestrationInstructions.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { applyOpenCode2ProviderEnvironment } from "../../provider/OpenCode2ProviderEnvironment.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import { makeProviderFailure, makeProviderFailureTurnItem } from "../ProviderFailure.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "../ProviderContinuationRequests.ts";
import {
  type ProviderInteractionModeReflection,
  ProviderInteractionModeReflections,
} from "../ProviderInteractionModeReflections.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
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
  ProviderAdapterSteerRunError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
// Tool names, permission actions, and the terminal-status mapping are the one
// thing 1.x and 2.x genuinely share, so these classifiers stay in one place
// rather than drifting between two copies.
import {
  openCodeBoundaryAfterProviderTurn,
  openCodePermissionRequestKind,
  openCodePermissionRules,
  openCodeToolProjectionKind,
  terminalToolStatus,
} from "./OpenCodeAdapterV2.ts";

export const OPENCODE2_PROVIDER = ProviderDriverKind.make("opencode2");
export const OPENCODE2_DRIVER_KIND = OPENCODE2_PROVIDER;
export const OPENCODE2_SDK_PROTOCOL = "opencode2-sdk.sse" as const;
export const OPENCODE2_RETIRED_SUPPRESS_WAKE_LIMIT = 16;
export const OPENCODE2_PROMOTED_INPUT_ID_LIMIT = 64;
/**
 * OpenCode 2 documents `/api/event` as volatile: a slow consumer overflows and
 * fails the stream. The adapter must keep the pull path hot and resubscribe.
 */
export const OPENCODE2_EVENT_STALL_MS = 30_000;
export const OPENCODE2_EVENT_STALL_CHECK_MS = 5_000;
export const OPENCODE2_EVENT_STREAM_MAX_FAILURES = 5;
/** Cap stall-driven resubscribes so a stuck turn cannot thrash subscribe forever. */
export const OPENCODE2_EVENT_STALL_MAX_RESUBSCRIBES = 2;
export const OPENCODE2_COMPACTION_BUFFER_TOKENS = 20_000;
export const OPENCODE2_COMPACTION_MAX_OUTPUT_RESERVE = 32_000;
export const OPENCODE2_EVENT_RESUBSCRIBE_DELAY_MS = 250;
export const OPENCODE2_EVENT_PENDING_RESUBSCRIBE_DELAY_MS = 5_000;
export const OPENCODE2_DEFERRED_CHILD_EVENT_LIMIT = 512;
/**
 * Require this many consecutive clean SSE EOFs while a turn is active, plus a
 * full stall window, before failing it. The elapsed guard keeps short proxy
 * recycle bursts harmless while still bounding an endless clean-close loop.
 * Idle reconnects and replay parking are not counted.
 */
export const OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES = 3;
/** Bound Stop so a wedged `session.interrupt` HTTP call cannot hang the UI. */
export const OPENCODE2_INTERRUPT_REQUEST_TIMEOUT_MS = 5_000;
/**
 * After interrupt is requested, wait this long for SSE
 * `session.execution.interrupted` before force-finalizing the turn. Cursor uses
 * the same pattern; without it a dead event stream leaves Stop inert.
 */
export const OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;
export const OPENCODE2_INTERRUPT_SETTLE_POLL_MS = 100;
export const OPENCODE2_RUNTIME_REQUEST_SETTLE_TIMEOUT_MS = 5_000;
export const OPENCODE2_RUNTIME_REQUEST_DEDUPE_PER_SESSION_LIMIT = 1_024;
const DEFAULT_OPENCODE2_SETTINGS = Schema.decodeSync(OpenCode2SettingsSchema)({});
const OPENCODE2_T3_MCP_NAME = "t3-code";
const OPENCODE2_T3_INSTRUCTION_KEY = "t3-code.orchestration";

/**
 * 2.x keeps 1.x's durable session/message identifiers and adds a durable
 * execution, but it still exposes no first-class turn object: the admitted
 * session input is the closest native correlation point, and the
 * `session.execution.*` terminal events are the authoritative settle signal.
 *
 * Native subagent sessions expose their parent session through
 * `session.created.info.parentID`. The parent subagent tool also reports the
 * child session id in its progress or terminal metadata, so the adapter can
 * project durable child lineage and route child requests through the root
 * turn's runtime policy.
 */
export const OpenCode2ProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
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
    exposesNativeTurnId: false,
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
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
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
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: true,
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
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

type TerminalTurnStatus = Extract<
  OrchestrationV2ProviderTurn["status"],
  "completed" | "interrupted" | "failed" | "cancelled"
>;

type OpenCode2ToolStatus = "pending" | "running" | "completed" | "error";

interface OpenCode2TextPart {
  readonly kind: "text" | "reasoning";
  readonly id: string;
  readonly startedAt: DateTime.Utc;
  text: string;
  completed: boolean;
}

interface OpenCode2ToolPart {
  readonly kind: "tool";
  readonly id: string;
  readonly callId: string;
  readonly startedAt: DateTime.Utc;
  name: string;
  input: Record<string, unknown>;
  inputText: string;
  output: string | undefined;
  structured: Record<string, unknown> | undefined;
  status: OpenCode2ToolStatus;
  errorMessage: string | undefined;
  completedAt: DateTime.Utc | null;
}

interface OpenCode2ShellProjection {
  readonly shellId: string;
  readonly state: OpenCode2ThreadState;
  readonly turn: ActiveOpenCode2Turn;
  readonly part: OpenCode2ToolPart;
  readonly location: SessionInfoV2["location"];
  status: ShellInfoV2["status"];
}

interface OpenCode2Compaction {
  readonly id: string;
  readonly startedAt: DateTime.Utc;
  summary: string;
  status: "running" | "completed" | "failed" | "cancelled";
  completedAt: DateTime.Utc | null;
  triggerReason: "auto" | "manual" | "unknown";
  diagnostics: OpenCode2CompactionDiagnostics | null;
}

interface OpenCode2TokenUsage {
  readonly total: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

interface OpenCode2CompactionDiagnostics {
  readonly usedTokenCount: number;
  readonly inputTokenCount: number;
  readonly inputLimit?: number;
  readonly contextLimit: number;
  readonly outputReserve: number;
  readonly triggerThreshold: number;
  readonly triggerReason: "auto" | "manual" | "unknown";
}

type OpenCode2Part = OpenCode2TextPart | OpenCode2ToolPart;

interface ActiveOpenCode2Turn {
  readonly isRoot: boolean;
  readonly providerBufferedContinuation: boolean;
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2ExecutionNode["runId"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["rootNodeId"];
  readonly appThread: OrchestrationV2AppThread;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2TurnInput["runtimePolicy"];
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly runOrdinal: number;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  readonly parts: Map<string, OpenCode2Part>;
  readonly toolIdsByCallId: Map<string, string>;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  nextItemOrdinal: number;
  nativeInputId: string | null;
  activeCompaction: OpenCode2Compaction | null;
  executionStarted: boolean;
  interrupted: boolean;
  finalized: boolean;
  terminalStatus: TerminalTurnStatus | null;
  providerRetry: OpenCode2ProviderRetry | null;
  pendingExecutionFailure: OrchestrationV2ProviderFailure | null;
}

interface OpenCode2SubagentContext {
  readonly nativeItemId: string;
  readonly nodeId: OrchestrationV2Subagent["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly parentState: OpenCode2ThreadState;
  readonly parentTurn: ActiveOpenCode2Turn;
  readonly startedAt: DateTime.Utc;
  completedAt: DateTime.Utc | null;
  prompt: string;
  title: string | null;
  model: string | null;
  childSessionId: string | null;
  childThreadId: ThreadId | null;
  childProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
  status: OrchestrationV2Subagent["status"];
  progress: string | undefined;
  result: string | null;
}

interface OpenCode2ProviderRetry {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly scheduledUntilAtMs: number;
}

type OpenCode2PostSettleWakeDisposition = "replay" | "suppress";
type OpenCode2PostSettleWakePhase = "pending" | "executing" | "ready";

interface OpenCode2ExecutionOwnership {
  readonly inputIds: Set<string>;
  claimedByPromotion: boolean;
}

interface OpenCode2EventHandlingContext {
  readonly deferredChildReplay?: boolean;
  readonly replayWakeInputId?: string;
}

interface OpenCode2PostSettleWake {
  readonly inputId: string;
  readonly events: Array<V2Event>;
  readonly disposition: OpenCode2PostSettleWakeDisposition;
  promotedAfterExecutionStarted: boolean;
  phase: OpenCode2PostSettleWakePhase;
}

/** Keep the newest retired suppression evidence in insertion order. */
export function pruneOpenCode2RetiredSuppressWakes(wakes: Map<string, unknown>): void {
  while (wakes.size > OPENCODE2_RETIRED_SUPPRESS_WAKE_LIMIT) {
    const oldestInputId = wakes.keys().next().value;
    if (oldestInputId === undefined) return;
    wakes.delete(oldestInputId);
  }
}

/** Keep recent promotion evidence for late admissions without unbounded state. */
export function pruneOpenCode2PromotedInputIds(inputIds: Set<string>): void {
  while (inputIds.size > OPENCODE2_PROMOTED_INPUT_ID_LIMIT) {
    const oldestInputId = inputIds.values().next().value;
    if (oldestInputId === undefined) return;
    inputIds.delete(oldestInputId);
  }
}

interface OpenCode2ThreadState {
  readonly nativeSessionId: string;
  location: SessionInfoV2["location"];
  providerThread: OrchestrationV2ProviderThread;
  appThread: OrchestrationV2AppThread | null;
  activeTurn: ActiveOpenCode2Turn | null;
  boundModel: string | null;
  boundVariant: string | null;
  boundAgent: string | null;
  lastAgentSelectedEventId: string | null;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: Map<string, OrchestrationV2RuntimeRequest>;
  readonly postSettleWakes: Array<OpenCode2PostSettleWake>;
  readonly retiredSuppressWakes: Map<string, OpenCode2PostSettleWake>;
  /**
   * Unclaimed promotion evidence. Ownership removes an id; unmatched ids
   * remain so a genuinely later admission can still claim it, with a bounded
   * insertion-order window preventing stale ids from growing state forever.
   */
  readonly promotedInputIds: Set<string>;
  sawInputPromotion: boolean;
  /**
   * True after an interrupt whose `session.interrupt` RPC or shell removal
   * could not be confirmed: the native session may still be executing the
   * interrupted turn, so a follow-up turn must not reuse it. Cleared when a
   * native `session.execution.*` terminal settles an active turn (the event
   * proves the execution ended), and absent on the replacement session that
   * `ensureThread` creates after a quarantined resume fails.
   */
  quarantined: boolean;
  activeExecution: OpenCode2ExecutionOwnership | null;
  parentSubagent: OpenCode2SubagentContext | null;
  nextChildTurnOrdinal: number;
  latestTokenUsage: OpenCode2TokenUsage | null;
}

type OpenCode2RuntimeRequestSettlement = {
  readonly requestStatus: "resolved" | "cancelled";
  readonly itemStatus: "completed" | "cancelled";
  readonly rememberPermissionForSession: boolean;
};

interface OpenCode2RuntimeRequestProjection {
  readonly requestId: RuntimeRequestId;
  readonly nativeRequestId: string;
  readonly nativeSessionId: string;
  readonly state: OpenCode2ThreadState;
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2ExecutionNode["runId"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["rootNodeId"];
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
  readonly createdAt: DateTime.Utc;
  readonly ordinal: number;
  readonly permission?: {
    readonly action: string;
    readonly resources: ReadonlyArray<string>;
    readonly save: ReadonlyArray<string>;
  };
  readonly questions?: ReadonlyArray<QuestionV2Info>;
}

interface PendingOpenCode2Request extends OpenCode2RuntimeRequestProjection {
  authoritativeCancellation: boolean;
  readonly sourceTurn: ActiveOpenCode2Turn;
  readonly turn: ActiveOpenCode2Turn;
  /**
   * Present when the questions came from a form (`form.created`); index-aligned
   * with `questions`, and the reply must go through `session.form.reply`.
   */
  readonly formFieldKeys?: ReadonlyArray<string>;
  /** Index-aligned label-to-value maps for translating UI answers. */
  readonly formOptionValues?: ReadonlyArray<Readonly<Record<string, string>>>;
  responseSettlement: OpenCode2RuntimeRequestSettlement | null;
  responseSettlementConfirmed: boolean;
  readonly responseSettlementOutcome: Deferred.Deferred<void>;
  rememberedPermission: OpenCode2SessionPermission | null;
}

interface SettledOpenCode2RequestProjection extends OpenCode2RuntimeRequestProjection {
  authoritativeCancellation: boolean;
  readonly sourceProviderTurnId: OrchestrationV2ProviderTurn["id"];
  responseSettlement: OpenCode2RuntimeRequestSettlement | null;
  responseSettlementConfirmed: boolean;
  rememberedPermission: OpenCode2SessionPermission | null;
}

interface SettledOpenCode2Request {
  readonly pending: SettledOpenCode2RequestProjection;
  settlement: OpenCode2RuntimeRequestSettlement;
}

export function openCode2RuntimeRequestResponseSettlement(
  decision: ProviderApprovalDecision | undefined,
): OpenCode2RuntimeRequestSettlement {
  return {
    requestStatus: "resolved",
    itemStatus: decision === "decline" || decision === "cancel" ? "cancelled" : "completed",
    rememberPermissionForSession: decision === "acceptForSession",
  };
}

export function openCode2PermissionReplyStatus(reply: unknown): "resolved" | "cancelled" {
  return reply === "reject" ? "cancelled" : "resolved";
}

export function openCode2RuntimeRequestNativeKey(
  nativeSessionId: string,
  nativeRequestId: string,
): string {
  return `${nativeSessionId}\0${nativeRequestId}`;
}

export function openCode2RuntimeRequestEventId(data: unknown): string | undefined {
  return recordString(data, "requestID", "formID", "id");
}

export interface OpenCode2SessionPermission {
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
}

export type OpenCode2SessionPermissionStore = Map<string, Array<OpenCode2SessionPermission>>;

const openCode2SessionPermissionOwnership = new WeakMap<OpenCode2SessionPermission, number>();

export interface OpenCode2AdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenCode2Settings;
  readonly environment: NodeJS.ProcessEnv;
  readonly runtime: OpenCode2Runtime["Service"];
  readonly idAllocator: IdAllocatorV2Shape;
  readonly serverConfig: ServerConfig["Service"];
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly continuationRequests?: {
    readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  };
  readonly interactionModeReflections?: {
    readonly offer: (request: ProviderInteractionModeReflection) => Effect.Effect<void>;
  };
}

export function openCode2ForkEventPumpInScope<E, R>(input: {
  readonly scope: Scope.Scope;
  readonly abort: Effect.Effect<void>;
  readonly pump: Effect.Effect<void, E, R>;
  readonly afterFork?: Effect.Effect<void>;
}): Effect.Effect<void, never, R> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      yield* input.pump.pipe(Effect.interruptible, Effect.forkIn(input.scope));
      if (input.afterFork !== undefined) yield* input.afterFork;
      yield* Scope.addFinalizer(input.scope, input.abort);
    }),
  );
}

/**
 * OpenCode admits a background-child result as a synthetic root input. The
 * admission itself does not identify its execution boundary: an ordinary
 * input and multiple synthetic inputs may be admitted together, and a later
 * promotion event assigns one or more of them to an execution.
 */
export function openCode2IsPostSettleWakeAdmission(
  event: any,
  state: { readonly isChildSession: boolean },
): boolean {
  const type = normalizeOpenCode2WireType(String(event?.type ?? ""));
  if (type !== "session.input.admitted" || state.isChildSession) {
    return false;
  }
  const input = openCode2WireAdmittedInput(event);
  if (input === undefined || input === null) return false;
  if (
    typeof input === "object" &&
    "type" in input &&
    input.type !== undefined &&
    input.type !== "synthetic"
  ) {
    return false;
  }
  const data = recordValue(input, "data") ?? recordValue(input, "payload") ?? input;
  const source = recordString(recordValue(data, "metadata"), "source");
  const text = recordString(data, "text") ?? recordString(input, "text");
  return source !== undefined || /^\s*<(?:subagent|shell)\b/i.test(text ?? "");
}

/**
 * An interrupted provider-native child is terminal work, not a successful
 * background result for the parent's next turn. OpenCode reports that result
 * as a synthetic root input, so keep the cancellation boundary here rather
 * than teaching the generic continuation machinery about provider wire data.
 */
export function openCode2IsCancelledPostSettleWake(event: any): boolean {
  const type = normalizeOpenCode2WireType(String(event?.type ?? ""));
  if (type !== "session.input.admitted") return false;
  const input = openCode2WireAdmittedInput(event);
  if (input === undefined || input === null) return false;
  if (
    typeof input === "object" &&
    "type" in input &&
    input.type !== undefined &&
    input.type !== "synthetic"
  ) {
    return false;
  }
  const text =
    recordString(input, "text") ??
    recordString(recordValue(input, "data"), "text") ??
    recordString(recordValue(input, "payload"), "text") ??
    (typeof input === "string" ? input : undefined);
  // The completed wrapper shape comes from captured pre-existing OpenCode 2
  // replay data. The cancelled and interrupted values are inferred from
  // OpenCode behavior, not adapter behavior. An exact raw-payload capture
  // remains an explicit in-vivo gate before treating this as a contract.
  const value = text ?? "";
  return (
    /^\s*<subagent\b(?=[^>]*\sstate\s*=\s*["'](?:cancelled|interrupted)["'])[^>]*>/i.test(value) ||
    /^\s*<shell\b(?=[^>]*\sstate\s*=\s*["']error["'])[^>]*>\s*<\/shell>\s*$/i.test(value)
  );
}

export function openCode2EventEndsExecution(event: {
  readonly type: string;
  readonly data?: unknown;
}): boolean {
  const type = normalizeOpenCode2WireType(event.type);
  if (
    type === "session.execution.failed" ||
    type === "session.execution.interrupted" ||
    type === "session.idle"
  ) {
    return true;
  }
  if (type !== "session.execution.succeeded") {
    return false;
  }
  // session.step.ended aliases to succeeded. Intermediate
  // tool-call steps must not clear activeExecution or settle wakes.
  return openCode2StepFinishSettlesTurn(openCode2WireData(event).finish);
}

interface OpenCode2DeferredChildEventBuffer {
  readonly events: Array<unknown>;
  overflowed: boolean;
  terminalFallback: unknown | null;
}

/** @internal exported for tests */
export function makeOpenCode2DeferredChildEventBuffer(): OpenCode2DeferredChildEventBuffer {
  return { events: [], overflowed: false, terminalFallback: null };
}

function openCode2IsAuthoritativeExecutionTerminal(event: unknown): boolean {
  if (event === null || typeof event !== "object" || !("type" in event)) return false;
  const wire = event as WireEvent;
  const type = normalizeOpenCode2WireType(String(wire.type));
  if (type === "session.execution.interrupted") return true;
  return type !== "session.idle" && openCode2EventEndsExecution(wire);
}

function openCode2DeferredChildOverflowTerminal(sessionID: string): WireEvent {
  return {
    type: "session.execution.failed",
    data: {
      sessionID,
      error: {
        name: "DeferredChildEventOverflow",
        message: "OpenCode 2 deferred child events overflowed before the child was bound.",
      },
    },
  };
}

/**
 * Retain the earliest child lifecycle and one terminal fallback. Once the
 * prefix overflows, a synthetic failure guarantees bounded settlement; a
 * later authoritative execution terminal replaces it before replay.
 *
 * @internal exported for tests
 */
export function bufferOpenCode2DeferredChildEvent(
  buffer: OpenCode2DeferredChildEventBuffer,
  event: unknown,
  sessionID: string,
  limit = OPENCODE2_DEFERRED_CHILD_EVENT_LIMIT,
): boolean {
  if (buffer.events.length < limit) {
    buffer.events.push(event);
    return false;
  }

  const newlyOverflowed = !buffer.overflowed;
  buffer.overflowed = true;
  if (openCode2IsAuthoritativeExecutionTerminal(event)) {
    buffer.terminalFallback = event;
  } else if (buffer.terminalFallback === null) {
    buffer.terminalFallback = openCode2DeferredChildOverflowTerminal(sessionID);
  }
  return newlyOverflowed;
}

/** @internal exported for tests */
export function drainOpenCode2DeferredChildEvents(
  buffer: OpenCode2DeferredChildEventBuffer,
): ReadonlyArray<unknown> {
  return buffer.terminalFallback === null
    ? buffer.events
    : [...buffer.events, buffer.terminalFallback];
}

/**
 * Decide whether Stop should force-finalize after the interrupt request and
 * settle wait. Pure so unit tests can cover the Stop recovery path without a
 * live SSE consumer.
 *
 * @internal exported for tests
 */
export function openCode2ShouldForceInterruptFinalize(input: {
  readonly interrupted: boolean;
  readonly finalized: boolean;
  readonly stillActive: boolean;
  readonly waitedMs: number;
  readonly settleTimeoutMs: number;
}): boolean {
  return (
    input.interrupted &&
    !input.finalized &&
    input.stillActive &&
    input.waitedMs >= input.settleTimeoutMs
  );
}

/**
 * Whether the event subscription loop should abort the current SSE pull and
 * resubscribe. Pure for tests.
 *
 * @internal exported for tests
 */
export function openCode2ShouldResubscribeStalledStream(input: {
  readonly sessionAborted: boolean;
  readonly hasActiveTurn: boolean;
  readonly lastEventAgeMs: number;
  readonly stallMs: number;
}): boolean {
  if (input.sessionAborted || !input.hasActiveTurn) return false;
  return input.lastEventAgeMs >= input.stallMs;
}

export function openCode2ShouldChargeStallBudget(input: {
  readonly hasPendingRuntimeRequest: boolean;
  readonly hasInFlightPendingWork: boolean;
}): boolean {
  return !input.hasPendingRuntimeRequest && !input.hasInFlightPendingWork;
}

export function openCode2AllActiveTurnsAwaitRuntimeRequest(input: {
  readonly activeTurns: ReadonlyArray<{
    readonly nativeSessionId: string;
    readonly providerTurnId: string;
  }>;
  readonly pendingRequests: ReadonlyArray<{
    readonly nativeSessionId: string;
    readonly providerTurnId: string;
  }>;
}): boolean {
  return input.activeTurns.every((active) =>
    input.pendingRequests.some(
      (pending) =>
        pending.providerTurnId === active.providerTurnId ||
        pending.nativeSessionId === active.nativeSessionId,
    ),
  );
}

export function openCode2ShouldChargeStreamFailure(watchdogResubscribe: boolean): boolean {
  return !watchdogResubscribe;
}

/**
 * Whether a clean SSE EOF while a turn is active should spend the fail budget.
 * Local stall aborts already own {@link OPENCODE2_EVENT_STALL_MAX_RESUBSCRIBES}.
 * Explained quiet (in-flight shells/tools, pending user input) stays open so a
 * healthy long turn cannot die on volatile `/api/event` recycles.
 *
 * @internal exported for tests
 */
export function openCode2ShouldChargeCleanEofBudget(input: {
  readonly watchdogResubscribe: boolean;
  readonly hasPendingRuntimeRequest: boolean;
  readonly hasInFlightPendingWork: boolean;
}): boolean {
  if (input.watchdogResubscribe) return false;
  return openCode2ShouldChargeStallBudget({
    hasPendingRuntimeRequest: input.hasPendingRuntimeRequest,
    hasInFlightPendingWork: input.hasInFlightPendingWork,
  });
}

export function openCode2ProviderRetryIsScheduled(
  providerRetry: Pick<OpenCode2ProviderRetry, "scheduledUntilAtMs"> | null,
  nowMs: number,
): boolean {
  return providerRetry !== null && nowMs <= providerRetry.scheduledUntilAtMs;
}

/**
 * 17823 emits `session.step.failed` before `session.retry.scheduled` for a
 * still-retryable unknown finish. Hold that failure until a retry is
 * announced. Only idle or another execution.failed prove OpenCode stopped.
 * Stop and session.error keep their own handlers. Trailing usage or text
 * events must not settle it.
 * A failure that arrives after OpenCode already announced a retry for this
 * attempt is the exhausted case.
 */
export function openCode2ShouldHoldExecutionFailure(input: {
  readonly retryable: boolean | null;
  readonly hasAnnouncedRetry: boolean;
}): boolean {
  if (input.retryable !== true) return false;
  return !input.hasAnnouncedRetry;
}

export function openCode2EventSettlesHeldExecutionFailure(type: string): boolean {
  return type === "session.idle" || type === "session.execution.failed";
}

export function openCode2EventClearsHeldExecutionFailure(type: string): boolean {
  return type === "session.execution.succeeded";
}

export function openCode2HasInFlightPendingWork(input: {
  readonly toolStatuses: ReadonlyArray<OpenCode2ToolStatus>;
  readonly shellStatuses: ReadonlyArray<string>;
  readonly hasProviderRetry: boolean;
  readonly compactionStatus: OpenCode2Compaction["status"] | null;
  readonly subagentStatuses: ReadonlyArray<OrchestrationV2Subagent["status"]>;
}): boolean {
  return (
    input.toolStatuses.some((status) => status === "pending" || status === "running") ||
    input.shellStatuses.some((status) => status === "running") ||
    input.hasProviderRetry ||
    input.compactionStatus === "running" ||
    input.subagentStatuses.some(
      (status) =>
        status !== "completed" &&
        status !== "failed" &&
        status !== "cancelled" &&
        status !== "interrupted",
    )
  );
}

function nonNegativeInteger(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.floor(value));
}

export function openCode2TokenUsage(input: unknown): OpenCode2TokenUsage | null {
  const tokens = recordValue(input, "tokens");
  if (tokens === undefined) return null;
  const cache = recordValue(tokens, "cache");
  const usage = {
    total: nonNegativeInteger(recordNumber(tokens, "total")),
    input: nonNegativeInteger(recordNumber(tokens, "input")),
    output: nonNegativeInteger(recordNumber(tokens, "output")),
    reasoning: nonNegativeInteger(recordNumber(tokens, "reasoning")),
    cacheRead: nonNegativeInteger(recordNumber(cache, "read")),
    cacheWrite: nonNegativeInteger(recordNumber(cache, "write")),
  };
  return Object.values(usage).some((value) => value > 0) ? usage : null;
}

export function openCode2LastErrorAt(input: {
  readonly previousError: string | null;
  readonly previousErrorAt?: DateTime.Utc | null;
  readonly nextError: string | null;
  readonly updatedAt: DateTime.Utc;
}): DateTime.Utc | null {
  if (input.nextError === null) return null;
  if (input.nextError !== input.previousError) return input.updatedAt;
  return input.previousErrorAt ?? input.updatedAt;
}

export function openCode2CompactionDiagnostics(input: {
  readonly usage: OpenCode2TokenUsage | null;
  readonly limits: Pick<ModelInfo["limit"], "context" | "input" | "output"> | null;
  readonly reason: unknown;
}): OpenCode2CompactionDiagnostics | null {
  if (input.usage === null || input.limits === null) return null;
  const contextLimit = nonNegativeInteger(input.limits.context);
  const outputReserve = Math.min(
    nonNegativeInteger(input.limits.output),
    OPENCODE2_COMPACTION_MAX_OUTPUT_RESERVE,
  );
  const inputLimit = input.limits.input;
  const triggerThreshold =
    inputLimit === undefined
      ? Math.max(0, contextLimit - outputReserve)
      : Math.max(
          0,
          nonNegativeInteger(inputLimit) -
            Math.min(OPENCODE2_COMPACTION_BUFFER_TOKENS, outputReserve),
        );
  const usedTokenCount =
    input.usage.total > 0
      ? input.usage.total
      : input.usage.input + input.usage.output + input.usage.cacheRead + input.usage.cacheWrite;
  return {
    usedTokenCount,
    inputTokenCount: input.usage.input,
    ...(inputLimit === undefined ? {} : { inputLimit: nonNegativeInteger(inputLimit) }),
    contextLimit,
    outputReserve,
    triggerThreshold,
    triggerReason: input.reason === "auto" || input.reason === "manual" ? input.reason : "unknown",
  };
}

function openCode2CompactionReason(input: unknown): "auto" | "manual" | "unknown" {
  const reason = recordString(input, "reason");
  return reason === "auto" || reason === "manual" ? reason : "unknown";
}

export function openCode2PendingItemsFromList(input: unknown): ReadonlyArray<SessionPendingInfo> {
  if (!Array.isArray(input)) return [];
  const items: SessionPendingInfo[] = [];
  for (const item of input) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const sessionID = record.sessionID;
    if (typeof sessionID !== "string" || sessionID.length === 0) continue;
    items.push({
      sessionID,
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      ...(typeof record.type === "string" ? { type: record.type } : {}),
    });
  }
  return items;
}

export const openCode2PendingWorkForSession = Effect.fnUntraced(function* (input: {
  readonly sessionID: string;
  readonly pending: Effect.Effect<ReadonlyArray<SessionPendingInfo>, OpenCode2RuntimeError>;
  readonly shells: Effect.Effect<ReadonlyArray<ShellInfoV2>, OpenCode2RuntimeError>;
}) {
  const pending = yield* Effect.result(input.pending);
  const shells = yield* Effect.result(input.shells);
  if (
    pending._tag === "Success" &&
    pending.success.some((item) => item.sessionID === input.sessionID)
  ) {
    return true;
  }
  if (
    shells._tag === "Success" &&
    shells.success.some(
      (shell) => shell.status === "running" && shell.metadata?.sessionID === input.sessionID,
    )
  ) {
    return true;
  }
  if (pending._tag === "Failure" && shells._tag === "Failure") {
    return yield* Effect.fail(pending.failure);
  }
  return false;
});

export function openCode2ToolNeedsTerminalOverride(
  part: Pick<OpenCode2ToolPart, "status" | "errorMessage">,
  terminal: TerminalTurnStatus,
): boolean {
  if (part.status === "pending" || part.status === "running") return true;
  return (
    terminal === "interrupted" &&
    part.status === "error" &&
    part.errorMessage === "Tool execution interrupted"
  );
}

type OpenCode2SessionErrorData = {
  sessionID?: string;
  error?: { name?: string; message?: string; type?: string; data?: unknown };
};

export function openCode2SessionErrorMessage(data: OpenCode2SessionErrorData): string {
  const error = data.error;
  if (error === undefined) return "OpenCode 2 reported a session error.";
  return (
    recordString(error.data, "message") ??
    (typeof error.message === "string" && error.message.length > 0 ? error.message : undefined) ??
    (typeof error.name === "string" && error.name.length > 0 ? error.name : undefined) ??
    "OpenCode 2 reported a session error."
  );
}

export function openCode2ProviderErrorStatus(input: unknown): number | null {
  const error = recordValue(input, "error") ?? input;
  const data = recordValue(error, "data");
  return (
    recordNumber(error, "statusCode", "status") ??
    recordNumber(data, "statusCode", "status") ??
    null
  );
}

export function openCode2SessionErrorStatus(
  data: OpenCode2SessionErrorData,
  interrupted: boolean,
): TerminalTurnStatus {
  return interrupted || data.error?.name === "MessageAbortedError" ? "interrupted" : "failed";
}

export function openCode2ProviderFailure(input: {
  readonly message: string;
  readonly code: string | null;
  readonly statusCode?: number | null;
  readonly hasProviderRetry?: boolean;
}): OrchestrationV2ProviderFailure {
  const evidence = `${input.code ?? ""} ${input.statusCode ?? ""} ${input.message}`;
  if (
    input.code === "Integration.Authorization" ||
    input.code === "ProviderAuthError" ||
    input.statusCode === 401
  ) {
    const status = /\b401\b/.test(evidence) ? " (HTTP 401)" : "";
    return makeProviderFailure({
      message: `OpenCode 2 provider authorization failed${status}. Reconnect the provider in OpenCode, then retry.`,
      code: "Integration.Authorization",
      class: "provider_error",
      retryable: false,
    });
  }
  if (
    input.code === "provider.rate-limit" ||
    input.statusCode === 429 ||
    /\b429\b|rate.?limit/i.test(evidence)
  ) {
    const status = /\b429\b/.test(evidence) ? " (HTTP 429)" : "";
    return makeProviderFailure({
      message: `OpenCode 2 hit a provider rate limit${status}. Wait, then retry the turn.`,
      code: "provider.rate-limit",
      class: "provider_error",
      retryable: true,
    });
  }
  if (
    input.code === "provider.internal" ||
    input.statusCode === 502 ||
    input.statusCode === 503 ||
    input.statusCode === 504 ||
    /endpoint is unavailable|service unavailable|upstream request failed/i.test(evidence)
  ) {
    const status =
      input.statusCode === 502 || input.statusCode === 503 || input.statusCode === 504
        ? ` (HTTP ${input.statusCode})`
        : "";
    return makeProviderFailure({
      message: `OpenCode 2 lost the model endpoint${status}. Wait, then retry the turn.`,
      code: "provider.unavailable",
      class: "provider_error",
      retryable: true,
    });
  }
  if (
    input.code === "ContextOverflowError" ||
    /context (?:length|window|limit)|maximum context|prompt is too long|token limit|too many tokens/i.test(
      evidence,
    )
  ) {
    return makeProviderFailure({
      message:
        "OpenCode 2 reached the model context limit. Compact or start a new thread, then retry.",
      code: "provider.context-limit",
      class: "provider_error",
      retryable: false,
    });
  }
  if (/\b(?:HTTP\s*)?401\b/i.test(evidence)) {
    const status = /\b401\b/.test(evidence) ? " (HTTP 401)" : "";
    return makeProviderFailure({
      message: `OpenCode 2 provider authorization failed${status}. Reconnect the provider in OpenCode, then retry.`,
      code: "Integration.Authorization",
      class: "provider_error",
      retryable: false,
    });
  }
  if (/unknown finish reason/i.test(input.message)) {
    return makeProviderFailure({
      message: "OpenCode 2 ended a model step with an unknown finish reason.",
      code: "provider.invalid-output",
      class: "provider_error",
      retryable: true,
    });
  }
  return makeProviderFailure({
    message: "OpenCode 2 provider failed. Check OpenCode logs for details, then retry the turn.",
    code: "provider.error",
    class: "provider_error",
    retryable: input.hasProviderRetry === true ? true : null,
  });
}

export function openCode2SessionErrorTargetSessionIds(
  sessionID: string | undefined,
  activeSessionIDs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (sessionID === undefined) return activeSessionIDs;
  return activeSessionIDs.includes(sessionID) ? [sessionID] : [];
}

export function openCode2InterruptedThreadDisposition(
  reason: string | undefined | null,
): "reusable" | "broken" {
  return reason === "shutdown" ? "broken" : "reusable";
}

export function openCode2ShouldSettleTurn(
  source: "execution-terminal" | "execution-interrupted" | "idle",
  executionStarted: boolean,
  interruptRequested = false,
): boolean {
  if (source === "idle") return !executionStarted;
  if (source === "execution-interrupted") return executionStarted || interruptRequested;
  return executionStarted;
}

/**
 * Whether a terminal `session.execution.*` may adopt a missing start event.
 * Used when the volatile SSE stream reconnects and drops
 * `session.execution.started` while later tool/text events still arrived for
 * this turn. Empty turns (prompt admitted, no parts yet) stay protected so a
 * late prior terminal cannot settle the next turn.
 *
 * @internal exported for tests
 */
export function openCode2CanAdoptMissingExecutionStart(turn: {
  readonly executionStarted: boolean;
  readonly interrupted: boolean;
  readonly partCount: number;
}): boolean {
  if (turn.executionStarted) return true;
  return turn.interrupted || turn.partCount > 0;
}

/**
 * Whether Stop's interrupt left the native session in an ambiguous state that
 * a follow-up turn must not reuse: when `session.interrupt` timed out or
 * failed, or an owned shell could not be stopped, the session may still be
 * executing the interrupted turn. The adapter still force-finalizes the turn
 * (Stop must stay live), but quarantines the session so a later prompt cannot
 * queue behind or interleave with the unconfirmed execution.
 *
 * @internal exported for tests
 */
export function openCode2ShouldQuarantineInterruptedSession(input: {
  readonly interruptRequestConfirmed: boolean;
  readonly shellRemovalConfirmed: boolean;
  readonly forceFinalizedWithoutTerminal?: boolean;
}): boolean {
  return (
    input.forceFinalizedWithoutTerminal === true ||
    !input.interruptRequestConfirmed ||
    !input.shellRemovalConfirmed
  );
}

/**
 * Whether the event subscription loop must fail active turns after repeated
 * clean SSE EOFs. A clean EOF while a turn is active resets the stall clock on
 * every reconnect, so without a budget an endless reconnect cycle parks the
 * turn with no terminal; idle reconnects and replay parking never count.
 * Pure so unit tests can cover the budget without a live SSE consumer.
 *
 * @internal exported for tests
 */
export function openCode2ShouldFailActiveTurnsAfterCleanEof(input: {
  readonly consecutiveCleanEofs: number;
  readonly maxCleanEofs: number;
  readonly cleanEofWindowAgeMs: number;
  readonly minimumWindowMs: number;
  readonly hasActiveTurn: boolean;
}): boolean {
  return (
    input.hasActiveTurn &&
    input.consecutiveCleanEofs >= input.maxCleanEofs &&
    input.cleanEofWindowAgeMs >= input.minimumWindowMs
  );
}

/** @internal exported for tests */
export function openCode2CleanEofResubscribeDelayMs(
  consecutiveCleanEofs: number,
  awaitingRuntimeRequest: boolean,
): number {
  if (!awaitingRuntimeRequest) return OPENCODE2_EVENT_RESUBSCRIBE_DELAY_MS;
  return Math.min(
    OPENCODE2_EVENT_PENDING_RESUBSCRIBE_DELAY_MS,
    OPENCODE2_EVENT_RESUBSCRIBE_DELAY_MS * 2 ** Math.min(Math.max(0, consecutiveCleanEofs - 1), 5),
  );
}

export interface OpenCode2ProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly messageKind: "request" | "response" | "notification" | "error";
  readonly method: string;
  readonly payload: unknown;
}

export function makeOpenCode2ProtocolLogger(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
}): (event: OpenCode2ProtocolLogEvent) => Effect.Effect<void, never> {
  return (event) =>
    Effect.gen(function* () {
      if (!input.nativeEventLogger) return;
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      const method = structuralProtocolMethod(event.method);
      yield* input.nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* input.idAllocator.allocate.rawEvent({
              providerSessionId: input.providerSessionId,
              method,
            }),
            kind: "protocol",
            protocol: OPENCODE2_SDK_PROTOCOL,
            provider: OPENCODE2_PROVIDER,
            providerInstanceId: input.providerInstanceId,
            providerSessionId: input.providerSessionId,
            createdAt: observedAt,
            threadId: input.threadId,
            payload: {
              direction: event.direction,
              messageKind: event.messageKind,
              method,
              payload: summarizeNativeProtocolPayload(event.payload),
            },
          },
        },
        input.threadId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Failed to write native OpenCode 2 event log.", {
              errorTag: causeErrorTag(cause),
              reasonCount: cause.reasons.length,
              provider: OPENCODE2_PROVIDER,
              threadId: input.threadId,
            }),
      ),
    );
}

function protocolError(detail: string, payload?: unknown): ProviderAdapterProtocolError {
  return new ProviderAdapterProtocolError({
    driver: OPENCODE2_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

/**
 * Builds the native selection fragment shared by session creation and
 * subsequent model or agent switches.
 *
 * @internal exported for tests
 */
export function openCode2SessionSelectionParameters(
  modelSelection: ModelSelection,
  interactionMode?: ProviderInteractionMode,
  knownAgentIDs?: ReadonlySet<string> | null,
) {
  const parsed = parseOpenCodeModelSlug(modelSelection.model);
  if (parsed === null) {
    throw protocolError(
      `OpenCode 2 model '${modelSelection.model}' must use provider/model format`,
    );
  }
  const variant = normalizeOpenCode2Variant(
    getModelSelectionStringOptionValue(modelSelection, "variant"),
  );
  const agent = resolveOpenCode2SessionAgent(
    getModelSelectionStringOptionValue(modelSelection, "agent"),
    interactionMode,
    knownAgentIDs,
  );
  return {
    model: {
      id: parsed.modelID,
      providerID: parsed.providerID,
      ...(variant === undefined ? {} : { variant }),
    },
    ...(agent === undefined ? {} : { agent }),
  };
}

/**
 * Current 2.x builds replaced the fork body's optional exclusive `messageID`
 * with a required `boundary` union: `{type: "before", messageID}` keeps the
 * old exclusive semantics and `{type: "through"}` copies the whole head. The
 * old shape is rejected with 400 `Missing key at ["boundary"]`. Session3 has no
 * `session.fork` method; production posts `{ boundary }` via the raw HTTP
 * client. `$body_boundary` remains the parameter shape for the generated
 * client's `$body_` escape hatch (Session2 / replay mocks that still expose
 * `.fork`).
 *
 * @internal exported for tests
 */
export function openCode2ForkParameters(sessionID: string, boundaryMessageId: string | undefined) {
  return {
    sessionID,
    $body_boundary:
      boundaryMessageId === undefined
        ? { type: "through" as const }
        : { type: "before" as const, messageID: boundaryMessageId },
  };
}

/**
 * Maps the thread's Build/Plan interaction mode onto OpenCode 2's native
 * `build`/`plan` primary agents, mirroring the 1.x adapter's plan fallback. A
 * custom agent selection always wins: the toggle only owns the two native
 * agents, and the `auto` sentinel (the descriptor default when custom agents
 * exist) means "defer to the toggle". Plan dominates a stale explicit
 * `build`/`plan` option because every pre-toggle thread has a persisted
 * `agent: "build"` selection that would otherwise pin the toggle inert; an
 * explicit `plan` option without plan mode still honors plan. With no
 * interaction mode (subagent child threads, text generation) the explicit
 * option passes through untouched. When the live agent catalog is available,
 * a missing agent is omitted so the server can choose a configured default.
 *
 * @internal exported for tests
 */
export function resolveOpenCode2SessionAgent(
  explicitAgent: string | undefined,
  interactionMode: ProviderInteractionMode | undefined,
  knownAgentIDs?: ReadonlySet<string> | null,
): string | undefined {
  const explicit = explicitAgent === OPENCODE2_AUTO_AGENT ? undefined : explicitAgent;
  let resolved: string | undefined;
  if (explicit !== undefined && explicit !== "build" && explicit !== "plan") {
    resolved = explicit;
  } else if (interactionMode === undefined) {
    resolved = explicit;
  } else if (interactionMode === "plan" || explicit === "plan") {
    resolved = "plan";
  } else {
    resolved = "build";
  }
  return resolved === undefined || knownAgentIDs == null || knownAgentIDs.has(resolved)
    ? resolved
    : undefined;
}

/** @internal exported for tests */
export function openCode2InteractionModeForAgent(agent: string): ProviderInteractionMode | null {
  if (agent === "build") return "default";
  if (agent === "plan") return "plan";
  return null;
}

export interface OpenCode2VariantClamp {
  readonly variant: string | undefined;
  readonly droppedVariant: string | null;
}

/**
 * Fail closed: the server accepts any variant id on session.create and
 * session.switchModel but silently drops the next prompt (the user message is
 * recorded, no assistant reply ever follows) when the bound variant is not in
 * the model's catalog. A variant that cannot be positively validated
 * (`knownVariants === null` covers a failed catalog fetch, the empty
 * bootstrap catalog, and a model the catalog does not list) is dropped:
 * running at the server default is strictly less harmful than a dead turn.
 *
 * @internal exported for tests
 */
export function clampOpenCode2Variant(
  variant: string | undefined,
  knownVariants: ReadonlySet<string> | null,
): OpenCode2VariantClamp {
  if (variant === undefined) return { variant: undefined, droppedVariant: null };
  if (knownVariants === null || !knownVariants.has(variant)) {
    return { variant: undefined, droppedVariant: variant };
  }
  return { variant, droppedVariant: null };
}

/**
 * A freshly spawned 2.x server prints its ready banner before model bootstrap
 * finishes and reports an empty catalog until then, exactly when the first
 * turn's session.create runs. Without this retry the fail-closed clamp eats a
 * valid variant on that first turn (observed live: a Max selection on
 * `opencode/glm-5.2` dropped at turn start, bound at server default). Mirrors
 * `retryEmptyOpenCode2Inventory`, additionally retrying failed fetches, which
 * the clamp represents as `null`.
 *
 * @internal exported for tests
 */
export const retryEmptyOpenCode2VariantCatalog = Effect.fnUntraced(function* <E, R>(
  readCatalog: Effect.Effect<ReadonlyMap<string, ReadonlySet<string>> | null, E, R>,
  options?: { readonly maxAttempts?: number; readonly retryDelayMs?: number },
) {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 10);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 500);
  let catalog = yield* readCatalog;
  for (
    let attempt = 1;
    (catalog === null || catalog.size === 0) && attempt < maxAttempts;
    attempt += 1
  ) {
    yield* Effect.sleep(retryDelayMs);
    catalog = yield* readCatalog;
  }
  return catalog;
});

/**
 * A selection with no variant option carries no opinion: subagent child
 * threads and pre-variant persisted selections have none, and treating that
 * as "reset to default" would clear a variant the native session legitimately
 * carries. Only an explicit option expresses intent (the synthetic "default"
 * id means reset), and a model change always rebinds.
 *
 * @internal exported for tests
 */
export function planOpenCode2VariantAlignment(input: {
  readonly boundModel: string | null;
  readonly boundVariant: string | null;
  readonly model: string;
  readonly rawVariant: string | undefined;
  readonly knownVariants: ReadonlySet<string> | null;
}): OpenCode2VariantClamp & { readonly switchNeeded: boolean } {
  const modelChanged = input.boundModel !== input.model;
  if (input.rawVariant === undefined && !modelChanged) {
    return { switchNeeded: false, variant: undefined, droppedVariant: null };
  }
  const clamp = clampOpenCode2Variant(
    normalizeOpenCode2Variant(input.rawVariant),
    input.knownVariants,
  );
  return {
    ...clamp,
    switchNeeded: modelChanged || input.boundVariant !== (clamp.variant ?? null),
  };
}

function nativeThreadId(providerThread: OrchestrationV2ProviderThread): string {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === null || nativeId === undefined) {
    throw protocolError(`Provider thread ${providerThread.id} has no OpenCode 2 session id`);
  }
  return nativeId;
}

function providerRef(nativeId: string, strength: "strong" | "weak" = "strong") {
  return {
    driver: OPENCODE2_PROVIDER,
    nativeId,
    strength,
  } satisfies OrchestrationV2ProviderRef;
}

function dateTimeFromEpoch(value: number | undefined, fallback: DateTime.Utc): DateTime.Utc {
  if (value === undefined) return fallback;
  return Option.getOrElse(DateTime.make(value), () => fallback);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function recordValue(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && key in input
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function recordString(input: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(recordValue(input, key));
    if (value !== undefined) return value;
  }
  return undefined;
}

function recordStringArray(input: unknown, ...keys: ReadonlyArray<string>): Array<string> {
  for (const key of keys) {
    const value = recordValue(input, key);
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
    const single = nonEmptyString(value);
    if (single !== undefined) return [single];
  }
  return [];
}

function recordNumber(input: unknown, ...keys: ReadonlyArray<string>): number | undefined {
  for (const key of keys) {
    const value = recordValue(input, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stableJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * OpenCode 2 reports MCP as execute({code}) and skills as skill({id}). Project
 * those into names the timeline already pretty-prints (t3-code.* / skill id).
 */
function projectOpenCode2DynamicToolName(
  normalizedTool: string,
  fallbackName: string,
  input: unknown,
): string {
  if (normalizedTool === "execute") {
    const code = recordString(input, "code");
    if (code !== undefined) {
      const embedded = extractOpenCode2ExecuteT3McpToolName(code);
      if (embedded !== null) {
        return `t3-code.${embedded}`;
      }
    }
    return fallbackName;
  }
  if (normalizedTool === "skill") {
    const skillId = recordString(input, "id", "name");
    if (skillId !== undefined) {
      return skillId;
    }
  }
  return fallbackName;
}

function sdkResponseForRawLog(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if ("data" in value) return { data: (value as { readonly data?: unknown }).data ?? null };
  if ("stream" in value) return { subscribed: true };
  return value;
}

/**
 * 2.x payloads are double-wrapped: the SDK's `.data` is the parsed body, and
 * every body carries its own `data` envelope. Reading one layer yields the
 * envelope rather than the value, which fails far from here.
 *
 * @internal exported for tests
 */
export function unwrapOpenCode2Data<A>(
  operation: OpenCode2RuntimeOperation,
  result: unknown,
): Effect.Effect<NonNullable<A>, OpenCode2RuntimeError> {
  const payload = unwrapOpenCode2Payload<A>(result);
  if (payload === undefined || payload === null) {
    return Effect.fail(
      new OpenCode2RuntimeError({
        operation,
        category: "missing-response-payload",
      }),
    );
  }
  return Effect.succeed(payload as NonNullable<A>);
}

/** @internal exported for tests */
function openCode2ClientHttpStatus(cause: unknown): number | undefined {
  const direct = recordNumber(cause, "status");
  if (direct !== undefined) return direct;
  return recordNumber(recordValue(cause, "cause"), "status");
}

/** @internal exported for tests */
export function openCode2ClientRemovalAlreadyMissing(cause: unknown): boolean {
  return (
    isSessionNotFoundError(cause) ||
    isShellNotFoundError(cause) ||
    openCode2ClientHttpStatus(cause) === 404
  );
}

/** @internal exported for tests */
export function settleOpenCode2ClientRemoval(request: Promise<unknown>): Promise<unknown> {
  return request.then(
    (data) => data ?? {},
    (cause) => {
      if (openCode2ClientRemovalAlreadyMissing(cause)) {
        return { error: cause, response: { status: 404 } };
      }
      throw cause;
    },
  );
}

export function removeOpenCode2Session(
  sessionID: string,
  request: Effect.Effect<unknown, OpenCode2RuntimeError>,
): Effect.Effect<void, OpenCode2RuntimeError> {
  return request.pipe(
    Effect.flatMap((response) => {
      const error = recordValue(response, "error");
      const status = recordNumber(recordValue(response, "response"), "status");
      if (error === undefined || status === 404) return Effect.void;
      return Effect.fail(
        new OpenCode2RuntimeError({
          operation: "session.remove",
          category: "session-remove-failed",
          cause: error,
        }),
      );
    }),
  );
}

/** @internal exported for tests */
export function openCode2ShellRemovalSucceeded(response: unknown): boolean {
  const error = recordValue(response, "error");
  const status = recordNumber(recordValue(response, "response"), "status");
  return error === undefined || status === 404 || openCode2ClientRemovalAlreadyMissing(error);
}

/**
 * Stable per-question id so an answer map keyed by header, question text, or
 * generated id all resolve. Mirrors `openCodeQuestionId` for the 2.x question
 * shape, which carries a header but none of 1.x's other fields.
 *
 * @internal exported for tests
 */
export function openCode2QuestionId(index: number, header: string): string {
  const slug = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? `question-${index}-${slug}` : `question-${index}`;
}

/**
 * Current 2.x builds surface the question tool through the form API
 * (`form.created`) instead of `question.v2.asked`, which still exists but no
 * longer fires for it. Map a form onto the question request shape so the UI
 * renders the Input card, and keep index-aligned field keys so the reply can
 * address `session.form.reply`.
 *
 * @internal exported for tests
 */
export function openCode2FormQuestions(form: FormInfo): {
  readonly questions: ReadonlyArray<QuestionV2Info>;
  readonly fieldKeys: ReadonlyArray<string>;
  readonly optionValuesByLabel: ReadonlyArray<Readonly<Record<string, string>>>;
} {
  const questions: Array<QuestionV2Info> = [];
  const fieldKeys: Array<string> = [];
  const optionValuesByLabel: Array<Readonly<Record<string, string>>> = [];
  for (const field of form.fields) {
    const title = field.title?.trim() ?? "";
    const description = field.description?.trim() ?? "";
    const options = "options" in field ? (field.options ?? []) : [];
    // The UI answers with labels; the wire wants option values.
    questions.push({
      header: title || form.title,
      question: description || title || form.title,
      options: options.map((option) => ({
        label: option.label.trim() || option.value,
        description: option.description?.trim() ?? "",
      })),
      ...(("custom" in field && field.custom) === true ? { custom: true } : {}),
      ...(field.type === "multiselect" ? { multiple: true } : {}),
    });
    fieldKeys.push(field.key);
    const valuesByLabel = Object.create(null) as Record<string, string>;
    for (const option of options) {
      valuesByLabel[option.label.trim() || option.value] = option.value;
    }
    optionValuesByLabel.push(valuesByLabel);
  }
  return { questions, fieldKeys, optionValuesByLabel };
}

/**
 * Builds the `session.form.reply` answer map from per-question answer arrays.
 * Answer labels translate back to option values where a mapping exists
 * (free-text custom answers pass through), a single selection collapses to
 * the plain string a non-multiselect field expects, and unanswered fields are
 * omitted rather than sent as empty arrays.
 *
 * @internal exported for tests
 */
export function openCode2FormAnswer(
  fieldKeys: ReadonlyArray<string>,
  answers: ReadonlyArray<ReadonlyArray<string>>,
  optionValuesByLabel?: ReadonlyArray<Readonly<Record<string, string>>>,
  multiselectFields?: ReadonlyArray<boolean>,
): Record<string, string | Array<string>> {
  const answer = Object.create(null) as Record<string, string | Array<string>>;
  fieldKeys.forEach((key, index) => {
    const valuesByLabel = optionValuesByLabel?.[index];
    const values = (answers[index] ?? []).map((value) => {
      if (valuesByLabel === undefined || !Object.hasOwn(valuesByLabel, value)) return value;
      return valuesByLabel[value]!;
    });
    if (values.length === 0) return;
    answer[key] = multiselectFields?.[index] === true || values.length > 1 ? values : values[0]!;
  });
  return answer;
}

export function openCode2LocationQuery(directory: string): string {
  return new URLSearchParams({ "location[directory]": directory }).toString();
}

export function openCode2ShellsFromList(input: unknown): ReadonlyArray<ShellInfoV2> {
  if (!Array.isArray(input)) {
    const nested = recordValue(input, "data");
    return Array.isArray(nested) ? openCode2ShellsFromList(nested) : [];
  }
  const shells: ShellInfoV2[] = [];
  for (const item of input) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    const metadata =
      record.metadata !== null &&
      typeof record.metadata === "object" &&
      !Array.isArray(record.metadata)
        ? (record.metadata as ShellInfoV2["metadata"])
        : {};
    shells.push({
      id: record.id,
      status: typeof record.status === "string" ? record.status : "unknown",
      ...(typeof record.command === "string" ? { command: record.command } : {}),
      ...(typeof record.exit === "number" ? { exit: record.exit } : {}),
      metadata,
    });
  }
  return shells;
}

export function openCode2McpServersFromList(input: unknown): ReadonlyArray<McpServer> {
  if (Array.isArray(input)) {
    const servers: McpServer[] = [];
    for (const item of input) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.name !== "string" || record.name.length === 0) continue;
      servers.push({
        name: record.name,
        status:
          typeof record.status === "string" ||
          (record.status !== null && typeof record.status === "object")
            ? (record.status as McpServer["status"])
            : "missing",
      });
    }
    return servers;
  }
  const nested = recordValue(input, "data");
  if (Array.isArray(nested) || (nested !== null && typeof nested === "object")) {
    return openCode2McpServersFromList(nested);
  }
  if (input === null || typeof input !== "object") return [];
  const servers: McpServer[] = [];
  for (const [name, status] of Object.entries(input as Record<string, unknown>)) {
    if (name === "location" || name === "data" || name.length === 0) continue;
    if (typeof status === "string") {
      servers.push({ name, status });
      continue;
    }
    if (status !== null && typeof status === "object" && !Array.isArray(status)) {
      servers.push({ name, status: status as McpServer["status"] });
    }
  }
  return servers;
}

/**
 * Durable instruction text installed on each OpenCode 2 session that has the
 * T3 MCP server. Shared orchestration rules plus the OpenCode execute bridge.
 *
 * @internal exported for tests
 */
export function openCode2T3OrchestrationInstructions(): string {
  return [
    T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
    "",
    'OpenCode 2 MCP call shape: run t3-code tools through the built-in `execute` tool with JavaScript that calls tools["t3-code"], for example:',
    'await tools["t3-code"].orchestrator_capabilities({})',
    'await tools["t3-code"].orchestrator_capabilities({ providerInstanceId: "..." })',
    'await tools["t3-code"].orchestrator_capabilities({ providerInstanceId: "...", modelCursor: 50 })',
    'await tools["t3-code"].orchestrator_capabilities({ providerInstanceId: "...", model: "...", includeModelOptions: true })',
    'await tools["t3-code"].t3_thread_start({ prompt: "...", title: "..." })',
    'await tools["t3-code"].delegate_task({ task: "...", mode: "async" })',
  ].join("\n");
}

/**
 * 2.x has no session-scoped permission ruleset — `session.create` accepts none
 * and its native `always` reply persists project-wide — so T3 evaluates each
 * request against the same rules used by the 1.x adapter and replies only for
 * that request. Session grants are remembered by the adapter instead.
 *
 * @internal exported for tests
 */
export function openCode2AutoPermissionReply(
  runtimePolicy: ProviderAdapterV2TurnInput["runtimePolicy"],
  request: {
    readonly action: string;
    readonly resources: ReadonlyArray<string>;
  },
): "once" | "reject" | null {
  const rules = openCodePermissionRules(runtimePolicy);
  const resources = request.resources.length === 0 ? ["*"] : request.resources;
  let needsApproval = false;
  for (const resource of resources) {
    const rule = rules.findLast(
      (candidate) =>
        openCode2WildcardMatch(candidate.permission, request.action) &&
        openCode2WildcardMatch(candidate.pattern, resource),
    );
    const effect = rule?.action ?? "ask";
    if (effect === "deny") return "reject";
    if (effect === "ask") needsApproval = true;
  }
  return needsApproval ? null : "once";
}

/**
 * OpenCode preview builds may drift from the pinned SDK before its generated
 * event types catch up. Keep that drift at the adapter boundary so a missing
 * resource or save list cannot terminate the provider event subscription.
 *
 * @internal exported for tests
 */
export function normalizeOpenCode2PermissionEvent(
  protocol: "legacy" | "v2",
  data: unknown,
): {
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly save: ReadonlyArray<string>;
} {
  return {
    action:
      (protocol === "legacy"
        ? recordString(data, "permission", "action")
        : recordString(data, "action", "permission")) ?? "unknown",
    resources:
      protocol === "legacy"
        ? recordStringArray(data, "patterns", "resources", "pattern")
        : recordStringArray(data, "resources", "patterns", "pattern"),
    save:
      protocol === "legacy"
        ? recordStringArray(data, "always", "save")
        : recordStringArray(data, "save", "always"),
  };
}

export function openCode2PermissionAutoReply(
  runtimePolicy: ProviderAdapterV2TurnInput["runtimePolicy"],
  sessionPermissions: ReadonlyArray<OpenCode2SessionPermission>,
  request: {
    readonly action: string;
    readonly resources: ReadonlyArray<string>;
  },
): "once" | "reject" | null {
  const resources = request.resources.length === 0 ? ["*"] : request.resources;
  let needsApproval = false;
  for (const resource of resources) {
    const resourceRequest = { action: request.action, resources: [resource] };
    const policyReply = openCode2AutoPermissionReply(runtimePolicy, resourceRequest);
    if (policyReply === "reject") return "reject";
    if (policyReply === "once") continue;
    if (
      sessionPermissions.some((permission) =>
        openCode2SessionPermissionMatches(permission, resourceRequest),
      )
    ) {
      continue;
    }
    needsApproval = true;
  }
  return needsApproval ? null : "once";
}

/** @internal exported for tests */
export function openCode2PermissionAutoReplyForSession(
  runtimePolicy: ProviderAdapterV2TurnInput["runtimePolicy"],
  sessionPermissions: OpenCode2SessionPermissionStore,
  nativeSessionId: string,
  request: {
    readonly action: string;
    readonly resources: ReadonlyArray<string>;
  },
): "once" | "reject" | null {
  return openCode2PermissionAutoReply(
    runtimePolicy,
    sessionPermissions.get(nativeSessionId) ?? [],
    request,
  );
}

function openCode2WildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

function openCode2SessionPermissionMatches(
  permission: OpenCode2SessionPermission,
  request: {
    readonly action: string;
    readonly resources: ReadonlyArray<string>;
  },
): boolean {
  if (!openCode2WildcardMatch(permission.action, request.action)) return false;
  const resources = request.resources.length === 0 ? ["*"] : request.resources;
  return resources.every((resource) =>
    permission.resources.some((pattern) => openCode2WildcardMatch(pattern, resource)),
  );
}

/** @internal exported for tests */
export function rememberOpenCode2SessionPermission(
  permissionsBySession: OpenCode2SessionPermissionStore,
  nativeSessionId: string,
  permission: PendingOpenCode2Request["permission"],
): OpenCode2SessionPermission | null {
  if (permission === undefined) return null;
  const permissions = permissionsBySession.get(nativeSessionId) ?? [];
  const savedResources = permission.save.length === 0 ? permission.resources : permission.save;
  const remembered = {
    action: permission.action,
    resources: savedResources.length === 0 ? ["*"] : savedResources,
  };
  const existing = permissions.find(
    (candidate) =>
      candidate.action === remembered.action &&
      candidate.resources.length === remembered.resources.length &&
      candidate.resources.every((resource, index) => resource === remembered.resources[index]),
  );
  if (existing !== undefined) {
    openCode2SessionPermissionOwnership.set(
      existing,
      (openCode2SessionPermissionOwnership.get(existing) ?? 1) + 1,
    );
    return existing;
  }
  permissions.push(remembered);
  openCode2SessionPermissionOwnership.set(remembered, 1);
  permissionsBySession.set(nativeSessionId, permissions);
  return remembered;
}

/** @internal exported for tests */
export function forgetOpenCode2SessionPermission(
  permissionsBySession: OpenCode2SessionPermissionStore,
  nativeSessionId: string,
  permission: OpenCode2SessionPermission,
): void {
  const permissions = permissionsBySession.get(nativeSessionId);
  if (permissions === undefined) return;
  const ownershipCount = openCode2SessionPermissionOwnership.get(permission) ?? 1;
  if (ownershipCount > 1) {
    openCode2SessionPermissionOwnership.set(permission, ownershipCount - 1);
    return;
  }
  const index = permissions.indexOf(permission);
  if (index === -1) return;
  permissions.splice(index, 1);
  openCode2SessionPermissionOwnership.delete(permission);
  if (permissions.length === 0) permissionsBySession.delete(nativeSessionId);
}

/** @internal exported for tests */
export function openCode2ChildTurnItemOrdinals(providerTurnOrdinal: number): {
  readonly next: number;
  readonly user: number;
} {
  const user = providerTurnOrdinal * 100;
  return { next: user + 1, user };
}

function toOpenCode2FileAttachments(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<PromptInputFileAttachment> {
  const files: Array<PromptInputFileAttachment> = [];
  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) continue;
    files.push({
      uri: NodeURL.pathToFileURL(attachmentPath).href,
      ...(attachment.name ? { name: attachment.name } : {}),
    });
  }
  return files;
}

function toolNodeStatus(status: OpenCode2ToolStatus): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly item: OrchestrationV2TurnItem["status"];
} {
  switch (status) {
    case "pending":
      return { node: "pending", item: "pending" };
    case "running":
      return { node: "running", item: "running" };
    case "completed":
      return { node: "completed", item: "completed" };
    case "error":
      return { node: "failed", item: "failed" };
  }
}

function subagentStatusFromTurnItemStatus(
  status: OrchestrationV2TurnItem["status"],
): OpenCode2SubagentContext["status"] {
  switch (status) {
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "pending":
      return "pending";
    default:
      return "running";
  }
}

function compactionStatusFromTerminalTurnStatus(
  status: TerminalTurnStatus,
): OpenCode2Compaction["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
  }
}

function compactionTitle(status: OpenCode2Compaction["status"]): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

function toolContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const chunks = content
    .filter((entry) => recordString(entry, "type") === "text")
    .map((entry) => recordString(entry, "text"))
    .filter((text): text is string => text !== undefined);
  return chunks.length === 0 ? undefined : chunks.join("\n");
}

function openCode2PermissionRequestKind(action: string): ProviderRequestKind {
  return openCodePermissionRequestKind(action);
}

/**
 * T3 allocates a pending provider-thread id before session.create. The start
 * service keeps that id and stamps nativeThreadRef onto it. The adapter's
 * in-memory thread is keyed by the native session id. Rebind so later
 * provider_thread.updated events, including the background-shell roster, land
 * on the row Waiting and the context-window meter read.
 */
export function bindOpenCode2CanonicalProviderThread(
  stateThread: OrchestrationV2ProviderThread,
  canonicalThread: OrchestrationV2ProviderThread,
): OrchestrationV2ProviderThread {
  return {
    ...stateThread,
    id: canonicalThread.id,
    appThreadId: canonicalThread.appThreadId ?? stateThread.appThreadId,
    ownerNodeId: canonicalThread.ownerNodeId,
    firstRunOrdinal: canonicalThread.firstRunOrdinal ?? stateThread.firstRunOrdinal,
    lastRunOrdinal: canonicalThread.lastRunOrdinal ?? stateThread.lastRunOrdinal,
    handoffIds: canonicalThread.handoffIds,
    forkedFrom: canonicalThread.forkedFrom ?? stateThread.forkedFrom,
    nativeThreadRef: stateThread.nativeThreadRef ?? canonicalThread.nativeThreadRef,
  };
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly nativeSession: SessionInfoV2;
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: OPENCODE2_PROVIDER,
      nativeThreadId: input.nativeSession.id,
    }),
    driver: OPENCODE2_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: OPENCODE2_PROVIDER,
      nativeId: input.nativeSession.id,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: dateTimeFromEpoch(input.nativeSession.time.created, input.now),
    updatedAt: dateTimeFromEpoch(input.nativeSession.time.updated, input.now),
  };
}

export function makeOpenCode2AdapterV2(options: OpenCode2AdapterV2Options): ProviderAdapterV2Shape {
  const { idAllocator, runtime, serverConfig } = options;
  const continuationRequests = options.continuationRequests;
  const interactionModeReflections = options.interactionModeReflections;

  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OPENCODE2_PROVIDER,
    deleteDetachedThread: (input) =>
      Effect.gen(function* () {
        const sessionID = nativeThreadId(input.providerThread);
        const connection = yield* runtime.connectToOpenCode2Server({
          binaryPath: options.settings.binaryPath,
          serverUrl: options.settings.serverUrl,
          serverPassword: options.settings.serverPassword,
          environment: options.environment,
        });
        const client = runtime.createOpenCode2SdkClient({
          baseUrl: connection.url,
          directory: input.providerSession.cwd,
          serverPassword: connection.password,
        });
        yield* removeOpenCode2Session(
          sessionID,
          runOpenCode2Sdk("session.remove", () =>
            settleOpenCode2ClientRemoval(client.session.remove({ sessionID })),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          protocolError(
            `Failed to delete detached OpenCode 2 session ${input.providerThread.id}`,
            cause,
          ),
        ),
      ),
    getCapabilities: () => Effect.succeed(OpenCode2ProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("OpenCode2AdapterV2.openSession")(
      function* (input: ProviderAdapterV2OpenSessionInput) {
        const scope = yield* Effect.scope;
        const cwd = input.runtimePolicy.cwd ?? serverConfig.cwd;
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const selfSpawning = !(options.settings.serverUrl?.trim() ?? "");
        const hasT3Mcp = mcpSession !== undefined && selfSpawning;
        const connection = yield* runtime.connectToOpenCode2Server({
          binaryPath: options.settings.binaryPath,
          serverUrl: options.settings.serverUrl,
          serverPassword: options.settings.serverPassword,
          environment: options.environment,
        });
        const client = runtime.createOpenCode2SdkClient({
          baseUrl: connection.url,
          directory: cwd,
          serverPassword: connection.password,
        });

        const deleteSessionHttp = (sessionID: string) =>
          settleOpenCode2ClientRemoval(client.session.remove({ sessionID }));

        const removeShellHttp = (input: {
          readonly id: string;
          readonly location: SessionInfoV2["location"];
        }) =>
          settleOpenCode2ClientRemoval(
            client.shell.remove({
              id: input.id,
              location: input.location,
            }),
          );

        const readShellOutputHttp = (input: {
          readonly id: string;
          readonly location: SessionInfoV2["location"];
          readonly cursor: string;
          readonly limit: string;
        }) =>
          client.shell.output({
            id: input.id,
            location: input.location,
            cursor: Number(input.cursor),
            limit: Number(input.limit),
          });

        const now = yield* DateTime.now;
        let sessionEntity: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: OPENCODE2_PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd,
          model: input.modelSelection.model,
          capabilities: OpenCode2ProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const threads = new Map<string, OpenCode2ThreadState>();
        const shellProjections = new Map<string, OpenCode2ShellProjection>();
        const shellSessionIds = new Map<string, string>();
        const runningShellIdsBySession = new Map<string, Set<string>>();
        const holdPendingWorkAfterClear = new Set<string>();
        const pendingRequests = new Map<string, PendingOpenCode2Request>();
        const pendingRequestsByNativeId = new Map<string, PendingOpenCode2Request>();
        const settledRequestsByNativeId = new Map<string, SettledOpenCode2Request>();
        const autoReplyPermissionsByNativeKey = new Map<
          string,
          { confirmed: boolean; reply: unknown }
        >();
        const seenRuntimeRequestKeysBySessionId = new Map<string, Map<string, void>>();

        const hasSeenRuntimeRequestKey = (
          nativeSessionId: string,
          nativeRequestKey: string,
        ): boolean =>
          seenRuntimeRequestKeysBySessionId.get(nativeSessionId)?.has(nativeRequestKey) === true;

        const rememberRuntimeRequestKey = (
          nativeSessionId: string,
          nativeRequestKey: string,
        ): void => {
          const seen = seenRuntimeRequestKeysBySessionId.get(nativeSessionId) ?? new Map();
          seenRuntimeRequestKeysBySessionId.set(nativeSessionId, seen);
          seen.delete(nativeRequestKey);
          seen.set(nativeRequestKey, undefined);
          while (seen.size > OPENCODE2_RUNTIME_REQUEST_DEDUPE_PER_SESSION_LIMIT) {
            const oldest = seen.keys().next().value;
            if (oldest === undefined) break;
            seen.delete(oldest);
          }
        };
        const subagentsByNativeItemId = new Map<string, OpenCode2SubagentContext>();
        const subagentsByChildSessionId = new Map<string, OpenCode2SubagentContext>();
        const nativeChildSessions = new Map<string, OpenCode2NativeSession>();
        const deferredChildEvents = new Map<string, OpenCode2DeferredChildEventBuffer>();
        const pendingDeferredChildEvents: Array<unknown> = [];
        const sessionPermissions: OpenCode2SessionPermissionStore = new Map();
        const modelLimits = new Map<string, ModelInfo["limit"]>();
        const abortController = new AbortController();
        // Liveness marker for SSE pull. OpenCode 2 fails a slow event consumer;
        // if pull stalls while a turn is active we resubscribe.
        let lastEventAtMs = 0;
        let consecutiveStreamFailures = 0;
        let consecutiveStallResubscribes = 0;
        let consecutiveCleanEofResubscribes = 0;
        let cleanEofWindowStartedAtMs: number | null = null;
        lastEventAtMs = yield* Clock.currentTimeMillis;

        const emitProviderEvent = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const writeProtocolEvent = makeOpenCode2ProtocolLogger({
          nativeEventLogger: options.nativeEventLogger,
          idAllocator,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          threadId: input.threadId,
        });
        // Never block the SSE pull path on disk logging. The stream is
        // volatile under backpressure; serializing every notification before
        // the next read is how a long kimi turn can fill Recv-Q and freeze.
        const logProtocolEvent = (event: OpenCode2ProtocolLogEvent) =>
          writeProtocolEvent(event).pipe(Effect.forkIn(scope), Effect.asVoid);

        const sdkCall = <A>(
          method: OpenCode2RuntimeOperation,
          payload: unknown,
          call: () => Promise<A>,
        ): Effect.Effect<A, OpenCode2RuntimeError> =>
          logProtocolEvent({
            direction: "outgoing",
            messageKind: "request",
            method,
            payload,
          }).pipe(
            Effect.andThen(runOpenCode2Sdk(method, call)),
            Effect.tap((response) =>
              logProtocolEvent({
                direction: "incoming",
                messageKind: "response",
                method,
                payload: sdkResponseForRawLog(response),
              }),
            ),
          );

        const sdkCallWithTimeout = <A>(
          method: OpenCode2RuntimeOperation,
          payload: unknown,
          call: () => Promise<A>,
          timeoutMs: number,
        ): Effect.Effect<Option.Option<A>, never> =>
          sdkCall(method, payload, call).pipe(
            Effect.timeoutOption(`${timeoutMs} millis`),
            Effect.catchCause((cause) =>
              Effect.logWarning("OpenCode 2 SDK call failed or timed out.", {
                errorTag: causeErrorTag(cause),
                operation: method,
                provider: OPENCODE2_PROVIDER,
                timeoutMs,
              }).pipe(Effect.as(Option.none<A>())),
            ),
          );

        /** Model inventory is cached per spawned server and also supplies safe compaction limits. */
        let variantCatalog: ReadonlyMap<string, ReadonlySet<string>> | null = null;
        const readVariantCatalog = sdkCall("model.list", {}, () =>
          client.model.list({ location: { directory: cwd } }),
        ).pipe(
          Effect.flatMap((response) =>
            unwrapOpenCode2Data<ReadonlyArray<ModelInfo>>("model.list", response).pipe(
              Effect.map((models) => {
                const catalog = new Map<string, ReadonlySet<string>>();
                for (const model of models) {
                  const slug = `${model.providerID}/${model.id}`;
                  catalog.set(slug, new Set(model.variants.map((entry) => entry.id)));
                  modelLimits.set(slug, model.limit);
                }
                return catalog as ReadonlyMap<string, ReadonlySet<string>>;
              }),
            ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("Failed to load the OpenCode 2 variant catalog.", {
                  errorTag: causeErrorTag(cause),
                  provider: OPENCODE2_PROVIDER,
                }).pipe(Effect.as(null)),
          ),
        );
        const knownVariantsForModel = Effect.fnUntraced(function* (modelSlug: string) {
          if (variantCatalog !== null) return variantCatalog.get(modelSlug) ?? null;
          const fetched = yield* retryEmptyOpenCode2VariantCatalog(readVariantCatalog);
          if (fetched !== null && fetched.size > 0 && variantCatalog === null) {
            variantCatalog = fetched;
          }
          return fetched?.get(modelSlug) ?? null;
        });

        const compactionDiagnosticsFor = (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          reason: unknown,
        ) =>
          openCode2CompactionDiagnostics({
            usage: state.latestTokenUsage,
            limits: modelLimits.get(turn.modelSelection.model) ?? null,
            reason,
          });

        const updateProviderSession = (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = sessionEntity.lastError,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const lastErrorAt = openCode2LastErrorAt({
              previousError: sessionEntity.lastError,
              previousErrorAt: sessionEntity.lastErrorAt ?? null,
              nextError: lastError,
              updatedAt,
            });
            sessionEntity = { ...sessionEntity, status, lastError, lastErrorAt, updatedAt };
            yield* emitProviderEvent({
              type: "provider_session.updated",
              driver: OPENCODE2_PROVIDER,
              providerSession: sessionEntity,
            });
          });

        const updateProviderThread = (
          state: OpenCode2ThreadState,
          patch: Partial<OrchestrationV2ProviderThread>,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            state.providerThread = { ...state.providerThread, ...patch, updatedAt };
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: OPENCODE2_PROVIDER,
              providerThread: state.providerThread,
            });
          });

        const runningShellRoster = (sessionID: string) =>
          [...(runningShellIdsBySession.get(sessionID) ?? [])].map((taskId) => ({
            taskId,
            taskType: "shell",
          }));

        const rememberRunningShell = Effect.fnUntraced(function* (
          sessionID: string,
          shellId: string,
        ) {
          const owned = runningShellIdsBySession.get(sessionID) ?? new Set<string>();
          const already = owned.has(shellId);
          owned.add(shellId);
          runningShellIdsBySession.set(sessionID, owned);
          shellSessionIds.set(shellId, sessionID);
          if (already) return;
          const state = threads.get(sessionID);
          if (state !== undefined) {
            yield* updateProviderThread(state, {
              pendingBackgroundTasks: runningShellRoster(sessionID),
            });
          }
        });

        const forgetRunningShell = Effect.fnUntraced(function* (shellId: string) {
          let sessionID = shellSessionIds.get(shellId);
          if (sessionID === undefined) {
            for (const [ownedSessionID, owned] of runningShellIdsBySession) {
              if (owned.has(shellId)) {
                sessionID = ownedSessionID;
                break;
              }
            }
          }
          if (sessionID === undefined) return;
          const owned = runningShellIdsBySession.get(sessionID);
          owned?.delete(shellId);
          if (owned !== undefined && owned.size === 0) {
            runningShellIdsBySession.delete(sessionID);
            holdPendingWorkAfterClear.add(sessionID);
          }
          const state = threads.get(sessionID);
          if (state !== undefined) {
            yield* updateProviderThread(state, {
              pendingBackgroundTasks: runningShellRoster(sessionID),
            });
          }
        });

        const itemOrdinal = (turn: ActiveOpenCode2Turn, nativeItemId: string): number => {
          const existing = turn.itemOrdinals.get(nativeItemId);
          if (existing !== undefined) return existing;
          const ordinal = turn.nextItemOrdinal++;
          turn.itemOrdinals.set(nativeItemId, ordinal);
          return ordinal;
        };

        const emitProviderTurn = (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          status: OrchestrationV2ProviderTurn["status"],
          completedAt: DateTime.Utc | null,
        ) => {
          const providerTurn: OrchestrationV2ProviderTurn = {
            ...turn.providerTurn,
            nativeTurnRef:
              turn.nativeInputId === null
                ? turn.providerTurn.nativeTurnRef
                : providerRef(turn.nativeInputId, "weak"),
            status,
            completedAt,
          };
          Object.assign(turn.providerTurn, providerTurn);
          state.providerTurns.set(String(providerTurn.id), providerTurn);
          return emitProviderEvent({
            type: "provider_turn.updated",
            driver: OPENCODE2_PROVIDER,
            threadId: turn.threadId,
            providerTurn,
          });
        };

        const emitTextPart = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          part: OpenCode2TextPart,
          forceCompleted = false,
        ) {
          if (part.text.length === 0) return;
          const emittedAt = yield* DateTime.now;
          const isCompleted = forceCompleted || part.completed;
          const completedAt = isCompleted ? emittedAt : null;
          const nativeItemRef = providerRef(part.id);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: part.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: part.id,
          });
          const ordinal = itemOrdinal(turn, part.id);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: part.kind === "text" ? "assistant_message" : "reasoning",
              status: isCompleted ? "completed" : "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: part.startedAt,
              completedAt,
            },
          });
          if (part.kind === "text") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: OPENCODE2_PROVIDER,
              nativeItemId: part.id,
            });
            const message: OrchestrationV2ConversationMessage = {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              role: "assistant",
              text: part.text,
              attachments: [],
              streaming: !isCompleted,
              createdAt: part.startedAt,
              updatedAt: emittedAt,
            };
            state.messages.set(String(message.id), message);
            yield* emitProviderEvent({
              type: "message.updated",
              driver: OPENCODE2_PROVIDER,
              message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: OPENCODE2_PROVIDER,
              turnItem: {
                id: turnItemId,
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId,
                providerThreadId: state.providerThread.id,
                providerTurnId: turn.providerTurnId,
                nativeItemRef,
                parentItemId: null,
                ordinal,
                status: isCompleted ? "completed" : "running",
                title: null,
                startedAt: part.startedAt,
                completedAt,
                updatedAt: emittedAt,
                type: "assistant_message",
                messageId,
                text: part.text,
                streaming: !isCompleted,
              },
            });
            return;
          }
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE2_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: isCompleted ? "completed" : "running",
              title: null,
              startedAt: part.startedAt,
              completedAt,
              updatedAt: emittedAt,
              type: "reasoning",
              text: part.text,
              streaming: !isCompleted,
            },
          });
        });

        const bindSubagentChild = Effect.fnUntraced(function* (
          context: OpenCode2SubagentContext,
          nativeSession: OpenCode2NativeSession,
        ) {
          if (context.childSessionId !== null) return;
          const now = yield* DateTime.now;
          const childSessionId = nativeSession.id;
          const childThreadId = idAllocator.derive.threadFromProviderThread({
            driver: OPENCODE2_PROVIDER,
            nativeThreadId: childSessionId,
          });
          const childProviderThreadId = idAllocator.derive.providerThread({
            driver: OPENCODE2_PROVIDER,
            nativeThreadId: childSessionId,
          });
          const model =
            nativeSession.model === undefined
              ? context.model
              : `${nativeSession.model.providerID}/${nativeSession.model.id}`;
          const childVariant = normalizeOpenCode2Variant(nativeSession.model?.variant);
          const childModelSelection: ModelSelection = {
            instanceId: options.instanceId,
            model: model ?? context.parentTurn.modelSelection.model,
            ...(childVariant === undefined
              ? {}
              : { options: [{ id: "variant", value: childVariant }] }),
          };
          const childThread = makeSubagentChildThread({
            parentThread: context.parentTurn.appThread,
            childThreadId,
            parentNodeId: context.nodeId,
            activeProviderThreadId: childProviderThreadId,
            providerInstanceId: options.instanceId,
            modelSelection: childModelSelection,
            title: subagentThreadTitle({
              parentTitle: context.parentTurn.appThread.title,
              title: context.title ?? nativeSession.title,
              prompt: context.prompt,
              ordinal: itemOrdinal(context.parentTurn, context.nativeItemId),
            }),
            now,
            createdBy: "agent",
            creationSource: "provider",
          });
          const childProviderThread: OrchestrationV2ProviderThread = {
            id: childProviderThreadId,
            driver: OPENCODE2_PROVIDER,
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: childThreadId,
            ownerNodeId: context.nodeId,
            nativeThreadRef: providerRef(childSessionId),
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: dateTimeFromEpoch(nativeSession.time.created, now),
            updatedAt: dateTimeFromEpoch(nativeSession.time.updated, now),
          };
          context.childSessionId = childSessionId;
          context.childThreadId = childThreadId;
          context.childProviderThreadId = childProviderThreadId;
          context.model = model;
          context.status = "pending";
          context.completedAt = null;
          context.progress = undefined;
          context.result = null;
          subagentsByChildSessionId.set(childSessionId, context);
          threads.set(childSessionId, {
            nativeSessionId: childSessionId,
            location: context.parentState.location,
            providerThread: childProviderThread,
            appThread: childThread,
            activeTurn: null,
            boundModel: model,
            boundVariant: normalizeOpenCode2Variant(nativeSession.model?.variant) ?? null,
            boundAgent: nativeSession.agent ?? null,
            lastAgentSelectedEventId: null,
            providerTurns: new Map(),
            messages: new Map(),
            runtimeRequests: new Map(),
            postSettleWakes: [],
            retiredSuppressWakes: new Map(),
            promotedInputIds: new Set(),
            sawInputPromotion: false,
            quarantined: false,
            activeExecution: null,
            parentSubagent: context,
            nextChildTurnOrdinal: 1,
            latestTokenUsage: null,
          });
          const bufferedEvents = deferredChildEvents.get(childSessionId);
          if (bufferedEvents !== undefined) {
            deferredChildEvents.delete(childSessionId);
            pendingDeferredChildEvents.push(...drainOpenCode2DeferredChildEvents(bufferedEvents));
          }
          yield* emitProviderEvent({
            type: "app_thread.created",
            driver: OPENCODE2_PROVIDER,
            appThread: childThread,
          });
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver: OPENCODE2_PROVIDER,
            providerThread: childProviderThread,
          });
        });

        const emitSubagentContext = Effect.fnUntraced(function* (
          context: OpenCode2SubagentContext,
        ) {
          const now = yield* DateTime.now;
          const terminal =
            context.status === "completed" ||
            context.status === "failed" ||
            context.status === "cancelled" ||
            context.status === "interrupted";
          if (terminal && context.completedAt === null) context.completedAt = now;
          const nodeStatus: OrchestrationV2ExecutionNode["status"] = context.status;
          const subagent: OrchestrationV2Subagent = {
            id: context.nodeId,
            threadId: context.parentTurn.threadId,
            runId: context.parentTurn.runId,
            parentNodeId: context.parentTurn.rootNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: OPENCODE2_PROVIDER,
            providerInstanceId: options.instanceId,
            providerThreadId: context.childProviderThreadId,
            childThreadId: context.childThreadId,
            nativeTaskRef: providerRef(context.nativeItemId),
            prompt: context.prompt,
            title: context.title,
            model: context.model,
            status: context.status,
            ...(context.progress === undefined ? {} : { progress: context.progress }),
            result: context.result,
            startedAt: context.startedAt,
            completedAt: context.completedAt,
            updatedAt: now,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: context.nodeId,
              threadId: context.parentTurn.threadId,
              runId: context.parentTurn.runId,
              parentNodeId: context.parentTurn.rootNodeId,
              rootNodeId: context.parentTurn.rootNodeId,
              kind: "subagent",
              status: nodeStatus,
              countsForRun: false,
              providerThreadId:
                context.childProviderThreadId ?? context.parentState.providerThread.id,
              providerTurnId: context.parentTurn.providerTurnId,
              nativeItemRef: providerRef(context.nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: context.startedAt,
              completedAt: context.completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: OPENCODE2_PROVIDER,
            subagent,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE2_PROVIDER,
            turnItem: {
              id: context.turnItemId,
              threadId: context.parentTurn.threadId,
              runId: context.parentTurn.runId,
              nodeId: context.nodeId,
              providerThreadId: context.parentState.providerThread.id,
              providerTurnId: context.parentTurn.providerTurnId,
              nativeItemRef: providerRef(context.nativeItemId),
              parentItemId: null,
              ordinal: itemOrdinal(context.parentTurn, context.nativeItemId),
              status: context.status,
              title: context.title,
              startedAt: context.startedAt,
              completedAt: context.completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: context.nodeId,
              origin: "provider_native",
              driver: OPENCODE2_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: context.childThreadId,
              prompt: context.prompt,
              result: context.result,
            },
          });
        });

        const emitSubagent = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          part: OpenCode2ToolPart,
          terminal?: TerminalTurnStatus,
        ) {
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: part.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: part.id,
          });
          let context = subagentsByNativeItemId.get(part.id);
          if (context === undefined) {
            context = {
              nativeItemId: part.id,
              nodeId,
              turnItemId,
              parentState: state,
              parentTurn: turn,
              startedAt: part.startedAt,
              completedAt: null,
              prompt: recordString(part.input, "prompt") ?? "",
              title: recordString(part.input, "description") ?? null,
              model: recordString(part.input, "model") ?? null,
              childSessionId: null,
              childThreadId: null,
              childProviderThreadId: null,
              status: "pending",
              progress: undefined,
              result: null,
            };
            subagentsByNativeItemId.set(part.id, context);
          }
          context.prompt = recordString(part.input, "prompt") ?? context.prompt;
          context.title = recordString(part.input, "description") ?? context.title;
          context.model = recordString(part.input, "model") ?? context.model;
          const isBackgroundLaunch =
            recordValue(part.input, "background") === true && part.status === "completed";
          if (context.childSessionId === null && !isBackgroundLaunch) {
            const status =
              terminal === undefined ? toolNodeStatus(part.status) : terminalToolStatus(terminal);
            context.status = subagentStatusFromTurnItemStatus(status.item);
            if (context.status !== "running") context.progress = undefined;
            if (part.output !== undefined && context.status === "completed") {
              context.result = part.output;
            } else if (context.status === "failed") {
              context.result = part.errorMessage ?? part.output ?? context.result;
            }
          } else if (isBackgroundLaunch && context.childSessionId === null) {
            context.status = "running";
            context.progress = part.output;
          }

          if (context.childSessionId === null) {
            // Prefer an explicit child session id from tool metadata when the
            // provider reports it (background launch structured.sessionID).
            // Provisional title matching happens only on session.created when
            // it has one unambiguous open context. Tool metadata must identify
            // the child session explicitly.
            const structuredSessionId = recordString(part.structured, "sessionID", "sessionId");
            const matchingChild = (() => {
              if (structuredSessionId === undefined) return undefined;
              const byId = nativeChildSessions.get(structuredSessionId);
              if (
                byId !== undefined &&
                byId.parentID === state.nativeSessionId &&
                !subagentsByChildSessionId.has(byId.id)
              ) {
                return byId;
              }
              return undefined;
            })();
            if (matchingChild !== undefined) yield* bindSubagentChild(context, matchingChild);
          }
          yield* emitSubagentContext(context);
        });

        const emitToolPart = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          part: OpenCode2ToolPart,
          /**
           * Force a terminal status for a tool the turn ended underneath.
           * `session.interrupt` stops the execution without reporting a final
           * state for whatever tool was mid-flight, so the last observed
           * status stays `running` and the row would spin forever.
           */
          terminal?: TerminalTurnStatus,
        ) {
          const normalizedTool = part.name.toLowerCase();
          if (normalizedTool === "subagent") {
            yield* emitSubagent(state, turn, part, terminal);
            return;
          }
          // form.created carries the respondable Input card. Projecting the
          // implementation tool as well would show a stuck "question" row with
          // no UI (observed live when form.created was unhandled).
          if (normalizedTool === "question") return;
          const emittedAt = yield* DateTime.now;
          const status =
            terminal === undefined ? toolNodeStatus(part.status) : terminalToolStatus(terminal);
          const completedAt =
            terminal === undefined ? part.completedAt : (part.completedAt ?? emittedAt);
          const nativeItemRef = providerRef(part.id);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: part.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: part.id,
          });
          const base = {
            id: turnItemId,
            threadId: turn.threadId,
            runId: turn.runId,
            nodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal: itemOrdinal(turn, part.id),
            status: status.item,
            title: part.name,
            startedAt: part.startedAt,
            completedAt,
            updatedAt: emittedAt,
          } satisfies Pick<
            OrchestrationV2TurnItem,
            | "id"
            | "threadId"
            | "runId"
            | "nodeId"
            | "providerThreadId"
            | "providerTurnId"
            | "nativeItemRef"
            | "parentItemId"
            | "ordinal"
            | "status"
            | "title"
            | "startedAt"
            | "completedAt"
            | "updatedAt"
          >;
          const projectionKind = openCodeToolProjectionKind(part.name);
          const exitCode = recordNumber(part.structured, "exit", "exitCode");
          let turnItem: OrchestrationV2TurnItem;
          if (projectionKind === "command_execution") {
            turnItem = {
              ...base,
              type: "command_execution",
              input: recordString(part.input, "command", "cmd") ?? stableJson(part.input),
              ...(part.output === undefined ? {} : { output: part.output }),
              ...(exitCode === undefined ? {} : { exitCode }),
            };
          } else if (projectionKind === "file_change") {
            turnItem = {
              ...base,
              type: "file_change",
              fileName: recordString(part.input, "filePath", "path", "file") ?? part.name,
              ...(recordString(part.input, "oldString", "oldText") === undefined
                ? {}
                : { oldStr: recordString(part.input, "oldString", "oldText")! }),
              ...(recordString(part.input, "newString", "content", "newText") === undefined
                ? {}
                : { newStr: recordString(part.input, "newString", "content", "newText")! }),
              ...(recordString(part.structured, "diff", "patch") === undefined
                ? {}
                : { diffStr: recordString(part.structured, "diff", "patch")! }),
            };
          } else if (projectionKind === "file_search") {
            turnItem = {
              ...base,
              type: "file_search",
              ...(recordString(part.input, "pattern", "query", "path", "filePath") === undefined
                ? {}
                : { pattern: recordString(part.input, "pattern", "query", "path", "filePath")! }),
            };
          } else if (projectionKind === "web_search") {
            const pattern = recordString(part.input, "query", "url", "pattern");
            turnItem = {
              ...base,
              type: "web_search",
              ...(pattern === undefined ? {} : { patterns: [pattern] }),
            };
          } else {
            // OpenCode 2 bridges MCP through execute({ code: tools["t3-code"].x(...) })
            // and skills through skill({ id }). Prefer projected names so the timeline
            // can show T3 product icons / skill ids instead of bare "execute"/"skill".
            const projectedToolName = projectOpenCode2DynamicToolName(
              normalizedTool,
              part.name,
              part.input,
            );
            turnItem = {
              ...base,
              title: projectedToolName,
              type: "dynamic_tool",
              toolName: projectedToolName,
              input: part.input,
              ...(part.output === undefined ? {} : { output: part.output }),
            };
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: "tool_call",
              status: status.node,
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: part.startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE2_PROVIDER,
            turnItem,
          });
        });

        const emitCompaction = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          compaction: OpenCode2Compaction,
        ) {
          const emittedAt = yield* DateTime.now;
          const completedAt =
            compaction.status === "running" ? null : (compaction.completedAt ?? emittedAt);
          const nativeItemRef = providerRef(compaction.id);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: compaction.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: compaction.id,
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: "system",
              status: compaction.status,
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: compaction.startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE2_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: itemOrdinal(turn, compaction.id),
              status: compaction.status,
              title: compactionTitle(compaction.status),
              startedAt: compaction.startedAt,
              completedAt,
              updatedAt: emittedAt,
              type: "compaction",
              driver: OPENCODE2_PROVIDER,
              ...(compaction.summary.length === 0 ? {} : { summary: compaction.summary }),
              ...(compaction.triggerReason === "unknown"
                ? {}
                : { triggerReason: compaction.triggerReason }),
              ...compaction.diagnostics,
            },
          });
        });

        const compactionDiagnosticsLoads = new Set<string>();
        const refreshCompactionDiagnostics = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          compaction: OpenCode2Compaction,
        ) {
          const key = `${turn.providerTurnId}:${compaction.id}`;
          if (compactionDiagnosticsLoads.has(key)) return;
          compactionDiagnosticsLoads.add(key);
          yield* Effect.gen(function* () {
            if (!modelLimits.has(turn.modelSelection.model)) {
              const fetched = yield* retryEmptyOpenCode2VariantCatalog(readVariantCatalog);
              if (fetched !== null && fetched.size > 0 && variantCatalog === null) {
                variantCatalog = fetched;
              }
            }
            const diagnostics = compactionDiagnosticsFor(state, turn, compaction.triggerReason);
            if (diagnostics === null) return;
            if (turn.activeCompaction !== compaction) return;
            compaction.diagnostics = diagnostics;
            yield* emitCompaction(state, turn, compaction);
          }).pipe(Effect.ensuring(Effect.sync(() => compactionDiagnosticsLoads.delete(key))));
        });

        const runningShellForPart = (
          turn: ActiveOpenCode2Turn,
          part: OpenCode2ToolPart,
        ): OpenCode2ShellProjection | undefined =>
          Array.from(shellProjections.values()).find(
            (shell) => shell.turn === turn && shell.part === part && shell.status === "running",
          );

        const runtimeRequestTurnItem = (
          pending: OpenCode2RuntimeRequestProjection,
          status: OrchestrationV2TurnItem["status"],
          completedAt: DateTime.Utc | null,
          updatedAt: DateTime.Utc,
        ): OrchestrationV2TurnItem => {
          const base = {
            id: pending.turnItemId,
            threadId: pending.threadId,
            runId: pending.runId,
            nodeId: pending.nodeId,
            providerThreadId: pending.state.providerThread.id,
            providerTurnId: pending.providerTurnId,
            nativeItemRef: providerRef(pending.nativeRequestId),
            parentItemId: null,
            ordinal: pending.ordinal,
            status,
            startedAt: pending.createdAt,
            completedAt,
            updatedAt,
          };
          if (pending.questions !== undefined) {
            return {
              ...base,
              title: "User input",
              type: "user_input_request",
              requestId: pending.requestId,
              questions: pending.questions.map((question, index) => ({
                id: openCode2QuestionId(index, question.header),
                header: question.header.trim() || `Question ${index + 1}`,
                question:
                  question.question.trim() || question.header.trim() || `Question ${index + 1}`,
                options: question.options.map((option) => ({
                  label: option.label.trim() || "Option",
                  description: option.description.trim() || option.label.trim() || "Option",
                })),
                multiSelect: question.multiple === true,
              })),
            };
          }
          const permission = pending.permission;
          if (permission === undefined) {
            throw protocolError(`OpenCode 2 request ${pending.requestId} has no native payload`);
          }
          return {
            ...base,
            title: permission.action,
            type: "approval_request",
            requestId: pending.requestId,
            requestKind:
              pending.requestKind === "user_input"
                ? "command"
                : (pending.requestKind as Exclude<ProviderRequestKind, "user_input">),
            prompt:
              permission.resources.length === 0
                ? permission.action
                : permission.resources.join("\n"),
          };
        };

        const emitRuntimeRequest = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          sourceTurn: ActiveOpenCode2Turn,
          nativeSessionId: string,
          nativeRequestId: string,
          request:
            | {
                readonly type: "permission";
                readonly action: string;
                readonly resources: ReadonlyArray<string>;
                readonly save: ReadonlyArray<string>;
              }
            | {
                readonly type: "question";
                readonly questions: ReadonlyArray<QuestionV2Info>;
                readonly formFieldKeys?: ReadonlyArray<string>;
                readonly formOptionValues?: ReadonlyArray<Readonly<Record<string, string>>>;
              },
          allowSeen = false,
        ) {
          const nativeRequestKey = openCode2RuntimeRequestNativeKey(
            nativeSessionId,
            nativeRequestId,
          );
          if (!allowSeen && hasSeenRuntimeRequestKey(nativeSessionId, nativeRequestKey)) return;
          if (pendingRequestsByNativeId.has(nativeRequestKey)) return;
          if (settledRequestsByNativeId.has(nativeRequestKey)) return;
          rememberRuntimeRequestKey(nativeSessionId, nativeRequestKey);
          const createdAt = yield* DateTime.now;
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver: OPENCODE2_PROVIDER,
            providerTurnId: turn.providerTurnId,
            nativeRequestId,
          });
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const turnItemId = idAllocator.derive.approvalTurnItem({ requestId });
          const requestKind: OrchestrationV2RuntimeRequest["kind"] =
            request.type === "permission"
              ? openCode2PermissionRequestKind(request.action)
              : "user_input";
          const responseSettlementOutcome = yield* Deferred.make<void>();
          const pendingBase = {
            authoritativeCancellation: false,
            requestId,
            nativeRequestId,
            nativeSessionId,
            turn,
            state,
            nodeId,
            turnItemId,
            requestKind,
            createdAt,
            threadId: turn.threadId,
            runId: turn.runId,
            rootNodeId: turn.rootNodeId,
            providerTurnId: turn.providerTurnId,
            ordinal: itemOrdinal(turn, nativeRequestId),
            rememberedPermission: null,
            responseSettlement: null,
            responseSettlementConfirmed: false,
            responseSettlementOutcome,
            sourceTurn,
          };
          let pending: PendingOpenCode2Request;
          if (request.type === "permission") {
            pending = {
              ...pendingBase,
              permission: {
                action: request.action,
                resources: request.resources,
                save: request.save,
              },
            };
          } else {
            pending = {
              ...pendingBase,
              questions: request.questions,
              ...(request.formFieldKeys === undefined
                ? {}
                : { formFieldKeys: request.formFieldKeys }),
              ...(request.formOptionValues === undefined
                ? {}
                : { formOptionValues: request.formOptionValues }),
            };
          }
          pendingRequests.set(String(requestId), pending);
          pendingRequestsByNativeId.set(nativeRequestKey, pending);
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: turn.providerTurnId,
            nativeRequestRef: providerRef(nativeRequestId),
            kind: requestKind,
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: input.providerSessionId,
            },
            createdAt,
            resolvedAt: null,
          };
          state.runtimeRequests.set(String(requestId), runtimeRequest);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: request.type === "question" ? "user_input_request" : "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(pending.nativeRequestId),
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: createdAt,
              completedAt: null,
            },
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: OPENCODE2_PROVIDER,
            threadId: turn.threadId,
            runtimeRequest,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE2_PROVIDER,
            turnItem: runtimeRequestTurnItem(pending, "waiting", null, createdAt),
          });
          yield* updateProviderSession("waiting", null);
        });

        const applyRuntimeRequestSettlement = Effect.fnUntraced(function* (
          pending: OpenCode2RuntimeRequestProjection,
          settlement: OpenCode2RuntimeRequestSettlement,
          rememberPermissionForSession = true,
        ) {
          const resolvedAt = yield* DateTime.now;
          const current = pending.state.runtimeRequests.get(String(pending.requestId));
          if (current !== undefined) {
            const resolved: OrchestrationV2RuntimeRequest = {
              ...current,
              status: settlement.requestStatus,
              resolvedAt,
            };
            pending.state.runtimeRequests.set(String(pending.requestId), resolved);
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: OPENCODE2_PROVIDER,
              threadId: pending.threadId,
              runtimeRequest: resolved,
            });
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: pending.nodeId,
              threadId: pending.threadId,
              runId: pending.runId,
              parentNodeId: pending.rootNodeId,
              rootNodeId: pending.rootNodeId,
              kind: pending.questions === undefined ? "approval_request" : "user_input_request",
              status: settlement.itemStatus,
              countsForRun: false,
              providerThreadId: pending.state.providerThread.id,
              providerTurnId: pending.providerTurnId,
              nativeItemRef: providerRef(pending.nativeRequestId),
              runtimeRequestId: pending.requestId,
              checkpointScopeId: null,
              startedAt: pending.createdAt,
              completedAt: resolvedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE2_PROVIDER,
            turnItem: runtimeRequestTurnItem(
              pending,
              settlement.itemStatus,
              resolvedAt,
              resolvedAt,
            ),
          });
          if (
            rememberPermissionForSession &&
            settlement.rememberPermissionForSession &&
            pending.permission !== undefined
          ) {
            return rememberOpenCode2SessionPermission(
              sessionPermissions,
              pending.nativeSessionId,
              pending.permission,
            );
          }
          return null;
        });

        const settledRequestProjection = (
          pending: PendingOpenCode2Request,
        ): SettledOpenCode2RequestProjection => ({
          authoritativeCancellation: pending.authoritativeCancellation,
          requestId: pending.requestId,
          nativeRequestId: pending.nativeRequestId,
          nativeSessionId: pending.nativeSessionId,
          state: pending.state,
          threadId: pending.threadId,
          runId: pending.runId,
          rootNodeId: pending.rootNodeId,
          providerTurnId: pending.providerTurnId,
          nodeId: pending.nodeId,
          turnItemId: pending.turnItemId,
          requestKind: pending.requestKind,
          createdAt: pending.createdAt,
          ordinal: pending.ordinal,
          ...(pending.permission === undefined ? {} : { permission: pending.permission }),
          ...(pending.questions === undefined ? {} : { questions: pending.questions }),
          sourceProviderTurnId: pending.sourceTurn.providerTurnId,
          responseSettlement: pending.responseSettlement,
          responseSettlementConfirmed: pending.responseSettlementConfirmed,
          rememberedPermission: pending.rememberedPermission,
        });

        const resolveRuntimeRequestUnlocked = Effect.fnUntraced(function* (
          nativeSessionId: string,
          nativeRequestId: string,
          status: "resolved" | "cancelled",
          useResponseSettlement = status === "resolved",
        ) {
          const nativeRequestKey = openCode2RuntimeRequestNativeKey(
            nativeSessionId,
            nativeRequestId,
          );
          const existingSettlement = settledRequestsByNativeId.get(nativeRequestKey);
          if (existingSettlement !== undefined) {
            let settlementChanged = false;
            if (status === "cancelled") {
              existingSettlement.pending.authoritativeCancellation = true;
              if (existingSettlement.pending.rememberedPermission !== null) {
                forgetOpenCode2SessionPermission(
                  sessionPermissions,
                  existingSettlement.pending.nativeSessionId,
                  existingSettlement.pending.rememberedPermission,
                );
                existingSettlement.pending.rememberedPermission = null;
              }
              if (
                existingSettlement.settlement.requestStatus !== "cancelled" ||
                existingSettlement.settlement.itemStatus !== "cancelled"
              ) {
                existingSettlement.settlement = {
                  requestStatus: "cancelled",
                  itemStatus: "cancelled",
                  rememberPermissionForSession: false,
                };
                settlementChanged = true;
              }
            }
            if (!settlementChanged) return;
            yield* applyRuntimeRequestSettlement(
              existingSettlement.pending,
              existingSettlement.settlement,
              false,
            );
            pendingRequests.delete(String(existingSettlement.pending.requestId));
            pendingRequestsByNativeId.delete(nativeRequestKey);
            if (
              existingSettlement.pending.rememberedPermission === null &&
              existingSettlement.pending.state.providerTurns.get(
                String(existingSettlement.pending.sourceProviderTurnId),
              )?.completedAt !== null
            ) {
              settledRequestsByNativeId.delete(nativeRequestKey);
            }
            return;
          }
          const pending = pendingRequestsByNativeId.get(nativeRequestKey);
          if (pending === undefined) return;
          if (status === "cancelled") {
            pending.authoritativeCancellation = true;
            if (pending.rememberedPermission !== null) {
              forgetOpenCode2SessionPermission(
                sessionPermissions,
                pending.nativeSessionId,
                pending.rememberedPermission,
              );
              pending.rememberedPermission = null;
            }
          }
          const settlement =
            (useResponseSettlement ? pending.responseSettlement : null) ??
            (status === "resolved"
              ? {
                  requestStatus: "resolved" as const,
                  itemStatus: "completed" as const,
                  rememberPermissionForSession: false,
                }
              : {
                  requestStatus: "cancelled" as const,
                  itemStatus: "cancelled" as const,
                  rememberPermissionForSession: false,
                });
          const resolvedAt = yield* DateTime.now;
          const current = pending.state.runtimeRequests.get(String(pending.requestId));
          if (current !== undefined) {
            const resolved: OrchestrationV2RuntimeRequest = {
              ...current,
              status: settlement.requestStatus,
              resolvedAt,
            };
            pending.state.runtimeRequests.set(String(pending.requestId), resolved);
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: OPENCODE2_PROVIDER,
              threadId: pending.threadId,
              runtimeRequest: resolved,
            });
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: pending.nodeId,
              threadId: pending.threadId,
              runId: pending.runId,
              parentNodeId: pending.rootNodeId,
              rootNodeId: pending.rootNodeId,
              kind: pending.questions === undefined ? "approval_request" : "user_input_request",
              status: settlement.itemStatus,
              countsForRun: false,
              providerThreadId: pending.state.providerThread.id,
              providerTurnId: pending.providerTurnId,
              nativeItemRef: providerRef(nativeRequestId),
              runtimeRequestId: pending.requestId,
              checkpointScopeId: null,
              startedAt: pending.createdAt,
              completedAt: resolvedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE2_PROVIDER,
            turnItem: runtimeRequestTurnItem(
              pending,
              settlement.itemStatus,
              resolvedAt,
              resolvedAt,
            ),
          });
          if (
            settlement.rememberPermissionForSession &&
            !pending.authoritativeCancellation &&
            pending.permission !== undefined
          ) {
            const rememberedPermission = rememberOpenCode2SessionPermission(
              sessionPermissions,
              pending.nativeSessionId,
              pending.permission,
            );
            if (rememberedPermission !== null) {
              pending.rememberedPermission = rememberedPermission;
            }
          }
          let finalSettlement = settlement;
          if (pending.authoritativeCancellation && settlement.itemStatus !== "cancelled") {
            if (pending.rememberedPermission !== null) {
              forgetOpenCode2SessionPermission(
                sessionPermissions,
                pending.nativeSessionId,
                pending.rememberedPermission,
              );
              pending.rememberedPermission = null;
            }
            finalSettlement = {
              requestStatus: "cancelled",
              itemStatus: "cancelled",
              rememberPermissionForSession: false,
            };
            yield* applyRuntimeRequestSettlement(pending, finalSettlement, false);
          }
          const settled: SettledOpenCode2Request = {
            pending: settledRequestProjection(pending),
            settlement: finalSettlement,
          };
          settledRequestsByNativeId.delete(nativeRequestKey);
          settledRequestsByNativeId.set(nativeRequestKey, settled);
          pendingRequests.delete(String(pending.requestId));
          pendingRequestsByNativeId.delete(nativeRequestKey);
          yield* Deferred.succeed(pending.responseSettlementOutcome, undefined);
          yield* refreshProviderSessionAfterRuntimeRequestSettlement(pending);
        });

        const resolveRuntimeRequest = resolveRuntimeRequestUnlocked;

        const refreshProviderSessionAfterRuntimeRequestSettlement = Effect.fnUntraced(function* (
          pending: PendingOpenCode2Request,
        ) {
          if (pendingRequests.size > 0) return;
          if (!pending.sourceTurn.finalized) {
            yield* updateProviderSession("running", null);
            return;
          }
          if (pending.sourceTurn.terminalStatus !== "completed") return;
          const anotherTurnIsActive = Array.from(threads.values()).some(
            (candidate) => candidate.activeTurn !== null && !candidate.activeTurn.finalized,
          );
          yield* updateProviderSession(anotherTurnIsActive ? "running" : "ready", null);
        });

        const confirmRuntimeRequestResponse = (
          nativeSessionId: string,
          nativeRequestId: string,
        ): void => {
          const pending = pendingRequestsByNativeId.get(
            openCode2RuntimeRequestNativeKey(nativeSessionId, nativeRequestId),
          );
          if (pending?.responseSettlement !== null && pending?.responseSettlement !== undefined) {
            pending.responseSettlementConfirmed = true;
          }
        };

        const resolvePermissionReply = Effect.fnUntraced(function* (
          nativeSessionId: string,
          nativeRequestId: string,
          reply: unknown,
        ) {
          const nativeRequestKey = openCode2RuntimeRequestNativeKey(
            nativeSessionId,
            nativeRequestId,
          );
          const request =
            pendingRequestsByNativeId.get(nativeRequestKey) ??
            settledRequestsByNativeId.get(nativeRequestKey)?.pending;
          const autoReplyState = autoReplyPermissionsByNativeKey.get(nativeRequestKey);
          if (request === undefined && autoReplyState !== undefined) {
            autoReplyState.confirmed = true;
            autoReplyState.reply = reply;
            return;
          }
          if (reply === "reject" && request?.responseSettlement?.itemStatus === "cancelled") {
            request.responseSettlementConfirmed = true;
            yield* resolveRuntimeRequest(nativeSessionId, nativeRequestId, "resolved", true);
            return;
          }
          if (reply !== "reject") {
            confirmRuntimeRequestResponse(nativeSessionId, nativeRequestId);
          }
          yield* resolveRuntimeRequest(
            nativeSessionId,
            nativeRequestId,
            openCode2PermissionReplyStatus(reply),
          );
        });

        const respondWithRuntimeRequestSettlement = Effect.fnUntraced(function* <A, E, R>(
          pending: PendingOpenCode2Request,
          settlement: OpenCode2RuntimeRequestSettlement,
          response: Effect.Effect<A, E, R>,
        ) {
          if (pending.responseSettlement !== null) {
            return yield* protocolError(
              `OpenCode 2 request ${pending.requestId} is already being answered`,
            );
          }
          pending.responseSettlement = settlement;
          const exit = yield* Effect.exit(response);
          if (Exit.isFailure(exit)) {
            const nativeRequestKey = openCode2RuntimeRequestNativeKey(
              pending.nativeSessionId,
              pending.nativeRequestId,
            );
            const settled = settledRequestsByNativeId.get(nativeRequestKey);
            if (settled?.pending.requestId === pending.requestId) return;
            if (pendingRequestsByNativeId.get(nativeRequestKey) !== pending) return;
            if (pending.sourceTurn.finalized) {
              yield* resolveRuntimeRequest(
                pending.nativeSessionId,
                pending.nativeRequestId,
                "cancelled",
                false,
              );
              return;
            }
            pending.responseSettlement = null;
            return yield* Effect.failCause(exit.cause);
          }
          pending.responseSettlementConfirmed = true;
          yield* resolveRuntimeRequest(
            pending.nativeSessionId,
            pending.nativeRequestId,
            settlement.requestStatus,
            true,
          );
        });

        const finalizeTurnNow = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          status: TerminalTurnStatus,
          terminal?: {
            readonly failure?: OrchestrationV2ProviderFailure;
            readonly threadDisposition?: "reusable" | "broken";
          },
        ) {
          const completedAt = yield* DateTime.now;
          for (const part of turn.parts.values()) {
            if (part.kind === "tool") {
              const subagent = subagentsByNativeItemId.get(part.id);
              const childTurn =
                subagent?.childSessionId === null || subagent?.childSessionId === undefined
                  ? null
                  : threads.get(subagent.childSessionId)?.activeTurn;
              if (
                part.name.toLowerCase() === "subagent" &&
                childTurn !== null &&
                childTurn !== undefined &&
                !childTurn.finalized
              ) {
                continue;
              }
              if (status === "completed" && runningShellForPart(turn, part) !== undefined) {
                continue;
              }
              if (openCode2ToolNeedsTerminalOverride(part, status)) {
                yield* emitToolPart(state, turn, part, status);
              }
              continue;
            }
            yield* emitTextPart(state, turn, part, true);
          }
          if (turn.activeCompaction?.status === "running") {
            turn.activeCompaction.status = compactionStatusFromTerminalTurnStatus(status);
            turn.activeCompaction.completedAt = completedAt;
            yield* emitCompaction(state, turn, turn.activeCompaction);
          }
          for (const pending of Array.from(pendingRequests.values())) {
            if (
              pending.sourceTurn.providerTurnId === turn.providerTurnId ||
              pending.nativeSessionId === state.nativeSessionId
            ) {
              const useResponseSettlement =
                status === "completed" && pending.responseSettlementConfirmed;
              yield* resolveRuntimeRequest(
                pending.nativeSessionId,
                pending.nativeRequestId,
                useResponseSettlement ? "resolved" : "cancelled",
                useResponseSettlement,
              );
            }
          }
          if (status !== "completed") {
            for (const settled of Array.from(settledRequestsByNativeId.values())) {
              if (settled.pending.sourceProviderTurnId === turn.providerTurnId) {
                yield* resolveRuntimeRequest(
                  settled.pending.nativeSessionId,
                  settled.pending.nativeRequestId,
                  "cancelled",
                  false,
                );
              }
            }
          }
          for (const [nativeRequestKey, settled] of settledRequestsByNativeId) {
            if (
              settled.pending.sourceProviderTurnId === turn.providerTurnId &&
              settled.pending.rememberedPermission === null
            ) {
              settledRequestsByNativeId.delete(nativeRequestKey);
            }
          }
          yield* emitProviderTurn(state, turn, status, completedAt);
          const threadDisposition = terminal?.threadDisposition ?? "reusable";
          let providerThreadStatus: OrchestrationV2ProviderThread["status"] = "idle";
          if (turn.isRoot) {
            providerThreadStatus = "active";
          } else if (threadDisposition === "broken") {
            providerThreadStatus = "error";
          }
          yield* updateProviderThread(state, {
            status: providerThreadStatus,
            nativeConversationHeadRef:
              turn.nativeInputId === null
                ? state.providerThread.nativeConversationHeadRef
                : providerRef(turn.nativeInputId, "weak"),
          });
          state.activeTurn = null;
          if (!turn.isRoot) {
            yield* emitProviderEvent({
              type: "node.updated",
              driver: OPENCODE2_PROVIDER,
              node: {
                id: turn.rootNodeId,
                threadId: turn.threadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: turn.rootNodeId,
                kind: "root_turn",
                status,
                countsForRun: false,
                providerThreadId: state.providerThread.id,
                providerTurnId: turn.providerTurnId,
                nativeItemRef: providerRef(state.nativeSessionId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: turn.startedAt,
                completedAt,
              },
            });
            const context = state.parentSubagent;
            if (context !== null) {
              const assistantResult = Array.from(turn.parts.values()).findLast(
                (part): part is OpenCode2TextPart =>
                  part.kind === "text" && part.text.trim().length > 0,
              )?.text;
              context.status = status;
              context.progress = undefined;
              if (
                (status === "completed" || status === "interrupted") &&
                assistantResult !== undefined
              ) {
                context.result = assistantResult;
              } else if (status === "failed") {
                const failure =
                  terminal?.failure ??
                  turn.providerRetry?.failure ??
                  makeProviderFailure({
                    message: sessionEntity.lastError ?? undefined,
                    class: "provider_error",
                  });
                context.result = failure.message;
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  driver: OPENCODE2_PROVIDER,
                  turnItem: makeProviderFailureTurnItem({
                    idAllocator,
                    driver: OPENCODE2_PROVIDER,
                    threadId: turn.threadId,
                    runId: null,
                    nodeId: turn.rootNodeId,
                    providerThreadId: state.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    itemOrdinal: itemOrdinal(turn, `terminal-failure:${turn.providerTurnId}`),
                    failure,
                    ...(turn.providerRetry === null
                      ? {}
                      : {
                          retry: turn.providerRetry.retry,
                          retryStartedAt: turn.providerRetry.startedAt,
                        }),
                    occurredAt: completedAt,
                  }),
                });
              }
              yield* emitSubagentContext(context);
            }
            if (pendingRequests.size === 0) {
              const anotherTurnIsActive = Array.from(threads.values()).some(
                (candidate) => candidate.activeTurn !== null && !candidate.activeTurn.finalized,
              );
              yield* updateProviderSession(anotherTurnIsActive ? "running" : "ready", null);
            }
            return;
          }
          const anotherTurnIsActive = Array.from(threads.values()).some(
            (candidate) => candidate.activeTurn !== null && !candidate.activeTurn.finalized,
          );
          let providerSessionStatus: OrchestrationV2ProviderSession["status"] = "ready";
          if (pendingRequests.size > 0) {
            providerSessionStatus = "waiting";
          } else if (anotherTurnIsActive) {
            providerSessionStatus = "running";
          } else if (status === "failed") {
            providerSessionStatus = "error";
          }
          yield* updateProviderSession(
            providerSessionStatus,
            status === "failed" ? sessionEntity.lastError : null,
          );
          if (status === "failed") {
            yield* emitProviderEvent({
              type: "turn.terminal",
              driver: OPENCODE2_PROVIDER,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              runOrdinal: turn.runOrdinal,
              failureItemOrdinal: itemOrdinal(turn, `terminal-failure:${turn.providerTurnId}`),
              status,
              failure:
                terminal?.failure ??
                turn.providerRetry?.failure ??
                makeProviderFailure({
                  message: sessionEntity.lastError ?? undefined,
                  class: "provider_error",
                }),
              ...(turn.providerRetry === null
                ? {}
                : {
                    retry: turn.providerRetry.retry,
                    retryStartedAt: turn.providerRetry.startedAt,
                  }),
              threadDisposition,
            });
            return;
          }
          yield* emitProviderEvent({
            type: "turn.terminal",
            driver: OPENCODE2_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurnId,
            runOrdinal: turn.runOrdinal,
            status,
            failure: null,
            threadDisposition,
          });
        });

        const finalizeTurn = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          status: TerminalTurnStatus,
          terminal?: {
            readonly failure?: OrchestrationV2ProviderFailure;
            readonly threadDisposition?: "reusable" | "broken";
          },
        ) {
          if (turn.finalized) {
            if (
              turn.terminalStatus === "completed" &&
              status !== "completed" &&
              state.activeTurn === turn
            ) {
              turn.terminalStatus = status;
              yield* finalizeTurnNow(state, turn, status, terminal);
            }
            return;
          }
          turn.finalized = true;
          turn.terminalStatus = status;
          const pendingResponseOutcomes =
            status === "completed"
              ? Array.from(pendingRequests.values())
                  .filter(
                    (pending) =>
                      (pending.sourceTurn.providerTurnId === turn.providerTurnId ||
                        pending.nativeSessionId === state.nativeSessionId) &&
                      pending.responseSettlement !== null &&
                      !pending.responseSettlementConfirmed,
                  )
                  .map((pending) => Deferred.await(pending.responseSettlementOutcome))
              : [];
          if (pendingResponseOutcomes.length === 0) {
            yield* finalizeTurnNow(state, turn, status, terminal);
            return;
          }
          yield* Effect.gen(function* () {
            yield* Effect.all(pendingResponseOutcomes, { concurrency: "unbounded" }).pipe(
              Effect.timeoutOption(`${OPENCODE2_RUNTIME_REQUEST_SETTLE_TIMEOUT_MS} millis`),
            );
            if (turn.terminalStatus !== status || state.activeTurn !== turn) return;
            yield* finalizeTurnNow(state, turn, status, terminal);
          }).pipe(Effect.forkIn(scope), Effect.asVoid);
        });

        /** Resolve the active turn for a session id, or nothing if it settled. */
        const activeFor = (
          sessionID: string | undefined,
        ): { state: OpenCode2ThreadState; turn: ActiveOpenCode2Turn } | null => {
          if (sessionID === undefined) return null;
          const state = threads.get(sessionID);
          const turn = state?.activeTurn;
          if (state === undefined || turn === null || turn === undefined || turn.finalized) {
            return null;
          }
          return { state, turn };
        };

        const terminalFor = (
          sessionID: string | undefined,
        ): { state: OpenCode2ThreadState; turn: ActiveOpenCode2Turn } | null => {
          if (sessionID === undefined) return null;
          const state = threads.get(sessionID);
          const turn = state?.activeTurn;
          if (state === undefined || turn === null || turn === undefined) return null;
          if (turn.finalized && turn.terminalStatus !== "completed") return null;
          return { state, turn };
        };

        const runtimeRequestProjectionFor = (active: {
          readonly state: OpenCode2ThreadState;
          readonly turn: ActiveOpenCode2Turn;
        }) => {
          const parent = active.state.parentSubagent;
          return parent === null ? active : { state: parent.parentState, turn: parent.parentTurn };
        };

        const createChildTurn = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          inputID: string,
        ) {
          const context = state.parentSubagent;
          if (state.appThread === null || context === null) return null;
          const now = yield* DateTime.now;
          const rootNodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: `${state.nativeSessionId}:root:${inputID}`,
          });
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: OPENCODE2_PROVIDER,
            nativeTurnId: inputID,
          });
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: providerTurnId,
            providerThreadId: state.providerThread.id,
            nodeId: rootNodeId,
            runAttemptId: null,
            nativeTurnRef: providerRef(inputID, "weak"),
            ordinal: state.nextChildTurnOrdinal++,
            status: "running",
            startedAt: now,
            completedAt: null,
          };
          const itemOrdinals = openCode2ChildTurnItemOrdinals(providerTurn.ordinal);
          const turn: ActiveOpenCode2Turn = {
            isRoot: false,
            providerBufferedContinuation: false,
            threadId: state.appThread.id,
            runId: null,
            rootNodeId,
            appThread: state.appThread,
            modelSelection: state.appThread.modelSelection,
            runtimePolicy: context.parentTurn.runtimePolicy,
            providerTurnId,
            runOrdinal: context.parentTurn.runOrdinal,
            startedAt: now,
            itemOrdinals: new Map(),
            parts: new Map(),
            toolIdsByCallId: new Map(),
            providerTurn,
            nextItemOrdinal: itemOrdinals.next,
            nativeInputId: inputID,
            activeCompaction: null,
            executionStarted: false,
            interrupted: false,
            finalized: false,
            terminalStatus: null,
            providerRetry: null,
            pendingExecutionFailure: null,
          };
          state.activeTurn = turn;
          state.providerTurns.set(String(providerTurnId), providerTurn);
          const userMessageId = idAllocator.derive.messageFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: inputID,
          });
          const userTurnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE2_PROVIDER,
            nativeItemId: inputID,
          });
          const userArtifacts = makeSubagentConversationArtifacts({
            messageId: userMessageId,
            turnItemId: userTurnItemId,
            threadId: turn.threadId,
            rootNodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId,
            nativeItemRef: providerRef(inputID, "weak"),
            role: "user",
            text: context.prompt,
            ordinal: itemOrdinals.user,
            now,
          });
          state.messages.set(String(userMessageId), userArtifacts.message);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: rootNodeId,
              threadId: turn.threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId,
              nativeItemRef: providerRef(inputID, "weak"),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          });
          yield* emitProviderTurn(state, turn, "running", null);
          yield* updateProviderThread(state, {
            status: "active",
            firstRunOrdinal: state.providerThread.firstRunOrdinal ?? providerTurn.ordinal,
            lastRunOrdinal: providerTurn.ordinal,
            nativeConversationHeadRef: providerRef(inputID, "weak"),
          });
          yield* emitProviderEvent({
            type: "message.updated",
            driver: OPENCODE2_PROVIDER,
            message: userArtifacts.message,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE2_PROVIDER,
            turnItem: userArtifacts.turnItem,
          });
          context.status = "running";
          context.progress = undefined;
          yield* emitSubagentContext(context);
          return turn;
        });

        const textPartId = (kind: "text" | "reasoning", messageId: string, ordinal: number) =>
          `${messageId}:${kind}:${ordinal}`;

        const upsertTextPart = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          kind: "text" | "reasoning",
          data: { readonly assistantMessageID: string; readonly ordinal: number },
          update: { readonly delta?: string; readonly text?: string; readonly completed?: boolean },
        ) {
          const id = textPartId(kind, data.assistantMessageID, data.ordinal);
          const startedAt = yield* DateTime.now;
          const existing = turn.parts.get(id);
          const part: OpenCode2TextPart =
            existing !== undefined && existing.kind !== "tool"
              ? existing
              : { kind, id, startedAt, text: "", completed: false };
          if (update.text !== undefined) part.text = update.text;
          else if (update.delta !== undefined) part.text += update.delta;
          if (update.completed === true) part.completed = true;
          turn.parts.set(id, part);
          yield* emitTextPart(state, turn, part);
        });

        const upsertToolPart = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          callId: string,
          update: {
            readonly name?: string;
            readonly input?: Record<string, unknown>;
            readonly inputDelta?: string;
            readonly output?: string;
            readonly structured?: Record<string, unknown>;
            readonly status?: OpenCode2ToolStatus;
            readonly errorMessage?: string;
          },
        ) {
          const now = yield* DateTime.now;
          const id = turn.toolIdsByCallId.get(callId) ?? `tool:${callId}`;
          turn.toolIdsByCallId.set(callId, id);
          const existing = turn.parts.get(id);
          const part: OpenCode2ToolPart =
            existing !== undefined && existing.kind === "tool"
              ? existing
              : {
                  kind: "tool",
                  id,
                  callId,
                  startedAt: now,
                  // The name arrives on `session.tool.input.started`, ahead of
                  // every other event for this call, so this placeholder only
                  // shows if 2.x ever reorders them.
                  name: update.name ?? "tool",
                  input: {},
                  inputText: "",
                  output: undefined,
                  structured: undefined,
                  status: "pending",
                  errorMessage: undefined,
                  completedAt: null,
                };
          if (update.name !== undefined) part.name = update.name;
          if (update.inputDelta !== undefined) part.inputText += update.inputDelta;
          if (update.input !== undefined) part.input = update.input;
          if (update.output !== undefined) part.output = update.output;
          if (update.structured !== undefined) part.structured = update.structured;
          if (update.errorMessage !== undefined) part.errorMessage = update.errorMessage;
          const preserveRunningShell =
            update.status !== undefined &&
            (update.status === "completed" || update.status === "error") &&
            runningShellForPart(turn, part) !== undefined;
          if (update.status !== undefined && !preserveRunningShell) {
            part.status = update.status;
            if (update.status === "completed" || update.status === "error") part.completedAt = now;
          }
          turn.parts.set(id, part);
          yield* emitToolPart(state, turn, part);
        });

        const shellToolStatus = (shell: ShellInfoV2): OpenCode2ToolStatus => {
          if (shell.status === "running") return "running";
          if (shell.status === "exited" && shell.exit === 0) return "completed";
          return "error";
        };

        const registerShellProjection = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          shell: ShellInfoV2,
        ) {
          const existing = shellProjections.get(shell.id);
          if (existing !== undefined) {
            existing.status = shell.status;
            existing.part.status = shellToolStatus(shell);
            existing.part.structured = {
              ...existing.part.structured,
              ...(shell.exit === undefined ? {} : { exit: shell.exit }),
            };
            if (existing.part.status !== "running") {
              existing.part.completedAt = yield* DateTime.now;
            }
            yield* emitToolPart(existing.state, existing.turn, existing.part);
            return existing;
          }

          const turn = state.activeTurn;
          if (turn === null) return null;
          const associated = Array.from(turn.parts.values()).find(
            (part): part is OpenCode2ToolPart =>
              part.kind === "tool" &&
              openCodeToolProjectionKind(part.name) === "command_execution" &&
              recordString(part.input, "command", "cmd") === shell.command &&
              Array.from(shellProjections.values()).every((projection) => projection.part !== part),
          );
          const now = yield* DateTime.now;
          const part: OpenCode2ToolPart =
            associated ??
            ({
              kind: "tool",
              id: `shell:${shell.id}`,
              callId: shell.id,
              startedAt: dateTimeFromEpoch(shell.time?.started, now),
              name: "bash",
              input: { command: shell.command },
              inputText: "",
              output: undefined,
              structured: shell.exit === undefined ? undefined : { exit: shell.exit },
              status: shellToolStatus(shell),
              errorMessage: undefined,
              completedAt:
                shell.status === "running" ? null : dateTimeFromEpoch(shell.time?.completed, now),
            } satisfies OpenCode2ToolPart);
          part.status = shellToolStatus(shell);
          if (shell.exit !== undefined) {
            part.structured = { ...part.structured, exit: shell.exit };
          }
          if (part.status !== "running") {
            part.completedAt = dateTimeFromEpoch(shell.time?.completed, now);
          }
          turn.parts.set(part.id, part);
          const projection: OpenCode2ShellProjection = {
            shellId: shell.id,
            state,
            turn,
            part,
            location: state.location,
            status: shell.status,
          };
          shellProjections.set(shell.id, projection);
          shellSessionIds.set(shell.id, state.nativeSessionId);
          yield* emitToolPart(state, turn, part);
          return projection;
        });

        const readShellOutput = Effect.fnUntraced(function* (
          shellId: string,
          location: SessionInfoV2["location"],
          initial?: {
            readonly output: string;
            readonly cursor: number;
            readonly truncated: boolean;
          },
        ) {
          let output = initial?.output ?? "";
          let cursor = initial?.cursor ?? 0;
          let truncated = initial?.truncated ?? true;
          while (truncated) {
            const parameters = {
              id: shellId,
              location,
              cursor: String(cursor),
              limit: String(64 * 1024),
            };
            const response = yield* sdkCall("shell.output", parameters, () =>
              readShellOutputHttp({
                id: shellId,
                location,
                cursor: String(cursor),
                limit: String(64 * 1024),
              }),
            );
            const page = yield* unwrapOpenCode2Data<{
              readonly output: string;
              readonly cursor: number;
              readonly size: number;
              readonly truncated: boolean;
            }>("shell.output", response);
            output += page.output;
            if (!page.truncated) return output;
            if (page.cursor <= cursor) {
              return yield* protocolError(
                `OpenCode 2 shell ${shellId} output cursor did not advance`,
              );
            }
            cursor = page.cursor;
            truncated = page.truncated;
          }
          return output;
        });

        const completeShellProjection = Effect.fnUntraced(function* (
          shellId: string,
          patch: {
            readonly exit?: number;
            readonly status: ShellInfoV2["status"];
            readonly output?: {
              readonly output: string;
              readonly cursor: number;
              readonly truncated: boolean;
            };
          },
        ) {
          const projection = shellProjections.get(shellId);
          if (projection === undefined) return;
          projection.status = patch.status;
          if (
            projection.turn.providerTurn.status !== "running" &&
            projection.turn.providerTurn.status !== "completed"
          ) {
            return;
          }
          const output =
            patch.status === "killed" && patch.output === undefined
              ? projection.part.output
              : yield* readShellOutput(shellId, projection.location, patch.output).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to read OpenCode 2 shell output.", {
                      errorTag: causeErrorTag(cause),
                      provider: OPENCODE2_PROVIDER,
                      shellId,
                    }).pipe(Effect.as(projection.part.output)),
                  ),
                );
          const completedAt = yield* DateTime.now;
          projection.part.status =
            patch.status === "exited" && patch.exit === 0 ? "completed" : "error";
          projection.part.completedAt = completedAt;
          if (output !== undefined) projection.part.output = output;
          projection.part.structured = {
            ...projection.part.structured,
            ...(patch.exit === undefined ? {} : { exit: patch.exit }),
          };
          yield* emitToolPart(projection.state, projection.turn, projection.part);
        });

        const removeRunningShellsForTurn = Effect.fnUntraced(function* (turn: ActiveOpenCode2Turn) {
          const running = Array.from(shellProjections.values()).filter(
            (projection) => projection.turn === turn && projection.status === "running",
          );
          let allRemoved = true;
          for (const projection of running) {
            const parameters = {
              id: projection.shellId,
              location: projection.location,
            };
            const removed = yield* sdkCall("shell.remove", parameters, () =>
              removeShellHttp({
                id: projection.shellId,
                location: projection.location,
              }),
            ).pipe(
              Effect.map(openCode2ShellRemovalSucceeded),
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to stop an interrupted OpenCode 2 shell.", {
                  errorTag: causeErrorTag(cause),
                  provider: OPENCODE2_PROVIDER,
                  shellId: projection.shellId,
                }).pipe(Effect.as(false)),
              ),
            );
            if (!removed) allRemoved = false;
          }
          return allRemoved;
        });

        const autoReplyPermission = Effect.fnUntraced(function* <E, R>(
          sessionID: string,
          requestID: string,
          reply: "once" | "reject",
          fallback: Effect.Effect<void, E, R>,
        ) {
          const nativeRequestKey = openCode2RuntimeRequestNativeKey(sessionID, requestID);
          if (hasSeenRuntimeRequestKey(sessionID, nativeRequestKey)) return;
          rememberRuntimeRequestKey(sessionID, nativeRequestKey);
          const state = { confirmed: false, reply: undefined as unknown };
          autoReplyPermissionsByNativeKey.set(nativeRequestKey, state);
          yield* Effect.gen(function* () {
            const replied = yield* sdkCall(
              "session.permission.reply",
              { sessionID, requestID, reply },
              () => client.permission.reply({ sessionID, requestID, reply }),
            ).pipe(
              Effect.as(true),
              Effect.catch((cause: OpenCode2RuntimeError) =>
                Effect.logWarning("Failed to answer an OpenCode 2 permission request.", {
                  category: cause.category,
                  operation: cause.operation,
                  provider: OPENCODE2_PROVIDER,
                }).pipe(Effect.as(false)),
              ),
            );
            if (!replied && !state.confirmed) {
              yield* fallback;
              if (state.confirmed) {
                yield* resolvePermissionReply(sessionID, requestID, state.reply);
              }
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => autoReplyPermissionsByNativeKey.delete(nativeRequestKey)),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          );
        });

        const failActiveTurns = Effect.fnUntraced(function* (
          detail: string,
          failureClass: "transport_error" | "provider_error",
          code: string | null = null,
          retryable: boolean | null = null,
        ) {
          yield* updateProviderSession("error", detail);
          for (const state of threads.values()) {
            if (state.activeTurn !== null) {
              yield* finalizeTurn(state, state.activeTurn, "failed", {
                failure: makeProviderFailure({
                  message: detail,
                  code,
                  class: failureClass,
                  retryable,
                }),
                threadDisposition: "broken",
              });
            }
          }
          yield* updateProviderSession("error", detail);
        });

        const allActiveTurnsAwaitRuntimeRequest = (): boolean =>
          openCode2AllActiveTurnsAwaitRuntimeRequest({
            activeTurns: Array.from(threads.values()).flatMap((threadState) => {
              const turn = threadState.activeTurn;
              return turn === null
                ? []
                : [
                    {
                      nativeSessionId: threadState.nativeSessionId,
                      providerTurnId: String(turn.providerTurnId),
                    },
                  ];
            }),
            pendingRequests: Array.from(pendingRequests.values()).map((pending) => ({
              nativeSessionId: pending.nativeSessionId,
              providerTurnId: String(pending.providerTurnId),
            })),
          });

        const allActiveTurnsHaveInFlightPendingWork = (nowMs: number): boolean =>
          Array.from(threads.values()).every((threadState) => {
            const turn = threadState.activeTurn;
            if (turn === null) return true;
            const retryRemainsScheduled = openCode2ProviderRetryIsScheduled(
              turn.providerRetry,
              nowMs,
            );
            return openCode2HasInFlightPendingWork({
              toolStatuses: Array.from(turn.parts.values())
                .filter((part): part is OpenCode2ToolPart => part.kind === "tool")
                .map((part) => part.status),
              shellStatuses: Array.from(shellProjections.values())
                .filter((projection) => projection.turn === turn)
                .map((projection) => projection.status),
              hasProviderRetry: retryRemainsScheduled,
              compactionStatus: turn.activeCompaction?.status ?? null,
              subagentStatuses: Array.from(subagentsByNativeItemId.values())
                .filter((subagent) => subagent.parentTurn === turn)
                .map((subagent) => subagent.status),
            });
          });

        const offerPostSettleWake = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          event: any,
          suppressContinuation: boolean,
        ) {
          const inputId = openCode2WireInputID(event);
          if (inputId === undefined) return;
          const wake: OpenCode2PostSettleWake = {
            inputId,
            events: [event],
            disposition: suppressContinuation ? "suppress" : "replay",
            promotedAfterExecutionStarted: false,
            phase: "pending",
          };
          state.postSettleWakes.push(wake);
          if (
            suppressContinuation ||
            continuationRequests === undefined ||
            state.appThread === null
          ) {
            return;
          }
          // Admission accepts data.input, legacy data.prompt, or 17498 data.item.
          const admittedInput = openCode2WireAdmittedInput(event);
          const admittedData =
            admittedInput !== undefined &&
            admittedInput !== null &&
            typeof admittedInput === "object"
              ? (recordValue(admittedInput, "data") ??
                recordValue(admittedInput, "payload") ??
                admittedInput)
              : undefined;
          const syntheticDescription =
            admittedInput !== undefined &&
            admittedInput !== null &&
            typeof admittedInput === "object" &&
            (admittedInput as { type?: unknown }).type === "synthetic"
              ? (recordString(admittedData, "description") ?? null)
              : null;
          yield* continuationRequests.offer({
            threadId: state.appThread.id,
            providerThreadId: state.providerThread.id,
            driver: OPENCODE2_PROVIDER,
            detail: syntheticDescription,
          });
        });

        const retireUnownedSuppressWakes = (
          state: OpenCode2ThreadState,
          ownerInputIds: ReadonlySet<string>,
        ): void => {
          for (let index = state.postSettleWakes.length - 1; index >= 0; index -= 1) {
            const wake = state.postSettleWakes[index];
            if (
              wake?.disposition === "suppress" &&
              (wake.phase === "pending" || wake.phase === "executing") &&
              !ownerInputIds.has(wake.inputId)
            ) {
              state.postSettleWakes.splice(index, 1);
              state.retiredSuppressWakes.delete(wake.inputId);
              state.retiredSuppressWakes.set(wake.inputId, wake);
            }
          }
          pruneOpenCode2RetiredSuppressWakes(state.retiredSuppressWakes);
        };

        const beginOpenCode2Execution = (state: OpenCode2ThreadState): void => {
          const activeInputId = state.activeTurn?.nativeInputId;
          const wakeInputIds = state.postSettleWakes
            .filter((wake) => wake.phase === "pending" || wake.phase === "executing")
            .map((wake) => wake.inputId);
          const candidateInputIds = new Set(
            activeInputId === null || activeInputId === undefined
              ? wakeInputIds
              : [activeInputId, ...wakeInputIds],
          );
          const promotedOwners = state.sawInputPromotion
            ? Array.from(state.promotedInputIds).filter((inputId) => candidateInputIds.has(inputId))
            : [];
          const promotedReplayOwners = promotedOwners.filter((inputId) =>
            state.postSettleWakes.some(
              (wake) => wake.inputId === inputId && wake.disposition === "replay",
            ),
          );
          const activeInputIsPromoted =
            activeInputId !== null &&
            activeInputId !== undefined &&
            promotedOwners.includes(activeInputId);

          // OpenCode's promoted event is the authoritative input-to-execution
          // boundary. Older clients omitted it, so the bounded fallback gives
          // a known ordinary input priority. If there is no ordinary input and
          // promotion has not identified an owner, every pending wake owns the
          // execution for buffering purposes: swallowing unattributable output
          // is safer than allowing it into the active visible turn.
          const fallbackInputIds =
            activeInputId !== null && activeInputId !== undefined ? [activeInputId] : wakeInputIds;
          // Cancelled synthetic wakes can promote after a recovery input has
          // arrived. They suppress late output but must not own the recovery
          // execution. A promoted replay wake still takes ownership because
          // its buffered output belongs to a continuation turn.
          const ownershipInputIds =
            promotedReplayOwners.length > 0
              ? promotedReplayOwners
              : activeInputIsPromoted
                ? [activeInputId]
                : promotedOwners.length > 0
                  ? promotedOwners
                  : fallbackInputIds;
          const ownership = {
            inputIds: new Set(ownershipInputIds),
            claimedByPromotion:
              promotedReplayOwners.length > 0 ||
              (!activeInputIsPromoted && promotedOwners.length > 0),
          };
          state.activeExecution = ownership;
          for (const inputId of ownership.inputIds) {
            state.promotedInputIds.delete(inputId);
          }
          for (const wake of state.postSettleWakes) {
            if (ownership.inputIds.has(wake.inputId) && wake.phase === "pending") {
              wake.phase = "executing";
            }
          }
          if (
            (activeInputId !== null && activeInputId !== undefined) ||
            promotedOwners.length > 0
          ) {
            retireUnownedSuppressWakes(state, ownership.inputIds);
          }
        };

        const settlePostSettleWakes = (
          state: OpenCode2ThreadState,
          event: any,
          ownerInputIds: ReadonlySet<string>,
        ): void => {
          if (!openCode2EventEndsExecution(event)) return;
          for (const wake of state.postSettleWakes) {
            if (
              ownerInputIds.has(wake.inputId) &&
              (wake.phase === "pending" || wake.phase === "executing")
            ) {
              wake.phase = "ready";
            }
          }
          const ordinaryTurnOwnsExecution =
            state.activeTurn?.nativeInputId !== null &&
            state.activeTurn?.nativeInputId !== undefined &&
            ownerInputIds.has(state.activeTurn.nativeInputId);
          let replayOwnerKept = false;
          for (let index = state.postSettleWakes.length - 1; index >= 0; index -= 1) {
            const wake = state.postSettleWakes[index];
            if (
              wake !== undefined &&
              ownerInputIds.has(wake.inputId) &&
              wake.phase === "ready" &&
              (wake.disposition === "suppress" ||
                ordinaryTurnOwnsExecution ||
                (wake.disposition === "replay" && replayOwnerKept))
            ) {
              state.postSettleWakes.splice(index, 1);
              state.promotedInputIds.delete(wake.inputId);
            } else if (
              wake !== undefined &&
              ownerInputIds.has(wake.inputId) &&
              wake.disposition === "replay" &&
              wake.phase === "ready"
            ) {
              replayOwnerKept = true;
            }
          }
        };

        const correlatedEventSessionId = (event: any): string | undefined => {
          const directSessionId = recordString(event.data, "sessionID");
          if (directSessionId !== undefined) return directSessionId;

          const formSessionId = recordString(recordValue(event.data, "form"), "sessionID");
          if (formSessionId !== undefined) return formSessionId;

          const info = recordValue(event.data, "info");
          const shellSessionId = recordString(recordValue(info, "metadata"), "sessionID");
          if (shellSessionId !== undefined) return shellSessionId;

          const nativeId = openCode2RuntimeRequestEventId(event.data);
          if (nativeId === undefined) return undefined;
          const knownShellSessionId = shellSessionIds.get(nativeId);
          if (knownShellSessionId !== undefined) return knownShellSessionId;
          const matchingSessionIds = new Set(
            [
              ...Array.from(pendingRequestsByNativeId.values()),
              ...Array.from(settledRequestsByNativeId.values()).map((settled) => settled.pending),
            ]
              .filter((request) => request.nativeRequestId === nativeId)
              .map((request) => request.nativeSessionId),
          );
          return matchingSessionIds.size === 1
            ? matchingSessionIds.values().next().value
            : undefined;
        };

        const bufferPostSettleWakeEvent = (event: any, isReplay: boolean): boolean => {
          const sessionID = correlatedEventSessionId(event);
          if (sessionID === undefined) return false;
          const state = threads.get(sessionID);
          if (state === undefined) return false;
          // The replay loop feeds old provider events back through this same
          // handler. They belong to the turn being replayed and must not
          // settle a live execution that happens to be active beside it.
          if (isReplay) return false;
          const bufferedType = normalizeOpenCode2WireType(String(event?.type ?? ""));
          if (bufferedType === "session.input.admitted") {
            return false;
          }
          if (state.activeExecution === null && openCode2EventEndsExecution(event)) {
            beginOpenCode2Execution(state);
          }
          const execution = state.activeExecution;
          if (execution === null) return false;
          const owningWakes = state.postSettleWakes.filter(
            (candidate) =>
              execution.inputIds.has(candidate.inputId) &&
              (candidate.phase === "pending" || candidate.phase === "executing"),
          );
          if (owningWakes.length === 0) return false;
          for (const wake of owningWakes) wake.events.push(event);
          const ordinaryTurnOwnsExecution =
            state.activeTurn?.nativeInputId !== null &&
            state.activeTurn?.nativeInputId !== undefined &&
            execution.inputIds.has(state.activeTurn.nativeInputId);
          const suppressesLateOutput = owningWakes.some(
            (wake) => wake.disposition === "suppress" && wake.promotedAfterExecutionStarted,
          );
          if (openCode2EventEndsExecution(event)) {
            settlePostSettleWakes(state, event, execution.inputIds);
            if (!ordinaryTurnOwnsExecution) state.activeExecution = null;
          }
          // A suppressed wake promoted after an ordinary root has claimed the
          // session-level execution is indistinguishable from that root's
          // output. Prefer the cancellation boundary for non-terminal output;
          // the terminal still reaches the root lifecycle so it can settle.
          return suppressesLateOutput
            ? !openCode2EventEndsExecution(event)
            : !ordinaryTurnOwnsExecution;
        };

        const activeTurnOwnsOpenCode2Execution = (
          state: OpenCode2ThreadState,
          turn: ActiveOpenCode2Turn,
          replayWakeInputId?: string,
        ): boolean => {
          if (replayWakeInputId !== undefined) {
            return replayWakeInputId === turn.nativeInputId;
          }
          if (
            turn.isRoot &&
            state.postSettleWakes.length === 0 &&
            state.retiredSuppressWakes.size === 0 &&
            (state.activeExecution === null || state.activeExecution.inputIds.size === 0)
          ) {
            return true;
          }
          if (
            !turn.isRoot &&
            state.postSettleWakes.length === 0 &&
            (state.activeExecution === null || state.activeExecution.inputIds.size === 0)
          ) {
            return true;
          }
          const inputId = turn.nativeInputId;
          return inputId !== null && state.activeExecution?.inputIds.has(inputId) === true;
        };

        const handleEvent = Effect.fnUntraced(function* (
          // Beta V2Event plus structural wire events; type names are normalized
          // before the switch.
          event: any,
          context: OpenCode2EventHandlingContext = {},
        ) {
          const wire = event as WireEvent;
          const eventType = normalizeOpenCode2WireType(String(wire.type ?? event?.type ?? ""));
          const isReplay = context.replayWakeInputId !== undefined;
          const isDeferredChildReplay = context.deferredChildReplay === true;
          const eventSessionId =
            openCode2WireSessionID(wire) ??
            recordString(event.data, "sessionID") ??
            recordString(recordValue(event.data, "form"), "sessionID") ??
            correlatedEventSessionId(event);
          if (!isDeferredChildReplay) {
            yield* logProtocolEvent({
              direction: "incoming",
              messageKind: "notification",
              method: wire.type,
              payload: event,
            });
          }
          if (
            !isReplay &&
            !isDeferredChildReplay &&
            eventType !== "session.created" &&
            eventSessionId !== undefined &&
            !threads.has(eventSessionId) &&
            nativeChildSessions.has(eventSessionId)
          ) {
            const buffered =
              deferredChildEvents.get(eventSessionId) ?? makeOpenCode2DeferredChildEventBuffer();
            deferredChildEvents.set(eventSessionId, buffered);
            if (bufferOpenCode2DeferredChildEvent(buffered, event, eventSessionId)) {
              yield* Effect.logWarning(
                "OpenCode 2 deferred child event buffer reached its limit; preserving earliest lifecycle events and a terminal fallback.",
                { sessionID: eventSessionId, limit: OPENCODE2_DEFERRED_CHILD_EVENT_LIMIT },
              );
            }
            return;
          }
          if (eventSessionId !== undefined) {
            const held = activeFor(eventSessionId);
            if (
              held !== null &&
              activeTurnOwnsOpenCode2Execution(held.state, held.turn, context.replayWakeInputId)
            ) {
              if (eventType === "session.execution.started") {
                held.turn.providerRetry = null;
              }
              if (held.turn.pendingExecutionFailure !== null) {
                if (openCode2EventClearsHeldExecutionFailure(eventType)) {
                  held.turn.pendingExecutionFailure = null;
                } else if (openCode2EventSettlesHeldExecutionFailure(eventType)) {
                  const pendingFailure = held.turn.pendingExecutionFailure;
                  held.turn.pendingExecutionFailure = null;
                  if (held.turn.isRoot) {
                    yield* updateProviderSession("error", pendingFailure.message);
                  }
                  yield* finalizeTurn(held.state, held.turn, "failed", {
                    failure: pendingFailure,
                  });
                  held.state.quarantined = false;
                  if (!isReplay) held.state.activeExecution = null;
                }
              }
            }
          }
          const isCancelledPostSettleWake = openCode2IsCancelledPostSettleWake(event);
          const admittedState =
            eventType === "session.input.admitted"
              ? threads.get(openCode2WireSessionID(wire) ?? event.data?.sessionID)
              : undefined;
          if (
            admittedState !== undefined &&
            !isReplay &&
            openCode2IsPostSettleWakeAdmission(event, {
              isChildSession: admittedState.parentSubagent !== null,
            })
          ) {
            yield* offerPostSettleWake(admittedState, event, isCancelledPostSettleWake);
            return;
          }
          const eventState =
            admittedState ??
            (eventSessionId === undefined ? undefined : threads.get(eventSessionId));
          if (!isReplay && eventType === "session.input.admitted" && eventState !== undefined) {
            const inputId = openCode2WireInputID(wire);
            const input = openCode2WireAdmittedInput(wire);
            // Session3 uses the same admitted event for the initial admission
            // and for the later promotion into an execution. A promotion has
            // an input id but no input payload. beta-17498 enqueue carries
            // `item`; delivered is id-only and is the promotion. Remember wake
            // ownership before
            // execution.started chooses a session-wide execution owner.
            if (inputId !== undefined && input === undefined) {
              eventState.sawInputPromotion = true;
              eventState.promotedInputIds.add(inputId);
              pruneOpenCode2PromotedInputIds(eventState.promotedInputIds);
              const wake = eventState.postSettleWakes.find(
                (candidate) => candidate.inputId === inputId,
              );
              if (wake !== undefined) {
                wake.promotedAfterExecutionStarted =
                  eventState.activeExecution !== null ||
                  eventState.activeTurn?.executionStarted === true;
                return;
              }
            }
          }
          if (eventState !== undefined && !isReplay && eventType === "session.execution.started") {
            beginOpenCode2Execution(eventState);
          }
          if (bufferPostSettleWakeEvent(event, isReplay)) return;
          if (
            isCancelledPostSettleWake &&
            !isReplay &&
            (admittedState === undefined || admittedState.parentSubagent === null)
          ) {
            return;
          }
          switch (eventType) {
            case "session.created": {
              const nativeSession = openCode2WireSession(wire);
              if (nativeSession === undefined) return;
              nativeChildSessions.set(nativeSession.id, nativeSession);
              if (nativeSession.parentID === undefined) return;
              const parentState = threads.get(nativeSession.parentID);
              if (parentState === undefined) return;
              const candidates = Array.from(subagentsByNativeItemId.values()).filter(
                (context) =>
                  context.parentState === parentState &&
                  context.childSessionId === null &&
                  (context.status === "pending" ||
                    context.status === "running" ||
                    context.status === "waiting") &&
                  !subagentsByChildSessionId.has(nativeSession.id),
              );
              const titleMatches = candidates.filter(
                (candidate) => candidate.title !== null && candidate.title === nativeSession.title,
              );
              const context = titleMatches.length === 1 ? titleMatches[0] : undefined;
              if (context === undefined) return;
              yield* bindSubagentChild(context, nativeSession);
              yield* emitSubagentContext(context);
              return;
            }
            case "session.agent.selected": {
              const state = threads.get(event.data.sessionID);
              if (state === undefined) return;
              // Event ids are monotonic, so a replayed or out-of-order
              // delivery must not resurrect an older agent selection.
              if (
                state.lastAgentSelectedEventId !== null &&
                event.id <= state.lastAgentSelectedEventId
              ) {
                return;
              }
              state.lastAgentSelectedEventId = event.id;
              state.boundAgent = event.data.agent;
              const reflectedInteractionMode = openCode2InteractionModeForAgent(event.data.agent);
              // A genuinely external switch (a future plan_exit flow, or
              // another client on the same session) reflects into the
              // thread's Build/Plan mode so the next turn does not push the
              // stale mode back. Only the two native agents map onto the
              // toggle, and subagent child sessions keep their own agents.
              if (
                interactionModeReflections === undefined ||
                state.parentSubagent !== null ||
                state.appThread === null ||
                reflectedInteractionMode === null
              ) {
                return;
              }
              // Matching echoes still supersede older queued reflections. The
              // worker drains them in native event order and command ids make
              // retries safe.
              yield* interactionModeReflections.offer({
                threadId: state.appThread.id,
                driver: OPENCODE2_PROVIDER,
                interactionMode: reflectedInteractionMode,
                dedupeKey: `${OPENCODE2_PROVIDER}:${event.id}`,
              });
              return;
            }
            case "session.shell.started": {
              const state = threads.get(event.data.sessionID);
              if (state === undefined) return;
              yield* rememberRunningShell(event.data.sessionID, event.data.shell.id);
              yield* registerShellProjection(state, event.data.shell);
              return;
            }
            case "session.shell.ended": {
              yield* completeShellProjection(event.data.shell.id, {
                status: event.data.shell.status,
                ...(event.data.shell.exit === undefined ? {} : { exit: event.data.shell.exit }),
                output: event.data.output,
              });
              shellProjections.delete(event.data.shell.id);
              yield* forgetRunningShell(event.data.shell.id);
              shellSessionIds.delete(event.data.shell.id);
              return;
            }
            case "shell.created": {
              const info = recordValue(event.data, "info") ?? event.data;
              const sessionID =
                recordString(recordValue(info, "metadata"), "sessionID") ??
                recordString(event.data, "sessionID");
              const shellId = recordString(info, "id");
              if (sessionID === undefined || shellId === undefined) return;
              yield* rememberRunningShell(sessionID, shellId);
              const state = threads.get(sessionID);
              if (state !== undefined && info !== null && typeof info === "object") {
                yield* registerShellProjection(state, info as ShellInfoV2);
              }
              return;
            }
            case "shell.exited": {
              const shellId =
                (typeof event.data === "string" ? event.data : undefined) ??
                recordString(event.data, "id") ??
                recordString(recordValue(event.data, "info"), "id") ??
                recordString(recordValue(event.data, "shell"), "id");
              if (shellId === undefined) return;
              yield* completeShellProjection(shellId, {
                status: recordString(event.data, "status") ?? "exited",
                ...(typeof event.data.exit === "number" ? { exit: event.data.exit } : {}),
              });
              shellProjections.delete(shellId);
              yield* forgetRunningShell(shellId);
              shellSessionIds.delete(shellId);
              return;
            }
            case "shell.deleted": {
              const shellId =
                (typeof event.data === "string" ? event.data : undefined) ??
                recordString(event.data, "id") ??
                recordString(recordValue(event.data, "info"), "id") ??
                recordString(recordValue(event.data, "shell"), "id");
              if (shellId === undefined) return;
              const projection = shellProjections.get(shellId);
              if (projection !== undefined && projection.turn.finalized) {
                yield* completeShellProjection(shellId, { status: "killed" });
              }
              shellProjections.delete(shellId);
              yield* forgetRunningShell(shellId);
              shellSessionIds.delete(shellId);
              return;
            }
            case "session.input.admitted": {
              const sessionID =
                openCode2WireSessionID(wire) ?? recordString(event.data, "sessionID");
              if (sessionID === undefined) return;
              const state = threads.get(sessionID);
              const inputId = openCode2WireInputID(wire);
              if (
                state !== undefined &&
                state.activeTurn === null &&
                state.parentSubagent !== null &&
                inputId !== undefined
              ) {
                yield* createChildTurn(state, inputId);
              }
              const active = activeFor(sessionID);
              if (active === null) return;
              if (active.turn.nativeInputId === null && inputId !== undefined) {
                active.turn.nativeInputId = inputId;
                yield* emitProviderTurn(active.state, active.turn, "running", null);
              }
              const rootInputId = active.turn.nativeInputId;
              const activeExecution = active.state.activeExecution;
              const activeExecutionOwnsPendingWake =
                activeExecution !== null &&
                Array.from(active.state.postSettleWakes).some(
                  (wake) =>
                    activeExecution.inputIds.has(wake.inputId) &&
                    (wake.phase === "pending" || wake.phase === "executing"),
                );
              if (
                !isReplay &&
                rootInputId !== null &&
                activeExecution !== null &&
                !activeExecution.claimedByPromotion &&
                !activeExecution.inputIds.has(rootInputId) &&
                !activeExecutionOwnsPendingWake &&
                (active.turn.isRoot || active.state.postSettleWakes.length === 0)
              ) {
                const previousOwnerInputIds = new Set(activeExecution.inputIds);
                // `session.execution.started` has only a session id. A
                // promoted owner wins this boundary. Otherwise the ordinary
                // admission claims the execution here, including when the
                // fallback temporarily held pending wake ids (inputIds may be
                // non-empty). A later retired promotion joins the same
                // boundary and remains suppressed. OpenCode cannot tell these
                // orderings apart without an execution id, so this is the
                // smallest deterministic policy.
                activeExecution.inputIds.clear();
                activeExecution.inputIds.add(rootInputId);
                active.turn.executionStarted = true;
                // Fallback ownership is only a safety hold until a known
                // ordinary input arrives. Move cancelled wakes out of the
                // execution so their later promotion still joins the same
                // boundary and remains suppressed. An unpromoted replay wake
                // cannot be distinguished from this execution either, so its
                // buffered events are discarded rather than re-parented into
                // the ordinary root turn.
                retireUnownedSuppressWakes(active.state, activeExecution.inputIds);
                for (let index = active.state.postSettleWakes.length - 1; index >= 0; index -= 1) {
                  const wake = active.state.postSettleWakes[index];
                  if (
                    wake !== undefined &&
                    wake.disposition === "replay" &&
                    previousOwnerInputIds.has(wake.inputId)
                  ) {
                    active.state.postSettleWakes.splice(index, 1);
                    active.state.promotedInputIds.delete(wake.inputId);
                  }
                }
              }
              return;
            }
            case "session.text.started":
            case "session.text.delta":
            case "session.text.ended": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              yield* upsertTextPart(active.state, active.turn, "text", event.data, {
                ...("delta" in event.data ? { delta: event.data.delta } : {}),
                ...("text" in event.data ? { text: event.data.text } : {}),
                ...(eventType === "session.text.ended" ? { completed: true } : {}),
              });
              return;
            }
            case "session.reasoning.started":
            case "session.reasoning.delta":
            case "session.reasoning.ended": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              yield* upsertTextPart(active.state, active.turn, "reasoning", event.data, {
                ...("delta" in event.data ? { delta: event.data.delta } : {}),
                ...("text" in event.data ? { text: event.data.text } : {}),
                ...(eventType === "session.reasoning.ended" ? { completed: true } : {}),
              });
              return;
            }
            case "session.compaction.started": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const now = yield* DateTime.now;
              const triggerReason = openCode2CompactionReason(event.data);
              const diagnostics = compactionDiagnosticsFor(
                active.state,
                active.turn,
                triggerReason,
              );
              const nativeItemId = String(openCode2WireInputID(wire) ?? event.id ?? "");
              if (nativeItemId.length === 0) return;
              const current = active.turn.activeCompaction;
              if (current !== null && current.id !== nativeItemId && current.status === "running") {
                current.status = "cancelled";
                current.completedAt = now;
                yield* emitCompaction(active.state, active.turn, current);
              }
              const compaction: OpenCode2Compaction =
                current !== null && current.id === nativeItemId
                  ? current
                  : {
                      id: nativeItemId,
                      startedAt: dateTimeFromEpoch(openCode2WireCreatedMs(wire), now),
                      summary: "",
                      status: "running",
                      completedAt: null,
                      triggerReason,
                      diagnostics,
                    };
              compaction.status = "running";
              compaction.completedAt = null;
              if (triggerReason !== "unknown") compaction.triggerReason = triggerReason;
              compaction.diagnostics = diagnostics ?? compaction.diagnostics;
              active.turn.activeCompaction = compaction;
              yield* emitCompaction(active.state, active.turn, compaction);
              if (compaction.diagnostics === null && compaction.triggerReason !== "unknown") {
                yield* refreshCompactionDiagnostics(active.state, active.turn, compaction).pipe(
                  Effect.forkIn(scope),
                );
              }
              return;
            }
            case "session.compaction.delta": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const now = yield* DateTime.now;
              const compaction =
                active.turn.activeCompaction ??
                ({
                  id: event.id,
                  startedAt: dateTimeFromEpoch(openCode2WireCreatedMs(wire), now),
                  summary: "",
                  status: "running",
                  completedAt: null,
                  triggerReason: "unknown",
                  diagnostics: null,
                } satisfies OpenCode2Compaction);
              const summaryDelta = openCode2WireTextDelta(wire);
              if (summaryDelta !== undefined) compaction.summary += summaryDelta;
              active.turn.activeCompaction = compaction;
              yield* emitCompaction(active.state, active.turn, compaction);
              return;
            }
            case "session.compaction.ended": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const now = yield* DateTime.now;
              const triggerReason = openCode2CompactionReason(event.data);
              const diagnostics = compactionDiagnosticsFor(
                active.state,
                active.turn,
                triggerReason,
              );
              const compaction =
                active.turn.activeCompaction ??
                ({
                  id: event.id,
                  startedAt: dateTimeFromEpoch(openCode2WireCreatedMs(wire), now),
                  summary: "",
                  status: "running",
                  completedAt: null,
                  triggerReason,
                  diagnostics,
                } satisfies OpenCode2Compaction);
              const finalSummary = openCode2WireTextDelta(wire);
              if (finalSummary !== undefined) compaction.summary = finalSummary;
              if (triggerReason !== "unknown") compaction.triggerReason = triggerReason;
              compaction.diagnostics = diagnostics ?? compaction.diagnostics;
              compaction.status = "completed";
              compaction.completedAt = dateTimeFromEpoch(openCode2WireCreatedMs(wire), now);
              active.turn.activeCompaction = compaction;
              yield* emitCompaction(active.state, active.turn, compaction);
              if (compaction.diagnostics === null && compaction.triggerReason !== "unknown") {
                yield* refreshCompactionDiagnostics(active.state, active.turn, compaction).pipe(
                  Effect.forkIn(scope),
                );
              }
              return;
            }
            case "session.compaction.failed": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const now = yield* DateTime.now;
              const triggerReason = openCode2CompactionReason(event.data);
              const diagnostics = compactionDiagnosticsFor(
                active.state,
                active.turn,
                triggerReason,
              );
              const compaction =
                active.turn.activeCompaction ??
                ({
                  id: String(openCode2WireInputID(wire) ?? event.id),
                  startedAt: dateTimeFromEpoch(openCode2WireCreatedMs(wire), now),
                  summary: "",
                  status: "running",
                  completedAt: null,
                  triggerReason,
                  diagnostics,
                } satisfies OpenCode2Compaction);
              if (triggerReason !== "unknown") compaction.triggerReason = triggerReason;
              compaction.diagnostics = diagnostics ?? compaction.diagnostics;
              compaction.status = "failed";
              compaction.completedAt = dateTimeFromEpoch(openCode2WireCreatedMs(wire), now);
              active.turn.activeCompaction = compaction;
              yield* emitCompaction(active.state, active.turn, compaction);
              if (compaction.diagnostics === null && compaction.triggerReason !== "unknown") {
                yield* refreshCompactionDiagnostics(active.state, active.turn, compaction).pipe(
                  Effect.forkIn(scope),
                );
              }
              return;
            }
            case "session.tool.input.started": {
              const active = activeFor(openCode2WireSessionID(wire) ?? event.data?.sessionID);
              if (active === null) return;
              const callID = openCode2WireCallID(wire);
              if (callID === undefined) return;
              yield* upsertToolPart(active.state, active.turn, callID, {
                name: openCode2WireToolName(wire) ?? event.data?.name ?? event.data?.tool ?? "tool",
                status: "pending",
              });
              return;
            }
            case "session.tool.input.delta": {
              const active = activeFor(openCode2WireSessionID(wire) ?? event.data?.sessionID);
              if (active === null) return;
              const callID = openCode2WireCallID(wire);
              if (callID === undefined) return;
              yield* upsertToolPart(active.state, active.turn, callID, {
                inputDelta: event.data?.delta,
              });
              return;
            }
            case "session.tool.called": {
              const active = activeFor(openCode2WireSessionID(wire) ?? event.data?.sessionID);
              if (active === null) return;
              const callID = openCode2WireCallID(wire);
              if (callID === undefined) return;
              yield* upsertToolPart(active.state, active.turn, callID, {
                input: event.data?.input,
                status: "running",
              });
              return;
            }
            case "session.tool.progress": {
              const active = activeFor(openCode2WireSessionID(wire) ?? event.data?.sessionID);
              if (active === null) return;
              const callID = openCode2WireCallID(wire);
              if (callID === undefined) return;
              const output = toolContentText(event.data?.content);
              const structured = openCode2WireToolMetadata(wire);
              yield* upsertToolPart(active.state, active.turn, callID, {
                ...(output === undefined ? {} : { output }),
                ...(structured === undefined ? {} : { structured }),
                status: "running",
              });
              return;
            }
            case "session.tool.success": {
              const active = activeFor(openCode2WireSessionID(wire) ?? event.data?.sessionID);
              if (active === null) return;
              const callID = openCode2WireCallID(wire);
              if (callID === undefined) return;
              const output = toolContentText(event.data?.content);
              const structured = openCode2WireToolMetadata(wire);
              yield* upsertToolPart(active.state, active.turn, callID, {
                ...(output === undefined ? {} : { output }),
                ...(structured === undefined ? {} : { structured }),
                status: "completed",
              });
              return;
            }
            case "session.tool.failed": {
              const active = activeFor(openCode2WireSessionID(wire) ?? event.data?.sessionID);
              if (active === null) return;
              const callID = openCode2WireCallID(wire);
              if (callID === undefined) return;
              const errorMessage =
                (typeof event.data?.error?.message === "string"
                  ? event.data.error.message
                  : undefined) ?? openCode2WireErrorMessage(wire);
              yield* upsertToolPart(active.state, active.turn, callID, {
                output: errorMessage,
                errorMessage,
                status: "error",
              });
              return;
            }
            case "session.retry.scheduled": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const now = yield* DateTime.now;
              const nowMs = DateTime.toEpochMillis(now);
              const retryAtMs =
                typeof event.data.at === "number"
                  ? event.data.at
                  : (openCode2WireCreatedMs(wire) ?? nowMs);
              const retry: OrchestrationV2ProviderRetry = {
                attempt: Math.max(1, Math.floor(event.data.attempt)),
                maxAttempts: null,
                retryDelayMs: Math.max(0, Math.floor(retryAtMs - nowMs)),
              };
              const failure = openCode2ProviderFailure({
                message: event.data.error.message,
                code: event.data.error.type,
                statusCode: openCode2ProviderErrorStatus(event.data.error),
                hasProviderRetry: true,
              });
              active.turn.pendingExecutionFailure = null;
              active.turn.providerRetry = {
                retry,
                failure,
                startedAt:
                  active.turn.providerRetry?.startedAt ??
                  dateTimeFromEpoch(openCode2WireCreatedMs(wire), now),
                scheduledUntilAtMs: retryAtMs,
              };
              const context = active.state.parentSubagent;
              if (context !== null) {
                context.status = "running";
                context.progress =
                  event.data.error.type === "provider.rate-limit" ||
                  event.data.error.message.includes("429")
                    ? `Rate limited, retrying (attempt ${retry.attempt})`
                    : `Provider retry attempt ${retry.attempt}`;
                yield* emitSubagentContext(context);
              }
              return;
            }
            case "permission.v2.asked": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const permission = normalizeOpenCode2PermissionEvent("v2", event.data);
              const autoReply = openCode2PermissionAutoReplyForSession(
                active.turn.runtimePolicy,
                sessionPermissions,
                event.data.sessionID,
                permission,
              );
              const projection = runtimeRequestProjectionFor(active);
              const runtimeRequest = {
                type: "permission" as const,
                ...permission,
              };
              if (autoReply !== null) {
                yield* autoReplyPermission(
                  event.data.sessionID,
                  event.data.id,
                  autoReply,
                  emitRuntimeRequest(
                    projection.state,
                    projection.turn,
                    active.turn,
                    event.data.sessionID,
                    event.data.id,
                    runtimeRequest,
                    true,
                  ),
                );
                return;
              }
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
                active.turn,
                event.data.sessionID,
                event.data.id,
                runtimeRequest,
              );
              return;
            }
            case "permission.v2.replied":
              yield* resolvePermissionReply(
                event.data.sessionID,
                event.data.requestID,
                event.data.reply,
              );
              return;
            case "question.v2.asked": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const projection = runtimeRequestProjectionFor(active);
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
                active.turn,
                event.data.sessionID,
                event.data.id,
                {
                  type: "question",
                  questions: event.data.questions,
                },
              );
              return;
            }
            case "question.v2.replied":
              confirmRuntimeRequestResponse(event.data.sessionID, event.data.requestID);
              yield* resolveRuntimeRequest(event.data.sessionID, event.data.requestID, "resolved");
              return;
            case "question.v2.rejected":
              yield* resolveRuntimeRequest(event.data.sessionID, event.data.requestID, "cancelled");
              return;
            // Current 2.x builds route the question tool through the form API;
            // question.v2.asked no longer fires for it.
            case "form.created": {
              const form = (event.data?.form ?? event.data) as FormInfo | undefined;
              if (form === undefined || typeof form.id !== "string") return;
              const sessionID =
                form.sessionID ??
                recordString(event.data, "sessionID") ??
                recordString(recordValue(event.data, "form"), "sessionID");
              if (sessionID === undefined) return;
              const active = activeFor(sessionID);
              if (active === null) return;
              const { questions, fieldKeys, optionValuesByLabel } = openCode2FormQuestions(form);
              if (questions.length === 0) return;
              const projection = runtimeRequestProjectionFor(active);
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
                active.turn,
                sessionID,
                form.id,
                {
                  type: "question",
                  questions,
                  formFieldKeys: fieldKeys,
                  formOptionValues: optionValuesByLabel,
                },
              );
              return;
            }
            case "form.replied": {
              const formId = openCode2RuntimeRequestEventId(event.data);
              if (formId !== undefined && eventSessionId !== undefined) {
                confirmRuntimeRequestResponse(eventSessionId, formId);
                yield* resolveRuntimeRequest(eventSessionId, formId, "resolved");
              }
              return;
            }
            case "form.cancelled": {
              const formId = openCode2RuntimeRequestEventId(event.data);
              if (formId !== undefined && eventSessionId !== undefined) {
                yield* resolveRuntimeRequest(eventSessionId, formId, "cancelled");
              }
              return;
            }
            case "permission.asked": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const permission = normalizeOpenCode2PermissionEvent("legacy", event.data);
              const autoReply = openCode2PermissionAutoReplyForSession(
                active.turn.runtimePolicy,
                sessionPermissions,
                event.data.sessionID,
                permission,
              );
              const projection = runtimeRequestProjectionFor(active);
              const runtimeRequest = {
                type: "permission" as const,
                ...permission,
              };
              if (autoReply !== null) {
                yield* autoReplyPermission(
                  event.data.sessionID,
                  event.data.id,
                  autoReply,
                  emitRuntimeRequest(
                    projection.state,
                    projection.turn,
                    active.turn,
                    event.data.sessionID,
                    event.data.id,
                    runtimeRequest,
                    true,
                  ),
                );
                return;
              }
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
                active.turn,
                event.data.sessionID,
                event.data.id,
                runtimeRequest,
              );
              return;
            }
            case "permission.replied":
              yield* resolvePermissionReply(
                event.data.sessionID,
                event.data.requestID,
                event.data.reply,
              );
              return;
            case "question.asked": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const projection = runtimeRequestProjectionFor(active);
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
                active.turn,
                event.data.sessionID,
                event.data.id,
                {
                  type: "question",
                  questions: event.data.questions,
                },
              );
              return;
            }
            case "question.replied":
              confirmRuntimeRequestResponse(event.data.sessionID, event.data.requestID);
              yield* resolveRuntimeRequest(event.data.sessionID, event.data.requestID, "resolved");
              return;
            case "question.rejected":
              yield* resolveRuntimeRequest(event.data.sessionID, event.data.requestID, "cancelled");
              return;
            case "session.execution.started": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              // Execution terminals carry only a session id. This start event
              // is the correlation barrier that keeps a late prior terminal
              // from settling a turn whose input did not own this execution.
              if (
                !activeTurnOwnsOpenCode2Execution(
                  active.state,
                  active.turn,
                  context.replayWakeInputId,
                )
              ) {
                return;
              }
              active.turn.executionStarted = true;
              return;
            }
            case "session.execution.succeeded": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              if (
                !activeTurnOwnsOpenCode2Execution(
                  active.state,
                  active.turn,
                  context.replayWakeInputId,
                )
              ) {
                return;
              }
              active.state.latestTokenUsage =
                openCode2TokenUsage(openCode2WireData(wire)) ?? active.state.latestTokenUsage;
              const compaction = active.turn.activeCompaction;
              if (compaction !== null && compaction.diagnostics === null) {
                const diagnostics = compactionDiagnosticsFor(
                  active.state,
                  active.turn,
                  compaction.triggerReason,
                );
                if (diagnostics !== null) {
                  compaction.diagnostics = diagnostics;
                  yield* emitCompaction(active.state, active.turn, compaction);
                }
              }
              if (
                !active.turn.executionStarted &&
                openCode2CanAdoptMissingExecutionStart({
                  executionStarted: active.turn.executionStarted,
                  interrupted: active.turn.interrupted,
                  partCount: active.turn.parts.size,
                })
              ) {
                active.turn.executionStarted = true;
              }
              if (
                !openCode2ShouldSettleTurn(
                  "execution-terminal",
                  active.turn.executionStarted,
                  active.turn.interrupted,
                )
              ) {
                return;
              }
              // step.ended can mean "tool-calls continue"; only settle
              // full-turn terminals.
              if (!openCode2StepFinishSettlesTurn(openCode2WireData(wire).finish)) {
                return;
              }
              yield* finalizeTurn(
                active.state,
                active.turn,
                active.turn.interrupted ? "interrupted" : "completed",
              );
              // The terminal proves the execution ended: lift any
              // unconfirmed-interrupt quarantine on this session.
              active.state.quarantined = false;
              if (!isReplay) active.state.activeExecution = null;
              return;
            }
            case "session.execution.failed": {
              const active = terminalFor(event.data.sessionID);
              if (active === null) return;
              if (
                !activeTurnOwnsOpenCode2Execution(
                  active.state,
                  active.turn,
                  context.replayWakeInputId,
                )
              ) {
                return;
              }
              if (
                !active.turn.executionStarted &&
                openCode2CanAdoptMissingExecutionStart({
                  executionStarted: active.turn.executionStarted,
                  interrupted: active.turn.interrupted,
                  partCount: active.turn.parts.size,
                })
              ) {
                active.turn.executionStarted = true;
              }
              if (!openCode2ShouldSettleTurn("execution-terminal", active.turn.executionStarted)) {
                return;
              }
              if (active.turn.interrupted) {
                yield* finalizeTurn(active.state, active.turn, "interrupted");
                active.state.quarantined = false;
                if (!isReplay) active.state.activeExecution = null;
                return;
              }
              const nowMs = yield* Clock.currentTimeMillis;
              const failure = openCode2ProviderFailure({
                message: openCode2WireErrorMessage(wire),
                code: openCode2WireErrorCode(wire),
                statusCode: openCode2ProviderErrorStatus(openCode2WireData(wire)),
                hasProviderRetry: openCode2ProviderRetryIsScheduled(
                  active.turn.providerRetry,
                  nowMs,
                ),
              });
              if (
                openCode2ShouldHoldExecutionFailure({
                  retryable: failure.retryable,
                  hasAnnouncedRetry: active.turn.providerRetry !== null,
                })
              ) {
                active.turn.pendingExecutionFailure = {
                  ...failure,
                  retryable: true,
                };
                return;
              }
              if (active.turn.isRoot) yield* updateProviderSession("error", failure.message);
              yield* finalizeTurn(active.state, active.turn, "failed", {
                failure,
              });
              active.state.quarantined = false;
              if (!isReplay) active.state.activeExecution = null;
              return;
            }
            case "session.execution.interrupted": {
              const active = terminalFor(event.data.sessionID);
              if (active === null) return;
              if (
                !activeTurnOwnsOpenCode2Execution(
                  active.state,
                  active.turn,
                  context.replayWakeInputId,
                )
              ) {
                return;
              }
              active.turn.interrupted = true;
              if (
                !active.turn.executionStarted &&
                openCode2CanAdoptMissingExecutionStart({
                  executionStarted: active.turn.executionStarted,
                  interrupted: active.turn.interrupted,
                  partCount: active.turn.parts.size,
                })
              ) {
                active.turn.executionStarted = true;
              }
              if (
                !openCode2ShouldSettleTurn(
                  "execution-interrupted",
                  active.turn.executionStarted,
                  true,
                )
              ) {
                return;
              }
              active.turn.pendingExecutionFailure = null;
              yield* finalizeTurn(active.state, active.turn, "interrupted");
              // The native event is the authoritative confirmation that the
              // execution ended, so an unconfirmed-interrupt quarantine (if
              // any) is lifted and the session may be reused again.
              active.state.quarantined = false;
              if (!isReplay) active.state.activeExecution = null;
              return;
            }
            // 2.x settles on `session.execution.*`; `session.idle` is only a
            // backstop for builds that never enter the authoritative lifecycle.
            case "session.idle": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              if (
                !activeTurnOwnsOpenCode2Execution(
                  active.state,
                  active.turn,
                  context.replayWakeInputId,
                )
              ) {
                return;
              }
              if (!openCode2ShouldSettleTurn("idle", active.turn.executionStarted)) return;
              yield* finalizeTurn(
                active.state,
                active.turn,
                active.turn.interrupted ? "interrupted" : "completed",
              );
              if (!isReplay) active.state.activeExecution = null;
              return;
            }
            case "session.error": {
              const activeSessionIDs = Array.from(threads.values())
                .filter(
                  (state) =>
                    state.activeTurn !== null &&
                    (!state.activeTurn.finalized ||
                      state.activeTurn.terminalStatus === "completed"),
                )
                .map((state) => state.nativeSessionId);
              const targetSessionIDs = openCode2SessionErrorTargetSessionIds(
                event.data.sessionID,
                activeSessionIDs,
              );
              const rawMessage = openCode2SessionErrorMessage(event.data);
              const isAbort = event.data.error?.name === "MessageAbortedError";
              const failure = isAbort
                ? makeProviderFailure({
                    message: "OpenCode 2 turn was aborted.",
                    code: "MessageAbortedError",
                    class: "provider_error",
                    retryable: true,
                  })
                : openCode2ProviderFailure({
                    message: rawMessage,
                    code: event.data.error?.name ?? null,
                    statusCode: openCode2ProviderErrorStatus(event.data),
                  });
              const targetsRoot =
                event.data.sessionID === undefined ||
                targetSessionIDs.some(
                  (sessionID) => threads.get(sessionID)?.parentSubagent === null,
                );
              if (!isAbort && targetsRoot) yield* updateProviderSession("error", failure.message);
              for (const sessionID of targetSessionIDs) {
                const active = terminalFor(sessionID);
                if (active === null) continue;
                active.turn.pendingExecutionFailure = null;
                yield* finalizeTurn(
                  active.state,
                  active.turn,
                  openCode2SessionErrorStatus(event.data, active.turn.interrupted),
                  {
                    failure,
                    threadDisposition: event.data.sessionID === undefined ? "broken" : "reusable",
                  },
                );
              }
              // Finalizing one of several active turns temporarily marks the
              // shared provider session as running. Restore the unscoped
              // provider failure after every affected turn has closed.
              if (!isAbort && targetsRoot) {
                yield* updateProviderSession("error", failure.message);
              }
              return;
            }
            default:
              return;
          }
        });

        const processEventAndDrain = Effect.fnUntraced(function* (
          event: unknown,
          context: OpenCode2EventHandlingContext = {},
        ) {
          yield* handleEvent(event, context);
          while (pendingDeferredChildEvents.length > 0) {
            const deferred = pendingDeferredChildEvents.shift();
            if (deferred !== undefined) {
              yield* handleEvent(deferred, { deferredChildReplay: true });
            }
          }
        });

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => abortController.abort()),
        );
        // First event.subscribe runs on this fiber so ensureThread cannot race
        // ahead under TestClock (fork-only subscribe lost to agent.list/create).
        // Drain + resubscribe stay forked after the first outbound is established.
        const firstStreamController = new AbortController();
        const onFirstSessionAbort = () => firstStreamController.abort();
        if (abortController.signal.aborted) {
          firstStreamController.abort();
        } else {
          abortController.signal.addEventListener("abort", onFirstSessionAbort, { once: true });
        }
        const firstSubscription = yield* sdkCall("event.subscribe", {}, () =>
          Promise.resolve(client.event.subscribe({ signal: firstStreamController.signal })),
        );
        lastEventAtMs = yield* Clock.currentTimeMillis;

        const consumeEventStream = (stream: AsyncIterable<unknown>) =>
          Stream.fromAsyncIterable(
            stream,
            (cause) =>
              new OpenCode2RuntimeError({
                operation: "event.subscribe",
                category: "event-subscription-failed",
                cause,
              }),
          ).pipe(
            Stream.tap((event) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => {
                  lastEventAtMs = now;
                  consecutiveStreamFailures = 0;
                  // server.connected alone is not progress; do not clear
                  // stall resubscribe budget on reconnect acks.
                  if ((event as { readonly type?: string }).type !== "server.connected") {
                    consecutiveStallResubscribes = 0;
                    consecutiveCleanEofResubscribes = 0;
                    cleanEofWindowStartedAtMs = null;
                  }
                }),
              ),
            ),
            Stream.runForEach(processEventAndDrain),
            Effect.exit,
          );

        // Resubscribe loop: `/api/event` is volatile (slow consumer overflows).
        // A single failed or hung pull must not leave active turns uninterruptible.
        const eventPump = Effect.gen(function* () {
          let pendingStream: AsyncIterable<unknown> | null = firstSubscription;
          let streamController = firstStreamController;
          let onSessionAbort = onFirstSessionAbort;

          while (!abortController.signal.aborted) {
            let watchdogResubscribe = false;
            if (pendingStream === null) {
              streamController = new AbortController();
              onSessionAbort = () => streamController.abort();
              if (abortController.signal.aborted) {
                streamController.abort();
              } else {
                abortController.signal.addEventListener("abort", onSessionAbort, { once: true });
              }
            }

            const watchdog = yield* Effect.gen(function* () {
              while (!streamController.signal.aborted && !abortController.signal.aborted) {
                yield* Effect.sleep(`${OPENCODE2_EVENT_STALL_CHECK_MS} millis`);
                const hasActiveTurn = Array.from(threads.values()).some(
                  (threadState) => threadState.activeTurn !== null,
                );
                // Explained quiet still reconnects so stale pending markers can
                // be cleared, but only unexplained quiet spends the fail budget.
                const now = yield* Clock.currentTimeMillis;
                const hasPendingRuntimeRequest = allActiveTurnsAwaitRuntimeRequest();
                const hasInFlightPendingWork = allActiveTurnsHaveInFlightPendingWork(now);
                const lastEventAgeMs = now - lastEventAtMs;
                if (
                  !openCode2ShouldResubscribeStalledStream({
                    sessionAborted: abortController.signal.aborted,
                    hasActiveTurn,
                    lastEventAgeMs,
                    stallMs: OPENCODE2_EVENT_STALL_MS,
                  })
                ) {
                  continue;
                }
                const chargeStallBudget = openCode2ShouldChargeStallBudget({
                  hasPendingRuntimeRequest,
                  hasInFlightPendingWork,
                });
                if (
                  chargeStallBudget &&
                  consecutiveStallResubscribes >= OPENCODE2_EVENT_STALL_MAX_RESUBSCRIBES
                ) {
                  yield* Effect.logError(
                    "OpenCode 2 event stream stall budget exhausted; failing active turns.",
                    {
                      provider: OPENCODE2_PROVIDER,
                      stallMs: lastEventAgeMs,
                      consecutiveStallResubscribes,
                    },
                  );
                  yield* failActiveTurns(
                    `OpenCode 2 event stream went quiet for ${OPENCODE2_EVENT_STALL_MS / 1_000}s after ${consecutiveStallResubscribes} reconnect attempts and did not recover. Retry the turn, or Stop if OpenCode is hung.`,
                    "transport_error",
                    "event.stream.stall",
                    true,
                  );
                  streamController.abort();
                  return;
                }
                if (chargeStallBudget) consecutiveStallResubscribes += 1;
                yield* Effect.logWarning(
                  "OpenCode 2 event stream stalled while a turn is active; resubscribing.",
                  {
                    provider: OPENCODE2_PROVIDER,
                    stallMs: lastEventAgeMs,
                    consecutiveStallResubscribes,
                    explainedQuiet: !chargeStallBudget,
                  },
                );
                watchdogResubscribe = true;
                streamController.abort();
                return;
              }
            }).pipe(Effect.forkIn(scope));

            const exit = yield* Effect.gen(function* () {
              if (pendingStream !== null) {
                const stream = pendingStream;
                pendingStream = null;
                return yield* consumeEventStream(stream);
              }
              const subscription = yield* sdkCall("event.subscribe", {}, () =>
                Promise.resolve(client.event.subscribe({ signal: streamController.signal })),
              );
              return yield* consumeEventStream(subscription);
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.succeed(
                  Exit.fail(
                    new OpenCode2RuntimeError({
                      operation: "event.subscribe",
                      category: "event-subscription-failed",
                      cause: Cause.squash(cause),
                    }),
                  ),
                ),
              ),
            );

            streamController.abort();
            abortController.signal.removeEventListener("abort", onSessionAbort);
            yield* Fiber.interrupt(watchdog).pipe(Effect.ignore);

            if (abortController.signal.aborted) return;

            const hasActiveTurn = Array.from(threads.values()).some(
              (threadState) => threadState.activeTurn !== null,
            );
            let resubscribeDelayMs = OPENCODE2_EVENT_RESUBSCRIBE_DELAY_MS;

            if (Exit.isFailure(exit)) {
              const chargeStreamFailure = openCode2ShouldChargeStreamFailure(watchdogResubscribe);
              if (chargeStreamFailure) consecutiveStreamFailures += 1;
              yield* Effect.logWarning(
                "OpenCode 2 event subscription ended; will resubscribe when possible.",
                {
                  errorTag: causeErrorTag(exit.cause),
                  provider: OPENCODE2_PROVIDER,
                  consecutiveStreamFailures,
                  watchdogResubscribe,
                },
              );
              if (
                chargeStreamFailure &&
                consecutiveStreamFailures >= OPENCODE2_EVENT_STREAM_MAX_FAILURES &&
                hasActiveTurn
              ) {
                yield* failActiveTurns(
                  `OpenCode 2 event subscription failed ${consecutiveStreamFailures} times. Retry the turn.`,
                  "transport_error",
                  "event.stream.subscribe",
                  true,
                );
                consecutiveStreamFailures = 0;
              }
            } else if (hasActiveTurn && allActiveTurnsAwaitRuntimeRequest()) {
              const now = yield* Clock.currentTimeMillis;
              cleanEofWindowStartedAtMs ??= now;
              consecutiveCleanEofResubscribes += 1;
              resubscribeDelayMs = openCode2CleanEofResubscribeDelayMs(
                consecutiveCleanEofResubscribes,
                true,
              );
              yield* Effect.logWarning(
                "OpenCode 2 event stream ended cleanly while awaiting user input; resubscribing with backoff.",
                {
                  provider: OPENCODE2_PROVIDER,
                  consecutiveCleanEofResubscribes,
                  resubscribeDelayMs,
                },
              );
            } else if (hasActiveTurn) {
              // A clean EOF while a turn is active leaves the turn without a
              // terminal and without a dead-stream signal: every cycle resets
              // the stall clock, so a proxy recycle or dead server that closes
              // /api/event right after each reconnect would park the turn
              // forever. Count unexplained event-less clean EOFs and fail once
              // both the count and elapsed-time budgets are exhausted. Local
              // stall aborts and explained quiet (in-flight shells/tools) only
              // resubscribe; idle reconnects and replay parking stay unbounded.
              const now = yield* Clock.currentTimeMillis;
              const chargeCleanEofBudget = openCode2ShouldChargeCleanEofBudget({
                watchdogResubscribe,
                hasPendingRuntimeRequest: false,
                hasInFlightPendingWork: allActiveTurnsHaveInFlightPendingWork(now),
              });
              if (!chargeCleanEofBudget) {
                consecutiveCleanEofResubscribes = 0;
                cleanEofWindowStartedAtMs = null;
                yield* Effect.logWarning(
                  "OpenCode 2 event stream ended cleanly during explained quiet or stall recovery; resubscribing without charging the clean-EOF budget.",
                  {
                    provider: OPENCODE2_PROVIDER,
                    watchdogResubscribe,
                  },
                );
              } else {
                cleanEofWindowStartedAtMs ??= now;
                consecutiveCleanEofResubscribes += 1;
                yield* Effect.logWarning(
                  "OpenCode 2 event stream ended cleanly while a turn is active; resubscribing.",
                  {
                    provider: OPENCODE2_PROVIDER,
                    consecutiveCleanEofResubscribes,
                  },
                );
                if (
                  openCode2ShouldFailActiveTurnsAfterCleanEof({
                    consecutiveCleanEofs: consecutiveCleanEofResubscribes,
                    maxCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
                    cleanEofWindowAgeMs: now - cleanEofWindowStartedAtMs,
                    minimumWindowMs: OPENCODE2_EVENT_STALL_MS,
                    hasActiveTurn,
                  })
                ) {
                  yield* Effect.logError(
                    "OpenCode 2 event stream clean-EOF budget exhausted; failing active turns.",
                    {
                      provider: OPENCODE2_PROVIDER,
                      consecutiveCleanEofResubscribes,
                      maxCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
                    },
                  );
                  yield* failActiveTurns(
                    `OpenCode 2 event stream closed cleanly ${consecutiveCleanEofResubscribes} times while a turn was active. Retry the turn.`,
                    "transport_error",
                    "event.stream.clean_eof",
                    true,
                  );
                  consecutiveCleanEofResubscribes = 0;
                  cleanEofWindowStartedAtMs = null;
                }
              }
            } else if (!hasActiveTurn) {
              // Replay fixtures end the SSE stream cleanly once the transcript
              // is drained; park until the adapter scope aborts instead of
              // opening a second subscribe the harness did not record.
              // Live servers can also clean-EOF while idle (proxy idle timeout,
              // process recycle). Resubscribe so a later startTurn on this
              // same session still receives events; openSession is not re-run.
              if (connection.url.startsWith("replay://")) {
                while (!abortController.signal.aborted) {
                  yield* Effect.sleep("1 second");
                }
                return;
              }
              consecutiveStreamFailures = 0;
              consecutiveCleanEofResubscribes = 0;
              cleanEofWindowStartedAtMs = null;
            }

            lastEventAtMs = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(`${resubscribeDelayMs} millis`);
          }
        });
        yield* openCode2ForkEventPumpInScope({
          scope,
          abort: Effect.sync(() => abortController.abort()),
          pump: eventPump,
        });

        if (!connection.external && connection.exitCode !== null) {
          yield* connection.exitCode.pipe(
            Effect.flatMap(() =>
              abortController.signal.aborted
                ? Effect.void
                : failActiveTurns(
                    "OpenCode 2 server exited unexpectedly. Restart OpenCode, then retry the turn.",
                    "transport_error",
                    "server.exited",
                    true,
                  ),
            ),
            Effect.forkIn(scope),
          );
        }

        const registerThread = (
          nativeSession: SessionInfoV2,
          providerThread: OrchestrationV2ProviderThread,
        ): OpenCode2ThreadState => {
          const existing = threads.get(nativeSession.id);
          if (existing !== undefined) {
            existing.location = nativeSession.location;
            existing.providerThread = providerThread;
            existing.latestTokenUsage =
              openCode2TokenUsage(nativeSession) ?? existing.latestTokenUsage;
            if (nativeSession.model !== undefined) {
              existing.boundModel = `${nativeSession.model.providerID}/${nativeSession.model.id}`;
              existing.boundVariant =
                normalizeOpenCode2Variant(nativeSession.model.variant) ?? null;
            }
            existing.boundAgent = nativeSession.agent ?? existing.boundAgent;
            return existing;
          }
          const state: OpenCode2ThreadState = {
            nativeSessionId: nativeSession.id,
            location: nativeSession.location,
            providerThread,
            appThread: null,
            activeTurn: null,
            boundModel:
              nativeSession.model === undefined
                ? null
                : `${nativeSession.model.providerID}/${nativeSession.model.id}`,
            boundVariant: normalizeOpenCode2Variant(nativeSession.model?.variant) ?? null,
            boundAgent: nativeSession.agent ?? null,
            lastAgentSelectedEventId: null,
            providerTurns: new Map(),
            messages: new Map(),
            runtimeRequests: new Map(),
            postSettleWakes: [],
            retiredSuppressWakes: new Map(),
            promotedInputIds: new Set(),
            sawInputPromotion: false,
            quarantined: false,
            activeExecution: null,
            parentSubagent: subagentsByChildSessionId.get(nativeSession.id) ?? null,
            nextChildTurnOrdinal: 1,
            latestTokenUsage: openCode2TokenUsage(nativeSession),
          };
          threads.set(nativeSession.id, state);
          return state;
        };

        let agentCatalog: ReadonlySet<string> | null = null;
        const knownAgentIDs = Effect.fnUntraced(function* () {
          if (agentCatalog !== null) return agentCatalog;
          const fetched = yield* sdkCall("agent.list", {}, () =>
            client.agent.list({ location: { directory: cwd } }),
          ).pipe(
            Effect.flatMap((response) =>
              unwrapOpenCode2Data<ReadonlyArray<AgentInfoV2>>("agent.list", response).pipe(
                Effect.map(
                  (agents) => new Set(agents.map((agent) => agent.id)) as ReadonlySet<string>,
                ),
              ),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Failed to load the OpenCode 2 agent catalog.", {
                    errorTag: causeErrorTag(cause),
                    provider: OPENCODE2_PROVIDER,
                  }).pipe(Effect.as(null)),
            ),
          );
          if (fetched?.has("build") && fetched.has("plan")) {
            agentCatalog = fetched;
          }
          return fetched;
        });

        const warnDroppedVariant = (modelSlug: string, droppedVariant: string | null) =>
          droppedVariant === null
            ? Effect.void
            : Effect.logWarning("Dropping a variant the OpenCode 2 catalog cannot validate.", {
                provider: OPENCODE2_PROVIDER,
                model: modelSlug,
                variant: droppedVariant,
              });

        /**
         * 2.x binds the model, variant, and agent to the session, not to the
         * prompt, so a selection change between turns has to be pushed before
         * the prompt. A variant-less switch resets the session to the
         * server-resolved default variant.
         */
        const alignSessionSelection = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          modelSelection: ModelSelection,
          interactionMode?: ProviderInteractionMode,
        ) {
          const sessionID = state.nativeSessionId;
          // Subagent child sessions run their own native agents (general,
          // explore, customs); the Build/Plan mapping only owns top-level
          // sessions.
          const selection = openCode2SessionSelectionParameters(
            modelSelection,
            state.parentSubagent === null ? interactionMode : undefined,
            state.parentSubagent === null ? yield* knownAgentIDs() : null,
          );
          const plan = planOpenCode2VariantAlignment({
            boundModel: state.boundModel,
            boundVariant: state.boundVariant,
            model: modelSelection.model,
            rawVariant: getModelSelectionStringOptionValue(modelSelection, "variant"),
            knownVariants:
              selection.model.variant === undefined
                ? null
                : yield* knownVariantsForModel(modelSelection.model),
          });
          yield* warnDroppedVariant(modelSelection.model, plan.droppedVariant);
          if (plan.switchNeeded) {
            const model = {
              id: selection.model.id,
              providerID: selection.model.providerID,
              ...(plan.variant === undefined ? {} : { variant: plan.variant }),
            };
            yield* sdkCall("session.switchModel", { sessionID, model }, () =>
              client.session.switchModel({ sessionID, model }),
            );
            state.boundModel = modelSelection.model;
            state.boundVariant = plan.variant ?? null;
          }
          const agent = selection.agent;
          if (agent !== undefined && state.boundAgent !== agent) {
            yield* sdkCall("session.switchAgent", { sessionID, agent }, () =>
              client.session.switchAgent({ sessionID, agent }),
            );
            state.boundAgent = agent;
          }
        });

        // Prompt body is flat `{ text, files?, delivery? }` on `@opencode-ai/client`.
        const promptPayload = (message: ProviderAdapterV2TurnInput["message"]) => {
          const text = message.text.trim();
          const files = toOpenCode2FileAttachments({
            attachments: message.attachments,
            resolveAttachmentPath: (attachment) =>
              resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
          });
          if (text.length === 0 && files.length === 0) {
            throw protocolError("OpenCode 2 turns require text or file attachments");
          }
          return {
            text: text.length === 0 ? " " : text,
            ...(files.length === 0 ? {} : { files }),
          };
        };

        const postSessionPrompt = (input: {
          readonly sessionID: string;
          readonly text: string;
          readonly files?: ReturnType<typeof toOpenCode2FileAttachments>;
          readonly delivery?: "steer" | "queue";
        }) =>
          client.session.prompt({
            sessionID: input.sessionID,
            text: input.text,
            ...(input.files === undefined || input.files.length === 0
              ? {}
              : { files: input.files }),
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
          });

        const postSessionFork = (parameters: ReturnType<typeof openCode2ForkParameters>) =>
          client.session.fork({
            sessionID: parameters.sessionID,
            boundary: parameters.$body_boundary,
          });

        const readSnapshot = Effect.fnUntraced(function* (
          providerThread: OrchestrationV2ProviderThread,
        ) {
          const sessionID = nativeThreadId(providerThread);
          const response = yield* sdkCall("message.list", { sessionID }, () =>
            client.message.list({ sessionID }),
          );
          const nativeMessages = yield* unwrapOpenCode2Data<Array<SessionMessageInfo>>(
            "message.list",
            response,
          );
          const state = threads.get(sessionID);
          const snapshotNow = yield* DateTime.now;
          const messages: Array<OrchestrationV2ConversationMessage> = nativeMessages.flatMap(
            (info) => {
              let text = "";
              if (info.type === "user") {
                text = info.text;
              } else if (info.type === "assistant") {
                text = info.content
                  .filter((entry) => entry.type === "text")
                  .map((entry) => entry.text)
                  .join("\n");
              }
              if (text.trim().length === 0) return [];
              const createdAt = dateTimeFromEpoch(info.time.created, snapshotNow);
              return [
                {
                  createdBy: info.type === "user" ? ("user" as const) : ("agent" as const),
                  creationSource: "provider" as const,
                  id: idAllocator.derive.messageFromProviderItem({
                    driver: OPENCODE2_PROVIDER,
                    nativeItemId: info.id,
                  }),
                  threadId: providerThread.appThreadId ?? input.threadId,
                  runId: null,
                  nodeId: null,
                  role: info.type === "user" ? ("user" as const) : ("assistant" as const),
                  text,
                  attachments: [],
                  streaming: false,
                  createdAt,
                  updatedAt: createdAt,
                },
              ];
            },
          );
          const lastUser = nativeMessages.findLast((info) => info.type === "user")?.id;
          return {
            providerThread: {
              ...providerThread,
              providerSessionId: input.providerSessionId,
              nativeConversationHeadRef:
                lastUser === undefined ? null : providerRef(lastUser, "weak"),
              status: "idle" as const,
              updatedAt: snapshotNow,
            },
            providerTurns: state === undefined ? [] : [...state.providerTurns.values()],
            messages,
            runtimeRequests: state === undefined ? [] : [...state.runtimeRequests.values()],
            providerPayload: nativeMessages,
          };
        });

        const inspectPendingBackgroundWork = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
        ) {
          const sessionID = state.nativeSessionId;
          return yield* openCode2PendingWorkForSession({
            sessionID,
            // Prefer live Session3 when present; replay client still implements
            // these routes so fixtures can assert the post-settle probes.
            pending: sdkCall("session.inbox.list", { sessionID }, () =>
              client.session.inbox.list({ sessionID }),
            ).pipe(
              Effect.flatMap((response) =>
                unwrapOpenCode2Data<unknown>("session.inbox.list", response),
              ),
              Effect.map(openCode2PendingItemsFromList),
            ),
            shells: sdkCall("shell.list", { location: state.location }, () =>
              client.shell.list({ location: state.location }),
            ).pipe(
              Effect.flatMap((response) => unwrapOpenCode2Data<unknown>("shell.list", response)),
              Effect.map(openCode2ShellsFromList),
              Effect.tap((shells) =>
                Effect.gen(function* () {
                  const listed = new Set(
                    shells
                      .filter((shell) => {
                        if (shell.status !== "running") return false;
                        const owner = shell.metadata?.sessionID;
                        return (
                          owner === sessionID ||
                          (owner === undefined &&
                            (runningShellIdsBySession.get(sessionID)?.has(shell.id) ?? false))
                        );
                      })
                      .map((shell) => shell.id),
                  );
                  const stale: string[] = [];
                  for (const shellId of runningShellIdsBySession.get(sessionID) ?? []) {
                    if (!listed.has(shellId)) stale.push(shellId);
                  }
                  for (const shellId of stale) {
                    yield* forgetRunningShell(shellId);
                  }
                  if (!holdPendingWorkAfterClear.has(sessionID)) {
                    for (const shellId of listed) {
                      yield* rememberRunningShell(sessionID, shellId);
                    }
                  }
                }),
              ),
            ),
          });
        });

        const sessionHasPendingBackgroundWork = (
          sessionID: string,
          inspected: boolean | undefined,
        ) =>
          inspected === true ||
          (runningShellIdsBySession.get(sessionID)?.size ?? 0) > 0 ||
          holdPendingWorkAfterClear.has(sessionID);

        const hasPendingBackgroundWorkForState = (state: OpenCode2ThreadState) =>
          inspectPendingBackgroundWork(state).pipe(
            Effect.map((inspected) =>
              sessionHasPendingBackgroundWork(state.nativeSessionId, inspected),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to inspect OpenCode 2 pending background work.", {
                errorTag: causeErrorTag(cause),
                provider: OPENCODE2_PROVIDER,
                providerThreadId: state.providerThread.id,
              }).pipe(Effect.as(sessionHasPendingBackgroundWork(state.nativeSessionId, undefined))),
            ),
          );

        const waitForT3Mcp = Effect.fnUntraced(function* () {
          if (!hasT3Mcp || mcpSession === undefined) return;
          let lastStatus = "missing";
          let added = false;
          for (let attempt = 0; attempt < 50; attempt++) {
            const listed = yield* sdkCall("mcp.list", { location: { directory: cwd } }, () =>
              client.mcp.list({ location: { directory: cwd } }),
            );
            const servers = yield* unwrapOpenCode2Data<unknown>("mcp.list", listed).pipe(
              Effect.map(openCode2McpServersFromList),
              Effect.catchCause(() => Effect.succeed<ReadonlyArray<McpServer>>([])),
            );
            const server = servers.find((candidate) => candidate.name === OPENCODE2_T3_MCP_NAME);
            lastStatus = server === undefined ? "missing" : mcpServerStatus(server);
            if (lastStatus === "connected") return;
            if (lastStatus === "missing" && !added) {
              added = true;
              const payload = {
                server: OPENCODE2_T3_MCP_NAME,
                location: { directory: cwd },
                config: {
                  type: "remote" as const,
                  url: mcpSession.endpoint,
                  headers: { Authorization: mcpSession.authorizationHeader },
                  oauth: false as const,
                },
              };
              yield* sdkCall("mcp.add", payload, () => client.mcp.add(payload));
              continue;
            }
            if (lastStatus !== "missing" && lastStatus !== "pending") {
              return yield* new OpenCode2RuntimeError({
                operation: "mcp.list",
                category: "mcp-connect-failed",
                cause: server?.status,
              });
            }
            if (attempt < 49) yield* Effect.sleep("100 millis");
          }
          return yield* new OpenCode2RuntimeError({
            operation: "mcp.list",
            category: "mcp-connect-timeout",
          });
        });

        const installT3OrchestrationInstructions = Effect.fnUntraced(function* (sessionID: string) {
          if (!hasT3Mcp) return;
          const value = openCode2T3OrchestrationInstructions();
          const payload = {
            sessionID,
            key: OPENCODE2_T3_INSTRUCTION_KEY,
            value,
          } as const;
          yield* sdkCall("session.instructions.entry.put", payload, () =>
            client.session.instructions.entry.put(payload),
          );
        });

        yield* waitForT3Mcp();

        const runtimeSession: ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver: OPENCODE2_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: sessionEntity,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          hasPendingBackgroundWork: Effect.gen(function* () {
            for (const state of threads.values()) {
              if (yield* hasPendingBackgroundWorkForState(state)) return true;
            }
            return false;
          }),
          hasPendingBackgroundWorkForThread: (providerThread) =>
            Effect.gen(function* () {
              const sessionID = nativeThreadId(providerThread);
              const state = threads.get(sessionID);
              if (state === undefined) {
                return sessionHasPendingBackgroundWork(sessionID, undefined);
              }
              const inspected = yield* inspectPendingBackgroundWork(state).pipe(Effect.option);
              const hold = holdPendingWorkAfterClear.delete(sessionID);
              return (
                (inspected._tag === "Some" && inspected.value) ||
                (runningShellIdsBySession.get(sessionID)?.size ?? 0) > 0 ||
                hold
              );
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to inspect OpenCode 2 pending background work.", {
                  errorTag: causeErrorTag(cause),
                  provider: OPENCODE2_PROVIDER,
                  providerThreadId: providerThread.id,
                }).pipe(
                  Effect.as(
                    (runningShellIdsBySession.get(nativeThreadId(providerThread))?.size ?? 0) > 0,
                  ),
                ),
              ),
            ),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              if (threadInput.existingProviderThread !== undefined) {
                return yield* runtimeSession.resumeThread({
                  providerThread: threadInput.existingProviderThread,
                });
              }
              const selection = openCode2SessionSelectionParameters(
                threadInput.modelSelection,
                threadInput.runtimePolicy.interactionMode,
                yield* knownAgentIDs(),
              );
              const agent = selection.agent;
              const clamp = clampOpenCode2Variant(
                selection.model.variant,
                selection.model.variant === undefined
                  ? null
                  : yield* knownVariantsForModel(threadInput.modelSelection.model),
              );
              yield* warnDroppedVariant(threadInput.modelSelection.model, clamp.droppedVariant);
              const parameters = {
                ...selection,
                model: {
                  id: selection.model.id,
                  providerID: selection.model.providerID,
                  ...(clamp.variant === undefined ? {} : { variant: clamp.variant }),
                },
                location: { directory: threadInput.runtimePolicy.cwd ?? cwd },
              };
              const response = yield* sdkCall("session.create", parameters, () =>
                client.session.create(parameters),
              );
              const nativeSession = yield* unwrapOpenCode2Data<SessionInfoV2>(
                "session.create",
                response,
              );
              yield* installT3OrchestrationInstructions(nativeSession.id);
              const createdAt = yield* DateTime.now;
              const providerThread = makeProviderThread({
                idAllocator,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                nativeSession,
                now: createdAt,
              });
              const state = registerThread(nativeSession, providerThread);
              state.boundModel = threadInput.modelSelection.model;
              state.boundVariant = clamp.variant ?? null;
              if (agent !== undefined) state.boundAgent = agent;
              return providerThread;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterEnsureThreadError({
                    driver: OPENCODE2_PROVIDER,
                    threadId: threadInput.threadId,
                    cause,
                  }),
              ),
            ),
          resumeThread: (threadInput) =>
            Effect.gen(function* () {
              const sessionID = nativeThreadId(threadInput.providerThread);
              const registered = threads.get(sessionID);
              if (registered !== undefined && registered.quarantined) {
                // The native session may still be executing an interrupt that
                // was never confirmed. Fail the resume so the orchestrator
                // replaces it with a fresh session (ensureThread) instead of
                // reattaching a thread whose execution state is unknown.
                return yield* protocolError(
                  `OpenCode 2 session ${sessionID} is quarantined after an unconfirmed interrupt; a fresh session is required`,
                );
              }
              const response = yield* sdkCall("session.get", { sessionID }, () =>
                client.session.get({ sessionID }),
              );
              const nativeSession = yield* unwrapOpenCode2Data<SessionInfoV2>(
                "session.get",
                response,
              );
              yield* installT3OrchestrationInstructions(sessionID);
              const resumedAt = yield* DateTime.now;
              const providerThread = {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                status: "idle" as const,
                updatedAt: dateTimeFromEpoch(nativeSession.time.updated, resumedAt),
              };
              registerThread(nativeSession, providerThread);
              return providerThread;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterResumeThreadError({
                    driver: OPENCODE2_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          deleteThread: (providerThread) =>
            Effect.gen(function* () {
              const sessionID = nativeThreadId(providerThread);
              yield* removeOpenCode2Session(
                sessionID,
                sdkCall("session.remove", { sessionID }, () => deleteSessionHttp(sessionID)),
              );
              threads.delete(sessionID);
              sessionPermissions.delete(sessionID);
              seenRuntimeRequestKeysBySessionId.delete(sessionID);
              for (const requestKey of autoReplyPermissionsByNativeKey.keys()) {
                if (requestKey.startsWith(`${sessionID}\0`)) {
                  autoReplyPermissionsByNativeKey.delete(requestKey);
                }
              }
              for (const [requestID, settled] of settledRequestsByNativeId) {
                if (settled.pending.nativeSessionId === sessionID) {
                  settledRequestsByNativeId.delete(requestID);
                }
              }
            }).pipe(
              Effect.mapError((cause) =>
                protocolError(`Failed to delete OpenCode 2 session ${providerThread.id}`, cause),
              ),
            ),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const sessionID = nativeThreadId(turnInput.providerThread);
              const state = threads.get(sessionID);
              if (state === undefined) {
                return yield* protocolError(`OpenCode 2 session ${sessionID} is not registered`);
              }
              if (state.activeTurn !== null) {
                return yield* protocolError(
                  `OpenCode 2 provider thread ${turnInput.providerThread.id} already has an active turn`,
                );
              }
              if (state.quarantined) {
                // Last line of defense when the session manager already cached
                // this thread as loaded (its resumeThread gate above is then
                // skipped). A prompt on a session whose interrupt was never
                // confirmed could queue behind the unconfirmed execution and
                // let its late events settle this turn.
                return yield* protocolError(
                  `OpenCode 2 session ${sessionID} is quarantined after an unconfirmed interrupt; start a new thread or retry after the session is replaced`,
                );
              }
              state.providerThread = bindOpenCode2CanonicalProviderThread(
                state.providerThread,
                turnInput.providerThread,
              );
              const providerBufferedContinuation =
                turnInput.message.createdBy === "agent" &&
                turnInput.message.creationSource === "provider";
              const wake = (() => {
                if (!providerBufferedContinuation) return undefined;
                const readyWakeIndex = state.postSettleWakes.findIndex(
                  (candidate) => candidate.disposition === "replay" && candidate.phase === "ready",
                );
                const wakeIndex =
                  readyWakeIndex >= 0
                    ? readyWakeIndex
                    : state.postSettleWakes.findIndex(
                        (candidate) => candidate.disposition === "replay",
                      );
                if (wakeIndex < 0) return undefined;
                const replayWake = state.postSettleWakes.splice(wakeIndex, 1)[0];
                if (replayWake !== undefined) state.promotedInputIds.delete(replayWake.inputId);
                return replayWake;
              })();
              // Build the prompt payload before arming activeTurn so an empty
              // message fails cleanly without wedging the session as active.
              const promptBody = providerBufferedContinuation
                ? undefined
                : promptPayload(turnInput.message);
              const startedAt = yield* DateTime.now;
              const syntheticNativeTurnId = `${sessionID}:attempt:${turnInput.attemptId}`;
              const providerTurnId = idAllocator.derive.providerTurn({
                driver: OPENCODE2_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              });
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
                ordinal: turnInput.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
              };
              const turn: ActiveOpenCode2Turn = {
                isRoot: true,
                providerBufferedContinuation,
                threadId: turnInput.threadId,
                runId: turnInput.runId,
                rootNodeId: turnInput.rootNodeId,
                appThread: turnInput.appThread,
                modelSelection: turnInput.modelSelection,
                runtimePolicy: turnInput.runtimePolicy,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                startedAt,
                itemOrdinals: new Map(),
                parts: new Map(),
                toolIdsByCallId: new Map(),
                providerTurn,
                nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
                nativeInputId: wake?.inputId ?? null,
                activeCompaction: null,
                executionStarted: false,
                interrupted: false,
                finalized: false,
                terminalStatus: null,
                providerRetry: null,
                pendingExecutionFailure: null,
              };
              state.appThread = turnInput.appThread;
              state.activeTurn = turn;
              state.providerTurns.set(String(providerTurnId), providerTurn);
              yield* emitProviderTurn(state, turn, "running", null);
              yield* updateProviderThread(state, {
                status: "active",
                firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                lastRunOrdinal: turnInput.runOrdinal,
              });
              yield* updateProviderSession("running", null);
              if (providerBufferedContinuation) {
                // OpenCode already ran this input. The app turn only gives its
                // buffered native events durable run ownership.
                // A still-pending wake was part of an ordinary shared execution;
                // its output already belongs to that ordinary turn.
                if (wake === undefined || wake.phase === "pending") {
                  yield* finalizeTurn(state, turn, "completed");
                  return;
                }
                for (const event of wake.events) {
                  yield* processEventAndDrain(event, { replayWakeInputId: wake.inputId });
                }
                return;
              }
              const payload = promptBody!;
              const finalizeFailedTurn = (cause: unknown) =>
                finalizeTurn(state, turn, "failed", {
                  failure: makeProviderFailure({ cause, class: "provider_error" }),
                });
              yield* alignSessionSelection(
                state,
                turnInput.modelSelection,
                turnInput.runtimePolicy.interactionMode,
              ).pipe(Effect.tapError(finalizeFailedTurn));
              // The pinned beta SDK omits this route, so post the flat body that
              // the next-line server accepts through the generated HTTP client.
              const prompted = yield* sdkCall("session.prompt", { sessionID, ...payload }, () =>
                postSessionPrompt({ sessionID, ...payload }),
              ).pipe(Effect.tapError(finalizeFailedTurn));
              // Arm the stall watchdog from the prompt boundary so a long first
              // token does not immediately resubscribe, but a dead stream after
              // prompt still recovers.
              lastEventAtMs = yield* Clock.currentTimeMillis;
              // The admitted input id is the closest native turn correlation
              // point 2.x offers, and it arrives on the prompt response before
              // `session.input.admitted` reaches the event stream. The pinned
              // client returns a single-wrapped body (`data.id`); a double
              // envelope (`data.data.id`) is still accepted.
              const promptedBody =
                prompted !== null && typeof prompted === "object" && "data" in prompted
                  ? (prompted as { data?: unknown }).data
                  : undefined;
              const admittedId =
                recordString(promptedBody, "id") ??
                recordString(
                  promptedBody !== null &&
                    typeof promptedBody === "object" &&
                    "data" in promptedBody
                    ? (promptedBody as { data?: unknown }).data
                    : undefined,
                  "id",
                );
              if (admittedId !== undefined && turn.nativeInputId === null) {
                turn.nativeInputId = admittedId;
                yield* emitProviderTurn(state, turn, "running", null);
              }
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: OPENCODE2_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
          steerTurn: (steerInput) =>
            Effect.gen(function* () {
              const sessionID = nativeThreadId(steerInput.providerThread);
              const state = threads.get(sessionID);
              const turn = state?.activeTurn;
              if (
                state === undefined ||
                turn === undefined ||
                turn === null ||
                turn.providerTurnId !== steerInput.providerTurnId
              ) {
                return yield* protocolError(
                  `OpenCode 2 turn ${steerInput.providerTurnId} is not active`,
                );
              }
              const payload = promptPayload(steerInput.message);
              // Keep the protocol log aligned with the flat HTTP body.
              yield* sdkCall("session.prompt", { sessionID, ...payload, delivery: "steer" }, () =>
                postSessionPrompt({ sessionID, ...payload, delivery: "steer" }),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterSteerRunError({
                    driver: OPENCODE2_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
          interruptTurn: (interruptInput) =>
            Effect.gen(function* () {
              const sessionID = nativeThreadId(interruptInput.providerThread);
              const state = threads.get(sessionID);
              if (state === undefined) {
                return yield* protocolError(
                  `OpenCode 2 turn ${interruptInput.providerTurnId} is not active`,
                );
              }
              const turn = state.activeTurn;
              if (turn === null || turn.providerTurnId !== interruptInput.providerTurnId) {
                return yield* protocolError(
                  `OpenCode 2 turn ${interruptInput.providerTurnId} is not active`,
                );
              }
              turn.interrupted = true;
              // Bound the interrupt RPC: a full SSE Recv-Q has wedged concurrent
              // HTTP before, and Stop must not hang on that path.
              const interruptedRemote = yield* sdkCallWithTimeout(
                "session.interrupt",
                { sessionID },
                () => client.session.interrupt({ sessionID }),
                OPENCODE2_INTERRUPT_REQUEST_TIMEOUT_MS,
              );
              const interruptRequestConfirmed = Option.isSome(interruptedRemote);
              if (!interruptRequestConfirmed) {
                yield* Effect.logWarning(
                  "OpenCode 2 session.interrupt did not complete in time; force-settling locally.",
                  {
                    provider: OPENCODE2_PROVIDER,
                    providerTurnId: turn.providerTurnId,
                    timeoutMs: OPENCODE2_INTERRUPT_REQUEST_TIMEOUT_MS,
                  },
                );
              }
              const shellsStopped = yield* removeRunningShellsForTurn(turn).pipe(
                Effect.timeoutOption(`${OPENCODE2_INTERRUPT_REQUEST_TIMEOUT_MS} millis`),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to stop OpenCode 2 shells during interrupt.", {
                    errorTag: causeErrorTag(cause),
                    provider: OPENCODE2_PROVIDER,
                    providerTurnId: turn.providerTurnId,
                  }).pipe(Effect.as(Option.none<boolean>())),
                ),
              );
              const shellRemovalConfirmed = Option.isSome(shellsStopped) && shellsStopped.value;
              if (
                openCode2ShouldQuarantineInterruptedSession({
                  interruptRequestConfirmed,
                  shellRemovalConfirmed,
                })
              ) {
                state.quarantined = true;
                yield* Effect.logWarning(
                  "OpenCode 2 interrupt was not confirmed; quarantining the native session against reuse.",
                  {
                    provider: OPENCODE2_PROVIDER,
                    providerTurnId: turn.providerTurnId,
                    interruptRequestConfirmed,
                    shellRemovalConfirmed,
                  },
                );
              }
              // Prefer SSE-driven `session.execution.interrupted` finalization.
              // When the event stream is dead, force-finalize so Stop returns
              // the run to a terminal state (mirrors CursorAdapterV2).
              const settleStartedAt = yield* Clock.currentTimeMillis;
              while (true) {
                if (turn.finalized || state.activeTurn !== turn) return;
                const now = yield* Clock.currentTimeMillis;
                const waitedMs = now - settleStartedAt;
                if (
                  openCode2ShouldForceInterruptFinalize({
                    interrupted: turn.interrupted,
                    finalized: turn.finalized,
                    stillActive: state.activeTurn === turn,
                    waitedMs,
                    settleTimeoutMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
                  })
                ) {
                  break;
                }
                yield* Effect.sleep(`${OPENCODE2_INTERRUPT_SETTLE_POLL_MS} millis`);
              }
              if (turn.finalized || state.activeTurn !== turn) return;
              // A local timeout is not proof that native execution stopped,
              // even when the interrupt and shell-removal requests returned.
              // Only a native execution terminal makes this session reusable.
              state.quarantined = openCode2ShouldQuarantineInterruptedSession({
                interruptRequestConfirmed,
                shellRemovalConfirmed,
                forceFinalizedWithoutTerminal: true,
              });
              yield* Effect.logWarning(
                "OpenCode 2 interrupt settle timed out; force-finalizing the turn.",
                {
                  provider: OPENCODE2_PROVIDER,
                  providerTurnId: turn.providerTurnId,
                  settleTimeoutMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
                  quarantined: state.quarantined,
                },
              );
              yield* finalizeTurn(
                state,
                turn,
                "interrupted",
                state.quarantined ? { threadDisposition: "broken" } : undefined,
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    driver: OPENCODE2_PROVIDER,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.gen(function* () {
              const pending = pendingRequests.get(String(requestInput.requestId));
              if (pending === undefined) {
                return yield* protocolError(
                  `No pending OpenCode 2 request ${requestInput.requestId}`,
                );
              }
              const sessionID = pending.nativeSessionId;
              const requestID = pending.nativeRequestId;
              if (pending.questions !== undefined) {
                if (requestInput.answers === undefined) {
                  return yield* protocolError(
                    `OpenCode 2 question request ${requestInput.requestId} requires answers`,
                  );
                }
                const answers = pending.questions.map((question, index) => {
                  const raw =
                    requestInput.answers?.[openCode2QuestionId(index, question.header)] ??
                    requestInput.answers?.[question.header] ??
                    requestInput.answers?.[question.question];
                  if (Array.isArray(raw)) {
                    return raw.filter((value): value is string => typeof value === "string");
                  }
                  if (typeof raw === "string") return raw.trim().length > 0 ? [raw] : [];
                  return [];
                });
                if (pending.formFieldKeys !== undefined) {
                  const answer = openCode2FormAnswer(
                    pending.formFieldKeys,
                    answers,
                    pending.formOptionValues,
                    pending.questions.map((question) => question.multiple === true),
                  );
                  yield* respondWithRuntimeRequestSettlement(
                    pending,
                    {
                      requestStatus: "resolved",
                      itemStatus: "completed",
                      rememberPermissionForSession: false,
                    },
                    sdkCall("session.form.reply", { sessionID, formID: requestID, answer }, () =>
                      client.form.reply({
                        sessionID,
                        formID: requestID,
                        answer,
                      }),
                    ),
                  );
                  return;
                }
                yield* respondWithRuntimeRequestSettlement(
                  pending,
                  {
                    requestStatus: "resolved",
                    itemStatus: "completed",
                    rememberPermissionForSession: false,
                  },
                  sdkCall("session.question.reply", { sessionID, requestID, answers }, () =>
                    client.form.reply({
                      sessionID,
                      formID: requestID,
                      answer: Object.fromEntries(
                        answers.map((answer, index) => [`${index}`, answer]),
                      ),
                    }),
                  ),
                );
                return;
              }
              if (requestInput.decision === undefined) {
                return yield* protocolError(
                  `OpenCode 2 approval request ${requestInput.requestId} requires a decision`,
                );
              }
              const reply =
                requestInput.decision === "accept" || requestInput.decision === "acceptForSession"
                  ? ("once" as const)
                  : ("reject" as const);
              yield* respondWithRuntimeRequestSettlement(
                pending,
                openCode2RuntimeRequestResponseSettlement(requestInput.decision),
                sdkCall("session.permission.reply", { sessionID, requestID, reply }, () =>
                  client.permission.reply({ sessionID, requestID, reply }),
                ),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRuntimeRequestResponseError({
                    driver: OPENCODE2_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
          readThreadSnapshot: (snapshotInput) =>
            readSnapshot(snapshotInput.providerThread).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterReadThreadSnapshotError({
                    driver: OPENCODE2_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          rollbackThread: (rollbackInput) =>
            Effect.gen(function* () {
              const sessionID = nativeThreadId(rollbackInput.providerThread);
              const state = threads.get(sessionID);
              if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
                return yield* protocolError(
                  `Cannot roll back OpenCode 2 thread ${rollbackInput.providerThread.id} while a turn is active`,
                );
              }
              const response = yield* sdkCall("message.list", { sessionID }, () =>
                client.message.list({ sessionID }),
              );
              const nativeMessages = yield* unwrapOpenCode2Data<Array<SessionMessageInfo>>(
                "message.list",
                response,
              );
              let boundaryMessageId: string | undefined;
              if (rollbackInput.target.type === "thread_start") {
                boundaryMessageId = nativeMessages.find((info) => info.type === "user")?.id;
              } else {
                boundaryMessageId = openCodeBoundaryAfterProviderTurn(
                  rollbackInput.providerThreadTurns,
                  rollbackInput.target.providerTurn.id,
                );
              }
              if (boundaryMessageId !== undefined) {
                // Stage then commit: 2.x split 1.x's single `session.revert`
                // into a reversible boundary plus an explicit commit.
                yield* sdkCall(
                  "session.revert.stage",
                  { sessionID, messageID: boundaryMessageId, files: true },
                  () =>
                    client.session.revert.stage({
                      sessionID,
                      messageID: boundaryMessageId!,
                      files: true,
                    }),
                );
                yield* sdkCall("session.revert.commit", { sessionID }, () =>
                  client.session.revert.commit({ sessionID }),
                );
              }
              const snapshot = yield* readSnapshot(rollbackInput.providerThread);
              return {
                ...snapshot,
                providerThread: {
                  ...snapshot.providerThread,
                  nativeConversationHeadRef:
                    rollbackInput.target.type === "provider_turn"
                      ? rollbackInput.target.providerTurn.nativeTurnRef
                      : null,
                },
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRollbackThreadError({
                    driver: OPENCODE2_PROVIDER,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
              ),
            ),
          forkThread: (forkInput) =>
            Effect.gen(function* () {
              const sessionID = nativeThreadId(forkInput.sourceProviderThread);
              const sourceState = threads.get(sessionID);
              if (sourceState?.activeTurn !== null && sourceState?.activeTurn !== undefined) {
                return yield* protocolError(
                  `Cannot fork OpenCode 2 thread ${forkInput.sourceProviderThread.id} while a turn is active`,
                );
              }
              let boundaryMessageId: string | undefined;
              if (forkInput.providerTurnId !== undefined) {
                const sourceTurns = forkInput.sourceProviderTurns ?? [];
                const selected = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
                if (selected === undefined) {
                  return yield* protocolError(
                    `OpenCode 2 fork boundary turn ${forkInput.providerTurnId} was not found`,
                  );
                }
                boundaryMessageId = openCodeBoundaryAfterProviderTurn(sourceTurns, selected.id);
              }
              const parameters = openCode2ForkParameters(sessionID, boundaryMessageId);
              // Prefer a typed/mock session.fork when present (replay testkit);
              // production Session3 has none, so post the boundary body raw.
              const response = yield* sdkCall("session.fork", parameters, () =>
                postSessionFork(parameters),
              );
              const nativeSession = yield* unwrapOpenCode2Data<SessionInfoV2>(
                "session.fork",
                response,
              );
              yield* installT3OrchestrationInstructions(nativeSession.id);
              const forkedAt = yield* DateTime.now;
              const providerThread = makeProviderThread({
                idAllocator,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: forkInput.targetThreadId,
                ...(forkInput.ownerNodeId === undefined
                  ? {}
                  : { ownerNodeId: forkInput.ownerNodeId }),
                nativeSession,
                forkedFrom: {
                  providerThreadId: forkInput.sourceProviderThread.id,
                  ...(forkInput.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: forkInput.providerTurnId }),
                },
                now: forkedAt,
              });
              registerThread(nativeSession, providerThread);
              return providerThread;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterForkThreadError({
                    driver: OPENCODE2_PROVIDER,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
        };

        return runtimeSession;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: OPENCODE2_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
}

export type OpenCode2AdapterV2DriverEnv =
  | OpenCode2Runtime
  | IdAllocatorV2
  | ProviderEventLoggers
  | ServerConfig;

export const OpenCode2AdapterV2Driver: ProviderAdapterDriver<
  OpenCode2Settings,
  OpenCode2AdapterV2DriverEnv
> = {
  driverKind: OPENCODE2_DRIVER_KIND,
  configSchema: OpenCode2SettingsSchema,
  defaultConfig: (): OpenCode2Settings => DEFAULT_OPENCODE2_SETTINGS,
  create: Effect.fn("OpenCode2AdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OpenCode2Settings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const openCode2Runtime = yield* OpenCode2Runtime;
      const idAllocator = yield* IdAllocatorV2;
      const continuationRequests = yield* ProviderContinuationRequests;
      const interactionModeReflections = yield* ProviderInteractionModeReflections;
      const providerEventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const environment = yield* Effect.try({
        try: () =>
          applyOpenCode2ProviderEnvironment(
            input.config,
            mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
            input.instanceId,
            serverConfig.stateDir,
          ),
        catch: (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: OPENCODE2_DRIVER_KIND,
            instanceId: input.instanceId,
            detail: "Failed to prepare private OpenCode 2 provider state.",
            cause,
          }),
      });
      return makeOpenCode2AdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment,
        runtime: openCode2Runtime,
        idAllocator,
        serverConfig,
        continuationRequests,
        interactionModeReflections,
        ...(providerEventLoggers.native === undefined
          ? {}
          : { nativeEventLogger: providerEventLoggers.native }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OPENCODE2_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create OpenCode 2 v2 adapter.",
              cause,
            }),
        ),
      ),
  ),
};
