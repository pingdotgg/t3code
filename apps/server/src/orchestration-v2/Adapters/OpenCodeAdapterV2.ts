import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OpenCodeSettings,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  OpenCodeSettings as OpenCodeSettingsSchema,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import {
  structuralProtocolMethod,
  summarizeNativeProtocolPayload,
} from "../../provider/NativeProtocolLogging.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { t3OrchestrationSystemPrompt } from "../../provider/T3OrchestrationInstructions.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeRuntimeShape,
} from "../../provider/opencodeRuntime.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
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
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeSubagentChildThread, subagentThreadTitle } from "../SubagentProjection.ts";

export const OPENCODE_PROVIDER = ProviderDriverKind.make("opencode");
export const OPENCODE_DRIVER_KIND = OPENCODE_PROVIDER;
export const OPENCODE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(OPENCODE_DRIVER_KIND);
export const OPENCODE_SDK_PROTOCOL = "opencode-sdk.sse" as const;
const DEFAULT_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettingsSchema)({});

/**
 * OpenCode's session, message, part, and interaction-request identifiers are
 * durable. It does not expose a first-class turn object: the initiating user
 * message is the best native turn correlation point, and session idle is the
 * authoritative terminal signal.
 */
export const OpenCodeProviderCapabilitiesV2 = {
  sessions: {
    // The current adapter owns one directory-bound client/server per session.
    // Keep it isolated until its runtime is made safe for cross-thread pooling.
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
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
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

interface ActiveOpenCodeTurn {
  readonly isRoot: boolean;
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: ProviderAdapterV2TurnInput["rootNodeId"];
  readonly appThread: OrchestrationV2AppThread;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly providerTurnOrdinal: number;
  readonly runOrdinal: number;
  readonly runAttemptId: OrchestrationV2ProviderTurn["runAttemptId"];
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  readonly parts: Map<string, OpenCodePart>;
  readonly partIdsByMessage: Map<string, Set<string>>;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  nextItemOrdinal: number;
  nativeUserMessageId: string | null;
  interrupted: boolean;
  finalized: boolean;
  planId: PlanId | null;
}

interface OpenCodeSubagentContext {
  readonly nativeItemId: string;
  readonly nodeId: OrchestrationV2Subagent["id"];
  readonly parentTurn: ActiveOpenCodeTurn;
  readonly prompt: string;
  readonly title: string | null;
  readonly startedAt: DateTime.Utc;
  childSessionId: string | null;
  childThreadId: ThreadId | null;
  childProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
  model: string | null;
  result: string | null;
}

interface OpenCodeThreadState {
  readonly nativeSessionId: string;
  providerThread: OrchestrationV2ProviderThread;
  appThread: OrchestrationV2AppThread | null;
  activeTurn: ActiveOpenCodeTurn | null;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: Map<string, OrchestrationV2RuntimeRequest>;
  readonly messageRoles: Map<string, "user" | "assistant">;
  readonly userMessageIds: Array<string>;
  parentSubagent: OpenCodeSubagentContext | null;
  nextChildTurnOrdinal: number;
}

interface PendingOpenCodeRequest {
  readonly requestId: RuntimeRequestId;
  readonly nativeRequestId: string;
  readonly turn: ActiveOpenCodeTurn;
  readonly state: OpenCodeThreadState;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly requestKind: OpenCodePermissionRequestKind | "user_input";
  readonly createdAt: DateTime.Utc;
  readonly permission?: PermissionRequest;
  readonly question?: QuestionRequest;
}

export interface OpenCodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly runtime: OpenCodeRuntimeShape;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly serverConfig: ServerConfig["Service"];
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface OpenCodeProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly messageKind: "request" | "response" | "notification" | "error";
  readonly method: string;
  readonly payload: unknown;
}

export function formatOpenCodeProtocolLogPayload(event: OpenCodeProtocolLogEvent) {
  return {
    direction: event.direction,
    messageKind: event.messageKind,
    method: structuralProtocolMethod(event.method),
    payload: summarizeNativeProtocolPayload(event.payload),
  };
}

export function makeOpenCodeProtocolLogger(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
}): (event: OpenCodeProtocolLogEvent) => Effect.Effect<void, never> {
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
            protocol: OPENCODE_SDK_PROTOCOL,
            provider: OPENCODE_PROVIDER,
            providerInstanceId: input.providerInstanceId,
            providerSessionId: input.providerSessionId,
            createdAt: observedAt,
            threadId: input.threadId,
            payload: formatOpenCodeProtocolLogPayload(event),
          },
        },
        input.threadId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Failed to write native OpenCode event log.", {
              errorTag: causeErrorTag(cause),
              reasonCount: cause.reasons.length,
              provider: OPENCODE_PROVIDER,
              threadId: input.threadId,
            }),
      ),
    );
}

function protocolError(detail: string, payload?: unknown): ProviderAdapterProtocolError {
  return new ProviderAdapterProtocolError({
    driver: OPENCODE_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

function nativeThreadId(providerThread: OrchestrationV2ProviderThread): string {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === null || nativeId === undefined) {
    throw protocolError(`Provider thread ${providerThread.id} has no OpenCode session id`);
  }
  return nativeId;
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

type OpenCodePermissionRequestKind = Extract<
  ProviderRequestKind,
  "command" | "file-read" | "file-change"
>;

export function openCodePermissionRequestKind(
  permission: string,
  toolName?: string,
): OpenCodePermissionRequestKind {
  const normalized = permission.toLowerCase();
  const normalizedTool = toolName?.toLowerCase() ?? "";
  if (
    normalized === "edit" ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalizedTool.includes("edit") ||
    normalizedTool.includes("write") ||
    normalizedTool.includes("patch")
  ) {
    return "file-change";
  }
  if (
    normalized === "read" ||
    normalized === "glob" ||
    normalized === "grep" ||
    normalized === "lsp" ||
    normalized === "external_directory" ||
    normalizedTool === "read" ||
    normalizedTool.includes("glob") ||
    normalizedTool.includes("grep") ||
    normalizedTool.includes("search")
  ) {
    return "file-read";
  }
  return "command";
}

export function openCodeToolProjectionKind(
  toolName: string,
): "command_execution" | "file_change" | "file_search" | "web_search" | "dynamic_tool" {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("shell")) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web") || normalized === "codesearch" || normalized === "code_search") {
    return "web_search";
  }
  if (
    normalized === "read" ||
    normalized.includes("glob") ||
    normalized.includes("grep") ||
    normalized.includes("search") ||
    normalized.includes("lsp")
  ) {
    return "file_search";
  }
  return "dynamic_tool";
}

const OPENCODE_ALWAYS_ALLOWED_PERMISSIONS = [
  "question",
  "read",
  "glob",
  "grep",
  "lsp",
  "todowrite",
  "task",
  "skill",
] as const;

const OPENCODE_RESTRICTED_PERMISSIONS = [
  "bash",
  "edit",
  "webfetch",
  "websearch",
  "codesearch",
  "external_directory",
  "doom_loop",
] as const;

/**
 * OpenCode does not provide an OS sandbox, so permission rules are also the
 * enforcement boundary for non-interactive policies. Read/planning tools are
 * safe by default; edits are auto-approved only for workspace-write modes,
 * while shell/network/external access remains gated unless policy explicitly
 * allows it.
 */
export function openCodePermissionRules(
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
): PermissionRuleset {
  const sandboxPolicy = recordValue(runtimePolicy, "sandboxPolicy");
  const sandboxType = recordString(sandboxPolicy, "type");
  const rawApprovalPolicy = runtimePolicy.approvalPolicy;
  const approvalPolicy = nonEmptyString(rawApprovalPolicy);
  const requiresApproval =
    approvalPolicy === undefined
      ? (typeof rawApprovalPolicy === "object" && rawApprovalPolicy !== null) ||
        runtimePolicy.runtimeMode !== "full-access"
      : approvalPolicy !== "never";
  const externallySandboxed = sandboxType === "externalSandbox";
  const dangerFullAccess = sandboxType === "dangerFullAccess";
  const implicitFullAccess =
    sandboxType === undefined && runtimePolicy.runtimeMode === "full-access";

  if (!requiresApproval && (externallySandboxed || dangerFullAccess || implicitFullAccess)) {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  // Task sessions initially inherit only parent deny rules. Seed explicit
  // denies before the effective ask/allow overrides so a child is safe during
  // the short interval before emitSubagent installs its complete policy.
  const rules: PermissionRuleset = [
    { permission: "*", pattern: "*", action: "deny" },
    ...OPENCODE_RESTRICTED_PERMISSIONS.map((permission) => ({
      permission,
      pattern: "*",
      action: "deny" as const,
    })),
  ];

  if (requiresApproval) {
    rules.push({ permission: "*", pattern: "*", action: "ask" });
    for (const permission of OPENCODE_RESTRICTED_PERMISSIONS) {
      rules.push({ permission, pattern: "*", action: "ask" });
    }
  }

  rules.push(
    ...OPENCODE_ALWAYS_ALLOWED_PERMISSIONS.map((permission) => ({
      permission,
      pattern: "*",
      action: "allow" as const,
    })),
  );

  if (runtimePolicy.runtimeMode === "auto-accept-edits" || sandboxType === "workspaceWrite") {
    rules.push({ permission: "edit", pattern: "*", action: "allow" });
  }

  if (!requiresApproval && recordValue(sandboxPolicy, "networkAccess") === true) {
    for (const permission of ["webfetch", "websearch", "codesearch"] as const) {
      rules.push({ permission, pattern: "*", action: "allow" });
    }
  }

  if (!requiresApproval && sandboxType === "readOnly") {
    const access = recordValue(sandboxPolicy, "access");
    if (recordString(access, "type") === "fullAccess") {
      rules.push({ permission: "external_directory", pattern: "*", action: "allow" });
    }
  }

  if (!requiresApproval && sandboxType === "workspaceWrite") {
    const writableRoots = recordValue(sandboxPolicy, "writableRoots");
    if (Array.isArray(writableRoots)) {
      for (const root of writableRoots) {
        if (typeof root === "string" && root.trim().length > 0) {
          rules.push({
            permission: "external_directory",
            pattern: `${root.replace(/\/$/, "")}/*`,
            action: "allow",
          });
        }
      }
    }
  }

  return rules;
}

function permissionRuleEquals(
  left: PermissionRuleset[number],
  right: PermissionRuleset[number],
): boolean {
  return (
    left.permission === right.permission &&
    left.pattern === right.pattern &&
    left.action === right.action
  );
}

/**
 * OpenCode task sessions inherit only the parent's deny/external-directory
 * rules and then add agent-specific restrictions such as disabling nested
 * tasks. Install the complete parent policy while retaining only rules that
 * were added specifically for the selected child agent.
 */
export function openCodeChildPermissionRules(
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
  nativeChildRules: PermissionRuleset,
): PermissionRuleset {
  const parentRules = openCodePermissionRules(runtimePolicy);
  const inheritedRules = parentRules.filter(
    (rule) => rule.permission === "external_directory" || rule.action === "deny",
  );
  const childSpecificRules = nativeChildRules.filter(
    (childRule) =>
      !inheritedRules.some((inheritedRule) => permissionRuleEquals(childRule, inheritedRule)),
  );
  return [...parentRules, ...childSpecificRules];
}

/**
 * OpenCode's fork/revert boundary is exclusive. To retain the selected app
 * turn, address the next native user message; omitting a boundary retains the
 * current head when the selected turn is already last.
 */
export function openCodeBoundaryAfterProviderTurn(
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  selectedProviderTurnId: OrchestrationV2ProviderTurn["id"],
): string | undefined {
  const selected = providerTurns.find((turn) => turn.id === selectedProviderTurnId);
  if (selected === undefined) return undefined;
  return providerTurns
    .filter((turn) => turn.ordinal > selected.ordinal)
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((turn) => turn.nativeTurnRef?.nativeId)
    .find((nativeId): nativeId is string => nativeId !== null && nativeId !== undefined);
}

function toolStatus(part: ToolPart): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly item: OrchestrationV2TurnItem["status"];
} {
  switch (part.state.status) {
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

function toolInput(part: ToolPart): Record<string, unknown> {
  return part.state.input;
}

function toolOutput(part: ToolPart): string | undefined {
  if (part.state.status === "completed") return part.state.output;
  if (part.state.status === "error") return part.state.error;
  return undefined;
}

function toolStartedAt(part: ToolPart, now: DateTime.Utc): DateTime.Utc {
  return dateTimeFromEpoch(
    part.state.status === "pending" ? undefined : part.state.time.start,
    now,
  );
}

function toolCompletedAt(part: ToolPart, now: DateTime.Utc): DateTime.Utc | null {
  return part.state.status === "completed" || part.state.status === "error"
    ? dateTimeFromEpoch(part.state.time.end, now)
    : null;
}

function toolTitle(part: ToolPart): string | null {
  return part.state.status === "running" || part.state.status === "completed"
    ? (part.state.title ?? null)
    : null;
}

function toolModel(part: ToolPart): string | null {
  const metadata =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error"
      ? part.state.metadata
      : undefined;
  const model = recordValue(metadata, "model");
  const providerId = recordString(model, "providerID", "providerId");
  const modelId = recordString(model, "modelID", "modelId", "id");
  return providerId !== undefined && modelId !== undefined ? `${providerId}/${modelId}` : null;
}

function taskSessionId(part: ToolPart): string | null {
  const metadata =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error"
      ? part.state.metadata
      : undefined;
  return recordString(metadata, "sessionId", "sessionID") ?? null;
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly nativeSession: OpenCodeSession;
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  const createdAt = dateTimeFromEpoch(input.nativeSession.time.created, input.now);
  return {
    id: input.idAllocator.derive.providerThread({
      driver: OPENCODE_PROVIDER,
      nativeThreadId: input.nativeSession.id,
    }),
    driver: OPENCODE_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: OPENCODE_PROVIDER,
      nativeId: input.nativeSession.id,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt,
    updatedAt: dateTimeFromEpoch(input.nativeSession.time.updated, input.now),
  };
}

function providerRef(nativeId: string, strength: "strong" | "weak" = "strong") {
  return {
    driver: OPENCODE_PROVIDER,
    nativeId,
    strength,
  } satisfies OrchestrationV2ProviderRef;
}

function openCodeErrorMessage(event: Extract<OpenCodeEvent, { type: "session.error" }>): string {
  const error = event.properties.error;
  if (error === undefined) return "OpenCode session failed without an error payload.";
  return recordString(error.data, "message") ?? error.name;
}

function terminalStatusForError(
  event: Extract<OpenCodeEvent, { type: "session.error" }>,
  turn: ActiveOpenCodeTurn,
): TerminalTurnStatus {
  return turn.interrupted || isMessageAbortedError(event) ? "interrupted" : "failed";
}

function isMessageAbortedError(event: Extract<OpenCodeEvent, { type: "session.error" }>): boolean {
  return event.properties.error?.name === "MessageAbortedError";
}

function unwrapData<A>(operation: string, result: { readonly data?: A }): NonNullable<A> {
  if (result.data === undefined) {
    throw new OpenCodeRuntimeError({
      operation,
      detail: `OpenCode ${operation} returned no response payload.`,
    });
  }
  return result.data as NonNullable<A>;
}

export function makeOpenCodeAdapterV2(options: OpenCodeAdapterV2Options): ProviderAdapterV2Shape {
  const { idAllocator, runtime, serverConfig } = options;

  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OPENCODE_PROVIDER,
    getCapabilities: () => Effect.succeed(OpenCodeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("OpenCodeAdapterV2.openSession")(
      function* (input: ProviderAdapterV2OpenSessionInput) {
        const scope = yield* Effect.scope;
        const cwd = input.runtimePolicy.cwd ?? serverConfig.cwd;
        const connection = yield* runtime.connectToOpenCodeServer({
          binaryPath: options.settings.binaryPath,
          serverUrl: options.settings.serverUrl,
          environment: options.environment,
        });
        const client = runtime.createOpenCodeSdkClient({
          baseUrl: connection.url,
          directory: cwd,
          ...(connection.external && options.settings.serverPassword
            ? { serverPassword: options.settings.serverPassword }
            : {}),
        });

        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const hasT3Mcp = mcpSession !== undefined && !connection.external;
        const orchestrationSystemPrompt = t3OrchestrationSystemPrompt(hasT3Mcp);
        if (hasT3Mcp) {
          yield* runOpenCodeSdk("mcp.add", () =>
            client.mcp.add({
              name: "t3-code",
              config: {
                type: "remote",
                url: mcpSession.endpoint,
                headers: { Authorization: mcpSession.authorizationHeader },
                oauth: false,
              },
            }),
          );
        }

        const now = yield* DateTime.now;
        let sessionEntity: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: OPENCODE_PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd,
          model: input.modelSelection.model,
          capabilities: OpenCodeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const threads = new Map<string, OpenCodeThreadState>();
        const pendingRequests = new Map<string, PendingOpenCodeRequest>();
        const pendingRequestsByNativeId = new Map<string, PendingOpenCodeRequest>();
        const subagentsByNativeItemId = new Map<string, OpenCodeSubagentContext>();
        const subagentsByChildSessionId = new Map<string, OpenCodeSubagentContext>();
        const abortController = new AbortController();

        const emitProviderEvent = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const logProtocolEvent = makeOpenCodeProtocolLogger({
          nativeEventLogger: options.nativeEventLogger,
          idAllocator,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          threadId: input.threadId,
        });

        const sdkCall = <A>(
          method: string,
          payload: unknown,
          call: () => Promise<A>,
        ): Effect.Effect<A, OpenCodeRuntimeError> =>
          logProtocolEvent({
            direction: "outgoing",
            messageKind: "request",
            method,
            payload,
          }).pipe(
            Effect.andThen(runOpenCodeSdk(method, call)),
            Effect.tap((response) =>
              logProtocolEvent({
                direction: "incoming",
                messageKind: "response",
                method,
                payload: sdkResponseForRawLog(response),
              }),
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
              driver: OPENCODE_PROVIDER,
              providerSession: sessionEntity,
            });
          });

        const updateProviderThread = (
          state: OpenCodeThreadState,
          patch: Partial<OrchestrationV2ProviderThread>,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            state.providerThread = { ...state.providerThread, ...patch, updatedAt };
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: OPENCODE_PROVIDER,
              providerThread: state.providerThread,
            });
          });

        const itemOrdinal = (turn: ActiveOpenCodeTurn, nativeItemId: string): number => {
          const existing = turn.itemOrdinals.get(nativeItemId);
          if (existing !== undefined) return existing;
          const ordinal = turn.nextItemOrdinal++;
          turn.itemOrdinals.set(nativeItemId, ordinal);
          return ordinal;
        };

        const emitProviderTurn = (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          status: OrchestrationV2ProviderTurn["status"],
          completedAt: DateTime.Utc | null,
        ) => {
          const providerTurn: OrchestrationV2ProviderTurn = {
            ...turn.providerTurn,
            nativeTurnRef:
              turn.nativeUserMessageId === null
                ? turn.providerTurn.nativeTurnRef
                : providerRef(turn.nativeUserMessageId, "weak"),
            status,
            completedAt,
          };
          Object.assign(turn.providerTurn, providerTurn);
          state.providerTurns.set(String(providerTurn.id), providerTurn);
          return emitProviderEvent({
            type: "provider_turn.updated",
            driver: OPENCODE_PROVIDER,
            threadId: turn.threadId,
            providerTurn,
          });
        };

        const emitTextPart = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          part: Extract<OpenCodePart, { type: "text" | "reasoning" }>,
          forceCompleted = false,
        ) {
          if (part.type === "text" && (part.ignored === true || part.synthetic === true)) return;
          if (part.text.length === 0) return;
          const emittedAt = yield* DateTime.now;
          const isCompleted = forceCompleted || part.time?.end !== undefined;
          const startedAt = dateTimeFromEpoch(part.time?.start, emittedAt);
          const completedAt = isCompleted ? dateTimeFromEpoch(part.time?.end, emittedAt) : null;
          const nativeItemRef = providerRef(part.id);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const ordinal = itemOrdinal(turn, part.id);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: part.type === "text" ? "assistant_message" : "reasoning",
              status: isCompleted ? "completed" : "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            },
          });
          if (part.type === "text") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: OPENCODE_PROVIDER,
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
              createdAt: startedAt,
              updatedAt: emittedAt,
            };
            state.messages.set(String(message.id), message);
            yield* emitProviderEvent({
              type: "message.updated",
              driver: OPENCODE_PROVIDER,
              message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: OPENCODE_PROVIDER,
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
                startedAt,
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
            driver: OPENCODE_PROVIDER,
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
              startedAt,
              completedAt,
              updatedAt: emittedAt,
              type: "reasoning",
              text: part.text,
              streaming: !isCompleted,
            },
          });
        });

        const emitSubagent = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          part: ToolPart,
        ) {
          const now = yield* DateTime.now;
          const nativeItemRef = providerRef(part.id);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const input = toolInput(part);
          const prompt = recordString(input, "prompt") ?? "";
          const title = toolTitle(part) ?? recordString(input, "description") ?? null;
          let context = subagentsByNativeItemId.get(part.id);
          if (context === undefined) {
            context = {
              nativeItemId: part.id,
              nodeId,
              parentTurn: turn,
              prompt,
              title,
              startedAt: toolStartedAt(part, now),
              childSessionId: null,
              childThreadId: null,
              childProviderThreadId: null,
              model: null,
              result: null,
            };
            subagentsByNativeItemId.set(part.id, context);
          }
          context.model = toolModel(part) ?? context.model;
          const childSessionId = taskSessionId(part);
          if (childSessionId !== null && context.childSessionId === null) {
            context.childSessionId = childSessionId;
            context.childThreadId = idAllocator.derive.threadFromProviderThread({
              driver: OPENCODE_PROVIDER,
              nativeThreadId: childSessionId,
            });
            context.childProviderThreadId = idAllocator.derive.providerThread({
              driver: OPENCODE_PROVIDER,
              nativeThreadId: childSessionId,
            });
            subagentsByChildSessionId.set(childSessionId, context);
            const childModelSelection: ModelSelection = {
              instanceId: options.instanceId,
              model: context.model ?? turn.modelSelection.model,
            };
            const childThread = makeSubagentChildThread({
              parentThread: turn.appThread,
              childThreadId: context.childThreadId,
              parentNodeId: nodeId,
              activeProviderThreadId: context.childProviderThreadId,
              providerInstanceId: options.instanceId,
              modelSelection: childModelSelection,
              title: subagentThreadTitle({
                parentTitle: turn.appThread.title,
                title,
                prompt,
                ordinal: itemOrdinal(turn, part.id),
              }),
              now,
              createdBy: "agent",
              creationSource: "provider",
            });
            const childProviderThread: OrchestrationV2ProviderThread = {
              id: context.childProviderThreadId,
              driver: OPENCODE_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: inputProviderSessionId,
              appThreadId: context.childThreadId,
              ownerNodeId: nodeId,
              nativeThreadRef: providerRef(childSessionId),
              nativeConversationHeadRef: null,
              status: "active",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            };
            const childSessionResponse = yield* sdkCall(
              "session.get",
              { sessionID: childSessionId },
              () => client.session.get({ sessionID: childSessionId }),
            );
            const nativeChildSession = unwrapData("session.get", childSessionResponse);
            const childPermission = openCodeChildPermissionRules(
              turn.runtimePolicy,
              nativeChildSession.permission ?? [],
            );
            yield* sdkCall(
              "session.update",
              { sessionID: childSessionId, permission: childPermission },
              () =>
                client.session.update({
                  sessionID: childSessionId,
                  permission: childPermission,
                }),
            );
            threads.set(childSessionId, {
              nativeSessionId: childSessionId,
              providerThread: childProviderThread,
              appThread: childThread,
              activeTurn: null,
              providerTurns: new Map(),
              messages: new Map(),
              runtimeRequests: new Map(),
              messageRoles: new Map(),
              userMessageIds: [],
              parentSubagent: context,
              nextChildTurnOrdinal: 1,
            });
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver: OPENCODE_PROVIDER,
              appThread: childThread,
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: OPENCODE_PROVIDER,
              providerThread: childProviderThread,
            });
          }
          const output = toolOutput(part);
          if (part.state.status === "completed" && output !== undefined) context.result = output;
          const status = toolStatus(part);
          const completedAt = toolCompletedAt(part, now);
          const subagentStatus: OrchestrationV2Subagent["status"] =
            status.item === "failed"
              ? "failed"
              : status.item === "completed"
                ? "completed"
                : status.item === "pending"
                  ? "pending"
                  : "running";
          const subagent: OrchestrationV2Subagent = {
            id: nodeId,
            threadId: turn.threadId,
            runId: turn.runId,
            parentNodeId: turn.rootNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: OPENCODE_PROVIDER,
            providerInstanceId: options.instanceId,
            providerThreadId: context.childProviderThreadId,
            childThreadId: context.childThreadId,
            nativeTaskRef: nativeItemRef,
            prompt,
            title,
            model: context.model,
            status: subagentStatus,
            result: context.result,
            startedAt: context.startedAt,
            completedAt,
            updatedAt: now,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: "subagent",
              status: status.node,
              countsForRun: false,
              providerThreadId: context.childProviderThreadId ?? state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: context.startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: OPENCODE_PROVIDER,
            subagent,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: {
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
              title,
              startedAt: context.startedAt,
              completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: nodeId,
              origin: "provider_native",
              driver: OPENCODE_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: context.childThreadId,
              prompt,
              result: context.result,
            },
          });
        });

        const emitToolPart = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          part: ToolPart,
        ) {
          const normalizedTool = part.tool.toLowerCase();
          if (normalizedTool === "task") {
            yield* emitSubagent(state, turn, part);
            return;
          }
          // question.asked carries the respondable semantic item. Projecting
          // the implementation tool as well would duplicate it in the UI.
          if (normalizedTool === "question") return;
          const now = yield* DateTime.now;
          const status = toolStatus(part);
          const startedAt = toolStartedAt(part, now);
          const completedAt = toolCompletedAt(part, now);
          const nativeItemRef = providerRef(part.id);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
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
            title: toolTitle(part),
            startedAt,
            completedAt,
            updatedAt: now,
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
          const input = toolInput(part);
          const output = toolOutput(part);
          const projectionKind = openCodeToolProjectionKind(part.tool);
          let turnItem: OrchestrationV2TurnItem;
          if (projectionKind === "command_execution") {
            turnItem = {
              ...base,
              type: "command_execution",
              input: recordString(input, "command", "cmd") ?? stableJson(input),
              ...(output === undefined ? {} : { output }),
              ...(recordNumber(
                part.state.status === "completed" ? part.state.metadata : undefined,
                "exit",
                "exitCode",
              ) === undefined
                ? {}
                : {
                    exitCode: recordNumber(
                      part.state.status === "completed" ? part.state.metadata : undefined,
                      "exit",
                      "exitCode",
                    )!,
                  }),
            };
          } else if (projectionKind === "file_change") {
            turnItem = {
              ...base,
              type: "file_change",
              fileName: recordString(input, "filePath", "path", "file") ?? part.tool,
              ...(recordString(input, "oldString", "oldText") === undefined
                ? {}
                : { oldStr: recordString(input, "oldString", "oldText")! }),
              ...(recordString(input, "newString", "content", "newText") === undefined
                ? {}
                : { newStr: recordString(input, "newString", "content", "newText")! }),
              ...(recordString(
                part.state.status === "completed" ? part.state.metadata : undefined,
                "diff",
                "patch",
              ) === undefined
                ? {}
                : {
                    diffStr: recordString(
                      part.state.status === "completed" ? part.state.metadata : undefined,
                      "diff",
                      "patch",
                    )!,
                  }),
            };
          } else if (projectionKind === "file_search") {
            turnItem = {
              ...base,
              type: "file_search",
              ...(recordString(input, "pattern", "query", "path", "filePath") === undefined
                ? {}
                : { pattern: recordString(input, "pattern", "query", "path", "filePath")! }),
            };
          } else if (projectionKind === "web_search") {
            const pattern = recordString(input, "query", "url", "pattern");
            turnItem = {
              ...base,
              type: "web_search",
              ...(pattern === undefined ? {} : { patterns: [pattern] }),
            };
          } else {
            turnItem = {
              ...base,
              type: "dynamic_tool",
              toolName: part.tool,
              input,
              ...(output === undefined ? {} : { output }),
            };
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
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
              startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem,
          });
        });

        const emitTodo = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          todos: ReadonlyArray<OpenCodeTodo>,
        ) {
          const now = yield* DateTime.now;
          if (turn.planId === null) {
            turn.planId = yield* idAllocator.allocate.plan({
              threadId: turn.threadId,
              ...(turn.runId === null ? {} : { runId: turn.runId }),
              driver: OPENCODE_PROVIDER,
            });
          }
          const planId = turn.planId;
          const nativeItemId = `${state.nativeSessionId}:todo:${turn.providerTurnId}`;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId,
          });
          const steps: Array<OrchestrationV2PlanStep> = todos.map((todo, index) => ({
            id: `${nativeItemId}:${index + 1}`,
            text: todo.content.trim() || `Todo ${index + 1}`,
            status:
              todo.status === "completed"
                ? "completed"
                : todo.status === "in_progress"
                  ? "running"
                  : "pending",
          }));
          const completed = steps.length > 0 && steps.every((step) => step.status === "completed");
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: "todo_list",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(nativeItemId, "weak"),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: turn.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            driver: OPENCODE_PROVIDER,
            plan: {
              id: planId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              status: completed ? "completed" : "active",
              kind: "todo_list",
              steps,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(nativeItemId, "weak"),
              parentItemId: null,
              ordinal: itemOrdinal(turn, nativeItemId),
              status: completed ? "completed" : "running",
              title: "Todo list",
              startedAt: turn.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "todo_list",
              planId,
              steps,
            },
          });
        });

        const requestQuestions = (request: QuestionRequest) =>
          request.questions.map((question, index) => ({
            id: openCodeQuestionId(index, question),
            header: question.header.trim() || `Question ${index + 1}`,
            question: question.question.trim() || question.header.trim() || `Question ${index + 1}`,
            options: question.options.map((option) => ({
              label: option.label.trim() || "Option",
              description: option.description.trim() || option.label.trim() || "Option",
            })),
          }));

        const runtimeRequestTurnItem = (
          pending: PendingOpenCodeRequest,
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
          if (pending.question !== undefined) {
            return {
              ...base,
              title: "User input",
              type: "user_input_request",
              requestId: pending.requestId,
              questions: requestQuestions(pending.question),
            };
          }
          const permission = pending.permission;
          if (permission === undefined) {
            throw protocolError(`OpenCode request ${pending.requestId} has no native payload`);
          }
          return {
            ...base,
            title: permission.permission,
            type: "approval_request",
            requestId: pending.requestId,
            requestKind: pending.requestKind === "user_input" ? "command" : pending.requestKind,
            prompt:
              permission.patterns.length === 0
                ? permission.permission
                : permission.patterns.join("\n"),
          };
        };

        const emitRuntimeRequest = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          nativeRequestId: string,
          request:
            | { readonly type: "permission"; readonly value: PermissionRequest }
            | { readonly type: "question"; readonly value: QuestionRequest },
        ) {
          if (pendingRequestsByNativeId.has(nativeRequestId)) return;
          const now = yield* DateTime.now;
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver: OPENCODE_PROVIDER,
            providerTurnId: turn.providerTurnId,
            nativeRequestId,
          });
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const turnItemId = idAllocator.derive.approvalTurnItem({ requestId });
          const permissionToolName =
            request.type === "permission" && request.value.tool !== undefined
              ? Array.from(turn.parts.values()).find(
                  (part): part is ToolPart =>
                    part.type === "tool" && part.callID === request.value.tool?.callID,
                )?.tool
              : undefined;
          const permissionRequestKind =
            request.type === "permission"
              ? openCodePermissionRequestKind(request.value.permission, permissionToolName)
              : undefined;
          const requestKind: OrchestrationV2RuntimeRequest["kind"] =
            permissionRequestKind ?? "user_input";
          const pending: PendingOpenCodeRequest = {
            requestId,
            nativeRequestId,
            turn,
            state,
            nodeId,
            turnItemId,
            requestKind,
            createdAt: now,
            ...(request.type === "permission"
              ? { permission: request.value }
              : { question: request.value }),
          };
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
              providerSessionId: inputProviderSessionId,
            },
            createdAt: now,
            resolvedAt: null,
          };
          state.runtimeRequests.set(String(requestId), runtimeRequest);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
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
              startedAt: now,
              completedAt: null,
            },
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: OPENCODE_PROVIDER,
            threadId: turn.threadId,
            runtimeRequest,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: runtimeRequestTurnItem(pending, "waiting", null, now),
          });
          yield* updateProviderSession("waiting", null);
        });

        const resolveRuntimeRequest = Effect.fnUntraced(function* (
          nativeRequestId: string,
          status: "resolved" | "cancelled",
        ) {
          const pending = pendingRequestsByNativeId.get(nativeRequestId);
          if (pending === undefined) return;
          const now = yield* DateTime.now;
          const current = pending.state.runtimeRequests.get(String(pending.requestId));
          if (current !== undefined) {
            const resolved: OrchestrationV2RuntimeRequest = {
              ...current,
              status,
              resolvedAt: now,
            };
            pending.state.runtimeRequests.set(String(pending.requestId), resolved);
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: OPENCODE_PROVIDER,
              threadId: pending.turn.threadId,
              runtimeRequest: resolved,
            });
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: pending.nodeId,
              threadId: pending.turn.threadId,
              runId: pending.turn.runId,
              parentNodeId: pending.turn.rootNodeId,
              rootNodeId: pending.turn.rootNodeId,
              kind: pending.question === undefined ? "approval_request" : "user_input_request",
              status: status === "resolved" ? "completed" : "cancelled",
              countsForRun: false,
              providerThreadId: pending.state.providerThread.id,
              providerTurnId: pending.turn.providerTurnId,
              nativeItemRef: providerRef(nativeRequestId),
              runtimeRequestId: pending.requestId,
              checkpointScopeId: null,
              startedAt: pending.createdAt,
              completedAt: now,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: runtimeRequestTurnItem(
              pending,
              status === "resolved" ? "completed" : "cancelled",
              now,
              now,
            ),
          });
          pendingRequests.delete(String(pending.requestId));
          pendingRequestsByNativeId.delete(nativeRequestId);
          const hasOtherPending = Array.from(pendingRequests.values()).some(
            (candidate) => candidate.turn.isRoot,
          );
          if (!hasOtherPending) yield* updateProviderSession("running", null);
        });

        const finalizeTurn = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
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
            if (part.type === "text" || part.type === "reasoning") {
              yield* emitTextPart(state, turn, part, true);
            }
          }
          for (const pending of Array.from(pendingRequests.values())) {
            if (pending.turn.providerTurnId === turn.providerTurnId) {
              yield* resolveRuntimeRequest(pending.nativeRequestId, "cancelled");
            }
          }
          yield* emitProviderTurn(state, turn, status, completedAt);
          const threadDisposition = terminal?.threadDisposition ?? "reusable";
          yield* updateProviderThread(state, {
            status: turn.isRoot ? "active" : threadDisposition === "broken" ? "error" : "idle",
            nativeConversationHeadRef:
              turn.nativeUserMessageId === null
                ? state.providerThread.nativeConversationHeadRef
                : providerRef(turn.nativeUserMessageId, "weak"),
          });
          state.activeTurn = null;
          if (!turn.isRoot) {
            yield* emitProviderEvent({
              type: "node.updated",
              driver: OPENCODE_PROVIDER,
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
            return;
          }
          const anotherTurnIsActive = Array.from(threads.values()).some(
            (candidate) => candidate.activeTurn?.isRoot === true,
          );
          yield* updateProviderSession(
            anotherTurnIsActive ? "running" : status === "failed" ? "error" : "ready",
            status === "failed" ? sessionEntity.lastError : null,
          );
          yield* emitProviderEvent(
            status === "failed"
              ? {
                  type: "turn.terminal",
                  driver: OPENCODE_PROVIDER,
                  providerThreadId: state.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  failureItemOrdinal: itemOrdinal(turn, `terminal-failure:${turn.providerTurnId}`),
                  status,
                  failure:
                    terminal?.failure ??
                    makeProviderFailure({
                      message: sessionEntity.lastError ?? undefined,
                      class: "provider_error",
                    }),
                  threadDisposition,
                }
              : {
                  type: "turn.terminal",
                  driver: OPENCODE_PROVIDER,
                  providerThreadId: state.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  status,
                  failure: null,
                  threadDisposition,
                },
          );
        });

        const createChildTurn = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          message: Extract<OpenCodeMessage, { role: "user" }>,
        ) {
          if (state.appThread === null || state.parentSubagent === null) return null;
          const now = yield* DateTime.now;
          const startedAt = dateTimeFromEpoch(message.time.created, now);
          const rootNodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: `${state.nativeSessionId}:root:${message.id}`,
          });
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: OPENCODE_PROVIDER,
            nativeTurnId: message.id,
          });
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: providerTurnId,
            providerThreadId: state.providerThread.id,
            nodeId: rootNodeId,
            runAttemptId: null,
            nativeTurnRef: providerRef(message.id, "weak"),
            ordinal: state.nextChildTurnOrdinal++,
            status: "running",
            startedAt,
            completedAt: null,
          };
          const turn: ActiveOpenCodeTurn = {
            isRoot: false,
            threadId: state.appThread.id,
            runId: null,
            rootNodeId,
            appThread: state.appThread,
            modelSelection: state.appThread.modelSelection,
            runtimePolicy: state.parentSubagent.parentTurn.runtimePolicy,
            providerTurnId,
            providerTurnOrdinal: providerTurn.ordinal,
            runOrdinal: state.parentSubagent.parentTurn.runOrdinal,
            runAttemptId: null,
            startedAt,
            itemOrdinals: new Map(),
            parts: new Map(),
            partIdsByMessage: new Map(),
            providerTurn,
            nextItemOrdinal: 1,
            nativeUserMessageId: message.id,
            interrupted: false,
            finalized: false,
            planId: null,
          };
          state.activeTurn = turn;
          state.providerTurns.set(String(providerTurnId), providerTurn);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
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
              nativeItemRef: providerRef(message.id, "weak"),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt: null,
            },
          });
          yield* emitProviderTurn(state, turn, "running", null);
          return turn;
        });

        const projectChildUserPart = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          part: Extract<OpenCodePart, { type: "text" }>,
        ) {
          const now = yield* DateTime.now;
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.messageID,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.messageID,
          });
          const projected: OrchestrationV2ConversationMessage = {
            createdBy: "agent",
            creationSource: "provider",
            id: messageId,
            threadId: turn.threadId,
            runId: null,
            nodeId: turn.rootNodeId,
            role: "user",
            text: part.text,
            attachments: [],
            streaming: false,
            createdAt: turn.startedAt,
            updatedAt: now,
          };
          state.messages.set(String(messageId), projected);
          yield* emitProviderEvent({
            type: "message.updated",
            driver: OPENCODE_PROVIDER,
            message: projected,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: {
              createdBy: "agent",
              creationSource: "provider",
              id: turnItemId,
              threadId: turn.threadId,
              runId: null,
              nodeId: turn.rootNodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(part.messageID),
              parentItemId: null,
              ordinal: itemOrdinal(turn, part.messageID),
              status: "completed",
              title: null,
              startedAt: projected.createdAt,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              messageId,
              inputIntent: "turn_start",
              text: part.text,
              attachments: [],
            },
          });
        });

        const handleMessageUpdated = Effect.fnUntraced(function* (
          event: Extract<OpenCodeEvent, { type: "message.updated" }>,
        ) {
          const state = threads.get(event.properties.sessionID);
          if (state === undefined) return;
          const message = event.properties.info;
          state.messageRoles.set(message.id, message.role);
          if (message.role !== "user") return;
          const isNewUserMessage = !state.userMessageIds.includes(message.id);
          if (isNewUserMessage) state.userMessageIds.push(message.id);
          let turn = state.activeTurn;
          if (turn === null && state.parentSubagent !== null && isNewUserMessage) {
            turn = yield* createChildTurn(state, message);
          }
          if (turn !== null && turn.nativeUserMessageId === null) {
            turn.nativeUserMessageId = message.id;
            yield* emitProviderTurn(state, turn, "running", null);
          }
        });

        const handlePartUpdated = Effect.fnUntraced(function* (
          event: Extract<OpenCodeEvent, { type: "message.part.updated" }>,
        ) {
          const part = event.properties.part;
          const state = threads.get(part.sessionID);
          const turn = state?.activeTurn;
          if (state === undefined || turn === null || turn === undefined || turn.finalized) return;
          if (part.type === "text" && state.messageRoles.get(part.messageID) === "user") {
            if (!turn.isRoot) yield* projectChildUserPart(state, turn, part);
            return;
          }
          turn.parts.set(part.id, part);
          const ids = turn.partIdsByMessage.get(part.messageID) ?? new Set<string>();
          ids.add(part.id);
          turn.partIdsByMessage.set(part.messageID, ids);
          switch (part.type) {
            case "text":
            case "reasoning":
              yield* emitTextPart(state, turn, part);
              return;
            case "tool":
              yield* emitToolPart(state, turn, part);
              return;
            default:
              return;
          }
        });

        const handlePartDelta = Effect.fnUntraced(function* (
          event: Extract<OpenCodeEvent, { type: "message.part.delta" }>,
        ) {
          if (event.properties.field !== "text") return;
          const state = threads.get(event.properties.sessionID);
          const turn = state?.activeTurn;
          const current = turn?.parts.get(event.properties.partID);
          if (
            state === undefined ||
            turn === null ||
            turn === undefined ||
            current === undefined ||
            (current.type !== "text" && current.type !== "reasoning")
          ) {
            return;
          }
          const updated = { ...current, text: current.text + event.properties.delta };
          turn.parts.set(updated.id, updated);
          yield* emitTextPart(state, turn, updated);
        });

        const handleAssistantCompleted = Effect.fnUntraced(function* (
          event: Extract<OpenCodeEvent, { type: "message.updated" }>,
        ) {
          const message = event.properties.info;
          if (message.role !== "assistant" || message.time.completed === undefined) return;
          const state = threads.get(message.sessionID);
          const turn = state?.activeTurn;
          if (state === undefined || turn === null || turn === undefined) return;
          for (const partId of turn.partIdsByMessage.get(message.id) ?? []) {
            const part = turn.parts.get(partId);
            if (part?.type === "text" || part?.type === "reasoning") {
              yield* emitTextPart(state, turn, part, true);
            }
          }
        });

        const handleEvent = Effect.fnUntraced(function* (event: OpenCodeEvent) {
          yield* logProtocolEvent({
            direction: "incoming",
            messageKind: "notification",
            method: event.type,
            payload: event,
          });
          switch (event.type) {
            case "message.updated":
              yield* handleMessageUpdated(event);
              yield* handleAssistantCompleted(event);
              return;
            case "message.part.updated":
              yield* handlePartUpdated(event);
              return;
            case "message.part.delta":
              yield* handlePartDelta(event);
              return;
            case "todo.updated": {
              const state = threads.get(event.properties.sessionID);
              if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
                yield* emitTodo(state, state.activeTurn, event.properties.todos);
              }
              return;
            }
            case "permission.asked": {
              const state = threads.get(event.properties.sessionID);
              if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
                yield* emitRuntimeRequest(state, state.activeTurn, event.properties.id, {
                  type: "permission",
                  value: event.properties,
                });
              }
              return;
            }
            case "question.asked": {
              const state = threads.get(event.properties.sessionID);
              if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
                yield* emitRuntimeRequest(state, state.activeTurn, event.properties.id, {
                  type: "question",
                  value: event.properties,
                });
              }
              return;
            }
            case "permission.replied":
              yield* resolveRuntimeRequest(event.properties.requestID, "resolved");
              return;
            case "question.replied":
              yield* resolveRuntimeRequest(event.properties.requestID, "resolved");
              return;
            case "question.rejected":
              yield* resolveRuntimeRequest(event.properties.requestID, "cancelled");
              return;
            case "session.status": {
              const state = threads.get(event.properties.sessionID);
              if (state === undefined) return;
              if (event.properties.status.type === "busy") {
                yield* updateProviderThread(state, { status: "active" });
                return;
              }
              if (event.properties.status.type === "idle" && state.activeTurn !== null) {
                yield* finalizeTurn(
                  state,
                  state.activeTurn,
                  state.activeTurn.interrupted ? "interrupted" : "completed",
                );
              }
              return;
            }
            case "session.idle": {
              const state = threads.get(event.properties.sessionID);
              if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
                yield* finalizeTurn(
                  state,
                  state.activeTurn,
                  state.activeTurn.interrupted ? "interrupted" : "completed",
                );
              }
              return;
            }
            case "session.error": {
              const states =
                event.properties.sessionID === undefined
                  ? Array.from(threads.values()).filter((state) => state.activeTurn !== null)
                  : [threads.get(event.properties.sessionID)].filter(
                      (state): state is OpenCodeThreadState => state !== undefined,
                    );
              const message = openCodeErrorMessage(event);
              if (
                !isMessageAbortedError(event) &&
                (event.properties.sessionID === undefined ||
                  states.some((state) => state.parentSubagent === null))
              ) {
                yield* updateProviderSession("error", message);
              }
              for (const state of states) {
                if (state.activeTurn !== null) {
                  yield* finalizeTurn(
                    state,
                    state.activeTurn,
                    terminalStatusForError(event, state.activeTurn),
                    {
                      failure: makeProviderFailure({
                        message,
                        code: event.properties.error?.name ?? null,
                        class: "provider_error",
                      }),
                      threadDisposition:
                        event.properties.sessionID === undefined ? "broken" : "reusable",
                    },
                  );
                }
              }
              return;
            }
            default:
              return;
          }
        });

        const inputProviderSessionId = input.providerSessionId;

        const subscription = yield* sdkCall("event.subscribe", {}, () =>
          client.event.subscribe(undefined, { signal: abortController.signal }),
        );
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => abortController.abort()),
        );
        yield* Stream.fromAsyncIterable(
          subscription.stream,
          (cause) =>
            new OpenCodeRuntimeError({
              operation: "event.subscribe",
              detail: openCodeRuntimeErrorDetail(cause),
              cause,
            }),
        ).pipe(
          Stream.runForEach(handleEvent),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              if (abortController.signal.aborted || Exit.isSuccess(exit)) return;
              const detail = openCodeRuntimeErrorDetail(Cause.squash(exit.cause));
              yield* updateProviderSession("error", detail);
              for (const state of threads.values()) {
                if (state.activeTurn !== null)
                  yield* finalizeTurn(state, state.activeTurn, "failed", {
                    failure: makeProviderFailure({ message: detail, class: "transport_error" }),
                    threadDisposition: "broken",
                  });
              }
            }),
          ),
          Effect.forkIn(scope),
        );

        if (!connection.external && connection.exitCode !== null) {
          yield* connection.exitCode.pipe(
            Effect.flatMap((code) =>
              abortController.signal.aborted
                ? Effect.void
                : Effect.gen(function* () {
                    const detail = `OpenCode server exited unexpectedly (${code}).`;
                    yield* updateProviderSession("error", detail);
                    for (const state of threads.values()) {
                      if (state.activeTurn !== null) {
                        yield* finalizeTurn(state, state.activeTurn, "failed", {
                          failure: makeProviderFailure({
                            message: detail,
                            class: "transport_error",
                          }),
                          threadDisposition: "broken",
                        });
                      }
                    }
                  }),
            ),
            Effect.forkIn(scope),
          );
        }

        const registerThread = (
          nativeSession: OpenCodeSession,
          providerThread: OrchestrationV2ProviderThread,
          appThread: OrchestrationV2AppThread | null,
        ): OpenCodeThreadState => {
          const existing = threads.get(nativeSession.id);
          if (existing !== undefined) {
            existing.providerThread = providerThread;
            if (appThread !== null) existing.appThread = appThread;
            return existing;
          }
          const state: OpenCodeThreadState = {
            nativeSessionId: nativeSession.id,
            providerThread,
            appThread,
            activeTurn: null,
            providerTurns: new Map(),
            messages: new Map(),
            runtimeRequests: new Map(),
            messageRoles: new Map(),
            userMessageIds: [],
            parentSubagent: subagentsByChildSessionId.get(nativeSession.id) ?? null,
            nextChildTurnOrdinal: 1,
          };
          threads.set(nativeSession.id, state);
          return state;
        };

        const resolvePromptParts = (turnInput: ProviderAdapterV2TurnInput) => {
          const text = turnInput.message.text.trim();
          const files = toOpenCodeFileParts({
            attachments: turnInput.message.attachments,
            resolveAttachmentPath: (attachment) =>
              resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
          });
          if (text.length === 0 && files.length === 0) {
            throw protocolError("OpenCode turns require text or at least one valid attachment");
          }
          return [...(text.length === 0 ? [] : [{ type: "text" as const, text }]), ...files];
        };

        const readSnapshot = Effect.fnUntraced(function* (
          providerThread: OrchestrationV2ProviderThread,
        ) {
          const sessionId = nativeThreadId(providerThread);
          const response = yield* sdkCall("session.messages", { sessionID: sessionId }, () =>
            client.session.messages({ sessionID: sessionId }),
          );
          const nativeMessages = unwrapData("session.messages", response);
          const state = threads.get(sessionId);
          const snapshotNow = yield* DateTime.now;
          const messages: Array<OrchestrationV2ConversationMessage> = nativeMessages.flatMap(
            ({ info, parts }) => {
              const text = parts
                .filter(
                  (part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text",
                )
                .filter((part) => part.ignored !== true && part.synthetic !== true)
                .map((part) => part.text)
                .join("\n");
              if (text.length === 0) return [];
              const createdAt = dateTimeFromEpoch(info.time.created, snapshotNow);
              return [
                {
                  createdBy: info.role === "user" ? "user" : "agent",
                  creationSource: "provider",
                  id: idAllocator.derive.messageFromProviderItem({
                    driver: OPENCODE_PROVIDER,
                    nativeItemId: info.id,
                  }),
                  threadId: providerThread.appThreadId ?? input.threadId,
                  runId: null,
                  nodeId: null,
                  role: info.role,
                  text,
                  attachments: [],
                  streaming: false,
                  createdAt,
                  updatedAt:
                    info.role === "assistant"
                      ? dateTimeFromEpoch(info.time.completed, createdAt)
                      : createdAt,
                },
              ];
            },
          );
          const lastUser = nativeMessages.findLast(({ info }) => info.role === "user")?.info.id;
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

        const runtimeSession: ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver: OPENCODE_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: sessionEntity,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              if (threadInput.existingProviderThread !== undefined) {
                return yield* runtimeSession.resumeThread({
                  providerThread: threadInput.existingProviderThread,
                });
              }
              const response = yield* sdkCall(
                "session.create",
                {
                  title: `T3 Code ${threadInput.threadId}`,
                  permission: openCodePermissionRules(threadInput.runtimePolicy),
                },
                () =>
                  client.session.create({
                    title: `T3 Code ${threadInput.threadId}`,
                    permission: openCodePermissionRules(threadInput.runtimePolicy),
                  }),
              );
              const nativeSession = unwrapData("session.create", response);
              const createdAt = yield* DateTime.now;
              const providerThread = makeProviderThread({
                idAllocator,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                nativeSession,
                now: createdAt,
              });
              registerThread(nativeSession, providerThread, null);
              return providerThread;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterEnsureThreadError({
                    driver: OPENCODE_PROVIDER,
                    threadId: threadInput.threadId,
                    cause,
                  }),
              ),
            ),
          resumeThread: (threadInput) =>
            Effect.gen(function* () {
              const sessionId = nativeThreadId(threadInput.providerThread);
              const response = yield* sdkCall("session.get", { sessionID: sessionId }, () =>
                client.session.get({ sessionID: sessionId }),
              );
              const nativeSession = unwrapData("session.get", response);
              const resumedAt = yield* DateTime.now;
              const providerThread = {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                status: "idle" as const,
                updatedAt: dateTimeFromEpoch(nativeSession.time.updated, resumedAt),
              };
              registerThread(nativeSession, providerThread, null);
              return providerThread;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterResumeThreadError({
                    driver: OPENCODE_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const sessionId = nativeThreadId(turnInput.providerThread);
              const state = threads.get(sessionId);
              if (state === undefined) {
                return yield* protocolError(`OpenCode session ${sessionId} is not registered`);
              }
              if (state.activeTurn !== null) {
                return yield* protocolError(
                  `OpenCode provider thread ${turnInput.providerThread.id} already has an active turn`,
                );
              }
              const parsedModel = parseOpenCodeModelSlug(turnInput.modelSelection.model);
              if (parsedModel === null) {
                return yield* protocolError(
                  `OpenCode model '${turnInput.modelSelection.model}' must use provider/model format`,
                );
              }
              const parts = resolvePromptParts(turnInput);
              const startedAt = yield* DateTime.now;
              const syntheticNativeTurnId = `${sessionId}:attempt:${turnInput.attemptId}`;
              const providerTurnId = idAllocator.derive.providerTurn({
                driver: OPENCODE_PROVIDER,
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
              const turn: ActiveOpenCodeTurn = {
                isRoot: true,
                threadId: turnInput.threadId,
                runId: turnInput.runId,
                rootNodeId: turnInput.rootNodeId,
                appThread: turnInput.appThread,
                modelSelection: turnInput.modelSelection,
                runtimePolicy: turnInput.runtimePolicy,
                providerTurnId,
                providerTurnOrdinal: turnInput.providerTurnOrdinal,
                runOrdinal: turnInput.runOrdinal,
                runAttemptId: turnInput.attemptId,
                startedAt,
                itemOrdinals: new Map(),
                parts: new Map(),
                partIdsByMessage: new Map(),
                providerTurn,
                nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
                nativeUserMessageId: null,
                interrupted: false,
                finalized: false,
                planId: null,
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
              const agent =
                getModelSelectionStringOptionValue(turnInput.modelSelection, "agent") ??
                (turnInput.runtimePolicy.interactionMode === "plan" ? "plan" : undefined);
              const variant = getModelSelectionStringOptionValue(
                turnInput.modelSelection,
                "variant",
              );
              yield* sdkCall(
                "session.promptAsync",
                {
                  sessionID: sessionId,
                  model: parsedModel,
                  ...(agent === undefined ? {} : { agent }),
                  ...(variant === undefined ? {} : { variant }),
                  ...(orchestrationSystemPrompt === undefined
                    ? {}
                    : { system: orchestrationSystemPrompt }),
                  parts,
                },
                () =>
                  client.session.promptAsync({
                    sessionID: sessionId,
                    model: parsedModel,
                    ...(agent === undefined ? {} : { agent }),
                    ...(variant === undefined ? {} : { variant }),
                    ...(orchestrationSystemPrompt === undefined
                      ? {}
                      : { system: orchestrationSystemPrompt }),
                    parts,
                  }),
              ).pipe(
                Effect.tapError((cause) =>
                  finalizeTurn(state, turn, "failed", {
                    failure: makeProviderFailure({ cause, class: "provider_error" }),
                  }),
                ),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: OPENCODE_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
          steerTurn: (steerInput) =>
            Effect.gen(function* () {
              const sessionId = nativeThreadId(steerInput.providerThread);
              const state = threads.get(sessionId);
              const turn = state?.activeTurn;
              if (
                turn === undefined ||
                turn === null ||
                turn.providerTurnId !== steerInput.providerTurnId
              ) {
                return yield* protocolError(
                  `OpenCode turn ${steerInput.providerTurnId} is not active`,
                );
              }
              const parsedModel = parseOpenCodeModelSlug(turn.modelSelection.model);
              if (parsedModel === null) {
                return yield* protocolError(
                  `OpenCode model '${turn.modelSelection.model}' must use provider/model format`,
                );
              }
              const text = steerInput.message.text.trim();
              const files = toOpenCodeFileParts({
                attachments: steerInput.message.attachments,
                resolveAttachmentPath: (attachment) =>
                  resolveAttachmentPath({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachment,
                  }),
              });
              if (text.length === 0 && files.length === 0) {
                return yield* protocolError("OpenCode steering requires text or an attachment");
              }
              const parts = [
                ...(text.length === 0 ? [] : [{ type: "text" as const, text }]),
                ...files,
              ];
              yield* sdkCall(
                "session.promptAsync",
                { sessionID: sessionId, model: parsedModel, parts },
                () =>
                  client.session.promptAsync({
                    sessionID: sessionId,
                    model: parsedModel,
                    parts,
                  }),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterSteerRunError({
                    driver: OPENCODE_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
          interruptTurn: (interruptInput) =>
            Effect.gen(function* () {
              const sessionId = nativeThreadId(interruptInput.providerThread);
              const state = threads.get(sessionId);
              const turn = state?.activeTurn;
              if (
                turn === undefined ||
                turn === null ||
                turn.providerTurnId !== interruptInput.providerTurnId
              ) {
                return yield* protocolError(
                  `OpenCode turn ${interruptInput.providerTurnId} is not active`,
                );
              }
              turn.interrupted = true;
              yield* sdkCall("session.abort", { sessionID: sessionId }, () =>
                client.session.abort({ sessionID: sessionId }),
              ).pipe(Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))));
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    driver: OPENCODE_PROVIDER,
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
                  `No pending OpenCode request ${requestInput.requestId}`,
                );
              }
              if (pending.question !== undefined) {
                if (requestInput.answers === undefined) {
                  return yield* protocolError(
                    `OpenCode question request ${requestInput.requestId} requires answers`,
                  );
                }
                const answers = toOpenCodeQuestionAnswers(pending.question, requestInput.answers);
                yield* sdkCall(
                  "question.reply",
                  { requestID: pending.nativeRequestId, answers },
                  () =>
                    client.question.reply({
                      requestID: pending.nativeRequestId,
                      answers,
                    }),
                );
                return;
              }
              if (requestInput.decision === undefined) {
                return yield* protocolError(
                  `OpenCode approval request ${requestInput.requestId} requires a decision`,
                );
              }
              const reply = toOpenCodePermissionReply(requestInput.decision);
              yield* sdkCall(
                "permission.reply",
                { requestID: pending.nativeRequestId, reply },
                () =>
                  client.permission.reply({
                    requestID: pending.nativeRequestId,
                    reply,
                  }),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRuntimeRequestResponseError({
                    driver: OPENCODE_PROVIDER,
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
                    driver: OPENCODE_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          rollbackThread: (rollbackInput) =>
            Effect.gen(function* () {
              const sessionId = nativeThreadId(rollbackInput.providerThread);
              const state = threads.get(sessionId);
              if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
                return yield* protocolError(
                  `Cannot roll back OpenCode thread ${rollbackInput.providerThread.id} while a turn is active`,
                );
              }
              const response = yield* sdkCall("session.messages", { sessionID: sessionId }, () =>
                client.session.messages({ sessionID: sessionId }),
              );
              const messages = unwrapData("session.messages", response);
              let boundaryMessageId: string | undefined;
              if (rollbackInput.target.type === "thread_start") {
                boundaryMessageId = messages.find(({ info }) => info.role === "user")?.info.id;
              } else {
                boundaryMessageId = openCodeBoundaryAfterProviderTurn(
                  rollbackInput.providerThreadTurns,
                  rollbackInput.target.providerTurn.id,
                );
              }
              if (boundaryMessageId !== undefined) {
                yield* sdkCall(
                  "session.revert",
                  { sessionID: sessionId, messageID: boundaryMessageId },
                  () =>
                    client.session.revert({ sessionID: sessionId, messageID: boundaryMessageId }),
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
                    driver: OPENCODE_PROVIDER,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
              ),
            ),
          forkThread: (forkInput) =>
            Effect.gen(function* () {
              const sourceSessionId = nativeThreadId(forkInput.sourceProviderThread);
              const sourceState = threads.get(sourceSessionId);
              if (sourceState?.activeTurn !== null && sourceState?.activeTurn !== undefined) {
                return yield* protocolError(
                  `Cannot fork OpenCode thread ${forkInput.sourceProviderThread.id} while a turn is active`,
                );
              }
              let boundaryMessageId: string | undefined;
              if (forkInput.providerTurnId !== undefined) {
                const sourceTurns = forkInput.sourceProviderTurns ?? [];
                const selected = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
                if (selected === undefined) {
                  return yield* protocolError(
                    `OpenCode fork boundary turn ${forkInput.providerTurnId} was not found`,
                  );
                }
                boundaryMessageId = openCodeBoundaryAfterProviderTurn(sourceTurns, selected.id);
              }
              const response = yield* sdkCall(
                "session.fork",
                {
                  sessionID: sourceSessionId,
                  ...(boundaryMessageId === undefined ? {} : { messageID: boundaryMessageId }),
                },
                () =>
                  client.session.fork({
                    sessionID: sourceSessionId,
                    ...(boundaryMessageId === undefined ? {} : { messageID: boundaryMessageId }),
                  }),
              );
              const nativeSession = unwrapData("session.fork", response);
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
              registerThread(nativeSession, providerThread, null);
              return providerThread;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterForkThreadError({
                    driver: OPENCODE_PROVIDER,
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
                driver: OPENCODE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
}

export type OpenCodeAdapterV2DriverEnv =
  | OpenCodeRuntime
  | IdAllocatorV2
  | ProviderEventLoggers
  | ServerConfig;

export const OpenCodeAdapterV2Driver: ProviderAdapterDriver<
  OpenCodeSettings,
  OpenCodeAdapterV2DriverEnv
> = {
  driverKind: OPENCODE_DRIVER_KIND,
  configSchema: OpenCodeSettingsSchema,
  defaultConfig: (): OpenCodeSettings => DEFAULT_OPENCODE_SETTINGS,
  create: Effect.fn("OpenCodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OpenCodeSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const idAllocator = yield* IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      return makeOpenCodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        runtime: openCodeRuntime,
        idAllocator,
        serverConfig,
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
              driver: OPENCODE_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create OpenCode v2 adapter.",
              cause,
            }),
        ),
      ),
  ),
};

export const layer: Layer.Layer<ProviderAdapterV2, never, OpenCodeAdapterV2DriverEnv> =
  Layer.effect(
    ProviderAdapterV2,
    Effect.gen(function* () {
      const hostEnvironment = yield* HostProcessEnvironment;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const idAllocator = yield* IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      return makeOpenCodeAdapterV2({
        instanceId: OPENCODE_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_OPENCODE_SETTINGS,
        environment: hostEnvironment,
        runtime: openCodeRuntime,
        idAllocator,
        serverConfig,
        ...(providerEventLoggers.native === undefined
          ? {}
          : { nativeEventLogger: providerEventLoggers.native }),
      });
    }),
  );
