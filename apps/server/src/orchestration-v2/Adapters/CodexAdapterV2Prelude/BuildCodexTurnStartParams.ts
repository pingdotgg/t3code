import { pipe } from "effect/Function";
import { classifyCodexManagedError } from "../../../provider/CodexManagedErrors.ts";
import { codexDefaultReasoningEffortOverride } from "../../../provider/CodexProvider.ts";
import { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type { OrchestrationV2AppThread, OrchestrationV2ExecutionNode, ModelSelection, OrchestrationV2ProviderFailure, OrchestrationV2ProviderRetry, OrchestrationV2ProviderSession, OrchestrationV2ProviderThread, OrchestrationV2ProviderTurn, OrchestrationV2Subagent, OrchestrationV2TurnItem, ProviderUserInputAnswers, ProviderApprovalDecision, ProviderRequestKind, ProviderTurnId, ProviderInstanceId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { getCodexServiceTierOptionValue } from "../../../codexModelOptions.ts";
import { buildCodexAdditionalContext } from "../../../provider/CodexDeveloperInstructions.ts";
import { makeProviderRetryTurnItem } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CODEX_PROVIDER, CODEX_CAPACITY_MAX_RETRIES, CODEX_DRIVER_KIND, CODEX_DEFAULT_INSTANCE_ID, codexFileChangeApprovalPrompt, canReuseCodexContextUsage, codexProviderTurnTokenUsage, CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS, CODEX_PLAN_DELTA_FLUSH_INTERVAL_MS, CodexBackgroundTerminalTerminateResponse, CodexBackgroundTerminalsListResponse, decodeCodexBackgroundTerminalTerminateResponse, decodeCodexBackgroundTerminalsListResponse, CODEX_CLIENT_CAPABILITIES, CodexProviderCapabilitiesV2, toProtocolError, CODEX_THREAD_IN_USE_MESSAGE, isCodexAppServerRequestError, isCodexActiveWriterError, codexTimestamp, codexUserMessageText, mapCodexTurnStatus, providerTurnStatusToTerminal, codexItemStatus, codexSkillMentionText, BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH, BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH, codexBackgroundCommandDetail, codexNativeSubagentLabel, codexNativeSubagentDetail, codexMcpToolOutput, MCP_APP_CAPTURE_TIMEOUT, codexMcpAppResourceUri, CODEX_IMAGE_DATA_URL, codexDynamicToolOutput, projectCodexDynamicToolItem, codexNativeItemRef, trimText, nonEmptyText, codexPlanStepStatus, approvalDecisionToLegacyReviewDecision, providerRequestKindFromPermissions, permissionsResponseFromDecision, answerValueToStrings, toCodexUserInputAnswers, compactStrings, webSearchPatterns, decodeTurnApprovalPolicy, decodeTurnSandboxPolicy, decodeTurnReasoningEffort, decodeCodexTurnStartParamsWithCollaborationMode, isProviderAdapterRuntimeRequestResponseError, type CodexFileChangeKinds, type CodexBackgroundTerminalsListPage, type CodexDynamicToolProjection, type CodexTurnStartParamsWithCollaborationMode, type CodexWebSearchItem, type CodexDynamicToolItem } from "./CodexProviderCapabilitiesV2.ts";

export function codexRuntimeModeTurnDefaults(runtimeMode: RuntimeMode): {
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

export const buildCodexTurnStartParams = Effect.fn("CodexAdapterV2.buildCodexTurnStartParams")(
function* (input: {
  readonly nativeThreadId: string;
  readonly codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly hasT3Mcp?: boolean;
  readonly browserToolsAvailable?: boolean;
  readonly deviceToolsAvailable?: boolean;
  /** ChatGPT token sharing does not accept service tiers. */
  readonly omitServiceTier?: boolean;
  readonly appContext?: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"];
}) {
  const runtimeModeDefaults = codexRuntimeModeTurnDefaults(input.runtimePolicy.runtimeMode);
  const approvalPolicy =
    input.runtimePolicy.approvalPolicy === undefined
      ? runtimeModeDefaults.approvalPolicy
      : yield* decodeTurnApprovalPolicy(input.runtimePolicy.approvalPolicy);
  const sandboxPolicy =
    input.runtimePolicy.sandboxPolicy === undefined
      ? runtimeModeDefaults.sandboxPolicy
      : yield* decodeTurnSandboxPolicy(input.runtimePolicy.sandboxPolicy);
  const selectedEffort =
    getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
    codexDefaultReasoningEffortOverride(input.modelSelection.model);
  const effort =
    selectedEffort === undefined ? undefined : yield* decodeTurnReasoningEffort(selectedEffort);
  const serviceTier =
    input.omitServiceTier === true
      ? undefined
      : getCodexServiceTierOptionValue(input.modelSelection);
  // MCP-written app context must be quoted user input, not developer instructions.
  const appContext = Object.fromEntries(
    (input.appContext ?? []).map((entry) => [
      entry.key,
      { kind: "untrusted" as const, value: entry.text },
    ]),
  );
  const t3Context =
    input.hasT3Mcp === true
      ? buildCodexAdditionalContext(
          { model: input.modelSelection.model, reasoningEffort: effort ?? undefined },
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
  return yield* decodeCodexTurnStartParamsWithCollaborationMode({
    threadId: input.nativeThreadId,
    input: input.codexInput,
    ...(additionalContext ? { additionalContext } : {}),
    cwd: input.runtimePolicy.cwd,
    model: input.modelSelection.model,
    // Catalogues can default summaries to "none"; request them explicitly on every turn.
    summary: "detailed",
    // Omitting the reviewer on resume preserves the previous Auto reviewer.
    approvalsReviewer: runtimeModeDefaults.approvalsReviewer,
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(effort === undefined ? {} : { effort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    // Codex supplies its own mode instructions; send both modes to clear Plan on exit.
    collaborationMode: {
      mode: input.runtimePolicy.interactionMode,
      settings: {
        model: input.modelSelection.model,
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      },
    },
  });
},
);

export function providerSession(input: {
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

export const getNativeThreadId = Effect.fn("CodexAdapterV2.getNativeThreadId")(function* (
providerThread: OrchestrationV2ProviderThread,
) {
const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
if (nativeThreadId === undefined || nativeThreadId === null) {
  return yield* toProtocolError(
    `Provider thread ${providerThread.id} is missing a native Codex thread id.`,
  );
}
return nativeThreadId;
});

export function providerThreadFromCodexThread(input: {
readonly appThreadId: ThreadId | null;
readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
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

export const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
turn.nativeTurnRef !== null &&
(turn.status === "completed" ||
  turn.status === "interrupted" ||
  turn.status === "failed" ||
  turn.status === "cancelled");

export class CodexGoalObjectiveTooLongError extends Schema.TaggedError<CodexGoalObjectiveTooLongError>()(
"CodexGoalObjectiveTooLongError",
{ length: Schema.Number, limit: Schema.Number },
) {
override get message() {
  return `The goal objective is ${this.length} characters; Codex supports at most ${this.limit}. Shorten it and send /goal again. The current goal was not changed.`;
}
}

export function validateCodexGoalObjective(objective: string) {
let length = 0;
for (const _ of objective) length++;
return length > CodexSchema.MAX_THREAD_GOAL_OBJECTIVE_CHARS
  ? Effect.fail(
      new CodexGoalObjectiveTooLongError({
        length,
        limit: CodexSchema.MAX_THREAD_GOAL_OBJECTIVE_CHARS,
      }),
    )
  : Effect.void;
}

export type CodexThreadGoal = CodexSchema.V2ThreadGoalUpdatedNotification["goal"];

export const CODEX_GOAL_STATUSES = {
active: "active",
paused: "paused",
blocked: "blocked",
usageLimited: "usage_limited",
budgetLimited: "budget_limited",
complete: "complete",
} as const satisfies Record<CodexThreadGoal["status"], OrchestrationV2ProviderGoal["status"]>;

export function providerGoalFromCodex(goal: CodexThreadGoal): OrchestrationV2ProviderGoal | null {
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

export const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));

export function describeCodexGoal(goal: OrchestrationV2ProviderGoal): string {
return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}

export const CODEX_GOAL_CONTINUATION_GRACE = "5 seconds";

export const providerTurnsForThread = (
providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
providerThread: OrchestrationV2ProviderThread,
): ReadonlyArray<OrchestrationV2ProviderTurn> =>
providerTurns.filter((turn) => turn.providerThreadId === providerThread.id);

export const countTerminalTurnsAfterBoundary = (
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

export const resolveCodexForkRollbackTurnCount = Effect.fn("CodexAdapterV2.resolveForkRollbackTurnCount")(
function* (input: ProviderAdapter.ProviderAdapterV2ForkThreadInput) {
  if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
    return 0;
  }

  const rollbackTurnCount = countTerminalTurnsAfterBoundary(
    providerTurnsForThread(input.sourceProviderTurns, input.sourceProviderThread),
    input.providerTurnId,
  );
  if (rollbackTurnCount === null) {
    return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
      driver: CODEX_PROVIDER,
      providerThreadId: input.sourceProviderThread.id,
      cause: `Cannot fork Codex thread from provider turn ${input.providerTurnId}: source turn was not found in provider thread ${input.sourceProviderThread.id}.`,
    });
  }

  return rollbackTurnCount;
},
);

export const resolveCodexForkBoundary = Effect.fn("CodexAdapterV2.resolveForkBoundary")(function* (
input: ProviderAdapter.ProviderAdapterV2ForkThreadInput,
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

export const CodexThreadHistoryMetadata = Schema.Struct({
thread: Schema.Struct({
  historyMode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
  status: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
}),
});

export const decodeCodexThreadHistoryMetadata = Schema.decodeUnknownEffect(CodexThreadHistoryMetadata);

export const readCodexThreadHistoryMetadata = Effect.fn("CodexAdapterV2.readThreadHistoryMetadata")(
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
function* (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) {
  const providerTurns = input.providerThreadTurns;
  switch (input.target.type) {
    case "thread_start":
      return providerTurns.filter(isTerminalProviderTurn).length;
    case "provider_turn": {
      if (input.target.providerTurn.providerThreadId !== input.providerThread.id) {
        return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
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
        return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
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

export function parseCodexRetryProgress(
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

export function codexErrorInfoCode(value: unknown): string | null {
if (typeof value === "string") {
  return value;
}
if (typeof value !== "object" || value === null) {
  return null;
}
return Object.keys(value)[0] ?? null;
}

export type CodexErrorInfo = CodexSchema.ServerNotification__CodexErrorInfo;

export function codexExhaustionHttpStatus(errorInfo: CodexErrorInfo | null | undefined): number | null {
return typeof errorInfo === "object" &&
  errorInfo !== null &&
  "responseTooManyFailedAttempts" in errorInfo
  ? (errorInfo.responseTooManyFailedAttempts.httpStatusCode ?? null)
  : null;
}

export function codexUsageLimitError(
code: string | null,
errorInfo: CodexErrorInfo | null | undefined,
): boolean {
return (
  code === "usageLimitExceeded" ||
  code === "rateLimitExceeded" ||
  codexExhaustionHttpStatus(errorInfo) === 429
);
}

export function withCodexManagedFailure(
failure: OrchestrationV2ProviderFailure,
nativeError: unknown,
): OrchestrationV2ProviderFailure {
const managed = classifyCodexManagedError(nativeError);
return managed === undefined
  ? failure
  : { ...failure, message: managed.message, code: managed.code };
}

export interface ActiveCodexTurnContext {
hookStopReason?: string;
capacityRetryAttempt?: number;
capacityRetryPending?: Deferred.Deferred<ActiveCodexTurnContext | undefined>;
closedCommandItemIds?: ReadonlySet<string>;
latestProviderFailure?: {
  readonly nativeMessage: string;
  readonly nativeCode: string | null;
  readonly failure: OrchestrationV2ProviderFailure;
};
readonly nativeStartReady?: Deferred.Deferred<void>;
readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
readonly projectionAppThread: OrchestrationV2AppThread;
readonly projectionThreadId: ThreadId;
readonly projectionRunId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
readonly nativeTurnId: string;
readonly providerThread: OrchestrationV2ProviderThread;
readonly providerTurnId: ProviderTurnId;
readonly providerTurnOrdinal: number;
readonly providerNodeId: OrchestrationV2ExecutionNode["id"];
readonly providerNodeStartedAt: DateTime.Utc | null;
readonly itemParentNodeId: OrchestrationV2ExecutionNode["id"];
readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
readonly subagent: CodexSubagentThreadContext | null;
readonly startedAt: DateTime.Utc;
readonly runningCompactionItemIds: Set<string>;
// Modern approval requests omit paths; keep the kinds without retaining patch bodies.
readonly fileChangeKindsByItem: Map<string, CodexFileChangeKinds>;
readonly itemPositions: Map<
  string,
  { readonly ordinal: number; readonly startedAt: DateTime.Utc }
>;
}

export interface ActiveCodexProviderRetry {
readonly context?: ActiveCodexTurnContext;
readonly nativeMessage: string;
readonly nativeCode: string | null;
readonly retry: OrchestrationV2ProviderRetry;
readonly failure: OrchestrationV2ProviderFailure;
readonly startedAt: DateTime.Utc;
readonly itemOrdinal: number;
}

export function codexRetryTurnItem(
activeContext: ActiveCodexTurnContext,
state: ActiveCodexProviderRetry,
status: Parameters<typeof makeProviderRetryTurnItem>[0]["status"],
updatedAt: DateTime.Utc,
) {
// A continuation keeps the retry row attached to the native turn that failed.
const context = state.context ?? activeContext;
return makeProviderRetryTurnItem({
  driver: CODEX_PROVIDER,
  threadId: context.projectionThreadId,
  runId: context.projectionRunId,
  nodeId: context.providerNodeId,
  providerThreadId: context.providerThread.id,
  providerTurnId: context.providerTurnId,
  itemOrdinal: state.itemOrdinal,
  failure: state.failure,
  retry: state.retry,
  status,
  startedAt: state.startedAt,
  updatedAt,
});
}

export interface TrackedRunningCommandItem {
readonly id: string;
readonly command: string;
readonly aggregatedOutput?: string;
readonly processId?: string;
}

export function isPersistentCodexDynamicTool(item: CodexDynamicToolItem): boolean {
const input = item.arguments;
if (input === null || typeof input !== "object" || Array.isArray(input)) {
  return false;
}
return Reflect.get(input, "persistent") === true;
}

export type CodexRootTerminalEvent = Extract<
ProviderAdapter.ProviderAdapterV2Event,
{ readonly type: "turn.terminal" }
>;

export interface CodexGoalHold {
readonly context: ActiveCodexTurnContext;
readonly event: Extract<CodexRootTerminalEvent, { readonly failure: null }>;
readonly completedTurn: OrchestrationV2ProviderTurn;
readonly next: Deferred.Deferred<ActiveCodexTurnContext | undefined>;
}

export interface DeferredCodexRootTerminal {
readonly context: ActiveCodexTurnContext;
readonly event: CodexRootTerminalEvent;
}

export interface CodexSubagentThreadContext {
parentContext: ActiveCodexTurnContext;
readonly providerThread: OrchestrationV2ProviderThread;
readonly childThread: OrchestrationV2AppThread;
readonly subagentNodeId: OrchestrationV2ExecutionNode["id"];
readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
readonly childThreadId: ThreadId;
readonly nativeTurnIds: Set<string>;
startedAt: DateTime.Utc;
readonly turnItemId: OrchestrationV2TurnItem["id"];
readonly turnItemOrdinal: number;
task: OrchestrationV2Subagent;
}

export const approvalOwnerCodexTurn = (
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

export const isDescendantCodexTurn = (
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

export interface PendingCodexSubagentTurnStarted {
readonly nativeTurnId: string;
readonly startedAt: DateTime.Utc;
}

export type PendingCodexRuntimeRequest =
| {
    readonly type: "approval";
    readonly requestKind: ProviderRequestKind;
    readonly decision: Deferred.Deferred<ProviderApprovalDecision, never>;
  }
| {
    readonly type: "user_input";
    readonly answers: Deferred.Deferred<ProviderUserInputAnswers, never>;
  };

export type CodexCollabAgentToolCallItem = Extract<
CodexSchema.V2ItemCompletedNotification__ThreadItem,
{ readonly type: "collabAgentToolCall" }
>;
