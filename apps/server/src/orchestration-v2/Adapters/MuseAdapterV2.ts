import type { SendUserTurnOptions } from "@muse-code/sdk";
import {
  MuseSettings,
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type PlanId,
  type OrchestrationV2PlanStep,
  type RuntimeRequestId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import { resolveMuseReasoningEffort } from "../../provider/museModelCatalog.ts";
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
  MuseViewPage,
  museApprovalChoices,
  type MuseItem,
} from "../../provider/museProtocol.ts";
import { createMuseSdkHost, museApprovalMode, type MuseSdkHost } from "../../provider/museSdk.ts";
import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import {
  providerMessageTextWithAttachmentPaths,
  isProviderNativeImageAttachment,
} from "../AttachmentPrompt.ts";
import { IdAllocatorV2 } from "../IdAllocator.ts";
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
} from "../ProviderAdapter.ts";
import {
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import { museItemStatus, museToolPresentation } from "./MuseItemPresentation.ts";

export const MUSE_PROVIDER = ProviderDriverKind.make("muse");
const defaultMuseSettings = Schema.decodeSync(MuseSettings)({});

export const MuseProviderCapabilitiesV2 = {
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
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
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
    supportsMcpTools: false,
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
    emitsPlanUpdated: false,
    emitsTodoList: false,
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

export interface MuseAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly modelCatalog?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  readonly createHost?: typeof createMuseSdkHost;
  readonly requestTimeoutMs?: number;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly path: Path.Path;
}

interface ActiveTurn {
  readonly input: ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly nativeId: string;
  readonly items: Map<string, MuseItem>;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  readonly dirty: Set<string>;
  readonly settledRequests: Set<string>;
  readonly autoApprovals: Set<string>;
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
}

const nativeRef = (nativeId: string) => ({
  driver: MUSE_PROVIDER,
  nativeId,
  strength: "strong" as const,
});
const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
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
      const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
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
      let recovery: { nativeId: string; done: Deferred.Deferred<void> } | undefined;
      const pending = new Map<RuntimeRequestId, PendingRequest>();
      const providerTurns = new Map<string, OrchestrationV2ProviderTurn>();
      const messages = new Map<string, OrchestrationV2ConversationMessage>();
      const history = new Map<string, MuseItem>();
      const seenTerminals = new Set<string>();
      const historyTerminals = new Map<string, typeof MuseTurnCompleted.Type>();
      const observedChildren = new Map<string, ActiveTurn>();
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
          catch: (cause) => protocolError(`Muse ${method} failed`, cause),
        }).pipe(
          Effect.timeout(options.requestTimeoutMs ?? 30_000),
          Effect.catchTag("TimeoutError", (cause) =>
            Effect.gen(function* () {
              yield* eventPermit.withPermits(1)(failHost(cause));
              return yield* protocolError(`Muse ${method} timed out; its host was closed`, cause);
            }),
          ),
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
      const publishItem = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        item: MuseItem,
        terminal?: OrchestrationV2TurnItem["status"],
      ) {
        if (item.kind === "userMessage") return;
        const time = yield* DateTime.now;
        const status = terminal ?? museItemStatus(item);
        if (item.kind === "subagent") {
          if (status === "running") observedChildren.set(item.itemId, turn);
          else observedChildren.delete(item.itemId);
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
          messages.set(messageId, message);
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
      });
      const resolvePending = Effect.fnUntraced(function* (
        entry: PendingRequest,
        status: "resolved" | "cancelled",
      ) {
        const time = yield* DateTime.now;
        entry.request = {
          ...entry.request,
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
            item.kind === "subagent" &&
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
        providerTurns.set(turn.nativeId, turn.providerTurn);
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
        const detail = cause instanceof Error ? cause.message : "Muse transport failed.";
        yield* Effect.tryPromise(() => host.close()).pipe(Effect.ignore);
        if (active) yield* finish(active, "failed", detail, "broken");
        else {
          yield* updateThread({ status: "error" });
          yield* updateSession("error", detail);
        }
      });
      const publishRequest = Effect.fnUntraced(function* (native: PendingRequest["native"]) {
        const turn = active;
        if (
          !turn ||
          native.value.sessionId !== nativeSessionId ||
          (native.value.turnId && native.value.turnId !== turn.nativeId)
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
        if (native.type === "approval") {
          const approval = native.value;
          const relativePath = approval.subject.path?.trim()
            ? options.path.relative(
                options.path.resolve(cwd),
                options.path.resolve(cwd, approval.subject.path),
              )
            : undefined;
          const accept = museApprovalChoices(approval).get("accept");
          if (
            input.runtimePolicy.runtimeMode === "auto-accept-edits" &&
            approval.protectedWrite === false &&
            approval.judgeEscalated === false &&
            relativePath !== undefined &&
            relativePath !== "" &&
            relativePath !== ".." &&
            !relativePath.startsWith(`..${options.path.sep}`) &&
            !options.path.isAbsolute(relativePath) &&
            approval.subject.kind === "fileAccess" &&
            (approval.subject.access === "write" || approval.subject.access === "readWrite") &&
            accept?.scope === "once"
          ) {
            const key = `${nativeId}:${approval.currentRequirementId.sourceIndex}`;
            if (!turn.autoApprovals.has(key)) {
              turn.autoApprovals.add(key);
              // Run outside the notification permit: timeout cleanup acquires it.
              yield* request("approval/decide", {
                approvalId: nativeId,
                requirementId: approval.currentRequirementId,
                choiceId: accept.choiceId,
              }).pipe(
                Effect.catch((cause) =>
                  Queue.offer(inbox, { type: "failure", cause, epoch: hostEpoch }),
                ),
                Effect.forkIn(scope),
              );
            }
            return;
          }
        }
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
        const kind =
          native.type === "question"
            ? "user_input"
            : native.value.subject.kind === "shell"
              ? "command"
              : native.value.subject.access === "read"
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
                  native.value.toolName ??
                  "Muse requests permission",
                options: [...museApprovalChoices(native.value)].map(([decision, choice]) => ({
                  decision,
                  label: choice.label,
                })),
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
        if (method === "turn/completed") {
          const terminal = yield* decode(MuseTurnCompleted, params);
          historyTerminals.set(terminal.turnId, terminal);
          if (recovery && recovery.nativeId === terminal.turnId) {
            yield* Deferred.succeed(recovery.done, undefined);
            return;
          }
        }
        if (method === "view/gap")
          return yield* protocolError("Muse delivery gap requires session recovery");
        if (method === "session/contextUsage") {
          const usage = yield* decode(MuseContextUsage, params);
          const currentTurn = active?.providerTurn ?? [...providerTurns.values()].at(-1);
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
            else if (updated.nativeTurnRef?.nativeId)
              providerTurns.set(updated.nativeTurnRef.nativeId, updated);
            yield* emit({
              type: "provider_turn.updated",
              driver: MUSE_PROVIDER,
              providerTurn: updated,
            });
          }
          return;
        }
        if (["item/started", "item/updated", "item/completed"].includes(method)) {
          const { item } = yield* decode(MuseItemEvent, params);
          const owner = observedChildren.get(item.itemId);
          if (owner && owner !== active && item.turnId === owner.nativeId) {
            const previous = owner.items.get(item.itemId);
            if (!previous || item.revision > previous.revision) {
              owner.items.set(item.itemId, item);
              history.set(item.itemId, item);
              yield* publishItem(owner, item);
            }
            return;
          }
        }
        const turn = active;
        if (!turn) {
          if (method === "turn/started")
            return yield* protocolError("Muse started a turn without an owning T3 run");
          return;
        }
        if (typeof params.turnId === "string" && params.turnId !== turn.nativeId && !turn.compact)
          return;
        switch (method) {
          case "item/started":
          case "item/updated":
          case "item/completed": {
            const { item } = yield* decode(MuseItemEvent, params);
            if (
              item.turnId &&
              item.turnId !== turn.nativeId &&
              !(turn.compact && item.kind === "compaction")
            )
              return;
            const previous = turn.items.get(item.itemId);
            if (previous && previous.revision >= item.revision) return;
            turn.items.set(item.itemId, item);
            history.set(item.itemId, item);
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
            if (entry) yield* resolvePending(entry, "resolved");
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
                if (options.nativeEventLogger)
                  yield* options.nativeEventLogger.write(
                    { provider: "muse", method: entry.method, params: entry.params },
                    input.threadId,
                  );
                yield* handleNotification(entry.method, entry.params).pipe(Effect.catch(failHost));
              }
            }
          }).pipe(eventPermit.withPermits(1)),
        ),
        Effect.forkIn(scope),
      );
      const launchHost = Effect.fnUntraced(function* () {
        const epoch = ++hostEpoch;
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const created = yield* Effect.tryPromise({
          try: (signal) =>
            (options.createHost ?? createMuseSdkHost)({
              binaryPath: options.settings.binaryPath || "muse",
              cwd,
              environment: McpProviderSession.withAgentDeviceEnvironment(
                options.environment,
                mcpSession,
              ),
              runtimeMode: input.runtimePolicy.runtimeMode,
              signal,
            }),
          catch: (cause) =>
            new ProviderAdapterOpenSessionError({
              driver: MUSE_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        });
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
        created.connection.onServerRequest(async (request) => {
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
          if (!closed && epoch === hostEpoch)
            Queue.offerUnsafe(inbox, {
              type: "failure",
              cause: new Error(`Muse host exited (${exit.code ?? exit.signal})`),
              epoch,
            });
        });
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            if (host === created) {
              closed = true;
              hostEpoch++;
            }
            yield* Effect.tryPromise(() => created.close()).pipe(Effect.ignore);
          }),
        );
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          hostEpoch++;
          if (active) yield* finish(active, "cancelled", "Muse session closed", "broken");
          yield* Queue.shutdown(inbox);
          yield* Queue.shutdown(events);
        }).pipe(eventPermit.withPermits(1)),
      );
      yield* launchHost();

      const loadHistory = Effect.fnUntraced(function* (
        result: typeof MuseSessionResult.Type,
        readTerminals = false,
      ) {
        const items = result.history?.items ?? result.history?.snapshot?.state.items;
        history.clear();
        if (items) {
          for (const item of items) history.set(item.itemId, item);
          if (!readTerminals) return;
        }
        if (!result.history) return;
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          const page: typeof MuseViewPage.Type = yield* request(
            "view/page",
            {
              sessionId: result.session.sessionId,
              direction: "forward",
              limit: 1000,
              ...(cursor ? { cursor } : {}),
            },
            false,
          ).pipe(Effect.flatMap((value) => decode(MuseViewPage, value)));
          for (const event of page.events)
            if (["item/started", "item/updated", "item/completed"].includes(event.method)) {
              const { item } = yield* decode(MuseItemEvent, event.params);
              const previous = history.get(item.itemId);
              if (!previous || previous.revision < item.revision) history.set(item.itemId, item);
            } else if (event.method === "turn/completed") {
              const terminal = yield* decode(MuseTurnCompleted, event.params);
              historyTerminals.set(terminal.turnId, terminal);
            }
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor))
            return yield* protocolError("Muse history paging did not advance");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      });
      const register = Effect.fnUntraced(function* (
        args: ProviderAdapterV2EnsureThreadInput,
        fresh = false,
      ) {
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
        const requestedId = fresh
          ? undefined
          : existing
            ? (existing.nativeThreadRef?.nativeId ?? undefined)
            : input.initialNativeThreadId;
        if (
          thread &&
          (!requestedId || requestedId === nativeSessionId) &&
          thread.appThreadId === args.threadId
        )
          return thread;
        if (thread) return yield* protocolError("Open a new host to attach another Muse session");
        return yield* Effect.gen(function* () {
          nativeSessionId = requestedId ?? host.connection.mintCommandId();
          const result = yield* request(
            requestedId ? "session/resume" : "session/start",
            requestedId
              ? { history: "inline" }
              : {
                  workspaceRoot: cwd,
                  modelId: args.modelSelection.model,
                  providerId: "meta",
                  approvalMode: museApprovalMode(args.runtimePolicy.runtimeMode),
                },
          ).pipe(Effect.flatMap((value) => decode(MuseSessionResult, value)));
          if (result.session.sessionId !== nativeSessionId)
            return yield* protocolError("Muse returned a different session identity");
          yield* loadHistory(result);
          if (result.session.activeTurnId && !historyTerminals.has(result.session.activeTurnId)) {
            recovery = {
              nativeId: result.session.activeTurnId,
              done: yield* Deferred.make<void>(),
            };
            yield* request("turn/interrupt", { turnId: recovery.nativeId });
            yield* Deferred.await(recovery.done).pipe(
              Effect.timeout(options.requestTimeoutMs ?? 30_000),
              Effect.mapError((cause) =>
                protocolError("Muse recovery interruption did not settle", cause),
              ),
            );
            recovery = undefined;
          }
          if (requestedId)
            yield* request("session/setApprovalMode", {
              mode: museApprovalMode(args.runtimePolicy.runtimeMode),
            });
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
          session = { ...session, model: result.session.modelId ?? args.modelSelection.model };
          yield* emit({
            type: "provider_thread.updated",
            driver: MUSE_PROVIDER,
            providerThread: thread,
          });
          return thread;
        }).pipe(Effect.onError((cause) => eventPermit.withPermits(1)(failHost(cause))));
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
        const selected = getModelSelectionStringOptionValue(selection, "reasoningEffort");
        const effort = resolveMuseReasoningEffort(
          catalog.find((model) => model.slug === selection.model)?.capabilities,
          selected ?? "max",
        );
        if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort))
          return yield* protocolError(`Muse SDK does not support '${effort}' reasoning effort`);
        return effort;
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
        const effort = yield* selectionEffort(turnInput.modelSelection);
        const parts = compact ? [] : yield* prompt(turnInput.message);
        if (session.model !== turnInput.modelSelection.model) {
          yield* request("session/setModel", {
            model: { modelId: turnInput.modelSelection.model, providerId: "meta" },
          });
          session = { ...session, model: turnInput.modelSelection.model };
        }
        const nativeId = host.connection.mintCommandId();
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
          items: new Map(),
          ordinals: new Map(),
          started: new Map(),
          dirty: new Set(),
          settledRequests: new Set(),
          autoApprovals: new Set(),
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
        }).pipe(eventPermit.withPermits(1));
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
          Effect.onError((cause) =>
            eventPermit.withPermits(1)(finish(turn, "failed", Cause.pretty(cause))),
          ),
        );
      });
      const snapshot = Effect.fnUntraced(function* (): Effect.fn.Return<
        ProviderAdapterV2ThreadSnapshot,
        ProviderAdapterV2Error
      > {
        if (!thread) return yield* protocolError("Muse has no registered thread");
        const result = yield* request("session/read", { excludeItems: false }, false).pipe(
          Effect.flatMap((value) => decode(MuseSessionResult, value)),
        );
        if (result.session.sessionId !== nativeSessionId)
          return yield* protocolError("Muse snapshot belongs to a different session");
        yield* loadHistory(result, true);
        return snapshotFromHistory(thread);
      });
      const snapshotFromHistory = (
        current: OrchestrationV2ProviderThread,
      ): ProviderAdapterV2ThreadSnapshot => {
        const turns = new Map<string, OrchestrationV2ProviderTurn>();
        const snapshotMessages: OrchestrationV2ConversationMessage[] = [];
        for (const item of history.values()) {
          const nativeTurnId = item.turnId;
          if (nativeTurnId && !turns.has(nativeTurnId)) {
            const known = providerTurns.get(nativeTurnId);
            turns.set(
              nativeTurnId,
              known ?? {
                id: idAllocator.derive.providerTurn({
                  driver: MUSE_PROVIDER,
                  nativeTurnId: `${options.instanceId}:${nativeSessionId}:${nativeTurnId}`,
                }),
                providerThreadId: current.id,
                nodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: MUSE_PROVIDER,
                  nativeItemId: `${current.id}:turn:${nativeTurnId}`,
                }),
                runAttemptId: null,
                nativeTurnRef: nativeRef(nativeTurnId),
                ordinal: turns.size + 1,
                status:
                  historyTerminals.get(nativeTurnId)?.terminal === "completed"
                    ? "completed"
                    : historyTerminals.get(nativeTurnId)?.terminal === "cancelled"
                      ? "cancelled"
                      : historyTerminals.has(nativeTurnId)
                        ? "failed"
                        : "pending",
                startedAt: null,
                completedAt: null,
              },
            );
          }
          if (item.kind !== "agentMessage" && item.kind !== "userMessage") continue;
          const id = idAllocator.derive.messageFromProviderItem({
            driver: MUSE_PROVIDER,
            nativeItemId: `${options.instanceId}:${current.id}:${nativeTurnId ?? "history"}:${item.itemId}`,
          });
          const existing = messages.get(id);
          snapshotMessages.push(
            existing ?? {
              id,
              threadId: current.appThreadId ?? input.threadId,
              runId: null,
              nodeId: null,
              role: item.kind === "agentMessage" ? "assistant" : "user",
              text: item.text ?? "",
              attachments: [],
              streaming: item.status === "inProgress",
              createdBy: item.kind === "agentMessage" ? "agent" : "user",
              creationSource: "provider",
              createdAt: current.createdAt,
              updatedAt: current.updatedAt,
            },
          );
        }
        return {
          providerThread: current,
          providerTurns: [...turns.values()],
          messages: snapshotMessages,
          runtimeRequests: [...pending.values()].map((entry) => entry.request),
          providerPayload: [...history.values()],
        };
      };
      const forkNative = Effect.fnUntraced(function* (
        source: OrchestrationV2ProviderThread,
        target?: OrchestrationV2ProviderTurn,
      ) {
        if (active || closed || broken)
          return yield* protocolError("Muse must be idle before forking");
        if (
          source.driver !== MUSE_PROVIDER ||
          source.providerInstanceId !== options.instanceId ||
          !source.nativeThreadRef
        )
          return yield* protocolError(
            "Muse fork source belongs to another instance or has no native identity",
          );
        if (
          target &&
          (target.providerThreadId !== source.id ||
            !target.nativeTurnRef ||
            target.nativeTurnRef.strength !== "strong" ||
            target.status !== "completed")
        )
          return yield* protocolError("Muse can only fork through a completed native turn");
        const result = yield* request("session/fork", {
          sessionId: source.nativeThreadRef.nativeId,
          ...(target?.nativeTurnRef
            ? { cutPoint: { lastTurnId: target.nativeTurnRef.nativeId } }
            : {}),
          excludeItems: false,
        }).pipe(Effect.flatMap((value) => decode(MuseSessionResult, value)));
        if (result.session.sessionId === source.nativeThreadRef.nativeId)
          return yield* protocolError("Muse fork did not create a distinct session");
        return result;
      });
      const attachFork = Effect.fnUntraced(function* (
        current: OrchestrationV2ProviderThread,
        result: typeof MuseSessionResult.Type,
      ) {
        // Forking may retain source and destination leases. A fresh scoped host
        // releases both before adopting the durable destination under T3's identity.
        hostEpoch++;
        yield* Effect.tryPromise(() => host.close()).pipe(
          Effect.mapError((cause) => protocolError("Cannot release Muse fork source", cause)),
        );
        thread = undefined;
        nativeSessionId = undefined;
        yield* launchHost();
        return yield* register({
          threadId: current.appThreadId ?? input.threadId,
          modelSelection: {
            ...input.modelSelection,
            model: session.model ?? input.modelSelection.model,
          },
          runtimePolicy: input.runtimePolicy,
          existingProviderThread: {
            ...current,
            nativeThreadRef: nativeRef(result.session.sessionId),
          },
        });
      });
      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: MUSE_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
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
              hostEpoch++;
              broken = true;
              yield* Effect.tryPromise(() => host.close()).pipe(
                Effect.mapError((cause) => protocolError("Cannot stop Muse compaction", cause)),
              );
              yield* eventPermit.withPermits(1)(finish(turn, "interrupted", undefined, "broken"));
              return;
            }
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
              yield* request("approval/decide", {
                approvalId: approval.approvalId,
                requirementId: approval.currentRequirementId,
                choiceId: choice.choiceId,
              });
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
              yield* request("userInput/answer", {
                userInputId: questionRequest.userInputId,
                answers,
              });
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
            : snapshot()
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
        rollbackThread: (args) =>
          Effect.gen(function* () {
            if (!validateThread(args.providerThread) || active)
              return yield* protocolError("Stop the owning Muse thread before rollback");
            const source = args.providerThread;
            const target =
              args.target.type === "provider_turn" ? args.target.providerTurn : undefined;
            if (
              target &&
              !args.providerThreadTurns.some(
                (turn) => turn.id === target.id && turn.providerThreadId === source.id,
              )
            )
              return yield* protocolError("Muse rollback boundary is not part of this thread");
            let adopted: OrchestrationV2ProviderThread;
            if (target) {
              const result = yield* forkNative(source, target);
              adopted = yield* attachFork(
                { ...source, nativeConversationHeadRef: target.nativeTurnRef },
                result,
              );
            } else {
              hostEpoch++;
              yield* Effect.tryPromise(() => host.close()).pipe(
                Effect.mapError((cause) =>
                  protocolError("Cannot release Muse rollback source", cause),
                ),
              );
              thread = undefined;
              nativeSessionId = undefined;
              yield* launchHost();
              const fresh = yield* register(
                {
                  threadId: source.appThreadId ?? input.threadId,
                  modelSelection: {
                    ...input.modelSelection,
                    model: session.model ?? input.modelSelection.model,
                  },
                  runtimePolicy: input.runtimePolicy,
                  existingProviderThread: {
                    ...source,
                    nativeThreadRef: null,
                    nativeConversationHeadRef: null,
                  },
                },
                true,
              );
              adopted = {
                ...source,
                nativeThreadRef: fresh.nativeThreadRef,
                nativeConversationHeadRef: null,
                providerSessionId: input.providerSessionId,
                status: "idle",
                updatedAt: fresh.updatedAt,
              };
              thread = adopted;
            }
            for (const [id, turn] of providerTurns)
              if (!target || turn.ordinal > target.ordinal) providerTurns.delete(id);
            yield* updateThread(adopted);
            return snapshotFromHistory(adopted);
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRollbackThreadError({
                  driver: MUSE_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  checkpointId: args.target.checkpointId,
                  cause,
                }),
            ),
          ),
        forkThread: (args) =>
          Effect.gen(function* () {
            if (args.ownerNodeId)
              return yield* protocolError("Muse does not support forking a native subagent thread");
            if (args.runtimePolicy?.cwd && args.runtimePolicy.cwd !== cwd)
              return yield* protocolError(
                "Muse native forks require the same workspace; use a context handoff for another workspace",
              );
            const target = args.sourceProviderTurns?.find(
              (turn) => turn.id === args.providerTurnId,
            );
            if (args.providerTurnId && !target)
              return yield* protocolError("Muse fork boundary was not supplied");
            const result = yield* forkNative(args.sourceProviderThread, target);
            const createdAt = yield* DateTime.now;
            return yield* attachFork(
              {
                ...args.sourceProviderThread,
                id: idAllocator.derive.providerThread({
                  driver: MUSE_PROVIDER,
                  providerInstanceId: options.instanceId,
                  nativeThreadId: result.session.sessionId,
                }),
                appThreadId: args.targetThreadId,
                ownerNodeId: null,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: nativeRef(result.session.sessionId),
                nativeConversationHeadRef: target?.nativeTurnRef ?? null,
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                pendingBackgroundTasks: [],
                contextUsage: null,
                forkedFrom: {
                  providerThreadId: args.sourceProviderThread.id,
                  ...(args.providerTurnId ? { providerTurnId: args.providerTurnId } : {}),
                },
                createdAt,
                updatedAt: createdAt,
              },
              result,
            );
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterForkThreadError({
                  driver: MUSE_PROVIDER,
                  providerThreadId: args.sourceProviderThread.id,
                  cause,
                }),
            ),
          ),
      };
      return runtime;
    }),
  });
}

export type MuseAdapterV2DriverEnv =
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocatorV2
  | ServerConfig;
export const createMuseAdapterV2 = Effect.fn("MuseAdapterV2Driver.create")(function* (
  input: ProviderAdapterDriverCreateInput<MuseSettings>,
  modelCatalog?: Effect.Effect<ReadonlyArray<ServerProviderModel>>,
  nativeEventLogger?: EventNdjsonLogger,
) {
  const hostEnvironment = yield* HostProcessEnvironment;
  return makeMuseAdapterV2({
    instanceId: input.instanceId,
    settings: { ...input.config, enabled: input.enabled },
    environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
    idAllocator: yield* IdAllocatorV2,
    serverConfig: yield* ServerConfig,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    ...(modelCatalog ? { modelCatalog } : {}),
    ...(nativeEventLogger ? { nativeEventLogger } : {}),
  });
});
export const MuseAdapterV2Driver: ProviderAdapterDriver<MuseSettings, MuseAdapterV2DriverEnv> = {
  driverKind: MUSE_PROVIDER,
  configSchema: MuseSettings,
  defaultConfig: () => defaultMuseSettings,
  create: (input) => createMuseAdapterV2(input),
};
