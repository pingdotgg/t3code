/**
 * OpenCode 2.x ("OpenCode 2") orchestration adapter.
 *
 * A separate adapter rather than a mode of `OpenCodeAdapterV2`: 2.x shares the
 * vendor name and the tool vocabulary with 1.x and nothing else. Concretely,
 *
 *   - the wire surface is `/api/*` only, reached through `client.v2.*`;
 *   - every response is double-wrapped, `{ data: { data: … } }`, because the
 *     SDK's own `.data` is the parsed body and the body carries its own
 *     envelope;
 *   - the event vocabulary is a flat stream of typed lifecycle events
 *     (`session.next.*` steps, tools, text) rather than 1.x's
 *     `message.part.updated` carrying a whole part object;
 *   - the model binds at session create via `ModelRef`, not per prompt;
 *   - permission asks can still arrive under the legacy `permission.asked`
 *     name, but replies always use the `/api` session-scoped
 *     `client.v2.session.*` routes. Self-spawned full-access servers also get
 *     `permission: "allow"` injected into `OPENCODE_CONFIG_CONTENT` at spawn.
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
import type {
  AgentV2Info,
  ModelV2Info,
  PromptInputFileAttachment,
  QuestionV2Info,
  SessionMessage,
  SessionV2Info,
  V2Event,
} from "@opencode-ai/sdk-next/v2";
import {
  normalizeOpenCode2WireType,
  openCode2StepFinishSettlesTurn,
  openCode2WireCallID,
  openCode2WireCreatedMs,
  openCode2WireData,
  openCode2WireSessionID,
  openCode2WireToolName,
  unwrapOpenCode2Payload,
} from "./openCode2Wire.ts";

/** Local shims for types dropped or renamed in the beta SDK generation. */
type AgentInfoV2 = AgentV2Info;
type ModelInfo = ModelV2Info;
type SessionInfoV2 = SessionV2Info;
type SessionMessageInfo = SessionMessage;
type SessionPendingInfo = {
  readonly sessionID: string;
  readonly type?: string;
  readonly id?: string;
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
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
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
import {
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
} from "../../provider/opencodeRuntime.ts";
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
export const OPENCODE2_EVENT_RESUBSCRIBE_DELAY_MS = 250;
/** Bound Stop so a wedged `session.interrupt` HTTP call cannot hang the UI. */
export const OPENCODE2_INTERRUPT_REQUEST_TIMEOUT_MS = 5_000;
/**
 * After interrupt is requested, wait this long for SSE
 * `session.execution.interrupted` before force-finalizing the turn. Cursor uses
 * the same pattern; without it a dead event stream leaves Stop inert.
 */
export const OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;
export const OPENCODE2_INTERRUPT_SETTLE_POLL_MS = 100;
const DEFAULT_OPENCODE2_SETTINGS = Schema.decodeSync(OpenCode2SettingsSchema)({});
const OPENCODE2_T3_MCP_NAME = "t3-code";
const OPENCODE2_T3_INSTRUCTION_KEY = "t3-code.orchestration";
const OpenCode2InlineConfig = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const OpenCode2McpConfig = Schema.Record(Schema.String, Schema.Unknown);
const decodeOpenCode2InlineConfig = Schema.decodeUnknownEffect(OpenCode2InlineConfig);
const decodeOpenCode2McpConfig = Schema.decodeUnknownEffect(OpenCode2McpConfig);
const encodeOpenCode2InlineConfig = Schema.encodeEffect(OpenCode2InlineConfig);

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
  providerRetry: OpenCode2ProviderRetry | null;
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
}

type OpenCode2PostSettleWakeDisposition = "replay" | "suppress";
type OpenCode2PostSettleWakePhase = "pending" | "executing" | "ready";

interface OpenCode2ExecutionOwnership {
  readonly inputIds: Set<string>;
  claimedByPromotion: boolean;
}

interface OpenCode2EventHandlingContext {
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
  activeExecution: OpenCode2ExecutionOwnership | null;
  parentSubagent: OpenCode2SubagentContext | null;
  nextChildTurnOrdinal: number;
}

interface PendingOpenCode2Request {
  readonly requestId: RuntimeRequestId;
  readonly nativeRequestId: string;
  readonly nativeSessionId: string;
  readonly turn: ActiveOpenCode2Turn;
  readonly state: OpenCode2ThreadState;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
  readonly createdAt: DateTime.Utc;
  readonly permission?: {
    readonly action: string;
    readonly resources: ReadonlyArray<string>;
    readonly save: ReadonlyArray<string>;
  };
  readonly questions?: ReadonlyArray<QuestionV2Info>;
}

export interface OpenCode2SessionPermission {
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
}

export type OpenCode2SessionPermissionStore = Map<string, Array<OpenCode2SessionPermission>>;

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
  const payload = event?.data ?? {};
  const input = payload.input ?? payload.prompt;
  if (input === undefined || input === null) return false;
  if (
    typeof input === "object" &&
    "type" in input &&
    input.type !== undefined &&
    input.type !== "synthetic"
  ) {
    return false;
  }
  const data = recordValue(input, "data") ?? input;
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
  const payload = event?.data ?? {};
  const input = payload.input ?? payload.prompt;
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

export function openCode2EventEndsExecution(event: { readonly type: string }): boolean {
  const type = normalizeOpenCode2WireType(event.type);
  return (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.idle"
  );
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
  return !input.sessionAborted && input.hasActiveTurn && input.lastEventAgeMs >= input.stallMs;
}

export const openCode2PendingWorkForSession = Effect.fnUntraced(function* (input: {
  readonly sessionID: string;
  readonly pending: Effect.Effect<ReadonlyArray<SessionPendingInfo>, OpenCode2RuntimeError>;
  readonly shells: Effect.Effect<ReadonlyArray<ShellInfoV2>, OpenCode2RuntimeError>;
}) {
  const pending = yield* input.pending;
  if (pending.some((item) => item.sessionID === input.sessionID)) {
    return true;
  }
  const shells = yield* input.shells;
  return shells.some(
    (shell) => shell.status === "running" && shell.metadata.sessionID === input.sessionID,
  );
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
  error?: { name?: string; message?: string; type?: string; data?: { message?: string } };
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

export function openCode2SessionErrorStatus(
  data: OpenCode2SessionErrorData,
  interrupted: boolean,
): TerminalTurnStatus {
  return interrupted || data.error?.name === "MessageAbortedError" ? "interrupted" : "failed";
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
 * old shape is rejected with 400 `Missing key at ["boundary"]`. The pinned SDK
 * (next-16233, still npm's `next` tag) predates the change and only maps
 * `messageID` into the body, so this rides the generated client's `$body_`
 * escape hatch to place `boundary` there.
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
 * Add T3's per-thread MCP server to a spawned OpenCode 2 process without
 * writing the user's global or project configuration.
 *
 * @internal exported for tests
 */
export const openCode2EnvironmentWithT3Mcp = Effect.fn(
  "OpenCode2AdapterV2.openCode2EnvironmentWithT3Mcp",
)(function* (environment: NodeJS.ProcessEnv, session: McpProviderSession.McpProviderSessionConfig) {
  const config = yield* decodeOpenCode2InlineConfig(environment.OPENCODE_CONFIG_CONTENT || "{}");
  const mcp = yield* decodeOpenCode2McpConfig(config.mcp ?? {});
  const content = yield* encodeOpenCode2InlineConfig({
    ...config,
    mcp: {
      ...mcp,
      [OPENCODE2_T3_MCP_NAME]: {
        type: "remote",
        url: session.endpoint,
        headers: { Authorization: session.authorizationHeader },
        oauth: false,
      },
    },
  });
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: content,
  } satisfies NodeJS.ProcessEnv;
});

/**
 * Give a self-spawned full-access OpenCode 2 server its fixed startup policy.
 *
 * @internal exported for tests
 */
export const openCode2EnvironmentWithPermission = Effect.fn(
  "OpenCode2AdapterV2.openCode2EnvironmentWithPermission",
)(function* (
  environment: NodeJS.ProcessEnv,
  runtimePolicy: ProviderAdapterV2TurnInput["runtimePolicy"],
) {
  if (!isOpenCodeAllowAllPolicy(runtimePolicy)) return environment;

  const config = yield* decodeOpenCode2InlineConfig(environment.OPENCODE_CONFIG_CONTENT || "{}");
  const content = yield* encodeOpenCode2InlineConfig({
    ...config,
    permission: "allow",
  });
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: content,
  } satisfies NodeJS.ProcessEnv;
});

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

function isOpenCodeAllowAllPolicy(
  runtimePolicy: ProviderAdapterV2TurnInput["runtimePolicy"],
): boolean {
  const rules = openCodePermissionRules(runtimePolicy);
  return (
    rules.length === 1 &&
    rules[0]?.permission === "*" &&
    rules[0].pattern === "*" &&
    rules[0].action === "allow"
  );
}

/** @internal exported for tests */
export function rememberOpenCode2SessionPermission(
  permissionsBySession: OpenCode2SessionPermissionStore,
  nativeSessionId: string,
  permission: PendingOpenCode2Request["permission"],
): void {
  if (permission === undefined) return;
  const permissions = permissionsBySession.get(nativeSessionId) ?? [];
  const savedResources = permission.save.length === 0 ? permission.resources : permission.save;
  const remembered = {
    action: permission.action,
    resources: savedResources.length === 0 ? ["*"] : savedResources,
  };
  if (
    permissions.some(
      (existing) =>
        existing.action === remembered.action &&
        existing.resources.length === remembered.resources.length &&
        existing.resources.every((resource, index) => resource === remembered.resources[index]),
    )
  ) {
    return;
  }
  permissions.push(remembered);
  permissionsBySession.set(nativeSessionId, permissions);
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
          runOpenCode2Sdk("session.interrupt", () =>
            client.v2.session.get({ sessionID }, { throwOnError: false }).then(async () => {
              // Beta Session3 has no remove(); best-effort interrupt then rely on GC.
              try {
                await client.v2.session.interrupt({ sessionID });
              } catch {
                /* ignore */
              }
              return { data: { data: true } };
            }),
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
        const environmentWithMcp =
          hasT3Mcp && mcpSession !== undefined
            ? yield* openCode2EnvironmentWithT3Mcp(options.environment, mcpSession)
            : options.environment;
        // The injected policy is fixed at spawn, like 1.x's session.create
        // ruleset. A stricter mid-thread turn does not re-gate asks suppressed
        // by allow-all until the provider session is reopened.
        const injectedAllowPolicy = selfSpawning && isOpenCodeAllowAllPolicy(input.runtimePolicy);
        const environment = injectedAllowPolicy
          ? yield* openCode2EnvironmentWithPermission(environmentWithMcp, input.runtimePolicy)
          : environmentWithMcp;
        const connection = yield* runtime.connectToOpenCode2Server({
          binaryPath: options.settings.binaryPath,
          serverUrl: options.settings.serverUrl,
          serverPassword: options.settings.serverPassword,
          environment,
        });
        const spawnedWithInjectedAllowPolicy = injectedAllowPolicy && !connection.external;
        let warnedAboutInjectedAllowPolicy = false;
        const client = runtime.createOpenCode2SdkClient({
          baseUrl: connection.url,
          directory: cwd,
          serverPassword: connection.password,
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
        const pendingRequests = new Map<string, PendingOpenCode2Request>();
        const pendingRequestsByNativeId = new Map<string, PendingOpenCode2Request>();
        const subagentsByNativeItemId = new Map<string, OpenCode2SubagentContext>();
        const subagentsByChildSessionId = new Map<string, OpenCode2SubagentContext>();
        const nativeChildSessions = new Map<
          string,
          Extract<V2Event, { type: "session.created" }>["data"]["info"]
        >();
        const sessionPermissions: OpenCode2SessionPermissionStore = new Map();
        const abortController = new AbortController();
        // Liveness marker for SSE pull. OpenCode 2 fails a slow event consumer;
        // if pull stalls while a turn is active we resubscribe.
        let lastEventAtMs = 0;
        let consecutiveStreamFailures = 0;
        let consecutiveStallResubscribes = 0;
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

        const updateProviderSession = (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = sessionEntity.lastError,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
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
          nativeSession: Extract<V2Event, { type: "session.created" }>["data"]["info"],
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
            activeExecution: null,
            parentSubagent: context,
            nextChildTurnOrdinal: 1,
          });
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
            const matchingChild = Array.from(nativeChildSessions.values()).find(
              (candidate) =>
                candidate.parentID === state.nativeSessionId &&
                !subagentsByChildSessionId.has(candidate.id) &&
                (context.title === null || candidate.title === context.title),
            );
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
          if (part.name.toLowerCase() === "subagent") {
            yield* emitSubagent(state, turn, part, terminal);
            return;
          }
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
            turnItem = {
              ...base,
              type: "dynamic_tool",
              toolName: part.name,
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
            },
          });
        });

        const runningShellForPart = (
          turn: ActiveOpenCode2Turn,
          part: OpenCode2ToolPart,
        ): OpenCode2ShellProjection | undefined =>
          Array.from(shellProjections.values()).find(
            (shell) => shell.turn === turn && shell.part === part && shell.status === "running",
          );

        const runtimeRequestTurnItem = (
          pending: PendingOpenCode2Request,
          status: OrchestrationV2TurnItem["status"],
          completedAt: DateTime.Utc | null,
          updatedAt: DateTime.Utc,
        ): OrchestrationV2TurnItem => {
          const base = {
            id: pending.turnItemId,
            threadId: pending.turn.threadId,
            runId: pending.turn.runId,
            nodeId: pending.nodeId,
            providerThreadId: pending.state.providerThread.id,
            providerTurnId: pending.turn.providerTurnId,
            nativeItemRef: providerRef(pending.nativeRequestId),
            parentItemId: null,
            ordinal: itemOrdinal(pending.turn, pending.nativeRequestId),
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
              },
        ) {
          if (pendingRequestsByNativeId.has(nativeRequestId)) return;
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
          const pendingBase = {
            requestId,
            nativeRequestId,
            nativeSessionId,
            turn,
            state,
            nodeId,
            turnItemId,
            requestKind,
            createdAt,
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
            };
          }
          pendingRequests.set(String(requestId), pending);
          pendingRequestsByNativeId.set(nativeRequestId, pending);
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
              nativeItemRef: providerRef(nativeRequestId),
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

        const resolveRuntimeRequest = Effect.fnUntraced(function* (
          nativeRequestId: string,
          status: "resolved" | "cancelled",
        ) {
          const pending = pendingRequestsByNativeId.get(nativeRequestId);
          if (pending === undefined) return;
          const resolvedAt = yield* DateTime.now;
          const current = pending.state.runtimeRequests.get(String(pending.requestId));
          if (current !== undefined) {
            const resolved: OrchestrationV2RuntimeRequest = { ...current, status, resolvedAt };
            pending.state.runtimeRequests.set(String(pending.requestId), resolved);
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: OPENCODE2_PROVIDER,
              threadId: pending.turn.threadId,
              runtimeRequest: resolved,
            });
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE2_PROVIDER,
            node: {
              id: pending.nodeId,
              threadId: pending.turn.threadId,
              runId: pending.turn.runId,
              parentNodeId: pending.turn.rootNodeId,
              rootNodeId: pending.turn.rootNodeId,
              kind: pending.questions === undefined ? "approval_request" : "user_input_request",
              status: status === "resolved" ? "completed" : "cancelled",
              countsForRun: false,
              providerThreadId: pending.state.providerThread.id,
              providerTurnId: pending.turn.providerTurnId,
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
              status === "resolved" ? "completed" : "cancelled",
              resolvedAt,
              resolvedAt,
            ),
          });
          pendingRequests.delete(String(pending.requestId));
          pendingRequestsByNativeId.delete(nativeRequestId);
          if (pendingRequests.size === 0) yield* updateProviderSession("running", null);
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
          if (turn.finalized) return;
          turn.finalized = true;
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
            if (pending.turn.providerTurnId === turn.providerTurnId) {
              yield* resolveRuntimeRequest(pending.nativeRequestId, "cancelled");
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
            return;
          }
          const anotherTurnIsActive = Array.from(threads.values()).some(
            (candidate) => candidate.activeTurn?.isRoot === true,
          );
          let providerSessionStatus: OrchestrationV2ProviderSession["status"] = "ready";
          if (anotherTurnIsActive) {
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
            providerRetry: null,
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
              Promise.resolve({
                data: { data: { output: "", cursor: 0, size: 0, truncated: false } },
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
          for (const projection of running) {
            const parameters = {
              id: projection.shellId,
              location: projection.location,
            };
            yield* sdkCall("shell.remove", parameters, () =>
              Promise.resolve({ data: { data: true } }),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to stop an interrupted OpenCode 2 shell.", {
                  errorTag: causeErrorTag(cause),
                  provider: OPENCODE2_PROVIDER,
                  shellId: projection.shellId,
                }),
              ),
            );
          }
        });

        const autoReplyPermission = Effect.fnUntraced(function* (
          sessionID: string,
          requestID: string,
          reply: "once" | "reject",
        ) {
          return yield* sdkCall("session.permission.reply", { sessionID, requestID, reply }, () =>
            client.v2.session.permission.reply({ sessionID, requestID, reply }),
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
        });

        const failActiveTurns = Effect.fnUntraced(function* (
          detail: string,
          failureClass: "transport_error" | "provider_error",
        ) {
          yield* updateProviderSession("error", detail);
          for (const state of threads.values()) {
            if (state.activeTurn !== null) {
              yield* finalizeTurn(state, state.activeTurn, "failed", {
                failure: makeProviderFailure({ message: detail, class: failureClass }),
                threadDisposition: "broken",
              });
            }
          }
        });

        const offerPostSettleWake = Effect.fnUntraced(function* (
          state: OpenCode2ThreadState,
          event: any,
          suppressContinuation: boolean,
        ) {
          const wake: OpenCode2PostSettleWake = {
            inputId: event.data.inputID,
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
          yield* continuationRequests.offer({
            threadId: state.appThread.id,
            providerThreadId: state.providerThread.id,
            driver: OPENCODE2_PROVIDER,
            detail:
              event.data.input.type === "synthetic"
                ? (event.data.input.data.description ?? null)
                : null,
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

          // OpenCode's promoted event is the authoritative input-to-execution
          // boundary. Older clients omitted it, so the bounded fallback gives
          // a known ordinary input priority. If there is no ordinary input and
          // promotion has not identified an owner, every pending wake owns the
          // execution for buffering purposes: swallowing unattributable output
          // is safer than allowing it into the active visible turn.
          const fallbackInputIds =
            activeInputId !== null && activeInputId !== undefined ? [activeInputId] : wakeInputIds;
          const ownership =
            promotedOwners.length > 0
              ? { inputIds: new Set(promotedOwners), claimedByPromotion: true }
              : { inputIds: new Set(fallbackInputIds), claimedByPromotion: false };
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

        const eventSessionId = (event: any): string | undefined => {
          const directSessionId = recordString(event.data, "sessionID");
          if (directSessionId !== undefined) return directSessionId;

          const formSessionId = recordString(recordValue(event.data, "form"), "sessionID");
          if (formSessionId !== undefined) return formSessionId;

          const info = recordValue(event.data, "info");
          const shellSessionId = recordString(recordValue(info, "metadata"), "sessionID");
          if (shellSessionId !== undefined) return shellSessionId;

          const nativeId = recordString(event.data, "requestID", "id");
          if (nativeId === undefined) return undefined;
          return (
            shellSessionIds.get(nativeId) ??
            pendingRequestsByNativeId.get(nativeId)?.nativeSessionId
          );
        };

        const bufferPostSettleWakeEvent = (event: any, isReplay: boolean): boolean => {
          const sessionID = eventSessionId(event);
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
          yield* logProtocolEvent({
            direction: "incoming",
            messageKind: "notification",
            method: wire.type,
            payload: event,
          });
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
          const eventSessionId =
            openCode2WireSessionID(wire) ?? recordString(event.data, "sessionID");
          const eventState =
            admittedState ??
            (eventSessionId === undefined ? undefined : threads.get(eventSessionId));
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
              const nativeSession = event.data.info;
              nativeChildSessions.set(nativeSession.id, nativeSession);
              if (nativeSession.parentID === undefined) return;
              const parentState = threads.get(nativeSession.parentID);
              if (parentState === undefined) return;
              const candidates = Array.from(subagentsByNativeItemId.values()).filter(
                (context) =>
                  context.parentState === parentState &&
                  context.childSessionId === null &&
                  !subagentsByChildSessionId.has(nativeSession.id),
              );
              const context =
                candidates.find(
                  (candidate) =>
                    candidate.title !== null && candidate.title === nativeSession.title,
                ) ?? candidates[0];
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
              yield* registerShellProjection(state, event.data.shell);
              yield* updateProviderThread(state, {});
              return;
            }
            case "session.shell.ended": {
              yield* completeShellProjection(event.data.shell.id, {
                status: event.data.shell.status,
                ...(event.data.shell.exit === undefined ? {} : { exit: event.data.shell.exit }),
                output: event.data.output,
              });
              shellProjections.delete(event.data.shell.id);
              shellSessionIds.delete(event.data.shell.id);
              const state = threads.get(event.data.sessionID);
              if (state !== undefined) yield* updateProviderThread(state, {});
              return;
            }
            case "shell.created": {
              const sessionID = recordString(event.data.info.metadata, "sessionID");
              if (sessionID === undefined) return;
              shellSessionIds.set(event.data.info.id, sessionID);
              const state = threads.get(sessionID);
              if (state !== undefined) {
                yield* registerShellProjection(state, event.data.info);
                yield* updateProviderThread(state, {});
              }
              return;
            }
            case "shell.exited": {
              yield* completeShellProjection(event.data.id, {
                status: event.data.status,
                ...(event.data.exit === undefined ? {} : { exit: event.data.exit }),
              });
              const sessionID = shellSessionIds.get(event.data.id);
              shellProjections.delete(event.data.id);
              shellSessionIds.delete(event.data.id);
              if (sessionID === undefined) return;
              const state = threads.get(sessionID);
              if (state !== undefined) yield* updateProviderThread(state, {});
              return;
            }
            case "shell.deleted": {
              const sessionID = shellSessionIds.get(event.data.id);
              if (sessionID === undefined) return;
              const projection = shellProjections.get(event.data.id);
              if (projection !== undefined && projection.turn.finalized) {
                yield* completeShellProjection(event.data.id, { status: "killed" });
              }
              shellProjections.delete(event.data.id);
              shellSessionIds.delete(event.data.id);
              const state = threads.get(sessionID);
              if (state !== undefined) yield* updateProviderThread(state, {});
              return;
            }
            case "session.input.admitted": {
              const state = threads.get(event.data.sessionID);
              if (
                state !== undefined &&
                state.activeTurn === null &&
                state.parentSubagent !== null
              ) {
                yield* createChildTurn(state, event.data.inputID);
              }
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              if (active.turn.nativeInputId === null) {
                active.turn.nativeInputId = event.data.inputID;
                yield* emitProviderTurn(active.state, active.turn, "running", null);
              }
              const rootInputId = active.turn.nativeInputId;
              const activeExecution = active.state.activeExecution;
              if (
                !isReplay &&
                rootInputId !== null &&
                activeExecution !== null &&
                !activeExecution.claimedByPromotion &&
                !activeExecution.inputIds.has(rootInputId) &&
                activeExecution.inputIds.size === 0 &&
                (active.turn.isRoot || active.state.postSettleWakes.length === 0)
              ) {
                const previousOwnerInputIds = new Set(activeExecution.inputIds);
                // `session.execution.started` has only a session id. A
                // promoted owner wins this boundary. Otherwise the ordinary
                // admission claims the execution here, including when the
                // fallback temporarily held pending wake ids. A later
                // retired promotion joins the same boundary and remains
                // suppressed. OpenCode cannot tell these orderings apart
                // without an execution id, so this is the smallest
                // deterministic policy.
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
              const nativeItemId = String(event.data.inputID ?? event.id ?? "");
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
                      startedAt: dateTimeFromEpoch(openCode2WireCreatedMs(wire) ?? 0, now),
                      summary: "",
                      status: "running",
                      completedAt: null,
                    };
              compaction.status = "running";
              compaction.completedAt = null;
              active.turn.activeCompaction = compaction;
              yield* emitCompaction(active.state, active.turn, compaction);
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
                  startedAt: dateTimeFromEpoch(openCode2WireCreatedMs(wire) ?? 0, now),
                  summary: "",
                  status: "running",
                  completedAt: null,
                } satisfies OpenCode2Compaction);
              compaction.summary += event.data.text;
              if (compaction !== null)
                active.turn.activeCompaction = compaction as OpenCode2Compaction;
              yield* emitCompaction(active.state, active.turn, compaction as OpenCode2Compaction);
              return;
            }
            case "session.compaction.ended": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const now = yield* DateTime.now;
              const compaction =
                active.turn.activeCompaction ??
                ({
                  id: event.id,
                  startedAt: dateTimeFromEpoch(openCode2WireCreatedMs(wire) ?? 0, now),
                  summary: "",
                  status: "running",
                  completedAt: null,
                } satisfies OpenCode2Compaction);
              compaction.summary = event.data.text;
              compaction.status = "completed";
              compaction.completedAt = dateTimeFromEpoch(openCode2WireCreatedMs(wire) ?? 0, now);
              if (compaction !== null)
                active.turn.activeCompaction = compaction as OpenCode2Compaction;
              yield* emitCompaction(active.state, active.turn, compaction as OpenCode2Compaction);
              return;
            }
            case "session.tool.input.started": {
              const active = activeFor(openCode2WireSessionID(wire) ?? event.data?.sessionID);
              if (active === null) return;
              const callID = openCode2WireCallID(wire) ?? event.data?.callID;
              if (callID === undefined) return;
              yield* upsertToolPart(active.state, active.turn, callID, {
                name: openCode2WireToolName(wire) ?? event.data?.name ?? event.data?.tool ?? "tool",
                status: "pending",
              });
              return;
            }
            case "session.tool.input.delta": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              yield* upsertToolPart(active.state, active.turn, event.data.callID, {
                inputDelta: event.data.delta,
              });
              return;
            }
            case "session.tool.called": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              yield* upsertToolPart(active.state, active.turn, event.data.callID, {
                input: event.data.input,
                status: "running",
              });
              return;
            }
            case "session.tool.progress": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const output = toolContentText(event.data.content);
              yield* upsertToolPart(active.state, active.turn, event.data.callID, {
                ...(output === undefined ? {} : { output }),
                structured: event.data.structured,
                status: "running",
              });
              return;
            }
            case "session.tool.success": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const output = toolContentText(event.data.content);
              yield* upsertToolPart(active.state, active.turn, event.data.callID, {
                ...(output === undefined ? {} : { output }),
                structured: event.data.structured,
                status: "completed",
              });
              return;
            }
            case "session.tool.failed": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              yield* upsertToolPart(active.state, active.turn, event.data.callID, {
                output: event.data.error.message,
                errorMessage: event.data.error.message,
                status: "error",
              });
              return;
            }
            case "session.retry.scheduled": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const now = yield* DateTime.now;
              const retry: OrchestrationV2ProviderRetry = {
                attempt: Math.max(1, Math.floor(event.data.attempt)),
                maxAttempts: null,
                retryDelayMs: Math.max(
                  0,
                  Math.floor(
                    (typeof event.data.at === "number"
                      ? event.data.at
                      : (openCode2WireCreatedMs(wire) ?? DateTime.toEpochMillis(now))) -
                      DateTime.toEpochMillis(now),
                  ),
                ),
              };
              const failure = makeProviderFailure({
                message: event.data.error.message,
                code: event.data.error.type,
                class: "provider_error",
                retryable: true,
              });
              active.turn.providerRetry = {
                retry,
                failure,
                startedAt:
                  active.turn.providerRetry?.startedAt ??
                  dateTimeFromEpoch(openCode2WireCreatedMs(wire) ?? 0, now),
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
              if (autoReply !== null) {
                const replied = yield* autoReplyPermission(
                  event.data.sessionID,
                  event.data.id,
                  autoReply,
                );
                if (replied) return;
              }
              const projection = runtimeRequestProjectionFor(active);
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
                event.data.sessionID,
                event.data.id,
                {
                  type: "permission",
                  ...permission,
                },
              );
              return;
            }
            case "permission.v2.replied":
              yield* resolveRuntimeRequest(event.data.requestID, "resolved");
              return;
            case "question.v2.asked": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const projection = runtimeRequestProjectionFor(active);
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
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
              yield* resolveRuntimeRequest(event.data.requestID, "resolved");
              return;
            case "question.v2.rejected":
              yield* resolveRuntimeRequest(event.data.requestID, "cancelled");
              return;
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
              if (autoReply !== null) {
                const replied = yield* autoReplyPermission(
                  event.data.sessionID,
                  event.data.id,
                  autoReply,
                );
                if (replied) return;
              }
              const projection = runtimeRequestProjectionFor(active);
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
                event.data.sessionID,
                event.data.id,
                {
                  type: "permission",
                  ...permission,
                },
              );
              return;
            }
            case "permission.replied":
              yield* resolveRuntimeRequest(event.data.requestID, "resolved");
              return;
            case "question.asked": {
              const active = activeFor(event.data.sessionID);
              if (active === null) return;
              const projection = runtimeRequestProjectionFor(active);
              yield* emitRuntimeRequest(
                projection.state,
                projection.turn,
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
              yield* resolveRuntimeRequest(event.data.requestID, "resolved");
              return;
            case "question.rejected":
              yield* resolveRuntimeRequest(event.data.requestID, "cancelled");
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
              if (!isReplay) active.state.activeExecution = null;
              return;
            }
            case "session.execution.failed": {
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
              const message = event.data.error.message;
              if (active.turn.isRoot) yield* updateProviderSession("error", message);
              yield* finalizeTurn(active.state, active.turn, "failed", {
                failure: makeProviderFailure({
                  message,
                  code: event.data.error.type,
                  class: "provider_error",
                  retryable: active.turn.providerRetry === null ? null : true,
                }),
              });
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
                .filter((state) => state.activeTurn !== null && !state.activeTurn.finalized)
                .map((state) => state.nativeSessionId);
              const targetSessionIDs = openCode2SessionErrorTargetSessionIds(
                event.data.sessionID,
                activeSessionIDs,
              );
              const message = openCode2SessionErrorMessage(event.data);
              const isAbort = event.data.error?.name === "MessageAbortedError";
              const targetsRoot =
                event.data.sessionID === undefined ||
                targetSessionIDs.some(
                  (sessionID) => threads.get(sessionID)?.parentSubagent === null,
                );
              if (!isAbort && targetsRoot) yield* updateProviderSession("error", message);
              for (const sessionID of targetSessionIDs) {
                const active = activeFor(sessionID);
                if (active === null) continue;
                yield* finalizeTurn(
                  active.state,
                  active.turn,
                  openCode2SessionErrorStatus(event.data, active.turn.interrupted),
                  {
                    failure: makeProviderFailure({
                      message,
                      code: event.data.error?.name ?? null,
                      class: "provider_error",
                    }),
                    threadDisposition: event.data.sessionID === undefined ? "broken" : "reusable",
                  },
                );
              }
              // Finalizing one of several active turns temporarily marks the
              // shared provider session as running. Restore the unscoped
              // provider failure after every affected turn has closed.
              if (!isAbort && targetsRoot && targetSessionIDs.length > 1) {
                yield* updateProviderSession("error", message);
              }
              return;
            }
            default:
              return;
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
          client.v2.event.subscribe({ signal: firstStreamController.signal }),
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
                  }
                }),
              ),
            ),
            Stream.runForEach(handleEvent),
            Effect.exit,
          );

        // Resubscribe loop: `/api/event` is volatile (slow consumer overflows).
        // A single failed or hung pull must not leave active turns uninterruptible.
        yield* Effect.gen(function* () {
          let pendingStream: AsyncIterable<unknown> | null = firstSubscription.stream;
          let streamController = firstStreamController;
          let onSessionAbort = onFirstSessionAbort;

          while (!abortController.signal.aborted) {
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
                const now = yield* Clock.currentTimeMillis;
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
                if (consecutiveStallResubscribes >= OPENCODE2_EVENT_STALL_MAX_RESUBSCRIBES) {
                  yield* Effect.logError(
                    "OpenCode 2 event stream stall budget exhausted; failing active turns.",
                    {
                      provider: OPENCODE2_PROVIDER,
                      stallMs: lastEventAgeMs,
                      consecutiveStallResubscribes,
                    },
                  );
                  yield* failActiveTurns(
                    "OpenCode 2 event stream stalled and did not recover.",
                    "transport_error",
                  );
                  streamController.abort();
                  return;
                }
                consecutiveStallResubscribes += 1;
                yield* Effect.logWarning(
                  "OpenCode 2 event stream stalled while a turn is active; resubscribing.",
                  {
                    provider: OPENCODE2_PROVIDER,
                    stallMs: lastEventAgeMs,
                    consecutiveStallResubscribes,
                  },
                );
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
                client.v2.event.subscribe({ signal: streamController.signal }),
              );
              return yield* consumeEventStream(subscription.stream);
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

            if (Exit.isFailure(exit)) {
              consecutiveStreamFailures += 1;
              const failure = Cause.squash(exit.cause);
              yield* Effect.logWarning(
                "OpenCode 2 event subscription ended; will resubscribe when possible.",
                {
                  errorTag: causeErrorTag(exit.cause),
                  provider: OPENCODE2_PROVIDER,
                  consecutiveStreamFailures,
                },
              );
              if (
                consecutiveStreamFailures >= OPENCODE2_EVENT_STREAM_MAX_FAILURES &&
                hasActiveTurn
              ) {
                yield* failActiveTurns(openCodeRuntimeErrorDetail(failure), "transport_error");
                consecutiveStreamFailures = 0;
              }
            } else if (!hasActiveTurn) {
              // Clean EOF while idle: wait for session close rather than opening a
              // second subscribe. Replay fixtures end the stream this way; a live
              // idle session almost never EOFs cleanly, and the next openSession
              // creates a fresh adapter when needed.
              while (!abortController.signal.aborted) {
                yield* Effect.sleep("1 second");
              }
              return;
            }

            lastEventAtMs = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(`${OPENCODE2_EVENT_RESUBSCRIBE_DELAY_MS} millis`);
          }
        }).pipe(Effect.forkIn(scope));

        if (!connection.external && connection.exitCode !== null) {
          yield* connection.exitCode.pipe(
            Effect.flatMap((code) =>
              abortController.signal.aborted
                ? Effect.void
                : failActiveTurns(
                    `OpenCode 2 server exited unexpectedly (${code}).`,
                    "transport_error",
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
            activeExecution: null,
            parentSubagent: subagentsByChildSessionId.get(nativeSession.id) ?? null,
            nextChildTurnOrdinal: 1,
          };
          threads.set(nativeSession.id, state);
          return state;
        };

        /**
         * Catalog for `clampOpenCode2Variant`. Cached per provider session: it
         * only changes when the spawned server restarts. A fresh 2.x server
         * reports an empty catalog until bootstrap finishes, so an empty
         * result is used for the current call but never cached, and a failed
         * fetch is not cached either, so later turns retry. Only successful
         * non-empty fetches are stored, which also keeps a losing concurrent
         * fetch from clobbering a good cache.
         */
        let variantCatalog: ReadonlyMap<string, ReadonlySet<string>> | null = null;
        const readVariantCatalog = sdkCall("model.list", {}, () =>
          client.v2.model.list({ location: { directory: cwd } }),
        ).pipe(
          Effect.flatMap((response) =>
            unwrapOpenCode2Data<ReadonlyArray<ModelInfo>>("model.list", response).pipe(
              Effect.map((models) => {
                const catalog = new Map<string, ReadonlySet<string>>();
                for (const model of models) {
                  catalog.set(
                    `${model.providerID}/${model.id}`,
                    new Set(model.variants.map((entry) => entry.id)),
                  );
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

        let agentCatalog: ReadonlySet<string> | null = null;
        const knownAgentIDs = Effect.fnUntraced(function* () {
          if (agentCatalog !== null) return agentCatalog;
          const fetched = yield* sdkCall("agent.list", {}, () =>
            client.v2.agent.list({ location: { directory: cwd } }),
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
              client.v2.session.switchModel({ sessionID, model }),
            );
            state.boundModel = modelSelection.model;
            state.boundVariant = plan.variant ?? null;
          }
          const agent = selection.agent;
          if (agent !== undefined && state.boundAgent !== agent) {
            yield* sdkCall("session.switchAgent", { sessionID, agent }, () =>
              client.v2.session.switchAgent({ sessionID, agent }),
            );
            state.boundAgent = agent;
          }
        });

        // next-16916+ prompt body is flat `{ text, files?, delivery? }`. The
        // pinned beta SDK still types/maps a nested `prompt` field, which the
        // server rejects with `Missing key at ["text"]`. Post through the raw
        // hey-api client so the wire matches the running binary.
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
        }) => {
          const rawClient = (
            client as unknown as {
              client: {
                post: (options: Record<string, unknown>) => Promise<unknown>;
              };
            }
          ).client;
          return rawClient.post({
            url: "/api/session/{sessionID}/prompt",
            path: { sessionID: input.sessionID },
            body: {
              text: input.text,
              ...(input.files === undefined || input.files.length === 0
                ? {}
                : { files: input.files }),
              ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
            },
            headers: { "Content-Type": "application/json" },
            throwOnError: true,
          });
        };

        const readSnapshot = Effect.fnUntraced(function* (
          providerThread: OrchestrationV2ProviderThread,
        ) {
          const sessionID = nativeThreadId(providerThread);
          const response = yield* sdkCall("message.list", { sessionID }, () =>
            client.v2.session.messages({ sessionID }),
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
            pending: sdkCall("session.pending.list", { sessionID }, () => {
              const pendingList = (
                client.v2.session as {
                  pending?: { list: (input: { sessionID: string }) => Promise<unknown> };
                }
              ).pending?.list;
              if (pendingList === undefined) {
                return Promise.resolve({ data: { data: [] as Array<SessionPendingInfo> } });
              }
              return pendingList({ sessionID });
            }).pipe(
              Effect.flatMap((response) =>
                unwrapOpenCode2Data<Array<SessionPendingInfo>>("session.pending.list", response),
              ),
            ),
            shells: sdkCall("shell.list", { location: state.location }, () => {
              const shellList = (
                client.v2 as {
                  shell?: {
                    list: (input: { location: SessionInfoV2["location"] }) => Promise<unknown>;
                  };
                }
              ).shell?.list;
              if (shellList === undefined) {
                return Promise.resolve({ data: { data: [] as Array<ShellInfoV2> } });
              }
              return shellList({ location: state.location });
            }).pipe(
              Effect.flatMap((response) =>
                unwrapOpenCode2Data<Array<ShellInfoV2>>("shell.list", response),
              ),
              Effect.tap((shells) =>
                Effect.sync(() => {
                  for (const shell of shells) {
                    if (shell.metadata.sessionID === sessionID) {
                      shellSessionIds.set(shell.id, sessionID);
                    }
                  }
                }),
              ),
            ),
          });
        });

        const hasPendingBackgroundWorkForState = (state: OpenCode2ThreadState) =>
          inspectPendingBackgroundWork(state).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to inspect OpenCode 2 pending background work.", {
                errorTag: causeErrorTag(cause),
                provider: OPENCODE2_PROVIDER,
                providerThreadId: state.providerThread.id,
              }).pipe(Effect.as(false)),
            ),
          );

        const waitForT3Mcp = Effect.fnUntraced(function* () {
          if (!hasT3Mcp) return;
          let lastStatus = "missing";
          for (let attempt = 0; attempt < 50; attempt++) {
            const listed = yield* sdkCall("mcp.list", {}, () =>
              client.mcp.status().then((response) => ({
                data: {
                  data: Object.entries(
                    (response as { data?: Record<string, unknown> }).data ?? {},
                  ).map(([name, status]) => ({ name, status })),
                },
              })),
            ).pipe(
              Effect.map((response) => ({ available: true as const, response })),
              Effect.catch((error: OpenCode2RuntimeError) => {
                // Beta lildax has no /mcp routes; do not block session open.
                const detail = openCodeRuntimeErrorDetail(error.cause).toLowerCase();
                if (detail.includes("404") || detail.includes("not found")) {
                  return Effect.succeed({ available: false as const, response: null });
                }
                return Effect.fail(error);
              }),
            );
            if (!listed.available) return;
            const servers = yield* unwrapOpenCode2Data<ReadonlyArray<McpServer>>(
              "mcp.list",
              listed.response,
            );
            const server = servers.find((candidate) => candidate.name === OPENCODE2_T3_MCP_NAME);
            lastStatus = server === undefined ? "missing" : mcpServerStatus(server);
            if (lastStatus === "connected") return;
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
          yield* sdkCall(
            "session.instructions.entry.put",
            { sessionID, key: OPENCODE2_T3_INSTRUCTION_KEY },
            () => Promise.resolve({ data: { data: true } }),
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
                return yield* protocolError(
                  `OpenCode 2 session ${sessionID} is not registered for pending-work inspection`,
                );
              }
              return yield* inspectPendingBackgroundWork(state);
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to inspect OpenCode 2 pending background work.", {
                  errorTag: causeErrorTag(cause),
                  provider: OPENCODE2_PROVIDER,
                  providerThreadId: providerThread.id,
                }).pipe(Effect.as(false)),
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
                client.v2.session.create(parameters),
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
              const response = yield* sdkCall("session.get", { sessionID }, () =>
                client.v2.session.get({ sessionID }),
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
                sdkCall("session.remove", { sessionID }, () =>
                  client.v2.session.get({ sessionID }, { throwOnError: false }).then(async () => {
                    // Beta Session3 has no remove(); best-effort interrupt then rely on GC.
                    try {
                      await client.v2.session.interrupt({ sessionID });
                    } catch {
                      /* ignore */
                    }
                    return { data: { data: true } };
                  }),
                ),
              );
              threads.delete(sessionID);
              sessionPermissions.delete(sessionID);
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
              if (
                spawnedWithInjectedAllowPolicy &&
                !warnedAboutInjectedAllowPolicy &&
                !isOpenCodeAllowAllPolicy(turnInput.runtimePolicy)
              ) {
                warnedAboutInjectedAllowPolicy = true;
                yield* Effect.logWarning(
                  "OpenCode 2 session was spawned with an allow-all permission policy; a stricter runtime mode will not re-gate suppressed permission asks until the session is reopened.",
                  {
                    provider: OPENCODE2_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    threadId: turnInput.threadId,
                    runtimeMode: turnInput.runtimePolicy.runtimeMode,
                  },
                );
              }
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
                providerRetry: null,
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
                if (wake === undefined) {
                  yield* finalizeTurn(state, turn, "completed");
                  return;
                }
                for (const event of wake.events) {
                  yield* handleEvent(event, { replayWakeInputId: wake.inputId });
                }
                return;
              }
              const payload = promptPayload(turnInput.message);
              yield* alignSessionSelection(
                state,
                turnInput.modelSelection,
                turnInput.runtimePolicy.interactionMode,
              );
              const prompted = yield* sdkCall("session.prompt", { sessionID, ...payload }, () =>
                postSessionPrompt({ sessionID, ...payload }),
              ).pipe(
                Effect.tapError((cause) =>
                  finalizeTurn(state, turn, "failed", {
                    failure: makeProviderFailure({ cause, class: "provider_error" }),
                  }),
                ),
              );
              // Arm the stall watchdog from the prompt boundary so a long first
              // token does not immediately resubscribe, but a dead stream after
              // prompt still recovers.
              lastEventAtMs = yield* Clock.currentTimeMillis;
              // The admitted input id is the closest native turn correlation
              // point 2.x offers, and it arrives on the prompt response before
              // `session.input.admitted` reaches the event stream. next-16916
              // returns a single-wrapped body (`data.id`); older beta SDKs used
              // the double envelope (`data.data.id`).
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
                () => client.v2.session.interrupt({ sessionID }),
                OPENCODE2_INTERRUPT_REQUEST_TIMEOUT_MS,
              );
              if (Option.isNone(interruptedRemote)) {
                yield* Effect.logWarning(
                  "OpenCode 2 session.interrupt did not complete in time; force-settling locally.",
                  {
                    provider: OPENCODE2_PROVIDER,
                    providerTurnId: turn.providerTurnId,
                    timeoutMs: OPENCODE2_INTERRUPT_REQUEST_TIMEOUT_MS,
                  },
                );
              }
              yield* removeRunningShellsForTurn(turn).pipe(
                Effect.timeoutOption(`${OPENCODE2_INTERRUPT_REQUEST_TIMEOUT_MS} millis`),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to stop OpenCode 2 shells during interrupt.", {
                    errorTag: causeErrorTag(cause),
                    provider: OPENCODE2_PROVIDER,
                    providerTurnId: turn.providerTurnId,
                  }).pipe(Effect.as(Option.none())),
                ),
                Effect.asVoid,
              );
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
              yield* Effect.logWarning(
                "OpenCode 2 interrupt settle timed out; force-finalizing the turn.",
                {
                  provider: OPENCODE2_PROVIDER,
                  providerTurnId: turn.providerTurnId,
                  settleTimeoutMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
                },
              );
              yield* finalizeTurn(state, turn, "interrupted");
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
                yield* sdkCall("session.question.reply", { sessionID, requestID, answers }, () =>
                  client.v2.session.question.reply({
                    sessionID,
                    requestID,
                    questionV2Reply: { answers },
                  }),
                );
                return;
              }
              if (requestInput.decision === undefined) {
                return yield* protocolError(
                  `OpenCode 2 approval request ${requestInput.requestId} requires a decision`,
                );
              }
              if (requestInput.decision === "acceptForSession") {
                rememberOpenCode2SessionPermission(
                  sessionPermissions,
                  sessionID,
                  pending.permission,
                );
              }
              const reply =
                requestInput.decision === "accept" || requestInput.decision === "acceptForSession"
                  ? ("once" as const)
                  : ("reject" as const);
              yield* sdkCall("session.permission.reply", { sessionID, requestID, reply }, () =>
                client.v2.session.permission.reply({ sessionID, requestID, reply }),
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
                client.v2.session.messages({ sessionID }),
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
                    client.v2.session.revert.stage({
                      sessionID,
                      messageID: boundaryMessageId!,
                      files: true,
                    }),
                );
                yield* sdkCall("session.revert.commit", { sessionID }, () =>
                  client.v2.session.revert.commit({ sessionID }),
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
              const response = yield* sdkCall("session.fork", parameters, () =>
                Promise.reject(
                  new Error("OpenCode 2 beta session.fork is not available on Session3"),
                ),
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
      return makeOpenCode2AdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: applyOpenCode2ProviderEnvironment(
          input.config,
          mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        ),
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
