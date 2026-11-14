/**
 * Extracted orchestrator handlers: dispatchQueuedRunEdit, dispatchQueuedRunCancel, dispatchPreparedRunProgress, dispatchPreparedRunRetry, dispatchPreparedRunRelease, dispatchPreparedRunFail, dispatchQueuedMessagePromoteToSteer, dispatchRuntimeRequestDeliveryFail, dispatchSecretRequestRecord, dispatchRemoteDelegatedTaskStop, dispatchDelegatedTaskWakePolicy.
 *
 * Moved out of the makeOrchestrator closure; dependencies are passed in.
 */
import { makePreparedRunHandlers } from "./queueHandlers-part2.ts";
import { makeQueuedRunHandlers } from "./queueHandlers-part3.ts";
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

  const { dispatchPreparedRunProgress, dispatchPreparedRunRelease, dispatchPreparedRunFail, dispatchPreparedRunRetry } = makePreparedRunHandlers(deps);
  const { dispatchRuntimeRequestDeliveryFail, dispatchQueuedMessagePromoteToSteer, dispatchQueuedRunCancel, dispatchQueuedRunEdit } = makeQueuedRunHandlers(deps);

  return { dispatchQueuedRunEdit, dispatchQueuedRunCancel, dispatchPreparedRunProgress, dispatchPreparedRunRetry, dispatchPreparedRunRelease, dispatchPreparedRunFail, dispatchQueuedMessagePromoteToSteer, dispatchRuntimeRequestDeliveryFail, dispatchSecretRequestRecord, dispatchRemoteDelegatedTaskStop, dispatchDelegatedTaskWakePolicy };
};
