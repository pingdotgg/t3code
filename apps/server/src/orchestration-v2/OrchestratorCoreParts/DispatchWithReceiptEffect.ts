import { CommandId, type OrchestrationV2ServerCommand, type OrchestrationV2Run, type OrchestrationV2StoredEvent, type OrchestrationV2Subagent, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { runOutcome } from "../RestartBackgroundNote.ts";
import { withCommandMetrics } from "../../observability/Metrics.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { DispatchModeLimit } from "../DispatchModeLimit.ts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { OrchestratorDispatchError, OrchestratorCommandRejectedError, OrchestratorProjectionError, OrchestratorThreadAboveModeLimitError } from "../orchestrationErrors.ts";
import { commandThreadId, delegatedTaskTerminalStatus } from "../orchestrationCommandQueries.ts";
import { OrchestratorCommandIdConflictError, OrchestratorCommandPreviouslyRejectedError, OrchestratorRuntimeModeAboveCeilingError, isTerminalDelegatedTaskStatus, mayStartSubagentFollowup, runtimePolicyCeilingCause, type OrchestratorV2DispatchResult, type OrchestratorV2Error } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";
import type { DispatchSteerIntoRunPart } from "./DispatchSteerIntoRun.ts";
import type { SettleInterruptedRunPart } from "./SettleInterruptedRun.ts";
import type { SettleBackgroundWorkPart } from "./SettleBackgroundWork.ts";
import type { DispatchRunInterruptPart } from "./DispatchRunInterrupt.ts";
import type { DispatchRuntimeRequestRespondPart } from "./DispatchRuntimeRequestRespond.ts";
import type { DispatchThreadMergeBackPart } from "./DispatchThreadMergeBack.ts";
import type { DispatchDelegatedTaskRequestPart } from "./DispatchDelegatedTaskRequest.ts";
import type { DispatchRemoteDelegatedTaskCompletePart } from "./DispatchRemoteDelegatedTaskComplete.ts";
import type { DispatchSubagentStopPart } from "./DispatchSubagentStop.ts";
import type { FinalizeAppOwnedSubagentTaskPart } from "./FinalizeAppOwnedSubagentTask.ts";
import type { DispatchOncePart } from "./DispatchOnce.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart & DispatchRuntimeRequestRespondPart & DispatchThreadMergeBackPart & DispatchDelegatedTaskRequestPart & DispatchRemoteDelegatedTaskCompletePart & DispatchSubagentStopPart & FinalizeAppOwnedSubagentTaskPart & DispatchOncePart;

export const installDispatchWithReceiptEffect = Effect.fnUntraced(function* (deps: Deps) {
  const { appOwnedSubagentParentThreadId, childAwaitsRestartContinuation, commandReceipts, dispatchOnce, eventSink, finalizeAppOwnedSubagentTask, findThread, idAllocator, liveSideChatIds, mapDelegatedCompletionError, offerDelegatedCompletionDeliveries, offerDelegatedCompletionDelivery, projectionStore, refuseAboveDispatchModeLimit, refuseAboveRuntimeModeCeiling, runtimeModeCeiling, startNextQueuedRun, threadDispatch, writeSystemEvents } = deps;

const finalizeAppOwnedSubagent = Effect.fn("Orchestrator.finalizeAppOwnedSubagent")(function* (
  childThreadId: ThreadId,
  options?: { readonly settledContinuationOf?: RunId; readonly syncRunId?: RunId },
) {
  const childControls = yield* projectionStore.getThreadRecords(
    childThreadId,
    ["runs", "messages", "subagents", "providerThreads", "providerTurns", "attempts"],
    { messageRoles: ["user"] },
  );
  const parentThreadId = childControls.thread.lineage.parentThreadId;
  if (
    childControls.thread.lineage.relationshipToParent !== "subagent" ||
    parentThreadId === null ||
    childControls.thread.forkedFrom?.type !== "node"
  )
    return;
  const progress = delegatedTaskProgress(childControls);
  const parent = yield* projectionStore.getThreadRecords(parentThreadId, [
    "subagents",
    "contextTransfers",
  ]);
  for (const task of parent.subagents) {
    if (
      task.origin !== "app_owned" ||
      task.childThreadId !== childThreadId ||
      (task.id === childControls.thread.forkedFrom.nodeId &&
        progress.state !== "result_available") ||
      (task.result !== null &&
        parent.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
        ))
    )
      continue;
    yield* finalizeAppOwnedSubagentTask(childControls, {
      ...options,
      task,
      ...(progress.resultRun === undefined ? {} : { resultRun: progress.resultRun }),
    });
  }

  const { resultRun } = progress;
  if (progress.state !== "result_available" || resultRun === undefined) return;
  const status = delegatedTaskTerminalStatus(runOutcome(resultRun));
  if (status !== "cancelled" && status !== "interrupted") return;
  if (
    yield* childAwaitsRestartContinuation(
      childControls.runs,
      resultRun,
      options?.settledContinuationOf,
    )
  )
    return;
  // Callers hold the parent lock; dismiss takes the child lock, as follow-up intake does.
  const { runtimeRequests } = yield* projectionStore.getThreadRecords(childThreadId, [
    "runtimeRequests",
  ]);
  const pendingQuestions = runtimeRequests.filter(
    (request) =>
      request.status === "pending" &&
      request.kind === "user_input" &&
      request.responseCapability.type === "message",
  );
  if (pendingQuestions.length === 0) return;
  const { nodes } = yield* projectionStore.getThreadRecords(childThreadId, ["nodes"]);
  const resultRunIds = new Set<RunId>();
  let run: OrchestrationV2Run | undefined = resultRun;
  while (run !== undefined && !resultRunIds.has(run.id)) {
    resultRunIds.add(run.id);
    const previousRunId: RunId | undefined = run.restartContinuationOfRunId;
    run =
      previousRunId === undefined
        ? undefined
        : childControls.runs.find((candidate) => candidate.id === previousRunId);
  }
  for (const request of pendingQuestions) {
    if (
      nodes.some(
        (node) =>
          node.id === request.nodeId && node.runId !== null && resultRunIds.has(node.runId),
      )
    ) {
      yield* dispatchWithReceipt({
        type: "thread.user-input.dismiss",
        commandId: CommandId.make(`command:system:delegated-task-question:${request.id}`),
        threadId: childThreadId,
        requestId: request.id,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to dismiss task question", {
            requestId: request.id,
            cause,
          }),
        ),
      );
    }
  }
});

const finalizeDelegatedCompletionDelivery = Effect.fn(
  "Orchestrator.finalizeDelegatedCompletionDelivery",
)(function* (threadId: ThreadId, runId: RunId) {
  // Ordinary turns do not own a delegated delivery. Read just their input
  // before loading the cohort state needed to settle an actual delivery.
  const message = yield* projectionStore.getRunMessage(threadId, runId);
  if (message?.delegatedCompletion === undefined) return;
  const projection = yield* projectionStore.getThreadRecords(
    threadId,
    ["runs", "messages", "subagents"],
    {
      runIds: [runId, message.delegatedCompletion.parentRunId],
      messageIds: [message.id],
      subagentRunIds: [message.delegatedCompletion.parentRunId],
    },
  );
  const deliveryRun = projection.runs.find((candidate) => candidate.id === runId);
  const deliveryMessage =
    deliveryRun === undefined
      ? undefined
      : projection.messages.find((candidate) => candidate.id === deliveryRun.userMessageId);
  const messageOwnership = deliveryMessage?.delegatedCompletion;
  if (deliveryRun === undefined || messageOwnership === undefined) {
    return;
  }
  const parentRun = projection.runs.find(
    (candidate) => candidate.id === messageOwnership.parentRunId,
  );
  const cohort = parentRun?.delegatedCompletion;
  const delivery = cohort?.delivery;
  if (
    parentRun === undefined ||
    cohort === undefined ||
    delivery === null ||
    delivery === undefined ||
    delivery.messageId !== deliveryRun.userMessageId ||
    delivery.generation !== messageOwnership.generation
  ) {
    return;
  }

  const now = yield* DateTime.now;
  const nextTaskStates = new Map<
    OrchestrationV2Subagent["id"],
    OrchestrationV2Subagent["completionDelivery"]
  >();
  for (const task of projection.subagents) {
    if (
      task.origin !== "app_owned" ||
      task.runId !== parentRun.id ||
      !delivery.taskIds.includes(task.id) ||
      task.completionDelivery?.state !== "claimed"
    ) {
      continue;
    }
    nextTaskStates.set(task.id, {
      state: deliveryRun.status === "cancelled" ? "pending" : "delivered",
      observedByRunId: null,
    });
  }
  const pendingTaskIds = projection.subagents
    .filter(
      (task) =>
        task.origin === "app_owned" &&
        task.runId === parentRun.id &&
        isTerminalDelegatedTaskStatus(task.status) &&
        (task.completionDelivery?.state === "pending" ||
          nextTaskStates.get(task.id)?.state === "pending"),
    )
    .map((task) => task.id);
  const canReserveFollowUp =
    cohort.disposition === "open" &&
    projection.thread.archivedAt === null &&
    projection.thread.deletedAt === null &&
    pendingTaskIds.length > 0;
  const nextDelivery = canReserveFollowUp
    ? {
        generation: cohort.nextGeneration,
        messageId: yield* mapDelegatedCompletionError(
          idAllocator.allocate.message({
            threadId,
            ordinal:
              (yield* mapDelegatedCompletionError(
                projectionStore.getMessageCount(projection.thread.id),
              )) + 1,
          }),
        ),
        taskIds: pendingTaskIds,
      }
    : null;
  if (nextDelivery !== null) {
    for (const taskId of pendingTaskIds) {
      nextTaskStates.set(taskId, {
        state: "claimed",
        observedByRunId: null,
      });
    }
  }
  const updatedParentRun: OrchestrationV2Run = {
    ...parentRun,
    delegatedCompletion: {
      ...cohort,
      nextGeneration: nextDelivery === null ? cohort.nextGeneration : cohort.nextGeneration + 1,
      delivery: nextDelivery,
    },
  };
  const taskEvents = projection.subagents.flatMap((task) => {
    const completionDelivery = nextTaskStates.get(task.id);
    if (completionDelivery === undefined) {
      return [];
    }
    return [
      {
        type: "subagent.updated" as const,
        threadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: {
          ...task,
          completionDelivery,
          updatedAt: now,
        },
      },
    ];
  });
  yield* writeSystemEvents([
    ...taskEvents,
    {
      type: "run.updated",
      threadId,
      runId: updatedParentRun.id,
      ...(updatedParentRun.rootNodeId === null ? {} : { nodeId: updatedParentRun.rootNodeId }),
      providerInstanceId: updatedParentRun.providerInstanceId,
      occurredAt: now,
      payload: updatedParentRun,
    },
  ]);
  if (nextDelivery !== null) {
    yield* offerDelegatedCompletionDelivery(threadId, parentRun.id);
  }
});

const dispatchWithReceiptEffect = Effect.fn("orchestrationV2.dispatch.withReceipt")(function* (
  command: OrchestrationV2ServerCommand,
  sideChatIds: ReadonlyArray<ThreadId> = [],
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
    const dispatchThreadId = commandThreadId(command);
    // Receipts only prove execution for the thread they were recorded against.
    if (receipt.threadId !== dispatchThreadId) {
      return yield* new OrchestratorCommandIdConflictError({
        commandId: command.commandId,
        commandType: command.type,
        receiptThreadId: receipt.threadId,
        commandThreadId: dispatchThreadId,
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
    if (command.type === "queue.resume" || command.type === "queued-run.start") {
      yield* mapDispatchError(command)(
        startNextQueuedRun(
          command.threadId,
          command.type === "queued-run.start" ? { queuedRunId: command.runId } : undefined,
        ),
      );
    }
    return {
      sequence: receipt.resultSequence,
      storedEvents,
      replayed: true,
    } satisfies OrchestratorV2DispatchResult;
  }

  // Recheck under the lock; the user may have raised modes since sender preflight.
  const limit = yield* DispatchModeLimit;
  if (limit !== undefined) {
    // Fork and merge-back sources are unlocked; validate the modes copied by their dispatch.
    const threadId = commandThreadId(command);
    const shell = yield* projectionStore
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    if (shell !== null) yield* refuseAboveDispatchModeLimit(command, threadId, shell);
  }

  const plan = yield* dispatchOnce(command, sideChatIds).pipe(
    Effect.tap((planned) => refuseAboveRuntimeModeCeiling(command, planned.events)),
    Effect.filterOrFail(
      (planned) =>
        planned.events.length > 0 ||
        command.type === "thread.background-work.settle" ||
        command.type === "thread.interrupt.unresponsive" ||
        command.type === "thread.stop" ||
        command.type === "subagent.stop" ||
        // Closing a share again, or after it ended, is not an error.
        command.type === "thread.guest-share.close" ||
        (command.type === "thread.delete" && command.onlyIfUnused === true),
      (_planned) =>
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Command produced no domain events.",
        }),
    ),
    Effect.catch((cause) =>
      Effect.gen(function* () {
        // Refusals depend on modes the user can change; a recorded rejection would block the retry.
        if (
          cause._tag === "OrchestratorThreadAboveModeLimitError" ||
          cause._tag === "OrchestratorRuntimeModeAboveCeilingError"
        ) {
          return yield* cause;
        }
        // Resolving a turn's policy refuses the same way, from inside the decision.
        const ceiling = runtimePolicyCeilingCause(cause);
        if (ceiling !== undefined) {
          const { threadId, runtimeMode, maxRuntimeMode, organization } = ceiling;
          return yield* new OrchestratorRuntimeModeAboveCeilingError({
            commandId: command.commandId,
            threadId,
            refused: "turn",
            runtimeMode,
            maxRuntimeMode,
            organization,
          });
        }
        const rejectedAt = yield* DateTime.now;
        const receipt = yield* eventSink
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
        if (
          command.type === "queued-run.edit" &&
          receipt.status === "rejected" &&
          cause._tag === "OrchestratorDispatchError"
        ) {
          return yield* new OrchestratorCommandRejectedError({
            commandId: cause.commandId,
            commandType: cause.commandType,
            cause: cause.cause,
          });
        }
        return yield* cause;
      }),
    ),
  );

  if (plan.events.length === 0 && plan.effects.length === 0) {
    // A settle that ended nothing still records its receipt: a replayed Stop
    // effect then finds it instead of settling work that appeared since.
    const { resultSequence, inserted } = yield* Effect.gen(function* () {
      const sequence = yield* eventSink.latestSequence({ threadId: commandThreadId(command) });
      const inserted = yield* commandReceipts.insertIfAbsent({
        commandId: command.commandId,
        threadId: commandThreadId(command),
        commandType: command.type,
        acceptedAt: yield* DateTime.now,
        resultSequence: sequence,
        status: "accepted",
        error: null,
      });
      return { resultSequence: sequence, inserted };
    }).pipe(
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
      sequence: resultSequence,
      storedEvents: [],
      ...(inserted ? {} : { replayed: true as const }),
    } satisfies OrchestratorV2DispatchResult;
  }
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
      ...(plan.updateDelegatedCompletionOnlyRunId === undefined
        ? {}
        : { updateDelegatedCompletionOnlyRunId: plan.updateDelegatedCompletionOnlyRunId }),
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
  if (
    command.type === "queue.resume" ||
    command.type === "queued-run.start" ||
    (command.type === "thread.runtime-mode.set" && runtimeModeCeiling !== undefined)
  ) {
    yield* mapDispatchError(command)(
      startNextQueuedRun(
        command.threadId,
        command.type === "queued-run.start" ? { queuedRunId: command.runId } : undefined,
      ),
    );
  }
  if (command.type === "notification.delivery.accept") {
    yield* mapDispatchError(command)(offerDelegatedCompletionDeliveries(command.threadId));
  }
  if (
    command.type === "delegated_task.wake-policy" ||
    command.type === "delegated_task.remote.complete"
  ) {
    yield* mapDispatchError(command)(offerDelegatedCompletionDeliveries(command.parentThreadId));
  }

  return {
    sequence: committed.receipt.resultSequence,
    storedEvents: committed.storedEvents,
    ...(committed.committed ? {} : { replayed: true as const }),
  } satisfies OrchestratorV2DispatchResult;
}, withCommandMetrics);

const dispatchWithReceipt = Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
  const dispatch = threadDispatch.withLock(
    commandThreadId(command),
    dispatchWithReceiptEffect(command),
  );
  // A parent's lock comes before its side chats' locks, so a delete cascade and a side chat
  // fork or command never interleave. A fork from a side chat or onto an existing thread would
  // invert that order; dispatch rejects both, so they skip the source lock.
  if (
    command.type === "thread.fork" &&
    command.sideChat === true &&
    command.sourceThreadId !== command.targetThreadId
  ) {
    const source = yield* findThread(command.sourceThreadId);
    const target = yield* findThread(command.targetThreadId);
    return yield* source === null || source.lineage.sideChat === true || target !== null
      ? dispatch
      : threadDispatch.withLock(command.sourceThreadId, dispatch);
  }
  if (command.type === "thread.delete")
    return yield* threadDispatch.withLock(
      command.threadId,
      liveSideChatIds(command.threadId).pipe(
        Effect.flatMap((sideChatIds) =>
          sideChatIds.reduce(
            (locked, sideChatId) => threadDispatch.withLock(sideChatId, locked),
            dispatchWithReceiptEffect(command, sideChatIds),
          ),
        ),
      ),
    );
  // Answering a message-mode question can also start a follow-up.
  if (
    command.type !== "runtime-request.respond" &&
    (command.type !== "message.dispatch" || !mayStartSubagentFollowup(command))
  )
    return yield* dispatch;
  const parentThreadId = yield* appOwnedSubagentParentThreadId(command.threadId).pipe(
    Effect.mapError(
      (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
    ),
  );
  // Follow-up intake and Stop serialize on the parent before taking the child lock.
  return yield* parentThreadId === undefined
    ? dispatch
    : threadDispatch.withLock(parentThreadId, dispatch);
});

  return { finalizeAppOwnedSubagent, finalizeDelegatedCompletionDelivery, dispatchWithReceiptEffect, dispatchWithReceipt };
});

export type DispatchWithReceiptEffectPart = ReturnType<typeof installDispatchWithReceiptEffect> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchWithReceiptEffect>;
