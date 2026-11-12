/**
 * Extracted orchestrator handlers: dispatchQueuedRunEdit, dispatchQueuedRunCancel, dispatchPreparedRunProgress, dispatchPreparedRunRetry, dispatchPreparedRunRelease, dispatchPreparedRunFail, dispatchQueuedMessagePromoteToSteer, dispatchRuntimeRequestDeliveryFail, dispatchSecretRequestRecord, dispatchRemoteDelegatedTaskStop, dispatchDelegatedTaskWakePolicy.
 *
 * Moved out of the makeOrchestrator closure; dependencies are passed in.
 */
import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2InternalCommand,
  OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { recordThreadOpen } from "@t3tools/shared/paletteSearch";

import type { CommandId, ThreadId } from "@t3tools/contracts";
import type { EventIdAllocator } from "../orchestrationEmitters.ts";
import type { CheckpointServiceV2Shape } from "../CheckpointService.ts";
import type { RuntimePolicyV2Shape } from "../RuntimePolicy.ts";

type AnyOrchestratorError =
  | OrchestratorDispatchError
  | OrchestratorThreadAlreadyExistsError
  | OrchestratorCommandRejectedError
  | OrchestratorProjectionError
  | OrchestratorDomainEventStreamError
  | OrchestratorProviderAdapterError
  | OrchestratorSubagentThreadReadOnlyError
  | OrchestratorThreadAboveModeLimitError;
import { isCheckpointRestoreIsolated } from "../CheckpointRestoreSafety.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "../ProjectionStore.ts";
import {
  RUNTIME_REQUEST_DELIVERY_FAILED_MESSAGE,
  WORKSPACE_PREPARATION_INPUT,
} from "../orchestrationMessages.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import {
  hasLiveRun,
  isLiveRun,
  isTerminalDelegatedTaskStatus,
  withoutPreparationResult,
} from "../Orchestrator.ts";
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

import { ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE } from "@t3tools/contracts";
import { TurnItemId } from "@t3tools/contracts";
import { goalCommandStopsActiveRun } from "../CommandPolicy.ts";
import { guestShareAfterCancelledSend } from "../GuestShareDecider.ts";
import { isActiveRun } from "../CommandPolicy.ts";
import { isCompactionCommandMessage } from "@t3tools/contracts";
import { isNativeMaintenanceCommand } from "../CommandPolicy.ts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { parseGoalCommand } from "@t3tools/contracts";
import { providerTurnForRun } from "../orchestrationCommandQueries.ts";
import { withoutGuestAttribution } from "../GuestShareDecider.ts";









import type {
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export interface MakeQueueHandlersDeps {
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => (
    event: Omit<OrchestrationV2DomainEvent, "id">,
  ) => Effect.Effect<OrchestrationV2DomainEvent, OrchestratorDispatchError>;
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly idAllocator: EventIdAllocator;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorProjectionError, never>;
  readonly checkpointService: CheckpointServiceV2Shape;
  readonly runtimePolicy: RuntimePolicyV2Shape;
  readonly preparedRunState: (...args: any[]) => any;
  readonly goalDriverFor: (
    command: OrchestrationV2ServerCommand,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderDriverKind | undefined, OrchestratorDispatchError, never>;
  readonly ensureGoalCommandSupported: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly disposeDelegatedCompletionCohort: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly emitRemoteStopOwed: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly planDelegatedCompletionDelivery: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly stopReachedRun: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly stopRunForQueuedCommand: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly dispatchSteerIntoRun: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
}

export const makeQueueHandlers = (deps: MakeQueueHandlersDeps) => {
const dispatchRemoteDelegatedTaskStop = Effect.fn(
  "orchestrationV2.dispatch.remoteDelegatedTaskStop",
)(function* (
  command: Extract<
    OrchestrationV2InternalCommand,
    { readonly type: "delegated_task.remote.stop" }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const { subagents } = yield* deps.projectionStore
    .getThreadRecords(command.parentThreadId, ["subagents"])
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
      ),
    );
  const task = subagents.find(
    (candidate) =>
      candidate.id === command.taskId &&
      candidate.origin === "app_owned" &&
      candidate.remoteChild !== undefined &&
      candidate.result !== null,
  );
  if (task?.remoteChild === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Delegated task ${command.taskId} is not a finished remote task of thread ${command.parentThreadId}.`,
    });
  }
  yield* deps.emitRemoteStopOwed(events, command, task, task.remoteChild);
});

const dispatchDelegatedTaskWakePolicy = Effect.fn(
  "orchestrationV2.dispatch.delegatedTaskWakePolicy",
)(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "delegated_task.wake-policy" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  // Delivery planning reads only this task and the undelivered tasks of the queued delivery.
  const parentProjection = yield* deps.projectionStore
    .getThreadRecords(
      command.parentThreadId,
      ["subagents", "runs", "messages", "providerTurns"],
      {
        omitSettledSubagents: { except: [command.taskId] },
      },
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
  const task = parentProjection.subagents.find(
    (candidate) => candidate.id === command.taskId && candidate.origin === "app_owned",
  );
  if (task === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Delegated task ${command.taskId} is not an app-owned task of thread ${command.parentThreadId}.`,
    });
  }
  if (task.completionWake === command.completionWake) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Delegated task ${command.taskId} already wakes the parent with completionWake ${command.completionWake}.`,
    });
  }
  const now = yield* DateTime.now;
  const emitEvent = deps.emit(events, command);
  const updatedTask: OrchestrationV2Subagent = {
    ...task,
    completionWake: command.completionWake,
    updatedAt: now,
  };
  // Finalization already offered for ended parent runs; another offer would duplicate the wake.
  const parentRun =
    task.runId === null
      ? undefined
      : parentProjection.runs.find((candidate) => candidate.id === task.runId);
  const completionPlan =
    command.completionWake === "always" &&
    isTerminalDelegatedTaskStatus(task.status) &&
    parentRun !== undefined &&
    hasLiveRun({ runs: [parentRun] })
      ? yield* deps.planDelegatedCompletionDelivery({
          parentProjection,
          parentRun,
          task: updatedTask,
          updatedTask,
          now,
        })
      : undefined;
  yield* emitEvent({
    type: "subagent.updated",
    threadId: command.parentThreadId,
    ...(task.runId === null ? {} : { runId: task.runId }),
    nodeId: task.id,
    driver: task.driver,
    providerInstanceId: task.providerInstanceId,
    occurredAt: now,
    payload: completionPlan?.task ?? updatedTask,
  });
  if (completionPlan === undefined) {
    return;
  }
  if (completionPlan.parentRun !== undefined) {
    yield* emitEvent({
      type: "run.updated",
      threadId: command.parentThreadId,
      runId: completionPlan.parentRun.id,
      ...(completionPlan.parentRun.rootNodeId === null
        ? {}
        : { nodeId: completionPlan.parentRun.rootNodeId }),
      providerInstanceId: completionPlan.parentRun.providerInstanceId,
      occurredAt: now,
      payload: completionPlan.parentRun,
    });
  }
  if (completionPlan.message !== undefined) {
    yield* emitEvent({
      type: "message.updated",
      threadId: command.parentThreadId,
      ...(completionPlan.message.runId === null ? {} : { runId: completionPlan.message.runId }),
      ...(completionPlan.message.nodeId === null
        ? {}
        : { nodeId: completionPlan.message.nodeId }),
      providerInstanceId:
        completionPlan.parentRun?.providerInstanceId ??
        parentProjection.thread.providerInstanceId,
      occurredAt: now,
      payload: completionPlan.message,
    });
  }
  return completionPlan.parentRun?.id;
});

const dispatchSecretRequestRecord = Effect.fn("orchestrationV2.dispatch.secretRequestRecord")(
  function* (
    command: Extract<OrchestrationV2InternalCommand, { readonly type: "secret_request.record" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* deps.projectionStore
      .getThreadRecords(
        command.threadId,
        ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
        { turnItemTypes: ["secret_request"], messageRoles: [] },
      )
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    if (run === undefined || run.rootNodeId !== command.nodeId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Node ${command.nodeId} is not the root of run ${command.runId}.`,
      });
    }
    const existing = projection.turnItems.find((item) => item.id === command.turnItemId);
    if (existing !== undefined && existing.type !== "secret_request") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Turn item ${command.turnItemId} is not a secret request.`,
      });
    }
    if (existing !== undefined && existing.runId !== command.runId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Secret request ${command.turnItemId} belongs to another run.`,
      });
    }
    const now = yield* DateTime.now;
    const unchanged =
      existing !== undefined &&
      (existing.secretStatus !== "pending" || command.secretStatus === "pending");
    const pending = command.secretStatus === "pending";
    const turnItem: OrchestrationV2TurnItem = unchanged
      ? existing
      : {
          id: command.turnItemId,
          threadId: command.threadId,
          runId: command.runId,
          nodeId: command.nodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: providerTurnForRun(projection, run)?.id ?? null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: existing?.ordinal ?? (yield* deps.nextTurnItemOrdinal(projection)),
          status: pending
            ? "waiting"
            : command.secretStatus === "saved"
              ? "completed"
              : "cancelled",
          title: command.label,
          startedAt: existing?.startedAt ?? now,
          completedAt: pending ? null : now,
          updatedAt: now,
          type: "secret_request",
          label: command.label,
          reason: command.reason,
          ...(command.placeholder === undefined ? {} : { placeholder: command.placeholder }),
          ...(command.delivery === undefined ? {} : { delivery: command.delivery }),
          secretStatus: command.secretStatus,
        };
    yield* deps.emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: command.runId,
      nodeId: command.nodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: turnItem,
    });
  },
);

/**
 * Records or updates the card for a link an agent asked the user to make.
 * The pairing code goes straight to the link and never through orchestration.
 */

const dispatchRuntimeRequestDeliveryFail = Effect.fn(
  "Orchestrator.dispatchRuntimeRequestDeliveryFail",
)(function* (
  command: Extract<
    OrchestrationV2InternalCommand,
    { readonly type: "runtime-request.delivery.fail" }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const thread = yield* deps.projectionStore
    .getThread(command.threadId)
    .pipe(mapDispatchError(command));
  if (thread.deletedAt !== null) return;
  const node = (yield* deps.projectionStore
    .getRuntimeResponseContext(command.threadId, command.requestId)
    .pipe(mapDispatchError(command))).node;
  if (node === undefined) return;
  const now = yield* DateTime.now;
  yield* deps.emit(
    events,
    command,
  )({
    type: "turn-item.updated",
    threadId: command.threadId,
    ...(node.runId === null ? {} : { runId: node.runId }),
    nodeId: node.id,
    providerInstanceId: thread.providerInstanceId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`turn-item:runtime-request-delivery-failure:${command.requestId}`),
      threadId: command.threadId,
      runId: node.runId,
      nodeId: node.id,
      providerThreadId: node.providerThreadId,
      providerTurnId: node.providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* deps.nextTurnItemOrdinal({ thread }),
      status: "failed",
      title: "Answer delivery not confirmed",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "error",
      failure: {
        class: "transport_error",
        message: RUNTIME_REQUEST_DELIVERY_FAILED_MESSAGE,
        code: null,
        retryable: null,
      },
    },
  });
});

const dispatchQueuedMessagePromoteToSteer = Effect.fn(
  "Orchestrator.dispatchQueuedMessagePromoteToSteer",
)(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "queued-message.promote-to-steer" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) {
  const projection = yield* deps.loadProjectionForCommand(
    command,
    [
      "runs",
      "nodes",
      "attempts",
      "messages",
      "providerThreads",
      "providerTurns",
      "providerSessions",
      "turnItems",
      "runtimeRequests",
      "subagents",
    ],
    // User messages measure a restart's model switch.
    { turnItemTypes: ["user_message"], messageRoles: ["user"] },
  );
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is not active.`,
    });
  }
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
  if (
    queuedMessage.delegatedCompletion !== undefined ||
    queuedMessage.notification !== undefined
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Automatic completion deliveries cannot be promoted to Steer.",
    });
  }

  const now = yield* DateTime.now;
  const emitEvent = deps.emit(events, command);
  const parsedGoalCommand = parseGoalCommand(queuedMessage);
  const goalCommand =
    parsedGoalCommand === null ||
    (yield* deps.goalDriverFor(command, queuedRun.providerInstanceId)) === undefined
      ? null
      : parsedGoalCommand;
  const target = projection.runs.find((run) => run.id === command.targetRunId);
  const targetMessage = projection.messages.find(
    (message) => message.id === target?.userMessageId,
  );
  // A compacting turn cannot take steering input, so steering skips the compaction instead.
  if (
    target !== undefined &&
    targetMessage !== undefined &&
    isCompactionCommandMessage(targetMessage)
  ) {
    if (goalCommand !== null) {
      yield* deps.ensureGoalCommandSupported(command, queuedMessage, queuedRun.providerInstanceId);
    }
    yield* emitEvent({
      type: "run.updated",
      threadId: command.threadId,
      runId: queuedRun.id,
      nodeId: queuedRootNode.id,
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: { ...queuedRun, queuePosition: 1 },
    });
    const stops =
      isLiveRun(target) && !(yield* deps.stopReachedRun(command, command.threadId, target.id));
    return yield* deps.stopRunForQueuedCommand({
      command,
      events,
      effects,
      projection,
      queuedRunId: queuedRun.id,
      targetRunId: stops ? target.id : undefined,
      reason: "Skipped compaction to send a queued message",
      now,
    });
  }
  if (goalCommand !== null) {
    yield* deps.ensureGoalCommandSupported(command, queuedMessage, queuedRun.providerInstanceId);
    const goal = projection.providerThreads.find(
      (candidate) => candidate.id === target?.providerThreadId,
    )?.goal;
    yield* emitEvent({
      type: "run.updated",
      threadId: command.threadId,
      runId: queuedRun.id,
      nodeId: queuedRootNode.id,
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: { ...queuedRun, queuePosition: 1 },
    });
    const stops =
      target !== undefined &&
      isLiveRun(target) &&
      goalCommandStopsActiveRun(goalCommand, goal?.status ?? null) &&
      (targetMessage === undefined || !isNativeMaintenanceCommand(targetMessage)) &&
      !(yield* deps.stopReachedRun(command, command.threadId, target.id));
    return yield* deps.stopRunForQueuedCommand({
      command,
      events,
      effects,
      projection,
      queuedRunId: queuedRun.id,
      targetRunId: stops ? target.id : undefined,
      reason: "Stopped to apply /goal",
      now,
    });
  }
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

  yield* deps.dispatchSteerIntoRun({
    command,
    events,
    effects,
    projection,
    modelSelection: queuedRun.modelSelection,
    targetRunId: command.targetRunId,
    messageId: queuedMessage.id,
    text: queuedMessage.text,
    attachments: queuedMessage.attachments,
    ...(queuedMessage.context ? { context: queuedMessage.context } : {}),
    createdBy: queuedMessage.createdBy,
    creationSource: queuedMessage.creationSource,
    ...(queuedMessage.scheduledTaskId === undefined
      ? {}
      : { scheduledTaskId: queuedMessage.scheduledTaskId }),
    ...(queuedMessage.senderThreadId === undefined
      ? {}
      : { senderThreadId: queuedMessage.senderThreadId }),
    ...(queuedMessage.idleCompaction === undefined
      ? {}
      : { idleCompaction: queuedMessage.idleCompaction }),
    forceRestart: false,
  });
});

const dispatchQueuedRunCancel = Effect.fn("Orchestrator.dispatchQueuedRunCancel")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const projection = yield* deps.loadProjectionForCommand(
    command,
    ["runs", "messages", "nodes", "attempts", "subagents", "turnItems"],
    { turnItemTypes: [], messageRoles: ["user"] },
  );
  const queuedRun = projection.runs.find((candidate) => candidate.id === command.runId);
  if (queuedRun === undefined || queuedRun.status !== "queued") {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Run ${command.runId} is not queued.`,
    });
  }
  const queuedMessage = projection.messages.find(
    (candidate) => candidate.id === queuedRun.userMessageId,
  );
  if (queuedMessage?.delegatedCompletion !== undefined) {
    const now = yield* DateTime.now;
    yield* deps.disposeDelegatedCompletionCohort({
      command,
      events,
      projection,
      parentRunId: queuedMessage.delegatedCompletion.parentRunId,
      disposition: "disposed",
      now,
    });
    return;
  }
  const queuedRootNode =
    queuedRun.rootNodeId === null
      ? undefined
      : projection.nodes.find((candidate) => candidate.id === queuedRun.rootNodeId);
  const queuedAttempt =
    queuedRun.activeAttemptId === null
      ? undefined
      : projection.attempts.find((candidate) => candidate.id === queuedRun.activeAttemptId);

  const now = yield* DateTime.now;
  const emitEvent = deps.emit(events, command);
  yield* emitEvent({
    type: "run.updated",
    threadId: command.threadId,
    runId: queuedRun.id,
    ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
    providerInstanceId: queuedRun.providerInstanceId,
    occurredAt: now,
    payload: {
      ...queuedRun,
      status: "cancelled",
      queuePosition: null,
      completedAt: now,
    },
  });
  if (queuedAttempt !== undefined && queuedRootNode !== undefined) {
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
  }
  if (queuedRootNode !== undefined) {
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
  }
  const guest = queuedMessage?.context?.guest;
  if (guest !== undefined) {
    const thread = guestShareAfterCancelledSend(projection.thread, guest, now);
    if (thread !== projection.thread) {
      yield* emitEvent({
        type: "thread.guest-share-updated",
        threadId: command.threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: thread,
      });
    }
  }
});

const dispatchQueuedRunEdit = Effect.fn("Orchestrator.dispatchQueuedRunEdit")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  if (command.text.trim().length === 0) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Queued run ${command.runId} cannot be edited to an empty message.`,
    });
  }
  const projection = yield* deps.loadProjectionForCommand(command, ["runs", "messages", "turnItems"], {
    turnItemTypes: ["user_message"],
    messageRoles: ["user"],
  });
  const queuedRun = projection.runs.find((candidate) => candidate.id === command.runId);
  if (queuedRun === undefined || queuedRun.status !== "queued") {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Run ${command.runId} is not queued.`,
    });
  }
  const queuedMessage = projection.messages.find(
    (candidate) => candidate.id === queuedRun.userMessageId,
  );
  if (queuedMessage === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Queued run ${queuedRun.id} has no user message.`,
    });
  }
  if (
    queuedMessage.delegatedCompletion !== undefined ||
    queuedMessage.notification !== undefined
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Automatic completion deliveries cannot be edited.",
    });
  }
  // The agent text and the shown text of a guest message must stay the guest's words.
  if (queuedMessage.context?.guest !== undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "A guest's message cannot be edited. Cancel it instead.",
    });
  }
  yield* deps.ensureGoalCommandSupported(
    command,
    { text: command.text, attachments: command.attachments ?? queuedMessage.attachments },
    queuedRun.providerInstanceId,
  );
  const queuedTurnItem = projection.turnItems.find(
    (candidate) => candidate.type === "user_message" && candidate.messageId === queuedMessage.id,
  );

  const now = yield* DateTime.now;
  const emitEvent = deps.emit(events, command);
  const editedAttachments =
    command.attachments === undefined ? {} : { attachments: command.attachments };
  yield* emitEvent({
    type: "message.updated",
    threadId: command.threadId,
    runId: queuedRun.id,
    ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
    providerInstanceId: queuedRun.providerInstanceId,
    occurredAt: now,
    payload: withoutGuestAttribution({
      ...queuedMessage,
      text: command.text,
      ...editedAttachments,
      ...(command.context ? { context: command.context } : {}),
      updatedAt: now,
    }),
  });
  if (queuedTurnItem !== undefined && queuedTurnItem.type === "user_message") {
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: queuedRun.id,
      ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: withoutGuestAttribution({
        ...queuedTurnItem,
        text: command.text,
        ...editedAttachments,
        ...(command.context ? { context: command.context } : {}),
        updatedAt: now,
      }),
    });
  }
});

const dispatchPreparedRunProgress = Effect.fn("Orchestrator.dispatchPreparedRunProgress")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.progress" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* deps.loadProjectionForCommand(
      command,
      ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
      { turnItemTypes: ["command_execution"], turnItemRunId: command.runId },
    );
    const state = deps.preparedRunState(command, projection);
    if (state === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not awaiting workspace preparation.`,
      });
    }
    const now = yield* DateTime.now;
    yield* deps.emit(
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
  },
);

const dispatchPreparedRunRelease = Effect.fn("Orchestrator.dispatchPreparedRunRelease")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.release" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* deps.loadProjectionForCommand(
      command,
      ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
      { turnItemTypes: ["command_execution"], turnItemRunId: command.runId },
    );
    const state = deps.preparedRunState(command, projection);
    if (state === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not awaiting workspace preparation.`,
      });
    }
    const now = yield* DateTime.now;
    const resolvedRuntimePolicy = yield* deps.runtimePolicy
      .resolve({ thread: projection.thread, modelSelection: state.run.modelSelection })
      .pipe(mapDispatchError(command));
    const checkpointScope = yield* deps.checkpointService
      .prepareRootRunScope({
        threadId: command.threadId,
        runId: state.run.id,
        rootNodeId: state.rootNode.id,
        providerThreadId: state.providerThread.id,
        cwd: resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
        createdAt: now,
      })
      .pipe(mapDispatchError(command));
    const emitEvent = deps.emit(events, command);
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
  },
);

const dispatchPreparedRunFail = Effect.fn("Orchestrator.dispatchPreparedRunFail")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.fail" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const projection = yield* deps.loadProjectionForCommand(
    command,
    ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
    { turnItemTypes: ["command_execution"], turnItemRunId: command.runId },
  );
  const state = deps.preparedRunState(command, projection);
  if (state === null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Run ${command.runId} is not awaiting workspace preparation.`,
    });
  }
  const now = yield* DateTime.now;
  const emitEvent = deps.emit(events, command);
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
      id: deps.idAllocator.derive.turnItemFromProviderItem({
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
      ordinal: yield* deps.nextTurnItemOrdinal(projection),
      status: "failed",
      title: "Workspace preparation failed",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "error",
      failure: {
        ...command.failure,
        code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
      },
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

const dispatchPreparedRunRetry = Effect.fn("Orchestrator.dispatchPreparedRunRetry")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.retry" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const projection = yield* deps.loadProjectionForCommand(
    command,
    ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
    { turnItemTypes: ["command_execution", "error"], turnItemRunId: command.runId },
  );
  const state = deps.preparedRunState(command, projection);
  const failureItem = projection.turnItems.find(
    (candidate): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "error" }> =>
      candidate.type === "error" &&
      candidate.status === "failed" &&
      candidate.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  );
  if (
    state === null ||
    state.run.workspacePreparation === undefined ||
    failureItem === undefined ||
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Run ${command.runId} has no failed workspace preparation to retry.`,
    });
  }
  if (projection.runs.some((run) => run.id !== state.run.id && isActiveRun(run))) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Another run is active on this thread.",
    });
  }
  const now = yield* DateTime.now;
  const emitEvent = deps.emit(events, command);
  const scope = {
    threadId: command.threadId,
    runId: state.run.id,
    nodeId: state.rootNode.id,
    providerInstanceId: state.run.providerInstanceId,
    occurredAt: now,
  };
  yield* emitEvent({
    ...scope,
    type: "turn-item.updated",
    payload: { ...failureItem, status: "cancelled", updatedAt: now },
  });
  yield* emitEvent({
    ...scope,
    type: "turn-item.updated",
    payload: {
      ...withoutPreparationResult(state.preparationItem),
      status: "running",
      title: WORKSPACE_PREPARATION_INPUT,
      completedAt: null,
      updatedAt: now,
    },
  });
  yield* emitEvent({
    ...scope,
    type: "run-attempt.updated",
    payload: { ...state.attempt, status: "pending", completedAt: null },
  });
  yield* emitEvent({
    ...scope,
    type: "node.updated",
    payload: { ...state.rootNode, status: "pending", completedAt: null },
  });
  yield* emitEvent({
    ...scope,
    type: "run.updated",
    payload: { ...state.run, status: "preparing", completedAt: null },
  });
  // Messages held when this preparation failed follow the run again. A hold
  // from a later run (a stop, say) is not this failure's to release.
  const failureOwnsQueue = latestExecutedRun(projection.runs)?.id === state.run.id;
  for (const run of projection.runs) {
    if (!failureOwnsQueue || run.status !== "queued" || run.queueHeld !== true) continue;
    yield* emitEvent({
      type: "run.updated",
      threadId: command.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...run, queueHeld: false },
    });
  }
});

  return { dispatchQueuedRunEdit, dispatchQueuedRunCancel, dispatchPreparedRunProgress, dispatchPreparedRunRetry, dispatchPreparedRunRelease, dispatchPreparedRunFail, dispatchQueuedMessagePromoteToSteer, dispatchRuntimeRequestDeliveryFail, dispatchSecretRequestRecord, dispatchRemoteDelegatedTaskStop, dispatchDelegatedTaskWakePolicy };
};
