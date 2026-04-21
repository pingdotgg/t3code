import {
  EventId,
  NodeId,
  OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { DateTime, Effect, Layer, Ref, Stream } from "effect";

import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
  OrchestratorV2,
  type OrchestratorV2Shape,
} from "../Services/Orchestrator.ts";
import type { ProviderAdapterV2Event } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistryV2 } from "../Services/ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "../Services/ProjectionStore.ts";
import { ProjectionStoreV2MemoryLayer } from "./ProjectionStoreMemory.ts";

function entityKey(threadId: ThreadId): string {
  const raw = String(threadId);
  return raw.startsWith("thread:") ? raw.slice("thread:".length) : raw;
}

function runIdFor(threadId: ThreadId, ordinal: number): RunId {
  return RunId.make(`run:${entityKey(threadId)}:${ordinal}`);
}

function runAttemptIdFor(threadId: ThreadId, ordinal: number): RunAttemptId {
  return RunAttemptId.make(`run-attempt:${entityKey(threadId)}:${ordinal}:1`);
}

function rootNodeIdFor(threadId: ThreadId, ordinal: number): NodeId {
  return NodeId.make(`node:${entityKey(threadId)}:${ordinal}:root`);
}

function userTurnItemIdFor(command: Extract<OrchestrationV2Command, { type: "message.dispatch" }>) {
  return TurnItemId.make(`turn-item:user:${command.messageId}`);
}

function nextRunOrdinal(projection: OrchestrationV2ThreadProjection): number {
  return projection.runs.length + 1;
}

function adapterEventToDomainEvent(input: {
  readonly event: ProviderAdapterV2Event;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly nodeId?: NodeId;
  readonly occurredAt: DateTime.Utc;
}): Omit<OrchestrationV2DomainEvent, "id"> | null {
  switch (input.event.type) {
    case "provider_thread.updated":
      return {
        type: "provider-thread.updated",
        threadId: input.threadId,
        provider: input.event.provider,
        occurredAt: input.occurredAt,
        payload: input.event.providerThread,
      };
    case "provider_turn.updated":
      return {
        type: "provider-turn.updated",
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.nodeId,
        provider: input.event.provider,
        occurredAt: input.occurredAt,
        payload: input.event.providerTurn,
      };
    case "message.updated":
      return {
        type: "message.updated",
        threadId: input.threadId,
        runId: input.event.message.runId ?? undefined,
        nodeId: input.event.message.nodeId ?? undefined,
        provider: input.event.provider,
        occurredAt: input.occurredAt,
        payload: input.event.message,
      };
    case "turn_item.updated":
      return {
        type: "turn-item.updated",
        threadId: input.threadId,
        runId: input.event.turnItem.runId ?? undefined,
        nodeId: input.event.turnItem.nodeId ?? undefined,
        provider: input.event.provider,
        occurredAt: input.occurredAt,
        payload: input.event.turnItem,
      };
    case "runtime_item.updated":
      return {
        type: "runtime-item.updated",
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.event.runtimeItem.nodeId,
        provider: input.event.provider,
        occurredAt: input.occurredAt,
        payload: input.event.runtimeItem,
      };
    case "runtime_request.updated":
      return {
        type: "runtime-request.updated",
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.event.runtimeRequest.nodeId,
        provider: input.event.provider,
        occurredAt: input.occurredAt,
        payload: input.event.runtimeRequest,
      };
    case "plan.updated":
      return {
        type: "plan.updated",
        threadId: input.threadId,
        runId: input.event.plan.runId ?? undefined,
        nodeId: input.event.plan.nodeId,
        provider: input.event.provider,
        occurredAt: input.occurredAt,
        payload: input.event.plan,
      };
    case "turn.terminal":
      return null;
  }
}

export const OrchestratorV2LiveLayer: Layer.Layer<
  OrchestratorV2,
  never,
  ProviderAdapterRegistryV2
> = Layer.effect(
  OrchestratorV2,
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const adapterRegistry = yield* ProviderAdapterRegistryV2;
    const eventSequence = yield* Ref.make(0);

    const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
      Effect.gen(function* () {
        const sequence = yield* Ref.updateAndGet(eventSequence, (current) => current + 1);
        return {
          ...event,
          id: EventId.make(`event:${sequence}`),
        } as Event;
      });

    const emit =
      (events: Ref.Ref<Array<OrchestrationV2DomainEvent>>, command: OrchestrationV2Command) =>
      <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
        Effect.gen(function* () {
          const withId = yield* makeEvent(event);
          yield* projectionStore.apply(withId).pipe(
            Effect.mapError(
              () =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
            ),
          );
          yield* Ref.update(events, (existing) => [...existing, withId]);
          return withId;
        });

    const dispatchThreadCreate = (
      command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const emitEvent = emit(events, command);
        const adapter = yield* adapterRegistry.get(command.modelSelection.provider).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: command.commandId,
                provider: command.modelSelection.provider,
                cause,
              }),
          ),
        );
        const providerThread = yield* adapter
          .ensureThread({
            threadId: command.threadId,
            modelSelection: command.modelSelection,
            runtimePolicy: {
              runtimeMode: command.runtimeMode,
              interactionMode: command.interactionMode,
              cwd: command.worktreePath,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: command.commandId,
                  provider: command.modelSelection.provider,
                  cause,
                }),
            ),
          );

        yield* emitEvent({
          type: "thread.created",
          threadId: command.threadId,
          provider: command.modelSelection.provider,
          occurredAt: now,
          payload: {
            id: command.threadId,
            projectId: command.projectId,
            title: command.title,
            defaultProvider: command.modelSelection.provider,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            branch: command.branch,
            worktreePath: command.worktreePath,
            activeProviderThreadId: providerThread.id,
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          },
        });
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: command.threadId,
          provider: command.modelSelection.provider,
          occurredAt: now,
          payload: providerThread,
        });
      });

    const dispatchMessage = (
      command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) =>
      Effect.gen(function* () {
        const projection = yield* projectionStore
          .getThreadProjection(command.threadId)
          .pipe(
            Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
          );
        const modelSelection = command.modelSelection ?? projection.thread.modelSelection;
        const adapter = yield* adapterRegistry.get(modelSelection.provider).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: command.commandId,
                provider: modelSelection.provider,
                cause,
              }),
          ),
        );
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === projection.thread.activeProviderThreadId,
        );
        if (!providerThread) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
          });
        }

        const now = yield* DateTime.now;
        const ordinal = nextRunOrdinal(projection);
        const runId = runIdFor(command.threadId, ordinal);
        const attemptId = runAttemptIdFor(command.threadId, ordinal);
        const rootNodeId = rootNodeIdFor(command.threadId, ordinal);
        const emitEvent = emit(events, command);
        const run: OrchestrationV2Run = {
          id: runId,
          threadId: command.threadId,
          ordinal,
          provider: modelSelection.provider,
          providerThreadId: providerThread.id,
          userMessageId: command.messageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const attempt: OrchestrationV2RunAttempt = {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          provider: modelSelection.provider,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          reason: "initial",
          status: "running",
          startedAt: now,
          completedAt: null,
        };
        const rootNode: OrchestrationV2ExecutionNode = {
          id: rootNodeId,
          threadId: command.threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          runtimeItemId: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        };
        const message: OrchestrationV2ConversationMessage = {
          id: command.messageId,
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: command.text,
          attachments: command.attachments,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        };
        const turnItem: OrchestrationV2TurnItem = {
          id: userTurnItemIdFor(command),
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          runtimeItemId: null,
          parentItemId: null,
          ordinal: (ordinal - 1) * 100,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: command.messageId,
          text: command.text,
          attachments: command.attachments,
        };

        yield* emitEvent({
          type: "run.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: run,
        });
        yield* emitEvent({
          type: "run-attempt.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: attempt,
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: rootNode,
        });
        yield* emitEvent({
          type: "message.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: message,
        });
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: turnItem,
        });

        const adapterEvents = yield* adapter
          .startTurn({
            threadId: command.threadId,
            runId,
            attemptId,
            rootNodeId,
            providerThread,
            message: {
              messageId: command.messageId,
              text: command.text,
            },
            modelSelection,
            runtimePolicy: {
              runtimeMode: projection.thread.runtimeMode,
              interactionMode: projection.thread.interactionMode,
              cwd: projection.thread.worktreePath,
            },
          })
          .pipe(
            Stream.runCollect,
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: command.commandId,
                  provider: modelSelection.provider,
                  cause,
                }),
            ),
          );

        for (const adapterEvent of adapterEvents) {
          const occurredAt = yield* DateTime.now;
          const domainEvent = adapterEventToDomainEvent({
            event: adapterEvent,
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            occurredAt,
          });
          if (domainEvent) {
            yield* emitEvent(domainEvent);
          }
        }
      });

    const dispatchUnsupported = (command: OrchestrationV2Command) =>
      Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
        }),
      );

    const service: OrchestratorV2Shape = {
      dispatch: (command) =>
        Effect.gen(function* () {
          const events = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
          switch (command.type) {
            case "thread.create":
              yield* dispatchThreadCreate(command, events);
              break;
            case "message.dispatch":
              yield* dispatchMessage(command, events);
              break;
            default:
              return yield* dispatchUnsupported(command);
          }
          return yield* Ref.get(events);
        }),
      getThreadProjection: (threadId) =>
        projectionStore
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(() => new OrchestratorProjectionError({ threadId }))),
      streamDomainEvents: Stream.empty,
    };

    return service;
  }).pipe(Effect.provide(ProjectionStoreV2MemoryLayer)),
);
