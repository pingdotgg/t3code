import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { OrchestrationCommandSchema } from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Effect,
  Either,
  Fiber,
  Layer,
  PubSub,
  Queue,
  Runtime,
  Schema,
} from "effect";

import { createLogger } from "../logger";
import { OrchestrationEventRepository } from "../persistence/Services/OrchestrationEvents";
import { createEmptyReadModel, reduceEvent } from "./reducer";
import { OrchestrationEngineService, type OrchestrationEngineShape } from "./Service";

type CommandEnvelope = {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, Error>;
};

function asError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

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

const decodeUnknownCommand = Schema.decodeUnknownEither(OrchestrationCommandSchema);

export const makeOrchestrationEngine = Effect.gen(function* () {
  const logger = createLogger("orchestration");
  const eventStore = yield* OrchestrationEventRepository;
  const runtime = Runtime.defaultRuntime;

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const readModelPubSub = yield* PubSub.unbounded<OrchestrationReadModel>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const readModelListeners = new Set<(snapshot: OrchestrationReadModel) => void>();
  const domainEventListeners = new Set<(event: OrchestrationEvent) => void>();

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

      for (const listener of domainEventListeners) {
        listener(savedEvent);
      }
      for (const listener of readModelListeners) {
        listener(snapshot);
      }

      yield* Deferred.succeed(envelope.result, { sequence: savedEvent.sequence });
    }).pipe(
      Effect.catchAllCause((cause) =>
        Deferred.fail(
          envelope.result,
          asError(Cause.squash(cause), "Unknown command processing error"),
        ).pipe(Effect.asVoid),
      ),
    );

  const bootstrapReadModel: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const existingEvents = yield* eventStore.readAll();
    for (const event of existingEvents) {
      readModel = yield* reduceEvent(readModel, event);
    }
  });

  yield* bootstrapReadModel;

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  const workerFiber: Fiber.RuntimeFiber<void, unknown> = Runtime.runFork(runtime)(worker);
  logger.info("orchestration engine started", {
    sequence: readModel.sequence,
  });

  yield* Effect.addFinalizer(() => Fiber.interrupt(workerFiber).pipe(Effect.orDie));

  const getSnapshot: OrchestrationEngineShape["getSnapshot"] = () =>
    Effect.sync((): OrchestrationReadModel => readModel);

  const replayEvents: OrchestrationEngineShape["replayEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, Error>();
      yield* Queue.offer(commandQueue, { command, result });
      return yield* Deferred.await(result);
    }).pipe(Effect.mapError((error) => asError(error, "Queue offer failed")));

  const dispatchUnknown: OrchestrationEngineShape["dispatchUnknown"] = (command) =>
    Effect.gen(function* () {
      let payload: unknown = command;
      if (typeof command === "string") {
        try {
          payload = JSON.parse(command) as unknown;
        } catch {
          return yield* Effect.fail(
            new Error("Invalid orchestration command: payload is not valid JSON"),
          );
        }
      }
      const decoded = decodeUnknownCommand(payload);
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(
          new Error(`Invalid orchestration command: ${decoded.left.toString()}`),
        );
      }
      return yield* dispatch(decoded.right);
    });

  const subscribeToReadModel: OrchestrationEngineShape["subscribeToReadModel"] = (callback) =>
    Effect.sync(() => {
      readModelListeners.add(callback);
      return () => {
        readModelListeners.delete(callback);
      };
    });

  const subscribeToDomainEvents: OrchestrationEngineShape["subscribeToDomainEvents"] = (callback) =>
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

export const OrchestrationEngineLive = Layer.scoped(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
