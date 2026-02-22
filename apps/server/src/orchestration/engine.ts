import path from "node:path";

import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { OrchestrationCommandSchema } from "@t3tools/contracts";
import { PubSub, Queue, Schema, Stream, Effect, Fiber, Runtime, Either } from "effect";

import { createLogger } from "../logger";
import { SqliteEventStore } from "./eventStore";
import { createEmptyReadModel, reduceEvent } from "./reducer";
import { UI_ENTITY_CONTRACTS } from "./uiContractInventory";

type CommandEnvelope = {
  command: OrchestrationCommand;
  resolve: (result: { sequence: number }) => void;
  reject: (error: Error) => void;
};

function mapCommandToEvent(command: OrchestrationCommand): Omit<OrchestrationEvent, "sequence"> {
  const eventId = crypto.randomUUID();
  switch (command.type) {
    case "project.create":
      return {
        eventId,
        type: "project.created",
        aggregateType: "project",
        aggregateId: command.projectId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          id: command.projectId,
          name: command.name,
          cwd: command.cwd,
          model: command.model,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    case "project.delete":
      return {
        eventId,
        type: "project.deleted",
        aggregateType: "project",
        aggregateId: command.projectId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          id: command.projectId,
          deletedAt: command.createdAt,
        },
      };
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
  }
}

export class OrchestrationEngine {
  private readonly logger = createLogger("orchestration");
  private readonly runtime = Runtime.defaultRuntime;
  private readonly eventStore: SqliteEventStore;

  private readModel: OrchestrationReadModel;
  private commandQueue: Queue.Queue<CommandEnvelope>;
  private readModelPubSub: PubSub.PubSub<OrchestrationReadModel>;
  private eventPubSub: PubSub.PubSub<OrchestrationEvent>;
  private workerFiber: Fiber.RuntimeFiber<void, unknown> | null = null;
  private readonly readModelListeners = new Set<(snapshot: OrchestrationReadModel) => void>();
  private readonly domainEventListeners = new Set<(event: OrchestrationEvent) => void>();

  constructor(stateDir: string) {
    const dbPath = path.join(stateDir, "orchestration.sqlite");
    this.eventStore = new SqliteEventStore(dbPath);
    this.readModel = createEmptyReadModel(new Date().toISOString());
    this.commandQueue = Runtime.runSync(this.runtime)(Queue.unbounded<CommandEnvelope>());
    this.readModelPubSub = Runtime.runSync(this.runtime)(PubSub.unbounded<OrchestrationReadModel>());
    this.eventPubSub = Runtime.runSync(this.runtime)(PubSub.unbounded<OrchestrationEvent>());
  }

  async start(): Promise<void> {
    const existingEvents = await Runtime.runPromise(this.runtime)(this.eventStore.readAll());
    for (const event of existingEvents) {
      this.readModel = reduceEvent(this.readModel, event);
    }

    const worker = Stream.fromQueue(this.commandQueue).pipe(
      Stream.runForEach((envelope) =>
        Effect.tryPromise({
          try: async () => {
            const eventBase = mapCommandToEvent(envelope.command);
            const savedEvent = await Runtime.runPromise(this.runtime)(this.eventStore.append(eventBase));
            this.readModel = reduceEvent(this.readModel, savedEvent);
            await Promise.all([
              Runtime.runPromise(this.runtime)(PubSub.publish(this.eventPubSub, savedEvent)),
              Runtime.runPromise(this.runtime)(PubSub.publish(this.readModelPubSub, this.readModel)),
            ]);
            for (const listener of this.domainEventListeners) {
              listener(savedEvent);
            }
            for (const listener of this.readModelListeners) {
              listener(this.readModel);
            }
            envelope.resolve({ sequence: savedEvent.sequence });
          },
          catch: (error) => {
            const message = error instanceof Error ? error.message : "Unknown command processing error";
            envelope.reject(new Error(message));
            return undefined;
          },
        }),
      ),
    );

    this.workerFiber = Runtime.runFork(this.runtime)(worker);
    this.logger.info("orchestration engine started", {
      sequence: this.readModel.sequence,
      contracts: UI_ENTITY_CONTRACTS.length,
    });
  }

  async stop(): Promise<void> {
    if (this.workerFiber) {
      await Runtime.runPromise(this.runtime)(Fiber.interrupt(this.workerFiber));
      this.workerFiber = null;
    }
  }

  getSnapshot(): OrchestrationReadModel {
    return this.readModel;
  }

  async replayEvents(fromSequenceExclusive: number): Promise<OrchestrationEvent[]> {
    return Runtime.runPromise(this.runtime)(this.eventStore.readFromSequence(fromSequenceExclusive));
  }

  async dispatchUnknown(command: unknown): Promise<{ sequence: number }> {
    const decode = Schema.decodeUnknownEither(OrchestrationCommandSchema);
    let payload: unknown = command;
    if (typeof command === "string") {
      try {
        payload = JSON.parse(command) as unknown;
      } catch {
        throw new Error("Invalid orchestration command: payload is not valid JSON");
      }
    }
    const decoded = decode(payload);
    if (Either.isLeft(decoded)) {
      const issues = decoded.left.toString();
      throw new Error(`Invalid orchestration command: ${issues}`);
    }
    return this.dispatch(decoded.right);
  }

  async dispatch(command: OrchestrationCommand): Promise<{ sequence: number }> {
    return new Promise<{ sequence: number }>((resolve, reject) => {
      Runtime.runPromise(this.runtime)(
        Queue.offer(this.commandQueue, { command, resolve, reject }),
      ).catch((error) => {
        const message = error instanceof Error ? error.message : "Queue offer failed";
        reject(new Error(message));
      });
    });
  }

  subscribeToReadModel(callback: (snapshot: OrchestrationReadModel) => void): () => void {
    this.readModelListeners.add(callback);
    return () => {
      this.readModelListeners.delete(callback);
    };
  }

  subscribeToDomainEvents(callback: (event: OrchestrationEvent) => void): () => void {
    this.domainEventListeners.add(callback);
    return () => {
      this.domainEventListeners.delete(callback);
    };
  }
}
