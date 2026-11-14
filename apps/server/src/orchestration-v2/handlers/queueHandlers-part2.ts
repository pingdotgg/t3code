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
import * as Ref from "effect/Ref";

import { recordThreadOpen } from "@t3tools/shared/paletteSearch";

import type { CommandId, ThreadId } from "@t3tools/contracts";

type AnyOrchestratorError =
  | OrchestratorDispatchError
  | OrchestratorThreadAlreadyExistsError
  | OrchestratorCommandRejectedError
  | OrchestratorProjectionError
  | OrchestratorDomainEventStreamError
  | OrchestratorProviderAdapterError
  | OrchestratorSubagentThreadReadOnlyError
  | OrchestratorThreadAboveModeLimitError;
import {
  RUNTIME_REQUEST_DELIVERY_FAILED_MESSAGE,
  WORKSPACE_PREPARATION_INPUT,
} from "../orchestrationMessages.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
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
import { isActiveRun } from "../CommandPolicy.ts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";









import type {
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import type { MakeQueueHandlersDeps } from "./queueHandlers.ts";

export const makePreparedRunHandlers = (deps: MakeQueueHandlersDeps) => {
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

  return { dispatchPreparedRunProgress, dispatchPreparedRunRelease, dispatchPreparedRunFail, dispatchPreparedRunRetry };
};
