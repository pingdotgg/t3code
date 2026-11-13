import { OrchestrationV2Command, type OrchestrationV2InternalCommand, type OrchestrationV2AppThread, type OrchestrationV2ContextTransfer, type OrchestrationV2DomainEvent, type OrchestrationV2ExecutionNode, type OrchestrationV2Subagent, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { isActiveRun } from "../CommandPolicy.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { makeSubagentChildThread, subagentThreadTitle } from "@t3tools/provider-core/server/subagentProjection";
import { OrchestratorDispatchError, OrchestratorProjectionError, OrchestratorProviderAdapterError } from "../orchestrationErrors.ts";
import { contextSourcePointForRun, providerTurnForRun } from "../orchestrationCommandQueries.ts";
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

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart & DispatchRuntimeRequestRespondPart & DispatchThreadMergeBackPart;

export const installDispatchDelegatedTaskRequest = Effect.fnUntraced(function* (deps: Deps) {
  const { dispatchMessage, emit, getProjectionWithPendingEvents, idAllocator, nextTurnItemOrdinal, projectionStore, providerAdapters, stopReachedRun, subagentCount } = deps;

const dispatchDelegatedTaskRequest = Effect.fn("orchestrationV2.dispatch.delegatedTaskRequest")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const parentProjection = yield* projectionStore
      .getThreadRecords(
        command.parentThreadId,
        ["runs", "nodes", "providerThreads", "providerTurns", "attempts"],
        // The parent node must belong to the active run, whose nodes this keeps.
        { omitSettledLeafNodes: true },
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
    const parentRun = parentProjection.runs.find(
      (candidate) => candidate.id === command.parentRunId,
    );
    if (parentRun === undefined || !isActiveRun(parentRun)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Parent run ${command.parentRunId} is not active.`,
      });
    }
    if (yield* stopReachedRun(command, command.parentThreadId, parentRun.id)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Parent run ${command.parentRunId} is stopping.`,
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
      ordinal: (yield* subagentCount(command.parentThreadId)) + 1,
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
      ...(command.workspaceStrategy === undefined ? {} : { branch: null, worktreePath: null }),
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
      ...(command.completionWake === undefined ? {} : { completionWake: command.completionWake }),
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
      ordinal: yield* nextTurnItemOrdinal(parentProjection),
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
      senderThreadId: command.parentThreadId,
      messageId: childMessageId,
      text: command.task,
      attachments: [],
      modelSelection: command.modelSelection,
      dispatchMode:
        command.workspaceStrategy === undefined
          ? { type: "start_immediately" }
          : { type: "defer_start", workspaceStrategy: command.workspaceStrategy },
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

const dispatchRemoteDelegatedTaskRequest = Effect.fn(
  "orchestrationV2.dispatch.remoteDelegatedTaskRequest",
)(function* (
  command: Extract<
    OrchestrationV2InternalCommand,
    { readonly type: "delegated_task.remote.request" }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const parentProjection = yield* projectionStore
    .getThreadRecords(command.parentThreadId, ["runs", "providerTurns", "attempts"])
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
      ),
    );
  const parentRun = parentProjection.runs.find(
    (candidate) => candidate.id === command.parentRunId,
  );
  if (parentRun === undefined || !isActiveRun(parentRun) || parentRun.rootNodeId === null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Parent run ${command.parentRunId} is not active.`,
    });
  }
  if (yield* stopReachedRun(command, command.parentThreadId, parentRun.id)) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Parent run ${command.parentRunId} is stopping.`,
    });
  }
  const now = yield* DateTime.now;
  const taskNodeId = idAllocator.derive.delegatedTaskNode({ commandId: command.commandId });
  const taskTurnItemId = idAllocator.derive.delegatedTaskTurnItem({
    commandId: command.commandId,
  });
  const taskTitle = subagentThreadTitle({
    parentTitle: parentProjection.thread.title,
    prompt: command.task,
    ...(command.title === undefined ? {} : { title: command.title }),
    ordinal: (yield* subagentCount(command.parentThreadId)) + 1,
  });
  const common = {
    threadId: command.parentThreadId,
    runId: parentRun.id,
    nodeId: taskNodeId,
    driver: command.driver,
    providerInstanceId: command.modelSelection.instanceId,
    occurredAt: now,
  };
  const emitEvent = emit(events, command);
  yield* emitEvent({
    ...common,
    type: "node.updated",
    payload: {
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
    },
  });
  yield* emitEvent({
    ...common,
    type: "subagent.updated",
    payload: {
      id: taskNodeId,
      threadId: command.parentThreadId,
      runId: parentRun.id,
      parentNodeId: command.parentNodeId,
      origin: "app_owned",
      createdBy: "agent",
      driver: command.driver,
      providerInstanceId: command.modelSelection.instanceId,
      providerThreadId: null,
      childThreadId: null,
      remoteChild: command.remoteChild,
      nativeTaskRef: null,
      prompt: command.task,
      title: command.title ?? null,
      model: command.modelSelection.model,
      ...(command.completionWake === undefined ? {} : { completionWake: command.completionWake }),
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    },
  });
  yield* emitEvent({
    ...common,
    type: "turn-item.updated",
    payload: {
      id: taskTurnItemId,
      threadId: command.parentThreadId,
      runId: parentRun.id,
      nodeId: taskNodeId,
      providerThreadId: parentRun.providerThreadId,
      providerTurnId: providerTurnForRun(parentProjection, parentRun)?.id ?? null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* nextTurnItemOrdinal(parentProjection),
      status: "running",
      title: command.title ?? taskTitle,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "subagent",
      subagentId: taskNodeId,
      origin: "app_owned",
      driver: command.driver,
      providerInstanceId: command.modelSelection.instanceId,
      childThreadId: null,
      remoteChild: command.remoteChild,
      prompt: command.task,
      result: null,
    },
  });
});

  return { dispatchDelegatedTaskRequest, dispatchRemoteDelegatedTaskRequest };
});

export type DispatchDelegatedTaskRequestPart = ReturnType<typeof installDispatchDelegatedTaskRequest> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchDelegatedTaskRequest>;
