import { type ChatAttachment, CommandId, type OrchestrationV2ServerCommand, type OrchestrationV2AppThread, type OrchestrationV2ConversationMessage, type OrchestrationV2DelegatedCompletionDelivery, type OrchestrationV2DomainEvent, type OrchestrationV2Run, type OrchestrationV2Subagent, type OrchestrationV2ThreadProjection, parseGoalCommand, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ProjectStore from "../ProjectStore.ts";
import { CheckpointServiceV2 } from "../CheckpointService.ts";
import { CommandPolicyV2 } from "../CommandPolicy.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { ContextHandoffServiceV2, readInheritedHandoffItems } from "../ContextHandoffService.ts";
import { isUndeliveredMailboxSteer } from "../NotificationMailbox.ts";
import { EventSinkV2 } from "../EventSink.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeEventEmitter, mapDispatchError } from "../orchestrationEmitters.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import { type RuntimeModeCeiling } from "../DispatchModeLimit.ts";
import { applyToProjection, emptyProjection, ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "../ProviderSwitchService.ts";
import { RuntimePolicyV2 } from "../RuntimePolicy.ts";
import { ThreadForkServiceV2 } from "../ThreadForkService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../../serverSettings.ts";
import { OrchestratorDispatchError, OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { nextQueuedRun } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
type Deps = Record<never, never>;

export const installFailQueuedRunStart = Effect.fnUntraced(function* (deps: Deps) {
const checkpointService = yield* CheckpointServiceV2;

const commandPolicy = yield* CommandPolicyV2;

const contextHandoffService = yield* ContextHandoffServiceV2;

const eventSink = yield* EventSinkV2;

const commandReceipts = yield* CommandReceiptStoreV2;

const idAllocator = yield* IdAllocator.IdAllocatorV2;

const { makeEvent, emit } = makeEventEmitter({ idAllocator });

const projects = yield* ProjectStore.ProjectStoreV2;

const projectionStore = yield* ProjectionStoreV2;

const effectOutbox = yield* EffectOutbox.EffectOutboxV2;

const nextTurnItemOrdinal = (
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
    Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
) =>
  projectionStore.getNextTurnItemOrdinal(projection.thread.id).pipe(
    Effect.mapError(
      (cause) => new OrchestratorProjectionError({ threadId: projection.thread.id, cause }),
    ),
    Effect.map((next) =>
      (projection.turnItems ?? []).reduce(
        (ordinal, item) => Math.max(ordinal, item.ordinal + 1),
        next,
      ),
    ),
  );

const fileSystem = yield* FileSystem.FileSystem;

const path = yield* Path.Path;

const providerAdapters = yield* ProviderAdapterRegistryV2;

const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;

const providerSessions = yield* ProviderSessionManagerV2;

const providerSwitchService = yield* ProviderSwitchServiceV2;

const serverSettings = yield* ServerSettings.ServerSettingsService;

const runtimePolicy = yield* RuntimePolicyV2;

const threadForkService = yield* ThreadForkServiceV2;

const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;

const { managedPolicy } = serverSettings;

const runtimeModeCeiling: RuntimeModeCeiling | undefined =
  managedPolicy?.limits?.maxRuntimeMode === undefined
    ? undefined
    : {
        organization: managedPolicy.organization,
        maxRuntimeMode: managedPolicy.limits.maxRuntimeMode,
      };

const goalDriverFor = Effect.fn("Orchestrator.goalDriverFor")(function* (
  command: OrchestrationV2ServerCommand,
  providerInstanceId: ProviderInstanceId,
) {
  const { driver } = yield* providerAdapters
    .get(providerInstanceId)
    .pipe(mapDispatchError(command));
  return driver === "codex" || driver === "claudeAgent" ? driver : undefined;
});

const ensureGoalCommandSupported = Effect.fn("Orchestrator.ensureGoalCommandSupported")(
  function* (
    command: OrchestrationV2ServerCommand,
    message: { readonly text: string; readonly attachments: ReadonlyArray<ChatAttachment> },
    providerInstanceId: ProviderInstanceId,
  ) {
    const goalCommand = parseGoalCommand(message);
    if (goalCommand?.type !== "pause" && goalCommand?.type !== "resume") return;
    if ((yield* goalDriverFor(command, providerInstanceId)) !== "claudeAgent") return;
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Claude goals cannot be paused or resumed. Send /goal clear to remove the goal.",
    });
  },
);

const mapDelegatedCompletionError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:system:delegated-completion-delivery"),
          commandType: "delegated_task.completion-delivery",
          cause,
        }),
    ),
  );

const providerSessionIdFor = (input: {
  readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}) =>
  input.adapter.getCapabilities().pipe(
    Effect.flatMap((capabilities) =>
      capabilities.sessions.supportsMultipleProviderThreadsPerSession
        ? Effect.succeed(
            idAllocator.derive.providerSession({
              providerInstanceId: input.providerInstanceId,
            }),
          )
        : idAllocator.allocate.providerSession({
            providerInstanceId: input.providerInstanceId,
            threadId: input.threadId,
          }),
    ),
  );

const sessionHasBackgroundWork = Effect.fn("Orchestrator.sessionHasBackgroundWork")(function* (
  detaching: OrchestrationV2ThreadProjection["providerSessions"][number],
  providerThreads: OrchestrationV2ThreadProjection["providerThreads"],
) {
  const session = yield* providerSessions
    .get(detaching.id)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(session)) return false;
  const runtime = session.value;
  const probes =
    !detaching.capabilities.sessions.supportsMultipleProviderThreadsPerSession &&
    runtime.hasPendingBackgroundWork !== undefined
      ? [runtime.hasPendingBackgroundWork]
      : providerThreads.flatMap((providerThread) =>
          providerThread.providerSessionId === detaching.id &&
          runtime.hasPendingBackgroundWorkForThread !== undefined
            ? [runtime.hasPendingBackgroundWorkForThread(providerThread)]
            : [],
        );
  for (const probe of probes) {
    // A failed probe cannot confirm that the work ended.
    if (yield* probe.pipe(Effect.catchCause(() => Effect.succeed(true)))) return true;
  }
  return false;
});

const readCommandProjection = (threadId: ThreadId) =>
  projectionStore
    .getThreadRecords(
      threadId,
      [
        "runs",
        "attempts",
        "nodes",
        "subagents",
        "providerSessions",
        "providerThreads",
        "providerTurns",
        "runtimeRequests",
        "messages",
        "turnItems",
        "checkpointScopes",
        "contextTransfers",
      ],
      {
        turnItemTypes: ["user_message", "error"],
        messageRoles: ["user"],
        omitSettledLeafNodes: true,
        // Commands here read only undelivered or active tasks; a dispatcher thread keeps
        // thousands of delivered ones, each carrying its full prompt.
        omitSettledSubagents: true,
      },
    )
    .pipe(
      Effect.map((records): OrchestrationV2ThreadProjection => ({
        ...records,
        checkpoints: [],
        plans: [],
        contextHandoffs: [],
        visibleTurnItems: [],
        updatedAt: records.thread.updatedAt,
      })),
      Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
    );

const notificationTasks = (
  threadId: ThreadId,
  message: Pick<OrchestrationV2ConversationMessage, "delegatedCompletion">,
  loaded: ReadonlyArray<OrchestrationV2Subagent>,
) =>
  message.delegatedCompletion === undefined
    ? Effect.succeed(loaded)
    : projectionStore
        .getThreadRecords(threadId, ["subagents"], {
          subagentRunIds: [message.delegatedCompletion.parentRunId],
        })
        .pipe(
          Effect.map((records) => records.subagents),
          Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
        );

const readHandoffItems = (threadId: ThreadId, runIds?: ReadonlyArray<RunId | null>) =>
  projectionStore
    .getThreadRecords(
      threadId,
      ["turnItems"],
      runIds === undefined ? undefined : { turnItemRunIds: runIds },
    )
    .pipe(
      Effect.map((records) => records.turnItems),
      Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
    );

const readInheritedItems = (thread: OrchestrationV2AppThread) =>
  readInheritedHandoffItems(projectionStore, thread).pipe(
    Effect.mapError((cause) => new OrchestratorProjectionError({ threadId: thread.id, cause })),
  );

const findThread = (threadId: ThreadId) =>
  projectionStore.getThread(threadId).pipe(
    Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
    Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
  );

const liveSideChatIds = Effect.fn("Orchestrator.liveSideChatIds")(
  function* (threadId: ThreadId) {
    const { contextTransfers } = yield* projectionStore
      .getThreadRecords(threadId, ["contextTransfers"])
      .pipe(
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed({ contextTransfers: [] }),
        }),
      );
    const sideChatIds: Array<ThreadId> = [];
    for (const transfer of contextTransfers) {
      if (transfer.type !== "fork" || transfer.sourceThreadId !== threadId) continue;
      const child = yield* projectionStore
        .getThread(transfer.targetThreadId)
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
        );
      if (child?.lineage.sideChat === true && child.deletedAt === null) {
        sideChatIds.push(child.id);
      }
    }
    return sideChatIds;
  },
  (effect, threadId) =>
    effect.pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
);

const getProjectionWithPendingEvents =
  /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
  Effect.fnUntraced(function* (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const pending = (yield* Ref.get(events)).filter((event) => event.threadId === threadId);
    const stored = yield* Effect.option(readCommandProjection(threadId));
    let projection: OrchestrationV2ThreadProjection;
    if (Option.isSome(stored)) {
      projection = stored.value;
    } else {
      const created = pending.find(
        (
          event,
        ): event is Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }> =>
          event.type === "thread.created",
      );
      if (created === undefined) {
        return yield* new OrchestratorProjectionError({ threadId });
      }
      projection = emptyProjection(created);
    }

    for (const event of pending) {
      if (event.type === "thread.created" && projection.thread.id === event.payload.id) {
        projection = { ...projection, thread: event.payload, updatedAt: event.occurredAt };
        continue;
      }
      projection = applyToProjection(projection, event);
    }
    return projection;
  });

const makeSystemEvent =
  /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
  Effect.fnUntraced(function* <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) {
    const eventId = yield* idAllocator.allocate.event({
      threadId: event.threadId,
    });
    return {
      ...event,
      id: eventId,
    } as Event;
  });

const writeSystemEvents =
  /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
  Effect.fnUntraced(function* (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
    effects: ReadonlyArray<PendingOrchestrationEffectV2> = [],
    options: { readonly updateDelegatedCompletionOnly?: boolean } = {},
  ) {
    const withIds = yield* Effect.forEach(events, (event) => makeSystemEvent(event));
    yield* eventSink.writeWithEffects({ events: withIds, effects, ...options });
  });

const completionDeliveryRun = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
) => {
  if (delivery == null) return undefined;
  const message = projection.messages.find((candidate) => candidate.id === delivery.messageId);
  return projection.runs.find((candidate) => candidate.id === message?.runId);
};

const completionDeliveryMessage = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
) =>
  delivery === null || delivery === undefined
    ? undefined
    : projection.messages.find((candidate) => candidate.id === delivery.messageId);

const offerDelegatedCompletionDelivery =
  /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
  Effect.fnUntraced(function* (threadId: ThreadId, parentRunId: RunId) {
    const controls = yield* projectionStore.getThreadRecords(threadId, ["runs"], {
      runIds: [parentRunId],
    });
    const parentRun = controls.runs[0];
    const cohort = parentRun?.delegatedCompletion;
    const delivery = cohort?.delivery;
    if (
      parentRun === undefined ||
      cohort?.disposition !== "open" ||
      delivery == null ||
      delivery.taskIds.length === 0 ||
      controls.thread.archivedAt !== null ||
      controls.thread.deletedAt !== null
    )
      return;
    const messages = yield* projectionStore.getThreadRecords(threadId, ["messages"], {
      messageIds: [delivery.messageId],
    });
    const message = messages.messages[0];
    if (message !== undefined) {
      if (message.delegatedCompletion === undefined || message.runId === null) return;
      const runs = yield* projectionStore.getThreadRecords(threadId, ["runs"], {
        runIds: [message.runId],
      });
      const run = runs.runs[0];
      const turns = yield* projectionStore.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: run?.activeAttemptId == null ? [] : [run.activeAttemptId],
      });
      if (!isUndeliveredMailboxSteer({ ...messages, ...runs, ...turns }, delivery.messageId))
        return;
    }
    const projection = yield* projectionStore.getThreadRecords(threadId, ["providerThreads"], {
      providerThreadIds: parentRun.providerThreadId === null ? [] : [parentRun.providerThreadId],
    });
    const providerThread =
      parentRun.providerThreadId === null
        ? undefined
        : projection.providerThreads.find(
            (candidate) => candidate.id === parentRun.providerThreadId,
          );
    if (providerThread === undefined) {
      return;
    }
    yield* continuationRequests.offer({
      threadId,
      providerThreadId: providerThread.id,
      driver: providerThread.driver,
      detail: null,
      delivery: "message_text",
      delegatedCompletion: {
        parentRunId,
        generation: delivery.generation,
        messageId: delivery.messageId,
      },
    });
  });

const offerDelegatedCompletionDeliveries =
  /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
  Effect.fnUntraced(function* (threadId: ThreadId) {
    const projection = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
    for (const run of projection.runs) {
      if (
        run.delegatedCompletion?.delivery !== undefined &&
        run.delegatedCompletion.delivery !== null
      ) {
        yield* offerDelegatedCompletionDelivery(threadId, run.id);
      }
    }
  });

const emitQueuedRunCancellation = Effect.fn("Orchestrator.emitQueuedRunCancellation")(
  function* (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "attempts">;
    readonly run: OrchestrationV2Run;
    readonly now: DateTime.Utc;
  }) {
    const rootNode =
      input.run.rootNodeId === null
        ? undefined
        : input.projection.nodes.find((candidate) => candidate.id === input.run.rootNodeId);
    const attempt =
      input.run.activeAttemptId === null
        ? undefined
        : input.projection.attempts.find(
            (candidate) => candidate.id === input.run.activeAttemptId,
          );
    const emitEvent = emit(input.events, input.command);
    yield* emitEvent({
      type: "run.updated",
      threadId: input.run.threadId,
      runId: input.run.id,
      ...(input.run.rootNodeId === null ? {} : { nodeId: input.run.rootNodeId }),
      providerInstanceId: input.run.providerInstanceId,
      occurredAt: input.now,
      payload: {
        ...input.run,
        status: "cancelled",
        queuePosition: null,
        completedAt: input.now,
      },
    });
    if (attempt !== undefined && rootNode !== undefined) {
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId: input.run.threadId,
        runId: input.run.id,
        nodeId: rootNode.id,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.now,
        payload: {
          ...attempt,
          status: "cancelled",
          completedAt: input.now,
        },
      });
    }
    if (rootNode !== undefined) {
      yield* emitEvent({
        type: "node.updated",
        threadId: input.run.threadId,
        runId: input.run.id,
        nodeId: rootNode.id,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.now,
        payload: {
          ...rootNode,
          status: "cancelled",
          completedAt: input.now,
        },
      });
    }
  },
);

const failQueuedRunStart = Effect.fn("Orchestrator.failQueuedRunStart")(function* (
  threadId: ThreadId,
  cause: unknown,
  queuedRunId?: RunId,
) {
  const projection = yield* projectionStore.getThreadRecords(
    threadId,
    ["runs", "nodes", "attempts", "providerThreads", "turnItems", "messages"],
    { turnItemTypes: [], messageRoles: ["user"] },
  );
  const queuedRun =
    queuedRunId === undefined
      ? nextQueuedRun(projection)
      : projection.runs.find((run) => run.id === queuedRunId && run.status === "queued");
  if (queuedRun === undefined) return;
  const now = yield* DateTime.now;
  const rootNode = projection.nodes.find((node) => node.id === queuedRun.rootNodeId);
  const attempt = projection.attempts.find((entry) => entry.id === queuedRun.activeAttemptId);
  const providerThread = projection.providerThreads.find(
    (entry) => entry.id === queuedRun.providerThreadId,
  );
  const handoffUnsupported =
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "CommandPolicyCapabilityUnsupportedError";
  const failureCause =
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "OrchestratorDispatchError" &&
    "cause" in cause
      ? cause.cause
      : cause;
  const failure = makeProviderFailure({
    cause: failureCause,
    code: handoffUnsupported ? "context_handoff_unsupported" : "queued_start_failed",
    class: handoffUnsupported ? "validation_error" : "unknown",
  });
  yield* writeSystemEvents([
    ...(attempt !== undefined && rootNode !== undefined
      ? [
          {
            type: "run-attempt.updated" as const,
            threadId,
            runId: queuedRun.id,
            nodeId: rootNode.id,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "failed" as const, completedAt: now },
          },
        ]
      : []),
    ...(rootNode === undefined
      ? []
      : [
          {
            type: "node.updated" as const,
            threadId,
            runId: queuedRun.id,
            nodeId: rootNode.id,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: { ...rootNode, status: "failed" as const, completedAt: now },
          },
        ]),
    ...(rootNode === undefined || providerThread === undefined
      ? []
      : [
          {
            type: "turn-item.updated" as const,
            threadId,
            runId: queuedRun.id,
            nodeId: rootNode.id,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: providerThread.driver,
                nativeItemId: `queued-start-failure:${queuedRun.id}`,
              }),
              threadId,
              runId: queuedRun.id,
              nodeId: rootNode.id,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: yield* nextTurnItemOrdinal(projection),
              status: "failed" as const,
              title: "Queued provider could not start",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "error" as const,
              failure,
            },
          },
        ]),
    {
      type: "run.updated",
      threadId,
      runId: queuedRun.id,
      ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: { ...queuedRun, status: "failed", queuePosition: null, completedAt: now },
    },
  ]);
});

  return { checkpointService, commandPolicy, contextHandoffService, eventSink, commandReceipts, idAllocator, makeEvent, emit, projects, projectionStore, effectOutbox, nextTurnItemOrdinal, fileSystem, path, providerAdapters, continuationRequests, providerSessions, providerSwitchService, serverSettings, runtimePolicy, threadForkService, threadDispatch, managedPolicy, runtimeModeCeiling, goalDriverFor, ensureGoalCommandSupported, mapDelegatedCompletionError, providerSessionIdFor, sessionHasBackgroundWork, readCommandProjection, notificationTasks, readHandoffItems, readInheritedItems, findThread, liveSideChatIds, getProjectionWithPendingEvents, makeSystemEvent, writeSystemEvents, completionDeliveryRun, completionDeliveryMessage, offerDelegatedCompletionDelivery, offerDelegatedCompletionDeliveries, emitQueuedRunCancellation, failQueuedRunStart };
});

export type FailQueuedRunStartPart = ReturnType<typeof installFailQueuedRunStart> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installFailQueuedRunStart>;
