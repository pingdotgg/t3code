import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  CopilotSettings,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderTurnId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeCopilotAdapter } from "../../provider/Layers/CopilotAdapter.ts";
import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import type { CopilotAdapterShape } from "../../provider/Services/CopilotAdapter.ts";
import { IdAllocatorV2, type IdAllocatorV2Error, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterEventStreamError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2ForkThreadInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2ReadThreadSnapshotInput,
  type ProviderAdapterV2RollbackThreadInput,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import { makeSubagentChildThread, subagentThreadTitle } from "../SubagentProjection.ts";

export const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");
const DEFAULT_COPILOT_SETTINGS = Schema.decodeSync(CopilotSettings)({});
const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapterRuntimeRequestResponseError,
);
const isProviderAdapterRollbackThreadError = Schema.is(ProviderAdapterRollbackThreadError);

export const CopilotProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
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
    streamsReasoning: false,
    streamsToolOutput: false,
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
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
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
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface TurnContext {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly legacyTurnId: TurnId;
  startedAt: DateTime.Utc;
  nextItemOrdinal: number;
}

interface CopilotSubagentTurnContext {
  readonly nativeTurnId: string;
  readonly providerTurnId: ProviderTurnId;
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  startedAt: DateTime.Utc;
  nextItemOrdinal: number;
}

interface CopilotSubagentContext {
  readonly agentId: string;
  readonly toolCallId: string;
  readonly parentTurn: TurnContext;
  readonly parentProjection: CopilotEventProjection;
  readonly parentAppThread: OrchestrationV2AppThread;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childThread: OrchestrationV2AppThread;
  providerThread: OrchestrationV2ProviderThread;
  task: OrchestrationV2Subagent;
  readonly turns: Map<string, CopilotSubagentTurnContext>;
  activeTurn: CopilotSubagentTurnContext | null;
  nextProviderTurnOrdinal: number;
}

interface CopilotEventProjection {
  readonly threadId: ThreadId;
  readonly runId: TurnContext["input"]["runId"] | null;
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly nativeTurnId: string;
  readonly startedAt: DateTime.Utc;
  readonly ordinalState: { nextItemOrdinal: number };
}

interface RequestContext {
  readonly appThreadId: ThreadId;
  readonly legacyRequestId: ApprovalRequestId;
  readonly runtimeRequestId: RuntimeRequestId;
  readonly providerTurnId: ProviderTurnId | null;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
  readonly createdAt: DateTime.Utc;
  readonly turn: TurnContext | undefined;
  readonly turnItemOrdinal: number | null;
  readonly title: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const copilotSdkEvent = (
  event: ProviderRuntimeEvent,
): Readonly<Record<string, unknown>> | undefined =>
  event.raw?.source === "copilot.sdk.event" ? asRecord(event.raw.payload) : undefined;

const copilotSdkEventData = (
  event: ProviderRuntimeEvent,
): Readonly<Record<string, unknown>> | undefined => asRecord(copilotSdkEvent(event)?.data);

const copilotSdkAgentId = (event: ProviderRuntimeEvent): string | undefined =>
  stringField(copilotSdkEvent(event), "agentId");

const copilotSdkTurnId = (event: ProviderRuntimeEvent): string | undefined =>
  stringField(copilotSdkEventData(event), "turnId") ?? event.providerRefs?.providerTurnId;

const stringField = (
  value: Readonly<Record<string, unknown>> | undefined,
  ...keys: ReadonlyArray<string>
): string | undefined => {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
};

const nativeThreadIdFromResumeCursor = (resumeCursor: unknown, fallback: ThreadId): string =>
  stringField(asRecord(resumeCursor), "sessionId") ?? String(fallback);

const requestKindFromCanonical = (
  requestType: CanonicalRequestType,
): OrchestrationV2RuntimeRequest["kind"] => {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "tool_user_input":
      return "user_input";
    case "dynamic_tool_call":
      return "dynamic_tool_call";
    case "auth_tokens_refresh":
      return "auth_refresh";
    case "unknown":
      return "dynamic_tool_call";
  }
};

const approvalRequestKind = (
  kind: OrchestrationV2RuntimeRequest["kind"],
): ProviderRequestKind | undefined =>
  kind === "command" || kind === "file-read" || kind === "file-change" ? kind : undefined;

const executionNodeKind = (itemType: CanonicalItemType): OrchestrationV2ExecutionNode["kind"] => {
  switch (itemType) {
    case "assistant_message":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "plan":
      return "plan";
    case "command_execution":
    case "file_change":
    case "web_search":
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "image_view":
      return "tool_call";
    case "collab_agent_tool_call":
      return "subagent";
    case "user_message":
    case "review_entered":
    case "review_exited":
    case "context_compaction":
    case "error":
    case "unknown":
      return "system";
  }
};

const nodeStatus = (status: string | undefined): OrchestrationV2ExecutionNode["status"] => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    case "pending":
      return "pending";
    default:
      return "running";
  }
};

const turnItemStatus = (status: string | undefined): OrchestrationV2TurnItem["status"] => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    case "pending":
      return "pending";
    default:
      return "running";
  }
};

const providerThreadFromSession = (input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly instanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly appThreadId: ThreadId;
  readonly nativeThreadId: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread => ({
  id: input.idAllocator.derive.providerThread({
    driver: COPILOT_DRIVER_KIND,
    nativeThreadId: input.nativeThreadId,
  }),
  driver: COPILOT_DRIVER_KIND,
  providerInstanceId: input.instanceId,
  providerSessionId: input.providerSessionId,
  appThreadId: input.appThreadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: COPILOT_DRIVER_KIND,
    nativeId: input.nativeThreadId,
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: input.now,
  updatedAt: input.now,
});

export const makeCopilotAdapterV2 = (options: {
  readonly instanceId: ProviderInstanceId;
  readonly legacyAdapter: CopilotAdapterShape;
  readonly idAllocator: IdAllocatorV2Shape;
}): ProviderAdapterV2Shape => ({
  instanceId: options.instanceId,
  driver: COPILOT_DRIVER_KIND,
  getCapabilities: () => Effect.succeed(CopilotProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
  openSession: Effect.fn("CopilotAdapterV2.openSession")(
    function* (sessionInput: ProviderAdapterV2OpenSessionInput) {
      const now = yield* DateTime.now;
      const providerSession = {
        id: sessionInput.providerSessionId,
        driver: COPILOT_DRIVER_KIND,
        providerInstanceId: options.instanceId,
        status: "ready" as const,
        cwd: sessionInput.runtimePolicy.cwd ?? ".",
        model: sessionInput.modelSelection.model ?? null,
        capabilities: CopilotProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const providerThreads = new Map<ThreadId, OrchestrationV2ProviderThread>();
      const ownedAppThreadIds = new Set<ThreadId>();
      const pendingStarts = new Map<ThreadId, Array<ProviderAdapterV2TurnInput>>();
      const turns = new Map<TurnId, TurnContext>();
      const legacyTurnIds = new Map<ProviderTurnId, TurnId>();
      const itemOrdinals = new Map<string, number>();
      const messageText = new Map<string, string>();
      const requests = new Map<RuntimeRequestId, RequestContext>();
      const legacyRequestIds = new Map<string, RuntimeRequestId>();
      const planIds = new Map<TurnId, PlanId>();
      const subagentsByAgentId = new Map<string, CopilotSubagentContext>();
      const subagentsByToolCallId = new Map<string, CopilotSubagentContext>();
      const subagentParentsByToolCallId = new Map<string, CopilotSubagentContext>();

      const removePendingStart = (input: ProviderAdapterV2TurnInput): void => {
        const queued = pendingStarts.get(input.threadId);
        const index = queued?.indexOf(input) ?? -1;
        if (queued && index >= 0) {
          queued.splice(index, 1);
        }
      };

      const resolveTurn = (
        appThreadId: ThreadId,
        legacyTurnId: TurnId,
        createdAt: DateTime.Utc,
      ): TurnContext | undefined => {
        const existing = turns.get(legacyTurnId);
        if (existing) {
          return existing;
        }
        const pending = pendingStarts.get(appThreadId)?.shift();
        if (!pending) {
          return undefined;
        }
        const providerTurnId = options.idAllocator.derive.providerTurn({
          driver: COPILOT_DRIVER_KIND,
          nativeTurnId: String(legacyTurnId),
        });
        const context: TurnContext = {
          input: pending,
          providerTurnId,
          legacyTurnId,
          startedAt: createdAt,
          nextItemOrdinal: 1,
        };
        turns.set(legacyTurnId, context);
        legacyTurnIds.set(providerTurnId, legacyTurnId);
        return context;
      };

      const rootProjection = (turn: TurnContext): CopilotEventProjection => ({
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        providerThread: turn.input.providerThread,
        providerTurnId: turn.providerTurnId,
        nativeTurnId: String(turn.legacyTurnId),
        startedAt: turn.startedAt,
        ordinalState: turn,
      });

      const itemIdentity = (projection: CopilotEventProjection, nativeItemId: string) => {
        let ordinal = itemOrdinals.get(nativeItemId);
        if (ordinal === undefined) {
          ordinal = projection.ordinalState.nextItemOrdinal++;
          itemOrdinals.set(nativeItemId, ordinal);
        }
        return {
          ordinal,
          nodeId: options.idAllocator.derive.nodeFromProviderItem({
            driver: COPILOT_DRIVER_KIND,
            nativeItemId,
          }),
          turnItemId: options.idAllocator.derive.turnItemFromProviderItem({
            driver: COPILOT_DRIVER_KIND,
            nativeItemId,
          }),
        };
      };

      const makeItemEvents = (
        event: Extract<
          ProviderRuntimeEvent,
          { type: "item.started" | "item.updated" | "item.completed" }
        >,
        projection: CopilotEventProjection,
        eventNow: DateTime.Utc,
        ownerSubagent?: CopilotSubagentContext,
      ): ReadonlyArray<ProviderAdapterV2Event> => {
        const nativeItemId = String(
          event.itemId ?? `${projection.nativeTurnId}:${event.payload.itemType}`,
        );
        const identity = itemIdentity(projection, nativeItemId);
        const status = nodeStatus(event.payload.status);
        const data = asRecord(event.payload.data);
        const title = event.payload.title ?? event.payload.itemType.replaceAll("_", " ");
        const common = {
          id: identity.turnItemId,
          threadId: projection.threadId,
          runId: projection.runId,
          nodeId: identity.nodeId,
          providerThreadId: projection.providerThread.id,
          providerTurnId: projection.providerTurnId,
          nativeItemRef: {
            driver: COPILOT_DRIVER_KIND,
            nativeId: nativeItemId,
            strength: "strong" as const,
          },
          parentItemId: null,
          ordinal: identity.ordinal,
          status: turnItemStatus(event.payload.status),
          title,
          startedAt: projection.startedAt,
          completedAt:
            event.type === "item.completed" || event.payload.status === "completed"
              ? eventNow
              : null,
          updatedAt: eventNow,
        };
        if (event.payload.itemType === "collab_agent_tool_call") {
          const toolCallId = stringField(data, "toolCallId") ?? nativeItemId;
          if (ownerSubagent) {
            subagentParentsByToolCallId.set(toolCallId, ownerSubagent);
          }
          const prompt = stringField(data, "prompt", "task", "description") ?? "";
          const existing = subagentsByToolCallId.get(toolCallId);
          const taskStatus: OrchestrationV2Subagent["status"] =
            common.status === "failed"
              ? "failed"
              : common.status === "cancelled"
                ? "cancelled"
                : common.status === "completed"
                  ? "completed"
                  : "running";
          const result =
            stringField(data, "result", "error") ??
            event.payload.detail ??
            existing?.task.result ??
            null;
          const task: OrchestrationV2Subagent = existing
            ? {
                ...existing.task,
                prompt: existing.task.prompt || prompt,
                title: existing.task.title ?? title,
                status: taskStatus,
                result,
                completedAt:
                  taskStatus === "completed" ||
                  taskStatus === "failed" ||
                  taskStatus === "cancelled"
                    ? eventNow
                    : null,
                updatedAt: eventNow,
              }
            : {
                id: identity.nodeId,
                threadId: projection.threadId,
                runId: projection.runId,
                parentNodeId: projection.parentNodeId,
                origin: "provider_native",
                createdBy: "agent",
                driver: COPILOT_DRIVER_KIND,
                providerInstanceId: options.instanceId,
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: common.nativeItemRef,
                prompt,
                title,
                model: null,
                status: taskStatus,
                result,
                startedAt: common.startedAt,
                completedAt:
                  taskStatus === "completed" ||
                  taskStatus === "failed" ||
                  taskStatus === "cancelled"
                    ? eventNow
                    : null,
                updatedAt: eventNow,
              };
          if (existing) {
            existing.task = task;
          }
          const node: OrchestrationV2ExecutionNode = {
            id: identity.nodeId,
            threadId: projection.threadId,
            runId: projection.runId,
            parentNodeId: projection.parentNodeId,
            rootNodeId: projection.rootNodeId,
            kind: "subagent",
            status,
            countsForRun: false,
            providerThreadId: existing?.providerThread.id ?? projection.providerThread.id,
            providerTurnId: projection.providerTurnId,
            nativeItemRef: common.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: status === "pending" ? null : projection.startedAt,
            completedAt: common.completedAt,
          };
          return [
            { type: "node.updated", driver: COPILOT_DRIVER_KIND, node },
            { type: "subagent.updated", driver: COPILOT_DRIVER_KIND, subagent: task },
            {
              type: "turn_item.updated",
              driver: COPILOT_DRIVER_KIND,
              turnItem: {
                ...common,
                type: "subagent",
                subagentId: task.id,
                origin: task.origin,
                driver: task.driver,
                providerInstanceId: task.providerInstanceId,
                childThreadId: task.childThreadId,
                prompt: task.prompt,
                result: task.result,
              },
            },
          ];
        }
        let turnItem: OrchestrationV2TurnItem;
        switch (event.payload.itemType) {
          case "assistant_message": {
            const messageId = options.idAllocator.derive.messageFromProviderItem({
              driver: COPILOT_DRIVER_KIND,
              nativeItemId,
            });
            turnItem = {
              ...common,
              type: "assistant_message",
              messageId,
              text: messageText.get(nativeItemId) ?? event.payload.detail ?? "",
              streaming: event.type !== "item.completed",
            };
            break;
          }
          case "reasoning":
            turnItem = {
              ...common,
              type: "reasoning",
              text: event.payload.detail ?? "",
              streaming: event.type !== "item.completed",
            };
            break;
          case "command_execution":
            turnItem = {
              ...common,
              type: "command_execution",
              input: stringField(data, "command", "cmd", "commandText") ?? title,
              ...(event.payload.detail === undefined ? {} : { output: event.payload.detail }),
              ...(typeof data?.exitCode === "number" ? { exitCode: data.exitCode } : {}),
            };
            break;
          case "file_change":
            turnItem = {
              ...common,
              type: "file_change",
              fileName: stringField(data, "fileName", "filename", "path", "filePath") ?? title,
              ...(event.payload.detail === undefined ? {} : { diffStr: event.payload.detail }),
            };
            break;
          case "web_search":
            turnItem = {
              ...common,
              type: "web_search",
              patterns: [stringField(data, "query") ?? title],
              results: [],
            };
            break;
          default:
            turnItem = {
              ...common,
              type: "dynamic_tool",
              toolName: stringField(data, "toolName") ?? title ?? null,
              input: event.payload.data,
              output: data?.result ?? event.payload.detail,
            };
        }
        const node: OrchestrationV2ExecutionNode = {
          id: identity.nodeId,
          threadId: projection.threadId,
          runId: projection.runId,
          parentNodeId: projection.parentNodeId,
          rootNodeId: projection.rootNodeId,
          kind: executionNodeKind(event.payload.itemType),
          status,
          countsForRun: false,
          providerThreadId: projection.providerThread.id,
          providerTurnId: projection.providerTurnId,
          nativeItemRef: {
            driver: COPILOT_DRIVER_KIND,
            nativeId: nativeItemId,
            strength: "strong",
          },
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: status === "pending" ? null : projection.startedAt,
          completedAt:
            status === "completed" || status === "failed" || status === "cancelled"
              ? eventNow
              : null,
        };
        const output: Array<ProviderAdapterV2Event> = [
          { type: "node.updated", driver: COPILOT_DRIVER_KIND, node },
        ];
        if (event.payload.itemType === "assistant_message") {
          const messageId = options.idAllocator.derive.messageFromProviderItem({
            driver: COPILOT_DRIVER_KIND,
            nativeItemId,
          });
          const text = messageText.get(nativeItemId) ?? event.payload.detail ?? "";
          output.push({
            type: "message.updated",
            driver: COPILOT_DRIVER_KIND,
            message: {
              id: messageId,
              threadId: projection.threadId,
              runId: projection.runId,
              nodeId: identity.nodeId,
              role: "assistant",
              text,
              attachments: [],
              streaming: event.type !== "item.completed",
              createdBy: "agent",
              creationSource: "provider",
              createdAt: projection.startedAt,
              updatedAt: eventNow,
            },
          });
        }
        output.push({ type: "turn_item.updated", driver: COPILOT_DRIVER_KIND, turnItem });
        return output;
      };

      const subagentTurnItem = (
        subagent: CopilotSubagentContext,
        eventNow: DateTime.Utc,
      ): Extract<OrchestrationV2TurnItem, { type: "subagent" }> => ({
        id: subagent.turnItemId,
        threadId: subagent.parentProjection.threadId,
        runId: subagent.parentProjection.runId,
        nodeId: subagent.nodeId,
        providerThreadId: subagent.parentProjection.providerThread.id,
        providerTurnId: subagent.parentProjection.providerTurnId,
        nativeItemRef: {
          driver: COPILOT_DRIVER_KIND,
          nativeId:
            subagent.toolCallId === subagent.agentId
              ? `copilot-subagent-${subagent.agentId}`
              : `copilot-tool-${subagent.toolCallId}`,
          strength: "strong",
        },
        parentItemId: null,
        ordinal: subagent.turnItemOrdinal,
        status: subagent.task.status === "interrupted" ? "cancelled" : subagent.task.status,
        title: subagent.task.title,
        startedAt: subagent.task.startedAt,
        completedAt: subagent.task.completedAt,
        updatedAt: eventNow,
        type: "subagent",
        subagentId: subagent.nodeId,
        origin: "provider_native",
        driver: COPILOT_DRIVER_KIND,
        providerInstanceId: options.instanceId,
        childThreadId: subagent.childThreadId,
        prompt: subagent.task.prompt,
        ...(subagent.task.progress === undefined ? {} : { progress: subagent.task.progress }),
        result: subagent.task.result,
      });

      const subagentNode = (subagent: CopilotSubagentContext): OrchestrationV2ExecutionNode => ({
        id: subagent.nodeId,
        threadId: subagent.parentProjection.threadId,
        runId: subagent.parentProjection.runId,
        parentNodeId: subagent.parentProjection.parentNodeId,
        rootNodeId: subagent.parentProjection.rootNodeId,
        kind: "subagent",
        status:
          subagent.task.status === "waiting"
            ? "waiting"
            : subagent.task.status === "completed"
              ? "completed"
              : subagent.task.status === "failed"
                ? "failed"
                : subagent.task.status === "cancelled"
                  ? "cancelled"
                  : subagent.task.status === "interrupted"
                    ? "interrupted"
                    : subagent.task.status === "pending"
                      ? "pending"
                      : "running",
        countsForRun: false,
        providerThreadId: subagent.providerThread.id,
        providerTurnId: subagent.parentProjection.providerTurnId,
        nativeItemRef: {
          driver: COPILOT_DRIVER_KIND,
          nativeId:
            subagent.toolCallId === subagent.agentId
              ? `copilot-subagent-${subagent.agentId}`
              : `copilot-tool-${subagent.toolCallId}`,
          strength: "strong",
        },
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: subagent.task.startedAt,
        completedAt: subagent.task.completedAt,
      });

      const registerSubagent = (
        event: Extract<ProviderRuntimeEvent, { type: "task.started" }>,
        parentTurn: TurnContext,
        eventNow: DateTime.Utc,
      ): ReadonlyArray<ProviderAdapterV2Event> => {
        const agentId = copilotSdkAgentId(event) ?? String(event.payload.taskId);
        const existing = subagentsByAgentId.get(agentId);
        if (existing) {
          return [];
        }
        const data = copilotSdkEventData(event);
        const toolCallId = stringField(data, "toolCallId") ?? agentId;
        const parentSubagent = subagentParentsByToolCallId.get(toolCallId);
        const parentProjection =
          parentSubagent?.activeTurn === null || parentSubagent === undefined
            ? rootProjection(parentTurn)
            : subagentProjection(parentSubagent, parentSubagent.activeTurn);
        const parentAppThread = parentSubagent?.childThread ?? parentTurn.input.appThread;
        const nativeItemId =
          toolCallId === agentId ? `copilot-subagent-${agentId}` : `copilot-tool-${toolCallId}`;
        const identity = itemIdentity(parentProjection, nativeItemId);
        const nativeThreadId = `copilot-subagent:${agentId}`;
        const childThreadId = options.idAllocator.derive.threadFromProviderThread({
          driver: COPILOT_DRIVER_KIND,
          nativeThreadId,
        });
        const childProviderThreadId = options.idAllocator.derive.providerThread({
          driver: COPILOT_DRIVER_KIND,
          nativeThreadId,
        });
        const childRootNodeId = options.idAllocator.derive.nodeFromProviderItem({
          driver: COPILOT_DRIVER_KIND,
          nativeItemId: `${nativeItemId}:thread-root`,
        });
        const prompt =
          stringField(data, "prompt", "agentDescription") ?? event.payload.description ?? "";
        const title =
          stringField(data, "agentDisplayName", "agentName") ?? event.payload.description ?? null;
        const model = stringField(data, "model") ?? null;
        const providerThread: OrchestrationV2ProviderThread = {
          id: childProviderThreadId,
          driver: COPILOT_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          providerSessionId: sessionInput.providerSessionId,
          appThreadId: childThreadId,
          ownerNodeId: identity.nodeId,
          nativeThreadRef: {
            driver: COPILOT_DRIVER_KIND,
            nativeId: agentId,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: {
            providerThreadId: parentProjection.providerThread.id,
            providerTurnId: parentProjection.providerTurnId,
          },
          createdAt: eventNow,
          updatedAt: eventNow,
        };
        const childThread = makeSubagentChildThread({
          parentThread: parentAppThread,
          childThreadId,
          parentNodeId: identity.nodeId,
          activeProviderThreadId: childProviderThreadId,
          providerInstanceId: options.instanceId,
          modelSelection: {
            ...parentTurn.input.modelSelection,
            model: model ?? parentTurn.input.modelSelection.model,
          },
          title: subagentThreadTitle({
            parentTitle: parentAppThread.title,
            title,
            prompt,
            ordinal: identity.ordinal,
          }),
          now: eventNow,
          createdBy: "agent",
          creationSource: "provider",
        });
        const nativeTaskRef = {
          driver: COPILOT_DRIVER_KIND,
          nativeId: agentId,
          strength: "strong" as const,
        };
        const task: OrchestrationV2Subagent = {
          id: identity.nodeId,
          threadId: parentProjection.threadId,
          runId: parentProjection.runId,
          parentNodeId: parentProjection.parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver: COPILOT_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          providerThreadId: childProviderThreadId,
          childThreadId,
          nativeTaskRef,
          prompt,
          title,
          model,
          status: "running",
          result: null,
          startedAt: eventNow,
          completedAt: null,
          updatedAt: eventNow,
        };
        const subagent: CopilotSubagentContext = {
          agentId,
          toolCallId,
          parentTurn,
          parentProjection,
          parentAppThread,
          nodeId: identity.nodeId,
          turnItemId: identity.turnItemId,
          turnItemOrdinal: identity.ordinal,
          childThreadId,
          childRootNodeId,
          childThread,
          providerThread,
          task,
          turns: new Map(),
          activeTurn: null,
          nextProviderTurnOrdinal: 1,
        };
        subagentsByAgentId.set(agentId, subagent);
        subagentsByToolCallId.set(toolCallId, subagent);
        providerThreads.set(childThreadId, providerThread);
        return [
          { type: "app_thread.created", driver: COPILOT_DRIVER_KIND, appThread: childThread },
          { type: "provider_thread.updated", driver: COPILOT_DRIVER_KIND, providerThread },
          {
            type: "node.updated",
            driver: COPILOT_DRIVER_KIND,
            node: subagentNode(subagent),
          },
          {
            type: "node.updated",
            driver: COPILOT_DRIVER_KIND,
            node: {
              id: childRootNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: childRootNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: false,
              providerThreadId: childProviderThreadId,
              providerTurnId: null,
              nativeItemRef: nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: eventNow,
              completedAt: null,
            },
          },
          { type: "subagent.updated", driver: COPILOT_DRIVER_KIND, subagent: task },
          {
            type: "turn_item.updated",
            driver: COPILOT_DRIVER_KIND,
            turnItem: subagentTurnItem(subagent, eventNow),
          },
        ];
      };

      const ensureSubagentTurn = (
        subagent: CopilotSubagentContext,
        nativeTurnId: string,
        eventNow: DateTime.Utc,
      ): {
        readonly context: CopilotSubagentTurnContext;
        readonly events: ReadonlyArray<ProviderAdapterV2Event>;
      } => {
        const existing = subagent.turns.get(nativeTurnId);
        if (existing) {
          subagent.activeTurn = existing;
          return { context: existing, events: [] };
        }
        const providerNativeTurnId = `${subagent.agentId}:${nativeTurnId}`;
        const providerTurnId = options.idAllocator.derive.providerTurn({
          driver: COPILOT_DRIVER_KIND,
          nativeTurnId: providerNativeTurnId,
        });
        const ordinal = subagent.nextProviderTurnOrdinal++;
        const rootNodeId =
          ordinal === 1
            ? subagent.childRootNodeId
            : options.idAllocator.derive.nodeFromProviderItem({
                driver: COPILOT_DRIVER_KIND,
                nativeItemId: `${providerNativeTurnId}:thread-root`,
              });
        const context: CopilotSubagentTurnContext = {
          nativeTurnId,
          providerTurnId,
          rootNodeId,
          startedAt: eventNow,
          nextItemOrdinal: ordinal * 100 + 1,
        };
        subagent.turns.set(nativeTurnId, context);
        subagent.activeTurn = context;
        subagent.providerThread = {
          ...subagent.providerThread,
          status: "active",
          updatedAt: eventNow,
        };
        providerThreads.set(subagent.childThreadId, subagent.providerThread);
        return {
          context,
          events: [
            {
              type: "provider_thread.updated",
              driver: COPILOT_DRIVER_KIND,
              providerThread: subagent.providerThread,
            },
            {
              type: "provider_turn.updated",
              driver: COPILOT_DRIVER_KIND,
              threadId: subagent.childThreadId,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: subagent.providerThread.id,
                nodeId: rootNodeId,
                runAttemptId: null,
                nativeTurnRef: {
                  driver: COPILOT_DRIVER_KIND,
                  nativeId: nativeTurnId,
                  strength: "strong",
                },
                ordinal,
                status: "running",
                startedAt: eventNow,
                completedAt: null,
              },
            },
            {
              type: "node.updated",
              driver: COPILOT_DRIVER_KIND,
              node: {
                id: rootNodeId,
                threadId: subagent.childThreadId,
                runId: null,
                parentNodeId: null,
                rootNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: false,
                providerThreadId: subagent.providerThread.id,
                providerTurnId,
                nativeItemRef: subagent.task.nativeTaskRef,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: eventNow,
                completedAt: null,
              },
            },
          ],
        };
      };

      const subagentProjection = (
        subagent: CopilotSubagentContext,
        turn: CopilotSubagentTurnContext,
      ): CopilotEventProjection => ({
        threadId: subagent.childThreadId,
        runId: null,
        parentNodeId: turn.rootNodeId,
        rootNodeId: turn.rootNodeId,
        providerThread: subagent.providerThread,
        providerTurnId: turn.providerTurnId,
        nativeTurnId: `${subagent.agentId}:${turn.nativeTurnId}`,
        startedAt: turn.startedAt,
        ordinalState: turn,
      });

      const completeSubagentTurn = (
        subagent: CopilotSubagentContext,
        eventNow: DateTime.Utc,
        status: "completed" | "failed" | "interrupted" = "completed",
      ): ReadonlyArray<ProviderAdapterV2Event> => {
        const turn = subagent.activeTurn;
        if (!turn) {
          return [];
        }
        subagent.activeTurn = null;
        subagent.providerThread = {
          ...subagent.providerThread,
          status: "idle",
          updatedAt: eventNow,
        };
        providerThreads.set(subagent.childThreadId, subagent.providerThread);
        return [
          {
            type: "provider_turn.updated",
            driver: COPILOT_DRIVER_KIND,
            threadId: subagent.childThreadId,
            providerTurn: {
              id: turn.providerTurnId,
              providerThreadId: subagent.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: null,
              nativeTurnRef: {
                driver: COPILOT_DRIVER_KIND,
                nativeId: turn.nativeTurnId,
                strength: "strong",
              },
              ordinal: Array.from(subagent.turns).findIndex(([id]) => id === turn.nativeTurnId) + 1,
              status,
              startedAt: turn.startedAt,
              completedAt: eventNow,
            },
          },
          {
            type: "node.updated",
            driver: COPILOT_DRIVER_KIND,
            node: {
              id: turn.rootNodeId,
              threadId: subagent.childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: turn.rootNodeId,
              kind: "root_turn",
              status,
              countsForRun: false,
              providerThreadId: subagent.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: subagent.task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: turn.startedAt,
              completedAt: eventNow,
            },
          },
          {
            type: "provider_thread.updated",
            driver: COPILOT_DRIVER_KIND,
            providerThread: subagent.providerThread,
          },
        ];
      };

      const convertEvent = (
        event: ProviderRuntimeEvent,
      ): Effect.Effect<ReadonlyArray<ProviderAdapterV2Event>, IdAllocatorV2Error> =>
        Effect.gen(function* () {
          if (
            event.provider !== COPILOT_DRIVER_KIND ||
            (event.providerInstanceId !== undefined &&
              event.providerInstanceId !== options.instanceId) ||
            !ownedAppThreadIds.has(event.threadId)
          ) {
            return [] as ReadonlyArray<ProviderAdapterV2Event>;
          }
          const eventNow = yield* DateTime.now;
          const legacyTurnId = event.turnId;
          const turn =
            legacyTurnId === undefined
              ? undefined
              : resolveTurn(event.threadId, legacyTurnId, eventNow);
          if (event.type === "task.started" && turn) {
            if (event.payload.taskType === "shell") {
              return [] as ReadonlyArray<ProviderAdapterV2Event>;
            }
            return registerSubagent(event, turn, eventNow);
          }
          if (event.type === "task.progress") {
            const agentId = copilotSdkAgentId(event) ?? String(event.payload.taskId);
            const subagent = subagentsByAgentId.get(agentId);
            if (!subagent) {
              return [] as ReadonlyArray<ProviderAdapterV2Event>;
            }
            const rawMethod = event.raw?.method;
            const output: Array<ProviderAdapterV2Event> = [];
            if (rawMethod === "assistant.turn_start") {
              const nativeTurnId = copilotSdkTurnId(event) ?? `${agentId}:turn`;
              const started = ensureSubagentTurn(subagent, nativeTurnId, eventNow);
              output.push(...started.events);
            } else if (rawMethod === "assistant.turn_end") {
              output.push(...completeSubagentTurn(subagent, eventNow));
            }
            subagent.task = {
              ...subagent.task,
              status: event.payload.summary?.toLowerCase().includes("idle") ? "waiting" : "running",
              progress: event.payload.summary ?? event.payload.description,
              updatedAt: eventNow,
            };
            output.push(
              {
                type: "node.updated",
                driver: COPILOT_DRIVER_KIND,
                node: subagentNode(subagent),
              },
              {
                type: "subagent.updated",
                driver: COPILOT_DRIVER_KIND,
                subagent: subagent.task,
              },
              {
                type: "turn_item.updated",
                driver: COPILOT_DRIVER_KIND,
                turnItem: subagentTurnItem(subagent, eventNow),
              },
            );
            return output;
          }
          if (event.type === "task.completed") {
            const agentId = copilotSdkAgentId(event) ?? String(event.payload.taskId);
            const subagent = subagentsByAgentId.get(agentId);
            if (!subagent) {
              return [] as ReadonlyArray<ProviderAdapterV2Event>;
            }
            const status: OrchestrationV2Subagent["status"] =
              event.payload.status === "failed"
                ? "failed"
                : event.payload.status === "stopped"
                  ? "cancelled"
                  : "completed";
            const childTurnStatus =
              status === "failed" ? "failed" : status === "cancelled" ? "interrupted" : "completed";
            const hadActiveTurn = subagent.activeTurn !== null;
            const output = Array.from(completeSubagentTurn(subagent, eventNow, childTurnStatus));
            if (!hadActiveTurn) {
              subagent.providerThread = {
                ...subagent.providerThread,
                status: "idle",
                updatedAt: eventNow,
              };
              providerThreads.set(subagent.childThreadId, subagent.providerThread);
              output.push(
                {
                  type: "node.updated",
                  driver: COPILOT_DRIVER_KIND,
                  node: {
                    id: subagent.childRootNodeId,
                    threadId: subagent.childThreadId,
                    runId: null,
                    parentNodeId: null,
                    rootNodeId: subagent.childRootNodeId,
                    kind: "root_turn",
                    status: childTurnStatus,
                    countsForRun: false,
                    providerThreadId: subagent.providerThread.id,
                    providerTurnId: null,
                    nativeItemRef: subagent.task.nativeTaskRef,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: subagent.task.startedAt,
                    completedAt: eventNow,
                  },
                },
                {
                  type: "provider_thread.updated",
                  driver: COPILOT_DRIVER_KIND,
                  providerThread: subagent.providerThread,
                },
              );
            }
            subagent.task = {
              ...subagent.task,
              status,
              result: event.payload.summary ?? subagent.task.result,
              completedAt: eventNow,
              updatedAt: eventNow,
            };
            output.push(
              {
                type: "node.updated",
                driver: COPILOT_DRIVER_KIND,
                node: subagentNode(subagent),
              },
              {
                type: "subagent.updated",
                driver: COPILOT_DRIVER_KIND,
                subagent: subagent.task,
              },
              {
                type: "turn_item.updated",
                driver: COPILOT_DRIVER_KIND,
                turnItem: subagentTurnItem(subagent, eventNow),
              },
            );
            return output;
          }
          if (event.type === "turn.started" && turn) {
            turn.startedAt = eventNow;
            const providerThread: OrchestrationV2ProviderThread = {
              ...turn.input.providerThread,
              providerSessionId: sessionInput.providerSessionId,
              status: "active",
              firstRunOrdinal: turn.input.providerThread.firstRunOrdinal ?? turn.input.runOrdinal,
              lastRunOrdinal: turn.input.runOrdinal,
              updatedAt: eventNow,
            };
            providerThreads.set(turn.input.threadId, providerThread);
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: turn.providerTurnId,
              providerThreadId: turn.input.providerThread.id,
              nodeId: turn.input.rootNodeId,
              runAttemptId: turn.input.attemptId,
              nativeTurnRef: {
                driver: COPILOT_DRIVER_KIND,
                nativeId: String(legacyTurnId),
                strength: "weak",
              },
              ordinal: turn.input.providerTurnOrdinal,
              status: "running",
              startedAt: eventNow,
              completedAt: null,
            };
            return [
              {
                type: "provider_thread.updated",
                driver: COPILOT_DRIVER_KIND,
                providerThread,
              },
              {
                type: "provider_turn.updated",
                driver: COPILOT_DRIVER_KIND,
                threadId: turn.input.threadId,
                providerTurn,
              },
            ];
          }
          if (
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed") &&
            turn
          ) {
            const agentId = copilotSdkAgentId(event);
            const subagent = agentId ? subagentsByAgentId.get(agentId) : undefined;
            if (subagent) {
              const nativeTurnId =
                copilotSdkTurnId(event) ?? subagent.activeTurn?.nativeTurnId ?? `${agentId}:turn`;
              const childTurn = ensureSubagentTurn(subagent, nativeTurnId, eventNow);
              return [
                ...childTurn.events,
                ...makeItemEvents(
                  event,
                  subagentProjection(subagent, childTurn.context),
                  eventNow,
                  subagent,
                ),
              ];
            }
            return makeItemEvents(event, rootProjection(turn), eventNow);
          }
          if (
            event.type === "content.delta" &&
            turn &&
            event.payload.streamKind === "assistant_text"
          ) {
            const agentId = copilotSdkAgentId(event);
            const subagent = agentId ? subagentsByAgentId.get(agentId) : undefined;
            const childTurn = subagent
              ? ensureSubagentTurn(
                  subagent,
                  copilotSdkTurnId(event) ?? subagent.activeTurn?.nativeTurnId ?? `${agentId}:turn`,
                  eventNow,
                )
              : undefined;
            const projection =
              subagent && childTurn
                ? subagentProjection(subagent, childTurn.context)
                : rootProjection(turn);
            const nativeItemId = String(
              event.itemId ??
                `${projection.nativeTurnId}:assistant:${event.payload.contentIndex ?? 0}`,
            );
            const identity = itemIdentity(projection, nativeItemId);
            const messageId = options.idAllocator.derive.messageFromProviderItem({
              driver: COPILOT_DRIVER_KIND,
              nativeItemId,
            });
            const text = `${messageText.get(nativeItemId) ?? ""}${event.payload.delta}`;
            messageText.set(nativeItemId, text);
            const message: OrchestrationV2ConversationMessage = {
              id: messageId,
              threadId: projection.threadId,
              runId: projection.runId,
              nodeId: identity.nodeId,
              role: "assistant",
              text,
              attachments: [],
              streaming: true,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: projection.startedAt,
              updatedAt: eventNow,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: identity.turnItemId,
              threadId: projection.threadId,
              runId: projection.runId,
              nodeId: identity.nodeId,
              providerThreadId: projection.providerThread.id,
              providerTurnId: projection.providerTurnId,
              nativeItemRef: {
                driver: COPILOT_DRIVER_KIND,
                nativeId: nativeItemId,
                strength: "strong",
              },
              parentItemId: null,
              ordinal: identity.ordinal,
              status: "running",
              title: null,
              startedAt: projection.startedAt,
              completedAt: null,
              updatedAt: eventNow,
              type: "assistant_message",
              messageId,
              text,
              streaming: true,
            };
            const node: OrchestrationV2ExecutionNode = {
              id: identity.nodeId,
              threadId: projection.threadId,
              runId: projection.runId,
              parentNodeId: projection.parentNodeId,
              rootNodeId: projection.rootNodeId,
              kind: "assistant_message",
              status: "running",
              countsForRun: false,
              providerThreadId: projection.providerThread.id,
              providerTurnId: projection.providerTurnId,
              nativeItemRef: {
                driver: COPILOT_DRIVER_KIND,
                nativeId: nativeItemId,
                strength: "strong",
              },
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: projection.startedAt,
              completedAt: null,
            };
            return [
              ...(childTurn?.events ?? []),
              { type: "node.updated", driver: COPILOT_DRIVER_KIND, node },
              { type: "message.updated", driver: COPILOT_DRIVER_KIND, message },
              { type: "turn_item.updated", driver: COPILOT_DRIVER_KIND, turnItem },
            ];
          }
          if (
            (event.type === "request.opened" || event.type === "user-input.requested") &&
            event.requestId !== undefined
          ) {
            const providerTurnId = turn?.providerTurnId ?? null;
            const runtimeRequestId = yield* options.idAllocator.allocate.runtimeRequest({
              driver: COPILOT_DRIVER_KIND,
              ...(providerTurnId === null ? {} : { providerTurnId }),
              nativeRequestId: String(event.requestId),
            });
            const nodeId = options.idAllocator.derive.approvalNode({ requestId: runtimeRequestId });
            const requestKind =
              event.type === "user-input.requested"
                ? "user_input"
                : requestKindFromCanonical(event.payload.requestType);
            const turnItemOrdinal = turn ? turn.nextItemOrdinal++ : null;
            const title =
              event.type === "user-input.requested"
                ? "User input requested"
                : (event.payload.detail ?? "Approval requested");
            const questions = event.type === "user-input.requested" ? event.payload.questions : [];
            const requestContext: RequestContext = {
              appThreadId: event.threadId,
              legacyRequestId: ApprovalRequestId.make(String(event.requestId)),
              runtimeRequestId,
              providerTurnId,
              nodeId,
              requestKind,
              createdAt: eventNow,
              turn,
              turnItemOrdinal,
              title,
              questions,
            };
            requests.set(runtimeRequestId, requestContext);
            legacyRequestIds.set(String(event.requestId), runtimeRequestId);
            const runtimeRequest: OrchestrationV2RuntimeRequest = {
              id: runtimeRequestId,
              nodeId,
              providerTurnId,
              nativeRequestRef: {
                driver: COPILOT_DRIVER_KIND,
                nativeId: String(event.requestId),
                strength: "strong",
              },
              kind: requestKind,
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: sessionInput.providerSessionId,
              },
              createdAt: eventNow,
              resolvedAt: null,
            };
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: event.threadId,
              runId: turn?.input.runId ?? null,
              parentNodeId: turn?.input.rootNodeId ?? nodeId,
              rootNodeId: turn?.input.rootNodeId ?? nodeId,
              kind:
                event.type === "user-input.requested" ? "user_input_request" : "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: turn?.input.providerThread.id ?? null,
              providerTurnId,
              nativeItemRef: null,
              runtimeRequestId,
              checkpointScopeId: null,
              startedAt: eventNow,
              completedAt: null,
            };
            const output: Array<ProviderAdapterV2Event> = [
              { type: "node.updated", driver: COPILOT_DRIVER_KIND, node },
              {
                type: "runtime_request.updated",
                driver: COPILOT_DRIVER_KIND,
                threadId: event.threadId,
                runtimeRequest,
              },
            ];
            if (turn) {
              const common = {
                id: options.idAllocator.derive.approvalTurnItem({
                  requestId: runtimeRequestId,
                }),
                threadId: event.threadId,
                runId: turn.input.runId,
                nodeId,
                providerThreadId: turn.input.providerThread.id,
                providerTurnId: turn.providerTurnId,
                nativeItemRef: {
                  driver: COPILOT_DRIVER_KIND,
                  nativeId: String(event.requestId),
                  strength: "strong" as const,
                },
                parentItemId: null,
                ordinal: turnItemOrdinal ?? 0,
                status: "waiting" as const,
                title,
                startedAt: eventNow,
                completedAt: null,
                updatedAt: eventNow,
              };
              if (event.type === "user-input.requested") {
                output.push({
                  type: "turn_item.updated",
                  driver: COPILOT_DRIVER_KIND,
                  turnItem: {
                    ...common,
                    type: "user_input_request",
                    requestId: runtimeRequestId,
                    questions: event.payload.questions,
                  },
                });
              } else {
                const requestKindForItem = approvalRequestKind(requestKind);
                if (requestKindForItem) {
                  output.push({
                    type: "turn_item.updated",
                    driver: COPILOT_DRIVER_KIND,
                    turnItem: {
                      ...common,
                      type: "approval_request",
                      requestId: runtimeRequestId,
                      requestKind: requestKindForItem,
                    },
                  });
                }
              }
            }
            return output;
          }
          if (
            (event.type === "request.resolved" || event.type === "user-input.resolved") &&
            event.requestId !== undefined
          ) {
            const runtimeRequestId = legacyRequestIds.get(String(event.requestId));
            const request = runtimeRequestId ? requests.get(runtimeRequestId) : undefined;
            if (!request) {
              return [] as ReadonlyArray<ProviderAdapterV2Event>;
            }
            const requestTurn = request.turn ?? turn;
            const output: Array<ProviderAdapterV2Event> = [
              {
                type: "node.updated",
                driver: COPILOT_DRIVER_KIND,
                node: {
                  id: request.nodeId,
                  threadId: request.appThreadId,
                  runId: requestTurn?.input.runId ?? null,
                  parentNodeId: requestTurn?.input.rootNodeId ?? request.nodeId,
                  rootNodeId: requestTurn?.input.rootNodeId ?? request.nodeId,
                  kind:
                    request.requestKind === "user_input"
                      ? "user_input_request"
                      : "approval_request",
                  status: "completed",
                  countsForRun: false,
                  providerThreadId: requestTurn?.input.providerThread.id ?? null,
                  providerTurnId: request.providerTurnId,
                  nativeItemRef: null,
                  runtimeRequestId: request.runtimeRequestId,
                  checkpointScopeId: null,
                  startedAt: request.createdAt,
                  completedAt: eventNow,
                },
              },
              {
                type: "runtime_request.updated",
                driver: COPILOT_DRIVER_KIND,
                threadId: request.appThreadId,
                runtimeRequest: {
                  id: request.runtimeRequestId,
                  nodeId: request.nodeId,
                  providerTurnId: request.providerTurnId,
                  nativeRequestRef: {
                    driver: COPILOT_DRIVER_KIND,
                    nativeId: String(request.legacyRequestId),
                    strength: "strong",
                  },
                  kind: request.requestKind,
                  status: "resolved",
                  responseCapability: {
                    type: "live",
                    providerSessionId: sessionInput.providerSessionId,
                  },
                  createdAt: request.createdAt,
                  resolvedAt: eventNow,
                },
              },
            ];
            if (request.turn && request.turnItemOrdinal !== null) {
              const common = {
                id: options.idAllocator.derive.approvalTurnItem({
                  requestId: request.runtimeRequestId,
                }),
                threadId: request.appThreadId,
                runId: request.turn.input.runId,
                nodeId: request.nodeId,
                providerThreadId: request.turn.input.providerThread.id,
                providerTurnId: request.turn.providerTurnId,
                nativeItemRef: {
                  driver: COPILOT_DRIVER_KIND,
                  nativeId: String(request.legacyRequestId),
                  strength: "strong" as const,
                },
                parentItemId: null,
                ordinal: request.turnItemOrdinal,
                status: "completed" as const,
                title: request.title,
                startedAt: request.createdAt,
                completedAt: eventNow,
                updatedAt: eventNow,
              };
              const requestKindForItem = approvalRequestKind(request.requestKind);
              if (request.requestKind === "user_input") {
                output.push({
                  type: "turn_item.updated",
                  driver: COPILOT_DRIVER_KIND,
                  turnItem: {
                    ...common,
                    type: "user_input_request",
                    requestId: request.runtimeRequestId,
                    questions: request.questions,
                  },
                });
              } else if (requestKindForItem) {
                output.push({
                  type: "turn_item.updated",
                  driver: COPILOT_DRIVER_KIND,
                  turnItem: {
                    ...common,
                    type: "approval_request",
                    requestId: request.runtimeRequestId,
                    requestKind: requestKindForItem,
                  },
                });
              }
            }
            return output;
          }
          if (
            (event.type === "turn.proposed.completed" || event.type === "turn.plan.updated") &&
            turn &&
            legacyTurnId
          ) {
            const planId =
              planIds.get(legacyTurnId) ??
              (yield* options.idAllocator.allocate.plan({
                threadId: turn.input.threadId,
                runId: turn.input.runId,
                driver: COPILOT_DRIVER_KIND,
              }));
            planIds.set(legacyTurnId, planId);
            const markdown =
              event.type === "turn.proposed.completed"
                ? event.payload.planMarkdown
                : event.payload.plan
                    .map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.step}`)
                    .join("\n");
            const nodeId = options.idAllocator.derive.nodeFromProviderItem({
              driver: COPILOT_DRIVER_KIND,
              nativeItemId: `plan:${legacyTurnId}`,
            });
            const plan: OrchestrationV2PlanArtifact =
              event.type === "turn.proposed.completed"
                ? {
                    id: planId,
                    threadId: turn.input.threadId,
                    runId: turn.input.runId,
                    nodeId,
                    status: "draft",
                    kind: "proposed_plan",
                    markdown,
                  }
                : {
                    id: planId,
                    threadId: turn.input.threadId,
                    runId: turn.input.runId,
                    nodeId,
                    status: "active",
                    kind: "todo_list",
                    steps: event.payload.plan.map((step, index) => ({
                      id: `${legacyTurnId}:${index}`,
                      text: step.step,
                      status:
                        step.status === "inProgress"
                          ? "running"
                          : step.status === "completed"
                            ? "completed"
                            : "pending",
                    })),
                    ...(event.payload.explanation === undefined ||
                    event.payload.explanation === null
                      ? {}
                      : { explanation: event.payload.explanation }),
                  };
            return [
              {
                type: "node.updated",
                driver: COPILOT_DRIVER_KIND,
                node: {
                  id: nodeId,
                  threadId: turn.input.threadId,
                  runId: turn.input.runId,
                  parentNodeId: turn.input.rootNodeId,
                  rootNodeId: turn.input.rootNodeId,
                  kind: event.type === "turn.proposed.completed" ? "plan" : "todo_list",
                  status: "completed",
                  countsForRun: false,
                  providerThreadId: turn.input.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  nativeItemRef: {
                    driver: COPILOT_DRIVER_KIND,
                    nativeId: `plan:${legacyTurnId}`,
                    strength: "weak",
                  },
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt: eventNow,
                  completedAt: eventNow,
                },
              },
              {
                type: "plan.updated",
                driver: COPILOT_DRIVER_KIND,
                plan,
              },
            ];
          }
          if (event.type === "turn.completed" && turn) {
            const status =
              event.payload.state === "failed"
                ? "failed"
                : event.payload.state === "interrupted"
                  ? "interrupted"
                  : event.payload.state === "cancelled"
                    ? "cancelled"
                    : "completed";
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: turn.providerTurnId,
              providerThreadId: turn.input.providerThread.id,
              nodeId: turn.input.rootNodeId,
              runAttemptId: turn.input.attemptId,
              nativeTurnRef: {
                driver: COPILOT_DRIVER_KIND,
                nativeId: String(turn.legacyTurnId),
                strength: "weak",
              },
              ordinal: turn.input.providerTurnOrdinal,
              status,
              startedAt: turn.startedAt,
              completedAt: eventNow,
            };
            const updated: ProviderAdapterV2Event = {
              type: "provider_turn.updated",
              driver: COPILOT_DRIVER_KIND,
              threadId: turn.input.threadId,
              providerTurn,
            };
            const currentProviderThread =
              providerThreads.get(turn.input.threadId) ?? turn.input.providerThread;
            const idleProviderThread: OrchestrationV2ProviderThread = {
              ...currentProviderThread,
              providerSessionId: sessionInput.providerSessionId,
              status: "idle",
              firstRunOrdinal: currentProviderThread.firstRunOrdinal ?? turn.input.runOrdinal,
              lastRunOrdinal: turn.input.runOrdinal,
              updatedAt: eventNow,
            };
            providerThreads.set(turn.input.threadId, idleProviderThread);
            const providerThreadUpdated: ProviderAdapterV2Event = {
              type: "provider_thread.updated",
              driver: COPILOT_DRIVER_KIND,
              providerThread: idleProviderThread,
            };
            if (status === "failed") {
              const message =
                event.payload.errorMessage?.slice(0, 4_096) ?? "GitHub Copilot turn failed.";
              return [
                updated,
                providerThreadUpdated,
                {
                  type: "turn.terminal",
                  driver: COPILOT_DRIVER_KIND,
                  providerThreadId: turn.input.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  runOrdinal: turn.input.runOrdinal,
                  failureItemOrdinal: Math.max(1, turn.nextItemOrdinal),
                  status: "failed",
                  failure: {
                    class: "provider_error",
                    message,
                    code: null,
                    retryable: null,
                  },
                  threadDisposition: "reusable",
                },
              ];
            }
            return [
              updated,
              providerThreadUpdated,
              {
                type: "turn.terminal",
                driver: COPILOT_DRIVER_KIND,
                providerThreadId: turn.input.providerThread.id,
                providerTurnId: turn.providerTurnId,
                runOrdinal: turn.input.runOrdinal,
                status,
                failure: null,
                threadDisposition: "reusable",
              },
            ];
          }
          return [] as ReadonlyArray<ProviderAdapterV2Event>;
        });

      const events = options.legacyAdapter.streamEvents.pipe(
        Stream.mapEffect(convertEvent),
        Stream.flatMap((items) => Stream.fromIterable(items)),
        Stream.mapError(
          (cause) =>
            new ProviderAdapterEventStreamError({
              driver: COPILOT_DRIVER_KIND,
              providerSessionId: sessionInput.providerSessionId,
              cause,
            }),
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          ownedAppThreadIds,
          (threadId) =>
            options.legacyAdapter.hasSession(threadId).pipe(
              Effect.flatMap((hasSession) =>
                hasSession ? options.legacyAdapter.stopSession(threadId) : Effect.void,
              ),
              Effect.ignore,
            ),
          { discard: true },
        ),
      );

      return {
        instanceId: options.instanceId,
        driver: COPILOT_DRIVER_KIND,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        events,
        ensureThread: Effect.fn("CopilotAdapterV2.ensureThread")(
          function* (input) {
            const existing = providerThreads.get(input.threadId);
            if (existing) {
              return existing;
            }
            const session = yield* options.legacyAdapter.startSession({
              threadId: input.threadId,
              provider: COPILOT_DRIVER_KIND,
              providerInstanceId: options.instanceId,
              cwd: input.runtimePolicy.cwd ?? undefined,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimePolicy.runtimeMode,
            });
            const createdAt = yield* DateTime.now;
            const providerThread = providerThreadFromSession({
              idAllocator: options.idAllocator,
              instanceId: options.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: input.threadId,
              nativeThreadId: nativeThreadIdFromResumeCursor(session.resumeCursor, input.threadId),
              now: createdAt,
            });
            providerThreads.set(input.threadId, providerThread);
            ownedAppThreadIds.add(input.threadId);
            return providerThread;
          },
          (effect, input) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterEnsureThreadError({
                    driver: COPILOT_DRIVER_KIND,
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            ),
        ),
        resumeThread: Effect.fn("CopilotAdapterV2.resumeThread")(
          function* (input) {
            const appThreadId = input.threadId ?? input.providerThread.appThreadId;
            if (appThreadId === null) {
              return yield* new ProviderAdapterEnsureThreadError({
                driver: COPILOT_DRIVER_KIND,
                threadId: sessionInput.threadId,
                cause: "Copilot provider thread has no app thread.",
              });
            }
            const previousAppThreadId = input.providerThread.appThreadId;
            if (previousAppThreadId !== null && previousAppThreadId !== appThreadId) {
              const hasPreviousSession =
                yield* options.legacyAdapter.hasSession(previousAppThreadId);
              if (hasPreviousSession) {
                yield* options.legacyAdapter.stopSession(previousAppThreadId);
              }
              ownedAppThreadIds.delete(previousAppThreadId);
              providerThreads.delete(previousAppThreadId);
            }
            const session = yield* options.legacyAdapter.startSession({
              threadId: appThreadId,
              provider: COPILOT_DRIVER_KIND,
              providerInstanceId: options.instanceId,
              cwd: input.runtimePolicy?.cwd ?? sessionInput.runtimePolicy.cwd ?? undefined,
              modelSelection: input.modelSelection ?? sessionInput.modelSelection,
              runtimeMode:
                input.runtimePolicy?.runtimeMode ?? sessionInput.runtimePolicy.runtimeMode,
              resumeCursor:
                input.providerThread.nativeThreadRef === null
                  ? undefined
                  : { sessionId: input.providerThread.nativeThreadRef.nativeId },
            });
            const updatedAt = yield* DateTime.now;
            const providerThread = {
              ...input.providerThread,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId,
              nativeThreadRef: {
                driver: COPILOT_DRIVER_KIND,
                nativeId: nativeThreadIdFromResumeCursor(session.resumeCursor, appThreadId),
                strength: "strong" as const,
              },
              status: "idle" as const,
              updatedAt,
            };
            providerThreads.set(appThreadId, providerThread);
            ownedAppThreadIds.add(appThreadId);
            return providerThread;
          },
          (effect, input) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterResumeThreadError({
                    driver: COPILOT_DRIVER_KIND,
                    providerSessionId: sessionInput.providerSessionId,
                    providerThreadId: input.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        startTurn: Effect.fn("CopilotAdapterV2.startTurn")(
          function* (input: ProviderAdapterV2TurnInput) {
            const pending = pendingStarts.get(input.threadId) ?? [];
            pending.push(input);
            pendingStarts.set(input.threadId, pending);
            const result = yield* options.legacyAdapter
              .sendTurn({
                threadId: input.threadId,
                input: input.message.text || undefined,
                attachments: input.message.attachments,
                modelSelection: input.modelSelection,
                interactionMode: input.runtimePolicy.interactionMode,
              })
              .pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    removePendingStart(input);
                  }),
                ),
              );
            removePendingStart(input);
            const startedAt = yield* DateTime.now;
            const providerTurnId = options.idAllocator.derive.providerTurn({
              driver: COPILOT_DRIVER_KIND,
              nativeTurnId: String(result.turnId),
            });
            if (!turns.has(result.turnId)) {
              turns.set(result.turnId, {
                input,
                providerTurnId,
                legacyTurnId: result.turnId,
                startedAt,
                nextItemOrdinal: 1,
              });
            }
            legacyTurnIds.set(providerTurnId, result.turnId);
          },
          (effect, input) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: COPILOT_DRIVER_KIND,
                    threadId: input.threadId,
                    providerThreadId: input.providerThread.id,
                    runId: input.runId,
                    cause,
                  }),
              ),
            ),
        ),
        steerTurn: (input: ProviderAdapterV2SteerInput) =>
          Effect.fail(
            new ProviderAdapterSteerRunUnsupportedError({
              driver: COPILOT_DRIVER_KIND,
              providerThreadId: input.providerThread.id,
            }),
          ),
        interruptTurn: Effect.fn("CopilotAdapterV2.interruptTurn")(
          function* (input) {
            const appThreadId = input.providerThread.appThreadId;
            const legacyTurnId = legacyTurnIds.get(input.providerTurnId);
            if (appThreadId !== null) {
              yield* options.legacyAdapter.interruptTurn(appThreadId, legacyTurnId);
            }
          },
          (effect, input) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    driver: COPILOT_DRIVER_KIND,
                    providerThreadId: input.providerThread.id,
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("CopilotAdapterV2.respondToRuntimeRequest")(
          function* (input) {
            const request = requests.get(input.requestId);
            if (!request) {
              return yield* new ProviderAdapterRuntimeRequestResponseError({
                driver: COPILOT_DRIVER_KIND,
                requestId: input.requestId,
                cause: `Unknown Copilot request ${input.requestId}.`,
              });
            }
            if (request.requestKind === "user_input") {
              if (!input.answers) {
                return yield* new ProviderAdapterRuntimeRequestResponseError({
                  driver: COPILOT_DRIVER_KIND,
                  requestId: input.requestId,
                  cause: "Copilot user input request requires answers.",
                });
              }
              yield* options.legacyAdapter.respondToUserInput(
                request.appThreadId,
                request.legacyRequestId,
                input.answers,
              );
              return;
            }
            if (!input.decision) {
              return yield* new ProviderAdapterRuntimeRequestResponseError({
                driver: COPILOT_DRIVER_KIND,
                requestId: input.requestId,
                cause: "Copilot approval request requires a decision.",
              });
            }
            yield* options.legacyAdapter.respondToRequest(
              request.appThreadId,
              request.legacyRequestId,
              input.decision,
            );
          },
          (effect, input) =>
            effect.pipe(
              Effect.mapError((cause) =>
                isProviderAdapterRuntimeRequestResponseError(cause)
                  ? cause
                  : new ProviderAdapterRuntimeRequestResponseError({
                      driver: COPILOT_DRIVER_KIND,
                      requestId: input.requestId,
                      cause,
                    }),
              ),
            ),
        ),
        readThreadSnapshot: (input: ProviderAdapterV2ReadThreadSnapshotInput) =>
          Effect.fail(
            new ProviderAdapterReadThreadSnapshotError({
              driver: COPILOT_DRIVER_KIND,
              providerThreadId: input.providerThread.id,
              cause: "Copilot V2 adapter does not implement snapshots.",
            }),
          ),
        rollbackThread: Effect.fn("CopilotAdapterV2.rollbackThread")(
          function* (input: ProviderAdapterV2RollbackThreadInput) {
            const appThreadId = input.providerThread.appThreadId;
            if (appThreadId === null) {
              return yield* new ProviderAdapterRollbackThreadError({
                driver: COPILOT_DRIVER_KIND,
                providerThreadId: input.providerThread.id,
                cause: "Copilot provider thread has no app thread.",
              });
            }
            let turnsToRemove = input.providerThreadTurns.length;
            if (input.target.type === "provider_turn") {
              const targetOrdinal = input.target.providerTurn.ordinal;
              turnsToRemove = input.providerThreadTurns.filter(
                (providerTurn) => providerTurn.ordinal > targetOrdinal,
              ).length;
            }
            if (turnsToRemove > 0) {
              yield* options.legacyAdapter.rollbackThread(appThreadId, turnsToRemove);
            }
            const updatedAt = yield* DateTime.now;
            return {
              providerThread: {
                ...input.providerThread,
                status: "idle" as const,
                lastRunOrdinal:
                  input.target.appRunOrdinal === 0 ? null : input.target.appRunOrdinal,
                updatedAt,
              },
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            };
          },
          (effect, input) =>
            effect.pipe(
              Effect.mapError((cause) =>
                isProviderAdapterRollbackThreadError(cause)
                  ? cause
                  : new ProviderAdapterRollbackThreadError({
                      driver: COPILOT_DRIVER_KIND,
                      providerThreadId: input.providerThread.id,
                      checkpointId: input.target.checkpointId,
                      cause,
                    }),
              ),
            ),
        ),
        forkThread: (input: ProviderAdapterV2ForkThreadInput) =>
          Effect.fail(
            new ProviderAdapterForkThreadError({
              driver: COPILOT_DRIVER_KIND,
              providerThreadId: input.sourceProviderThread.id,
              cause: "Copilot does not support provider thread forks.",
            }),
          ),
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterOpenSessionError({
              driver: COPILOT_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  ),
});

export type CopilotAdapterV2DriverEnv =
  | FileSystem.FileSystem
  | Path.Path
  | Context.Service.Identifier<typeof HostProcessPlatform>
  | ProviderEventLoggers
  | ServerConfig
  | IdAllocatorV2;

export const CopilotAdapterV2Driver: ProviderAdapterDriver<
  CopilotSettings,
  CopilotAdapterV2DriverEnv
> = {
  driverKind: COPILOT_DRIVER_KIND,
  configSchema: CopilotSettings,
  defaultConfig: () => DEFAULT_COPILOT_SETTINGS,
  create: Effect.fn("CopilotAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CopilotSettings>) {
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const idAllocator = yield* IdAllocatorV2;
      const baseDirectory = path.join(
        serverConfig.stateDir,
        "providers",
        "copilot",
        input.instanceId,
      );
      yield* fileSystem.makeDirectory(baseDirectory, { recursive: true });
      const legacyAdapter = yield* makeCopilotAdapter(
        { ...input.config, enabled: input.enabled },
        {
          instanceId: input.instanceId,
          baseDirectory,
          environment: mergeProviderInstanceEnvironment(input.environment),
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
      );
      return makeCopilotAdapterV2({
        instanceId: input.instanceId,
        legacyAdapter,
        idAllocator,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: COPILOT_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create GitHub Copilot adapter.",
              cause,
            }),
        ),
      ),
  ),
};
