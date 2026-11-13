import { CommandId, OrchestrationV2Command, type OrchestrationV2InternalCommand, type OrchestrationV2ServerCommand, type OrchestrationV2AppThread, type OrchestrationV2DomainEvent, type OrchestrationV2ProviderTurn, type OrchestrationV2RemoteTaskChild, type OrchestrationV2Run, type OrchestrationV2Subagent, type OrchestrationV2ThreadProjection, type OrchestrationV2TurnItem, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { releasedGuestAttachmentIds } from "../GuestShareDecider.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { WORKSPACE_PREPARATION_INPUT } from "../orchestrationMessages.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { type ProjectionRecordField, type ProjectionRecordFilter } from "../ProjectionStore.ts";
import * as RunExecutionService from "../RunExecutionService.ts";
import { OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { commandThreadId, delegatedCompletionWakeDetail } from "../orchestrationCommandQueries.ts";
import { hasLiveRun } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";
import type { DispatchSteerIntoRunPart } from "./DispatchSteerIntoRun.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart;

export const installSettleInterruptedRun = Effect.fnUntraced(function* (deps: Deps) {
  const { completionDeliveryMessage, completionDeliveryRun, effectOutbox, emit, idAllocator, mapDelegatedCompletionError, nextTurnItemOrdinal, projectionStore, stopReachedRun } = deps;

const releaseGuestAttachments = (
  command: { readonly commandId: CommandId; readonly threadId: ThreadId },
  before: OrchestrationV2AppThread["guestShare"],
  after: OrchestrationV2AppThread["guestShare"],
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) => {
  const attachmentIds = releasedGuestAttachmentIds(before ?? null, after ?? null);
  return attachmentIds.length === 0
    ? Effect.void
    : Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:guest-attachment.cleanup`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "attachment.cleanup", attachmentIds: [...attachmentIds] },
        } satisfies PendingOrchestrationEffectV2,
      ]);
};

const emitRemoteStopOwed = Effect.fn("orchestrationV2.dispatch.remoteStopOwed")(function* (
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  command: Extract<
    OrchestrationV2InternalCommand,
    { readonly type: "delegated_task.remote.complete" | "delegated_task.remote.stop" }
  >,
  task: OrchestrationV2Subagent,
  remoteChild: OrchestrationV2RemoteTaskChild,
) {
  const now = yield* DateTime.now;
  yield* emit(
    events,
    command,
  )({
    type: "subagent.updated",
    threadId: command.parentThreadId,
    ...(task.runId === null ? {} : { runId: task.runId }),
    nodeId: task.id,
    driver: task.driver,
    occurredAt: now,
    payload: {
      ...task,
      remoteChild: {
        ...remoteChild,
        stoppedThere: false,
        stopCount: (remoteChild.stopCount ?? 0) + 1,
      },
      updatedAt: now,
    },
  });
});

const loadProjectionForCommand = <K extends ProjectionRecordField>(
  command: OrchestrationV2Command,
  fields: ReadonlyArray<K>,
  filter?: ProjectionRecordFilter,
) =>
  projectionStore
    .getThreadRecords(commandThreadId(command), fields, filter)
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: commandThreadId(command), cause }),
      ),
    );

const preparedRunState = (
  command: Extract<
    OrchestrationV2Command,
    {
      readonly type:
        | "prepared-run.release"
        | "prepared-run.progress"
        | "prepared-run.fail"
        | "prepared-run.retry";
    }
  >,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "nodes" | "providerThreads" | "turnItems"
  >,
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
    run?.status !== (command.type === "prepared-run.retry" ? "failed" : "preparing") ||
    attempt === undefined ||
    rootNode === undefined ||
    providerThread === undefined ||
    preparationItem === undefined
  ) {
    return null;
  }
  return { run, attempt, rootNode, providerThread, preparationItem } as const;
};

const runInterruptReason = Effect.fnUntraced(function* (
  command: Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "run.interrupt" | "thread.background-work.settle" }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  runId: RunId,
) {
  const isRequest = (
    item: OrchestrationV2TurnItem,
  ): item is Extract<OrchestrationV2TurnItem, { readonly type: "run_interrupt_request" }> =>
    item.runId === runId && item.type === "run_interrupt_request";
  const pending = (yield* Ref.get(events))
    .flatMap((event) => (event.type === "turn-item.updated" ? [event.payload] : []))
    .findLast(isRequest);
  if (pending !== undefined) return pending.message;
  const { turnItems } = yield* projectionStore
    .getThreadRecords(command.threadId, ["turnItems"], {
      turnItemTypes: ["run_interrupt_request"],
      turnItemRunIds: [runId],
    })
    .pipe(mapDispatchError(command));
  return turnItems.find(isRequest)?.message;
});

const settleInterruptedRun = Effect.fn("Orchestrator.settleInterruptedRun")(function* (input: {
  readonly command: Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "run.interrupt" | "thread.background-work.settle" }
  >;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    | "runs"
    | "attempts"
    | "nodes"
    | "subagents"
    | "runtimeRequests"
    | "messages"
    | "turnItems"
    | "providerThreads"
  >;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
  readonly now: DateTime.Utc;
}) {
  const attempt = input.projection.attempts.find(
    (candidate) => candidate.id === input.providerTurn.runAttemptId,
  );
  const run = input.projection.runs.find((candidate) => candidate.id === attempt?.runId);
  const rootNode = input.projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
  if (
    attempt === undefined ||
    run === undefined ||
    rootNode === undefined ||
    run.activeAttemptId !== attempt.id ||
    run.status !== "running" ||
    attempt.status === "pending"
  )
    return;
  const emitEvent = emit(input.events, input.command);
  const base = {
    threadId: input.command.threadId,
    runId: run.id,
    nodeId: rootNode.id,
    providerInstanceId: run.providerInstanceId,
    occurredAt: input.now,
  };
  if (input.providerTurn.status === "running") {
    yield* emitEvent({
      ...base,
      type: "provider-turn.updated",
      payload: {
        ...input.providerTurn,
        status: "interrupted",
        completedAt: input.now,
      },
    });
  }
  // An attempt that already ended keeps its status; only its run was left running.
  if (attempt.status === "running") {
    yield* emitEvent({
      ...base,
      type: "run-attempt.updated",
      payload: {
        ...attempt,
        status: "interrupted",
        completedAt: input.now,
      },
    });
  }
  const providerThread = input.projection.providerThreads.find(
    (candidate) => candidate.id === input.providerTurn.providerThreadId,
  );
  if (providerThread?.status === "active" && providerThread.lastRunOrdinal === run.ordinal) {
    yield* emitEvent({
      ...base,
      type: "provider-thread.updated",
      payload: { ...providerThread, status: "idle", updatedAt: input.now },
    });
  }
  for (const message of input.projection.messages) {
    if (message.runId !== run.id || !message.streaming) continue;
    yield* emitEvent({
      ...base,
      ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
      type: "message.updated",
      payload: { ...message, streaming: false, updatedAt: input.now },
    });
  }
  const delegatedNodeIds = new Set(
    input.projection.subagents
      .filter((subagent) => subagent.origin === "app_owned")
      .map((subagent) => subagent.id),
  );
  const cascaded = yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
    run,
    status: "interrupted",
    completedAt: input.now,
    allocateEventId: () =>
      idAllocator.allocate.event({
        threadId: input.command.threadId,
        commandId: input.command.commandId,
      }),
    open: {
      subagents: new Map(
        input.projection.subagents
          .filter((task) => task.runId === run.id && task.origin !== "app_owned")
          .map((task) => [task.id, task]),
      ),
      nodes: new Map(
        input.projection.nodes
          .filter((node) => node.runId === run.id && !delegatedNodeIds.has(node.id))
          .map((node) => [node.id, node]),
      ),
      turnItems: new Map(),
      childTurnItems: new Map(
        input.projection.turnItems
          .filter(
            (item) =>
              item.runId === run.id &&
              (item.type === "assistant_message" || item.type === "reasoning"),
          )
          .map((item) => [item.id, item]),
      ),
      linkedChildThreadIds: new Set([run.threadId]),
    },
  }).pipe(mapDispatchError(input.command));
  yield* Ref.update(input.events, (events) => [...events, ...cascaded]);
  for (const request of input.projection.runtimeRequests) {
    if (
      request.status !== "pending" ||
      !input.projection.nodes.some((node) => node.id === request.nodeId && node.runId === run.id)
    )
      continue;
    yield* emitEvent({
      ...base,
      nodeId: request.nodeId,
      type: "runtime-request.updated",
      payload: {
        ...request,
        status: "cancelled",
        resolvedAt: input.now,
        responseCapability: { type: "not_resumable", reason: "The run was interrupted." },
      },
    });
  }
  if (providerThread !== undefined) {
    yield* emitEvent({
      ...base,
      type: "turn-item.updated",
      payload: RunExecutionService.makeInterruptResultTurnItem({
        idAllocator,
        run,
        rootNode,
        providerThread,
        reason:
          (input.command.type === "thread.background-work.settle"
            ? input.command.reason
            : undefined) ?? (yield* runInterruptReason(input.command, input.events, run.id)),
        completedAt: input.now,
      }),
    });
  }
  const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } = run;
  yield* emitEvent({
    ...base,
    type: "run.updated",
    payload: {
      ...runWithoutDelegatedCompletion,
      status: "interrupted",
      completedAt: input.now,
    },
  });
  const scopeId = rootNode.checkpointScopeId;
  if (scopeId !== null) {
    yield* Ref.update(input.effects, (effects) => [
      ...effects,
      {
        id: `effect:checkpoint.capture:${run.id}`,
        commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
        threadId: input.command.threadId,
        request: {
          type: "checkpoint.capture",
          runId: run.id,
          scopeId,
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
  }
});

const markStoppedRun = Effect.fnUntraced(function* (input: {
  readonly command: Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "run.interrupt" | "thread.stop" }
  >;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly thread: OrchestrationV2AppThread;
  readonly run: OrchestrationV2Run;
  readonly now: DateTime.Utc;
}) {
  const { command, events, thread, run, now } = input;
  if (run.rootNodeId === null || run.providerThreadId === null) return;
  const pendingItems = (yield* Ref.get(events)).flatMap((event) =>
    event.type === "turn-item.updated" ? [event.payload] : [],
  );
  if (
    pendingItems.some((item) => item.runId === run.id && item.type === "run_interrupt_request") ||
    (yield* stopReachedRun(command, thread.id, run.id))
  ) {
    return;
  }
  yield* emit(
    events,
    command,
  )({
    type: "turn-item.updated",
    threadId: thread.id,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerInstanceId: run.providerInstanceId,
    occurredAt: now,
    payload: {
      id: idAllocator.derive.runSignalTurnItem({ runId: run.id, signal: "interrupt-request" }),
      threadId: thread.id,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* nextTurnItemOrdinal({ thread, turnItems: pendingItems }),
      status: "completed",
      title: "Interrupt requested",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "run_interrupt_request",
      message: command.reason ?? RunExecutionService.USER_STOP_REASON,
    },
  });
});

const awaitsRestartContinuation = (run: OrchestrationV2Run) =>
  effectOutbox
    .get(`effect:restart-continuation:${run.id}`)
    .pipe(
      Effect.map(
        Option.exists((effect) => effect.status === "pending" || effect.status === "running"),
      ),
    );

const planDelegatedCompletionDelivery = Effect.fn(
  "orchestrationV2.planDelegatedCompletionDelivery",
)(function* (input: {
  readonly parentProjection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "messages" | "runs" | "subagents" | "providerTurns"
  >;
  readonly parentRun: OrchestrationV2Run | undefined;
  readonly task: OrchestrationV2Subagent;
  readonly updatedTask: OrchestrationV2Subagent;
  readonly now: DateTime.Utc;
}) {
  const taskDelivery = input.updatedTask.completionDelivery;
  if (
    taskDelivery?.state === "acknowledged" ||
    taskDelivery?.state === "delivered" ||
    taskDelivery?.state === "disposed"
  ) {
    return {
      task: input.updatedTask,
      parentRun: undefined,
      message: undefined,
      offer: false,
    };
  }
  const cohort = input.parentRun?.delegatedCompletion;
  if (
    input.parentRun === undefined ||
    input.parentProjection.thread.archivedAt !== null ||
    input.parentProjection.thread.deletedAt !== null ||
    (cohort !== undefined && cohort.disposition !== "open")
  ) {
    return {
      task: {
        ...input.updatedTask,
        completionDelivery: {
          state: "disposed" as const,
          observedByRunId: null,
        },
      },
      parentRun: undefined,
      message: undefined,
      offer: false,
    };
  }
  // settled_only relies on a blocking wait that ends with the spawning turn; later results need another delivery path.
  if (
    (input.task.completionWake ?? "settled_only") === "settled_only" &&
    hasLiveRun({ runs: [input.parentRun] })
  ) {
    return {
      task: input.updatedTask,
      parentRun: undefined,
      message: undefined,
      offer: false,
    };
  }

  const delivery = cohort?.delivery ?? null;
  const deliveryRun = completionDeliveryRun(input.parentProjection, delivery);
  if (delivery !== null) {
    if (deliveryRun?.status === "queued" && deliveryRun.userMessageId === delivery.messageId) {
      const taskIds = Array.from(new Set([...delivery.taskIds, input.task.id]));
      const message = completionDeliveryMessage(input.parentProjection, delivery);
      const nextCohort = {
        ...cohort!,
        delivery: {
          ...delivery,
          taskIds,
        },
      };
      return {
        task: {
          ...input.updatedTask,
          completionDelivery: {
            state: "claimed" as const,
            observedByRunId: null,
          },
        },
        parentRun: {
          ...input.parentRun,
          delegatedCompletion: nextCohort,
        },
        message:
          message === undefined
            ? undefined
            : {
                ...message,
                text: delegatedCompletionWakeDetail(
                  taskIds,
                  input.parentProjection.subagents.map((task) =>
                    task.id === input.updatedTask.id ? input.updatedTask : task,
                  ),
                ),
                delegatedCompletion: {
                  parentRunId: input.parentRun.id,
                  generation: delivery.generation,
                  taskIds,
                },
                updatedAt: input.now,
              },
        offer: false,
      };
    }
    if (deliveryRun !== undefined) {
      // The terminal-run listener reserves successor wakes; keep racing siblings pending to avoid competing deliveries.
      return {
        task: {
          ...input.updatedTask,
          completionDelivery: {
            state: "pending" as const,
            observedByRunId: null,
          },
        },
        parentRun: undefined,
        message: undefined,
        offer: false,
      };
    }
    const taskIds = Array.from(new Set([...delivery.taskIds, input.task.id]));
    const nextCohort = {
      ...cohort!,
      delivery: {
        ...delivery,
        taskIds,
      },
    };
    return {
      task: {
        ...input.updatedTask,
        completionDelivery: {
          state: "claimed" as const,
          observedByRunId: null,
        },
      },
      parentRun: {
        ...input.parentRun,
        delegatedCompletion: nextCohort,
      },
      message: undefined,
      offer: true,
    };
  }

  const generation = cohort?.nextGeneration ?? 1;
  const messageId = yield* mapDelegatedCompletionError(
    idAllocator.allocate.message({
      threadId: input.parentRun.threadId,
      ordinal:
        (yield* mapDelegatedCompletionError(
          projectionStore.getMessageCount(input.parentRun.threadId),
        )) + 1,
    }),
  );
  const nextCohort = {
    disposition: "open" as const,
    nextGeneration: generation + 1,
    delivery: {
      generation,
      messageId,
      taskIds: [input.task.id],
    },
  };
  return {
    task: {
      ...input.updatedTask,
      completionDelivery: {
        state: "claimed" as const,
        observedByRunId: null,
      },
    },
    parentRun: {
      ...input.parentRun,
      delegatedCompletion: nextCohort,
    },
    message: undefined,
    offer: true,
  };
});

  return { releaseGuestAttachments, emitRemoteStopOwed, loadProjectionForCommand, preparedRunState, runInterruptReason, settleInterruptedRun, markStoppedRun, awaitsRestartContinuation, planDelegatedCompletionDelivery };
});

export type SettleInterruptedRunPart = ReturnType<typeof installSettleInterruptedRun> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installSettleInterruptedRun>;
