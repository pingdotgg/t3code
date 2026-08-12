import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  OrchestrationDispatchCommandError,
  EventId,
  OrchestrationCommand,
  OrchestrationTurnStartPendingError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { ProviderTurnIntentRepositoryLive } from "../../persistence/Layers/ProviderTurnIntents.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProviderTurnIntentRepository } from "../../persistence/Services/ProviderTurnIntents.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type CompleteProviderTurnIntentInput,
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

interface ProviderTurnIntentEnvelope {
  readonly input: CompleteProviderTurnIntentInput;
  readonly result: Deferred.Deferred<{ consumed: boolean }, OrchestrationDispatchError>;
}

type EngineEnvelope = CommandEnvelope | ProviderTurnIntentEnvelope;

function isCommandEnvelope(envelope: EngineEnvelope): envelope is CommandEnvelope {
  return "command" in envelope;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
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
  const providerTurnIntentRepository = yield* ProviderTurnIntentRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const processLocalSqlError = (cause: unknown) =>
    new OrchestrationDispatchCommandError({
      message: "Failed to persist process-local command identity",
      cause,
    });

  const readProcessLocalFingerprint = (commandId: string) => sql<{ readonly fingerprint: string }>`
    SELECT fingerprint
    FROM process_local_command_fingerprints
    WHERE command_id = ${commandId}
  `;

  const registerProcessLocalCommand: NonNullable<
    OrchestrationEngineShape["registerProcessLocalCommand"]
  > = (input) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO process_local_command_fingerprints (command_id, fingerprint)
        VALUES (${input.commandId}, ${input.fingerprint})
        ON CONFLICT (command_id) DO NOTHING
      `;
      const persisted = yield* readProcessLocalFingerprint(input.commandId);
      if (persisted[0]?.fingerprint !== input.fingerprint) {
        return yield* new OrchestrationDispatchCommandError({
          message: "The command ID was reused with a different command payload.",
        });
      }
    }).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(processLocalSqlError(cause))));

  const findAcceptedProcessLocalCommand: NonNullable<
    OrchestrationEngineShape["findAcceptedProcessLocalCommand"]
  > = (input) =>
    Effect.gen(function* () {
      const persisted = yield* readProcessLocalFingerprint(input.commandId);
      if (persisted.length === 0) return Option.none();
      if (persisted[0]?.fingerprint !== input.fingerprint) {
        return yield* new OrchestrationDispatchCommandError({
          message: "The command ID was reused with a different command payload.",
        });
      }
      const receipts = yield* sql<{
        readonly aggregateId: string;
        readonly aggregateKind: string;
        readonly resultSequence: number;
        readonly status: string;
      }>`
        SELECT
          aggregate_id AS "aggregateId",
          aggregate_kind AS "aggregateKind",
          result_sequence AS "resultSequence",
          status
        FROM orchestration_command_receipts
        WHERE command_id = ${input.commandId}
      `;
      const receipt = receipts[0];
      return receipt !== undefined &&
        receipt.status === "accepted" &&
        receipt.aggregateKind === "thread" &&
        receipt.aggregateId === input.threadId
        ? Option.some({ sequence: receipt.resultSequence })
        : Option.none();
    }).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(processLocalSqlError(cause))));
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<EngineEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
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

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
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

        if (envelope.command.type === "thread.turn.start") {
          const turnStartThreadId = envelope.command.threadId;
          if (
            yield* providerTurnIntentRepository.hasPendingForThread({
              threadId: turnStartThreadId,
            })
          ) {
            return yield* new OrchestrationTurnStartPendingError({
              threadId: turnStartThreadId,
            });
          }
        }

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandInvariantError(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                if (savedEvent.type === "thread.turn-start-requested") {
                  yield* providerTurnIntentRepository.insert({
                    eventSequence: savedEvent.sequence,
                    threadId: savedEvent.payload.threadId,
                    messageId: savedEvent.payload.messageId,
                    requestedAt: savedEvent.payload.createdAt,
                  });
                }
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
                nextCommandReadModel,
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

        commandReadModel = committedCommand.nextCommandReadModel;
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
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
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
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
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
                    snapshotSequence: commandReadModel.snapshotSequence,
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
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
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
  };

  const processProviderTurnIntentEnvelope = (
    envelope: ProviderTurnIntentEnvelope,
  ): Effect.Effect<void> =>
    Effect.exit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const commandReceipts = yield* Effect.forEach(envelope.input.commands, (command) =>
              commandReceiptRepository.getByCommandId({ commandId: command.commandId }),
            );
            for (const [index, receipt] of commandReceipts.entries()) {
              if (Option.isSome(receipt) && receipt.value.status === "rejected") {
                const command = envelope.input.commands[index];
                if (command === undefined) {
                  continue;
                }
                return yield* new OrchestrationCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  detail: receipt.value.error ?? "Previously rejected.",
                });
              }
            }
            // Runtime event command ids are deterministic. A replay after a
            // later turn was queued must remain a no-op instead of consuming
            // that newer turn's intent.
            if (
              commandReceipts.length > 0 &&
              commandReceipts.every(
                (receipt) => Option.isSome(receipt) && receipt.value.status === "accepted",
              )
            ) {
              return {
                consumed: false,
                committedEvents: [],
                nextCommandReadModel: commandReadModel,
              };
            }

            const consumedIntent =
              envelope.input.selector.kind === "exact"
                ? yield* providerTurnIntentRepository.takeExact({
                    eventSequence: envelope.input.selector.eventSequence,
                    threadId: envelope.input.selector.threadId,
                  })
                : yield* providerTurnIntentRepository.takeOldestForThread({
                    threadId: envelope.input.selector.threadId,
                  });
            const consumed = Option.isSome(consumedIntent);
            const projectedThread = commandReadModel.threads.find(
              (thread) => thread.id === envelope.input.selector.threadId,
            );
            const shouldApplyCommands =
              envelope.input.commandPolicy === "always" ||
              (consumed &&
                (envelope.input.commandPolicy === "if-consumed" ||
                  projectedThread?.session?.status === "starting"));
            const committedEvents: OrchestrationEvent[] = [];
            let nextCommandReadModel = commandReadModel;
            if (!shouldApplyCommands) {
              // Steering an already-running provider turn has no lifecycle
              // command to adopt the pending message. Its exact ACK below is
              // therefore the only projection change.
            } else {
              for (const [index, command] of envelope.input.commands.entries()) {
                const existingReceipt = commandReceipts[index] ?? Option.none();
                if (Option.isSome(existingReceipt)) {
                  if (existingReceipt.value.status === "accepted") {
                    continue;
                  }
                  return yield* new OrchestrationCommandPreviouslyRejectedError({
                    commandId: command.commandId,
                    detail: existingReceipt.value.error ?? "Previously rejected.",
                  });
                }

                const eventBase = yield* decideOrchestrationCommand({
                  command,
                  readModel: nextCommandReadModel,
                }).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.mapError((cause) =>
                    isOrchestrationCommandInvariantError(cause)
                      ? cause
                      : new OrchestrationCommandInvariantError({
                          commandType: command.type,
                          detail: "Failed to generate an event identifier.",
                          cause,
                        }),
                  ),
                );
                const commandEvents: OrchestrationEvent[] = [];
                for (const nextEvent of Array.isArray(eventBase) ? eventBase : [eventBase]) {
                  const savedEvent = yield* eventStore.append(nextEvent);
                  nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                  yield* projectionPipeline.projectEvent(savedEvent);
                  commandEvents.push(savedEvent);
                  committedEvents.push(savedEvent);
                }

                const lastSavedEvent = commandEvents.at(-1) ?? null;
                if (lastSavedEvent === null) {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "Command produced no events.",
                  });
                }
                yield* commandReceiptRepository.upsert({
                  commandId: command.commandId,
                  aggregateKind: lastSavedEvent.aggregateKind,
                  aggregateId: lastSavedEvent.aggregateId,
                  acceptedAt: lastSavedEvent.occurredAt,
                  resultSequence: lastSavedEvent.sequence,
                  status: "accepted",
                  error: null,
                });
              }
            }

            // For a starting session, project session.set first so it adopts
            // the correlated pending message into the running turn. Only then
            // remove the exact placeholder. Steering has no lifecycle command
            // and reaches the same exact cleanup without disturbing newer work.
            if (consumed && envelope.input.acknowledgement !== undefined) {
              const intent = consumedIntent.value;
              const acknowledgement = envelope.input.acknowledgement;
              const eventId = EventId.make(yield* crypto.randomUUIDv4);
              const acknowledgedEvent = yield* eventStore.append({
                eventId,
                aggregateKind: "thread",
                aggregateId: intent.threadId,
                occurredAt: acknowledgement.acknowledgedAt,
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: { providerTurnId: acknowledgement.turnId },
                type: "thread.turn-start-acknowledged",
                payload: {
                  threadId: intent.threadId,
                  eventSequence: intent.eventSequence,
                  messageId: intent.messageId,
                  turnId: acknowledgement.turnId,
                  acknowledgedAt: acknowledgement.acknowledgedAt,
                },
              });
              nextCommandReadModel = yield* projectEvent(nextCommandReadModel, acknowledgedEvent);
              yield* projectionPipeline.projectEvent(acknowledgedEvent);
              committedEvents.push(acknowledgedEvent);
            }
            return { consumed, committedEvents, nextCommandReadModel };
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (sqlError) =>
            Effect.fail(
              toPersistenceSqlError(
                "OrchestrationEngine.processProviderTurnIntentEnvelope:transaction",
              )(sqlError),
            ),
          ),
        ),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (Exit.isFailure(exit)) {
            yield* Deferred.fail(
              envelope.result,
              Cause.squash(exit.cause) as OrchestrationDispatchError,
            );
            return;
          }
          commandReadModel = exit.value.nextCommandReadModel;
          for (const event of exit.value.committedEvents) {
            yield* PubSub.publish(eventPubSub, event);
          }
          yield* Deferred.succeed(envelope.result, { consumed: exit.value.consumed });
        }),
      ),
    );

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.flatMap((envelope) =>
        isCommandEnvelope(envelope)
          ? processEnvelope(envelope)
          : processProviderTurnIntentEnvelope(envelope),
      ),
    ),
  );
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  const completeProviderTurnIntent: OrchestrationEngineShape["completeProviderTurnIntent"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ consumed: boolean }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { input, result });
      return yield* Deferred.await(result);
    });

  return {
    registerProcessLocalCommand,
    findAcceptedProcessLocalCommand,
    readEvents,
    dispatch,
    completeProviderTurnIntent,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(Effect.map(Stream.fromSubscription)),
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(Layer.provideMerge(ProviderTurnIntentRepositoryLive));
