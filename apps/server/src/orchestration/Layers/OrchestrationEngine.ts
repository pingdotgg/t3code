import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { OrchestrationCommandSchema } from "@t3tools/contracts";
import { Deferred, Effect, Layer, PubSub, Queue, Schema, Stream } from "effect";

import { createLogger } from "../../logger.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  toOrchestrationCommandDecodeError,
  toOrchestrationJsonParseError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
}

const decodeUnknownCommand = Schema.decodeUnknownEffect(OrchestrationCommandSchema);

const makeOrchestrationEngine = Effect.gen(function* () {
  const logger = createLogger("orchestration");
  const eventStore = yield* OrchestrationEventStore;

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> =>
    Effect.gen(function* () {
      const eventBase = yield* decideOrchestrationCommand({
        command: envelope.command,
        readModel,
      });
      const savedEvent = yield* eventStore.append(eventBase);
      readModel = yield* projectEvent(readModel, savedEvent);
      yield* PubSub.publish(eventPubSub, savedEvent);

      yield* Deferred.succeed(envelope.result, { sequence: savedEvent.sequence });
    }).pipe(Effect.catch((error) => Deferred.fail(envelope.result, error).pipe(Effect.asVoid)));

  // bootstrap read model from event store
  yield* Stream.runForEach(eventStore.readAll(), (event) =>
    Effect.gen(function* () {
      readModel = yield* projectEvent(readModel, event);
    }),
  );

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  logger.info("orchestration engine started", {
    sequence: readModel.sequence,
  });

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

  const dispatchUnknownCommand: OrchestrationEngineShape["dispatchUnknownCommand"] = (command) =>
    Effect.gen(function* () {
      const payload =
        typeof command === "string"
          ? yield* Effect.try({
              try: () => JSON.parse(command) as unknown,
              catch: toOrchestrationJsonParseError,
            })
          : command;

      const decoded = yield* decodeUnknownCommand(payload).pipe(
        Effect.mapError(toOrchestrationCommandDecodeError),
      );

      return yield* dispatch(decoded);
    });

  const streamDomainEvents: OrchestrationEngineShape["streamDomainEvents"] =
    Stream.fromPubSub(eventPubSub);

  return {
    getReadModel,
    readEvents,
    dispatchUnknownCommand,
    dispatch,
    streamDomainEvents,
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
