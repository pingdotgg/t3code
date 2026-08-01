import type { OrchestrationEvent, ProjectId, ThreadId, WorkflowRunId } from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandWorktreeCleanupPendingError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread" | "workflow";
  readonly aggregateId: ProjectId | ThreadId | WorkflowRunId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    case "workflow.run.request":
    case "workflow.node.worker.start":
    case "workflow.worker-result.record":
    case "workflow.run.finalize":
      return {
        aggregateKind: "workflow",
        aggregateId: command.runId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const initialized = yield* Deferred.make<void, OrchestrationDispatchError>();
  const worktreeLock = yield* Semaphore.make(1);

  const withWorktreeLock: OrchestrationEngineShape["withWorktreeLock"] = (effect) =>
    worktreeLock.withPermits(1)(effect);

  const commandWorktreePath = (command: OrchestrationCommand): string | null => {
    switch (command.type) {
      case "thread.create":
        return command.worktreePath;
      case "thread.meta.update":
        return command.worktreePath ?? null;
      case "thread.workspace.handoff":
        return command.worktreePath;
      default:
        return null;
    }
  };

  const canonicalizeCommandWorktree = Effect.fn("canonicalizeCommandWorktree")(function* (
    command: OrchestrationCommand,
  ) {
    const worktreePath = commandWorktreePath(command);
    if (worktreePath === null) {
      return command;
    }
    const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
    switch (command.type) {
      case "thread.create":
      case "thread.meta.update":
      case "thread.workspace.handoff":
        return { ...command, worktreePath: canonicalPath };
      default:
        return command;
    }
  });

  const isWorktreeCleanupPending = Effect.fn("isWorktreeCleanupPending")(function* (
    worktreePath: string,
  ) {
    if (yield* worktreeCleanupJobs.existsByPath(worktreePath)) {
      return true;
    }
    const jobs = yield* worktreeCleanupJobs.list();
    return yield* Effect.forEach(
      jobs,
      (job) =>
        Effect.promise(() => canonicalizeWorktreePath(job.worktreePath)).pipe(
          Effect.map((pendingPath) => pendingPath === worktreePath),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((matches) => matches.some(Boolean)));
  });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = readModel.snapshotSequence;
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextReadModel = readModel;
      for (const persistedEvent of persistedEvents) {
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
      }
      readModel = nextReadModel;

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    const process = Effect.exit(
      Effect.gen(function* () {
        const command = yield* canonicalizeCommandWorktree(envelope.command);
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const worktreePath = commandWorktreePath(command);
        if (worktreePath !== null && (yield* isWorktreeCleanupPending(worktreePath))) {
          return yield* new OrchestrationCommandWorktreeCleanupPendingError({
            commandType: command.type,
            worktreePath,
          });
        }

        const eventBase = yield* decideOrchestrationCommand({
          command,
          readModel,
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextReadModel = readModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        readModel = committedCommand.nextReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, Date.now() - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, Date.now() - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: readModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: new Date().toISOString(),
                  resultSequence: readModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
    return commandWorktreePath(envelope.command) !== null ? withWorktreeLock(process) : process;
  };

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const initializationExit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* projectionPipeline.bootstrap;
          readModel = yield* projectionSnapshotQuery.getSnapshot();
          yield* Effect.forkScoped(worker);
          yield* Effect.logDebug("orchestration engine started").pipe(
            Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
          );
        }),
      );
      if (Exit.isFailure(initializationExit)) {
        yield* Deferred.failCause(initialized, initializationExit.cause).pipe(Effect.orDie);
        return;
      }
      yield* Deferred.succeed(initialized, undefined).pipe(Effect.orDie);
    }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Deferred.await(initialized).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error("Orchestration engine initialization failed"),
      ),
      Effect.orDie,
      Effect.map(() => readModel),
    );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Deferred.await(initialized);
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result, startedAtMs: Date.now() });
      return yield* Deferred.await(result);
    });

  return {
    getReadModel,
    readEvents,
    dispatch,
    withWorktreeLock,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(Layer.provideMerge(WorktreeCleanupJobRepositoryLive));
