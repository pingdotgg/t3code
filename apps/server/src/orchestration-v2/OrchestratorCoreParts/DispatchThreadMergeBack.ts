import { OrchestrationV2Command, type OrchestrationV2ContextTransfer, type OrchestrationV2DomainEvent, orchestrationV2WorktreePending, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { isActiveRun } from "../CommandPolicy.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { forkableSourceRunStatusError, isForkableSourceRunStatus } from "../ThreadForkService.ts";
import { OrchestratorDispatchError, OrchestratorThreadAlreadyExistsError, OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { runForSourcePoint, contextSourcePointForRun, providerThreadForRun, providerTurnForRun } from "../orchestrationCommandQueries.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";
import type { DispatchSteerIntoRunPart } from "./DispatchSteerIntoRun.ts";
import type { SettleInterruptedRunPart } from "./SettleInterruptedRun.ts";
import type { SettleBackgroundWorkPart } from "./SettleBackgroundWork.ts";
import type { DispatchRunInterruptPart } from "./DispatchRunInterrupt.ts";
import type { DispatchRuntimeRequestRespondPart } from "./DispatchRuntimeRequestRespond.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart & DispatchRuntimeRequestRespondPart;

export const installDispatchThreadMergeBack = Effect.fnUntraced(function* (deps: Deps) {
  const { emit, findThread, idAllocator, projectionStore, refuseAboveDispatchModeLimit, threadForkService } = deps;

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
    .getThreadRecords(command.sourceThreadId, [
      "runs",
      ...(command.sourcePoint.type === "checkpoint" ? (["checkpoints"] as const) : []),
      "providerThreads",
      "providerTurns",
      "attempts",
    ])
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProjectionError({
            threadId: command.sourceThreadId,
            cause,
          }),
      ),
    );
  // Only side chat forks lock the source; validate the modes copied here, not an earlier read.
  yield* refuseAboveDispatchModeLimit(command, command.sourceThreadId, sourceProjection.thread);
  if (command.sideChat === true && sourceProjection.thread.deletedAt !== null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.sourceThreadId} was deleted.`,
    });
  }
  // The fork would copy no worktree path and run in the project checkout.
  if (
    command.sideChat === true &&
    orchestrationV2WorktreePending(sourceProjection.thread.worktreePath, sourceProjection.runs)
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.sourceThreadId} has no worktree yet. Start the side chat once its worktree is set up.`,
    });
  }
  if ((yield* findThread(command.targetThreadId)) !== null) {
    return yield* new OrchestratorThreadAlreadyExistsError({
      commandId: command.commandId,
      threadId: command.targetThreadId,
    });
  }

  const sourceRun = runForSourcePoint(sourceProjection, command.sourcePoint);

  // A side chat may open during the parent's first turn; it starts from a digest instead.
  if (
    sourceRun === null &&
    !(command.sideChat === true && command.sourcePoint.type === "latest_stable")
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `No stable source run was found for fork source ${command.sourcePoint.type}.`,
    });
  }
  if (sourceRun !== null && !isForkableSourceRunStatus(sourceRun.status)) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: forkableSourceRunStatusError(sourceRun),
    });
  }
  const sourceProviderThread =
    sourceRun === null ? undefined : providerThreadForRun(sourceProjection, sourceRun);
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
      sourceTokenUsage:
        sourceRun === null
          ? undefined
          : providerTurnForRun(sourceProjection, sourceRun)?.tokenUsage,
      canonicalSourcePoint:
        sourceRun === null
          ? { threadId: sourceProjection.thread.id }
          : contextSourcePointForRun(sourceProjection, sourceRun),
      transferId,
      targetThreadId: command.targetThreadId,
      ...(command.title === undefined ? {} : { title: command.title }),
      ...(command.sideChat ? { sideChat: true } : {}),
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
    providerInstanceId: transfer.sourceProviderInstanceId ?? targetThread.providerInstanceId,
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
    .getThreadRecords(command.sourceThreadId, [
      "runs",
      "checkpoints",
      "providerThreads",
      "providerTurns",
      "attempts",
      "contextTransfers",
    ])
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProjectionError({
            threadId: command.sourceThreadId,
            cause,
          }),
      ),
    );
  // The source is unlocked; validate the modes copied here, not an earlier read.
  yield* refuseAboveDispatchModeLimit(command, command.sourceThreadId, sourceProjection.thread);
  const targetProjection = yield* projectionStore
    .getThreadRecords(command.targetThreadId, ["runs", "contextTransfers"])
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
  // Queued runs cannot consume merge-back context. Refuse under the target's
  // command lock before a pending transfer can block its ordinary messages.
  if (targetProjection.runs.some((run) => isActiveRun(run) || run.status === "queued")) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause:
        "Finish or stop the target thread's active work and clear its queue before merging back.",
    });
  }
  const otherPendingMergeBack = targetProjection.contextTransfers.some(
    (transfer) =>
      transfer.type === "merge_back" &&
      transfer.status === "pending" &&
      transfer.targetThreadId === command.targetThreadId &&
      transfer.sourceThreadId !== command.sourceThreadId,
  );
  if (otherPendingMergeBack) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.targetThreadId} already has pending context from another side chat or fork. Send a message there first.`,
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
  if (sourceRun.status !== "completed" && sourceRun.status !== "waiting") {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Merge-back source run ${sourceRun.id} is ${sourceRun.status}; only provider-finished runs are supported.`,
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

const subagentCount = (threadId: ThreadId) =>
  projectionStore
    .getSubagentCount(threadId)
    .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));

  return { dispatchThreadFork, dispatchThreadMergeBack, subagentCount };
});

export type DispatchThreadMergeBackPart = ReturnType<typeof installDispatchThreadMergeBack> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchThreadMergeBack>;
