import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import { Deferred, Effect, Layer, Option, PubSub, Queue, Stream } from "effect";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
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

function formatDispatchError(error: OrchestrationDispatchError): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> =>
    Effect.gen(function* () {
      const existingReceipt = yield* commandReceiptRepository.getByCommandId({
        commandId: envelope.command.commandId,
      });
      if (Option.isSome(existingReceipt)) {
        if (existingReceipt.value.status === "accepted") {
          yield* Deferred.succeed(envelope.result, {
            sequence: existingReceipt.value.resultSequence,
          });
          return;
        }
        yield* Deferred.fail(
          envelope.result,
          new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          }),
        );
        return;
      }

      const eventBase = yield* decideOrchestrationCommand({
        command: envelope.command,
        readModel,
      });
      const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
      let lastSavedEvent = null as OrchestrationEvent | null;

      for (const nextEvent of eventBases) {
        const savedEvent = yield* eventStore.append(nextEvent);
        yield* projectionPipeline.projectEvent(savedEvent);
        readModel = yield* projectEvent(readModel, savedEvent);
        yield* PubSub.publish(eventPubSub, savedEvent);
        lastSavedEvent = savedEvent;
      }

      if (lastSavedEvent === null) {
        return yield* Deferred.fail(
          envelope.result,
          new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: "Command produced no events.",
          }),
        );
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
      yield* Deferred.succeed(envelope.result, { sequence: lastSavedEvent.sequence });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error instanceof OrchestrationCommandInvariantError) {
            const aggregateRef = commandToAggregateRef(envelope.command);
            yield* commandReceiptRepository
              .upsert({
                commandId: envelope.command.commandId,
                aggregateKind: aggregateRef.aggregateKind,
                aggregateId: aggregateRef.aggregateId,
                acceptedAt: new Date().toISOString(),
                resultSequence: readModel.snapshotSequence,
                status: "rejected",
                error: formatDispatchError(error),
              })
              .pipe(Effect.catch(() => Effect.void));
          }
          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );

  yield* projectionPipeline.bootstrap;

  // bootstrap in-memory read model from event store
  yield* Stream.runForEach(eventStore.readAll(), (event) =>
    Effect.gen(function* () {
      readModel = yield* projectEvent(readModel, event);
    }),
  );

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.log("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Effect.sync((): OrchestrationReadModel => readModel);

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result });
      return yield* Deferred.await(result);
    });

  const streamDomainEvents: OrchestrationEngineShape["streamDomainEvents"] =
    Stream.fromPubSub(eventPubSub);

  return {
    getReadModel,
    readEvents,
    dispatch,
    streamDomainEvents,
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
