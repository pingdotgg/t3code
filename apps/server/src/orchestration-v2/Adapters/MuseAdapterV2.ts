import { MspError, type SendUserTurnOptions } from "@muse-code/sdk";
import {
  MUSE_DEFAULT_MODEL,
  type MuseSettings,
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItemStatus,
  type NodeId,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type PlanId,
  type OrchestrationV2PlanStep,
  type RuntimeRequestId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import {
  museModelCapabilities,
  resolveMuseReasoningEffort,
} from "../../provider/museModelCatalog.ts";
import {
  MuseApproval,
  MuseCompactResult,
  MuseContextUsage,
  MuseDelta,
  MuseItemEvent,
  MuseSessionResult,
  MuseTokenUsageEvent,
  MuseTodoList,
  MuseTurnRetryScheduled,
  MuseTurnCompleted,
  MuseTurnStartResult,
  MuseUserInput,
  museApprovalChoices,
  museApprovalDecision,
  museApprovalOptions,
  type MuseItem,
} from "../../provider/museProtocol.ts";
import {
  createMuseSdkHostEffect,
  museApprovalMode,
  type createMuseSdkHost,
  type MuseSdkHost,
} from "../../provider/museSdk.ts";
import type { EventNdjsonLogger } from "../../provider/EventNdjsonLogger.ts";
import {
  providerMessageTextWithAttachmentPaths,
  isProviderNativeImageAttachment,
} from "../AttachmentPrompt.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
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
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2EnsureThreadInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2ThreadSnapshot,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2TurnMessage,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { backgroundWorkNotification, type BackgroundWorkReport } from "../Notification.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { museItemStatus, museToolPresentation } from "./MuseItemPresentation.ts";

const MUSE_PROVIDER = ProviderDriverKind.make("muse");
const isOpenSessionError = Schema.is(ProviderAdapterOpenSessionError);
const isProtocolError = Schema.is(ProviderAdapterProtocolError);

const MuseProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
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
    // Muse 1.2.1/1.3.0 reject tested completed-turn fork boundaries with InvalidCut.
    // Public forks use portable context handoff until native boundaries are validated.
    canRollbackThread: false,
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
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
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
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
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
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface MuseAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly modelCatalog?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  readonly createHost?: typeof createMuseSdkHost;
  readonly requestTimeoutMs?: number;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Where a turn Muse starts on its own (a finished workflow's report) asks for its run. */
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

interface ActiveTurn {
  readonly input: ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly nativeId: string;
  /** Turns Muse started on its own while this run was active, which this run shows. */
  readonly joined: Set<string>;
  readonly items: Map<string, MuseItem>;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  readonly dirty: Set<string>;
  readonly settledRequests: Set<string>;
  readonly done: Deferred.Deferred<void>;
  todoPlanId?: PlanId;
  nextOrdinal: number;
  flushScheduled: boolean;
  interruptRequested: boolean;
  compact: boolean;
}

interface PendingRequest {
  readonly native:
    | { type: "approval"; value: MuseApproval }
    | { type: "question"; value: MuseUserInput };
  request: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  item: OrchestrationV2TurnItem;
  /** What T3 answered, recorded on the request once Muse confirms it. */
  response?: Pick<OrchestrationV2RuntimeRequest, "decision" | "answers">;
}

const nativeRef = (nativeId: string) => ({
  driver: MUSE_PROVIDER,
  nativeId,
  strength: "strong" as const,
});
const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
// Notifications that only add detail. A malformed one is skipped instead of ending the session.
const INFORMATIONAL_NOTIFICATIONS = new Set([
  "session/contextUsage",
  "session/tokenUsage",
  "session/todoListChanged",
  "turn/retryScheduled",
]);
// Tools whose results already show as their own rows: T3's todo list and question
// rows, and the workflow item a `workflow` call launches.
const TOOLS_WITH_NATIVE_ROWS = new Set(["write_todos", "request_user_input", "workflow"]);
const responseAnswerSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

/** One scoped Muse host owns one native session; the orchestrator owns app runs and queuing. */
export function makeMuseAdapterV2(options: MuseAdapterV2Options): ProviderAdapterV2Shape {
  const { idAllocator } = options;
  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapterProtocolError({
      driver: MUSE_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });
  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: MUSE_PROVIDER,
    getCapabilities: () => Effect.succeed(MuseProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("MuseAdapterV2.openSession")(function* (
      input: ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.settings.enabled) return yield* protocolError("Muse Code is disabled");
      if (input.runtimePolicy.interactionMode === "plan")
        return yield* protocolError("Muse Code does not support dedicated Plan mode");
      const scope = yield* Effect.scope;
      // Muse rejects non-canonical workspace roots (for example macOS /tmp) and
      // reports canonical paths in approvals, so resolve symlinks once here.
      const requestedCwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
      const cwd = yield* options.fileSystem
        .realPath(requestedCwd)
        .pipe(Effect.orElseSucceed(() => requestedCwd));
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: MUSE_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: MuseProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapterV2Event,
        ProviderAdapterV2Error | Cause.Done
      >();
      type Inbox =
        | { type: "notification"; method: string; params: unknown; epoch: number }
        | { type: "failure"; cause: unknown; epoch: number }
        | { type: "flush"; turn: ActiveTurn };
      const inbox = yield* Queue.unbounded<Inbox>();
      const commands = yield* Semaphore.make(1);
      const eventPermit = yield* Semaphore.make(1);
      let host: MuseSdkHost;
      let hostEpoch = 0;
      let closed = false;
      let broken = false;
      let nativeSessionId: string | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      // The last finished turn, so context usage reported after it still lands on it.
      let lastProviderTurn: OrchestrationV2ProviderTurn | undefined;
      const agentEndedAt = new Map<string, DateTime.Utc>();
      // "default" is the catalog's default model, from the provider snapshot. Without
      // one, Muse keeps whatever model the session already runs.
      const resolveModel = Effect.fnUntraced(function* (selection: ModelSelection) {
        if (selection.model !== MUSE_DEFAULT_MODEL) return selection.model;
        const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
        return catalog.find((model) => model.isDefault && !model.isCustom)?.slug;
      });
      const pending = new Map<RuntimeRequestId, PendingRequest>();
      const seenTerminals = new Set<string>();
      // Workflows and subagents that outlive their turn, by item id, with the turn that owns them.
      const observedChildren = new Map<string, ActiveTurn>();
      // Background work that finished since the last turn, reported to the turn Muse starts for it.
      const finishedBackground: Array<BackgroundWorkReport> = [];
      // A turn Muse started on its own, held until the continuation run T3 opens for it takes it.
      let wake:
        | { readonly nativeId: string; readonly events: Array<[string, unknown]> }
        | undefined;
      const emit = (event: ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const decode = <A, I>(schema: Schema.Codec<A, I>, data: unknown) =>
        Schema.decodeUnknownEffect(schema)(data).pipe(
          Effect.mapError((cause) => protocolError("Invalid Muse protocol response", cause)),
        );
      const request = (
        method: string,
        params: Record<string, unknown>,
        command = true,
        commandId?: string,
      ) =>
        Effect.tryPromise({
          try: () =>
            command
              ? host.connection.command(
                  method,
                  { ...(nativeSessionId ? { sessionId: nativeSessionId } : {}), ...params },
                  {
                    ...(method === "turn/start" ? {} : { maxAttempts: 1 }),
                    ...(commandId ? { commandId } : {}),
                  },
                )
              : host.connection.request(method, {
                  ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
                  ...params,
                }),
          catch: (cause) =>
            protocolError(
              cause instanceof Error && cause.message
                ? `Muse ${method} failed: ${cause.message}`
                : `Muse ${method} failed`,
              cause,
            ),
        }).pipe(
          Effect.timeout(options.requestTimeoutMs ?? 30_000),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.gen(function* () {
                yield* eventPermit.withPermits(1)(failHost(cause));
                return yield* protocolError(`Muse ${method} timed out; its host was closed`, cause);
              }),
          }),
        );
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: MUSE_PROVIDER,
          providerSession: session,
        });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: MUSE_PROVIDER,
          providerThread: thread,
        });
      });
      const itemIdentity = (turn: ActiveTurn, nativeId: string) =>
        `${options.instanceId}:${turn.input.providerThread.id}:${turn.nativeId}:${nativeId}`;
      const baseItem = (turn: ActiveTurn, nativeId: string, time: DateTime.Utc) => {
        if (!turn.ordinals.has(nativeId)) turn.ordinals.set(nativeId, turn.nextOrdinal++);
        if (!turn.started.has(nativeId)) turn.started.set(nativeId, time);
        const identity = itemIdentity(turn, nativeId);
        return {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: MUSE_PROVIDER,
            nativeItemId: identity,
          }),
          nodeId: idAllocator.derive.nodeFromProviderItem({
            driver: MUSE_PROVIDER,
            nativeItemId: identity,
          }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: nativeRef(nativeId),
          parentItemId: null,
          ordinal: turn.ordinals.get(nativeId)!,
          startedAt: turn.started.get(nativeId)!,
          updatedAt: time,
        };
      };
      /** Lists running workflows and subagents on the thread, so it shows it still waits on them. */
      const syncBackground = Effect.fnUntraced(function* () {
        yield* updateThread({
          pendingBackgroundTasks: [...observedChildren].flatMap(([itemId, owner]) => {
            const item = owner.items.get(itemId);
            const description = item?.objective ?? item?.entryId ?? item?.fallbackText;
            return [
              {
                taskId: itemId,
                kind:
                  item?.kind === "subagent" ? ("subagent" as const) : ("background_task" as const),
                ...(description ? { description } : {}),
              },
            ];
          }),
        });
      });
      const publishItem = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        item: MuseItem,
        terminal?: OrchestrationV2TurnItem["status"],
      ) {
        // Muse's skill-reminder child runs on every model step; it is housekeeping, not work.
        if (item.kind === "userMessage" || item.kind === "reminderChild") return;
        // A failed call keeps its row: it may have no native row to show its error.
        if (
          item.kind === "toolCall" &&
          item.tool &&
          TOOLS_WITH_NATIVE_ROWS.has(item.tool) &&
          item.status !== "failed"
        )
          return;
        const time = yield* DateTime.now;
        const status = terminal ?? museItemStatus(item);
        if (item.kind === "subagent" || item.kind === "workflow") {
          const wasRunning = observedChildren.has(item.itemId);
          if (status === "running") observedChildren.set(item.itemId, turn);
          else if (observedChildren.delete(item.itemId) && active !== turn)
            finishedBackground.push({
              kind: item.kind === "subagent" ? "subagent" : "background_task",
              label: item.objective ?? item.entryId ?? item.fallbackText,
              outcome:
                status === "completed"
                  ? "completed"
                  : status === "cancelled"
                    ? "cancelled"
                    : "failed",
            });
          if (wasRunning !== observedChildren.has(item.itemId)) yield* syncBackground();
        }
        const streaming = status === "running";
        const base = {
          ...baseItem(turn, item.itemId, time),
          status,
          completedAt: streaming ? null : time,
          title: item.tool ?? null,
        };
        const text = item.text ?? item.summary?.join("\n") ?? item.fallbackText ?? "";
        let turnItem: OrchestrationV2TurnItem;
        if (item.kind === "agentMessage") {
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: MUSE_PROVIDER,
            nativeItemId: itemIdentity(turn, item.itemId),
          });
          const message: OrchestrationV2ConversationMessage = {
            id: messageId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            role: "assistant",
            text,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: base.startedAt,
            updatedAt: time,
          };
          yield* emit({ type: "message.updated", driver: MUSE_PROVIDER, message });
          turnItem = { ...base, type: "assistant_message", messageId, text, streaming };
        } else if (item.kind === "reasoning") {
          turnItem = { ...base, type: "reasoning", text, streaming };
        } else if (item.kind === "compaction") {
          turnItem = {
            ...base,
            type: "compaction",
            driver: MUSE_PROVIDER,
            summary: text || item.reason,
          };
        } else {
          turnItem = { ...base, ...museToolPresentation(item, status) };
        }
        yield* emit({
          type: "node.updated",
          driver: MUSE_PROVIDER,
          node: {
            id: base.nodeId,
            threadId: base.threadId,
            runId: base.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind:
              item.kind === "agentMessage"
                ? "assistant_message"
                : item.kind === "reasoning"
                  ? "reasoning"
                  : "tool_call",
            status,
            countsForRun: false,
            providerThreadId: base.providerThreadId,
            providerTurnId: base.providerTurnId,
            nativeItemRef: base.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: base.startedAt,
            completedAt: base.completedAt,
          },
        });
        yield* emit({ type: "turn_item.updated", driver: MUSE_PROVIDER, turnItem });
        if (item.kind === "workflow") yield* publishWorkflowAgents(turn, item, base, status);
      });
      /**
       * Shows each workflow child as a native subagent under the workflow row. Muse
       * reports only their status, label and outcome, not their conversations, so
       * they get no child thread.
       */
      const publishWorkflowAgents = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        item: MuseItem,
        workflow: { readonly id: OrchestrationV2TurnItem["id"]; readonly nodeId: NodeId },
        workflowStatus: OrchestrationV2TurnItemStatus,
      ) {
        const latest = new Map((item.children ?? []).map((child) => [child.childId, child]));
        for (const [index, child] of [...latest.values()].entries()) {
          const time = yield* DateTime.now;
          const base = baseItem(turn, `${item.itemId}:agent:${child.childId}`, time);
          const status: OrchestrationV2TurnItemStatus =
            child.terminal === "completed"
              ? "completed"
              : child.terminal === "cancelled"
                ? "cancelled"
                : child.terminal !== undefined
                  ? "failed"
                  : workflowStatus !== "running"
                    ? workflowStatus
                    : child.status === "scheduled"
                      ? "pending"
                      : "running";
          const settled = status !== "running" && status !== "pending";
          // Children are re-sent on every workflow change; keep each one's first end time.
          const endKey = `${item.itemId}:${child.childId}:${child.attempt}`;
          if (settled && !agentEndedAt.has(endKey)) agentEndedAt.set(endKey, time);
          const title = child.label?.trim() || `Agent ${index + 1}`;
          const result = child.failureReason ?? null;
          const subagent: OrchestrationV2Subagent = {
            id: base.nodeId,
            threadId: base.threadId,
            runId: base.runId,
            parentNodeId: workflow.nodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: MUSE_PROVIDER,
            providerInstanceId: options.instanceId,
            providerThreadId: base.providerThreadId,
            childThreadId: null,
            nativeTaskRef: nativeRef(child.childId),
            prompt: title,
            title,
            model: null,
            status,
            result,
            startedAt: base.startedAt,
            completedAt: settled ? (agentEndedAt.get(endKey) ?? time) : null,
            updatedAt: time,
          };
          yield* emit({ type: "subagent.updated", driver: MUSE_PROVIDER, subagent });
          yield* emit({
            type: "node.updated",
            driver: MUSE_PROVIDER,
            node: {
              id: base.nodeId,
              threadId: base.threadId,
              runId: base.runId,
              parentNodeId: workflow.nodeId,
              rootNodeId: turn.input.rootNodeId,
              kind: "subagent",
              status,
              countsForRun: false,
              providerThreadId: base.providerThreadId,
              providerTurnId: base.providerTurnId,
              nativeItemRef: subagent.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: base.startedAt,
              completedAt: subagent.completedAt,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: MUSE_PROVIDER,
            turnItem: {
              ...base,
              nativeItemRef: subagent.nativeTaskRef,
              parentItemId: workflow.id,
              type: "subagent",
              status,
              title,
              completedAt: subagent.completedAt,
              subagentId: subagent.id,
              origin: "provider_native",
              driver: MUSE_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: null,
              prompt: title,
              result,
            },
          });
        }
      });
      const settleObservedChildren = Effect.fnUntraced(function* (
        status: "failed" | "cancelled" | "interrupted",
      ) {
        for (const [itemId, owner] of observedChildren) {
          const item = owner.items.get(itemId);
          if (item) yield* publishItem(owner, item, status);
        }
        observedChildren.clear();
        if (thread?.pendingBackgroundTasks?.length) yield* syncBackground();
      });
      const resolvePending = Effect.fnUntraced(function* (
        entry: PendingRequest,
        status: "resolved" | "cancelled",
      ) {
        const time = yield* DateTime.now;
        entry.request = {
          ...entry.request,
          ...(status === "resolved" ? entry.response : undefined),
          status,
          resolvedAt: time,
          responseCapability: { type: "not_resumable", reason: "This Muse request has ended." },
        };
        entry.node = {
          ...entry.node,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
        };
        entry.item = {
          ...entry.item,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
          updatedAt: time,
        };
        pending.delete(entry.request.id);
        yield* emit({
          type: "runtime_request.updated",
          driver: MUSE_PROVIDER,
          threadId: input.threadId,
          runtimeRequest: entry.request,
        });
        yield* emit({ type: "node.updated", driver: MUSE_PROVIDER, node: entry.node });
        yield* emit({ type: "turn_item.updated", driver: MUSE_PROVIDER, turnItem: entry.item });
      });
      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "cancelled" | "interrupted" | "failed",
        detail?: string,
        disposition: "reusable" | "broken" = "reusable",
      ) {
        if (active !== turn || seenTerminals.has(turn.nativeId)) return;
        seenTerminals.add(turn.nativeId);
        const completedAt = yield* DateTime.now;
        for (const item of turn.items.values()) {
          if (
            (item.kind === "subagent" || item.kind === "workflow") &&
            item.status === "inProgress" &&
            disposition === "reusable"
          )
            continue;
          if (turn.dirty.has(item.itemId) || item.status === "inProgress")
            yield* publishItem(turn, item, item.status === "inProgress" ? status : undefined);
        }
        turn.dirty.clear();
        for (const entry of pending.values()) yield* resolvePending(entry, "cancelled");
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        lastProviderTurn = turn.providerTurn;
        yield* emit({
          type: "provider_turn.updated",
          driver: MUSE_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({
          status: disposition === "broken" ? "error" : "idle",
          ...(!turn.compact && status === "completed"
            ? { nativeConversationHeadRef: nativeRef(turn.nativeId) }
            : {}),
        });
        yield* updateSession(disposition === "broken" ? "error" : "ready", detail ?? null);
        active = undefined;
        if (status === "failed") {
          const failure = makeProviderFailure({
            class: disposition === "broken" ? "transport_error" : "provider_error",
            message: detail ?? "Muse turn failed.",
          });
          const base = baseItem(turn, `failure:${turn.nativeId}`, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: MUSE_PROVIDER,
            turnItem: {
              ...base,
              type: "error",
              status: "failed",
              title: null,
              completedAt,
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: MUSE_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure,
            failureItemOrdinal: base.ordinal,
            threadDisposition: disposition,
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: MUSE_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: disposition,
          });
        }
        yield* Deferred.succeed(turn.done, undefined);
      });
      const failHost = Effect.fnUntraced(function* (cause: unknown) {
        if (closed || broken) return;
        broken = true;
        const rootCause = Cause.isCause(cause) ? Cause.squash(cause) : cause;
        const failure = isOpenSessionError(rootCause) ? rootCause.cause : rootCause;
        const detail = isProtocolError(failure)
          ? failure.detail
          : failure instanceof Error
            ? failure.message
            : "Muse transport failed.";
        if (active) yield* finish(active, "failed", detail, "broken");
        else {
          yield* updateThread({ status: "error" });
          yield* updateSession("error", detail);
        }
        yield* settleObservedChildren("failed");
        yield* Queue.fail(events, protocolError(detail, cause));
        // Report the failure first; a hung host can take a while to close.
        const failed = host;
        yield* Effect.tryPromise(() => failed.close()).pipe(Effect.ignore, Effect.forkIn(scope));
      });
      const owns = (turn: ActiveTurn, turnId: string) =>
        turnId === turn.nativeId || turn.joined.has(turnId);
      const publishRequest = Effect.fnUntraced(function* (native: PendingRequest["native"]) {
        const turn = active;
        if (
          !turn ||
          native.value.sessionId !== nativeSessionId ||
          (native.value.turnId && !owns(turn, native.value.turnId))
        )
          return;
        const nativeId =
          native.type === "approval" ? native.value.approvalId : native.value.userInputId;
        if (turn.settledRequests.has(`${native.type}:${nativeId}`)) return;
        const previous = [...pending.values()].find(
          (entry) =>
            entry.native.type === native.type &&
            entry.request.nativeRequestRef?.nativeId === nativeId,
        );
        const requestId =
          previous?.request.id ??
          (yield* idAllocator.allocate
            .runtimeRequest({
              driver: MUSE_PROVIDER,
              providerTurnId: turn.providerTurn.id,
              nativeRequestId: nativeId,
            })
            .pipe(
              Effect.mapError((cause) => protocolError("Cannot allocate Muse request", cause)),
            ));
        const time = yield* DateTime.now;
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const subject = native.type === "approval" ? native.value.subject : undefined;
        const kind = !subject
          ? "user_input"
          : subject.kind === "shell"
            ? "command"
            : subject.kind !== "fileAccess"
              ? "permission"
              : subject.access === "read"
                ? "file-read"
                : "file-change";
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn.providerTurn.id,
          nativeRequestRef: nativeRef(nativeId),
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: previous?.request.createdAt ?? time,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: native.type === "approval" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: nativeRef(nativeId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: runtimeRequest.createdAt,
          completedAt: null,
        };
        const base = {
          ...baseItem(turn, `request:${nativeId}`, time),
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          nodeId,
          status: "waiting" as const,
          title: null,
          completedAt: null,
        };
        const item: OrchestrationV2TurnItem =
          native.type === "approval"
            ? {
                ...base,
                type: "approval_request",
                requestId,
                requestKind: kind === "user_input" ? "command" : kind,
                prompt:
                  native.value.subject.command ??
                  native.value.subject.path ??
                  native.value.subject.host ??
                  native.value.subject.target ??
                  native.value.toolName ??
                  "Muse requests permission",
                options: museApprovalOptions(native.value),
              }
            : {
                ...base,
                type: "user_input_request",
                requestId,
                questions: native.value.questions.map((question) => ({
                  id: question.id,
                  header: question.header || "Question",
                  question: question.question,
                  options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description || option.label,
                  })),
                  multiSelect: question.selection.mode === "multiple",
                  allowCustomAnswer: true,
                  required: true,
                })),
              };
        pending.set(requestId, { native, request: runtimeRequest, node, item });
        yield* emit({
          type: "runtime_request.updated",
          driver: MUSE_PROVIDER,
          threadId: turn.input.threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: MUSE_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: MUSE_PROVIDER, turnItem: item });
        yield* updateSession("waiting");
      });
      const handleNotification = Effect.fnUntraced(function* (method: string, data: unknown) {
        const params = yield* decode(recordSchema, data);
        if (params.sessionId !== nativeSessionId) return;
        if (method === "view/gap")
          return yield* protocolError("Muse delivery gap requires session recovery");
        if (method === "session/contextUsage") {
          const usage = yield* decode(MuseContextUsage, params);
          const currentTurn = active?.providerTurn ?? lastProviderTurn;
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          const tokenUsage = {
            ...currentTurn?.tokenUsage,
            usedTokens: usage.usedTokens,
            maxTokens: usage.windowTokens ?? currentTurn?.tokenUsage?.maxTokens ?? undefined,
            updatedAt,
          };
          yield* updateThread({ contextUsage: tokenUsage });
          if (currentTurn) {
            const updated = { ...currentTurn, tokenUsage };
            if (active) active.providerTurn = updated;
            else lastProviderTurn = updated;
            yield* emit({
              type: "provider_turn.updated",
              driver: MUSE_PROVIDER,
              providerTurn: updated,
            });
          }
          return;
        }
        const itemEvent = ["item/started", "item/updated", "item/completed"].includes(method)
          ? (yield* decode(MuseItemEvent, params)).item
          : undefined;
        if (itemEvent) {
          const owner = observedChildren.get(itemEvent.itemId);
          if (owner && owner !== active && itemEvent.turnId === owner.nativeId) {
            const previous = owner.items.get(itemEvent.itemId);
            if (!previous || itemEvent.revision > previous.revision) {
              owner.items.set(itemEvent.itemId, itemEvent);
              yield* publishItem(owner, itemEvent);
            }
            return;
          }
        }
        // Muse starts a turn on its own when a workflow finishes, to report its result.
        // During a run, that run shows it. Otherwise hold it and ask the orchestrator for
        // a run; that run takes the held events, unless a user turn takes them first.
        if (
          method === "turn/started" &&
          typeof params.turnId === "string" &&
          params.turnId !== active?.nativeId &&
          params.turnId !== wake?.nativeId
        ) {
          if (active && !active.compact) active.joined.add(params.turnId);
          else if (!active && !wake) {
            const held = { nativeId: params.turnId, events: [] };
            wake = held;
            const notification = backgroundWorkNotification(finishedBackground.splice(0));
            if (thread?.appThreadId && options.continuationRequests)
              yield* options.continuationRequests.offer({
                threadId: thread.appThreadId,
                providerThreadId: thread.id,
                driver: MUSE_PROVIDER,
                detail: null,
                ...(notification ? { notification } : {}),
                dispatchIfCurrent: (dispatch) =>
                  wake === held ? Effect.map(dispatch, Option.some) : Effect.succeed(Option.none()),
                clearIfCurrent: () =>
                  Effect.sync(() => {
                    if (wake === held) wake = undefined;
                  }),
              });
          }
        }
        if (wake && active?.nativeId !== wake.nativeId) {
          const turnId = typeof params.turnId === "string" ? params.turnId : itemEvent?.turnId;
          if (turnId === wake.nativeId) {
            wake.events.push([method, data]);
            return;
          }
        }
        const turn = active;
        if (!turn) return;
        if (typeof params.turnId === "string" && !owns(turn, params.turnId) && !turn.compact)
          return;
        switch (method) {
          case "item/started":
          case "item/updated":
          case "item/completed": {
            const item = itemEvent!;
            if (
              item.turnId &&
              !owns(turn, item.turnId) &&
              !(turn.compact && item.kind === "compaction")
            )
              return;
            const previous = turn.items.get(item.itemId);
            if (previous && previous.revision >= item.revision) return;
            turn.items.set(item.itemId, item);
            turn.dirty.delete(item.itemId);
            yield* publishItem(turn, item);
            if (turn.compact && item.kind === "compaction" && item.status !== "inProgress") {
              yield* finish(
                turn,
                item.status === "completed" && (!item.outcome || item.outcome === "compacted")
                  ? "completed"
                  : item.status === "cancelled"
                    ? "cancelled"
                    : "failed",
                item.failureReason ?? item.reason,
              );
            }
            break;
          }
          case "item/delta": {
            const delta = yield* decode(MuseDelta, params);
            const previous = turn.items.get(delta.itemId);
            if (!previous || previous.status !== "inProgress") return;
            const field = delta.field ?? "text";
            let item = previous;
            if (field === "text") item = { ...previous, text: (previous.text ?? "") + delta.delta };
            else if (field === "output" || field === "visibleOutput")
              item = { ...previous, visibleOutput: (previous.visibleOutput ?? "") + delta.delta };
            else if (field.startsWith("summary.")) {
              const index = Number(field.slice(8));
              if (Number.isSafeInteger(index) && index >= 0 && index < 100) {
                const summary = [...(previous.summary ?? [])];
                summary[index] = (summary[index] ?? "") + delta.delta;
                item = { ...previous, summary };
              }
            }
            if (item === previous) return;
            turn.items.set(item.itemId, item);
            turn.dirty.add(item.itemId);
            if (!turn.flushScheduled) {
              turn.flushScheduled = true;
              yield* Effect.sleep(50).pipe(
                Effect.andThen(Queue.offer(inbox, { type: "flush", turn })),
                Effect.forkIn(scope),
              );
            }
            break;
          }
          case "turn/completed": {
            if (turn.compact) return;
            const result = yield* decode(MuseTurnCompleted, params);
            // A joined Muse turn ending does not end this run; its own turn does.
            if (result.turnId !== turn.nativeId) break;
            if (result.usage) {
              const usage = result.usage;
              turn.providerTurn = {
                ...turn.providerTurn,
                turnTokenUsage: {
                  usageScope: "main_agent",
                  usageStatus: "complete",
                  hasSubagents: [...turn.items.values()].some((item) => item.kind === "subagent"),
                  inputTokens: turn.providerTurn.turnTokenUsage?.inputTokens ?? usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cachedInputTokens: usage.cacheReadTokens ?? usage.cachedTokens,
                  reasoningTokens: usage.reasoningTokens,
                  ...(usage.cacheWriteTokens === undefined
                    ? {}
                    : { cacheCreationTokens: usage.cacheWriteTokens }),
                },
              };
            }
            const status =
              result.terminal === "completed"
                ? "completed"
                : result.terminal === "cancelled"
                  ? turn.interruptRequested
                    ? "interrupted"
                    : "cancelled"
                  : "failed";
            yield* finish(turn, status, result.error?.message ?? result.reason);
            break;
          }
          case "approval/requested":
          case "approval/updated":
            if (
              method === "approval/updated" &&
              ![...pending.values()].some(
                (entry) =>
                  entry.native.type === "approval" &&
                  entry.native.value.approvalId === params.approvalId,
              )
            )
              break;
            yield* publishRequest({ type: "approval", value: yield* decode(MuseApproval, params) });
            break;
          case "userInput/requested":
            yield* publishRequest({
              type: "question",
              value: yield* decode(MuseUserInput, params),
            });
            break;
          case "approval/resolved":
          case "userInput/settled": {
            const id = method === "approval/resolved" ? params.approvalId : params.userInputId;
            if (typeof id === "string")
              turn.settledRequests.add(
                `${method === "approval/resolved" ? "approval" : "question"}:${id}`,
              );
            const entry = [...pending.values()].find(
              (candidate) => candidate.request.nativeRequestRef?.nativeId === id,
            );
            if (entry) {
              // An approval settled outside T3 still shows Muse's own decision.
              const native =
                method === "approval/resolved" && typeof params.decision === "string"
                  ? museApprovalDecision({ decision: params.decision, scope: "once" })
                  : undefined;
              if (!entry.response && native) entry.response = { decision: native };
              yield* resolvePending(entry, "resolved");
            }
            if (!pending.size) yield* updateSession("running");
            break;
          }
          case "session/tokenUsage": {
            const usage = yield* decode(MuseTokenUsageEvent, params);
            const previous = turn.providerTurn.turnTokenUsage;
            const contextUsage = thread?.contextUsage;
            turn.providerTurn = {
              ...turn.providerTurn,
              ...(contextUsage
                ? {
                    tokenUsage: {
                      ...turn.providerTurn.tokenUsage,
                      usedTokens: contextUsage.usedTokens,
                      inputTokens: usage.usage.inputTokens,
                      outputTokens: usage.usage.outputTokens,
                      cachedInputTokens: usage.usage.cacheReadTokens ?? usage.usage.cachedTokens,
                      reasoningOutputTokens: usage.usage.reasoningTokens,
                      updatedAt: DateTime.formatIso(yield* DateTime.now),
                    },
                  }
                : {}),
              turnTokenUsage: {
                usageScope: "main_agent",
                usageStatus: "partial",
                hasSubagents: [...turn.items.values()].some((item) => item.kind === "subagent"),
                inputTokens: (previous?.inputTokens ?? 0) + usage.promptTokens,
                outputTokens: (previous?.outputTokens ?? 0) + usage.usage.outputTokens,
                cachedInputTokens:
                  (previous?.cachedInputTokens ?? 0) +
                  (usage.usage.cacheReadTokens ?? usage.usage.cachedTokens),
                ...(usage.usage.cacheWriteTokens === undefined &&
                previous?.cacheCreationTokens === undefined
                  ? {}
                  : {
                      cacheCreationTokens:
                        (previous?.cacheCreationTokens ?? 0) + (usage.usage.cacheWriteTokens ?? 0),
                    }),
                reasoningTokens: (previous?.reasoningTokens ?? 0) + usage.usage.reasoningTokens,
              },
            };
            yield* emit({
              type: "provider_turn.updated",
              driver: MUSE_PROVIDER,
              providerTurn: turn.providerTurn,
            });
            break;
          }
          case "session/todoListChanged": {
            const todo = yield* decode(MuseTodoList, params);
            const steps: ReadonlyArray<OrchestrationV2PlanStep> = todo.items
              .filter((item) => item.text.trim() && item.status !== "cancelled")
              .map((item, index) => ({
                id: `${turn.nativeId}:todo:${index}`,
                text: item.text.trim(),
                status:
                  item.status === "completed"
                    ? "completed"
                    : item.status === "inProgress"
                      ? "running"
                      : "pending",
              }));
            const time = yield* DateTime.now;
            const base = baseItem(turn, "todo", time);
            const planId =
              turn.todoPlanId ??
              (yield* idAllocator.allocate
                .plan({
                  threadId: turn.input.threadId,
                  runId: turn.input.runId,
                  driver: MUSE_PROVIDER,
                })
                .pipe(
                  Effect.mapError((cause) =>
                    protocolError("Cannot allocate Muse todo list", cause),
                  ),
                ));
            turn.todoPlanId = planId;
            yield* emit({
              type: "plan.updated",
              driver: MUSE_PROVIDER,
              plan: {
                id: planId,
                threadId: turn.input.threadId,
                runId: turn.input.runId,
                nodeId: base.nodeId,
                kind: "todo_list",
                status: steps.every((step) => step.status === "completed") ? "completed" : "active",
                steps,
              },
            });
            yield* emit({
              type: "node.updated",
              driver: MUSE_PROVIDER,
              node: {
                id: base.nodeId,
                threadId: base.threadId,
                runId: base.runId,
                parentNodeId: turn.input.rootNodeId,
                rootNodeId: turn.input.rootNodeId,
                kind: "todo_list",
                status: "completed",
                countsForRun: false,
                providerThreadId: base.providerThreadId,
                providerTurnId: base.providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: base.startedAt,
                completedAt: time,
              },
            });
            yield* emit({
              type: "turn_item.updated",
              driver: MUSE_PROVIDER,
              turnItem: {
                ...base,
                nativeItemRef: null,
                type: "todo_list",
                status: "completed",
                title: null,
                completedAt: time,
                planId,
                steps,
              },
            });
            break;
          }
          case "turn/retryScheduled": {
            const retry = yield* decode(MuseTurnRetryScheduled, params);
            const time = yield* DateTime.now;
            yield* emit({
              type: "turn_item.updated",
              driver: MUSE_PROVIDER,
              turnItem: {
                ...baseItem(turn, `retry:${retry.nextAttempt}`, time),
                type: "system_notice",
                status: "completed",
                title: "Muse retry",
                completedAt: time,
                message: `Muse is retrying this turn (attempt ${retry.nextAttempt} of ${retry.maxAttempts}): ${retry.reason}`,
              },
            });
            break;
          }
        }
      });
      yield* Stream.fromQueue(inbox).pipe(
        Stream.runForEach((entry) =>
          Effect.gen(function* () {
            if (entry.type === "flush") {
              const turn = entry.turn;
              turn.flushScheduled = false;
              if (active !== turn) return;
              for (const id of turn.dirty) {
                const item = turn.items.get(id);
                if (item) yield* publishItem(turn, item);
              }
              turn.dirty.clear();
            } else if (entry.epoch === hostEpoch) {
              if (entry.type === "failure") yield* failHost(entry.cause);
              else {
                if (options.nativeEventLogger && entry.method !== "item/delta")
                  yield* options.nativeEventLogger.write(
                    { provider: "muse", method: entry.method, params: entry.params },
                    input.threadId,
                  );
                yield* handleNotification(entry.method, entry.params).pipe(
                  Effect.catch((cause) =>
                    INFORMATIONAL_NOTIFICATIONS.has(entry.method)
                      ? Effect.logWarning(`Skipped an unreadable Muse ${entry.method}`, cause)
                      : failHost(cause),
                  ),
                );
              }
            }
          }).pipe(eventPermit.withPermits(1)),
        ),
        Effect.forkIn(scope),
      );
      const launchHost = Effect.fnUntraced(function* () {
        const epoch = ++hostEpoch;
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const created = yield* Effect.acquireRelease(
          createMuseSdkHostEffect(
            {
              binaryPath: options.settings.binaryPath || "muse",
              cwd,
              environment: McpProviderSession.withAgentDeviceEnvironment(
                options.environment,
                mcpSession,
              ),
              runtimeMode: input.runtimePolicy.runtimeMode,
            },
            options.createHost,
          ).pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterOpenSessionError({
                  driver: MUSE_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause: error.cause,
                }),
            ),
          ),
          (created) =>
            Effect.gen(function* () {
              if (host === created) {
                closed = true;
                hostEpoch++;
              }
              yield* Effect.tryPromise(() => created.close()).pipe(Effect.ignore);
            }),
          { interruptible: true },
        ).pipe(Effect.provideService(Scope.Scope, scope));
        host = created;
        created.connection.onNotification((notification) => {
          Queue.offerUnsafe(inbox, {
            type: "notification",
            method: notification.method,
            params: notification.params,
            epoch,
          });
        });
        created.connection.onProtocolError((cause) => {
          Queue.offerUnsafe(inbox, { type: "failure", cause, epoch });
        });
        // These are presentation receipts only. The matching notifications drive the UI,
        // and decisions travel as `approval/decide` and `userInput/answer` commands.
        created.connection.onServerRequest(async (request) => {
          if (request.method === "approval/request" || request.method === "userInput/request")
            return {};
          throw new Error(`Unsupported Muse server request: ${request.method}`);
        });
        void created.connection.closed.then(() => {
          if (!closed && epoch === hostEpoch)
            Queue.offerUnsafe(inbox, {
              type: "failure",
              cause: new Error("Muse connection closed unexpectedly"),
              epoch,
            });
        });
        void created.exited.then((exit) => {
          if (!closed && epoch === hostEpoch) {
            const reason = created
              .stderrTail?.()
              .findLast((line) => line.trim())
              ?.trim();
            Queue.offerUnsafe(inbox, {
              type: "failure",
              cause: new Error(
                `Muse exited unexpectedly (${exit.code ?? exit.signal})${reason ? `: ${reason}` : ""}`,
              ),
              epoch,
            });
          }
        });
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          hostEpoch++;
          if (active) yield* finish(active, "cancelled", "Muse session closed", "broken");
          yield* settleObservedChildren("cancelled");
          yield* Queue.shutdown(inbox);
          yield* Queue.shutdown(events);
        }).pipe(eventPermit.withPermits(1)),
      );
      yield* launchHost();

      const register = Effect.fnUntraced(function* (args: ProviderAdapterV2EnsureThreadInput) {
        if (broken || closed)
          return yield* protocolError("Muse host is unavailable; reopen the session");
        if (active)
          return yield* protocolError("Cannot change Muse sessions during an active turn");
        const existing = args.existingProviderThread;
        if (
          existing &&
          (existing.driver !== MUSE_PROVIDER || existing.providerInstanceId !== options.instanceId)
        )
          return yield* protocolError("Muse thread belongs to another provider instance");
        const requestedId = existing
          ? (existing.nativeThreadRef?.nativeId ?? undefined)
          : input.initialNativeThreadId;
        if (
          thread &&
          (!requestedId || requestedId === nativeSessionId) &&
          thread.appThreadId === args.threadId
        )
          return thread;
        if (thread) return yield* protocolError("Open a new host to attach another Muse session");
        let missingNativeSession = false;
        return yield* Effect.gen(function* () {
          nativeSessionId = requestedId ?? host.connection.mintCommandId();
          const mcpSession = McpProviderSession.readMcpProviderSession(args.threadId);
          if (mcpSession && !host.initializeResult.grantedCapabilities.includes("sessionMcp"))
            return yield* protocolError(
              "Update Muse Code to a version that supports session MCP servers",
            );
          const config = mcpSession
            ? {
                mcpServers: {
                  // Muse defaults to "required", which fails the whole run when T3's
                  // tools cannot be reached. The agent should still work without them.
                  "t3-code": {
                    transport: "streamableHttp",
                    mode: "optional",
                    url: mcpSession.endpoint,
                    headers: { Authorization: mcpSession.authorizationHeader },
                  },
                },
              }
            : undefined;
          const startModel = yield* resolveModel(args.modelSelection);
          const result = yield* request(
            requestedId ? "session/resume" : "session/start",
            requestedId
              ? // T3 already has the transcript; skip Muse's history payload.
                { excludeItems: true, ...(config ? { config } : {}) }
              : {
                  workspaceRoot: cwd,
                  ...(config ? { config } : {}),
                  ...(startModel ? { modelId: startModel } : {}),
                  providerId: "meta",
                  approvalMode: museApprovalMode(args.runtimePolicy.runtimeMode),
                },
          ).pipe(
            Effect.catch((error) => {
              missingNativeSession =
                requestedId !== undefined &&
                error.payload instanceof MspError &&
                (error.payload.kind === "sessionNotFound" || error.payload.kind === "notFound");
              return Effect.fail(error);
            }),
            Effect.flatMap((value) => decode(MuseSessionResult, value)),
          );
          if (result.session.sessionId !== nativeSessionId)
            return yield* protocolError("Muse returned a different session identity");
          if (requestedId)
            yield* request("session/setApprovalMode", {
              mode: museApprovalMode(args.runtimePolicy.runtimeMode),
            });
          // A resumed session keeps the model it last ran with; the next turn
          // switches it when the selection differs.
          const createdAt = yield* DateTime.now;
          thread = existing
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: nativeRef(result.session.sessionId),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: MUSE_PROVIDER,
                  providerInstanceId: options.instanceId,
                  nativeThreadId: nativeSessionId,
                }),
                driver: MUSE_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: args.threadId,
                ownerNodeId: null,
                nativeThreadRef: nativeRef(nativeSessionId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              };
          session = {
            ...session,
            model: result.session.modelId ?? args.modelSelection.model,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: MUSE_PROVIDER,
            providerThread: thread,
          });
          return thread;
        }).pipe(
          Effect.onError((cause) =>
            missingNativeSession ? Effect.void : eventPermit.withPermits(1)(failHost(cause)),
          ),
        );
      });
      const prompt = Effect.fnUntraced(function* (message: ProviderAdapterV2TurnMessage) {
        const parts: SendUserTurnOptions<unknown>["input"] = [];
        const text = providerMessageTextWithAttachmentPaths({
          text: message.text,
          attachments: message.attachments,
          attachmentsDir: options.serverConfig.attachmentsDir,
        });
        if (text) parts.push({ type: "text", text });
        for (const attachment of message.attachments)
          if (isProviderNativeImageAttachment(attachment)) {
            const path = resolveAttachmentPath({
              attachmentsDir: options.serverConfig.attachmentsDir,
              attachment,
            });
            if (!path) return yield* protocolError("Muse image attachment is missing");
            const bytes = yield* options.fileSystem
              .readFile(path)
              .pipe(Effect.mapError((cause) => protocolError("Cannot read Muse image", cause)));
            parts.push({
              type: "image",
              base64Data: Buffer.from(bytes).toString("base64"),
              mediaType: attachment.mimeType,
            });
          }
        if (!parts.length) return yield* protocolError("Muse needs text or an image");
        return parts;
      });
      const validateThread = (candidate: OrchestrationV2ProviderThread) =>
        thread !== undefined &&
        candidate.driver === MUSE_PROVIDER &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.appThreadId === thread.appThreadId &&
        candidate.nativeThreadRef?.nativeId === nativeSessionId;
      const selectionEffort = Effect.fnUntraced(function* (selection: ModelSelection) {
        if (selection.instanceId !== options.instanceId)
          return yield* protocolError("Model selection belongs to another Muse instance");
        const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
        const model = yield* resolveModel(selection);
        const selected = getModelSelectionStringOptionValue(selection, "reasoningEffort");
        // With no saved choice, the model's own default applies.
        return resolveMuseReasoningEffort(
          catalog.find((entry) => entry.slug === model)?.capabilities ?? museModelCapabilities(),
          selected,
        );
      });
      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapterV2TurnInput,
        compact = false,
      ) {
        if (!validateThread(turnInput.providerThread) || broken || closed)
          return yield* protocolError("Muse thread is not attached to this host");
        if (active)
          return yield* protocolError(
            "Muse already has an active turn; queue through the orchestrator",
          );
        if (turnInput.runtimePolicy.interactionMode === "plan")
          return yield* protocolError("Muse does not support dedicated Plan mode");
        if (turnInput.runtimePolicy.runtimeMode !== input.runtimePolicy.runtimeMode)
          return yield* protocolError("Runtime policy changes require a fresh Muse host");
        // A continuation run takes the turn Muse already started; it sends no prompt.
        const continuation =
          turnInput.message.createdBy === "agent" &&
          turnInput.message.creationSource === "provider";
        const adopted = continuation ? wake : undefined;
        const effort = continuation ? undefined : yield* selectionEffort(turnInput.modelSelection);
        const parts = compact || continuation ? [] : yield* prompt(turnInput.message);
        const targetModel = continuation
          ? undefined
          : yield* resolveModel(turnInput.modelSelection);
        if (targetModel && session.model !== targetModel) {
          yield* request("session/setModel", {
            model: { modelId: targetModel, providerId: "meta" },
          });
          session = { ...session, model: targetModel };
        }
        const nativeId = adopted?.nativeId ?? host.connection.mintCommandId();
        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: MUSE_PROVIDER,
            nativeTurnId: `${options.instanceId}:${nativeSessionId}:${nativeId}`,
          }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: compact
            ? { ...nativeRef(nativeId), strength: "weak" }
            : nativeRef(nativeId),
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const turn: ActiveTurn = {
          input: turnInput,
          providerTurn,
          nativeId,
          joined: new Set(),
          items: new Map(),
          ordinals: new Map(),
          started: new Map(),
          dirty: new Set(),
          settledRequests: new Set(),
          done: yield* Deferred.make<void>(),
          nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          flushScheduled: false,
          interruptRequested: false,
          compact,
        };
        yield* Effect.gen(function* () {
          thread = turnInput.providerThread;
          active = turn;
          yield* emit({
            type: "provider_turn.updated",
            driver: MUSE_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* updateThread({
            status: "active",
            firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          yield* updateSession("running");
          // A user turn takes a held Muse turn: Muse runs it first, so this run shows it
          // (and its approvals), and the continuation asked for it is no longer needed.
          const held = wake;
          wake = undefined;
          if (continuation && !held) return yield* finish(turn, "completed");
          if (held && !continuation) turn.joined.add(held.nativeId);
          for (const [method, data] of held?.events ?? [])
            yield* handleNotification(method, data).pipe(Effect.catch(failHost));
        }).pipe(eventPermit.withPermits(1));
        if (continuation) return;
        yield* Effect.gen(function* () {
          if (compact) {
            const result = yield* request("session/compact", {}, true, nativeId).pipe(
              Effect.flatMap((value) => decode(MuseCompactResult, value)),
            );
            if (result.status === "noop")
              yield* eventPermit.withPermits(1)(
                finish(turn, "failed", result.reason ?? "Muse has no context to compact."),
              );
            else if (result.status !== "accepted")
              return yield* protocolError(
                `Muse returned an unsupported compaction status: ${result.status}`,
              );
          } else {
            const result = yield* request(
              "turn/start",
              {
                input: [
                  {
                    type: "text",
                    text: buildRuntimeInstructions({
                      harness: "Muse Code",
                      model: session.model ?? undefined,
                      reasoningEffort: effort,
                    }),
                  },
                  ...parts,
                ],
                displayText: turnInput.message.text || "Image attachment",
                // A resumed session keeps the root it was created with; pin it to
                // this thread's current checkout so edits land where T3 tracks them.
                workspaceRoots: [cwd],
                ifBusy: "queue",
                ...(effort ? { reasoningEffort: effort } : {}),
              },
              true,
              nativeId,
            ).pipe(Effect.flatMap((value) => decode(MuseTurnStartResult, value)));
            if (result.turnId !== nativeId) {
              yield* eventPermit.withPermits(1)(
                failHost(new Error("Muse admitted an unowned turn")),
              );
              return yield* protocolError("Muse admitted the turn under an unexpected identity");
            }
          }
        }).pipe(
          Effect.onError((cause) => {
            const error = Cause.squash(cause);
            const detail = isProtocolError(error)
              ? error.detail
              : error instanceof Error
                ? error.message
                : "Muse could not start the turn.";
            return eventPermit.withPermits(1)(finish(turn, "failed", detail));
          }),
        );
      });
      // Only messages are read back; T3 owns turn and item history.
      const snapshot = Effect.fnUntraced(function* (
        current: OrchestrationV2ProviderThread,
      ): Effect.fn.Return<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error> {
        const result = yield* request("session/read", { excludeItems: false }, false).pipe(
          Effect.flatMap((value) => decode(MuseSessionResult, value)),
        );
        if (result.session.sessionId !== nativeSessionId)
          return yield* protocolError("Muse snapshot belongs to a different session");
        const items = result.history?.items ?? result.history?.snapshot?.state.items ?? [];
        const now = yield* DateTime.now;
        return {
          providerThread: current,
          providerTurns: [],
          messages: items.flatMap((item): OrchestrationV2ConversationMessage[] =>
            item.kind === "agentMessage" || item.kind === "userMessage"
              ? [
                  {
                    id: idAllocator.derive.messageFromProviderItem({
                      driver: MUSE_PROVIDER,
                      nativeItemId: `${options.instanceId}:${current.id}:${item.turnId ?? "history"}:${item.itemId}`,
                    }),
                    threadId: current.appThreadId ?? input.threadId,
                    runId: null,
                    nodeId: null,
                    role: item.kind === "agentMessage" ? "assistant" : "user",
                    text: item.text ?? "",
                    attachments: [],
                    streaming: item.status === "inProgress",
                    createdBy: item.kind === "agentMessage" ? "agent" : "user",
                    creationSource: "provider",
                    createdAt: now,
                    updatedAt: now,
                  },
                ]
              : [],
          ),
          runtimeRequests: [...pending.values()].map((entry) => entry.request),
          providerPayload: items,
        };
      });
      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: MUSE_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        // A running workflow or a held Muse turn keeps the host: idle release must wait.
        hasPendingBackgroundWork: Effect.sync(
          () => observedChildren.size > 0 || wake !== undefined,
        ),
        ensureThread: (args) =>
          register(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterEnsureThreadError({
                  driver: MUSE_PROVIDER,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          register({
            threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
            modelSelection: args.modelSelection ?? input.modelSelection,
            runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: args.providerThread,
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterResumeThreadError({
                  driver: MUSE_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (args) =>
          start(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterTurnStartError({
                  driver: MUSE_PROVIDER,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        compactThread: (args) => start(args, true).pipe(commands.withPermits(1)),
        steerTurn: (args) =>
          Effect.gen(function* () {
            const turn = active;
            if (
              !turn ||
              turn.providerTurn.id !== args.providerTurnId ||
              !validateThread(args.providerThread) ||
              turn.compact
            )
              return yield* protocolError("This Muse turn cannot be steered");
            const parts = yield* prompt(args.message);
            const result = yield* request("turn/steer", {
              expectedTurnId: turn.nativeId,
              input: parts,
            }).pipe(Effect.flatMap((value) => decode(MuseTurnStartResult, value)));
            if (result.turnId !== turn.nativeId)
              return yield* protocolError("Muse steering targeted a different turn");
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterSteerRunError({
                  driver: MUSE_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (args) =>
          Effect.gen(function* () {
            const turn = active;
            if (
              !turn ||
              turn.providerTurn.id !== args.providerTurnId ||
              !validateThread(args.providerThread)
            )
              return yield* protocolError("This Muse turn is no longer active");
            turn.interruptRequested = true;
            if (turn.compact) {
              yield* eventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (active !== turn) return;
                  hostEpoch++;
                  yield* Effect.tryPromise(() => host.close()).pipe(
                    Effect.mapError((cause) => protocolError("Cannot stop Muse compaction", cause)),
                    Effect.onError(failHost),
                  );
                  broken = true;
                  yield* finish(turn, "interrupted", undefined, "broken");
                  yield* settleObservedChildren("interrupted");
                  yield* updateSession("stopped");
                  yield* Queue.end(events);
                }),
              );
              return;
            }
            // Muse runs a joined turn first, so Stop must end it too.
            for (const joined of turn.joined)
              yield* request("turn/interrupt", { turnId: joined }).pipe(Effect.ignore);
            yield* request("turn/interrupt", { turnId: turn.nativeId });
            yield* Deferred.await(turn.done).pipe(
              Effect.timeout(options.requestTimeoutMs ?? 30_000),
              Effect.mapError((cause) => protocolError("Muse did not confirm interruption", cause)),
              Effect.onError((cause) => eventPermit.withPermits(1)(failHost(cause))),
            );
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterInterruptError({
                  driver: MUSE_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (args) =>
          Effect.gen(function* () {
            const entry = pending.get(args.requestId);
            if (!entry) return yield* protocolError("This Muse request is no longer pending");
            if (entry.native.type === "approval") {
              const approval = entry.native.value;
              const choice = args.decision && museApprovalChoices(approval).get(args.decision);
              if (!choice) return yield* protocolError("Muse did not offer this approval decision");
              // Recorded first: Muse can settle the approval before it acknowledges the command.
              entry.response = { decision: args.decision };
              yield* request("approval/decide", {
                approvalId: approval.approvalId,
                requirementId: approval.currentRequirementId,
                choiceId: choice.choiceId,
              }).pipe(Effect.tapError(() => Effect.sync(() => delete entry.response)));
            } else {
              const questionRequest = entry.native.value;
              const answers = [];
              for (const question of questionRequest.questions) {
                const raw = yield* decode(responseAnswerSchema, args.answers?.[question.id]);
                const values = typeof raw === "string" ? [raw] : [...new Set(raw)];
                const selected = values.filter((value) =>
                  question.options.some((option) => option.label === value),
                );
                const freeText = values.filter((value) => !selected.includes(value)).join("\n");
                if (freeText.length > 500 || (!freeText && !selected.length))
                  return yield* protocolError(
                    "Muse needs a nonempty answer with at most 500 custom characters",
                  );
                if (
                  (question.selection.mode === "single" && selected.length > 1) ||
                  (selected.length > 0 &&
                    (selected.length < (question.selection.minSelections ?? 0) ||
                      selected.length > (question.selection.maxSelections ?? Infinity)))
                )
                  return yield* protocolError("Muse question selection count is invalid");
                answers.push({
                  questionId: question.id,
                  ...(selected.length
                    ? question.selection.mode === "single"
                      ? { selectedLabel: selected[0]! }
                      : { selectedLabels: selected }
                    : {}),
                  ...(freeText ? (selected.length ? { note: freeText } : { freeText }) : {}),
                });
              }
              if (args.answers) entry.response = { answers: args.answers };
              yield* request("userInput/answer", {
                userInputId: questionRequest.userInputId,
                answers,
              }).pipe(Effect.tapError(() => Effect.sync(() => delete entry.response)));
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRuntimeRequestResponseError({
                  driver: MUSE_PROVIDER,
                  requestId: args.requestId,
                  cause,
                }),
            ),
          ),
        readThreadSnapshot: (args) =>
          (!validateThread(args.providerThread)
            ? protocolError("Snapshot requested for a different Muse thread")
            : snapshot(args.providerThread)
          ).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterReadThreadSnapshotError({
                  driver: MUSE_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        // Muse rejects forks at completed-turn boundaries (InvalidCut), so T3 uses
        // portable context handoff for forks and does not rewind Muse conversations.
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapterRollbackThreadError({
              driver: MUSE_PROVIDER,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "Muse Code does not support conversation rollback in T3 Code.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapterForkThreadError({
              driver: MUSE_PROVIDER,
              providerThreadId: args.sourceProviderThread.id,
              cause: "Muse Code does not support native forks in T3 Code.",
            }),
          ),
      };
      return runtime;
    }),
  });
}
