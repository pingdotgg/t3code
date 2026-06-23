import {
  type ChatAttachment,
  CommandId,
  type ModelSelection,
  OrchestrationV2Command,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextSourcePoint,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ContextTransferResolution,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { CommandPolicyV2 } from "./CommandPolicy.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { ContextHandoffServiceV2 } from "./ContextHandoffService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import { applyToProjection, emptyProjection, ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "./ProviderSwitchService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import {
  makeSubagentChildThread,
  subagentResultForRun,
  subagentThreadTitle,
} from "./SubagentProjection.ts";
import { ThreadForkServiceV2 } from "./ThreadForkService.ts";

export class OrchestratorDispatchError extends Schema.TaggedErrorClass<OrchestratorDispatchError>()(
  "OrchestratorDispatchError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to dispatch orchestration command ${this.commandType} (${this.commandId}).`;
  }
}

export class OrchestratorProjectionError extends Schema.TaggedErrorClass<OrchestratorProjectionError>()(
  "OrchestratorProjectionError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to load orchestration projection for thread ${this.threadId}.`;
  }
}

export class OrchestratorDomainEventStreamError extends Schema.TaggedErrorClass<OrchestratorDomainEventStreamError>()(
  "OrchestratorDomainEventStreamError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed while streaming orchestration domain events.";
  }
}

export class OrchestratorProviderAdapterError extends Schema.TaggedErrorClass<OrchestratorProviderAdapterError>()(
  "OrchestratorProviderAdapterError",
  {
    commandId: CommandId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter failed while dispatching orchestration command ${this.commandId}.`;
  }
}

export class OrchestratorCommandPreviouslyRejectedError extends Schema.TaggedErrorClass<OrchestratorCommandPreviouslyRejectedError>()(
  "OrchestratorCommandPreviouslyRejectedError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was previously rejected: ${this.detail}`;
  }
}

export const OrchestratorV2Error = Schema.Union([
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorCommandPreviouslyRejectedError,
]);
export type OrchestratorV2Error = typeof OrchestratorV2Error.Type;

export interface OrchestratorV2DispatchResult {
  readonly sequence: number;
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
}

export interface OrchestratorV2Shape {
  readonly resumeQueuedRuns: Effect.Effect<number, OrchestratorV2Error>;
  readonly dispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    OrchestratorV2Error
  >;
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationV2ThreadShellSnapshot,
    OrchestratorV2Error
  >;
  readonly getThreadEventSequence: (
    threadId: ThreadId,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly streamStoredEvents: Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  readonly streamStoredEventsFrom: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  readonly streamDomainEvents: Stream.Stream<OrchestrationV2DomainEvent, OrchestratorV2Error>;
}

export class OrchestratorV2 extends Context.Service<OrchestratorV2, OrchestratorV2Shape>()(
  "t3/orchestration-v2/Orchestrator/OrchestratorV2",
) {}

function nextRunOrdinal(projection: OrchestrationV2ThreadProjection): number {
  return projection.runs.length + 1;
}

function commandThreadId(command: OrchestrationV2Command): ThreadId {
  switch (command.type) {
    case "thread.create":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
    case "thread.metadata.update":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider-session.detach":
    case "message.dispatch":
    case "prepared-run.release":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queued-run.reorder":
    case "runtime-request.respond":
    case "checkpoint.rollback":
    case "provider.switch":
      return command.threadId;
    case "delegated_task.request":
    case "thread.created.record":
      return command.parentThreadId;
    case "thread.fork":
    case "thread.merge_back":
      return command.targetThreadId;
  }
}

function nextTurnItemOrdinal(projection: OrchestrationV2ThreadProjection): number {
  return Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1;
}

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

function isBlockingRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

function delegatedTaskTerminalStatus(
  status: OrchestrationV2Run["status"],
): OrchestrationV2Subagent["status"] | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "rolled_back":
      return "cancelled";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return null;
  }
}

function nextQueuedRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    )[0];
}

function latestStableRun(projection: OrchestrationV2ThreadProjection): OrchestrationV2Run | null {
  return (
    projection.runs
      .filter((run) => run.status === "completed" && run.checkpointId !== null)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null
  );
}

function runForSourcePoint(
  projection: OrchestrationV2ThreadProjection,
  sourcePoint: Extract<
    OrchestrationV2Command,
    { readonly type: "thread.fork" | "thread.merge_back" }
  >["sourcePoint"],
): OrchestrationV2Run | null {
  switch (sourcePoint.type) {
    case "latest_stable":
      return latestStableRun(projection);
    case "run":
      return projection.runs.find((run) => run.id === sourcePoint.runId) ?? null;
    case "checkpoint": {
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === sourcePoint.checkpointId,
      );
      return checkpoint?.runId === null || checkpoint === undefined
        ? null
        : (projection.runs.find((run) => run.id === checkpoint.runId) ?? null);
    }
  }
}

function providerThreadForRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderThread | undefined {
  return run.providerThreadId === null
    ? undefined
    : projection.providerThreads.find((candidate) => candidate.id === run.providerThreadId);
}

function providerTurnForRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderTurn | undefined {
  if (run.activeAttemptId === null) {
    return undefined;
  }

  return (
    projection.providerTurns.find((turn) => turn.runAttemptId === run.activeAttemptId) ??
    projection.providerTurns.find((turn) => {
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      return attempt?.providerTurnId === turn.id;
    })
  );
}

function contextSourcePointForRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): OrchestrationV2ContextSourcePoint {
  const providerThread = providerThreadForRun(projection, run);
  const providerTurn = providerTurnForRun(projection, run);
  return {
    threadId: projection.thread.id,
    runId: run.id,
    ...(run.checkpointId === null ? {} : { checkpointId: run.checkpointId }),
    ...(providerThread?.nativeThreadRef === null || providerThread?.nativeThreadRef === undefined
      ? {}
      : { providerThreadRef: providerThread.nativeThreadRef }),
    ...(providerTurn?.nativeTurnRef === null || providerTurn?.nativeTurnRef === undefined
      ? {}
      : { providerTurnRef: providerTurn.nativeTurnRef }),
  };
}

function pendingForkTransferForThread(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ContextTransfer | undefined {
  return projection.contextTransfers.find(
    (transfer) =>
      transfer.type === "fork" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

function pendingMergeBackTransfersForThread(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<OrchestrationV2ContextTransfer> {
  return projection.contextTransfers.filter(
    (transfer) =>
      transfer.type === "merge_back" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

function latestContextTransfer(
  transfers: ReadonlyArray<OrchestrationV2ContextTransfer>,
): OrchestrationV2ContextTransfer | undefined {
  return transfers.reduce<OrchestrationV2ContextTransfer | undefined>((latest, transfer) => {
    if (latest === undefined) {
      return transfer;
    }
    return DateTime.toEpochMillis(transfer.updatedAt) >= DateTime.toEpochMillis(latest.updatedAt)
      ? transfer
      : latest;
  }, undefined);
}

function visibleDeltaRunOrdinals(
  projection: OrchestrationV2ThreadProjection,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ContextHandoff["coveredRunOrdinals"] {
  const ordinals = items.flatMap((item) => {
    if (item.runId === null) {
      return [];
    }
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    return run === undefined ? [] : [run.ordinal];
  });
  if (ordinals.length === 0) {
    return { from: 1, to: 1 };
  }
  return {
    from: Math.min(...ordinals),
    to: Math.max(...ordinals),
  };
}

function rootProviderThreadsForProvider(
  projection: OrchestrationV2ThreadProjection,
  providerInstanceId: ModelSelection["instanceId"],
): ReadonlyArray<OrchestrationV2ProviderThread> {
  return projection.providerThreads
    .filter(
      (providerThread) =>
        providerThread.providerInstanceId === providerInstanceId &&
        providerThread.appThreadId === projection.thread.id &&
        providerThread.ownerNodeId === null,
    )
    .toSorted(
      (left, right) =>
        (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

const makeOrchestrator = Effect.fn("orchestrationV2.Orchestrator.layer")(function* () {
  const checkpointService = yield* CheckpointServiceV2;
  const commandPolicy = yield* CommandPolicyV2;
  const contextHandoffService = yield* ContextHandoffServiceV2;
  const eventSink = yield* EventSinkV2;
  const commandReceipts = yield* CommandReceiptStoreV2;
  const idAllocator = yield* IdAllocatorV2;
  const projectionStore = yield* ProjectionStoreV2;
  const providerAdapters = yield* ProviderAdapterRegistryV2;
  const providerSessions = yield* ProviderSessionManagerV2;
  const providerSwitchService = yield* ProviderSwitchServiceV2;
  const runtimePolicy = yield* RuntimePolicyV2;
  const threadForkService = yield* ThreadForkServiceV2;
  const threadDispatch = yield* makeKeyedSerialExecutor<ThreadId>();

  const mapDispatchError =
    (command: OrchestrationV2Command) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OrchestratorDispatchError, R> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

  const providerSessionIdFor = (input: {
    readonly adapter: ProviderAdapterV2Shape;
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

  const enforceCommandPolicy =
    (command: OrchestrationV2Command) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OrchestratorDispatchError, R> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

  const makeEvent = <Event extends OrchestrationV2DomainEvent>(
    command: OrchestrationV2Command,
    event: Omit<Event, "id">,
  ) =>
    Effect.gen(function* () {
      const eventId = yield* mapDispatchError(command)(
        idAllocator.allocate.event({
          threadId: event.threadId,
          commandId: command.commandId,
        }),
      );
      return {
        ...event,
        id: eventId,
      } as Event;
    });

  const emit =
    (events: Ref.Ref<Array<OrchestrationV2DomainEvent>>, command: OrchestrationV2Command) =>
    <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
      Effect.gen(function* () {
        const withId = yield* makeEvent(command, event);
        yield* Ref.update(events, (existing) => [...existing, withId]);
        return withId;
      });

  const getProjectionWithPendingEvents = (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const pending = (yield* Ref.get(events)).filter((event) => event.threadId === threadId);
      const stored = yield* Effect.option(projectionStore.getThreadProjection(threadId));
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

  const makeSystemEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
    Effect.gen(function* () {
      const eventId = yield* idAllocator.allocate.event({
        threadId: event.threadId,
      });
      return {
        ...event,
        id: eventId,
      } as Event;
    });

  const writeSystemEvents = (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
    effects: ReadonlyArray<PendingOrchestrationEffectV2> = [],
  ) =>
    Effect.gen(function* () {
      const withIds = yield* Effect.forEach(events, (event) =>
        makeSystemEvent(event as Omit<OrchestrationV2DomainEvent, "id">),
      );
      yield* eventSink.writeWithEffects({ events: withIds, effects });
    });

  const startNextQueuedRun = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore.getThreadProjection(threadId);
      if (projection.runs.some(isBlockingRun)) {
        return;
      }

      const queuedRun = nextQueuedRun(projection);
      if (queuedRun === undefined) {
        return;
      }
      const rootNodeId = queuedRun.rootNodeId;
      const attemptId = queuedRun.activeAttemptId;
      const providerThreadId = queuedRun.providerThreadId;
      if (rootNodeId === null || attemptId === null || providerThreadId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: CommandId.make(`command:system:start-queued:${queuedRun.id}`),
          commandType: "message.dispatch",
          cause: `Queued run ${queuedRun.id} is missing execution identity.`,
        });
      }

      const rootNode = projection.nodes.find((candidate) => candidate.id === rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === attemptId);
      const queuedProviderThread = projection.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      );
      const storedCheckpointScope = projection.checkpointScopes.find(
        (scope) => scope.id === rootNode?.checkpointScopeId,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        queuedProviderThread === undefined ||
        (rootNode.checkpointScopeId !== null && storedCheckpointScope === undefined)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: CommandId.make(`command:system:start-queued:${queuedRun.id}`),
          commandType: "message.dispatch",
          cause: `Queued run ${queuedRun.id} is missing projection state.`,
        });
      }

      const commandId = CommandId.make(`command:system:start-queued:${queuedRun.id}`);
      const now = yield* DateTime.now;
      const checkpointScope =
        storedCheckpointScope ??
        (yield* runtimePolicy
          .resolve({ thread: projection.thread, modelSelection: queuedRun.modelSelection })
          .pipe(
            Effect.flatMap((resolvedRuntimePolicy) =>
              checkpointService.prepareRootRunScope({
                threadId,
                runId: queuedRun.id,
                rootNodeId: rootNode.id,
                providerThreadId: queuedProviderThread.id,
                cwd: resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
                createdAt: now,
              }),
            ),
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId,
                  commandType: "message.dispatch",
                  cause,
                }),
            ),
          ));
      const providerSessionId =
        queuedProviderThread.providerSessionId ??
        (yield* providerAdapters.get(queuedRun.providerInstanceId).pipe(
          Effect.flatMap((adapter) =>
            providerSessionIdFor({
              adapter,
              providerInstanceId: queuedRun.providerInstanceId,
              threadId,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId,
                commandType: "message.dispatch",
                cause,
              }),
          ),
        ));
      const providerThread: OrchestrationV2ProviderThread = {
        ...queuedProviderThread,
        providerSessionId,
        status: "not_loaded",
        firstRunOrdinal: queuedProviderThread.firstRunOrdinal ?? queuedRun.ordinal,
        lastRunOrdinal: queuedRun.ordinal,
        updatedAt: now,
      };
      const startingRun: OrchestrationV2Run = {
        ...queuedRun,
        status: "starting",
        queuePosition: null,
        startedAt: null,
      };
      const checkpointEvents: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> =
        storedCheckpointScope === undefined
          ? [
              {
                type: "checkpoint-scope.created",
                threadId,
                runId: queuedRun.id,
                nodeId: rootNode.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: checkpointScope,
              },
              {
                type: "node.updated",
                threadId,
                runId: queuedRun.id,
                nodeId: rootNode.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: { ...rootNode, checkpointScopeId: checkpointScope.id },
              },
            ]
          : [];
      yield* writeSystemEvents(
        [
          ...checkpointEvents,
          {
            type: "provider-thread.updated",
            threadId,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: providerThread,
          },
          {
            type: "run.updated",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: startingRun,
          },
        ],
        [
          {
            id: `effect:${commandId}:provider-turn.start:${queuedRun.id}`,
            commandId,
            threadId,
            request: { type: "provider-turn.start", runId: queuedRun.id },
          },
        ],
      );
    });

  const resumeQueuedRuns = Effect.gen(function* () {
    const shell = yield* projectionStore.getShellSnapshot();
    let resumed = 0;
    for (const thread of shell.threads) {
      const resumedThread = yield* Effect.gen(function* () {
        const projection = yield* projectionStore.getThreadProjection(thread.id);
        if (projection.runs.some(isBlockingRun) || nextQueuedRun(projection) === undefined) {
          return false;
        }
        yield* threadDispatch.withLock(thread.id, startNextQueuedRun(thread.id));
        return true;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to resume queued V2 run after recovery", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (resumedThread) {
        resumed += 1;
      }
    }
    return resumed;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:system:resume-queued-runs"),
          commandType: "message.dispatch",
          cause,
        }),
    ),
  );

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

    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
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
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: command.threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    };

    yield* emitEvent({
      type: "thread.created",
      threadId: command.threadId,
      providerInstanceId: command.modelSelection.instanceId,
      occurredAt: now,
      payload: thread,
    });
  });

  const dispatchThreadMutation = Effect.fn("orchestrationV2.dispatch.threadMutation")(function* (
    command: Extract<
      OrchestrationV2Command,
      {
        readonly type:
          | "thread.archive"
          | "thread.unarchive"
          | "thread.delete"
          | "thread.metadata.update"
          | "thread.runtime-mode.set"
          | "thread.interaction-mode.set"
          | "thread.model-selection.set"
          | "provider.switch";
      }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* projectionStore.getThreadProjection(command.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProjectionError({
            threadId: command.threadId,
            cause,
          }),
      ),
    );
    const thread = projection.thread;
    if (thread.deletedAt !== null && command.type !== "thread.delete") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is deleted.`,
      });
    }
    if (command.type === "thread.archive" && thread.archivedAt !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is already archived.`,
      });
    }
    if (command.type === "thread.unarchive" && thread.archivedAt === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is not archived.`,
      });
    }

    const providerSwitchPlan =
      command.type === "thread.model-selection.set" || command.type === "provider.switch"
        ? yield* Effect.gen(function* () {
            yield* providerAdapters.get(command.modelSelection.instanceId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorProviderAdapterError({
                    commandId: command.commandId,
                    providerInstanceId: command.modelSelection.instanceId,
                    cause,
                  }),
              ),
            );
            return yield* providerSwitchService
              .plan({
                projection,
                targetModelSelection: command.modelSelection,
              })
              .pipe(mapDispatchError(command));
          })
        : null;

    const now = yield* DateTime.now;
    const updatedThread: OrchestrationV2AppThread = (() => {
      switch (command.type) {
        case "thread.archive":
          return { ...thread, archivedAt: now, updatedAt: now };
        case "thread.unarchive":
          return { ...thread, archivedAt: null, updatedAt: now };
        case "thread.delete":
          return { ...thread, deletedAt: thread.deletedAt ?? now, updatedAt: now };
        case "thread.metadata.update":
          return {
            ...thread,
            ...(command.title === undefined ? {} : { title: command.title }),
            ...(command.branch === undefined ? {} : { branch: command.branch }),
            ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
            updatedAt: now,
          };
        case "thread.runtime-mode.set":
          return { ...thread, runtimeMode: command.runtimeMode, updatedAt: now };
        case "thread.interaction-mode.set":
          return { ...thread, interactionMode: command.interactionMode, updatedAt: now };
        case "thread.model-selection.set":
        case "provider.switch":
          return {
            ...thread,
            providerInstanceId: command.modelSelection.instanceId,
            modelSelection: command.modelSelection,
            updatedAt: now,
          };
      }
    })();
    const eventType = (() => {
      switch (command.type) {
        case "thread.archive":
          return "thread.archived" as const;
        case "thread.unarchive":
          return "thread.unarchived" as const;
        case "thread.delete":
          return "thread.deleted" as const;
        case "thread.metadata.update":
          return "thread.metadata-updated" as const;
        case "thread.runtime-mode.set":
          return "thread.runtime-mode-updated" as const;
        case "thread.interaction-mode.set":
          return "thread.interaction-mode-updated" as const;
        case "thread.model-selection.set":
          return "thread.model-selection-updated" as const;
        case "provider.switch":
          return "thread.provider-switched" as const;
      }
    })();
    yield* emit(
      events,
      command,
    )({
      type: eventType,
      threadId: command.threadId,
      providerInstanceId: updatedThread.providerInstanceId,
      occurredAt: now,
      payload: updatedThread,
    });

    if (command.type === "thread.delete") {
      const emitEvent = emit(events, command);
      const activeRunIds = new Set(
        projection.runs
          .filter((run) =>
            ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
          )
          .map((run) => run.id),
      );
      for (const run of projection.runs.filter((candidate) => activeRunIds.has(candidate.id))) {
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
        });
      }
      for (const attempt of projection.attempts.filter(
        (candidate) =>
          activeRunIds.has(candidate.runId) &&
          (candidate.status === "pending" || candidate.status === "running"),
      )) {
        const run = projection.runs.find((candidate) => candidate.id === attempt.runId)!;
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: command.threadId,
          runId: attempt.runId,
          nodeId: attempt.rootNodeId,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...attempt, status: "cancelled", completedAt: now },
        });
      }
      for (const node of projection.nodes.filter(
        (candidate) =>
          candidate.runId !== null &&
          activeRunIds.has(candidate.runId) &&
          ["pending", "running", "waiting"].includes(candidate.status),
      )) {
        const run = projection.runs.find((candidate) => candidate.id === node.runId)!;
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "cancelled", completedAt: now },
        });
      }
      for (const request of projection.runtimeRequests.filter(
        (candidate) => candidate.status === "pending",
      )) {
        yield* emitEvent({
          type: "runtime-request.updated",
          threadId: command.threadId,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: "The thread was deleted.",
            },
            resolvedAt: now,
          },
        });
      }
    }

    const detachSessionIds = new Set(
      command.type === "thread.archive" || command.type === "thread.delete"
        ? projection.providerSessions.map((session) => session.id)
        : command.type === "thread.metadata.update" &&
            command.worktreePath !== undefined &&
            command.worktreePath !== thread.worktreePath
          ? projection.providerSessions.map((session) => session.id)
          : command.type === "thread.runtime-mode.set"
            ? projection.providerSessions
                .filter(
                  (session) => !session.capabilities.sessions.supportsRuntimeModeSwitchInSession,
                )
                .map((session) => session.id)
            : (providerSwitchPlan?.releaseProviderSessionIds ?? []),
    );
    if (detachSessionIds.size > 0) {
      const liveSessions = projection.providerSessions.filter(
        (session) =>
          detachSessionIds.has(session.id) &&
          session.status !== "stopped" &&
          session.status !== "error",
      );
      yield* Effect.forEach(
        liveSessions,
        (session) =>
          Effect.gen(function* () {
            yield* emit(
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
                reason:
                  command.type === "thread.archive"
                    ? "Thread archived."
                    : command.type === "thread.delete"
                      ? "Thread deleted."
                      : command.type === "thread.metadata.update"
                        ? "Workspace changed."
                        : command.type === "thread.runtime-mode.set"
                          ? "Runtime mode changed."
                          : "Provider or model selection changed.",
              },
            });
            const pendingEffect = {
              id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
              commandId: command.commandId,
              threadId: command.threadId,
              request: {
                type: "provider-session.detach",
                providerSessionId: session.id,
                detail:
                  command.type === "thread.archive"
                    ? "Thread archived."
                    : command.type === "thread.delete"
                      ? "Thread deleted."
                      : command.type === "thread.metadata.update"
                        ? "Workspace changed."
                        : command.type === "thread.runtime-mode.set"
                          ? "Runtime mode changed."
                          : "Provider or model selection changed.",
              },
            } satisfies PendingOrchestrationEffectV2;
            yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
          }),
        { concurrency: 1, discard: true },
      );
    }

    if (command.type === "thread.archive" || command.type === "thread.delete") {
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:terminal.cleanup`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "terminal.cleanup" },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    }

    if (command.type === "thread.delete") {
      const attachmentIds = Array.from(
        new Set(
          projection.messages.flatMap((message) => message.attachments.map((item) => item.id)),
        ),
      );
      if (attachmentIds.length > 0) {
        yield* Ref.update(effects, (existing) => [
          ...existing,
          {
            id: `effect:${command.commandId}:attachment.cleanup`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: { type: "attachment.cleanup", attachmentIds },
          } satisfies PendingOrchestrationEffectV2,
        ]);
      }
    }
  });

  const dispatchProviderSessionDetach = Effect.fn("orchestrationV2.dispatch.providerSessionDetach")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "provider-session.detach" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const projection = yield* projectionStore
        .getThreadProjection(command.threadId)
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
      yield* emit(
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

  const dispatchThreadFork = Effect.fn("orchestrationV2.dispatch.threadFork")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.source_thread_id": command.sourceThreadId,
      "orchestration_v2.target_thread_id": command.targetThreadId,
      "orchestration_v2.source_point_type": command.sourcePoint.type,
    });

    const sourceProjection = yield* projectionStore
      .getThreadProjection(command.sourceThreadId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.sourceThreadId,
              cause,
            }),
        ),
      );

    const sourceRun = runForSourcePoint(sourceProjection, command.sourcePoint);

    if (sourceRun === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No stable source run was found for fork source ${command.sourcePoint.type}.`,
      });
    }
    if (sourceRun.status !== "completed") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Fork source run ${sourceRun.id} is ${sourceRun.status}; only completed runs are supported.`,
      });
    }
    const sourceProviderThread = providerThreadForRun(sourceProjection, sourceRun);
    const now = command.createdAt ?? (yield* DateTime.now);
    const emitEvent = emit(events, command);
    const transferId = yield* mapDispatchError(command)(
      idAllocator.allocate.contextTransfer({
        sourceThreadId: sourceProjection.thread.id,
        targetThreadId: command.targetThreadId,
        type: "fork",
      }),
    );
    const { targetThread, transfer } = yield* threadForkService
      .plan({
        sourceProjection,
        sourceRun,
        sourceProviderThread,
        canonicalSourcePoint: contextSourcePointForRun(sourceProjection, sourceRun),
        transferId,
        targetThreadId: command.targetThreadId,
        ...(command.title === undefined ? {} : { title: command.title }),
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        createdAt: now,
      })
      .pipe(mapDispatchError(command));

    yield* emitEvent({
      type: "thread.created",
      threadId: command.targetThreadId,
      providerInstanceId: targetThread.providerInstanceId,
      occurredAt: now,
      payload: targetThread,
    });
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: command.targetThreadId,
      providerInstanceId: sourceRun.providerInstanceId,
      occurredAt: now,
      payload: transfer,
    });
  });

  const dispatchThreadMergeBack = Effect.fn("orchestrationV2.dispatch.threadMergeBack")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.merge_back" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.source_thread_id": command.sourceThreadId,
      "orchestration_v2.target_thread_id": command.targetThreadId,
      "orchestration_v2.source_point_type": command.sourcePoint.type,
    });

    const sourceProjection = yield* projectionStore
      .getThreadProjection(command.sourceThreadId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.sourceThreadId,
              cause,
            }),
        ),
      );
    const targetProjection = yield* projectionStore
      .getThreadProjection(command.targetThreadId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.targetThreadId,
              cause,
            }),
        ),
      );

    if (
      sourceProjection.thread.lineage.relationshipToParent !== "fork" ||
      sourceProjection.thread.lineage.parentThreadId !== command.targetThreadId
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.sourceThreadId} is not a fork of ${command.targetThreadId}.`,
      });
    }

    const sourceRun = runForSourcePoint(sourceProjection, command.sourcePoint);
    if (sourceRun === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No stable source run was found for merge-back source ${command.sourcePoint.type}.`,
      });
    }
    if (sourceRun.status !== "completed") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Merge-back source run ${sourceRun.id} is ${sourceRun.status}; only completed runs are supported.`,
      });
    }

    const forkTransfer = sourceProjection.contextTransfers.findLast(
      (transfer) =>
        transfer.type === "fork" &&
        transfer.sourceThreadId === command.targetThreadId &&
        transfer.targetThreadId === command.sourceThreadId,
    );
    if (forkTransfer === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No fork transfer exists between ${command.targetThreadId} and ${command.sourceThreadId}.`,
      });
    }

    const sourceProviderThread = providerThreadForRun(sourceProjection, sourceRun);
    const now = command.createdAt ?? (yield* DateTime.now);
    const emitEvent = emit(events, command);
    const transferId = yield* mapDispatchError(command)(
      idAllocator.allocate.contextTransfer({
        sourceThreadId: command.sourceThreadId,
        targetThreadId: command.targetThreadId,
        type: "merge_back",
      }),
    );
    const pendingMergeBackTransfersForPair = targetProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.status === "pending" &&
        transfer.sourceThreadId === command.sourceThreadId &&
        transfer.targetThreadId === command.targetThreadId,
    );
    const transfer: OrchestrationV2ContextTransfer = {
      id: transferId,
      type: "merge_back",
      sourceThreadId: command.sourceThreadId,
      targetThreadId: command.targetThreadId,
      sourcePoint: contextSourcePointForRun(sourceProjection, sourceRun),
      basePoint: forkTransfer.sourcePoint,
      sourceProviderInstanceId: sourceRun.providerInstanceId,
      targetProviderInstanceId: targetProjection.thread.modelSelection.instanceId,
      targetRunId: null,
      status: "pending",
      resolution: null,
      createdBy: command.createdBy,
      error:
        sourceProviderThread === undefined ? "Source merge-back run has no provider thread." : null,
      createdAt: now,
      updatedAt: now,
      consumedAt: null,
    };

    for (const pendingTransfer of pendingMergeBackTransfersForPair) {
      yield* emitEvent({
        type: "context-transfer.updated",
        threadId: command.targetThreadId,
        providerInstanceId: sourceRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...pendingTransfer,
          status: "superseded",
          error: `Superseded by merge-back transfer ${transferId}.`,
          updatedAt: now,
        },
      });
    }
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: command.targetThreadId,
      providerInstanceId: sourceRun.providerInstanceId,
      occurredAt: now,
      payload: transfer,
    });
  });

  const dispatchSteerIntoRun = (input: {
    readonly command: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
    readonly projection: OrchestrationV2ThreadProjection;
    readonly modelSelection: ModelSelection;
    readonly targetRunId: OrchestrationV2Run["id"];
    readonly messageId: OrchestrationV2ConversationMessage["id"];
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
    readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
    readonly forceRestart: boolean;
  }) =>
    Effect.gen(function* () {
      const targetRun = input.projection.runs.find(
        (candidate) => candidate.id === input.targetRunId,
      );
      if (targetRun === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Target run ${input.targetRunId} was not found.`,
        });
      }
      const rootNodeId = targetRun.rootNodeId;
      if (rootNodeId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Target run ${targetRun.id} has no root node.`,
        });
      }
      if (targetRun.status !== "running") {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Target run ${targetRun.id} is ${targetRun.status} and cannot be steered.`,
        });
      }
      const providerThread = input.projection.providerThreads.find(
        (candidate) => candidate.id === targetRun.providerThreadId,
      );
      if (providerThread === undefined || providerThread.providerSessionId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Provider thread ${targetRun.providerThreadId} has no active provider session for steering.`,
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      const providerTurn = input.projection.providerTurns.find(
        (candidate) =>
          candidate.runAttemptId === targetRun.activeAttemptId && candidate.status === "running",
      );
      if (providerTurn === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `No running provider turn found for active run ${targetRun.id}.`,
        });
      }
      const sessionOption = yield* providerSessions.get(providerSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: input.command.commandId,
              commandType: input.command.type,
              cause,
            }),
        ),
      );
      if (Option.isNone(sessionOption)) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Provider session ${providerThread.providerSessionId} is not active.`,
        });
      }

      const session = sessionOption.value;
      const now = yield* DateTime.now;
      const emitEvent = emit(input.events, input.command);
      const selectionChanged = !modelSelectionsEqual(
        targetRun.modelSelection,
        input.modelSelection,
      );
      const providerInstanceChanged =
        targetRun.providerInstanceId !== input.modelSelection.instanceId;
      const selectionTransition =
        selectionChanged && !providerInstanceChanged
          ? yield* providerAdapters.get(targetRun.providerInstanceId).pipe(
              Effect.flatMap((adapter) =>
                adapter.planSelectionTransition({
                  current: targetRun.modelSelection,
                  target: input.modelSelection,
                  sessionCapabilities: session.providerSession.capabilities,
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestratorProviderAdapterError({
                    commandId: input.command.commandId,
                    providerInstanceId: targetRun.providerInstanceId,
                    cause,
                  }),
              ),
            )
          : null;
      if (selectionTransition?.type === "reject") {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: selectionTransition.reason,
        });
      }
      const appendSteeringMessage = (messageInput: {
        readonly runId: OrchestrationV2Run["id"];
        readonly nodeId: OrchestrationV2ExecutionNode["id"];
        readonly providerTurnId: typeof providerTurn.id | null;
        readonly providerThreadId: OrchestrationV2ProviderThread["id"];
        readonly providerInstanceId: ProviderInstanceId;
      }) =>
        Effect.gen(function* () {
          const message: OrchestrationV2ConversationMessage = {
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            id: input.messageId,
            threadId: input.command.threadId,
            runId: messageInput.runId,
            nodeId: messageInput.nodeId,
            role: "user",
            text: input.text,
            attachments: input.attachments,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          };
          const turnItem: OrchestrationV2TurnItem = {
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            id: idAllocator.derive.userTurnItem({ messageId: input.messageId }),
            threadId: input.command.threadId,
            runId: messageInput.runId,
            nodeId: messageInput.nodeId,
            providerThreadId: messageInput.providerThreadId,
            providerTurnId: messageInput.providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: nextTurnItemOrdinal(input.projection),
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: input.messageId,
            inputIntent:
              input.command.type === "queued-message.promote-to-steer"
                ? "promoted_queued_to_steer"
                : "steer",
            text: input.text,
            attachments: input.attachments,
          };
          yield* emitEvent({
            type: "message.updated",
            threadId: input.command.threadId,
            runId: messageInput.runId,
            nodeId: messageInput.nodeId,
            providerInstanceId: messageInput.providerInstanceId,
            occurredAt: now,
            payload: message,
          });
          yield* emitEvent({
            type: "turn-item.updated",
            threadId: input.command.threadId,
            runId: messageInput.runId,
            nodeId: messageInput.nodeId,
            providerInstanceId: messageInput.providerInstanceId,
            occurredAt: now,
            payload: turnItem,
          });
        });

      const steeringPolicy = yield* enforceCommandPolicy(input.command)(
        commandPolicy.decideSteeringExecution({
          commandId: input.command.commandId,
          threadId: input.command.threadId,
          providerInstanceId: targetRun.providerInstanceId,
          capabilities: session.providerSession.capabilities,
          forceRestart: input.forceRestart || selectionChanged,
        }),
      );

      if (steeringPolicy === "active_steering") {
        yield* appendSteeringMessage({
          runId: targetRun.id,
          nodeId: rootNodeId,
          providerTurnId: providerTurn.id,
          providerThreadId: providerThread.id,
          providerInstanceId: targetRun.providerInstanceId,
        });
        yield* Ref.update(input.effects, (existing) => [
          ...existing,
          {
            id: `effect:${input.command.commandId}:provider-turn.steer:${providerTurn.id}`,
            commandId: input.command.commandId,
            threadId: input.command.threadId,
            request: {
              type: "provider-turn.steer",
              providerSessionId,
              providerThreadId: providerThread.id,
              providerTurnId: providerTurn.id,
              messageId: input.messageId,
            },
          } satisfies PendingOrchestrationEffectV2,
        ]);
        return;
      }

      const currentAttempt = input.projection.attempts.find(
        (candidate) => candidate.id === targetRun.activeAttemptId,
      );
      const currentRootNode = input.projection.nodes.find(
        (candidate) => candidate.id === rootNodeId,
      );
      const attemptOrdinal =
        Math.max(
          0,
          ...input.projection.attempts
            .filter((candidate) => candidate.runId === targetRun.id)
            .map((candidate) => candidate.attemptOrdinal),
        ) + 1;
      const nextAttemptId = idAllocator.derive.runAttempt({
        runId: targetRun.id,
        attemptOrdinal,
      });
      const nextRootNodeId = idAllocator.derive.rootNodeAttempt({
        runId: targetRun.id,
        attemptOrdinal,
      });
      let restartProviderThread = providerThread;
      let restartSessionTransition:
        | {
            readonly type: "replace";
            readonly replacementProviderSessionId: ProviderSessionId;
          }
        | { readonly type: "detach" }
        | null = null;
      let restartHandoff: OrchestrationV2ContextHandoff | null = null;
      let restartTransfer: OrchestrationV2ContextTransfer | null = null;
      const requiresProviderThreadHandoff =
        providerInstanceChanged || selectionTransition?.type === "create_with_handoff";
      const requiresProviderSessionRestart = selectionTransition?.type === "restart_session";
      if (requiresProviderThreadHandoff) {
        const targetAdapter = yield* providerAdapters.get(input.modelSelection.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: input.command.commandId,
                providerInstanceId: input.modelSelection.instanceId,
                cause,
              }),
          ),
        );
        const targetCapabilities = yield* targetAdapter.getCapabilities().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: input.command.commandId,
                providerInstanceId: input.modelSelection.instanceId,
                cause,
              }),
          ),
        );
        yield* enforceCommandPolicy(input.command)(
          commandPolicy.ensureContextHandoff({
            commandId: input.command.commandId,
            threadId: input.command.threadId,
            providerInstanceId: input.modelSelection.instanceId,
            capabilities: targetCapabilities,
            strategy: "full_thread_summary",
          }),
        );
        const existingTargetProviderThread = rootProviderThreadsForProvider(
          input.projection,
          input.modelSelection.instanceId,
        ).find((candidate) => candidate.id !== providerThread.id);
        const targetProviderSessionId =
          existingTargetProviderThread?.providerSessionId ??
          (yield* mapDispatchError(input.command)(
            providerSessionIdFor({
              adapter: targetAdapter,
              providerInstanceId: input.modelSelection.instanceId,
              threadId: input.command.threadId,
            }),
          ));
        const targetProviderThreadBase: OrchestrationV2ProviderThread =
          existingTargetProviderThread === undefined
            ? {
                id: idAllocator.derive.providerThread({
                  driver: targetAdapter.driver,
                  nativeThreadId: `pending:${targetRun.id}:attempt:${attemptOrdinal}`,
                }),
                driver: targetAdapter.driver,
                providerInstanceId: input.modelSelection.instanceId,
                providerSessionId: targetProviderSessionId,
                appThreadId: input.command.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "not_loaded",
                firstRunOrdinal: targetRun.ordinal,
                lastRunOrdinal: targetRun.ordinal,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }
            : {
                ...existingTargetProviderThread,
                providerSessionId: targetProviderSessionId,
                lastRunOrdinal: targetRun.ordinal,
                updatedAt: now,
              };
        const transferId = yield* mapDispatchError(input.command)(
          idAllocator.allocate.contextTransfer({
            sourceThreadId: input.command.threadId,
            targetThreadId: input.command.threadId,
            type: "provider_handoff",
          }),
        );
        restartHandoff = yield* contextHandoffService
          .prepareProviderHandoff({
            threadId: input.command.threadId,
            targetRunId: targetRun.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: targetProviderThreadBase.id,
            fromProviderInstanceId: targetRun.providerInstanceId,
            toProviderInstanceId: input.modelSelection.instanceId,
            coveredRunOrdinals: { from: 1, to: targetRun.ordinal },
            strategy: "full_thread_summary",
            items: input.projection.turnItems,
            createdAt: now,
          })
          .pipe(mapDispatchError(input.command));
        restartProviderThread = {
          ...targetProviderThreadBase,
          handoffIds: Array.from(
            new Set([...targetProviderThreadBase.handoffIds, restartHandoff.id]),
          ),
        };
        restartTransfer = {
          id: transferId,
          type: "provider_handoff",
          sourceThreadId: input.command.threadId,
          targetThreadId: input.command.threadId,
          sourcePoint: contextSourcePointForRun(input.projection, targetRun),
          basePoint: null,
          sourceProviderInstanceId: targetRun.providerInstanceId,
          targetProviderInstanceId: input.modelSelection.instanceId,
          targetRunId: targetRun.id,
          status: "consumed",
          resolution: {
            strategy: "portable_context",
            contextHandoffId: restartHandoff.id,
          },
          createdBy: input.createdBy,
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: now,
        };
        restartSessionTransition = { type: "detach" };
      } else if (requiresProviderSessionRestart) {
        const nextProviderSessionId = yield* mapDispatchError(input.command)(
          idAllocator.allocate.providerSession({
            providerInstanceId: input.modelSelection.instanceId,
            threadId: input.command.threadId,
          }),
        );
        restartProviderThread = {
          ...providerThread,
          providerSessionId: nextProviderSessionId,
          status: "not_loaded",
          updatedAt: now,
        };
        restartSessionTransition = {
          type: "replace",
          replacementProviderSessionId: nextProviderSessionId,
        };
      }
      const resolvedRuntimePolicy = yield* runtimePolicy
        .resolve({ thread: input.projection.thread, modelSelection: input.modelSelection })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: input.command.commandId,
                commandType: input.command.type,
                cause,
              }),
          ),
        );
      const checkpointScope = yield* checkpointService
        .prepareRootRunScope({
          threadId: input.command.threadId,
          runId: targetRun.id,
          rootNodeId: nextRootNodeId,
          providerThreadId: restartProviderThread.id,
          cwd:
            resolvedRuntimePolicy.cwd ??
            input.projection.thread.worktreePath ??
            session.providerSession.cwd,
          createdAt: now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: input.command.commandId,
                commandType: input.command.type,
                cause,
              }),
          ),
        );
      const ensuredCheckpointScope = yield* checkpointService.ensureScope(checkpointScope).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: input.command.commandId,
              commandType: input.command.type,
              cause,
            }),
        ),
      );
      const restartedRun: OrchestrationV2Run = {
        ...targetRun,
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        providerThreadId: restartProviderThread.id,
        rootNodeId: nextRootNodeId,
        activeAttemptId: nextAttemptId,
        userMessageId: input.messageId,
        status: "starting",
        contextHandoffId: restartHandoff?.id ?? targetRun.contextHandoffId,
      };
      const nextAttempt: OrchestrationV2RunAttempt = {
        id: nextAttemptId,
        runId: targetRun.id,
        attemptOrdinal,
        rootNodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        providerThreadId: restartProviderThread.id,
        providerTurnId: null,
        reason: "steering_restart",
        status: "pending",
        startedAt: null,
        completedAt: null,
      };
      const nextRootNode: OrchestrationV2ExecutionNode = {
        id: nextRootNodeId,
        threadId: input.command.threadId,
        runId: targetRun.id,
        parentNodeId: null,
        rootNodeId: nextRootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId: restartProviderThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: ensuredCheckpointScope.id,
        startedAt: null,
        completedAt: null,
      };
      if (currentAttempt !== undefined) {
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: rootNodeId,
          providerInstanceId: targetRun.providerInstanceId,
          occurredAt: now,
          payload: { ...currentAttempt, status: "superseded", completedAt: now },
        });
      }
      if (currentRootNode !== undefined) {
        yield* emitEvent({
          type: "node.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: rootNodeId,
          providerInstanceId: targetRun.providerInstanceId,
          occurredAt: now,
          payload: { ...currentRootNode, status: "interrupted", completedAt: now },
        });
      }
      if (requiresProviderThreadHandoff || requiresProviderSessionRestart) {
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: input.command.threadId,
          driver: restartProviderThread.driver,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: restartProviderThread,
        });
      }
      if (restartHandoff !== null) {
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: restartHandoff,
        });
      }
      if (restartTransfer !== null) {
        yield* emitEvent({
          type: "context-transfer.created",
          threadId: input.command.threadId,
          runId: targetRun.id,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: restartTransfer,
        });
      }
      yield* emitEvent({
        type: "run.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: restartedRun,
      });
      yield* emitEvent({
        type: "run-attempt.created",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: nextAttempt,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: nextRootNode,
      });
      yield* emitEvent({
        type: "checkpoint-scope.created",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: ensuredCheckpointScope,
      });
      yield* appendSteeringMessage({
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerTurnId: null,
        providerThreadId: restartProviderThread.id,
        providerInstanceId: input.modelSelection.instanceId,
      });
      const interruptedAttemptId = targetRun.activeAttemptId;
      if (interruptedAttemptId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Active run ${targetRun.id} has no attempt to interrupt.`,
        });
      }
      yield* Ref.update(input.effects, (existing) => [
        ...existing,
        {
          id: `effect:${input.command.commandId}:provider-turn.restart:${providerTurn.id}`,
          commandId: input.command.commandId,
          threadId: input.command.threadId,
          request: {
            type: "provider-turn.restart",
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            interruptedAttemptId,
            runId: targetRun.id,
            ...(restartSessionTransition === null
              ? {}
              : { sessionTransition: restartSessionTransition }),
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });

  const dispatchMessage = (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* getProjectionWithPendingEvents(command.threadId, events);
      const modelSelection = command.modelSelection ?? projection.thread.modelSelection;
      const dispatchMode = command.dispatchMode;
      const sourcePlanProjection =
        command.sourcePlanRef === undefined
          ? null
          : yield* getProjectionWithPendingEvents(command.sourcePlanRef.threadId, events);
      const sourcePlan =
        command.sourcePlanRef === undefined
          ? null
          : (sourcePlanProjection?.plans.find(
              (plan) => plan.id === command.sourcePlanRef?.planId && plan.kind === "proposed_plan",
            ) ?? null);
      if (command.sourcePlanRef !== undefined && sourcePlan === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Proposed plan ${command.sourcePlanRef.planId} does not exist on thread ${command.sourcePlanRef.threadId}.`,
        });
      }
      if (
        sourcePlanProjection !== null &&
        sourcePlanProjection.thread.projectId !== projection.thread.projectId
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Proposed plan ${command.sourcePlanRef?.planId} belongs to a different project.`,
        });
      }
      if (sourcePlan !== null && sourcePlan.status !== "active") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Proposed plan ${sourcePlan.id} is not active.`,
        });
      }
      const completeSourcePlan = (occurredAt: DateTime.Utc) =>
        sourcePlan === null
          ? Effect.void
          : emit(
              events,
              command,
            )({
              type: "plan.updated",
              threadId: sourcePlan.threadId,
              ...(sourcePlan.runId === null ? {} : { runId: sourcePlan.runId }),
              nodeId: sourcePlan.nodeId,
              occurredAt,
              payload: { ...sourcePlan, status: "completed" },
            });

      if (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") {
        yield* dispatchSteerIntoRun({
          command,
          events,
          effects,
          projection,
          modelSelection,
          targetRunId: dispatchMode.targetRunId,
          messageId: command.messageId,
          text: command.text,
          attachments: command.attachments,
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          forceRestart: dispatchMode.type === "restart_active",
        });
        return;
      }

      const activeProviderThread = projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      );
      const activeRun = projection.runs.find(isBlockingRun);
      const pendingMergeBackTransfers = pendingMergeBackTransfersForThread(projection);
      const shouldQueue =
        activeRun !== undefined &&
        (dispatchMode.type === "defer_start" ||
          dispatchMode.type === "start_immediately" ||
          dispatchMode.type === "queue_after_active");
      if (shouldQueue) {
        if (pendingMergeBackTransfers.length > 0) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Thread ${command.threadId} has a pending merge-back transfer; queued merge-back consumption is not implemented yet.`,
          });
        }
        const queueProviderThread =
          activeProviderThread ??
          projection.providerThreads.find(
            (candidate) => candidate.id === activeRun.providerThreadId,
          );
        if (queueProviderThread === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Active run ${activeRun.id} has no provider thread for queued dispatch.`,
          });
        }
        if (modelSelection.instanceId !== queueProviderThread.providerInstanceId) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Queued dispatch for provider instance ${modelSelection.instanceId} cannot run behind active provider instance ${queueProviderThread.providerInstanceId}.`,
          });
        }
        const existingProviderSession =
          queueProviderThread.providerSessionId === null
            ? undefined
            : projection.providerSessions.find(
                (candidate) => candidate.id === queueProviderThread.providerSessionId,
              );
        if (existingProviderSession !== undefined) {
          yield* enforceCommandPolicy(command)(
            commandPolicy.ensureQueuedMessages({
              commandId: command.commandId,
              threadId: command.threadId,
              providerInstanceId: modelSelection.instanceId,
              capabilities: existingProviderSession.capabilities,
            }),
          );
        }

        const now = yield* DateTime.now;
        const ordinal = nextRunOrdinal(projection);
        const runId = idAllocator.derive.run({ threadId: command.threadId, ordinal });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const checkpointScope =
          activeRun.status === "preparing"
            ? null
            : yield* runtimePolicy.resolve({ thread: projection.thread, modelSelection }).pipe(
                Effect.flatMap((resolvedRuntimePolicy) =>
                  checkpointService.prepareRootRunScope({
                    threadId: command.threadId,
                    runId,
                    rootNodeId,
                    providerThreadId: queueProviderThread.id,
                    cwd:
                      resolvedRuntimePolicy.cwd ??
                      existingProviderSession?.cwd ??
                      projection.thread.worktreePath ??
                      process.cwd(),
                    createdAt: now,
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
        const run: OrchestrationV2Run = {
          id: runId,
          threadId: command.threadId,
          ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: queueProviderThread.id,
          userMessageId: command.messageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "queued",
          queuePosition:
            Math.max(
              0,
              ...projection.runs
                .filter((candidate) => candidate.status === "queued")
                .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
            ) + 1,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
        };
        const attempt: OrchestrationV2RunAttempt = {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: queueProviderThread.id,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
        };
        const rootNode: OrchestrationV2ExecutionNode = {
          id: rootNodeId,
          threadId: command.threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: queueProviderThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: checkpointScope?.id ?? null,
          startedAt: null,
          completedAt: null,
        };
        const message: OrchestrationV2ConversationMessage = {
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          id: command.messageId,
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: command.text,
          attachments: command.attachments,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        };
        const turnItem: OrchestrationV2TurnItem = {
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: queueProviderThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 100,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: command.messageId,
          inputIntent: "queued_turn",
          text: command.text,
          attachments: command.attachments,
        };
        const emitEvent = emit(events, command);
        yield* emitEvent({
          type: "run.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: run,
        });
        yield* completeSourcePlan(now);
        yield* emitEvent({
          type: "run-attempt.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: attempt,
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: rootNode,
        });
        if (checkpointScope !== null) {
          yield* emitEvent({
            type: "checkpoint-scope.created",
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: yield* checkpointService.ensureScope(checkpointScope).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            ),
          });
        }
        yield* emitEvent({
          type: "message.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: message,
        });
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: turnItem,
        });
        return;
      }
      const pendingForkTransfer = pendingForkTransferForThread(projection);
      const pendingMergeBackSourceThreadIds = new Set(
        pendingMergeBackTransfers.map((transfer) => transfer.sourceThreadId),
      );
      if (pendingMergeBackSourceThreadIds.size > 1) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} has pending merge-back transfers from multiple forks.`,
        });
      }
      const pendingMergeBackTransfer = latestContextTransfer(pendingMergeBackTransfers);
      const supersededMergeBackTransfers = pendingMergeBackTransfers.filter(
        (transfer) => transfer.id !== pendingMergeBackTransfer?.id,
      );
      const now = yield* DateTime.now;
      const ordinal = nextRunOrdinal(projection);
      const runId = idAllocator.derive.run({ threadId: command.threadId, ordinal });
      const latestCompletedRun = projection.runs.findLast((run) => run.status === "completed");
      const isProviderSwitch =
        activeProviderThread !== undefined &&
        activeProviderThread.providerInstanceId !== modelSelection.instanceId;

      if (
        pendingForkTransfer === undefined &&
        pendingMergeBackTransfer === undefined &&
        !isProviderSwitch
      ) {
        const adapter = yield* providerAdapters.get(modelSelection.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: command.commandId,
                providerInstanceId: modelSelection.instanceId,
                cause,
              }),
          ),
        );
        const providerSessionId =
          activeProviderThread?.providerSessionId ??
          (yield* mapDispatchError(command)(
            providerSessionIdFor({
              adapter,
              providerInstanceId: modelSelection.instanceId,
              threadId: command.threadId,
            }),
          ));
        const providerThreadId =
          activeProviderThread?.id ??
          idAllocator.derive.providerThread({
            driver: adapter.driver,
            nativeThreadId: `pending:${runId}`,
          });
        const providerThread: OrchestrationV2ProviderThread =
          activeProviderThread === undefined
            ? {
                id: providerThreadId,
                driver: adapter.driver,
                providerInstanceId: modelSelection.instanceId,
                providerSessionId,
                appThreadId: command.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "not_loaded",
                firstRunOrdinal: ordinal,
                lastRunOrdinal: ordinal,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }
            : {
                ...activeProviderThread,
                providerSessionId,
                lastRunOrdinal: ordinal,
                updatedAt: now,
              };
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const checkpointScope =
          dispatchMode.type === "defer_start"
            ? null
            : yield* runtimePolicy
                .resolve({
                  thread: projection.thread,
                  modelSelection,
                })
                .pipe(
                  mapDispatchError(command),
                  Effect.flatMap((resolvedRuntimePolicy) =>
                    checkpointService.prepareRootRunScope({
                      threadId: command.threadId,
                      runId,
                      rootNodeId,
                      providerThreadId,
                      cwd:
                        resolvedRuntimePolicy.cwd ??
                        projection.thread.worktreePath ??
                        process.cwd(),
                      createdAt: now,
                    }),
                  ),
                  mapDispatchError(command),
                );
        const run: OrchestrationV2Run = {
          id: runId,
          threadId: command.threadId,
          ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: command.messageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: dispatchMode.type === "defer_start" ? "preparing" : "starting",
          queuePosition: null,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
        };
        const attempt: OrchestrationV2RunAttempt = {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
        };
        const rootNode: OrchestrationV2ExecutionNode = {
          id: rootNodeId,
          threadId: command.threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: checkpointScope?.id ?? null,
          startedAt: null,
          completedAt: null,
        };
        const message: OrchestrationV2ConversationMessage = {
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          id: command.messageId,
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: command.text,
          attachments: command.attachments,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        };
        const turnItem: OrchestrationV2TurnItem = {
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: nextTurnItemOrdinal(projection),
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: command.messageId,
          inputIntent: "turn_start",
          text: command.text,
          attachments: command.attachments,
        };
        const preparationTurnItem: OrchestrationV2TurnItem | null =
          dispatchMode.type === "defer_start"
            ? {
                id: idAllocator.derive.turnItemFromProviderItem({
                  driver: adapter.driver,
                  nativeItemId: `workspace-preparation:${runId}`,
                }),
                threadId: command.threadId,
                runId,
                nodeId: rootNodeId,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: turnItem.ordinal + 1,
                status: "running",
                title: WORKSPACE_PREPARATION_INPUT,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "command_execution",
                input: WORKSPACE_PREPARATION_INPUT,
              }
            : null;
        const emitEvent = emit(events, command);
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: command.threadId,
          driver: adapter.driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: providerThread,
        });
        yield* emitEvent({
          type: "run.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: run,
        });
        yield* completeSourcePlan(now);
        yield* emitEvent({
          type: "run-attempt.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: attempt,
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: rootNode,
        });
        if (checkpointScope !== null) {
          yield* emitEvent({
            type: "checkpoint-scope.created",
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: checkpointScope,
          });
        }
        yield* emitEvent({
          type: "message.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: message,
        });
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: turnItem,
        });
        if (preparationTurnItem !== null) {
          yield* emitEvent({
            type: "turn-item.updated",
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: preparationTurnItem,
          });
        }
        const pendingEffect = {
          id: `effect:${command.commandId}:provider-turn.start:${runId}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "provider-turn.start", runId },
        } satisfies PendingOrchestrationEffectV2;
        if (dispatchMode.type !== "defer_start") {
          yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
        }
        return;
      }
      const sourceProjection =
        pendingForkTransfer === undefined
          ? null
          : yield* projectionStore.getThreadProjection(pendingForkTransfer.sourceThreadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorProjectionError({
                    threadId: pendingForkTransfer.sourceThreadId,
                    cause,
                  }),
              ),
            );
      const sourceRun =
        pendingForkTransfer?.sourcePoint.runId === undefined || sourceProjection === null
          ? null
          : (sourceProjection.runs.find(
              (candidate) => candidate.id === pendingForkTransfer.sourcePoint.runId,
            ) ?? null);
      const sourceProviderThread =
        sourceProjection === null || sourceRun === null
          ? undefined
          : providerThreadForRun(sourceProjection, sourceRun);
      const sourceProviderTurnId =
        sourceProjection === null || sourceRun === null || sourceRun.activeAttemptId === null
          ? undefined
          : (sourceProjection.providerTurns.find(
              (candidate) => candidate.runAttemptId === sourceRun.activeAttemptId,
            )?.id ??
            sourceProjection.attempts.find(
              (candidate) => candidate.id === sourceRun.activeAttemptId,
            )?.providerTurnId ??
            undefined);
      if (pendingForkTransfer !== undefined) {
        if (sourceRun === null || sourceProviderThread === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Pending fork transfer ${pendingForkTransfer.id} has no resolvable source provider thread.`,
          });
        }
        if (pendingForkTransfer.sourceProviderInstanceId === null) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Pending fork transfer ${pendingForkTransfer.id} has no source provider.`,
          });
        }
      }

      const adapter = yield* providerAdapters.get(modelSelection.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: modelSelection.instanceId,
              cause,
            }),
        ),
      );
      const targetProviderThread = isProviderSwitch
        ? rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0]
        : activeProviderThread;
      const providerSessionId =
        targetProviderThread?.providerSessionId ??
        (yield* mapDispatchError(command)(
          providerSessionIdFor({
            adapter,
            providerInstanceId: modelSelection.instanceId,
            threadId: command.threadId,
          }),
        ));
      const existingProviderSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const resolvedRuntimePolicy = yield* runtimePolicy
        .resolve({ thread: projection.thread, modelSelection })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );

      const capabilities = yield* adapter.getCapabilities().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: modelSelection.instanceId,
              cause,
            }),
        ),
      );
      const forkExecution =
        pendingForkTransfer === undefined
          ? null
          : yield* enforceCommandPolicy(command)(
              commandPolicy.decideForkExecution({
                commandId: command.commandId,
                threadId: command.threadId,
                providerInstanceId: modelSelection.instanceId,
                capabilities,
                sameProvider:
                  pendingForkTransfer.sourceProviderInstanceId === modelSelection.instanceId,
                hasStrongNativeSource: sourceProviderThread?.nativeThreadRef?.strength === "strong",
                fromSpecificTurn: sourceRun !== null,
              }),
            );
      const canResolveForkNatively = forkExecution === "native_fork";
      const requiresPortableFork = forkExecution === "portable_context";

      if (canResolveForkNatively) {
        yield* enforceCommandPolicy(command)(
          commandPolicy.ensureNativeFork({
            commandId: command.commandId,
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
            fromSpecificTurn: sourceRun !== null,
          }),
        );
      }

      const ensuredProviderThread: OrchestrationV2ProviderThread =
        targetProviderThread === undefined
          ? {
              id: idAllocator.derive.providerThread({
                driver: adapter.driver,
                nativeThreadId: `pending:${runId}`,
              }),
              driver: adapter.driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId,
              appThreadId: command.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "not_loaded",
              firstRunOrdinal: ordinal,
              lastRunOrdinal: ordinal,
              handoffIds: [],
              forkedFrom:
                canResolveForkNatively && sourceProviderThread !== undefined
                  ? {
                      providerThreadId: sourceProviderThread.id,
                      ...(sourceProviderTurnId === undefined
                        ? {}
                        : { providerTurnId: sourceProviderTurnId }),
                    }
                  : null,
              createdAt: now,
              updatedAt: now,
            }
          : {
              ...targetProviderThread,
              providerSessionId,
              updatedAt: now,
            };
      const portableForkItems =
        !requiresPortableFork || sourceProjection === null || sourceRun === null
          ? []
          : sourceProjection.turnItems.filter((item) => {
              if (item.runId === null) {
                return false;
              }
              const itemRun = sourceProjection.runs.find(
                (candidate) => candidate.id === item.runId,
              );
              return itemRun !== undefined && itemRun.ordinal <= sourceRun.ordinal;
            });
      const portableForkHandoff =
        !requiresPortableFork ||
        pendingForkTransfer === undefined ||
        sourceProjection === null ||
        sourceRun === null
          ? null
          : yield* contextHandoffService
              .prepareProviderHandoff({
                threadId: command.threadId,
                targetRunId: runId,
                transferId: pendingForkTransfer.id,
                fromProviderThreadIds:
                  sourceProviderThread === undefined ? [] : [sourceProviderThread.id],
                toProviderThreadId: ensuredProviderThread.id,
                fromProviderInstanceId: sourceRun.providerInstanceId,
                toProviderInstanceId: modelSelection.instanceId,
                coveredRunOrdinals: visibleDeltaRunOrdinals(sourceProjection, portableForkItems),
                strategy: "full_thread_summary",
                items: portableForkItems,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
      const requiresFullProviderSwitchContext =
        isProviderSwitch && pendingMergeBackTransfer !== undefined;
      const providerSwitchCoveredRuns =
        !isProviderSwitch || latestCompletedRun === undefined
          ? []
          : projection.runs.filter(
              (run) =>
                run.status === "completed" &&
                run.ordinal >
                  (requiresFullProviderSwitchContext
                    ? 0
                    : (targetProviderThread?.lastRunOrdinal ?? 0)) &&
                run.ordinal <= latestCompletedRun.ordinal,
            );
      const providerSwitchItems =
        providerSwitchCoveredRuns.length === 0
          ? []
          : projection.turnItems.filter(
              (item) =>
                item.runId !== null &&
                providerSwitchCoveredRuns.some((run) => run.id === item.runId),
            );
      const providerSwitchTransferId =
        providerSwitchCoveredRuns.length === 0 || latestCompletedRun === undefined
          ? null
          : yield* mapDispatchError(command)(
              idAllocator.allocate.contextTransfer({
                sourceThreadId: command.threadId,
                targetThreadId: command.threadId,
                type: "provider_handoff",
              }),
            );
      if (providerSwitchTransferId !== null) {
        yield* enforceCommandPolicy(command)(
          commandPolicy.ensureContextHandoff({
            commandId: command.commandId,
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
            strategy:
              targetProviderThread === undefined || requiresFullProviderSwitchContext
                ? "full_thread_summary"
                : "delta_context",
          }),
        );
      }
      const providerSwitchHandoff =
        providerSwitchTransferId === null || latestCompletedRun === undefined
          ? null
          : yield* contextHandoffService
              .prepareProviderHandoff({
                threadId: command.threadId,
                targetRunId: runId,
                transferId: providerSwitchTransferId,
                fromProviderThreadIds: Array.from(
                  new Set(
                    providerSwitchCoveredRuns.flatMap((run) =>
                      run.providerThreadId === null ? [] : [run.providerThreadId],
                    ),
                  ),
                ),
                toProviderThreadId: ensuredProviderThread.id,
                fromProviderInstanceId: latestCompletedRun.providerInstanceId,
                toProviderInstanceId: modelSelection.instanceId,
                coveredRunOrdinals: {
                  from: providerSwitchCoveredRuns[0]!.ordinal,
                  to: providerSwitchCoveredRuns.at(-1)!.ordinal,
                },
                strategy:
                  targetProviderThread === undefined || requiresFullProviderSwitchContext
                    ? "full_thread_summary"
                    : "delta_since_target_last_seen",
                items: providerSwitchItems,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
      const providerThread: OrchestrationV2ProviderThread = {
        ...ensuredProviderThread,
        status: "active",
        firstRunOrdinal: ensuredProviderThread.firstRunOrdinal ?? ordinal,
        lastRunOrdinal: ordinal,
        handoffIds: [
          ...ensuredProviderThread.handoffIds,
          ...[portableForkHandoff, providerSwitchHandoff].flatMap((handoff) =>
            handoff === null ? [] : [handoff.id],
          ),
        ],
        updatedAt: now,
      };

      const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const rootNodeId = idAllocator.derive.rootNode({ runId });
      const emitEvent = emit(events, command);
      const mergeBackSourceProjection =
        pendingMergeBackTransfer === undefined
          ? null
          : yield* projectionStore
              .getThreadProjection(pendingMergeBackTransfer.sourceThreadId)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorProjectionError({
                      threadId: pendingMergeBackTransfer.sourceThreadId,
                      cause,
                    }),
                ),
              );
      const mergeBackSourceRun =
        pendingMergeBackTransfer?.sourcePoint.runId === undefined ||
        mergeBackSourceProjection === null
          ? null
          : (mergeBackSourceProjection.runs.find(
              (candidate) => candidate.id === pendingMergeBackTransfer.sourcePoint.runId,
            ) ?? null);
      if (pendingMergeBackTransfer !== undefined && mergeBackSourceRun === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source run.`,
        });
      }
      const mergeBackSourceProviderThread =
        mergeBackSourceProjection === null || mergeBackSourceRun === null
          ? undefined
          : providerThreadForRun(mergeBackSourceProjection, mergeBackSourceRun);
      if (pendingMergeBackTransfer !== undefined && mergeBackSourceProviderThread === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source provider thread.`,
        });
      }
      if (pendingMergeBackTransfer !== undefined) {
        yield* enforceCommandPolicy(command)(
          commandPolicy.ensureContextHandoff({
            commandId: command.commandId,
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
            strategy: "fork_delta_context",
          }),
        );
      }
      const mergeBackDeltaItems =
        mergeBackSourceProjection === null || mergeBackSourceRun === null
          ? []
          : mergeBackSourceProjection.turnItems.filter((item) => {
              if (item.runId === null) {
                return false;
              }
              const itemRun = mergeBackSourceProjection.runs.find(
                (candidate) => candidate.id === item.runId,
              );
              return itemRun !== undefined && itemRun.ordinal <= mergeBackSourceRun.ordinal;
            });
      const mergeBackHandoff =
        pendingMergeBackTransfer === undefined ||
        mergeBackSourceProjection === null ||
        mergeBackSourceRun === null ||
        mergeBackSourceProviderThread === undefined
          ? null
          : yield* contextHandoffService
              .prepareForkDelta({
                sourceThreadId: pendingMergeBackTransfer.sourceThreadId,
                targetThreadId: command.threadId,
                targetRunId: runId,
                transferId: pendingMergeBackTransfer.id,
                fromProviderThreadIds: [mergeBackSourceProviderThread.id],
                toProviderThreadId: providerThread.id,
                fromProviderInstanceId: mergeBackSourceRun.providerInstanceId,
                toProviderInstanceId: modelSelection.instanceId,
                coveredRunOrdinals: visibleDeltaRunOrdinals(
                  mergeBackSourceProjection,
                  mergeBackDeltaItems,
                ),
                deltaItems: mergeBackDeltaItems,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
      const checkpointScope = yield* checkpointService
        .prepareRootRunScope({
          threadId: command.threadId,
          runId,
          rootNodeId,
          providerThreadId: providerThread.id,
          cwd:
            resolvedRuntimePolicy.cwd ??
            existingProviderSession?.cwd ??
            projection.thread.worktreePath ??
            process.cwd(),
          createdAt: now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );
      const run: OrchestrationV2Run = {
        id: runId,
        threadId: command.threadId,
        ordinal,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: providerThread.id,
        userMessageId: command.messageId,
        rootNodeId,
        activeAttemptId: attemptId,
        status: "starting",
        queuePosition: null,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId:
          portableForkHandoff?.id ?? providerSwitchHandoff?.id ?? mergeBackHandoff?.id ?? null,
        ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
      };
      const attempt: OrchestrationV2RunAttempt = {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      };
      const rootNode: OrchestrationV2ExecutionNode = {
        id: rootNodeId,
        threadId: command.threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: checkpointScope.id,
        startedAt: null,
        completedAt: null,
      };
      const message: OrchestrationV2ConversationMessage = {
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        id: command.messageId,
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: command.text,
        attachments: command.attachments,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      };
      const turnItem: OrchestrationV2TurnItem = {
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: ordinal * 100,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: command.messageId,
        inputIntent: "turn_start",
        text: command.text,
        attachments: command.attachments,
      };
      const activeHandoff = portableForkHandoff ?? mergeBackHandoff ?? providerSwitchHandoff;
      const handoffTurnItem: OrchestrationV2TurnItem | null =
        activeHandoff === null
          ? null
          : {
              id: idAllocator.derive.runSignalTurnItem({
                runId,
                signal: `context-handoff:${activeHandoff.id}`,
              }),
              threadId: command.threadId,
              runId,
              nodeId: rootNodeId,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: ordinal * 100 - 1,
              status: "completed",
              title:
                portableForkHandoff !== null
                  ? "Fork context"
                  : providerSwitchHandoff !== null
                    ? "Provider handoff"
                    : "Merge-back context",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "handoff",
              contextHandoffId: activeHandoff.id,
              fromProviderThreadIds: activeHandoff.fromProviderThreadIds,
              toProviderThreadId: activeHandoff.toProviderThreadId,
              fromProviderInstanceIds:
                portableForkHandoff !== null
                  ? sourceRun === null
                    ? []
                    : [sourceRun.providerInstanceId]
                  : providerSwitchHandoff === null
                    ? mergeBackSourceRun === null
                      ? []
                      : [mergeBackSourceRun.providerInstanceId]
                    : Array.from(
                        new Set(providerSwitchCoveredRuns.map((run) => run.providerInstanceId)),
                      ),
              toProviderInstanceId: modelSelection.instanceId,
              strategy: activeHandoff.strategy,
              summary: activeHandoff.summaryText,
            };
      const nativeForkResolution: OrchestrationV2ContextTransferResolution | null =
        !canResolveForkNatively || providerThread.nativeThreadRef === null
          ? null
          : {
              strategy: "native_fork",
              providerThreadRef: providerThread.nativeThreadRef,
            };
      const portableForkResolution: OrchestrationV2ContextTransferResolution | null =
        pendingForkTransfer === undefined || portableForkHandoff === null
          ? null
          : {
              strategy: "portable_context",
              contextHandoffId: portableForkHandoff.id,
            };
      const mergeBackResolution: OrchestrationV2ContextTransferResolution | null =
        pendingMergeBackTransfer === undefined || mergeBackHandoff === null
          ? null
          : {
              strategy: "fork_delta_context",
              contextHandoffId: mergeBackHandoff.id,
            };

      if (pendingForkTransfer !== undefined && canResolveForkNatively) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...pendingForkTransfer,
            targetProviderInstanceId: modelSelection.instanceId,
            targetRunId: runId,
            status: "pending",
            resolution: null,
            error: null,
            updatedAt: now,
          },
        });
      }
      if (pendingForkTransfer !== undefined && portableForkResolution !== null) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...pendingForkTransfer,
            targetProviderInstanceId: modelSelection.instanceId,
            targetRunId: runId,
            status: "resolved_portable",
            resolution: portableForkResolution,
            error: null,
            updatedAt: now,
          },
        });
      }
      yield* emitEvent({
        type: "provider-thread.updated",
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: providerThread,
      });
      if (portableForkHandoff !== null) {
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: portableForkHandoff,
        });
      }
      if (
        providerSwitchTransferId !== null &&
        providerSwitchHandoff !== null &&
        latestCompletedRun !== undefined
      ) {
        const transfer: OrchestrationV2ContextTransfer = {
          id: providerSwitchTransferId,
          type: "provider_handoff",
          sourceThreadId: command.threadId,
          targetThreadId: command.threadId,
          sourcePoint: contextSourcePointForRun(projection, latestCompletedRun),
          basePoint:
            requiresFullProviderSwitchContext ||
            targetProviderThread?.lastRunOrdinal === null ||
            targetProviderThread?.lastRunOrdinal === undefined
              ? null
              : (() => {
                  const baseRun = projection.runs.find(
                    (run) => run.ordinal === targetProviderThread.lastRunOrdinal,
                  );
                  return baseRun === undefined
                    ? null
                    : contextSourcePointForRun(projection, baseRun);
                })(),
          sourceProviderInstanceId: latestCompletedRun.providerInstanceId,
          targetProviderInstanceId: modelSelection.instanceId,
          targetRunId: runId,
          status: "consumed",
          resolution: {
            strategy:
              providerSwitchHandoff.strategy === "full_thread_summary"
                ? "portable_context"
                : "delta_context",
            contextHandoffId: providerSwitchHandoff.id,
          },
          createdBy: command.createdBy,
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: now,
        };
        yield* emitEvent({
          type: "context-transfer.created",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: transfer,
        });
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: providerSwitchHandoff,
        });
      }
      if (mergeBackHandoff !== null) {
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: mergeBackHandoff,
        });
      }
      for (const supersededTransfer of supersededMergeBackTransfers) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...supersededTransfer,
            status: "superseded",
            error:
              pendingMergeBackTransfer === undefined
                ? "Superseded while consuming merge-back transfer."
                : `Superseded by merge-back transfer ${pendingMergeBackTransfer.id}.`,
            updatedAt: now,
          },
        });
      }
      if (pendingMergeBackTransfer !== undefined && mergeBackResolution !== null) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...pendingMergeBackTransfer,
            targetProviderInstanceId: modelSelection.instanceId,
            targetRunId: runId,
            status: "consumed",
            resolution: mergeBackResolution,
            error: null,
            updatedAt: now,
            consumedAt: now,
          },
        });
      }
      yield* emitEvent({
        type: "run.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: run,
      });
      yield* completeSourcePlan(now);
      yield* emitEvent({
        type: "run-attempt.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: attempt,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: rootNode,
      });
      yield* emitEvent({
        type: "checkpoint-scope.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: yield* checkpointService.ensureScope(checkpointScope).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        ),
      });
      if (handoffTurnItem !== null) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: handoffTurnItem,
        });
      }
      yield* emitEvent({
        type: "message.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: message,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: turnItem,
      });
      const forkResolution = nativeForkResolution ?? portableForkResolution;
      if (pendingForkTransfer !== undefined && forkResolution !== null) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...pendingForkTransfer,
            targetProviderInstanceId: modelSelection.instanceId,
            targetRunId: runId,
            status: "consumed",
            resolution: forkResolution,
            error: null,
            updatedAt: now,
            consumedAt: now,
          },
        });
      }

      const pendingEffect = {
        id: `effect:${command.commandId}:provider-turn.start:${runId}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: { type: "provider-turn.start", runId },
      } satisfies PendingOrchestrationEffectV2;
      yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
    });

  const dispatchDelegatedTaskRequest = Effect.fn("orchestrationV2.dispatch.delegatedTaskRequest")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const parentProjection = yield* projectionStore
        .getThreadProjection(command.parentThreadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.parentThreadId,
                cause,
              }),
          ),
        );
      const parentRun = parentProjection.runs.find(
        (candidate) => candidate.id === command.parentRunId,
      );
      if (parentRun === undefined || !isBlockingRun(parentRun)) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent run ${command.parentRunId} is not active.`,
        });
      }
      const parentNode = parentProjection.nodes.find(
        (candidate) => candidate.id === command.parentNodeId,
      );
      if (
        parentNode === undefined ||
        parentNode.runId !== parentRun.id ||
        parentRun.rootNodeId === null
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent node ${command.parentNodeId} is not part of active run ${parentRun.id}.`,
        });
      }

      const targetAdapter = yield* providerAdapters.get(command.modelSelection.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: command.modelSelection.instanceId,
              cause,
            }),
        ),
      );

      const now = command.createdAt ?? (yield* DateTime.now);
      const taskNodeId = idAllocator.derive.delegatedTaskNode({
        commandId: command.commandId,
      });
      const childThreadId = idAllocator.derive.delegatedTaskThread({
        commandId: command.commandId,
      });
      const childMessageId = idAllocator.derive.delegatedTaskMessage({
        commandId: command.commandId,
      });
      const taskTurnItemId = idAllocator.derive.delegatedTaskTurnItem({
        commandId: command.commandId,
      });
      const taskTitle = subagentThreadTitle({
        parentTitle: parentProjection.thread.title,
        prompt: command.task,
        ...(command.title === undefined ? {} : { title: command.title }),
        ordinal: parentProjection.subagents.length + 1,
      });
      const childThread: OrchestrationV2AppThread = {
        ...makeSubagentChildThread({
          parentThread: parentProjection.thread,
          childThreadId,
          parentNodeId: taskNodeId,
          activeProviderThreadId: null,
          providerInstanceId: command.modelSelection.instanceId,
          modelSelection: command.modelSelection,
          title: taskTitle,
          now,
          createdBy: command.createdBy,
          creationSource: command.creationSource,
        }),
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
      };
      const task: OrchestrationV2Subagent = {
        id: taskNodeId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        parentNodeId: command.parentNodeId,
        origin: "app_owned",
        createdBy: command.createdBy,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: command.task,
        title: command.title ?? null,
        model: command.modelSelection.model,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const taskNode: OrchestrationV2ExecutionNode = {
        id: taskNodeId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        parentNodeId: command.parentNodeId,
        rootNodeId: parentRun.rootNodeId,
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const parentProviderTurn = providerTurnForRun(parentProjection, parentRun);
      const taskTurnItem: OrchestrationV2TurnItem = {
        id: taskTurnItemId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        providerThreadId: parentRun.providerThreadId,
        providerTurnId: parentProviderTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: nextTurnItemOrdinal(parentProjection),
        status: "running",
        title: command.title ?? taskTitle,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: taskNodeId,
        origin: "app_owned",
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        childThreadId,
        prompt: command.task,
        result: null,
      };
      const emitEvent = emit(events, command);

      yield* emitEvent({
        type: "thread.created",
        threadId: childThreadId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: childThread,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: taskNode,
      });
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: task,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: taskTurnItem,
      });

      const childMessageCommand = {
        type: "message.dispatch",
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        commandId: command.commandId,
        threadId: childThreadId,
        messageId: childMessageId,
        text: command.task,
        attachments: [],
        modelSelection: command.modelSelection,
        dispatchMode: { type: "start_immediately" },
      } satisfies Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
      yield* dispatchMessage(childMessageCommand, events, effects);

      const childProjection = yield* getProjectionWithPendingEvents(childThreadId, events);
      const childRun = childProjection.runs[0];
      if (childRun === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Delegated child thread ${childThreadId} did not create a run.`,
        });
      }
      const spawnTransferId = yield* mapDispatchError(command)(
        idAllocator.allocate.contextTransfer({
          sourceThreadId: command.parentThreadId,
          targetThreadId: childThreadId,
          type: "subagent_spawn",
        }),
      );
      const spawnTransfer: OrchestrationV2ContextTransfer = {
        id: spawnTransferId,
        type: "subagent_spawn",
        sourceThreadId: command.parentThreadId,
        targetThreadId: childThreadId,
        sourcePoint: {
          ...contextSourcePointForRun(parentProjection, parentRun),
          turnItemId: taskTurnItemId,
        },
        basePoint: null,
        sourceProviderInstanceId: parentRun.providerInstanceId,
        targetProviderInstanceId: command.modelSelection.instanceId,
        targetRunId: childRun.id,
        status: "consumed",
        resolution: null,
        createdBy: command.createdBy,
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };
      yield* emitEvent({
        type: "context-transfer.created",
        threadId: childThreadId,
        runId: childRun.id,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: spawnTransfer,
      });
    },
  );

  const dispatchCreatedThreadRecord = Effect.fn("orchestrationV2.dispatch.createdThreadRecord")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "thread.created.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const parentProjection = yield* projectionStore
        .getThreadProjection(command.parentThreadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.parentThreadId,
                cause,
              }),
          ),
        );
      const targetProjection = yield* projectionStore
        .getThreadProjection(command.targetThreadId)
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
        id: idAllocator.derive.createdThreadTurnItem({ commandId: command.commandId }),
        threadId: command.parentThreadId,
        runId: command.parentRunId,
        nodeId: command.parentNodeId,
        providerThreadId: parentRun.providerThreadId,
        providerTurnId: parentProviderTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: nextTurnItemOrdinal(parentProjection),
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

      yield* emit(
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

  const dispatchRuntimeRequestRespond = (
    command: Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getThreadProjection(command.threadId)
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      const runtimeRequest = projection.runtimeRequests.find(
        (candidate) => candidate.id === command.requestId,
      );
      if (runtimeRequest === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Runtime request ${command.requestId} was not found.`,
        });
      }
      if (runtimeRequest.status !== "pending") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Runtime request ${command.requestId} is ${runtimeRequest.status}.`,
        });
      }
      if (runtimeRequest.responseCapability.type !== "live") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: runtimeRequest.responseCapability.reason,
        });
      }
      const providerSessionId = runtimeRequest.responseCapability.providerSessionId;

      const providerSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      if (providerSession === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider session ${providerSessionId} was not found.`,
        });
      }

      const now = yield* DateTime.now;
      const resolvedRequest = {
        ...runtimeRequest,
        status: "resolved" as const,
        resolvedAt: now,
      };
      const emitEvent = emit(events, command);
      const requestNode = projection.nodes.find((node) => node.id === runtimeRequest.nodeId);
      const resolvedNodeStatus =
        command.decision === "decline" || command.decision === "cancel"
          ? ("cancelled" as const)
          : ("completed" as const);
      yield* emitEvent({
        type: "runtime-request.updated",
        threadId: command.threadId,
        ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
        nodeId: runtimeRequest.nodeId,
        driver: providerSession.driver,
        providerInstanceId: providerSession.providerInstanceId,
        occurredAt: now,
        payload: resolvedRequest,
      });
      if (requestNode !== undefined) {
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
          nodeId: requestNode.id,
          driver: providerSession.driver,
          providerInstanceId: providerSession.providerInstanceId,
          occurredAt: now,
          payload: {
            ...requestNode,
            status: resolvedNodeStatus,
            completedAt: now,
          },
        });
      }

      const approvalTurnItem = projection.turnItems.find(
        (item) =>
          (item.type === "approval_request" || item.type === "user_input_request") &&
          item.requestId === command.requestId,
      );
      if (approvalTurnItem !== undefined) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          ...(approvalTurnItem.runId === null ? {} : { runId: approvalTurnItem.runId }),
          ...(approvalTurnItem.nodeId === null ? {} : { nodeId: approvalTurnItem.nodeId }),
          driver: providerSession.driver,
          providerInstanceId: providerSession.providerInstanceId,
          occurredAt: now,
          payload: {
            ...approvalTurnItem,
            status: resolvedNodeStatus,
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:runtime-request.respond:${command.requestId}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "runtime-request.respond",
            providerSessionId,
            requestId: command.requestId,
            ...(command.decision === undefined ? {} : { decision: command.decision }),
            ...(command.answers === undefined ? {} : { answers: command.answers }),
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });

  const dispatchQueuedMessagePromoteToSteer = (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-message.promote-to-steer" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getThreadProjection(command.threadId)
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      const queuedRun = projection.runs.find((candidate) => candidate.id === command.queuedRunId);
      if (queuedRun === undefined || queuedRun.status !== "queued") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Queued run ${command.queuedRunId} is not queued.`,
        });
      }
      const queuedRootNode =
        queuedRun.rootNodeId === null
          ? undefined
          : projection.nodes.find((candidate) => candidate.id === queuedRun.rootNodeId);
      const queuedAttempt =
        queuedRun.activeAttemptId === null
          ? undefined
          : projection.attempts.find((candidate) => candidate.id === queuedRun.activeAttemptId);
      const queuedMessage = projection.messages.find(
        (candidate) => candidate.id === queuedRun.userMessageId,
      );
      if (
        queuedRootNode === undefined ||
        queuedAttempt === undefined ||
        queuedMessage === undefined
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Queued run ${queuedRun.id} is missing message or execution state.`,
        });
      }

      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...queuedRun,
          status: "cancelled",
          queuePosition: null,
          completedAt: now,
        },
      });
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...queuedAttempt,
          status: "cancelled",
          completedAt: now,
        },
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...queuedRootNode,
          status: "cancelled",
          completedAt: now,
        },
      });

      yield* dispatchSteerIntoRun({
        command,
        events,
        effects,
        projection,
        modelSelection: projection.thread.modelSelection,
        targetRunId: command.targetRunId,
        messageId: queuedMessage.id,
        text: queuedMessage.text,
        attachments: queuedMessage.attachments,
        createdBy: queuedMessage.createdBy,
        creationSource: queuedMessage.creationSource,
        forceRestart: false,
      });
    });

  const dispatchQueuedRunReorder = (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.reorder" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getThreadProjection(command.threadId)
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      const queuedRuns = projection.runs
        .filter((run) => run.status === "queued")
        .toSorted(
          (left, right) =>
            (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
            left.ordinal - right.ordinal,
        );
      const moving = queuedRuns.find((run) => run.id === command.runId);
      if (moving === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not queued.`,
        });
      }
      const withoutMoving = queuedRuns.filter((run) => run.id !== command.runId);
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
        ...withoutMoving.slice(0, beforeIndex),
        moving,
        ...withoutMoving.slice(beforeIndex),
      ];
      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
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

  const loadProjectionForCommand = (command: OrchestrationV2Command) =>
    projectionStore
      .getThreadProjection(commandThreadId(command))
      .pipe(
        Effect.mapError(
          () => new OrchestratorProjectionError({ threadId: commandThreadId(command) }),
        ),
      );

  const preparedRunState = (
    command: Extract<
      OrchestrationV2Command,
      {
        readonly type: "prepared-run.release" | "prepared-run.progress" | "prepared-run.fail";
      }
    >,
    projection: OrchestrationV2ThreadProjection,
  ) => {
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    const attempt = projection.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
    const rootNode = projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run?.providerThreadId,
    );
    const preparationItem = projection.turnItems.find(
      (
        candidate,
      ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
        candidate.runId === command.runId &&
        candidate.type === "command_execution" &&
        candidate.input === WORKSPACE_PREPARATION_INPUT,
    );
    if (
      run?.status !== "preparing" ||
      attempt === undefined ||
      rootNode === undefined ||
      providerThread === undefined ||
      preparationItem === undefined
    ) {
      return null;
    }
    return { run, attempt, rootNode, providerThread, preparationItem } as const;
  };

  const dispatchPreparedRunProgress = (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.progress" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(command);
      const state = preparedRunState(command, projection);
      if (state === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not awaiting workspace preparation.`,
        });
      }
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...state.preparationItem,
          title: command.phase === "worktree" ? "Preparing worktree" : "Starting setup script",
          updatedAt: now,
        },
      });
    });

  const dispatchPreparedRunRelease = (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.release" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(command);
      const state = preparedRunState(command, projection);
      if (state === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not awaiting workspace preparation.`,
        });
      }
      const now = yield* DateTime.now;
      const resolvedRuntimePolicy = yield* runtimePolicy
        .resolve({ thread: projection.thread, modelSelection: state.run.modelSelection })
        .pipe(mapDispatchError(command));
      const checkpointScope = yield* checkpointService
        .prepareRootRunScope({
          threadId: command.threadId,
          runId: state.run.id,
          rootNodeId: state.rootNode.id,
          providerThreadId: state.providerThread.id,
          cwd: resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
          createdAt: now,
        })
        .pipe(mapDispatchError(command));
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "checkpoint-scope.created",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: checkpointScope,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.rootNode, checkpointScopeId: checkpointScope.id },
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...state.preparationItem,
          status: "completed",
          title: "Workspace ready",
          output: "Workspace preparation completed.",
          exitCode: 0,
          completedAt: now,
          updatedAt: now,
        },
      });
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.run, status: "starting" },
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-turn.start:${state.run.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "provider-turn.start", runId: state.run.id },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });

  const dispatchPreparedRunFail = (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.fail" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(command);
      const state = preparedRunState(command, projection);
      if (state === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not awaiting workspace preparation.`,
        });
      }
      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.attempt, status: "failed", completedAt: now },
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.rootNode, status: "failed", completedAt: now },
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...state.preparationItem,
          status: "failed",
          title: "Workspace preparation failed",
          output: command.failure.message,
          exitCode: 1,
          completedAt: now,
          updatedAt: now,
        },
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: state.providerThread.driver,
            nativeItemId: `workspace-preparation-failure:${state.run.id}`,
          }),
          threadId: command.threadId,
          runId: state.run.id,
          nodeId: state.rootNode.id,
          providerThreadId: state.providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: nextTurnItemOrdinal(projection),
          status: "failed",
          title: "Workspace preparation failed",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure: command.failure,
        },
      });
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.run, status: "failed", completedAt: now },
      });
    });

  const dispatchRunInterrupt = (
    command: Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(command);
      const run = projection.runs.find((candidate) => candidate.id === command.runId);
      const rootNode =
        run?.rootNodeId === null
          ? undefined
          : projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
      const providerThread =
        run?.providerThreadId === null
          ? undefined
          : projection.providerThreads.find((candidate) => candidate.id === run?.providerThreadId);
      const providerTurn = projection.providerTurns.find(
        (candidate) =>
          candidate.runAttemptId === run?.activeAttemptId && candidate.status === "running",
      );
      if (run === undefined || rootNode === undefined || providerThread === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not interruptible.`,
        });
      }

      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      const interruptRequestItem: OrchestrationV2TurnItem = {
        id: idAllocator.derive.runSignalTurnItem({
          runId: run.id,
          signal: "interrupt-request",
        }),
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerThreadId: providerThread.id,
        providerTurnId: providerTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: nextTurnItemOrdinal(projection),
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: command.reason ?? "Interrupt requested",
      };

      if (
        providerTurn === undefined &&
        (run.status === "preparing" || run.status === "starting" || run.status === "running")
      ) {
        const attempt = projection.attempts.find(
          (candidate) => candidate.id === run.activeAttemptId,
        );
        if (attempt === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Run ${command.runId} has no active attempt to interrupt.`,
          });
        }
        const interruptResultItem: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({
            runId: run.id,
            signal: "interrupt-result",
          }),
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: interruptRequestItem.id,
          ordinal: interruptRequestItem.ordinal + 1,
          status: "interrupted",
          title: "Interrupted",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "run_interrupt_result",
          message: "Run interrupted before provider start",
        };
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: interruptRequestItem,
        });
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: interruptResultItem,
        });
        const preparationItem = projection.turnItems.find(
          (
            candidate,
          ): candidate is Extract<
            OrchestrationV2TurnItem,
            { readonly type: "command_execution" }
          > =>
            candidate.runId === run.id &&
            candidate.type === "command_execution" &&
            candidate.input === WORKSPACE_PREPARATION_INPUT &&
            candidate.status === "running",
        );
        if (preparationItem !== undefined) {
          yield* emitEvent({
            type: "turn-item.updated",
            threadId: command.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              ...preparationItem,
              status: "interrupted",
              title: "Workspace preparation interrupted",
              output: command.reason ?? "Interrupted before provider start",
              completedAt: now,
              updatedAt: now,
            },
          });
        }
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...attempt, status: "interrupted", completedAt: now },
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...rootNode, status: "interrupted", completedAt: now },
        });
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        });
        return {
          effectTypes: ["provider-turn.start", "provider-turn.restart"],
          reason: `Run ${run.id} was interrupted before its provider turn started.`,
        } satisfies {
          readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
          readonly reason: string;
        };
      }

      if (providerTurn === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not interruptible.`,
        });
      }
      if (providerThread.providerSessionId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider thread ${providerThread.id} has no active provider session.`,
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      const sessionOption = yield* providerSessions.get(providerSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: run.providerInstanceId,
              cause,
            }),
        ),
      );
      if (Option.isNone(sessionOption)) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider session ${providerThread.providerSessionId} is not active.`,
        });
      }
      yield* enforceCommandPolicy(command)(
        commandPolicy.ensureInterrupt({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: run.providerInstanceId,
          capabilities: sessionOption.value.providerSession.capabilities,
        }),
      );

      /*
       * TODO(interrupt-hardening): before shipping, make these interrupt
       * semantics explicit in tests and policy.
       *
       * Current behavior:
       * - emit a `run_interrupt_request` item as user intent;
       * - call the provider interrupt RPC;
       * - keep the run active and continue ingesting provider chunks;
       * - let RunExecutionService emit `run_interrupt_result` only if the
       *   provider later reports terminal status `interrupted`.
       *
       * Known scenarios we do not fully harden yet:
       * - provider accepts interrupt, then emits more chunks before terminal;
       * - provider accepts interrupt, then completes normally instead;
       * - provider accepts interrupt but never terminalizes;
       * - user queues, steers, or starts another message while the interrupted
       *   provider turn is still active.
       *
       * Likely policy:
       * - queue should wait behind the still-active provider turn;
       * - explicit steer may target the active turn if provider steering is
       *   supported;
       * - starting a new root turn before provider terminalization should be
       *   an explicit policy decision because it can weaken native-item
       *   correlation.
       */
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: interruptRequestItem,
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-turn.interrupt:${providerTurn.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-turn.interrupt",
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
      return undefined;
    });

  const dispatchCheckpointRollback = (
    command: Extract<OrchestrationV2Command, { readonly type: "checkpoint.rollback" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(command);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      );
      if (providerThread === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "No active provider thread exists for rollback.",
        });
      }
      if (providerThread.providerSessionId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider thread ${providerThread.id} has no provider session.`,
        });
      }

      const modelSelection = projection.thread.modelSelection;
      const capabilities = yield* providerAdapters.get(modelSelection.instanceId).pipe(
        Effect.flatMap((adapter) => adapter.getCapabilities()),
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: modelSelection.instanceId,
              cause,
            }),
        ),
      );
      yield* enforceCommandPolicy(command)(
        commandPolicy.ensureRollback({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          capabilities,
        }),
      );

      const targetCheckpoint = projection.checkpoints.find(
        (candidate) => candidate.id === command.checkpointId,
      );
      if (targetCheckpoint === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} was not found.`,
        });
      }
      const targetScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === targetCheckpoint.scopeId,
      );
      if (targetScope === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint scope ${targetCheckpoint.scopeId} was not found.`,
        });
      }
      if (targetScope.id !== command.scopeId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} belongs to scope ${targetScope.id}, not ${command.scopeId}.`,
        });
      }
      const targetOrdinal = targetCheckpoint.appRunOrdinal ?? 0;
      if (targetOrdinal > 0) {
        const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
        const targetProviderTurn =
          targetRun === undefined ? undefined : providerTurnForRun(projection, targetRun);
        if (targetRun === undefined || targetProviderTurn === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Cannot roll back to checkpoint ${targetCheckpoint.id}: its provider turn is unavailable.`,
          });
        }
        if (targetProviderTurn.providerThreadId !== providerThread.id) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Cannot roll back provider thread ${providerThread.id} to checkpoint ${targetCheckpoint.id}: target provider turn ${targetProviderTurn.id} belongs to provider thread ${targetProviderTurn.providerThreadId}.`,
          });
        }
      }

      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "checkpoint.rollback-requested",
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          scopeId: targetScope.id,
          checkpointId: targetCheckpoint.id,
          requestedAt: now,
        },
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-thread.rollback:${providerThread.id}:${targetCheckpoint.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-thread.rollback",
            providerThreadId: providerThread.id,
            checkpointId: targetCheckpoint.id,
            scopeId: targetScope.id,
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });

  const finalizeAppOwnedSubagent = (childThreadId: ThreadId) =>
    Effect.gen(function* () {
      const childProjection = yield* projectionStore.getThreadProjection(childThreadId);
      const forkedFrom = childProjection.thread.forkedFrom;
      if (
        childProjection.thread.lineage.relationshipToParent !== "subagent" ||
        childProjection.thread.lineage.parentThreadId === null ||
        forkedFrom?.type !== "node"
      ) {
        return;
      }
      const childRun = childProjection.runs[0];
      if (childRun === undefined) {
        return;
      }
      const terminalStatus = delegatedTaskTerminalStatus(childRun.status);
      if (terminalStatus === null) {
        return;
      }

      const parentThreadId = childProjection.thread.lineage.parentThreadId;
      const parentProjection = yield* projectionStore.getThreadProjection(parentThreadId);
      const task = parentProjection.subagents.find(
        (candidate) =>
          candidate.id === forkedFrom.nodeId &&
          candidate.origin === "app_owned" &&
          candidate.childThreadId === childThreadId,
      );
      if (task === undefined) {
        return;
      }
      const existingResultTransfer = parentProjection.contextTransfers.find(
        (transfer) =>
          transfer.type === "subagent_result" &&
          transfer.sourceThreadId === childThreadId &&
          transfer.targetThreadId === parentThreadId,
      );
      if (existingResultTransfer !== undefined) {
        return;
      }

      const now = yield* DateTime.now;
      const result = subagentResultForRun(childProjection, childRun);
      const parentRun =
        task.runId === null
          ? undefined
          : parentProjection.runs.find((candidate) => candidate.id === task.runId);
      const parentNode = parentProjection.nodes.find((candidate) => candidate.id === task.id);
      const parentTurnItem = parentProjection.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
      );
      const updatedTask: OrchestrationV2Subagent = {
        ...task,
        providerThreadId: childRun.providerThreadId,
        status: terminalStatus,
        result: result.text,
        completedAt: now,
        updatedAt: now,
      };
      const resultTransferId = yield* idAllocator.allocate.contextTransfer({
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        type: "subagent_result",
      });
      const childProviderThread =
        childRun.providerThreadId === null
          ? undefined
          : childProjection.providerThreads.find(
              (candidate) => candidate.id === childRun.providerThreadId,
            );
      const parentProviderThread =
        parentRun?.providerThreadId === null || parentRun?.providerThreadId === undefined
          ? undefined
          : parentProjection.providerThreads.find(
              (candidate) => candidate.id === parentRun.providerThreadId,
            );
      const resultHandoff: OrchestrationV2ContextHandoff | null =
        parentRun === undefined ||
        childProviderThread === undefined ||
        parentProviderThread === undefined
          ? null
          : {
              id: yield* idAllocator.allocate.contextHandoff({
                threadId: parentThreadId,
                fromProviderInstanceId: childRun.providerInstanceId,
                toProviderInstanceId: parentRun.providerInstanceId,
              }),
              transferId: resultTransferId,
              threadId: parentThreadId,
              targetRunId: parentRun.id,
              fromProviderThreadIds: [childProviderThread.id],
              toProviderThreadId: parentProviderThread.id,
              coveredRunOrdinals: {
                from: childRun.ordinal,
                to: childRun.ordinal,
              },
              strategy: "manual_context",
              status: "ready",
              summaryMessageId: result.messageId,
              summaryText: result.text,
              createdByProviderInstanceId: childRun.providerInstanceId,
              createdAt: now,
              updatedAt: now,
            };
      const resultTransfer: OrchestrationV2ContextTransfer = {
        id: resultTransferId,
        type: "subagent_result",
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        sourcePoint: {
          ...contextSourcePointForRun(childProjection, childRun),
          ...(result.turnItemId === null ? {} : { turnItemId: result.turnItemId }),
        },
        basePoint: null,
        sourceProviderInstanceId: childRun.providerInstanceId,
        targetProviderInstanceId:
          parentRun?.providerInstanceId ?? parentProjection.thread.providerInstanceId,
        targetRunId: parentRun?.id ?? null,
        status: "consumed",
        resolution:
          resultHandoff === null
            ? null
            : {
                strategy: "portable_context",
                contextHandoffId: resultHandoff.id,
              },
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };

      yield* writeSystemEvents([
        {
          type: "subagent.updated",
          threadId: parentThreadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          occurredAt: now,
          payload: updatedTask,
        },
        ...(parentNode === undefined
          ? []
          : [
              {
                type: "node.updated" as const,
                threadId: parentThreadId,
                ...(parentNode.runId === null ? {} : { runId: parentNode.runId }),
                nodeId: parentNode.id,
                driver: task.driver,
                occurredAt: now,
                payload: {
                  ...parentNode,
                  status: terminalStatus,
                  providerThreadId: childRun.providerThreadId,
                  completedAt: now,
                },
              },
            ]),
        ...(parentTurnItem === undefined
          ? []
          : [
              {
                type: "turn-item.updated" as const,
                threadId: parentThreadId,
                ...(parentTurnItem.runId === null ? {} : { runId: parentTurnItem.runId }),
                ...(parentTurnItem.nodeId === null ? {} : { nodeId: parentTurnItem.nodeId }),
                driver: task.driver,
                occurredAt: now,
                payload: {
                  ...parentTurnItem,
                  status: terminalStatus,
                  result: result.text,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ]),
        ...(resultHandoff === null
          ? []
          : [
              {
                type: "context-handoff.updated" as const,
                threadId: parentThreadId,
                ...(parentRun === undefined ? {} : { runId: parentRun.id }),
                providerInstanceId: childRun.providerInstanceId,
                occurredAt: now,
                payload: resultHandoff,
              },
            ]),
        {
          type: "context-transfer.created",
          threadId: parentThreadId,
          ...(parentRun === undefined ? {} : { runId: parentRun.id }),
          providerInstanceId: childRun.providerInstanceId,
          occurredAt: now,
          payload: resultTransfer,
        },
      ]);
    });

  const dispatchUnsupported = (command: OrchestrationV2Command) =>
    Effect.fail(
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
      }),
    );

  const dispatchOnce = Effect.fn("orchestrationV2.dispatch.once")(function* (
    command: OrchestrationV2Command,
  ): Effect.fn.Return<
    {
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      readonly cancelUnsettledEffects?: {
        readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
        readonly reason: string;
      };
    },
    OrchestratorV2Error
  > {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.thread_id": commandThreadId(command),
    });

    const events = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    const effects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
    let cancelUnsettledEffects:
      | {
          readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
          readonly reason: string;
        }
      | undefined;
    switch (command.type) {
      case "thread.create":
        yield* dispatchThreadCreate(command, events);
        break;
      case "thread.archive":
      case "thread.unarchive":
      case "thread.delete":
      case "thread.metadata.update":
      case "thread.runtime-mode.set":
      case "thread.interaction-mode.set":
      case "thread.model-selection.set":
      case "provider.switch":
        yield* dispatchThreadMutation(command, events, effects);
        break;
      case "provider-session.detach":
        yield* dispatchProviderSessionDetach(command, events, effects);
        break;
      case "message.dispatch":
        yield* dispatchMessage(command, events, effects);
        break;
      case "prepared-run.release":
        yield* dispatchPreparedRunRelease(command, events, effects);
        break;
      case "prepared-run.progress":
        yield* dispatchPreparedRunProgress(command, events);
        break;
      case "prepared-run.fail":
        yield* dispatchPreparedRunFail(command, events);
        break;
      case "runtime-request.respond":
        yield* dispatchRuntimeRequestRespond(command, events, effects);
        break;
      case "run.interrupt":
        cancelUnsettledEffects = yield* dispatchRunInterrupt(command, events, effects);
        break;
      case "queued-message.promote-to-steer":
        yield* dispatchQueuedMessagePromoteToSteer(command, events, effects);
        break;
      case "queued-run.reorder":
        yield* dispatchQueuedRunReorder(command, events);
        break;
      case "checkpoint.rollback":
        yield* dispatchCheckpointRollback(command, events, effects);
        break;
      case "thread.fork":
        yield* dispatchThreadFork(command, events);
        break;
      case "thread.merge_back":
        yield* dispatchThreadMergeBack(command, events);
        break;
      case "delegated_task.request":
        yield* dispatchDelegatedTaskRequest(command, events, effects);
        break;
      case "thread.created.record":
        yield* dispatchCreatedThreadRecord(command, events);
        break;
      default:
        return yield* dispatchUnsupported(command);
    }
    return {
      events: yield* Ref.get(events),
      effects: yield* Ref.get(effects),
      ...(cancelUnsettledEffects === undefined ? {} : { cancelUnsettledEffects }),
    };
  });

  const dispatchWithReceiptEffect = Effect.fn("orchestrationV2.dispatch.withReceipt")(function* (
    command: OrchestrationV2Command,
  ): Effect.fn.Return<OrchestratorV2DispatchResult, OrchestratorV2Error> {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.thread_id": commandThreadId(command),
    });

    const existingReceipt = yield* commandReceipts.getByCommandId(command.commandId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );

    if (Option.isSome(existingReceipt)) {
      const receipt = existingReceipt.value;
      if (receipt.status === "rejected") {
        return yield* new OrchestratorCommandPreviouslyRejectedError({
          commandId: command.commandId,
          commandType: command.type,
          detail: receipt.error ?? "Previously rejected.",
        });
      }
      const storedEvents = yield* eventSink.readByCommandId({ commandId: command.commandId }).pipe(
        Stream.runCollect,
        Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );
      return {
        sequence: receipt.resultSequence,
        storedEvents,
      } satisfies OrchestratorV2DispatchResult;
    }

    const plan = yield* dispatchOnce(command).pipe(
      Effect.flatMap((planned) =>
        planned.events.length > 0
          ? Effect.succeed(planned)
          : Effect.fail(
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "Command produced no domain events.",
              }),
            ),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const rejectedAt = yield* DateTime.now;
          yield* eventSink
            .commitRejectedCommand({
              commandId: command.commandId,
              threadId: commandThreadId(command),
              commandType: command.type,
              rejectedAt,
              error: cause instanceof Error ? cause.message : String(cause),
            })
            .pipe(
              Effect.mapError(
                (receiptCause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: receiptCause,
                  }),
              ),
            );
          return yield* cause;
        }),
      ),
    );

    const acceptedAt = plan.events.at(-1)?.occurredAt ?? (yield* DateTime.now);
    const committed = yield* eventSink
      .commitCommand({
        commandId: command.commandId,
        threadId: commandThreadId(command),
        commandType: command.type,
        acceptedAt,
        events: plan.events,
        effects: plan.effects,
        ...(plan.cancelUnsettledEffects === undefined
          ? {}
          : { cancelUnsettledEffects: plan.cancelUnsettledEffects }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

    if (committed.receipt.status === "rejected") {
      return yield* new OrchestratorCommandPreviouslyRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        detail: committed.receipt.error ?? "Previously rejected.",
      });
    }

    return {
      sequence: committed.receipt.resultSequence,
      storedEvents: committed.storedEvents,
    } satisfies OrchestratorV2DispatchResult;
  });

  const dispatchWithReceipt = (command: OrchestrationV2Command) =>
    threadDispatch.withLock(commandThreadId(command), dispatchWithReceiptEffect(command));

  yield* eventSink.stream().pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "run.updated" &&
        !String(stored.commandId).startsWith("command:runtime-reconcile:") &&
        (stored.event.payload.status === "completed" ||
          stored.event.payload.status === "interrupted" ||
          stored.event.payload.status === "failed" ||
          stored.event.payload.status === "cancelled" ||
          stored.event.payload.status === "rolled_back"),
    ),
    Stream.runForEach((stored) =>
      threadDispatch
        .withLock(
          stored.event.threadId,
          finalizeAppOwnedSubagent(stored.event.threadId).pipe(
            Effect.andThen(startNextQueuedRun(stored.event.threadId)),
          ),
        )
        .pipe(Effect.catchCause(() => Effect.void)),
    ),
    Effect.forkDetach,
  );

  return OrchestratorV2.of({
    resumeQueuedRuns,
    dispatch: dispatchWithReceipt,
    getThreadProjection: (threadId) =>
      projectionStore
        .getThreadProjection(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getThreadSnapshot: (threadId) =>
      projectionStore
        .getThreadSnapshot(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getShellSnapshot: () =>
      projectionStore.getShellSnapshot().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: ThreadId.make("thread:shell"),
              cause,
            }),
        ),
      ),
    getThreadEventSequence: (threadId) =>
      eventSink
        .latestSequence({ threadId })
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    streamStoredEvents: eventSink.stream().pipe(
      Stream.mapError(
        (cause) =>
          new OrchestratorDomainEventStreamError({
            cause,
          }),
      ),
    ),
    streamStoredEventsFrom: (input) =>
      eventSink.stream(input).pipe(
        Stream.mapError(
          (cause) =>
            new OrchestratorDomainEventStreamError({
              cause,
            }),
        ),
      ),
    streamDomainEvents: eventSink.stream().pipe(
      Stream.map((stored) => stored.event),
      Stream.mapError(
        (cause) =>
          new OrchestratorDomainEventStreamError({
            cause,
          }),
      ),
    ),
  });
});

export const layer: Layer.Layer<
  OrchestratorV2,
  never,
  | CheckpointServiceV2
  | CommandPolicyV2
  | CommandReceiptStoreV2
  | ContextHandoffServiceV2
  | EventSinkV2
  | IdAllocatorV2
  | ProviderAdapterRegistryV2
  | ProviderSessionManagerV2
  | ProviderSwitchServiceV2
  | ProjectionStoreV2
  | RuntimePolicyV2
  | ThreadForkServiceV2
> = Layer.effect(OrchestratorV2, makeOrchestrator());

export const layerUnavailable: Layer.Layer<OrchestratorV2> = Layer.succeed(
  OrchestratorV2,
  OrchestratorV2.of({
    resumeQueuedRuns: Effect.fail(
      new OrchestratorDispatchError({
        commandId: CommandId.make("command:system:resume-queued-runs"),
        commandType: "message.dispatch",
        cause: "Orchestration V2 live runtime is not configured.",
      }),
    ),
    dispatch: (command) =>
      Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadProjection: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadSnapshot: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getShellSnapshot: () =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId: ThreadId.make("thread:shell"),
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadEventSequence: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    streamStoredEvents: Stream.fail(
      new OrchestratorDomainEventStreamError({
        cause: "Orchestration V2 live runtime is not configured.",
      }),
    ),
    streamStoredEventsFrom: () =>
      Stream.fail(
        new OrchestratorDomainEventStreamError({
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    streamDomainEvents: Stream.fail(
      new OrchestratorDomainEventStreamError({
        cause: "Orchestration V2 live runtime is not configured.",
      }),
    ),
  } satisfies OrchestratorV2Shape),
);
