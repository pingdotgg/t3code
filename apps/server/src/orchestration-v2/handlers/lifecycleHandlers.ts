/**
 * Extracted orchestrator handlers: dispatchInterruptUnresponsive, dispatchProviderSessionDetach, dispatchThreadVisit, dispatchQueuedRunReorder, dispatchThreadCreate, dispatchThreadProjectAdoptFolder, dispatchCreatedThreadRecord, dispatchThreadUserInputDismiss, dispatchGuestShare.
 *
 * Moved out of the makeOrchestrator closure; dependencies are passed in.
 */
import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2InternalCommand,
  OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import type { GuestShareCommand } from "../GuestShareDecider.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { recordThreadOpen } from "@t3tools/shared/paletteSearch";

import type { CommandId, ThreadId } from "@t3tools/contracts";
import type { EventIdAllocator } from "../orchestrationEmitters.ts";

type AnyOrchestratorError =
  | OrchestratorDispatchError
  | OrchestratorThreadAlreadyExistsError
  | OrchestratorCommandRejectedError
  | OrchestratorProjectionError
  | OrchestratorDomainEventStreamError
  | OrchestratorProviderAdapterError
  | OrchestratorSubagentThreadReadOnlyError
  | OrchestratorThreadAboveModeLimitError;
import type { ProviderAdapterV2Error } from "@t3tools/provider-core/server/ProviderAdapter";
import type { IdAllocatorV2Error } from "@t3tools/provider-core/server/IdAllocator";
import { isCheckpointRestoreIsolated } from "../CheckpointRestoreSafety.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "../ProjectionStore.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorDomainEventStreamError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
  OrchestratorThreadAlreadyExistsError,
} from "../orchestrationErrors.ts";

import * as Result from "effect/Result";
import { decideGuestShareCommand } from "../GuestShareDecider.ts";
import { isAutomaticCompletionRun } from "../QueuedRunOrder.ts";
import { providerTurnForRun } from "../orchestrationCommandQueries.ts";
import { queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";

import type {
  OrchestrationV2AppThread,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export interface MakeLifecycleHandlersDeps {
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => (
    event: Omit<OrchestrationV2DomainEvent, "id">,
  ) => Effect.Effect<OrchestrationV2DomainEvent, OrchestratorDispatchError>;
  readonly threadHasUnfinishedWork: (records: {
    readonly runs: readonly { readonly status: string }[];
    readonly runtimeRequests: readonly { readonly status: string }[];
  }) => boolean;
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly idAllocator: EventIdAllocator;
  readonly projects: Parameters<typeof isCheckpointRestoreIsolated>[2]["projects"];
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorProjectionError, never>;
  readonly releaseGuestAttachments: (
    command: { readonly commandId: CommandId; readonly threadId: ThreadId },
    before: OrchestrationV2AppThread["guestShare"],
    after: OrchestrationV2AppThread["guestShare"],
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<void, never, never>;
  readonly dispatchRuntimeRequestRespond: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
}

export const makeLifecycleHandlers = (deps: MakeLifecycleHandlersDeps) => {
const dispatchThreadCreate = Effect.fn("orchestrationV2.dispatch.threadCreate")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  yield* Effect.annotateCurrentSpan({
    "orchestration_v2.command_id": command.commandId,
    "orchestration_v2.command_type": command.type,
    "orchestration_v2.thread_id": command.threadId,
    "orchestration_v2.driver": command.modelSelection.instanceId,
  });

  // Tombstones reserve their ids too; recreating one would overwrite its history.
  const existing = yield* deps.projectionStore.getThread(command.threadId).pipe(
    Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
    Effect.mapError(
      (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
    ),
  );
  if (existing !== null) {
    return yield* new OrchestratorThreadAlreadyExistsError({
      commandId: command.commandId,
      threadId: command.threadId,
    });
  }

  const now = yield* DateTime.now;
  const emitEvent = deps.emit(events, command);
  const thread: OrchestrationV2AppThread = {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    id: command.threadId,
    projectId: command.projectId,
    title: command.title,
    providerInstanceId: command.modelSelection.instanceId,
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    branch: command.branch,
    worktreePath: command.worktreePath,
    activeProviderThreadId: null,
    pullRequests: [],
    ...(command.linkOrigin === undefined ? {} : { linkOrigin: command.linkOrigin }),
    // Only stamped work names a remote parent, so a client cannot claim one.
    ...(command.linkOrigin === undefined || command.delegatedFrom === undefined
      ? {}
      : { delegatedFrom: command.delegatedFrom }),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: command.threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };

  yield* emitEvent({
    type: "thread.created",
    threadId: command.threadId,
    providerInstanceId: command.modelSelection.instanceId,
    occurredAt: now,
    payload: thread,
  });
  if (command.importedNativeThread !== undefined) {
    yield* emitEvent({
      type: "provider-thread.updated",
      threadId: command.threadId,
      driver: command.importedNativeThread.ref.driver,
      providerInstanceId: command.modelSelection.instanceId,
      occurredAt: now,
      payload: {
        id: deps.idAllocator.derive.providerThread({
          driver: command.importedNativeThread.ref.driver,
          providerInstanceId: command.modelSelection.instanceId,
          nativeThreadId: command.importedNativeThread.ref.nativeId,
        }),
        driver: command.importedNativeThread.ref.driver,
        providerInstanceId: command.modelSelection.instanceId,
        providerSessionId: null,
        appThreadId: command.threadId,
        ownerNodeId: null,
        nativeThreadRef: command.importedNativeThread.ref,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        contextUsage: null,
        nativeMetadata: command.importedNativeThread.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
});

const dispatchThreadVisit = Effect.fn("orchestrationV2.dispatch.threadVisit")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "thread.visit" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const thread = yield* deps.projectionStore
    .getThread(command.threadId)
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
  if (thread.deletedAt !== null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is deleted.`,
    });
  }
  const visitedAt = DateTime.make(command.visitedAt);
  if (Option.isNone(visitedAt)) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} visit time ${command.visitedAt} is not a valid timestamp.`,
    });
  }
  const movesForward =
    thread.lastVisitedAt === null ||
    DateTime.toEpochMillis(visitedAt.value) > DateTime.toEpochMillis(thread.lastVisitedAt);
  const occurredAt = yield* DateTime.now;
  // Opens are timed by the server clock so devices with skewed clocks agree.
  const opens = command.opened
    ? recordThreadOpen(
        thread.opens ?? null,
        DateTime.toEpochMillis(occurredAt),
        command.searchQuery,
      )
    : null;
  // Viewing a thread changes read state only. Loading its transcript (or
  // bumping updatedAt) makes a routine read receipt scale with its history.
  yield* deps.emit(
    events,
    command,
  )({
    type: "thread.visited",
    threadId: command.threadId,
    providerInstanceId: thread.providerInstanceId,
    occurredAt,
    payload: {
      ...thread,
      ...(movesForward ? { lastVisitedAt: visitedAt.value } : {}),
      ...(opens ? { opens } : {}),
    },
  });
});

// Recheck under the lock after reading the host. Record the watch first so wake events carry it.

const dispatchGuestShare = Effect.fn("orchestrationV2.dispatch.guestShare")(function* (
  command: GuestShareCommand,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) {
  const projection = yield* deps.projectionStore
    .getThreadRecords(command.threadId, [])
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
  const thread = projection.thread;
  const now = yield* DateTime.now;
  const decided =
    thread.deletedAt !== null
      ? Result.fail(`Thread ${command.threadId} is deleted.`)
      : decideGuestShareCommand({
          thread,
          command,
          now,
        });
  if (Result.isFailure(decided)) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: decided.failure,
    });
  }
  if (decided.success === thread) return;
  yield* deps.emit(
    events,
    command,
  )({
    type: "thread.guest-share-updated",
    threadId: command.threadId,
    providerInstanceId: thread.providerInstanceId,
    occurredAt: now,
    payload: decided.success,
  });
  yield* deps.releaseGuestAttachments(command, thread.guestShare, decided.success.guestShare, effects);
});

// Emitted before the message so the send and the status change commit together, and so
// `dispatchMessage`, which reads pending events, keeps the updated share.

const dispatchProviderSessionDetach = Effect.fn("orchestrationV2.dispatch.providerSessionDetach")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "provider-session.detach" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* deps.projectionStore
      .getThreadRecords(command.threadId, ["providerSessions"])
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    const session = projection.providerSessions.find(
      (candidate) => candidate.id === command.providerSessionId,
    );
    if (session === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Provider session ${command.providerSessionId} does not belong to thread ${command.threadId}.`,
      });
    }
    const now = yield* DateTime.now;
    yield* deps.emit(
      events,
      command,
    )({
      type: "provider-session.detached",
      threadId: command.threadId,
      driver: session.driver,
      providerInstanceId: session.providerInstanceId,
      occurredAt: now,
      payload: {
        providerSessionId: session.id,
        detachedAt: now,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      },
    });
    const pendingEffect = {
      id: `effect:${command.commandId}:provider-session.detach:${command.providerSessionId}`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: {
        type: "provider-session.detach",
        providerSessionId: command.providerSessionId,
        ...(command.reason === undefined ? {} : { detail: command.reason }),
      },
    } satisfies PendingOrchestrationEffectV2;
    yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
  },
);

const dispatchThreadProjectAdoptFolder = Effect.fn(
  "orchestrationV2.dispatch.threadProjectAdoptFolder",
)(function* (
  command: Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "thread.project.adopt-folder" }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const reject = (cause: string) =>
    new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} ${cause}`,
    });
  const projection = yield* deps.projectionStore
    .getThreadRecords(command.threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
  const thread = projection.thread;
  if (thread.deletedAt !== null) return yield* reject("is deleted.");
  if (deps.threadHasUnfinishedWork(projection)) {
    return yield* reject("still has work in progress. Finish or stop it first.");
  }
  const current = yield* deps.projects.get(thread.projectId).pipe(mapDispatchError(command));
  const target = yield* deps.projects.get(command.projectId).pipe(mapDispatchError(command));
  if (Option.isNone(target) || target.value.deletedAt !== null) {
    return yield* reject(`cannot move to missing project ${command.projectId}.`);
  }
  // The thread always lands in the project root, so the move must not change its cwd.
  const cwd = thread.worktreePath ?? Option.getOrUndefined(current)?.workspaceRoot;
  if (cwd !== target.value.workspaceRoot) {
    return yield* reject(`does not work in ${target.value.workspaceRoot}.`);
  }
  const now = yield* DateTime.now;
  yield* deps.emit(
    events,
    command,
  )({
    type: "thread.metadata-updated",
    threadId: command.threadId,
    providerInstanceId: thread.providerInstanceId,
    occurredAt: now,
    payload: { ...thread, projectId: command.projectId, worktreePath: null, updatedAt: now },
  });
});

const dispatchCreatedThreadRecord = Effect.fn("orchestrationV2.dispatch.createdThreadRecord")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.created.record" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const parentProjection = yield* deps.projectionStore
      .getThreadRecords(
        command.parentThreadId,
        ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.parentThreadId,
              cause,
            }),
        ),
      );
    const targetProjection = yield* deps.projectionStore
      .getThreadRecords(
        command.targetThreadId,
        ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.targetThreadId,
              cause,
            }),
        ),
      );
    const parentRun = parentProjection.runs.find(
      (candidate) => candidate.id === command.parentRunId,
    );
    const parentNode = parentProjection.nodes.find(
      (candidate) => candidate.id === command.parentNodeId,
    );
    if (
      parentRun === undefined ||
      parentNode === undefined ||
      parentNode.runId !== command.parentRunId ||
      parentRun.rootNodeId !== command.parentNodeId
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Parent node ${command.parentNodeId} is not the root of run ${command.parentRunId}.`,
      });
    }
    if (parentProjection.thread.projectId !== targetProjection.thread.projectId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Target thread ${command.targetThreadId} belongs to another project.`,
      });
    }
    if (
      command.targetRunId !== null &&
      !targetProjection.runs.some((candidate) => candidate.id === command.targetRunId)
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Target run ${command.targetRunId} does not belong to thread ${command.targetThreadId}.`,
      });
    }

    const now = yield* DateTime.now;
    const parentProviderTurn = providerTurnForRun(parentProjection, parentRun);
    const turnItem: OrchestrationV2TurnItem = {
      id: deps.idAllocator.derive.createdThreadTurnItem({ commandId: command.commandId }),
      threadId: command.parentThreadId,
      runId: command.parentRunId,
      nodeId: command.parentNodeId,
      providerThreadId: parentRun.providerThreadId,
      providerTurnId: parentProviderTurn?.id ?? null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* deps.nextTurnItemOrdinal(parentProjection),
      status: "completed",
      title: targetProjection.thread.title,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "thread_created",
      targetThreadId: command.targetThreadId,
      targetRunId: command.targetRunId,
      targetProviderInstanceId: targetProjection.thread.modelSelection.instanceId,
      targetModel: targetProjection.thread.modelSelection.model,
    };

    yield* deps.emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: command.parentThreadId,
      runId: command.parentRunId,
      nodeId: command.parentNodeId,
      providerInstanceId: parentRun.providerInstanceId,
      occurredAt: now,
      payload: turnItem,
    });
  },
);

const dispatchThreadUserInputDismiss = Effect.fn("Orchestrator.dispatchThreadUserInputDismiss")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.user-input.dismiss" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const request = yield* deps.projectionStore
      .getRuntimeRequest(command.threadId, command.requestId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    if (request === undefined || request.status !== "pending") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "This question has already been answered.",
      });
    }
    if (request.kind !== "user_input" || request.responseCapability.type !== "message") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "This question needs an answer. Answer it or stop the turn.",
      });
    }
    yield* deps.dispatchRuntimeRequestRespond(
      {
        type: "runtime-request.respond",
        commandId: command.commandId,
        threadId: command.threadId,
        requestId: command.requestId,
        decision: "cancel",
      },
      events,
      effects,
    );
  },
);

const dispatchQueuedRunReorder = Effect.fn("Orchestrator.dispatchQueuedRunReorder")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "queued-run.reorder" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const projection = yield* deps.loadProjectionForCommand(command, ["runs", "messages"], {
    messageRoles: ["user"],
  });
  const queuedRuns = queuedRunsInDeliveryOrder(projection);
  const moving = queuedRuns.find((run) => run.id === command.runId);
  if (moving === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Run ${command.runId} is not queued.`,
    });
  }
  const movingMessage = projection.messages.find(
    (candidate) => candidate.id === moving.userMessageId,
  );
  if (
    movingMessage?.delegatedCompletion !== undefined ||
    movingMessage?.notification !== undefined
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Automatic completion deliveries cannot be reordered.",
    });
  }
  const automaticRuns = queuedRuns.filter((run) => isAutomaticCompletionRun(projection, run));
  if (
    command.beforeRunId !== null &&
    automaticRuns.some((run) => run.id === command.beforeRunId)
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Queued messages cannot be reordered ahead of automatic completion delivery.",
    });
  }
  const reorderableRuns = queuedRuns.filter((run) => !isAutomaticCompletionRun(projection, run));
  const withoutMoving = reorderableRuns.filter((run) => run.id !== command.runId);
  const beforeIndex =
    command.beforeRunId === null
      ? withoutMoving.length
      : withoutMoving.findIndex((run) => run.id === command.beforeRunId);
  if (beforeIndex === -1) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Queue target ${command.beforeRunId} is not queued.`,
    });
  }
  const reordered = [
    ...automaticRuns,
    ...withoutMoving.slice(0, beforeIndex),
    moving,
    ...withoutMoving.slice(beforeIndex),
  ];
  const now = yield* DateTime.now;
  const emitEvent = deps.emit(events, command);
  yield* Effect.forEach(
    reordered,
    (run, index) =>
      Effect.gen(function* () {
        const queuePosition = index + 1;
        if (run.queuePosition === queuePosition) {
          return;
        }
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...run,
            queuePosition,
          },
        });
      }),
    { concurrency: 1 },
  );
});

const dispatchInterruptUnresponsive = Effect.fn("Orchestrator.dispatchInterruptUnresponsive")(
  function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "thread.interrupt.unresponsive" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const { providerTurn } = yield* deps.projectionStore
      .getProviderControlContext(command.threadId, {
        providerThreadId: command.providerThreadId,
        providerTurnId: command.providerTurnId,
      })
      .pipe(mapDispatchError(command));
    const { runs } = yield* deps.projectionStore
      .getThreadRecords(command.threadId, ["runs"])
      .pipe(mapDispatchError(command));
    const run = runs.find(
      (candidate) =>
        providerTurn !== undefined && candidate.activeAttemptId === providerTurn.runAttemptId,
    );
    // A settled run still counts: Stop may have targeted its background work.
    if (run === undefined) return;
    const { turnItems } = yield* deps.projectionStore
      .getThreadRecords(command.threadId, ["turnItems"], {
        turnItemTypes: ["run_interrupt_request", "run_interrupt_result"],
        turnItemRunIds: [run.id],
      })
      .pipe(mapDispatchError(command));
    // A provider that stopped late already wrote the result; it needs no Force stop.
    if (turnItems.some((item) => item.type === "run_interrupt_result")) return;
    const request = turnItems.find((item) => item.type === "run_interrupt_request");
    if (request?.type !== "run_interrupt_request" || request.unresponsiveAt !== undefined) return;
    const now = yield* DateTime.now;
    yield* deps.emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: run.id,
      ...(request.nodeId === null ? {} : { nodeId: request.nodeId }),
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...request, unresponsiveAt: now, updatedAt: now },
    });
  },
);

  return { dispatchInterruptUnresponsive, dispatchProviderSessionDetach, dispatchThreadVisit, dispatchQueuedRunReorder, dispatchThreadCreate, dispatchThreadProjectAdoptFolder, dispatchCreatedThreadRecord, dispatchThreadUserInputDismiss, dispatchGuestShare };
};
