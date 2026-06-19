import { CodexSettings, defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type {
  ChatAttachment,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2PlanStep,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderTurnId,
  ProviderInstanceId,
  RuntimeMode,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS } from "../../provider/codex/CodexDeveloperInstructions.ts";
import {
  type EventNdjsonLogger,
  makeEventNdjsonLogger,
} from "../../provider/Layers/EventNdjsonLogger.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "../ProviderAdapterDriver.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
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
  type ProviderAdapterV2ForkThreadInput,
  type ProviderAdapterV2RollbackThreadInput,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "../SubagentProjection.ts";

const CODEX_PROVIDER = "codex" as const;
export const CODEX_DRIVER_KIND = ProviderDriverKind.make(CODEX_PROVIDER);
export const CODEX_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER_KIND);
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_CLIENT_INFO = {
  name: "t3code_desktop",
  title: "T3 Code Desktop",
  version: "0.1.0",
} as const;
const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: true,
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
} satisfies OrchestrationV2ProviderCapabilities;

function toProtocolError(detail: string, payload?: unknown): ProviderAdapterProtocolError {
  return new ProviderAdapterProtocolError({
    provider: CODEX_PROVIDER,
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

export interface CodexDynamicToolProjection {
  readonly toolName: string;
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

function codexDynamicToolOutput(
  item: Extract<CodexDynamicToolItem, { readonly type: "dynamicToolCall" }>,
): unknown | undefined {
  if (item.contentItems !== null && item.contentItems !== undefined) {
    return item.contentItems;
  }
  return item.success === false ? { success: false } : undefined;
}

export function projectCodexDynamicToolItem(
  item: CodexDynamicToolItem,
): CodexDynamicToolProjection {
  const output =
    item.type === "mcpToolCall" ? codexMcpToolOutput(item) : codexDynamicToolOutput(item);
  const toolName =
    item.type === "mcpToolCall"
      ? `${item.server}.${item.tool}`
      : [trimText(item.namespace), item.tool].filter(Boolean).join(".");
  const projection: CodexDynamicToolProjection = {
    toolName,
    input: item.arguments,
    status: codexItemStatus(item.status).turnItem,
  };
  return output === undefined ? projection : { ...projection, output };
}

function codexNativeItemRef(nativeItemId: string) {
  return {
    provider: CODEX_PROVIDER,
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
      return "approved_for_session";
    case "decline":
      return "denied";
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
): CodexSchema.ToolRequestUserInputResponse["answers"] {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      { answers: [...answerValueToStrings(value)] },
    ]),
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
    collaborationMode: Schema.optionalKey(CodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;

function codexRuntimeModeTurnDefaults(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexSchema.V2TurnStartParams__AskForApproval;
  readonly sandboxPolicy: CodexSchema.V2TurnStartParams__SandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandboxPolicy: {
          type: "readOnly",
        },
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "full-access":
      return {
        approvalPolicy: "never",
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
  readonly model: string;
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
    const effort =
      input.runtimePolicy.reasoningEffort === undefined
        ? undefined
        : yield* decodeTurnReasoningEffort(input.runtimePolicy.reasoningEffort);
    const collaborationMode: CodexSchema.V2TurnStartParams__CollaborationMode | undefined =
      input.runtimePolicy.interactionMode === "plan"
        ? {
            mode: "plan",
            settings: {
              model: input.model,
              reasoning_effort: effort ?? "medium",
              developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
            },
          }
        : undefined;

    return yield* Schema.decodeUnknownEffect(CodexTurnStartParamsWithCollaborationMode)({
      threadId: input.nativeThreadId,
      input: input.codexInput,
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(effort === undefined ? {} : { effort }),
      ...(collaborationMode === undefined ? {} : { collaborationMode }),
    });
  });
}

function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    provider: CODEX_PROVIDER,
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
      provider: CODEX_PROVIDER,
      nativeThreadId: input.thread.id,
    }),
    provider: CODEX_PROVIDER,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId,
    nativeThreadRef: {
      provider: CODEX_PROVIDER,
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

const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
  turn.status === "completed" ||
  turn.status === "interrupted" ||
  turn.status === "failed" ||
  turn.status === "cancelled";

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
        provider: CODEX_PROVIDER,
        providerThreadId: input.sourceProviderThread.id,
        cause: `Cannot fork Codex thread from provider turn ${input.providerTurnId}: source turn was not found in provider thread ${input.sourceProviderThread.id}.`,
      });
    }

    return rollbackTurnCount;
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
            provider: CODEX_PROVIDER,
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
            provider: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
            cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${input.target.providerTurn.id}: target turn was not found in durable provider turn history.`,
          });
        }

        return rollbackTurnCount;
      }
    }
  },
);

interface ActiveCodexTurnContext {
  readonly input: ProviderAdapterV2TurnInput;
  readonly projectionThreadId: ThreadId;
  readonly projectionRunId: ProviderAdapterV2TurnInput["runId"] | null;
  readonly nativeTurnId: string;
  readonly providerTurnId: ProviderTurnId;
  readonly providerTurnOrdinal: number;
  readonly providerNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerNodeKind: OrchestrationV2ExecutionNode["kind"];
  readonly providerNodeStartedAt: DateTime.Utc | null;
  readonly itemParentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly subagent: CodexSubagentThreadContext | null;
  readonly startedAt: DateTime.Utc;
}

interface CodexSubagentThreadContext {
  readonly parentContext: ActiveCodexTurnContext;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly subagentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childThreadId: ThreadId;
  readonly nativeToolCallId: string;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  task: OrchestrationV2Subagent;
}

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

export interface CodexAppServerClientFactoryShape {
  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  }) => Effect.Effect<
    CodexClient.CodexAppServerClientShape,
    ProviderAdapterOpenSessionError,
    Scope.Scope
  >;
}

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryShape
>()("t3/orchestration-v2/Adapters/CodexAdapterV2/CodexAppServerClientFactory") {}

export function codexAppServerMcpLaunchConfig(threadId: ThreadId): {
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
} | null {
  const session = McpProviderSession.readMcpProviderSession(threadId);
  return session === undefined
    ? null
    : {
        args: [
          "-c",
          `mcp_servers.t3-code.url=${session.endpoint}`,
          "-c",
          'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
        ],
        environment: {
          T3_MCP_BEARER_TOKEN: session.authorizationHeader.replace(/^Bearer\s+/, ""),
        },
      };
}

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

export const makeCodexAppServerClientFactoryCommandLayer = (
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
            const mcp = codexAppServerMcpLaunchConfig(input.threadId);
            const command = yield* makeCodexAppServerSpawnCommand({
              command: options.command,
              args: [...(options.args ?? []), ...(mcp?.args ?? [])],
              ...((input.runtimePolicy.cwd ?? options.cwd) === undefined
                ? {}
                : { cwd: input.runtimePolicy.cwd ?? options.cwd }),
              ...(options.env === undefined && mcp === null
                ? {}
                : {
                    env: {
                      ...options.env,
                      ...mcp?.environment,
                    },
                    extendEnv: true,
                  }),
            });
            const handle = yield* spawner.spawn(command).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterOpenSessionError({
                    provider: CODEX_PROVIDER,
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

  return (event) =>
    nativeEventLogger
      .write(
        {
          provider: CODEX_PROVIDER,
          protocol: "codex.app-server",
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event,
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
}

export const codexAppServerClientFactoryFromSettingsLayer: Layer.Layer<
  CodexAppServerClientFactory,
  never,
  ChildProcessSpawner.ChildProcessSpawner | ServerConfig | ServerSettingsService
> = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { providerEventLogPath } = yield* ServerConfig;
    const settingsService = yield* ServerSettingsService;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });

    return CodexAppServerClientFactory.of({
      open: (input) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const mcp = codexAppServerMcpLaunchConfig(input.threadId);
          const environment = {
            ...input.environment,
            ...(input.settings.homePath ? { CODEX_HOME: input.settings.homePath } : {}),
            ...mcp?.environment,
          };
          const command = yield* makeCodexAppServerSpawnCommand({
            command: input.settings.binaryPath || "codex",
            args: ["app-server", ...(mcp?.args ?? [])],
            ...(input.runtimePolicy.cwd === null ? {} : { cwd: input.runtimePolicy.cwd }),
            env: environment,
          });
          const handle = yield* spawner.spawn(command).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  provider: CODEX_PROVIDER,
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
  | FileSystem.FileSystem
  | IdAllocatorV2
  | Path.Path
  | ServerConfig;

export const CodexAdapterV2Driver: ProviderAdapterDriver<CodexSettings, CodexAdapterV2DriverEnv> = {
  driverKind: CODEX_DRIVER_KIND,
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => DEFAULT_CODEX_SETTINGS,
  create: ({ instanceId, environment, enabled, config }) =>
    Effect.gen(function* () {
      const clientFactory = yield* CodexAppServerClientFactory;
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
              detail: cause.message,
              cause,
            }),
        ),
      );

      const settings = {
        ...config,
        enabled,
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;

      return makeCodexAdapterV2({
        instanceId,
        settings,
        environment: mergeProviderInstanceEnvironment(environment, hostEnvironment),
        clientFactory,
        fileSystem,
        idAllocator,
        serverConfig,
      });
    }),
};

export const layer: Layer.Layer<
  ProviderAdapterV2,
  never,
  CodexAppServerClientFactory | FileSystem.FileSystem | IdAllocatorV2 | ServerConfig
> = Layer.effect(
  ProviderAdapterV2,
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcessEnvironment;
    const idAllocator = yield* IdAllocatorV2;
    const serverConfig = yield* ServerConfig;

    return makeCodexAdapterV2({
      instanceId: CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: hostEnvironment,
      clientFactory,
      fileSystem,
      idAllocator,
      serverConfig,
    });
  }),
);

export interface CodexAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly clientFactory: CodexAppServerClientFactoryShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly serverConfig: ServerConfigShape;
}

export function makeCodexAdapterV2(adapterOptions: CodexAdapterV2Options): ProviderAdapterV2Shape {
  const { clientFactory, fileSystem, idAllocator, serverConfig } = adapterOptions;

  return ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    provider: CODEX_PROVIDER,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    openSession: (input) =>
      Effect.gen(function* () {
        const client = yield* clientFactory.open({
          instanceId: adapterOptions.instanceId,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
          runtimePolicy: input.runtimePolicy,
          settings: adapterOptions.settings,
          environment: adapterOptions.environment,
        });
        const initialized = yield* Ref.make(false);
        const ensureInitialized = Effect.gen(function* () {
          const alreadyInitialized = yield* Ref.get(initialized);
          if (alreadyInitialized) {
            return;
          }

          yield* client.request("initialize", {
            clientInfo: CODEX_CLIENT_INFO,
            capabilities: CODEX_CLIENT_CAPABILITIES,
          });
          yield* client.notify("initialized", undefined);
          yield* Ref.set(initialized, true);
        });
        const now = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const activeTurns = yield* Ref.make(new Map<string, ActiveCodexTurnContext>());
        const turnWaiters = yield* Ref.make(new Map<string, Deferred.Deferred<void, never>>());
        const subagentThreads = yield* Ref.make(new Map<string, CodexSubagentThreadContext>());
        const pendingSubagentTurns = yield* Ref.make(
          new Map<string, ReadonlyArray<PendingCodexSubagentTurnStarted>>(),
        );
        const nextProviderTurnOrdinals = yield* Ref.make(new Map<string, number>());
        const itemOrdinals = yield* Ref.make(new Map<string, number>());
        const nextItemOrdinalsByTurn = yield* Ref.make(new Map<string, number>());
        const agentMessageDeltas = yield* Ref.make(new Map<string, string>());
        const planDeltas = yield* Ref.make(new Map<string, string>());
        const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());
        const pendingRuntimeRequests = yield* Ref.make(
          new Map<string, PendingCodexRuntimeRequest>(),
        );

        const emitProviderEvent = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const findActiveTurnByNativeThreadId = (nativeThreadId: string) =>
          Effect.gen(function* () {
            const turns = Array.from((yield* Ref.get(activeTurns)).values());
            return turns.find(
              (context) => context.providerThread.nativeThreadRef?.nativeId === nativeThreadId,
            );
          });

        const resolveItemOrdinal = (context: ActiveCodexTurnContext, nativeItemId: string) =>
          Effect.gen(function* () {
            const existing = (yield* Ref.get(itemOrdinals)).get(nativeItemId);
            if (existing !== undefined) {
              return existing;
            }

            const turnKey = context.nativeTurnId;
            const nextWithinTurn = yield* Ref.modify(nextItemOrdinalsByTurn, (current) => {
              const next = (current.get(turnKey) ?? 0) + 1;
              const updated = new Map(current);
              updated.set(turnKey, next);
              return [next, updated];
            });
            const nextOrdinal = context.providerTurnOrdinal * 100 + nextWithinTurn;
            yield* Ref.update(itemOrdinals, (current) => {
              const updated = new Map(current);
              updated.set(nativeItemId, nextOrdinal);
              return updated;
            });
            return nextOrdinal;
          });

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
        }) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const terminal =
              input.status === "completed" ||
              input.status === "failed" ||
              input.status === "cancelled" ||
              input.status === "interrupted";
            const completedAt = terminal ? (input.completedAt ?? now) : null;
            const task = {
              ...input.subagent.task,
              status: input.status,
              result: input.result === undefined ? input.subagent.task.result : input.result,
              completedAt,
              updatedAt: now,
            } satisfies OrchestrationV2Subagent;
            input.subagent.task = task;

            yield* emitProviderEvent({
              type: "subagent.updated",
              provider: CODEX_PROVIDER,
              subagent: task,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
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
                provider: task.provider,
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
            const providerTurnId = idAllocator.derive.providerTurn({
              provider: CODEX_PROVIDER,
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
                    provider: CODEX_PROVIDER,
                    nativeItemId: `${turn.nativeTurnId}:thread-root`,
                  });
            const activeContext: ActiveCodexTurnContext = {
              input: subagent.parentContext.input,
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
            };
            yield* Ref.update(activeTurns, (current) => {
              const updated = new Map(current);
              updated.set(turn.nativeTurnId, activeContext);
              return updated;
            });
            const now = yield* DateTime.now;
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              provider: CODEX_PROVIDER,
              providerThread: {
                ...subagent.providerThread,
                status: "active",
                updatedAt: now,
              },
            });
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              provider: CODEX_PROVIDER,
              threadId: subagent.childThreadId,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: subagent.providerThread.id,
                nodeId: providerNodeId,
                runAttemptId: null,
                nativeTurnRef: {
                  provider: CODEX_PROVIDER,
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
              provider: CODEX_PROVIDER,
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

        const registerSubagentThreads = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly item: Extract<
            CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "collabAgentToolCall" }
          >;
        }) =>
          Effect.gen(function* () {
            if (input.item.tool !== "spawnAgent" || input.item.receiverThreadIds.length === 0) {
              return;
            }

            const now = yield* DateTime.now;
            for (const [index, nativeThreadId] of input.item.receiverThreadIds.entries()) {
              const registeredSubagents = yield* Ref.get(subagentThreads);
              if (registeredSubagents.has(nativeThreadId)) {
                continue;
              }

              const nativeItemId = `${input.item.id}:${nativeThreadId}`;
              const subagentNodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId,
              });
              const childRootNodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: `${nativeItemId}:thread-root`,
              });
              const childThreadId = idAllocator.derive.threadFromProviderThread({
                provider: CODEX_PROVIDER,
                nativeThreadId,
              });
              const turnItemOrdinal = yield* resolveItemOrdinal(input.context, nativeItemId);
              const providerThread = {
                id: idAllocator.derive.providerThread({
                  provider: CODEX_PROVIDER,
                  nativeThreadId,
                }),
                provider: CODEX_PROVIDER,
                providerSessionId: input.context.providerThread.providerSessionId,
                appThreadId: childThreadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  provider: CODEX_PROVIDER,
                  nativeId: nativeThreadId,
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
              const task = {
                id: subagentNodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.rootNodeId,
                origin: "provider_native",
                createdBy: "agent",
                provider: CODEX_PROVIDER,
                providerThreadId: providerThread.id,
                childThreadId,
                nativeTaskRef: codexNativeItemRef(nativeItemId),
                prompt: input.item.prompt ?? "",
                title: null,
                model:
                  typeof input.item.model === "string" && input.item.model.length > 0
                    ? input.item.model
                    : null,
                status: "running",
                result: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
              } satisfies OrchestrationV2Subagent;
              const subagent = {
                parentContext: input.context,
                providerThread,
                subagentNodeId,
                childRootNodeId,
                childThreadId,
                nativeToolCallId: input.item.id,
                ordinal: index + 1,
                startedAt: now,
                turnItemId: idAllocator.derive.turnItemFromProviderItem({
                  provider: CODEX_PROVIDER,
                  nativeItemId,
                }),
                turnItemOrdinal,
                task,
              } satisfies CodexSubagentThreadContext;

          const emitProviderEvent = (event: ProviderAdapterV2Event) =>
            Queue.offer(events, event).pipe(Effect.asVoid);

          const findActiveTurnByNativeThreadId = (nativeThreadId: string) =>
            Effect.gen(function* () {
              const turns = Array.from((yield* Ref.get(activeTurns)).values());
              return turns.find(
                (context) =>
                  context.input.providerThread.nativeThreadRef?.nativeId === nativeThreadId,
              );
            });

          const resolveItemOrdinal = (context: ActiveCodexTurnContext, nativeItemId: string) =>
            Effect.gen(function* () {
              const existing = (yield* Ref.get(itemOrdinals)).get(nativeItemId);
              if (existing !== undefined) {
                return existing;
              }

              const turnKey = context.nativeTurnId;
              const nextWithinTurn = yield* Ref.modify(nextItemOrdinalsByTurn, (current) => {
                const next = (current.get(turnKey) ?? 0) + 1;
                const updated = new Map(current);
                updated.set(turnKey, next);
                return [next, updated];
              });
              const nextOrdinal = context.providerTurnOrdinal * 100 + nextWithinTurn;
              yield* Ref.update(itemOrdinals, (current) => {
                const updated = new Map(current);
                updated.set(nativeItemId, nextOrdinal);
                return updated;
              });
              const childThread = makeSubagentChildThread({
                parentThread: input.context.input.appThread,
                childThreadId,
                parentNodeId: subagentNodeId,
                activeProviderThreadId: providerThread.id,
                providerInstanceId: input.context.input.modelSelection.instanceId,
                modelSelection: {
                  ...input.context.input.modelSelection,
                  model: task.model ?? input.context.input.modelSelection.model,
                },
                title: subagentThreadTitle({
                  parentTitle: input.context.input.appThread.title,
                  prompt: task.prompt,
                  title: task.title,
                  ordinal: index + 1,
                }),
                now,
                createdBy: "agent",
                creationSource: "provider",
              });
              const promptNativeItemId = `${nativeItemId}:prompt`;
              const promptArtifacts = makeSubagentConversationArtifacts({
                messageId: idAllocator.derive.messageFromProviderItem({
                  provider: CODEX_PROVIDER,
                  nativeItemId: promptNativeItemId,
                }),
                turnItemId: idAllocator.derive.turnItemFromProviderItem({
                  provider: CODEX_PROVIDER,
                  nativeItemId: promptNativeItemId,
                }),
                threadId: childThreadId,
                rootNodeId: childRootNodeId,
                providerThreadId: providerThread.id,
                providerTurnId: null,
                nativeItemRef: codexNativeItemRef(promptNativeItemId),
                role: "user",
                text: task.prompt,
                ordinal: 100,
                now,
              });
              yield* emitProviderEvent({
                type: "app_thread.created",
                provider: CODEX_PROVIDER,
                appThread: childThread,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: {
                  id: subagentNodeId,
                  threadId: input.context.input.threadId,
                  runId: input.context.input.runId,
                  parentNodeId: input.context.rootNodeId,
                  rootNodeId: input.context.rootNodeId,
                  kind: "subagent",
                  status: "running",
                  countsForRun: false,
                  providerThreadId: providerThread.id,
                  providerTurnId: input.context.providerTurnId,
                  nativeItemRef: codexNativeItemRef(input.item.id),
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt: now,
                  completedAt: null,
                },
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
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
                  nativeItemRef: codexNativeItemRef(nativeItemId),
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt: now,
                  completedAt: null,
                },
              });
              yield* emitProviderEvent({
                type: "provider_thread.updated",
                provider: CODEX_PROVIDER,
                providerThread,
              });
              yield* emitProviderEvent({
                type: "message.updated",
                provider: CODEX_PROVIDER,
                message: promptArtifacts.message,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: promptArtifacts.turnItem,
              });
              yield* emitSubagentTaskUpdate({
                subagent,
                status: "running",
              });

          const resolvePlanId = (context: ActiveCodexTurnContext, planKey: string) =>
            Effect.gen(function* () {
              const existing = (yield* Ref.get(planIds)).get(planKey);
              if (existing !== undefined) {
                return existing;
              }
              const planId = yield* idAllocator.allocate.plan({
                threadId: context.input.threadId,
                runId: context.input.runId,
                provider: CODEX_PROVIDER,
              });
              yield* Ref.update(planIds, (current) => {
                const updated = new Map(current);
                updated.set(planKey, planId);
                return updated;
              });
              return planId;
            });

        const updateSubagentStates = (input: {
          readonly item: Extract<
            CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "collabAgentToolCall" }
          >;
        }) =>
          Effect.gen(function* () {
            if (input.item.tool !== "spawnAgent") {
              return;
            }

            const subagents = yield* Ref.get(subagentThreads);
            for (const [nativeThreadId, state] of Object.entries(input.item.agentsStates)) {
              const subagent = subagents.get(nativeThreadId);
              if (subagent === undefined) {
                continue;
              }
              const nativeStatus = String(state.status);
              const status: OrchestrationV2Subagent["status"] =
                nativeStatus === "completed"
                  ? "completed"
                  : nativeStatus === "failed" || nativeStatus === "errored"
                    ? "failed"
                    : nativeStatus === "cancelled" || nativeStatus === "closed"
                      ? "cancelled"
                      : "running";
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
              provider: CODEX_PROVIDER,
            });

          const toCodexInput = (
            turnInput: Pick<ProviderAdapterV2TurnInput | ProviderAdapterV2SteerInput, "message">,
          ) =>
            Effect.gen(function* () {
              const inputItems: Array<CodexSchema.V2TurnStartParams__UserInput> = [];
              if (turnInput.message.text.length > 0) {
                inputItems.push({
                  type: "text",
                  text: turnInput.message.text,
                });
              }
              const attachmentItems = yield* Effect.forEach(
                turnInput.message.attachments,
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
            item: Extract<
              CodexSchema.V2ItemCompletedNotification__ThreadItem,
              { type: "agentMessage" }
            >,
          ) =>
            Effect.gen(function* () {
              const completedAt = yield* DateTime.now;
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const ordinal = yield* resolveItemOrdinal(context, item.id);
              const messageId = idAllocator.derive.messageFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                parentNodeId: context.input.rootNodeId,
                rootNodeId: context.input.rootNodeId,
                kind: "assistant_message",
                status: "completed",
                countsForRun: false,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: context.startedAt,
                completedAt,
              };
              const message: OrchestrationV2ConversationMessage = {
                id: messageId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming: false,
                createdAt: completedAt,
                updatedAt: completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: context.startedAt,
                completedAt,
                updatedAt: completedAt,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming: false,
              };
              return { node, message, turnItem };
            });

          const buildCommandExecutionArtifacts = (
            context: ActiveCodexTurnContext,
            item: Extract<
              CodexSchema.V2ItemCompletedNotification__ThreadItem,
              { type: "commandExecution" }
            >,
          ) =>
            Effect.gen(function* () {
              const updatedAt = yield* DateTime.now;
              const status = codexItemStatus(item.status);
              const completedAt = status.completed ? updatedAt : null;
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const ordinal = yield* resolveItemOrdinal(context, item.id);
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                parentNodeId: context.input.rootNodeId,
                rootNodeId: context.input.rootNodeId,
                kind: "tool_call",
                status: status.node,
                countsForRun: false,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                parentItemId: null,
                ordinal,
                status: status.turnItem,
                title: null,
                startedAt: context.startedAt,
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
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const ordinal = yield* resolveItemOrdinal(context, item.id);
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                parentNodeId: context.input.rootNodeId,
                rootNodeId: context.input.rootNodeId,
                kind: "tool_call",
                status: status.node,
                countsForRun: false,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                parentItemId: null,
                ordinal,
                status: status.turnItem,
                title: null,
                startedAt: context.startedAt,
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
                provider: CODEX_PROVIDER,
                nativeItemId: input.item.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.item.id,
              });
              const ordinal = yield* resolveItemOrdinal(input.context, input.item.id);
              const patterns = webSearchPatterns(input.item);
              const status = input.completed ? "completed" : "running";
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.input.rootNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "tool_call",
                status,
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.item.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: input.context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.item.id),
                parentItemId: null,
                ordinal,
                status,
                title: null,
                startedAt: input.context.startedAt,
                completedAt,
                updatedAt,
                type: "web_search",
                ...(patterns.length === 0 ? {} : { patterns: [...patterns] }),
              };
              return { node, turnItem };
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
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
              const plan: OrchestrationV2PlanArtifact = {
                id: planId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                kind: "proposed_plan",
                status: input.status,
                markdown: input.markdown,
              };
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.input.rootNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "plan",
                status: input.completed === true ? "completed" : "running",
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: input.context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                parentItemId: null,
                ordinal,
                status: input.completed === true ? "completed" : "running",
                title: null,
                startedAt: input.context.startedAt,
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
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
              const plan: OrchestrationV2PlanArtifact = {
                id: planId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                kind: "todo_list",
                status: input.status,
                steps: [...input.steps],
                ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
              };
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.input.rootNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "todo_list",
                status: input.completed === true ? "completed" : "running",
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: input.context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                parentItemId: null,
                ordinal,
                status: input.completed === true ? "completed" : "running",
                title: null,
                startedAt: input.context.startedAt,
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
          }) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const parentNodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const ordinal = yield* resolveItemOrdinal(
                input.context,
                `${input.nativeItemId}:approval:${input.nativeRequestId}`,
              );
              const requestId = yield* idAllocator.allocate.runtimeRequest({
                provider: CODEX_PROVIDER,
                providerTurnId: input.context.providerTurnId,
                nativeRequestId: input.nativeRequestId,
              });
              const nodeId = idAllocator.derive.approvalNode({ requestId });
              const providerSessionId = input.context.input.providerThread.providerSessionId;
              if (providerSessionId === null) {
                return yield* toProtocolError(
                  `Provider thread ${input.context.input.providerThread.id} is missing a provider session id.`,
                );
              }
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "approval_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
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
                  provider: CODEX_PROVIDER,
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
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
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
              };
              return { node, request, turnItem };
            });

          const buildUserInputRequestArtifacts = (input: {
            readonly context: ActiveCodexTurnContext;
            readonly nativeItemId: string;
            readonly nativeRequestId: string;
            readonly questions: ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion>;
          }) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const requestId = yield* idAllocator.allocate.runtimeRequest({
                provider: CODEX_PROVIDER,
                providerTurnId: input.context.providerTurnId,
                nativeRequestId: input.nativeRequestId,
              });
              const providerSessionId = input.context.input.providerThread.providerSessionId;
              if (providerSessionId === null) {
                return yield* toProtocolError(
                  `Provider thread ${input.context.input.providerThread.id} is missing a provider session id.`,
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
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.input.rootNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "user_input_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
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
                  provider: CODEX_PROVIDER,
                  nativeId: input.nativeRequestId,
                  strength: "strong",
                },
                kind: "user_input",
                status: "pending",
                responseCapability: {
                  type: "live",
                  providerSessionId,
                },
                createdAt,
                resolvedAt: null,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
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
              };
              return { node, request, turnItem };
            });

          yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
            Ref.update(agentMessageDeltas, (current) => {
              const updated = new Map(current);
              updated.set(payload.itemId, `${updated.get(payload.itemId) ?? ""}${payload.delta}`);
              return updated;
            }),
          );

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
            if (turnInput.message.text.length > 0) {
              inputItems.push({
                type: "text",
                text: turnInput.message.text,
              });
            }
            const attachmentItems = yield* Effect.forEach(
              turnInput.message.attachments,
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
          item: Extract<
            CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "agentMessage" }
          >,
        ) =>
          Effect.gen(function* () {
            const completedAt = yield* DateTime.now;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const ordinal = yield* resolveItemOrdinal(context, item.id);
            const messageId = idAllocator.derive.messageFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "assistant_message",
              status: "completed",
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: context.startedAt,
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
              streaming: false,
              createdAt: completedAt,
              updatedAt: completedAt,
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
              status: "completed",
              title: null,
              startedAt: context.startedAt,
              completedAt,
              updatedAt: completedAt,
              type: "assistant_message",
              messageId,
              text: item.text,
              streaming: false,
            };
            return { node, message, turnItem };
          });

        const emitSubagentUserMessage = (
          context: ActiveCodexTurnContext,
          item: Extract<
            | CodexSchema.V2ItemStartedNotification__ThreadItem
            | CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "userMessage" }
          >,
        ) =>
          Effect.gen(function* () {
            if (context.subagent === null || context.providerTurnOrdinal === 1) {
              return false;
            }
            const text = codexUserMessageText(item.content);
            if (text.length === 0) {
              return false;
            }
            const now = yield* DateTime.now;
            const ordinal = yield* resolveItemOrdinal(context, item.id);
            const artifacts = makeSubagentConversationArtifacts({
              messageId: idAllocator.derive.messageFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
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
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              provider: CODEX_PROVIDER,
              message: artifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
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
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const ordinal = yield* resolveItemOrdinal(context, item.id);
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
              startedAt: context.startedAt,
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
              startedAt: context.startedAt,
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
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const ordinal = yield* resolveItemOrdinal(context, item.id);
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
              startedAt: context.startedAt,
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
              startedAt: context.startedAt,
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
              provider: CODEX_PROVIDER,
              nativeItemId: input.item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: input.item.id,
            });
            const ordinal = yield* resolveItemOrdinal(input.context, input.item.id);
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
              startedAt: input.context.startedAt,
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
              startedAt: input.context.startedAt,
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
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const ordinal = yield* resolveItemOrdinal(context, item.id);
            const projection = projectCodexDynamicToolItem(item);
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
              startedAt: context.startedAt,
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
              status: projection.status,
              title: null,
              startedAt: context.startedAt,
              completedAt,
              updatedAt,
              type: "dynamic_tool",
              toolName: projection.toolName,
              input: projection.input,
              ...(projection.output === undefined ? {} : { output: projection.output }),
            };
            return { node, turnItem };
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
              provider: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
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
              startedAt: input.context.startedAt,
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
              startedAt: input.context.startedAt,
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
              provider: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
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
              startedAt: input.context.startedAt,
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
              startedAt: input.context.startedAt,
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
        }) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            const parentNodeId = idAllocator.derive.nodeFromProviderItem({
              provider: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const ordinal = yield* resolveItemOrdinal(
              input.context,
              `${input.nativeItemId}:approval:${input.nativeRequestId}`,
            );
            const requestId = yield* idAllocator.allocate.runtimeRequest({
              provider: CODEX_PROVIDER,
              providerTurnId: input.context.providerTurnId,
              nativeRequestId: input.nativeRequestId,
            });
            const nodeId = idAllocator.derive.approvalNode({ requestId });
            const providerSessionId = input.context.input.providerThread.providerSessionId;
            if (providerSessionId === null) {
              return yield* toProtocolError(
                `Provider thread ${input.context.providerThread.id} is missing a provider session id.`,
              );
            }
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "approval_request",
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
                provider: CODEX_PROVIDER,
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
              type: "approval_request",
              requestId,
              requestKind: input.requestKind,
              ...(input.prompt === null || input.prompt === undefined
                ? {}
                : { prompt: input.prompt }),
            };
            return { node, request, turnItem };
          });

        const buildUserInputRequestArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly nativeRequestId: string;
          readonly questions: ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion>;
        }) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            const requestId = yield* idAllocator.allocate.runtimeRequest({
              provider: CODEX_PROVIDER,
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
              provider: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              provider: CODEX_PROVIDER,
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
                provider: CODEX_PROVIDER,
                nativeId: input.nativeRequestId,
                strength: "strong",
              },
              kind: "user_input",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId,
              },
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
            };
            return { node, request, turnItem };
          });

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(agentMessageDeltas, (current) => {
            const updated = new Map(current);
            updated.set(payload.itemId, `${updated.get(payload.itemId) ?? ""}${payload.delta}`);
            return updated;
          }),
        );

        yield* client.handleServerNotification("item/plan/delta", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
            if (context === undefined) {
              return;
            }
            const markdown = yield* Ref.modify(planDeltas, (current) => {
              const updated = new Map(current);
              const next = `${updated.get(payload.itemId) ?? ""}${payload.delta}`;
              updated.set(payload.itemId, next);
              return [next, updated];
            });
            const artifacts = yield* buildProposedPlanArtifacts({
              context,
              nativeItemId: payload.itemId,
              status: "active",
              markdown,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "plan.updated",
              provider: CODEX_PROVIDER,
              plan: artifacts.plan,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("turn/plan/updated", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
            if (context === undefined) {
              return;
            }
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
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "plan.updated",
              provider: CODEX_PROVIDER,
              plan: artifacts.plan,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("turn/started", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
            if (context !== undefined) {
              return;
            }
            yield* rememberSubagentTurnStarted({
              nativeThreadId: payload.threadId,
              nativeTurnId: payload.turn.id,
              startedAt: codexTimestamp(payload.turn.startedAt),
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("item/started", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
            if (context === undefined) {
              return;
            }

            if (payload.item.type === "userMessage") {
              if (yield* emitSubagentUserMessage(context, payload.item)) {
                return;
              }
            }

            if (payload.item.type === "commandExecution") {
              const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "mcpToolCall" || payload.item.type === "dynamicToolCall") {
              const artifacts = yield* buildDynamicToolArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
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
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("item/completed", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
            if (context === undefined) {
              return;
            }

            if (payload.item.type === "userMessage") {
              if (yield* emitSubagentUserMessage(context, payload.item)) {
                return;
              }
            }

            if (payload.item.type === "commandExecution") {
              const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "mcpToolCall" || payload.item.type === "dynamicToolCall") {
              const artifacts = yield* buildDynamicToolArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "fileChange") {
              const artifacts = yield* buildFileChangeArtifacts(context, payload.item);
              if (artifacts === null) {
                return;
              }
              const markdown = yield* Ref.modify(planDeltas, (current) => {
                const updated = new Map(current);
                const next = `${updated.get(payload.itemId) ?? ""}${payload.delta}`;
                updated.set(payload.itemId, next);
                return [next, updated];
              });
              const artifacts = yield* buildProposedPlanArtifacts({
                context,
                nativeItemId: payload.itemId,
                status: "active",
                markdown,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "plan.updated",
                provider: CODEX_PROVIDER,
                plan: artifacts.plan,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerNotification("turn/plan/updated", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return;
              }
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
              yield* updateSubagentStates({
                item: payload.item,
              });
              return;
            }

            if (payload.item.type !== "agentMessage") {
              return;
            }

            const deltas = yield* Ref.get(agentMessageDeltas);
            const text =
              payload.item.text.length > 0
                ? payload.item.text
                : (deltas.get(payload.item.id) ?? "");
            const artifacts = yield* buildAgentMessageArtifacts(context, {
              ...payload.item,
              text,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              provider: CODEX_PROVIDER,
              message: artifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            if (
              context.subagent !== null &&
              context.providerTurnOrdinal === 1 &&
              payload.item.phase !== "commentary"
            ) {
              yield* emitSubagentTaskUpdate({
                subagent: context.subagent,
                status: context.subagent.task.status,
                result: text,
              });
            }
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
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
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              provider: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
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
              decision: resolved,
            } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
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
              ...(payload.reason === undefined ? {} : { prompt: payload.reason }),
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
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              provider: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
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
              decision: resolved,
            } satisfies CodexSchema.FileChangeRequestApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/permissions/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
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
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              provider: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
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
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              provider: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
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
              prompt: payload.reason ?? Object.keys(payload.fileChanges).join(", "),
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
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              provider: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
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
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
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
              provider: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              provider: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CODEX_PROVIDER,
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
              answers: toCodexUserInputAnswers(resolved),
            } satisfies CodexSchema.ToolRequestUserInputResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("turn/completed", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
            if (context === undefined) {
              return;
            }
            const completedAt = codexTimestamp(payload.turn.completedAt);
            const status = mapCodexTurnStatus(payload.turn.status);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              provider: CODEX_PROVIDER,
              threadId: context.projectionThreadId,
              providerTurn: {
                id: context.providerTurnId,
                providerThreadId: context.providerThread.id,
                nodeId: context.providerNodeId,
                runAttemptId: context.subagent === null ? context.input.attemptId : null,
                nativeTurnRef: {
                  provider: CODEX_PROVIDER,
                  nativeId: payload.turn.id,
                  strength: "strong",
                },
                ordinal: context.providerTurnOrdinal,
                status,
                startedAt: context.startedAt,
                completedAt,
              },
            });
            if (context.subagent !== null) {
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: {
                  id: context.providerNodeId,
                  threadId: context.projectionThreadId,
                  runId: null,
                  parentNodeId: null,
                  rootNodeId: context.rootNodeId,
                  kind: "root_turn",
                  status,
                  countsForRun: false,
                  providerThreadId: context.providerThread.id,
                  providerTurnId: context.providerTurnId,
                  nativeItemRef: context.subagent.task.nativeTaskRef,
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt: context.providerNodeStartedAt,
                  completedAt,
                },
              });
              yield* emitProviderEvent({
                type: "plan.updated",
                provider: CODEX_PROVIDER,
                plan: artifacts.plan,
              });
              if (context.providerTurnOrdinal === 1) {
                yield* emitProviderEvent({
                  type: "node.updated",
                  provider: CODEX_PROVIDER,
                  node: {
                    id: context.subagent.subagentNodeId,
                    threadId: context.subagent.parentContext.projectionThreadId,
                    runId: context.subagent.parentContext.projectionRunId,
                    parentNodeId: context.subagent.parentContext.rootNodeId,
                    rootNodeId: context.subagent.parentContext.rootNodeId,
                    kind: "subagent",
                    status,
                    countsForRun: false,
                    providerThreadId: context.providerThread.id,
                    providerTurnId: context.subagent.parentContext.providerTurnId,
                    nativeItemRef: context.subagent.task.nativeTaskRef,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: context.subagent.startedAt,
                    completedAt,
                  },
                });
                yield* emitSubagentTaskUpdate({
                  subagent: context.subagent,
                  status,
                  completedAt,
                });
              }
            }
            if (context.subagent === null) {
              yield* emitProviderEvent({
                type: "turn.terminal",
                provider: CODEX_PROVIDER,
                providerTurnId: context.providerTurnId,
                status: providerTurnStatusToTerminal(status),
              });
            }
            const waiter = (yield* Ref.get(turnWaiters)).get(payload.turn.id);
            if (waiter !== undefined) {
              yield* Deferred.succeed(waiter, undefined);
            }
            yield* Ref.update(activeTurns, (current) => {
              const updated = new Map(current);
              updated.delete(payload.turn.id);
              return updated;
            });
          }),
        );

        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: CODEX_DEFAULT_INSTANCE_ID,
          provider: CODEX_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          rawEvents: Stream.empty,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: (threadInput) =>
            ensureInitialized.pipe(
              Effect.andThen(client.request("thread/start", {})),
              Effect.map(
                (response): OrchestrationV2ProviderThread =>
                  providerThreadFromCodexThread({
                    appThreadId: threadInput.threadId,
                    idAllocator,
                    ownerNodeId: null,
                    providerSessionId: input.providerSessionId,
                    thread: response.thread,
                  }),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterEnsureThreadError({
                    provider: CODEX_PROVIDER,
                    threadId: threadInput.threadId,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          resumeThread: (threadInput) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined || payload.item.type !== "webSearch") {
                return;
              }

              const artifacts = yield* buildWebSearchArtifacts({
                context,
                item: payload.item,
                completed: false,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerNotification("item/completed", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return;
              }

              if (payload.item.type === "commandExecution") {
                const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
                yield* emitProviderEvent({
                  type: "node.updated",
                  provider: CODEX_PROVIDER,
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
                    provider: CODEX_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: threadInput.providerThread.id,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(turnInput.providerThread);

              const codexInput = yield* toCodexInput(turnInput);
              const turnStartParams = yield* buildCodexTurnStartParams({
                nativeThreadId: threadId,
                codexInput,
                runtimePolicy: turnInput.runtimePolicy,
                model: turnInput.modelSelection.model,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              const providerTurnOrdinal = turnInput.providerTurnOrdinal;
              const context: ActiveCodexTurnContext = {
                input: turnInput,
                projectionThreadId: turnInput.threadId,
                projectionRunId: turnInput.runId,
                nativeTurnId,
                providerThread: turnInput.providerThread,
                providerTurnId: pTurnId,
                providerTurnOrdinal,
                providerNodeId: turnInput.rootNodeId,
                providerNodeKind: "root_turn",
                providerNodeStartedAt: startedAt,
                itemParentNodeId: turnInput.rootNodeId,
                rootNodeId: turnInput.rootNodeId,
                subagent: null,
                startedAt,
              };
              yield* Ref.update(activeTurns, (current) => {
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
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
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
                decision: resolved,
              } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
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
                ...(payload.reason === undefined ? {} : { prompt: payload.reason }),
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
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
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
                decision: resolved,
              } satisfies CodexSchema.FileChangeRequestApprovalResponse;
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerRequest("item/permissions/requestApproval", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
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
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
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
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
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
                prompt: payload.reason ?? Object.keys(payload.fileChanges).join(", "),
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
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
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
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
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
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
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
                answers: toCodexUserInputAnswers(resolved),
              } satisfies CodexSchema.ToolRequestUserInputResponse;
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerNotification("turn/completed", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
              if (context === undefined) {
                return;
              }
              const completedAt = codexTimestamp(payload.turn.completedAt);
              const status = mapCodexTurnStatus(payload.turn.status);
              yield* emitProviderEvent({
                type: "provider_turn.updated",
                provider: CODEX_PROVIDER,
                threadId: turnInput.threadId,
                providerTurn: {
                  id: context.providerTurnId,
                  providerThreadId: context.input.providerThread.id,
                  nodeId: context.input.rootNodeId,
                  runAttemptId: context.input.attemptId,
                  nativeTurnRef: {
                    provider: CODEX_PROVIDER,
                    nativeId: payload.turn.id,
                    strength: "strong",
                  },
                  ordinal: context.providerTurnOrdinal,
                  status,
                  startedAt: context.startedAt,
                  completedAt,
                },
              });
              yield* emitProviderEvent({
                type: "turn.terminal",
                provider: CODEX_PROVIDER,
                providerTurnId: context.providerTurnId,
                status: providerTurnStatusToTerminal(status),
              });
              const waiter = (yield* Ref.get(turnWaiters)).get(payload.turn.id);
              if (waiter !== undefined) {
                yield* Deferred.succeed(waiter, undefined);
              }
              yield* Ref.update(activeTurns, (current) => {
                const updated = new Map(current);
                updated.delete(payload.turn.id);
                return updated;
              });
            }),
          );

          const runtime: ProviderAdapterV2SessionRuntime = {
            provider: CODEX_PROVIDER,
            providerSessionId: input.providerSessionId,
            providerSession: session,
            rawEvents: Stream.empty,
            events: Stream.fromQueue(events),
            ensureThread: (threadInput) =>
              ensureInitialized.pipe(
                Effect.andThen(client.request("thread/start", {})),
                Effect.map(
                  (response): OrchestrationV2ProviderThread =>
                    providerThreadFromCodexThread({
                      appThreadId: threadInput.threadId,
                      idAllocator,
                      ownerNodeId: null,
                      providerSessionId: input.providerSessionId,
                      thread: response.thread,
                    }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterEnsureThreadError({
                      provider: CODEX_PROVIDER,
                      threadId: threadInput.threadId,
                      cause: normalizeCodexCause(cause),
                    }),
                ),
              ),
            resumeThread: (threadInput) =>
              Effect.gen(function* () {
                const nativeThreadId = yield* getNativeThreadId(threadInput.providerThread);

                const response = yield* ensureInitialized.pipe(
                  Effect.andThen(client.request("thread/resume", { threadId: nativeThreadId })),
                );
                return {
                  ...threadInput.providerThread,
                  providerSessionId: input.providerSessionId,
                  status: "idle",
                  nativeThreadRef: {
                    provider: CODEX_PROVIDER,
                    nativeId: response.thread.id,
                    strength: "strong",
                  },
                  updatedAt: codexTimestamp(response.thread.updatedAt),
                } satisfies OrchestrationV2ProviderThread;
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterResumeThreadError({
                      provider: CODEX_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause: normalizeCodexCause(cause),
                    }),
                ),
              ),
            startTurn: (turnInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(turnInput.providerThread);

                const codexInput = yield* toCodexInput(turnInput);
                const turnStartParams = yield* buildTurnStartParams({
                  nativeThreadId: threadId,
                  codexInput,
                  runtimePolicy: turnInput.runtimePolicy,
                  model: turnInput.modelSelection.model,
                });
                const started = yield* client.request("turn/start", turnStartParams);
                const nativeTurnId = started.turn.id;
                const startedAt = codexTimestamp(started.turn.startedAt);
                const pTurnId = idAllocator.derive.providerTurn({
                  provider: CODEX_PROVIDER,
                  nativeTurnId,
                });
                const providerTurnOrdinal = turnInput.runOrdinal;
                const context: ActiveCodexTurnContext = {
                  input: turnInput,
                  nativeTurnId,
                  providerTurnId: pTurnId,
                  providerTurnOrdinal,
                  startedAt,
                };
                yield* Ref.update(activeTurns, (current) => {
                  const updated = new Map(current);
                  updated.set(nativeTurnId, context);
                  return updated;
                });
                yield* emitProviderEvent({
                  type: "provider_turn.updated",
                  provider: CODEX_PROVIDER,
                  providerTurn: {
                    id: pTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      provider: CODEX_PROVIDER,
                      nativeId: nativeTurnId,
                      strength: "strong",
                    },
                    ordinal: providerTurnOrdinal,
                    status: "running",
                    startedAt,
                    completedAt: null,
                  },
                });
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterTurnStartError({
                      provider: CODEX_PROVIDER,
                      threadId: turnInput.threadId,
                      providerThreadId: turnInput.providerThread.id,
                      runId: turnInput.runId,
                      cause,
                    }),
                ),
              ),
            steerTurn: (turnInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(turnInput.providerThread);
                const activeTurn = Array.from((yield* Ref.get(activeTurns)).values()).find(
                  (candidate) => candidate.providerTurnId === turnInput.providerTurnId,
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
                      provider: CODEX_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
            interruptTurn: (turnInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(turnInput.providerThread);
                const activeTurn = Array.from((yield* Ref.get(activeTurns)).values()).find(
                  (candidate) => candidate.providerTurnId === turnInput.providerTurnId,
                );
                if (activeTurn === undefined) {
                  return yield* toProtocolError(
                    `Provider turn ${turnInput.providerTurnId} is not active and cannot be interrupted.`,
                  );
                }
                yield* client.request("turn/interrupt", {
                  threadId,
                  turnId: activeTurn.nativeTurnId,
                });
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterInterruptError({
                      provider: CODEX_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
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
                    provider: CODEX_PROVIDER,
                    requestId: requestInput.requestId,
                    cause: toProtocolError(
                      `No pending Codex runtime request ${requestInput.requestId}.`,
                    ),
                  });
                }
                if (pending.type === "user_input") {
                  if (requestInput.answers === undefined) {
                    return yield* new ProviderAdapterRuntimeRequestResponseError({
                      provider: CODEX_PROVIDER,
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
                    provider: CODEX_PROVIDER,
                    requestId: requestInput.requestId,
                    cause: toProtocolError(
                      `Codex ${pending.requestKind} request ${requestInput.requestId} requires an approval decision.`,
                    ),
                  });
                }
                yield* Deferred.succeed(pending.decision, requestInput.decision);
              }).pipe(
                Effect.mapError((cause) =>
                  Schema.is(ProviderAdapterRuntimeRequestResponseError)(cause)
                    ? cause
                    : new ProviderAdapterRuntimeRequestResponseError({
                        provider: CODEX_PROVIDER,
                        requestId: requestInput.requestId,
                        cause,
                      }),
                ),
              ),
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
                      provider: CODEX_PROVIDER,
                      nativeId: response.thread.id,
                      strength: "strong" as const,
                    },
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
                      provider: CODEX_PROVIDER,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
            rollbackThread: (threadInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(threadInput.providerThread);
                const numTurns =
                  typeof threadInput.providerPayload === "object" &&
                  threadInput.providerPayload !== null &&
                  "numTurns" in threadInput.providerPayload &&
                  typeof threadInput.providerPayload.numTurns === "number"
                    ? threadInput.providerPayload.numTurns
                    : 1;
                const response = yield* ensureInitialized.pipe(
                  Effect.andThen(client.request("thread/rollback", { threadId, numTurns })),
                );
                return {
                  providerThread: {
                    ...threadInput.providerThread,
                    nativeThreadRef: {
                      provider: CODEX_PROVIDER,
                      nativeId: response.thread.id,
                      strength: "strong" as const,
                    },
                    status: "idle" as const,
                    updatedAt: codexTimestamp(response.thread.updatedAt),
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
                    provider: CODEX_PROVIDER,
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
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(client.request("thread/rollback", { threadId, numTurns })),
              );
              return {
                providerThread: {
                  ...threadInput.providerThread,
                  nativeThreadRef: {
                    provider: CODEX_PROVIDER,
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
                    provider: CODEX_PROVIDER,
                    providerThreadId: threadInput.providerThread.id,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          forkThread: (threadInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(threadInput.sourceProviderThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(client.request("thread/fork", { threadId })),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterForkThreadError({
                      provider: CODEX_PROVIDER,
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
                provider: CODEX_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    });
  }),
);
