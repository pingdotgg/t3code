import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { OrchestrationV2Command, type OrchestrationV2ServerCommand, type OrchestrationV2DomainEvent, type OrchestrationV2ExecutionNode, type OrchestrationV2Subagent, type OrchestrationV2TurnItem, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { isActiveRun } from "../CommandPolicy.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { providerTurnForRun } from "../orchestrationCommandQueries.ts";
import { mayStartSubagentFollowup } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart;

export const installRecordSubagentFollowup = Effect.fnUntraced(function* (deps: Deps) {
  const { emit, idAllocator, nextTurnItemOrdinal, projectionStore, providerAdapters } = deps;

const recordSubagentFollowup = Effect.fnUntraced(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  if (!mayStartSubagentFollowup(command)) return;
  const pending = yield* Ref.get(events);
  const message = pending
    .flatMap((event) =>
      event.type === "message.updated" && event.payload.id === command.messageId
        ? [event.payload]
        : [],
    )
    .at(-1);
  if (message?.runId == null) return;
  // Only new attempts can own tasks; steers join an existing snapshot that cannot settle newly bound tasks.
  const startsAttempt = pending.some(
    (event) =>
      (event.type === "run.created" && event.payload.id === message.runId) ||
      (event.type === "run-attempt.created" && event.payload.runId === message.runId),
  );
  if (!startsAttempt) return;
  const child = yield* projectionStore.getThread(command.threadId);
  const parentThreadId = child.lineage.parentThreadId;
  if (
    child.lineage.relationshipToParent !== "subagent" ||
    parentThreadId === null ||
    (command.notification === undefined &&
      command.createdBy !== "user" &&
      command.senderThreadId !== parentThreadId)
  )
    return;
  const run =
    pending
      .flatMap((event) =>
        (event.type === "run.created" || event.type === "run.updated") &&
        event.payload.id === message.runId
          ? [event.payload]
          : [],
      )
      .at(-1) ??
    (yield* projectionStore.getThreadRecords(command.threadId, ["runs"])).runs.find(
      (row) => row.id === message.runId,
    );
  if (run === undefined || run.delegatedTaskId !== undefined) return;
  const parent = yield* projectionStore
    .getThreadRecords(parentThreadId, ["runs", "subagents", "providerTurns", "attempts"], {
      subagentIds: child.forkedFrom?.type === "node" ? [child.forkedFrom.nodeId] : [],
    })
    .pipe(mapDispatchError(command));
  const original = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.childThreadId === child.id &&
      task.id === (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined),
  );
  if (original === undefined || original.result === null) return;
  const owner =
    parent.runs.filter(isActiveRun).toSorted((a, b) => b.ordinal - a.ordinal)[0] ??
    latestExecutedRun(parent.runs);
  if (owner === null || owner.rootNodeId === null) return;
  const now = message.createdAt;
  const adapter = yield* providerAdapters.get(run.providerInstanceId);
  const taskId = idAllocator.derive.delegatedTaskNode({ commandId: command.commandId });
  const task: OrchestrationV2Subagent = {
    ...original,
    createdBy: command.createdBy,
    driver: adapter.driver,
    id: taskId,
    runId: owner.id,
    parentNodeId: owner.rootNodeId,
    providerInstanceId: run.providerInstanceId,
    providerThreadId: run.providerThreadId,
    model: run.modelSelection.model,
    modelSelection: run.modelSelection,
    prompt: command.text,
    title: child.title,
    completionWake: "always",
    completionDelivery: { state: "pending", observedByRunId: null },
    status: run.status === "queued" ? (run.queueHeld === true ? "idle" : "pending") : "running",
    progress: undefined,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  const node: OrchestrationV2ExecutionNode = {
    id: taskId,
    threadId: parentThreadId,
    runId: owner.id,
    parentNodeId: owner.rootNodeId,
    rootNodeId: owner.rootNodeId,
    kind: "subagent",
    status: task.status,
    countsForRun: false,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
  const turnItem: OrchestrationV2TurnItem = {
    id: idAllocator.derive.delegatedTaskTurnItem({ commandId: command.commandId }),
    threadId: parentThreadId,
    runId: owner.id,
    nodeId: taskId,
    providerThreadId: owner.providerThreadId,
    providerTurnId: providerTurnForRun(parent, owner)?.id ?? null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: yield* nextTurnItemOrdinal(parent),
    status: task.status,
    title: child.title,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId: taskId,
    origin: "app_owned",
    driver: task.driver,
    providerInstanceId: task.providerInstanceId,
    childThreadId: child.id,
    prompt: command.text,
    result: null,
  };
  const emitEvent = emit(events, command);
  yield* emitEvent({
    type: "run.updated",
    threadId: child.id,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, delegatedTaskId: taskId },
  });
  yield* emitEvent({
    type: "node.updated",
    threadId: parentThreadId,
    runId: owner.id,
    nodeId: taskId,
    occurredAt: now,
    payload: node,
  });
  yield* emitEvent({
    type: "subagent.updated",
    threadId: parentThreadId,
    runId: owner.id,
    nodeId: taskId,
    occurredAt: now,
    payload: task,
  });
  yield* emitEvent({
    type: "turn-item.updated",
    threadId: parentThreadId,
    runId: owner.id,
    nodeId: taskId,
    occurredAt: now,
    payload: turnItem,
  });
});

const stopReachedRun = (
  command: OrchestrationV2ServerCommand,
  threadId: ThreadId,
  runId: RunId,
) =>
  projectionStore
    .getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["run_interrupt_request"],
      turnItemRunIds: [runId],
    })
    .pipe(
      Effect.map(({ turnItems }) => turnItems.length > 0),
      mapDispatchError(command),
    );

  return { recordSubagentFollowup, stopReachedRun };
});

export type RecordSubagentFollowupPart = ReturnType<typeof installRecordSubagentFollowup> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRecordSubagentFollowup>;
