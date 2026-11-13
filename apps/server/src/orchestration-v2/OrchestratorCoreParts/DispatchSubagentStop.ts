import { latestExecutedRun, runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { isOrchestrationV2WorkActive, OrchestrationV2Command, type OrchestrationV2ServerCommand, type OrchestrationV2DomainEvent, type OrchestrationV2ExecutionNode, type OrchestrationV2Run, type OrchestrationV2ThreadProjection, RunId, ThreadId } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { isActiveRun } from "../CommandPolicy.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { makeCheckpointHandlers } from "../handlers/checkpointHandlers.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { type ProjectionRecords } from "../ProjectionStore.ts";
import { OrchestratorDispatchError, OrchestratorProjectionError, isOrchestratorProjectionError } from "../orchestrationErrors.ts";
import { cancelledAppOwnedTask, delegatedTasksStopEffect, hasLiveRun } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
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

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart & DispatchRuntimeRequestRespondPart & DispatchThreadMergeBackPart & DispatchDelegatedTaskRequestPart & DispatchRemoteDelegatedTaskCompletePart;

export const installDispatchSubagentStop = Effect.fnUntraced(function* (deps: Deps) {
  const { awaitsRestartContinuation, commandPolicy, dispatchRunInterrupt, emit, fileSystem, holdStoppedThread, loadProjectionForCommand, markStoppedRun, path, projectionStore, projects, providerAdapters, writeAppOwnedTask } = deps;

const dispatchSubagentStop = Effect.fn("Orchestrator.dispatchSubagentStop")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "subagent.stop" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) {
  const projection = yield* loadProjectionForCommand(command, [
    "runs",
    "subagents",
    "providerThreads",
    "providerTurns",
  ]);
  const run = projection.runs.find((candidate) => candidate.id === command.runId);
  const subagent = projection.subagents.find((candidate) => candidate.id === command.subagentId);
  // User Stop cancels app-owned tasks with no bound child run unless they are the child's
  // original task, regardless of other child work. Bound runs keep their settlement path
  // because results may still arrive; the client's next child stop interrupts the run.
  // Rewrite ended tasks so clients with stale copies see them end.
  if (
    subagent?.origin === "app_owned" &&
    subagent.childThreadId !== null &&
    subagent.runId === command.runId
  ) {
    const childThreadId = subagent.childThreadId;
    const child = yield* projectionStore.getThreadRecords(childThreadId, ["runs"]).pipe(
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: childThreadId, cause }),
      ),
    );
    const active = isOrchestrationV2WorkActive(subagent.status);
    if (
      active &&
      child !== null &&
      ((child.thread.forkedFrom?.type === "node" &&
        child.thread.forkedFrom.nodeId === subagent.id) ||
        child.runs.some((run) => run.delegatedTaskId === subagent.id))
    )
      return;
    const records = yield* loadProjectionForCommand(command, ["nodes", "turnItems"], {
      turnItemTypes: ["subagent"],
      turnItemRunIds: [subagent.runId],
      omitSettledLeafNodes: true,
    });
    const now = yield* DateTime.now;
    return yield* writeAppOwnedTask({
      command,
      events,
      task: active ? cancelledAppOwnedTask(subagent, now) : subagent,
      nodes: records.nodes,
      turnItems: records.turnItems,
      now,
    });
  }
  if (
    subagent === undefined ||
    subagent.runId !== command.runId ||
    subagent.origin !== "provider_native" ||
    subagent.driver !== "claudeAgent" ||
    subagent.nativeTaskRef?.strength !== "strong" ||
    subagent.nativeTaskRef.nativeId === null
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "The requested native subagent cannot be stopped on this run.",
    });
  }
  if (!["pending", "running", "waiting"].includes(subagent.status)) return;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run?.providerThreadId,
  );
  const providerTurn = projection.providerTurns.findLast(
    (candidate) => candidate.providerThreadId === providerThread?.id,
  );
  if (
    providerThread?.providerSessionId == null ||
    providerTurn === undefined ||
    providerThread.driver !== subagent.driver ||
    providerThread.providerInstanceId !== subagent.providerInstanceId
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "The requested native subagent has no owning provider session.",
    });
  }
  const providerSessionId = providerThread.providerSessionId;
  const nativeTaskId = subagent.nativeTaskRef.nativeId;
  const now = yield* DateTime.now;
  yield* emit(
    events,
    command,
  )({
    type: "subagent.updated",
    threadId: command.threadId,
    runId: command.runId,
    nodeId: subagent.id,
    providerInstanceId: subagent.providerInstanceId,
    occurredAt: now,
    payload: { ...subagent, updatedAt: now },
  });
  yield* Ref.update(effects, (existing) => [
    ...existing,
    {
      id: `effect:${command.commandId}:subagent.stop:${subagent.id}`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: {
        type: "provider-turn.interrupt",
        providerSessionId,
        providerThreadId: providerThread.id,
        providerTurnId: providerTurn.id,
        subagent: { id: subagent.id, nativeTaskId },
      },
    } satisfies PendingOrchestrationEffectV2,
  ]);
  return;
});

const cancelIdleOrphans = Effect.fn("Orchestrator.cancelIdleOrphans")(
  function* (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "subagents" | "turnItems">;
  }) {
    const { command, events, projection } = input;
    const pending = yield* Ref.get(events);
    const children = new Map<
      ThreadId,
      ProjectionRecords<"runs" | "providerThreads" | "runtimeRequests" | "turnItems"> | null
    >();
    const idleChildren = new Map<ThreadId, boolean>();
    let nodes: ReadonlyArray<OrchestrationV2ExecutionNode> | undefined;
    for (const recorded of projection.subagents) {
      const updated = pending.findLast(
        (event) => event.type === "subagent.updated" && event.payload.id === recorded.id,
      );
      const task = updated?.type === "subagent.updated" ? updated.payload : recorded;
      if (
        task.origin !== "app_owned" ||
        task.childThreadId === null ||
        !isOrchestrationV2WorkActive(task.status)
      )
        continue;
      const childThreadId = task.childThreadId;
      const child = children.has(childThreadId)
        ? (children.get(childThreadId) ?? null)
        : yield* projectionStore
            .getThreadRecords(
              childThreadId,
              ["runs", "providerThreads", "runtimeRequests", "turnItems"],
              {
                turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
                turnItemStatuses: ["pending", "running", "waiting"],
              },
            )
            .pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
              }),
              Effect.mapError(
                (cause) => new OrchestratorProjectionError({ threadId: childThreadId, cause }),
              ),
            );
      children.set(childThreadId, child);
      if (child === null) continue;
      if (
        child.thread.lineage.parentThreadId !== command.threadId ||
        child.thread.lineage.relationshipToParent !== "subagent" ||
        (child.thread.forkedFrom?.type === "node" &&
          child.thread.forkedFrom.nodeId === task.id) ||
        child.runs.some((run) => run.delegatedTaskId === task.id)
      )
        continue;
      const idle =
        idleChildren.get(task.childThreadId) ??
        (!child.runs.some((run) => run.status === "queued" || isActiveRun(run)) &&
          !child.providerThreads.some(
            (thread) =>
              thread.status === "active" || (thread.pendingBackgroundTasks?.length ?? 0) > 0,
          ) &&
          !child.runtimeRequests.some((request) => request.status === "pending") &&
          child.turnItems.length === 0 &&
          Option.isNone(yield* Effect.findFirst(child.runs, awaitsRestartContinuation)));
      idleChildren.set(task.childThreadId, idle);
      if (!idle) continue;
      // Stop can cancel an idle orphan without guessing which completed run owned its result.
      const now = yield* DateTime.now;
      nodes ??= (yield* projectionStore.getThreadRecords(command.threadId, ["nodes"])).nodes;
      yield* writeAppOwnedTask({
        command,
        events,
        task: cancelledAppOwnedTask(task, now),
        nodes,
        turnItems: projection.turnItems,
        now,
      });
    }
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isOrchestratorProjectionError(cause)
          ? cause
          : new OrchestratorProjectionError({ threadId: input.command.threadId, cause }),
      ),
    ),
);

const dispatchThreadStop = Effect.fn("Orchestrator.dispatchThreadStop")(function* (
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.stop" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) {
  const projection = yield* projectionStore
    .getThreadRecords(command.threadId, ["runs", "providerThreads", "turnItems", "subagents"], {
      turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
      turnItemStatuses: ["pending", "running", "waiting"],
    })
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
  if (projection.thread.deletedAt !== null) return undefined;
  // Queued after the interrupt, since a thread's effects run in order.
  const stopDelegatedTasks =
    command.stopDelegatedTasks === false ||
    !projection.subagents.some(
      (task) => task.origin === "app_owned" && task.childThreadId !== null,
    )
      ? Effect.void
      : Ref.update(effects, (existing) => [...existing, delegatedTasksStopEffect(command)]);
  const latestRun = projection.runs.findLast((run) => run.status !== "queued");
  const target =
    projection.runs.findLast(
      (run) =>
        run.status === "preparing" || run.status === "starting" || run.status === "running",
    ) ??
    (derivePendingBackgroundWork({
      latestRun,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
    }).length > 0
      ? latestRun
      : undefined);
  if (target !== undefined) {
    const interruptEvents = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    const interruptEffects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
    const interrupted = yield* Effect.exit(
      dispatchRunInterrupt(
        {
          type: "run.interrupt",
          commandId: command.commandId,
          threadId: command.threadId,
          runId: target.id,
          holdQueue: true,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        },
        interruptEvents,
        interruptEffects,
      ),
    );
    // A failed interrupt may have written part of its events, so they are kept apart.
    if (Exit.isSuccess(interrupted)) {
      const written = yield* Ref.get(interruptEvents);
      const enqueued = yield* Ref.get(interruptEffects);
      yield* Ref.update(events, (existing) => [...existing, ...written]);
      yield* Ref.update(effects, (existing) => [...existing, ...enqueued]);
      yield* cancelIdleOrphans({ command, events, projection });
      yield* stopDelegatedTasks;
      return interrupted.value;
    }
    yield* Effect.logWarning("thread.stop could not interrupt the running turn", {
      threadId: command.threadId,
      runId: target.id,
      cause: interrupted.cause,
    });
  }
  const now = yield* DateTime.now;
  // Record that Stop reached the turn it could not interrupt and the thread's last executed
  // run, so a late tool call from their agent starts nothing.
  const executed = latestExecutedRun(projection.runs);
  const reached = new Map<RunId, OrchestrationV2Run>();
  if (target !== undefined) reached.set(target.id, target);
  if (executed !== null && !hasLiveRun({ runs: [executed] })) reached.set(executed.id, executed);
  for (const run of reached.values()) {
    yield* markStoppedRun({ command, events, thread: projection.thread, run, now });
  }
  yield* holdStoppedThread({ command, events, projection, cohortRunIds: [], now });
  yield* cancelIdleOrphans({ command, events, projection });
  yield* stopDelegatedTasks;
  return undefined;
});

const { dispatchCheckpointRollback, dispatchCheckpointRollbackFail } = makeCheckpointHandlers({
  projectionStore,
  providerAdapters,
  loadProjectionForCommand: (command, fields, filter) =>
    loadProjectionForCommand(command, fields, filter),
  emit,
  mapDispatchError,
  commandPolicy,
  projects,
  fileSystem,
  path,
});

const appOwnedSubagentParentThreadId = Effect.fn("Orchestrator.appOwnedSubagentParentThreadId")(
  function* (childThreadId: ThreadId) {
    const childThread = yield* projectionStore.getThread(childThreadId);
    const lineage = childThread.lineage;
    return lineage.relationshipToParent === "subagent" &&
      lineage.parentThreadId !== null &&
      childThread.forkedFrom?.type === "node"
      ? lineage.parentThreadId
      : undefined;
  },
);

const childAwaitsRestartContinuation = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  resultRun: OrchestrationV2Run,
  settledContinuationOf?: RunId,
) =>
  Effect.forEach(
    runs.filter(
      (run) =>
        run.id !== settledContinuationOf &&
        (run.id === resultRun.id || runRanAfter(run, resultRun)),
    ),
    awaitsRestartContinuation,
  ).pipe(Effect.map((pending) => pending.includes(true)));

  return { dispatchSubagentStop, cancelIdleOrphans, dispatchThreadStop, dispatchCheckpointRollback, dispatchCheckpointRollbackFail, appOwnedSubagentParentThreadId, childAwaitsRestartContinuation };
});

export type DispatchSubagentStopPart = ReturnType<typeof installDispatchSubagentStop> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchSubagentStop>;
