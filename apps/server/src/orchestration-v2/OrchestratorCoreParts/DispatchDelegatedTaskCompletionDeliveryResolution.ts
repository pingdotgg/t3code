import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { CommandId, OrchestrationV2Command, type OrchestrationV2ServerCommand, type OrchestrationV2DelegatedCompletionCohort, type OrchestrationV2DomainEvent, type OrchestrationV2Subagent, type OrchestrationV2ThreadProjection, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { continuationStartRetryDelayMs } from "../RestartBackgroundNote.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { OrchestratorDispatchError, OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { delegatedCompletionWakeDetail } from "../orchestrationCommandQueries.ts";
import { worktreeSetupPending } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart;

export const installDispatchDelegatedTaskCompletionDeliveryResolution = Effect.fnUntraced(function* (deps: Deps) {
  const { completionDeliveryMessage, completionDeliveryRun, emit, emitQueuedRunCancellation, projectionStore, startNextQueuedRun, threadDispatch, writeSystemEvents } = deps;

const retryContinuationStart = Effect.fn("Orchestrator.retryContinuationStart")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const projection = yield* projectionStore.getThreadRecords(
    threadId,
    ["runs", "providerTurns", "turnItems"],
    { turnItemTypes: ["error"], turnItemRunIds: [runId] },
  );
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return;
  const delayMs = continuationStartRetryDelayMs(run, projection);
  if (delayMs === undefined) return;
  const commandId = CommandId.make(`command:restart-continuation-retry:${run.id}`);
  yield* writeSystemEvents(
    [],
    [
      {
        id: `effect:restart-continuation:${run.id}`,
        commandId,
        threadId,
        request: { type: "provider-runtime.continue", sourceRunId: run.id },
        availableAt: DateTime.add(yield* DateTime.now, { milliseconds: delayMs }),
      },
    ],
  );
});

const releaseUnattendedHolds = Effect.fn("Orchestrator.releaseUnattendedHolds")(function* (
  threadId: ThreadId,
  completedRunId: RunId,
) {
  const held = yield* projectionStore.getHeldQueuedRuns(threadId);
  if (held.length === 0) return;
  const projection = yield* projectionStore.getThreadRecords(
    threadId,
    ["runs", "messages", "turnItems"],
    {
      messageIds: held.map((run) => run.userMessageId),
      turnItemTypes: ["run_interrupt_request"],
      turnItemRunIds: [completedRunId],
    },
  );
  // Only the newest run completing shows the thread moved past the hold; a late or
  // bookkeeping update to an older run, overtaken by a failure or Stop, does not.
  if (
    latestExecutedRun(projection.runs)?.id !== completedRunId ||
    projection.turnItems.length > 0 ||
    worktreeSetupPending(projection)
  )
    return;
  const { messages } = projection;
  const unattended = new Set(
    messages
      .filter((message) => message.createdBy !== "user" || message.scheduledTaskId !== undefined)
      .map((message) => message.id),
  );
  const now = yield* DateTime.now;
  const released = held.filter((run) => unattended.has(run.userMessageId));
  if (released.length === 0) return;
  yield* writeSystemEvents(
    released.map((run) => ({
      type: "run.updated" as const,
      threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...run, queueHeld: false },
    })),
  );
});

const resumeQueuedRuns = Effect.gen(function* () {
  const threadIds = yield* projectionStore.getRecoveryThreadIds("queued-runs");
  let resumed = 0;
  for (const threadId of threadIds) {
    const resumedThread = yield* Effect.gen(function* () {
      if (!(yield* projectionStore.canStartQueuedRun(threadId))) return false;
      yield* threadDispatch.withLock(threadId, startNextQueuedRun(threadId));
      return true;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to resume queued V2 run after recovery", {
          threadId,
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

const dispatchDelegatedTaskCompletionDeliveryResolution = Effect.fn(
  "Orchestrator.dispatchDelegatedTaskCompletionDeliveryResolution",
)(function* (
  command: Extract<
    OrchestrationV2Command,
    {
      readonly type:
        | "delegated_task.completion-delivery.acknowledge"
        | "delegated_task.completion-delivery.dispose";
    }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const projection = yield* projectionStore
    .getThreadRecords(
      command.parentThreadId,
      ["subagents", "runs", "nodes", "attempts", "turnItems"],
      { turnItemTypes: [] },
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
  const task = projection.subagents.find(
    (candidate) => candidate.id === command.taskId && candidate.origin === "app_owned",
  );
  if (task === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Delegated task ${command.taskId} is not an app-owned task of thread ${command.parentThreadId}.`,
    });
  }
  const state =
    command.type === "delegated_task.completion-delivery.acknowledge"
      ? "acknowledged"
      : "disposed";
  const now = yield* DateTime.now;
  const emitEvent = emit(events, command);
  // task_status and t3_thread_read use distinct command IDs, so two
  // valid observations can race after their read preflight. Re-emit the
  // existing task row so the second dispatch is a successful idempotent
  // no-op rather than "already acknowledged/disposed" or empty-events.
  if (
    task.completionDelivery?.state === state ||
    (command.type === "delegated_task.completion-delivery.acknowledge" &&
      task.completionDelivery?.state === "disposed")
  ) {
    yield* emitEvent({
      type: "subagent.updated",
      threadId: command.parentThreadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      occurredAt: now,
      payload: task,
    });
    return;
  }
  const updatedTask: OrchestrationV2Subagent = {
    ...task,
    completionDelivery: {
      state,
      observedByRunId:
        command.type === "delegated_task.completion-delivery.acknowledge"
          ? command.observedByRunId
          : null,
    },
    updatedAt: now,
  };
  yield* emitEvent({
    type: "subagent.updated",
    threadId: command.parentThreadId,
    ...(task.runId === null ? {} : { runId: task.runId }),
    nodeId: task.id,
    driver: task.driver,
    providerInstanceId: task.providerInstanceId,
    occurredAt: now,
    payload: updatedTask,
  });

  const parentRun =
    task.runId === null
      ? undefined
      : projection.runs.find((candidate) => candidate.id === task.runId);
  const cohort = parentRun?.delegatedCompletion;
  const delivery = cohort?.delivery;
  if (
    parentRun === undefined ||
    cohort === undefined ||
    delivery === null ||
    delivery === undefined
  ) {
    return;
  }
  if (!delivery.taskIds.includes(task.id)) {
    return;
  }

  const { messages } = yield* projectionStore
    .getThreadRecords(command.parentThreadId, ["messages"], {
      messageRoles: ["user"],
      messageIds: [delivery.messageId],
    })
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
      ),
    );
  const deliveryProjection = { ...projection, messages };
  const remainingTaskIds = delivery.taskIds.filter((taskId) => taskId !== task.id);
  const deliveryRun = completionDeliveryRun(deliveryProjection, delivery);
  const clearDelivery =
    remainingTaskIds.length === 0 &&
    (deliveryRun === undefined || deliveryRun.status === "queued");
  const updatedCohort: OrchestrationV2DelegatedCompletionCohort = {
    ...cohort,
    delivery: clearDelivery
      ? null
      : {
          ...delivery,
          taskIds: remainingTaskIds,
        },
  };
  yield* emitEvent({
    type: "run.updated",
    threadId: command.parentThreadId,
    runId: parentRun.id,
    ...(parentRun.rootNodeId === null ? {} : { nodeId: parentRun.rootNodeId }),
    providerInstanceId: parentRun.providerInstanceId,
    occurredAt: now,
    payload: {
      ...parentRun,
      delegatedCompletion: updatedCohort,
    },
  });

  if (deliveryRun?.status === "queued") {
    if (remainingTaskIds.length === 0) {
      yield* emitQueuedRunCancellation({
        command,
        events,
        projection,
        run: deliveryRun,
        now,
      });
      return parentRun.id;
    }
    const message = completionDeliveryMessage(deliveryProjection, delivery);
    if (message !== undefined) {
      yield* emitEvent({
        type: "message.updated",
        threadId: command.parentThreadId,
        runId: deliveryRun.id,
        ...(deliveryRun.rootNodeId === null ? {} : { nodeId: deliveryRun.rootNodeId }),
        providerInstanceId: deliveryRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...message,
          text: delegatedCompletionWakeDetail(remainingTaskIds, projection.subagents),
          delegatedCompletion: {
            parentRunId: parentRun.id,
            generation: delivery.generation,
            taskIds: remainingTaskIds,
          },
          updatedAt: now,
        },
      });
    }
  }
  return parentRun.id;
});

const disposeDelegatedCompletionCohort = Effect.fn(
  "Orchestrator.disposeDelegatedCompletionCohort",
)(function* (input: {
  readonly command: OrchestrationV2ServerCommand;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "subagents" | "messages" | "nodes" | "attempts"
  >;
  readonly parentRunId: RunId;
  readonly disposition: "stopped" | "disposed";
  readonly now: DateTime.Utc;
  readonly cancelQueuedDelivery?: boolean;
}) {
  const parentRun = input.projection.runs.find((candidate) => candidate.id === input.parentRunId);
  if (parentRun === undefined) {
    return;
  }
  const cohort = parentRun.delegatedCompletion;
  const tasks = input.projection.subagents.filter(
    (candidate) => candidate.origin === "app_owned" && candidate.runId === input.parentRunId,
  );
  if (cohort === undefined && tasks.length === 0) {
    return;
  }
  const emitEvent = emit(input.events, input.command);
  const nextDisposition = cohort?.disposition === "disposed" ? "disposed" : input.disposition;
  const nextCohort = {
    disposition: nextDisposition,
    nextGeneration: cohort?.nextGeneration ?? 1,
    delivery: null,
  } as const;
  yield* emitEvent({
    type: "run.updated",
    threadId: parentRun.threadId,
    runId: parentRun.id,
    ...(parentRun.rootNodeId === null ? {} : { nodeId: parentRun.rootNodeId }),
    providerInstanceId: parentRun.providerInstanceId,
    occurredAt: input.now,
    payload: {
      ...parentRun,
      delegatedCompletion: nextCohort,
    },
  });
  for (const task of tasks) {
    if (
      task.completionDelivery?.state === "acknowledged" ||
      task.completionDelivery?.state === "delivered" ||
      task.completionDelivery?.state === "disposed"
    ) {
      continue;
    }
    yield* emitEvent({
      type: "subagent.updated",
      threadId: parentRun.threadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      occurredAt: input.now,
      payload: {
        ...task,
        completionDelivery: {
          state: "disposed",
          observedByRunId: null,
        },
        updatedAt: input.now,
      },
    });
  }
  const deliveryRun = completionDeliveryRun(input.projection, cohort?.delivery ?? null);
  if (input.cancelQueuedDelivery !== false && deliveryRun?.status === "queued") {
    yield* emitQueuedRunCancellation({
      command: input.command,
      events: input.events,
      projection: input.projection,
      run: deliveryRun,
      now: input.now,
    });
  }
});

const disposeAllDelegatedCompletionCohorts = (input: {
  readonly command: OrchestrationV2Command;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "subagents" | "messages" | "nodes" | "attempts"
  >;
  readonly now: DateTime.Utc;
  readonly cancelQueuedDelivery?: boolean;
}) =>
  Effect.forEach(
    Array.from(
      new Set([
        ...input.projection.runs
          .filter((run) => run.delegatedCompletion !== undefined)
          .map((run) => run.id),
        ...input.projection.subagents
          .filter((task) => task.origin === "app_owned" && task.runId !== null)
          .map((task) => task.runId!),
      ]),
    ),
    (parentRunId) =>
      disposeDelegatedCompletionCohort({
        ...input,
        parentRunId,
        disposition: "disposed",
      }),
    { concurrency: 1, discard: true },
  );

const closePendingLinkRequests = Effect.fn("orchestrationV2.closePendingLinkRequests")(
  function* (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly threadId: ThreadId;
    readonly now: DateTime.Utc;
  }) {
    const { turnItems } = yield* projectionStore
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["link_request"],
        turnItemStatuses: ["waiting"],
        messageRoles: [],
      })
      .pipe(mapDispatchError(input.command));
    for (const item of turnItems) {
      if (item.type !== "link_request" || item.linkStatus !== "pending") continue;
      yield* emit(
        input.events,
        input.command,
      )({
        type: "turn-item.updated",
        threadId: input.threadId,
        ...(item.runId === null ? {} : { runId: item.runId }),
        ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
        occurredAt: input.now,
        payload: {
          ...item,
          status: "cancelled",
          linkStatus: "cancelled",
          completedAt: input.now,
          updatedAt: input.now,
        },
      });
    }
  },
);

  return { retryContinuationStart, releaseUnattendedHolds, resumeQueuedRuns, dispatchDelegatedTaskCompletionDeliveryResolution, disposeDelegatedCompletionCohort, disposeAllDelegatedCompletionCohorts, closePendingLinkRequests };
});

export type DispatchDelegatedTaskCompletionDeliveryResolutionPart = ReturnType<typeof installDispatchDelegatedTaskCompletionDeliveryResolution> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchDelegatedTaskCompletionDeliveryResolution>;
