import { type OrchestrationV2InternalCommand, type OrchestrationV2ServerCommand, type OrchestrationV2DomainEvent, type OrchestrationV2ExecutionNode, type OrchestrationV2Subagent, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { isActiveRun } from "../CommandPolicy.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { endOrphanedNativeSubagent, endRunlessRootTurns } from "@t3tools/provider-core/server/subagentProjection";
import { OrchestratorDispatchError, OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { providerTurnForRun } from "../orchestrationCommandQueries.ts";
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

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart & DispatchRuntimeRequestRespondPart & DispatchThreadMergeBackPart & DispatchDelegatedTaskRequestPart;

export const installDispatchRemoteDelegatedTaskComplete = Effect.fnUntraced(function* (deps: Deps) {
  const { dispatchMessage, emit, emitRemoteStopOwed, idAllocator, nextTurnItemOrdinal, planDelegatedCompletionDelivery, projectionStore, settleBackgroundWork, settleInterruptedRun, stopReachedRun } = deps;

const dispatchRemoteDelegatedTaskComplete = Effect.fn(
  "orchestrationV2.dispatch.remoteDelegatedTaskComplete",
)(function* (
  command: Extract<
    OrchestrationV2InternalCommand,
    { readonly type: "delegated_task.remote.complete" }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  // Delivery planning reads only this task and the undelivered tasks of the queued delivery;
  // the task's own node and turn item are all it updates besides.
  const parentProjection = yield* projectionStore
    .getThreadRecords(
      command.parentThreadId,
      ["runs", "messages", "subagents", "providerTurns", "nodes", "turnItems"],
      {
        turnItemTypes: ["subagent"],
        messageRoles: ["user"],
        omitSettledSubagents: { except: [command.taskId] },
        nodeIds: [command.taskId],
        turnItemNodeIds: [command.taskId],
      },
    )
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
      ),
    );
  const task = parentProjection.subagents.find(
    (candidate) =>
      candidate.id === command.taskId &&
      candidate.origin === "app_owned" &&
      candidate.remoteChild !== undefined,
  );
  if (task === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Delegated task ${command.taskId} is not a remote task of thread ${command.parentThreadId}.`,
    });
  }
  if (
    command.stoppedThere === "stopped" &&
    (command.stopCount ?? 0) !== (task.remoteChild?.stopCount ?? 0)
  )
    return;
  const remoteChild =
    command.stoppedThere === undefined
      ? task.remoteChild
      : { ...task.remoteChild!, stoppedThere: true };
  // The first result stands; a repeated follower report records nothing, which
  // the dispatcher refuses. A stop there after the result is still recorded, but
  // a run that ended by itself does not settle a stop the task here still owes.
  if (task.result !== null) {
    // A Stop or cancel here that lost the race to the result still owes its stop.
    if (command.stoppedThere === undefined) {
      return yield* emitRemoteStopOwed(events, command, task, task.remoteChild!);
    }
    const owesStop =
      task.status === "cancelled" ||
      task.status === "interrupted" ||
      task.remoteChild?.stoppedThere === false;
    if (
      task.remoteChild?.stoppedThere === true ||
      (owesStop && command.stoppedThere !== "stopped")
    )
      return;
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
      payload: { ...task, remoteChild, updatedAt: now },
    });
    return;
  }
  const now = yield* DateTime.now;
  const updatedTask: OrchestrationV2Subagent = {
    ...task,
    remoteChild,
    status: command.status,
    result: command.result,
    completedAt: now,
    updatedAt: now,
  };
  const parentRun =
    task.runId === null
      ? undefined
      : parentProjection.runs.find((candidate) => candidate.id === task.runId);
  const plan = yield* planDelegatedCompletionDelivery({
    parentProjection,
    parentRun,
    task,
    updatedTask,
    now,
  }).pipe(mapDispatchError(command));
  const emitEvent = emit(events, command);
  yield* emitEvent({
    type: "subagent.updated",
    threadId: command.parentThreadId,
    ...(task.runId === null ? {} : { runId: task.runId }),
    nodeId: task.id,
    driver: task.driver,
    occurredAt: now,
    payload: plan.task,
  });
  if (plan.parentRun !== undefined) {
    yield* emitEvent({
      type: "run.updated",
      threadId: command.parentThreadId,
      runId: plan.parentRun.id,
      ...(plan.parentRun.rootNodeId === null ? {} : { nodeId: plan.parentRun.rootNodeId }),
      providerInstanceId: plan.parentRun.providerInstanceId,
      occurredAt: now,
      payload: plan.parentRun,
    });
  }
  if (plan.message !== undefined) {
    yield* emitEvent({
      type: "message.updated",
      threadId: command.parentThreadId,
      ...(plan.message.runId === null ? {} : { runId: plan.message.runId }),
      ...(plan.message.nodeId === null ? {} : { nodeId: plan.message.nodeId }),
      providerInstanceId:
        plan.parentRun?.providerInstanceId ?? parentProjection.thread.providerInstanceId,
      occurredAt: now,
      payload: plan.message,
    });
  }
  const node = parentProjection.nodes.find((candidate) => candidate.id === task.id);
  if (node !== undefined) {
    yield* emitEvent({
      type: "node.updated",
      threadId: command.parentThreadId,
      ...(node.runId === null ? {} : { runId: node.runId }),
      nodeId: node.id,
      driver: task.driver,
      occurredAt: now,
      payload: { ...node, status: command.status, completedAt: now },
    });
  }
  const item = parentProjection.turnItems.find(
    (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
  );
  if (item !== undefined) {
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.parentThreadId,
      ...(item.runId === null ? {} : { runId: item.runId }),
      ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
      driver: task.driver,
      occurredAt: now,
      payload: {
        ...item,
        status: command.status,
        result: command.result,
        completedAt: now,
        updatedAt: now,
      } as OrchestrationV2TurnItem,
    });
  }
});

const dispatchLinkRequestRecord = Effect.fn("orchestrationV2.dispatch.linkRequestRecord")(
  function* (
    command: Extract<OrchestrationV2InternalCommand, { readonly type: "link_request.record" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(
        command.threadId,
        ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
        { turnItemTypes: ["link_request"], messageRoles: [] },
      )
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    if (run === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} was not found.`,
      });
    }
    const existing = projection.turnItems.find((item) => item.id === command.turnItemId);
    if (existing !== undefined && existing.type !== "link_request") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Turn item ${command.turnItemId} is not a link request.`,
      });
    }
    if (existing !== undefined && existing.runId !== command.runId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Link request ${command.turnItemId} belongs to another run.`,
      });
    }
    // Only a new card needs its run's current root and a live run. An answer
    // may land long after a steer restarted the run or the run ended, and the
    // link it reports is already made.
    if (existing === undefined && run.rootNodeId !== command.nodeId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Node ${command.nodeId} is not the root of run ${command.runId}.`,
      });
    }
    if (
      existing === undefined &&
      (!isActiveRun(run) || (yield* stopReachedRun(command, command.threadId, run.id)))
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} is not active.`,
      });
    }
    const nodeId = existing?.nodeId ?? command.nodeId;
    const now = yield* DateTime.now;
    // A request is answered once, and a retry finds its card as it was
    // asked: either one records the card unchanged.
    const unchanged =
      existing !== undefined &&
      (existing.linkStatus !== "pending" || command.linkStatus === "pending");
    const pending = command.linkStatus === "pending";
    const {
      type: _type,
      commandId: _commandId,
      turnItemId: _turnItemId,
      wake,
      ...fields
    } = command;
    const turnItem: OrchestrationV2TurnItem = unchanged
      ? existing
      : {
          ...fields,
          id: command.turnItemId,
          // An update keeps where the card was asked, even after a restart.
          ...(existing === undefined
            ? {
                providerThreadId: run.providerThreadId,
                providerTurnId: providerTurnForRun(projection, run)?.id ?? null,
              }
            : {
                nodeId: existing.nodeId,
                providerThreadId: existing.providerThreadId,
                providerTurnId: existing.providerTurnId,
              }),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: existing?.ordinal ?? (yield* nextTurnItemOrdinal(projection)),
          status: pending
            ? "waiting"
            : command.linkStatus === "linked"
              ? "completed"
              : command.linkStatus === "failed"
                ? "failed"
                : "cancelled",
          title: command.label ?? command.url ?? "Link an environment",
          startedAt: existing?.startedAt ?? now,
          completedAt: pending ? null : now,
          updatedAt: now,
          type: "link_request",
        };
    yield* emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: command.runId,
      nodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: turnItem,
    });
    // The agent asked without waiting, so the answer reaches it as a
    // notification: it starts a turn, or follows the one running. Only the
    // answer that closes the card wakes it, and never a closed thread.
    if (
      wake === undefined ||
      unchanged ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null
    ) {
      return;
    }
    yield* dispatchMessage(
      {
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: wake.messageId,
        text: wake.text,
        notification: wake.notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      },
      events,
      effects,
    );
  },
);

const dispatchBackgroundWorkSettle = Effect.fn("Orchestrator.dispatchBackgroundWorkSettle")(
  function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "thread.background-work.settle" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const [projection, stopped] = yield* Effect.all([
      projectionStore.getThreadRecords(
        command.threadId,
        [
          "runs",
          "attempts",
          "nodes",
          "subagents",
          "runtimeRequests",
          "turnItems",
          "providerThreads",
        ],
        {
          turnItemTypes: [
            "command_execution",
            "dynamic_tool",
            "subagent",
            "assistant_message",
            "reasoning",
          ],
          turnItemStatuses: ["pending", "running", "waiting"],
        },
      ),
      projectionStore.getProviderControlContext(command.threadId, {
        providerThreadId: command.providerThreadId,
        providerTurnId: command.providerTurnId,
      }),
    ]).pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
    if (command.subagent !== undefined) {
      const outcome = command.subagent.outcome;
      const subagent = projection.subagents.find((task) => task.id === command.subagent?.id);
      if (
        subagent?.origin !== "provider_native" ||
        !["pending", "running", "waiting"].includes(subagent.status) ||
        (subagent.startedAt !== null &&
          DateTime.toEpochMillis(subagent.startedAt) >
            DateTime.toEpochMillis(command.subagent.stoppedAt))
      )
        return;
      const now = yield* DateTime.now;
      const allocateEventId = () =>
        idAllocator.allocate.event({
          threadId: command.threadId,
          commandId: command.commandId,
        });
      const ended = yield* endOrphanedNativeSubagent({
        projection,
        subagentId: subagent.id,
        result: outcome.result,
        status: outcome.status,
        completedAt: outcome.completedAt,
        now,
        emitted: yield* Ref.get(events),
        allocateEventId,
      }).pipe(mapDispatchError(command));
      yield* Ref.update(events, (current) => [...current, ...ended]);
      if (subagent.childThreadId !== null) {
        const child = yield* projectionStore
          .getThreadRecords(subagent.childThreadId, ["nodes", "providerTurns", "turnItems"], {
            turnItemRunIds: [null],
            turnItemStatuses: ["pending", "running", "waiting"],
          })
          .pipe(
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
            mapDispatchError(command),
          );
        if (child !== null) {
          const childEnded = yield* endRunlessRootTurns({
            threadId: subagent.childThreadId,
            providerInstanceId: subagent.providerInstanceId,
            projection: child,
            status: outcome.status,
            completedAt: outcome.completedAt,
            now,
            emitted: yield* Ref.get(events),
            allocateEventId,
          }).pipe(mapDispatchError(command));
          yield* Ref.update(events, (current) => [...current, ...childEnded]);
        }
      }
      return;
    }
    const stoppedRunId = projection.attempts.find(
      (attempt) => attempt.id === stopped.providerTurn?.runAttemptId,
    )?.runId;
    const stoppedRun = projection.runs.find((run) => run.id === stoppedRunId);
    if (
      stoppedRun === undefined ||
      (["preparing", "starting", "running"].includes(stoppedRun.status) &&
        stoppedRun.activeAttemptId !== stopped.providerTurn?.runAttemptId)
    )
      return;
    const now = yield* DateTime.now;
    if (stopped.providerTurn !== undefined && stoppedRun.status === "running") {
      const output = yield* projectionStore
        .getThreadRecords(command.threadId, ["messages"], {
          messageRunIds: [stoppedRun.id],
          messageRoles: ["assistant"],
        })
        .pipe(mapDispatchError(command));
      yield* settleInterruptedRun({
        command,
        projection: { ...projection, messages: output.messages },
        providerTurn: stopped.providerTurn,
        events,
        effects,
        now,
      });
    }
    // A new turn may have started since Stop; its work is not this Stop's.
    if (
      projection.runs.some(
        (run) =>
          run.id !== stoppedRun.id &&
          (run.status === "preparing" || run.status === "starting" || run.status === "running"),
      )
    ) {
      return;
    }
    yield* settleBackgroundWork({
      command,
      events,
      projection,
      stoppedProviderThreadId: command.providerThreadId,
      throughRunOrdinal: stoppedRun.ordinal,
      now,
    });
  },
);

const writeAppOwnedTask = Effect.fn("Orchestrator.writeAppOwnedTask")(function* (input: {
  readonly command: Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "run.interrupt" | "thread.stop" | "subagent.stop" }
  >;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly task: OrchestrationV2Subagent;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly now: DateTime.Utc;
}) {
  const { command, task, now } = input;
  const emitEvent = emit(input.events, command);
  yield* emitEvent({
    type: "subagent.updated",
    threadId: command.threadId,
    nodeId: task.id,
    occurredAt: now,
    payload: task,
  });
  const node = input.nodes.find((candidate) => candidate.id === task.id);
  if (node !== undefined)
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      nodeId: node.id,
      occurredAt: now,
      payload: { ...node, status: task.status, completedAt: task.completedAt },
    });
  for (const item of input.turnItems) {
    if (item.type !== "subagent" || item.subagentId !== task.id) continue;
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      nodeId: task.id,
      occurredAt: now,
      payload: { ...item, status: task.status, completedAt: task.completedAt, updatedAt: now },
    });
  }
});

  return { dispatchRemoteDelegatedTaskComplete, dispatchLinkRequestRecord, dispatchBackgroundWorkSettle, writeAppOwnedTask };
});

export type DispatchRemoteDelegatedTaskCompletePart = ReturnType<typeof installDispatchRemoteDelegatedTaskComplete> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchRemoteDelegatedTaskComplete>;
