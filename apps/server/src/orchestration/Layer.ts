import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { OrchestrationCommandSchema } from "@t3tools/contracts";
import { Deferred, Effect, Layer, PubSub, Queue, Schema } from "effect";

import { createLogger } from "../logger.ts";
import { OrchestrationEventRepository } from "../persistence/Services/OrchestrationEvents.ts";
import {
  toListenerCallbackError,
  toOrchestrationCommandDecodeError,
  toOrchestrationJsonParseError,
  type OrchestrationDispatchError,
} from "./Errors.ts";
import { createEmptyReadModel, reduceEvent } from "./reducer.ts";
import { OrchestrationEngineService, type OrchestrationEngineShape } from "./Service.ts";

type CommandEnvelope = {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
};

function mapCommandToEvent(command: OrchestrationCommand): Omit<OrchestrationEvent, "sequence"> {
  const eventId = crypto.randomUUID();
  switch (command.type) {
    case "thread.create":
      return {
        eventId,
        type: "thread.created",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          model: command.model,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    case "thread.delete":
      return {
        eventId,
        type: "thread.deleted",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          id: command.threadId,
          deletedAt: command.createdAt,
        },
      };
    case "thread.meta.update":
      return {
        eventId,
        type: "thread.meta-updated",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: command.createdAt,
        },
      };
    case "message.send":
      return {
        eventId,
        type: "message.sent",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          id: command.messageId,
          role: command.role,
          text: command.text,
          threadId: command.threadId,
          createdAt: command.createdAt,
          streaming: command.streaming === true,
        },
      };
    case "thread.session":
      return {
        eventId,
        type: "thread.session-set",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    case "git.readModel.upsert":
      return {
        eventId,
        type: "git.read-model-upsert",
        aggregateType: "project",
        aggregateId: command.projectId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          projectId: command.projectId,
          branch: command.branch,
          hasWorkingTreeChanges: command.hasWorkingTreeChanges,
          aheadCount: command.aheadCount,
          behindCount: command.behindCount,
          updatedAt: command.createdAt,
        },
      };
    case "thread.turnDiff.complete":
      return {
        eventId,
        type: "thread.turn-diff-completed",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          completedAt: command.completedAt,
          ...(command.status !== undefined ? { status: command.status } : {}),
          files: command.files,
          ...(command.assistantMessageId !== undefined
            ? { assistantMessageId: command.assistantMessageId }
            : {}),
          ...(command.checkpointTurnCount !== undefined
            ? { checkpointTurnCount: command.checkpointTurnCount }
            : {}),
        },
      };
    case "thread.revert":
      return {
        eventId,
        type: "thread.reverted",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          messageCount: command.messageCount,
        },
      };
  }
}

const decodeUnknownCommand = Schema.decodeUnknownEffect(OrchestrationCommandSchema);

const makeOrchestrationEngine = 
  Effect.gen(function* () {
    const logger = createLogger("orchestration");
    const eventStore = yield* OrchestrationEventRepository;

    let readModel = createEmptyReadModel(new Date().toISOString());

    const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
    const readModelPubSub = yield* PubSub.unbounded<OrchestrationReadModel>();
    const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

    const readModelListeners = new Set<(snapshot: OrchestrationReadModel) => void>();
    const domainEventListeners = new Set<(event: OrchestrationEvent) => void>();

    const notifyReadModelListeners = (snapshot: OrchestrationReadModel) =>
      Effect.forEach(readModelListeners, (listener) =>
        Effect.try({
          try: () => listener(snapshot),
          catch: toListenerCallbackError("read-model"),
        }),
      ).pipe(Effect.asVoid);

    const notifyDomainEventListeners = (event: OrchestrationEvent) =>
      Effect.forEach(domainEventListeners, (listener) =>
        Effect.try({
          try: () => listener(event),
          catch: toListenerCallbackError("domain-event"),
        }),
      ).pipe(Effect.asVoid);

    const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> =>
      Effect.gen(function* () {
        const eventBase = mapCommandToEvent(envelope.command);
        const savedEvent = yield* eventStore.append(eventBase);
        readModel = yield* reduceEvent(readModel, savedEvent);

        const snapshot = readModel;
        yield* Effect.all([
          PubSub.publish(eventPubSub, savedEvent),
          PubSub.publish(readModelPubSub, snapshot),
        ]);

        yield* notifyDomainEventListeners(savedEvent);
        yield* notifyReadModelListeners(snapshot);

        yield* Deferred.succeed(envelope.result, { sequence: savedEvent.sequence });
      }).pipe(
        Effect.catch((error) => Deferred.fail(envelope.result, error).pipe(Effect.asVoid)),
      );

    const bootstrapReadModel: Effect.Effect<void, OrchestrationDispatchError> = Effect.gen(
      function* () {
        const existingEvents = yield* eventStore.readAll();
        for (const event of existingEvents) {
          readModel = yield* reduceEvent(readModel, event);
        }
      },
    );

    yield* bootstrapReadModel;

    const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
    yield* Effect.forkScoped(worker);
    logger.info("orchestration engine started", {
      sequence: readModel.sequence,
    });

    const getSnapshot: OrchestrationEngineShape["getSnapshot"] = () =>
      Effect.sync((): OrchestrationReadModel => readModel);

    const replayEvents: OrchestrationEngineShape["replayEvents"] = (fromSequenceExclusive) =>
      eventStore.readFromSequence(fromSequenceExclusive);

    const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
      Effect.gen(function* () {
        const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
        yield* Queue.offer(commandQueue, { command, result });
        return yield* Deferred.await(result);
      });

    const dispatchUnknown: OrchestrationEngineShape["dispatchUnknown"] = (command) =>
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

    const subscribeToReadModel: OrchestrationEngineShape["subscribeToReadModel"] = (callback) =>
      Effect.sync(() => {
        readModelListeners.add(callback);
        return () => {
          readModelListeners.delete(callback);
        };
      });

    const subscribeToDomainEvents: OrchestrationEngineShape["subscribeToDomainEvents"] = (
      callback,
    ) =>
      Effect.sync(() => {
        domainEventListeners.add(callback);
        return () => {
          domainEventListeners.delete(callback);
        };
      });

    return {
      getSnapshot,
      replayEvents,
      dispatchUnknown,
      dispatch,
      subscribeToReadModel,
      subscribeToDomainEvents,
    } satisfies OrchestrationEngineShape;
  });

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
