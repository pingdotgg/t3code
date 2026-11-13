import { OrchestrationV2Command, type OrchestrationV2ServerCommand, type OrchestrationV2ContextTransfer, type OrchestrationV2DomainEvent, type OrchestrationV2Run, type OrchestrationV2Subagent, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { runOutcome } from "../RestartBackgroundNote.ts";
import { makeLifecycleHandlers } from "../handlers/lifecycleHandlers.ts";
import { type ProjectionRecords } from "../ProjectionStore.ts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import { OrchestratorDispatchError } from "../orchestrationErrors.ts";
import { delegatedTaskTerminalStatus, contextSourcePointForRun } from "../orchestrationCommandQueries.ts";
import { hasLiveRun, isTerminalDelegatedTaskStatus, threadHasUnfinishedWork } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
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

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart & DispatchRuntimeRequestRespondPart & DispatchThreadMergeBackPart & DispatchDelegatedTaskRequestPart & DispatchRemoteDelegatedTaskCompletePart & DispatchSubagentStopPart;

export const installFinalizeAppOwnedSubagentTask = Effect.fnUntraced(function* (deps: Deps) {
  const { childAwaitsRestartContinuation, dispatchRuntimeRequestRespond, emit, getProjectionWithPendingEvents, idAllocator, loadProjectionForCommand, mapDelegatedCompletionError, nextTurnItemOrdinal, offerDelegatedCompletionDelivery, planDelegatedCompletionDelivery, projectionStore, projects, releaseGuestAttachments, writeSystemEvents } = deps;

const finalizeAppOwnedSubagentTask = Effect.fn("Orchestrator.finalizeAppOwnedSubagentTask")(
  function* (
    childControls: ProjectionRecords<
      "runs" | "messages" | "subagents" | "providerThreads" | "providerTurns" | "attempts"
    >,
    options: {
      readonly settledContinuationOf?: RunId;
      readonly syncRunId?: RunId;
      readonly task: OrchestrationV2Subagent;
      readonly resultRun?: OrchestrationV2Run;
    },
  ) {
    const childThreadId = childControls.thread.id;
    const forkedFrom = childControls.thread.forkedFrom;
    if (
      childControls.thread.lineage.relationshipToParent !== "subagent" ||
      childControls.thread.lineage.parentThreadId === null ||
      forkedFrom?.type !== "node"
    ) {
      return;
    }
    const taskRuns = childControls.runs.filter((run) => run.delegatedTaskId === options.task.id);
    const childRun =
      taskRuns.length === 0
        ? options.task.id === forkedFrom.nodeId
          ? options.resultRun
          : undefined
        : taskRuns.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    if (childRun === undefined) return;
    const outcome = runOutcome(childRun);
    const terminalStatus = delegatedTaskTerminalStatus(outcome);
    if (terminalStatus === null) {
      if (childRun.delegatedTaskId === undefined || childRun.id !== options.syncRunId) return;
      const task = options.task;
      const status: OrchestrationV2Subagent["status"] =
        childRun.status === "queued"
          ? childRun.queueHeld === true
            ? "idle"
            : "pending"
          : childRun.status === "waiting"
            ? "waiting"
            : "running";
      if (task.result !== null || task.status === status) return;
      const parent = yield* projectionStore.getThreadRecords(
        childControls.thread.lineage.parentThreadId,
        ["nodes", "turnItems"],
        { turnItemTypes: ["subagent"] },
      );
      const now = yield* DateTime.now;
      const scope = {
        threadId: parent.thread.id,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
      };
      const node = parent.nodes.find((row) => row.id === task.id);
      const item = parent.turnItems.find(
        (row) => row.type === "subagent" && row.subagentId === task.id,
      );
      yield* writeSystemEvents([
        {
          ...scope,
          type: "subagent.updated",
          payload: { ...task, status, completedAt: null, updatedAt: now },
        },
        ...(node === undefined
          ? []
          : [
              {
                ...scope,
                type: "node.updated" as const,
                payload: { ...node, status, completedAt: null },
              },
            ]),
        ...(item === undefined
          ? []
          : [
              {
                ...scope,
                type: "turn-item.updated" as const,
                payload: { ...item, status, completedAt: null, updatedAt: now },
              },
            ]),
      ]);
      return;
    }
    if (
      yield* childAwaitsRestartContinuation(
        taskRuns.length === 0 ? childControls.runs : taskRuns,
        childRun,
        options?.settledContinuationOf,
      )
    ) {
      return;
    }

    const childResult = yield* projectionStore.getThreadRecords(
      childThreadId,
      ["messages", "turnItems"],
      {
        messageRoles: ["assistant"],
        messageRunIds: [childRun.id],
        turnItemRunId: childRun.id,
        turnItemTypes: ["assistant_message", "error"],
      },
    );
    const childProjection = {
      ...childControls,
      messages: childResult.messages,
      turnItems: childResult.turnItems,
    };
    const parentThreadId = childControls.thread.lineage.parentThreadId;
    const parentProjection = yield* projectionStore.getThreadRecords(
      parentThreadId,
      [
        "runs",
        "messages",
        "subagents",
        "providerThreads",
        "providerTurns",
        "nodes",
        "turnItems",
        "contextTransfers",
      ],
      { turnItemTypes: ["subagent"], messageRoles: ["user"] },
    );
    const task = parentProjection.subagents.find(
      (candidate) =>
        candidate.id === options.task.id &&
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
        transfer.targetThreadId === parentThreadId &&
        (transfer.sourcePoint.runId === childRun.id ||
          (options.task.id === forkedFrom.nodeId && transfer.sourcePoint.runId === undefined)),
    );
    if (existingResultTransfer !== undefined) {
      return;
    }

    const now = yield* DateTime.now;
    const result = subagentResultForRun(childProjection, { ...childRun, status: outcome });
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
    const completionPlan = yield* planDelegatedCompletionDelivery({
      parentProjection,
      parentRun,
      task,
      updatedTask,
      now,
    });
    const resultTransferId = yield* idAllocator.allocate.contextTransfer({
      sourceThreadId: childThreadId,
      targetThreadId: parentThreadId,
      type: "subagent_result",
    });
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
      resolution: null,
      createdBy: "system",
      error: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: now,
    };

    const completionEvents: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> = [
      {
        type: "subagent.updated",
        threadId: parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        occurredAt: now,
        payload: completionPlan.task,
      },
      ...(completionPlan.parentRun === undefined
        ? []
        : [
            {
              type: "run.updated" as const,
              threadId: parentThreadId,
              runId: completionPlan.parentRun.id,
              ...(completionPlan.parentRun.rootNodeId === null
                ? {}
                : { nodeId: completionPlan.parentRun.rootNodeId }),
              providerInstanceId: completionPlan.parentRun.providerInstanceId,
              occurredAt: now,
              payload: completionPlan.parentRun,
            },
          ]),
      ...(completionPlan.message === undefined
        ? []
        : [
            {
              type: "message.updated" as const,
              threadId: parentThreadId,
              ...(completionPlan.message.runId === null
                ? {}
                : { runId: completionPlan.message.runId }),
              ...(completionPlan.message.nodeId === null
                ? {}
                : { nodeId: completionPlan.message.nodeId }),
              providerInstanceId:
                completionPlan.parentRun?.providerInstanceId ??
                parentProjection.thread.providerInstanceId,
              occurredAt: now,
              payload: completionPlan.message,
            },
          ]),
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
      {
        type: "context-transfer.created",
        threadId: parentThreadId,
        ...(parentRun === undefined ? {} : { runId: parentRun.id }),
        providerInstanceId: childRun.providerInstanceId,
        occurredAt: now,
        payload: resultTransfer,
      },
    ];
    yield* writeSystemEvents(completionEvents, [], { updateDelegatedCompletionOnly: true });

    if (completionPlan.offer && completionPlan.parentRun !== undefined) {
      yield* offerDelegatedCompletionDelivery(parentThreadId, completionPlan.parentRun.id);
    }
  },
);

const dispatchNotificationAccepted = Effect.fn("orchestrationV2.notificationAccepted")(function* (
  command: Extract<OrchestrationV2Command, { type: "notification.delivery.accept" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const projection = yield* getProjectionWithPendingEvents(command.threadId, events);
  const message = projection.messages.find((row) => row.id === command.messageId);
  const ownership = message?.delegatedCompletion;
  const parentRun = projection.runs.find((run) => run.id === ownership?.parentRunId);
  const cohort = parentRun?.delegatedCompletion;
  const delivery = cohort?.delivery;
  const now = yield* DateTime.now;
  const emitEvent = emit(events, command);
  if (
    parentRun === undefined ||
    cohort === undefined ||
    cohort.disposition !== "open" ||
    delivery == null ||
    delivery.messageId !== command.messageId ||
    delivery.generation !== ownership?.generation
  ) {
    yield* emitEvent({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      occurredAt: now,
      payload: projection.thread,
    });
    return;
  }
  const parentIsLive = hasLiveRun({ runs: [parentRun] });
  const pendingTaskIds =
    projection.thread.archivedAt === null && projection.thread.deletedAt === null
      ? projection.subagents
          .filter(
            (task) =>
              task.origin === "app_owned" &&
              task.runId === parentRun.id &&
              task.completionDelivery?.state === "pending" &&
              isTerminalDelegatedTaskStatus(task.status) &&
              (!parentIsLive || task.completionWake === "always"),
          )
          .map((task) => task.id)
      : [];
  const nextDelivery =
    pendingTaskIds.length === 0
      ? null
      : {
          generation: cohort.nextGeneration,
          messageId: yield* mapDelegatedCompletionError(
            idAllocator.allocate.message({
              threadId: command.threadId,
              ordinal:
                (yield* mapDelegatedCompletionError(
                  projectionStore.getMessageCount(projection.thread.id),
                )) + 1,
            }),
          ),
          taskIds: pendingTaskIds,
        };
  const acceptedIds = new Set(delivery.taskIds);
  const pendingIds = new Set(pendingTaskIds);
  for (const task of projection.subagents) {
    const state = pendingIds.has(task.id)
      ? "claimed"
      : acceptedIds.has(task.id) && task.completionDelivery?.state === "claimed"
        ? "delivered"
        : undefined;
    if (state === undefined) continue;
    yield* emitEvent({
      type: "subagent.updated",
      threadId: command.threadId,
      runId: parentRun.id,
      nodeId: task.id,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      occurredAt: now,
      payload: { ...task, completionDelivery: { state, observedByRunId: null }, updatedAt: now },
    });
  }
  yield* emitEvent({
    type: "run.updated",
    threadId: command.threadId,
    runId: parentRun.id,
    providerInstanceId: parentRun.providerInstanceId,
    occurredAt: now,
    payload: {
      ...parentRun,
      delegatedCompletion: {
        ...cohort,
        nextGeneration: cohort.nextGeneration + (nextDelivery === null ? 0 : 1),
        delivery: nextDelivery,
      },
    },
  });
  return parentRun.id;
});

const dispatchUnsupported = (command: OrchestrationV2ServerCommand) =>
  Effect.fail(
    new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
    }),
  );

const { dispatchInterruptUnresponsive, dispatchProviderSessionDetach, dispatchThreadVisit, dispatchQueuedRunReorder, dispatchThreadCreate, dispatchThreadProjectAdoptFolder, dispatchCreatedThreadRecord, dispatchThreadUserInputDismiss, dispatchGuestShare } = makeLifecycleHandlers({
  projectionStore,
  loadProjectionForCommand,
  idAllocator,
  projects,
  nextTurnItemOrdinal,
  releaseGuestAttachments,
  dispatchRuntimeRequestRespond,
  emit,
  threadHasUnfinishedWork,
});

  return { finalizeAppOwnedSubagentTask, dispatchNotificationAccepted, dispatchUnsupported, dispatchInterruptUnresponsive, dispatchProviderSessionDetach, dispatchThreadVisit, dispatchQueuedRunReorder, dispatchThreadCreate, dispatchThreadProjectAdoptFolder, dispatchCreatedThreadRecord, dispatchThreadUserInputDismiss, dispatchGuestShare };
});

export type FinalizeAppOwnedSubagentTaskPart = ReturnType<typeof installFinalizeAppOwnedSubagentTask> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installFinalizeAppOwnedSubagentTask>;
