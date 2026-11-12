/**
 * Checkpoint rollback domain.
 *
 * Extracted from the makeOrchestrator closure: both handlers need only a projection
 * read, the provider adapter registry, and the event emitter, all passed in.
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

import type { CommandPolicyV2Shape } from "../CommandPolicy.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";

import type { ProviderAdapterRegistryV2Shape } from "../ProviderAdapterRegistry.ts";
import { providerTurnForRun } from "../orchestrationCommandQueries.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "../CheckpointRestoreSafety.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
  ProjectionStoreV2Shape,
} from "../ProjectionStore.ts";
import type { DispatchErrorMapper } from "../orchestrationEmitters.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
} from "../orchestrationErrors.ts";

type CheckpointRestoreDeps = Parameters<typeof isCheckpointRestoreIsolated>[2];

export interface CheckpointHandlerDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly providerAdapters: ProviderAdapterRegistryV2Shape;
  readonly commandPolicy: CommandPolicyV2Shape;
  readonly projects: CheckpointRestoreDeps["projects"];
  readonly fileSystem: CheckpointRestoreDeps["fileSystem"];
  readonly path: CheckpointRestoreDeps["path"];
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => (
    event: Omit<OrchestrationV2DomainEvent, "id">,
  ) => Effect.Effect<OrchestrationV2DomainEvent, OrchestratorDispatchError>;
  readonly mapDispatchError: DispatchErrorMapper;
}

export interface CheckpointHandlers {
  readonly dispatchCheckpointRollback: (
    command: Extract<OrchestrationV2Command, { readonly type: "checkpoint.rollback" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<void, CheckpointHandlerError>;
  readonly dispatchCheckpointRollbackFail: (
    command: Extract<OrchestrationV2InternalCommand, { readonly type: "checkpoint.rollback.fail" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<void, CheckpointHandlerError>;
}

export type CheckpointHandlerError =
  | OrchestratorDispatchError
  | OrchestratorProjectionError
  | OrchestratorProviderAdapterError;

export const makeCheckpointHandlers = (deps: CheckpointHandlerDeps): CheckpointHandlers => {
const dispatchCheckpointRollback = Effect.fn("Orchestrator.dispatchCheckpointRollback")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "checkpoint.rollback" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* deps.loadProjectionForCommand(
      command,
      ["providerThreads", "checkpoints", "checkpointScopes", "runs", "providerTurns", "attempts"],
      { turnItemTypes: [], messageRoles: ["user"] },
    );
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    );
    if (providerThread === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "No active provider thread exists for rollback.",
      });
    }
    if (providerThread.providerSessionId === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Provider thread ${providerThread.id} has no provider session.`,
      });
    }

    const modelSelection = projection.thread.modelSelection;
    const capabilities = yield* deps.providerAdapters.get(modelSelection.instanceId).pipe(
      Effect.flatMap((adapter) => adapter.getCapabilities()),
      Effect.mapError(
        (cause) =>
          new OrchestratorProviderAdapterError({
            commandId: command.commandId,
            providerInstanceId: modelSelection.instanceId,
            cause,
          }),
      ),
    );
    yield* deps.mapDispatchError(command)(
      deps.commandPolicy.ensureRollback({
        commandId: command.commandId,
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        capabilities,
      }),
    );

    const targetCheckpoint = projection.checkpoints.find(
      (candidate) => candidate.id === command.checkpointId,
    );
    if (targetCheckpoint === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Checkpoint ${command.checkpointId} was not found.`,
      });
    }
    if (targetCheckpoint.status !== "ready") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Checkpoint ${command.checkpointId} is ${targetCheckpoint.status} and cannot be restored.`,
      });
    }
    const targetScope = projection.checkpointScopes.find(
      (candidate) => candidate.id === targetCheckpoint.scopeId,
    );
    if (targetScope === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Checkpoint scope ${targetCheckpoint.scopeId} was not found.`,
      });
    }
    if (targetScope.id !== command.scopeId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Checkpoint ${command.checkpointId} belongs to scope ${targetScope.id}, not ${command.scopeId}.`,
      });
    }
    if (command.restoreFiles !== false) {
      const isolated = yield* isCheckpointRestoreIsolated(projection.thread, targetScope, {
        projects: deps.projects,
        path: deps.path,
        fileSystem: deps.fileSystem,
        projections: deps.projectionStore,
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
      if (!isolated)
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: SHARED_WORKSPACE_RESTORE_MESSAGE,
        });
    }

    const targetOrdinal = targetCheckpoint.appRunOrdinal ?? 0;
    if (targetOrdinal > 0) {
      const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
      const targetProviderTurn =
        targetRun === undefined ? undefined : providerTurnForRun(projection, targetRun);
      if (targetRun === undefined || targetProviderTurn === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Cannot roll back to checkpoint ${targetCheckpoint.id}: its provider turn is unavailable.`,
        });
      }
      if (targetProviderTurn.providerThreadId !== providerThread.id) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Cannot roll back provider thread ${providerThread.id} to checkpoint ${targetCheckpoint.id}: target provider turn ${targetProviderTurn.id} belongs to provider thread ${targetProviderTurn.providerThreadId}.`,
        });
      }
    }

    const now = yield* DateTime.now;
    yield* deps.emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      providerInstanceId: projection.thread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...projection.thread,
        rollbackRequestId: command.commandId,
        rollbackFailure: null,
        updatedAt: now,
      },
    });
    yield* deps.emit(
      events,
      command,
    )({
      type: "checkpoint.rollback-requested",
      threadId: command.threadId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        scopeId: targetScope.id,
        checkpointId: targetCheckpoint.id,
        requestedAt: now,
      },
    });
    yield* Ref.update(effects, (existing) => [
      ...existing,
      {
        id: `effect:${command.commandId}:provider-thread.rollback:${providerThread.id}:${targetCheckpoint.id}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "provider-thread.rollback",
          ...(command.restoreFiles === undefined ? {} : { restoreFiles: command.restoreFiles }),
          providerThreadId: providerThread.id,
          checkpointId: targetCheckpoint.id,
          scopeId: targetScope.id,
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
  },
);

const dispatchCheckpointRollbackFail = Effect.fn("Orchestrator.dispatchCheckpointRollbackFail")(
  function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "checkpoint.rollback.fail" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const thread = yield* deps.projectionStore
      .getThread(command.threadId)
      .pipe(deps.mapDispatchError(command));
    if (thread.deletedAt !== null) return;
    if (thread.rollbackRequestId !== command.requestId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Rollback ${command.requestId} is no longer the thread's current rollback.`,
      });
    }
    const now = yield* DateTime.now;
    yield* deps.emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...thread,
        rollbackFailure: { requestId: command.requestId, message: command.message },
        updatedAt: now,
      },
    });
  },
);

/**
 * Thread lineage and fork origin are immutable, so this
 * is safe to read without holding either thread's dispatch lock.
 */
  return { dispatchCheckpointRollback, dispatchCheckpointRollbackFail };
};
