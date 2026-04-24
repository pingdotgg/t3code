import {
  type ChatAttachment,
  CommandId,
  type ModelSelection,
  OrchestrationV2Command,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { Context, DateTime, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RunExecutionServiceV2 } from "./RunExecutionService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export class OrchestratorDispatchError extends Schema.TaggedErrorClass<OrchestratorDispatchError>()(
  "OrchestratorDispatchError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to dispatch orchestration command ${this.commandType} (${this.commandId}).`;
  }
}

export class OrchestratorProjectionError extends Schema.TaggedErrorClass<OrchestratorProjectionError>()(
  "OrchestratorProjectionError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to load orchestration projection for thread ${this.threadId}.`;
  }
}

export class OrchestratorDomainEventStreamError extends Schema.TaggedErrorClass<OrchestratorDomainEventStreamError>()(
  "OrchestratorDomainEventStreamError",
  {
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return "Failed while streaming orchestration domain events.";
  }
}

export class OrchestratorProviderAdapterError extends Schema.TaggedErrorClass<OrchestratorProviderAdapterError>()(
  "OrchestratorProviderAdapterError",
  {
    commandId: CommandId,
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter failed while dispatching orchestration command ${this.commandId}.`;
  }
}

export class OrchestratorCommandPreviouslyRejectedError extends Schema.TaggedErrorClass<OrchestratorCommandPreviouslyRejectedError>()(
  "OrchestratorCommandPreviouslyRejectedError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was previously rejected: ${this.detail}`;
  }
}

export const OrchestratorV2Error = Schema.Union([
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorCommandPreviouslyRejectedError,
]);
export type OrchestratorV2Error = typeof OrchestratorV2Error.Type;

export interface OrchestratorV2DispatchResult {
  readonly sequence: number;
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
}

export interface OrchestratorV2Shape {
  readonly dispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly getThreadEventSequence: (
    threadId: ThreadId,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly streamStoredEvents: Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  readonly streamDomainEvents: Stream.Stream<OrchestrationV2DomainEvent, OrchestratorV2Error>;
}

export class OrchestratorV2 extends Context.Service<OrchestratorV2, OrchestratorV2Shape>()(
  "t3/orchestration-v2/Orchestrator",
) {}

function nextRunOrdinal(projection: OrchestrationV2ThreadProjection): number {
  return projection.runs.length + 1;
}

function commandThreadId(command: OrchestrationV2Command): ThreadId {
  switch (command.type) {
    case "thread.create":
    case "message.dispatch":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queued-run.reorder":
    case "runtime-request.respond":
    case "checkpoint.rollback":
    case "provider.switch":
      return command.threadId;
    case "thread.fork":
      return command.targetThreadId;
  }
}

function lastSequence(storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>): number {
  return storedEvents.at(-1)?.sequence ?? 0;
}

function nextTurnItemOrdinal(projection: OrchestrationV2ThreadProjection): number {
  return Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1;
}

function isBlockingRun(run: OrchestrationV2Run): boolean {
  return run.status === "starting" || run.status === "running" || run.status === "waiting";
}

function nextQueuedRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    )[0];
}

export const layer: Layer.Layer<
  OrchestratorV2,
  never,
  | CheckpointServiceV2
  | CommandReceiptStoreV2
  | EventSinkV2
  | IdAllocatorV2
  | ProviderSessionManagerV2
  | ProjectionStoreV2
  | RunExecutionServiceV2
  | RuntimePolicyV2
> = Layer.effect(
  OrchestratorV2,
  Effect.gen(function* () {
    const checkpointService = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const commandReceipts = yield* CommandReceiptStoreV2;
    const idAllocator = yield* IdAllocatorV2;
    const projectionStore = yield* ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const dispatchSemaphore = yield* Semaphore.make(1);

    const mapDispatchError =
      (command: OrchestrationV2Command) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OrchestratorDispatchError, R> =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );

    const makeEvent = <Event extends OrchestrationV2DomainEvent>(
      command: OrchestrationV2Command,
      event: Omit<Event, "id">,
    ) =>
      Effect.gen(function* () {
        const eventId = yield* mapDispatchError(command)(
          idAllocator.allocate.event({
            threadId: event.threadId,
            commandId: command.commandId,
          }),
        );
        return {
          ...event,
          id: eventId,
        } as Event;
      });

    const emit =
      (events: Ref.Ref<Array<OrchestrationV2StoredEvent>>, command: OrchestrationV2Command) =>
      <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
        Effect.gen(function* () {
          const withId = yield* makeEvent(command, event);
          const storedEvents = yield* eventSink
            .write({ commandId: command.commandId, events: [withId] })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
          const storedEvent = storedEvents[0];
          if (!storedEvent) {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "Event sink did not return a stored event.",
            });
          }
          yield* Ref.update(events, (existing) => [...existing, storedEvent]);
          return storedEvent.event;
        });

    const makeSystemEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
      Effect.gen(function* () {
        const eventId = yield* idAllocator.allocate.event({
          threadId: event.threadId,
        });
        return {
          ...event,
          id: eventId,
        } as Event;
      });

    const writeSystemEvents = (events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>) =>
      Effect.gen(function* () {
        const withIds = yield* Effect.forEach(events, (event) =>
          makeSystemEvent(event as Omit<OrchestrationV2DomainEvent, "id">),
        );
        yield* eventSink.write({ events: withIds });
      });

    const startNextQueuedRun = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const projection = yield* projectionStore.getThreadProjection(threadId);
        if (projection.runs.some(isBlockingRun)) {
          return;
        }

        const queuedRun = nextQueuedRun(projection);
        if (queuedRun === undefined) {
          return;
        }
        const rootNodeId = queuedRun.rootNodeId;
        const attemptId = queuedRun.activeAttemptId;
        const providerThreadId = queuedRun.providerThreadId;
        if (rootNodeId === null || attemptId === null || providerThreadId === null) {
          return yield* new OrchestratorDispatchError({
            commandId: CommandId.make(`command:system:start-queued:${queuedRun.id}`),
            commandType: "message.dispatch",
            cause: `Queued run ${queuedRun.id} is missing execution identity.`,
          });
        }

        const rootNode = projection.nodes.find((candidate) => candidate.id === rootNodeId);
        const attempt = projection.attempts.find((candidate) => candidate.id === attemptId);
        const message = projection.messages.find(
          (candidate) => candidate.id === queuedRun.userMessageId,
        );
        const queuedProviderThread = projection.providerThreads.find(
          (candidate) => candidate.id === providerThreadId,
        );
        if (
          rootNode === undefined ||
          attempt === undefined ||
          message === undefined ||
          queuedProviderThread === undefined
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: CommandId.make(`command:system:start-queued:${queuedRun.id}`),
            commandType: "message.dispatch",
            cause: `Queued run ${queuedRun.id} is missing projection state.`,
          });
        }

        const modelSelection = projection.thread.modelSelection;
        if (modelSelection.provider !== queuedRun.provider) {
          return yield* new OrchestratorDispatchError({
            commandId: CommandId.make(`command:system:start-queued:${queuedRun.id}`),
            commandType: "message.dispatch",
            cause: `Queued provider ${queuedRun.provider} does not match thread model provider ${modelSelection.provider}.`,
          });
        }

        const providerSessionId =
          queuedProviderThread.providerSessionId ??
          (yield* idAllocator.allocate.providerSession({
            provider: queuedRun.provider,
            threadId,
          }));
        const existingProviderSession = projection.providerSessions.find(
          (candidate) => candidate.id === providerSessionId,
        );
        const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
          thread: projection.thread,
          modelSelection,
        });
        const activeSession = yield* providerSessions.get(providerSessionId);
        const session = yield* providerSessions.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingProviderSession === undefined
            ? {}
            : { resumeFromSession: existingProviderSession }),
        });
        const resumedProviderThread =
          Option.isSome(activeSession) || queuedProviderThread.providerSessionId === null
            ? queuedProviderThread
            : yield* session.resumeThread({ providerThread: queuedProviderThread });

        const now = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread = {
          ...resumedProviderThread,
          providerSessionId,
          status: "active",
          firstRunOrdinal: resumedProviderThread.firstRunOrdinal ?? queuedRun.ordinal,
          lastRunOrdinal: queuedRun.ordinal,
          updatedAt: now,
        };
        const checkpointScope =
          rootNode.checkpointScopeId === null
            ? yield* checkpointService.prepareRootRunScope({
                threadId,
                runId: queuedRun.id,
                rootNodeId,
                providerThreadId: providerThread.id,
                cwd: resolvedRuntimePolicy.cwd ?? session.providerSession.cwd,
                createdAt: now,
              })
            : (projection.checkpointScopes.find(
                (scope) => scope.id === rootNode.checkpointScopeId,
              ) ??
              (yield* checkpointService.prepareRootRunScope({
                threadId,
                runId: queuedRun.id,
                rootNodeId,
                providerThreadId: providerThread.id,
                cwd: resolvedRuntimePolicy.cwd ?? session.providerSession.cwd,
                createdAt: now,
              })));
        const ensuredCheckpointScope = yield* checkpointService.ensureScope(checkpointScope);
        const runningRun: OrchestrationV2Run = {
          ...queuedRun,
          status: "running",
          queuePosition: null,
          startedAt: now,
        };
        const runningAttempt: OrchestrationV2RunAttempt = {
          ...attempt,
          status: "running",
          startedAt: now,
        };
        const runningRootNode: OrchestrationV2ExecutionNode = {
          ...rootNode,
          status: "running",
          providerThreadId: providerThread.id,
          checkpointScopeId: ensuredCheckpointScope.id,
          startedAt: now,
        };

        yield* writeSystemEvents([
          {
            type: "provider-session.updated",
            threadId,
            provider: queuedRun.provider,
            occurredAt: now,
            payload: session.providerSession,
          },
          {
            type: "provider-thread.updated",
            threadId,
            provider: queuedRun.provider,
            occurredAt: now,
            payload: providerThread,
          },
          {
            type: "run.updated",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            provider: queuedRun.provider,
            occurredAt: now,
            payload: runningRun,
          },
          {
            type: "run-attempt.updated",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            provider: queuedRun.provider,
            occurredAt: now,
            payload: runningAttempt,
          },
          {
            type: "node.updated",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            provider: queuedRun.provider,
            occurredAt: now,
            payload: runningRootNode,
          },
          {
            type: "checkpoint-scope.created",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            provider: queuedRun.provider,
            occurredAt: now,
            payload: ensuredCheckpointScope,
          },
        ]);

        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:system:start-queued:${queuedRun.id}`),
          providerSessionId,
          session,
          run: runningRun,
          rootNode: runningRootNode,
          checkpointScope: ensuredCheckpointScope,
          providerThread,
          attempt: runningAttempt,
          attemptId,
          shouldFinalizeRun: () =>
            projectionStore.getThreadProjection(threadId).pipe(
              Effect.map((current) => {
                const currentRun = current.runs.find((candidate) => candidate.id === queuedRun.id);
                return currentRun?.activeAttemptId === attemptId;
              }),
              Effect.catchCause(() => Effect.succeed(false)),
            ),
          message: {
            messageId: message.id,
            text: message.text,
            attachments: message.attachments,
          },
          modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
        });
      });

    const dispatchThreadCreate = (
      command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
      events: Ref.Ref<Array<OrchestrationV2StoredEvent>>,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const emitEvent = emit(events, command);
        const thread: OrchestrationV2AppThread = {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          defaultProvider: command.modelSelection.provider,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          activeProviderThreadId: null,
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
        };

        yield* emitEvent({
          type: "thread.created",
          threadId: command.threadId,
          provider: command.modelSelection.provider,
          occurredAt: now,
          payload: thread,
        });
      });

    const dispatchSteerIntoRun = (input: {
      readonly command: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
      >;
      readonly events: Ref.Ref<Array<OrchestrationV2StoredEvent>>;
      readonly projection: OrchestrationV2ThreadProjection;
      readonly modelSelection: ModelSelection;
      readonly targetRunId: OrchestrationV2Run["id"];
      readonly messageId: OrchestrationV2ConversationMessage["id"];
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }) =>
      Effect.gen(function* () {
        const targetRun = input.projection.runs.find(
          (candidate) => candidate.id === input.targetRunId,
        );
        if (targetRun === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause: `Target run ${input.targetRunId} was not found.`,
          });
        }
        const rootNodeId = targetRun.rootNodeId;
        if (rootNodeId === null) {
          return yield* new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause: `Target run ${targetRun.id} has no root node.`,
          });
        }
        if (targetRun.status !== "running") {
          return yield* new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause: `Target run ${targetRun.id} is ${targetRun.status} and cannot be steered.`,
          });
        }
        const providerThread = input.projection.providerThreads.find(
          (candidate) => candidate.id === targetRun.providerThreadId,
        );
        if (providerThread === undefined || providerThread.providerSessionId === null) {
          return yield* new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause: `Provider thread ${targetRun.providerThreadId} has no active provider session for steering.`,
          });
        }
        const providerTurn = input.projection.providerTurns.find(
          (candidate) =>
            candidate.runAttemptId === targetRun.activeAttemptId && candidate.status === "running",
        );
        if (providerTurn === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause: `No running provider turn found for active run ${targetRun.id}.`,
          });
        }
        const sessionOption = yield* providerSessions.get(providerThread.providerSessionId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: input.command.commandId,
                commandType: input.command.type,
                cause,
              }),
          ),
        );
        if (Option.isNone(sessionOption)) {
          return yield* new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause: `Provider session ${providerThread.providerSessionId} is not active.`,
          });
        }

        const session = sessionOption.value;
        const now = yield* DateTime.now;
        const emitEvent = emit(input.events, input.command);
        const appendSteeringMessage = (messageInput: {
          readonly runId: OrchestrationV2Run["id"];
          readonly nodeId: OrchestrationV2ExecutionNode["id"];
          readonly providerTurnId: typeof providerTurn.id | null;
        }) =>
          Effect.gen(function* () {
            const message: OrchestrationV2ConversationMessage = {
              id: input.messageId,
              threadId: input.command.threadId,
              runId: messageInput.runId,
              nodeId: messageInput.nodeId,
              role: "user",
              text: input.text,
              attachments: input.attachments,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: idAllocator.derive.userTurnItem({ messageId: input.messageId }),
              threadId: input.command.threadId,
              runId: messageInput.runId,
              nodeId: messageInput.nodeId,
              providerThreadId: providerThread.id,
              providerTurnId: messageInput.providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: nextTurnItemOrdinal(input.projection),
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              messageId: input.messageId,
              text: input.text,
              attachments: input.attachments,
            };
            yield* emitEvent({
              type: "message.updated",
              threadId: input.command.threadId,
              runId: messageInput.runId,
              nodeId: messageInput.nodeId,
              provider: targetRun.provider,
              occurredAt: now,
              payload: message,
            });
            yield* emitEvent({
              type: "turn-item.updated",
              threadId: input.command.threadId,
              runId: messageInput.runId,
              nodeId: messageInput.nodeId,
              provider: targetRun.provider,
              occurredAt: now,
              payload: turnItem,
            });
          });

        if (session.providerSession.capabilities.turns.supportsActiveSteering) {
          yield* session
            .steerTurn({
              threadId: input.command.threadId,
              runId: targetRun.id,
              providerThread,
              providerTurnId: providerTurn.id,
              message: {
                messageId: input.messageId,
                text: input.text,
                attachments: input.attachments,
              },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorProviderAdapterError({
                    commandId: input.command.commandId,
                    provider: targetRun.provider,
                    cause,
                  }),
              ),
            );
          yield* appendSteeringMessage({
            runId: targetRun.id,
            nodeId: rootNodeId,
            providerTurnId: providerTurn.id,
          });
          return;
        }

        if (!session.providerSession.capabilities.turns.supportsSteeringByInterruptRestart) {
          return yield* new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause: `Provider ${targetRun.provider} cannot steer or restart active turns.`,
          });
        }

        yield* session.interruptTurn({ providerThread, providerTurnId: providerTurn.id }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: input.command.commandId,
                provider: targetRun.provider,
                cause,
              }),
          ),
        );

        const currentAttempt = input.projection.attempts.find(
          (candidate) => candidate.id === targetRun.activeAttemptId,
        );
        const currentRootNode = input.projection.nodes.find(
          (candidate) => candidate.id === rootNodeId,
        );
        const attemptOrdinal =
          Math.max(
            0,
            ...input.projection.attempts
              .filter((candidate) => candidate.runId === targetRun.id)
              .map((candidate) => candidate.attemptOrdinal),
          ) + 1;
        const nextAttemptId = idAllocator.derive.runAttempt({
          runId: targetRun.id,
          attemptOrdinal,
        });
        const nextRootNodeId = idAllocator.derive.rootNodeAttempt({
          runId: targetRun.id,
          attemptOrdinal,
        });
        const resolvedRuntimePolicy = yield* runtimePolicy
          .resolve({ thread: input.projection.thread, modelSelection: input.modelSelection })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: input.command.commandId,
                  commandType: input.command.type,
                  cause,
                }),
            ),
          );
        const checkpointScope = yield* checkpointService
          .prepareRootRunScope({
            threadId: input.command.threadId,
            runId: targetRun.id,
            rootNodeId: nextRootNodeId,
            providerThreadId: providerThread.id,
            cwd: resolvedRuntimePolicy.cwd ?? session.providerSession.cwd,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: input.command.commandId,
                  commandType: input.command.type,
                  cause,
                }),
            ),
          );
        const ensuredCheckpointScope = yield* checkpointService.ensureScope(checkpointScope).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: input.command.commandId,
                commandType: input.command.type,
                cause,
              }),
          ),
        );
        const restartedRun: OrchestrationV2Run = {
          ...targetRun,
          rootNodeId: nextRootNodeId,
          activeAttemptId: nextAttemptId,
          status: "running",
        };
        const nextAttempt: OrchestrationV2RunAttempt = {
          id: nextAttemptId,
          runId: targetRun.id,
          attemptOrdinal,
          rootNodeId: nextRootNodeId,
          provider: targetRun.provider,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          reason: "steering_restart",
          status: "running",
          startedAt: now,
          completedAt: null,
        };
        const nextRootNode: OrchestrationV2ExecutionNode = {
          id: nextRootNodeId,
          threadId: input.command.threadId,
          runId: targetRun.id,
          parentNodeId: null,
          rootNodeId: nextRootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: ensuredCheckpointScope.id,
          startedAt: now,
          completedAt: null,
        };
        yield* emitEvent({
          type: "provider-turn.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: rootNodeId,
          provider: targetRun.provider,
          occurredAt: now,
          payload: { ...providerTurn, status: "interrupted", completedAt: now },
        });
        if (currentAttempt !== undefined) {
          yield* emitEvent({
            type: "run-attempt.updated",
            threadId: input.command.threadId,
            runId: targetRun.id,
            nodeId: rootNodeId,
            provider: targetRun.provider,
            occurredAt: now,
            payload: { ...currentAttempt, status: "superseded", completedAt: now },
          });
        }
        if (currentRootNode !== undefined) {
          yield* emitEvent({
            type: "node.updated",
            threadId: input.command.threadId,
            runId: targetRun.id,
            nodeId: rootNodeId,
            provider: targetRun.provider,
            occurredAt: now,
            payload: { ...currentRootNode, status: "interrupted", completedAt: now },
          });
        }
        yield* emitEvent({
          type: "run.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: nextRootNodeId,
          provider: targetRun.provider,
          occurredAt: now,
          payload: restartedRun,
        });
        yield* emitEvent({
          type: "run-attempt.created",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: nextRootNodeId,
          provider: targetRun.provider,
          occurredAt: now,
          payload: nextAttempt,
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: nextRootNodeId,
          provider: targetRun.provider,
          occurredAt: now,
          payload: nextRootNode,
        });
        yield* emitEvent({
          type: "checkpoint-scope.created",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: nextRootNodeId,
          provider: targetRun.provider,
          occurredAt: now,
          payload: ensuredCheckpointScope,
        });
        yield* appendSteeringMessage({
          runId: targetRun.id,
          nodeId: nextRootNodeId,
          providerTurnId: null,
        });
        yield* runExecution
          .startRootRun({
            commandId: input.command.commandId,
            providerSessionId: providerThread.providerSessionId,
            session,
            run: restartedRun,
            rootNode: nextRootNode,
            checkpointScope: ensuredCheckpointScope,
            providerThread,
            attempt: nextAttempt,
            attemptId: nextAttemptId,
            shouldFinalizeRun: () =>
              projectionStore.getThreadProjection(input.command.threadId).pipe(
                Effect.map((current) => {
                  const currentRun = current.runs.find(
                    (candidate) => candidate.id === targetRun.id,
                  );
                  return currentRun?.activeAttemptId === nextAttemptId;
                }),
                Effect.catchCause(() => Effect.succeed(false)),
              ),
            message: {
              messageId: input.messageId,
              text: input.text,
              attachments: input.attachments,
            },
            modelSelection: input.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: input.command.commandId,
                  commandType: input.command.type,
                  cause,
                }),
            ),
          );
      });

    const dispatchMessage = (
      command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
      events: Ref.Ref<Array<OrchestrationV2StoredEvent>>,
    ) =>
      Effect.gen(function* () {
        const projection = yield* projectionStore
          .getThreadProjection(command.threadId)
          .pipe(
            Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
          );
        const modelSelection = command.modelSelection ?? projection.thread.modelSelection;
        const dispatchMode = command.dispatchMode;

        if (dispatchMode.type === "steer_active") {
          yield* dispatchSteerIntoRun({
            command,
            events,
            projection,
            modelSelection,
            targetRunId: dispatchMode.targetRunId,
            messageId: command.messageId,
            text: command.text,
            attachments: command.attachments,
          });
          return;
        }

        const activeProviderThread = projection.providerThreads.find(
          (candidate) => candidate.id === projection.thread.activeProviderThreadId,
        );
        const activeRun = projection.runs.find(isBlockingRun);
        const shouldQueue =
          activeRun !== undefined &&
          (dispatchMode.type === "start_immediately" || dispatchMode.type === "queue_after_active");
        if (shouldQueue) {
          const queueProviderThread =
            activeProviderThread ??
            projection.providerThreads.find(
              (candidate) => candidate.id === activeRun.providerThreadId,
            );
          if (queueProviderThread === undefined) {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: `Active run ${activeRun.id} has no provider thread for queued dispatch.`,
            });
          }
          if (modelSelection.provider !== queueProviderThread.provider) {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: `Queued dispatch for provider ${modelSelection.provider} cannot run behind active provider ${queueProviderThread.provider}.`,
            });
          }

          const resolvedRuntimePolicy = yield* runtimePolicy
            .resolve({ thread: projection.thread, modelSelection })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
          const now = yield* DateTime.now;
          const ordinal = nextRunOrdinal(projection);
          const runId = idAllocator.derive.run({ threadId: command.threadId, ordinal });
          const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
          const rootNodeId = idAllocator.derive.rootNode({ runId });
          const existingProviderSession =
            queueProviderThread.providerSessionId === null
              ? undefined
              : projection.providerSessions.find(
                  (candidate) => candidate.id === queueProviderThread.providerSessionId,
                );
          const checkpointScope = yield* checkpointService
            .prepareRootRunScope({
              threadId: command.threadId,
              runId,
              rootNodeId,
              providerThreadId: queueProviderThread.id,
              cwd:
                resolvedRuntimePolicy.cwd ??
                existingProviderSession?.cwd ??
                projection.thread.worktreePath ??
                process.cwd(),
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
          const run: OrchestrationV2Run = {
            id: runId,
            threadId: command.threadId,
            ordinal,
            provider: modelSelection.provider,
            providerThreadId: queueProviderThread.id,
            userMessageId: command.messageId,
            rootNodeId,
            activeAttemptId: attemptId,
            status: "queued",
            queuePosition:
              Math.max(
                0,
                ...projection.runs
                  .filter((candidate) => candidate.status === "queued")
                  .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
              ) + 1,
            requestedAt: now,
            startedAt: null,
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
            providerThreadId: queueProviderThread.id,
            providerTurnId: null,
            reason: "initial",
            status: "pending",
            startedAt: null,
            completedAt: null,
          };
          const rootNode: OrchestrationV2ExecutionNode = {
            id: rootNodeId,
            threadId: command.threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "pending",
            countsForRun: true,
            providerThreadId: queueProviderThread.id,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: checkpointScope.id,
            startedAt: null,
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
            id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: queueProviderThread.id,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100,
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
          const emitEvent = emit(events, command);
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
            type: "checkpoint-scope.created",
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            provider: modelSelection.provider,
            occurredAt: now,
            payload: yield* checkpointService.ensureScope(checkpointScope).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            ),
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
          return;
        }
        const providerSessionId =
          activeProviderThread?.providerSessionId ??
          (yield* mapDispatchError(command)(
            idAllocator.allocate.providerSession({
              provider: modelSelection.provider,
              threadId: command.threadId,
            }),
          ));
        const existingProviderSession = projection.providerSessions.find(
          (candidate) => candidate.id === providerSessionId,
        );
        const resolvedRuntimePolicy = yield* runtimePolicy
          .resolve({ thread: projection.thread, modelSelection })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );

        const now = yield* DateTime.now;
        const ordinal = nextRunOrdinal(projection);
        const activeSession = yield* providerSessions.get(providerSessionId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: command.commandId,
                provider: modelSelection.provider,
                cause,
              }),
          ),
        );
        const session = yield* providerSessions
          .open({
            threadId: command.threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            ...(existingProviderSession === undefined
              ? {}
              : { resumeFromSession: existingProviderSession }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: command.commandId,
                  provider: modelSelection.provider,
                  cause,
                }),
            ),
          );
        const ensuredProviderThread =
          activeProviderThread === undefined
            ? yield* session
                .ensureThread({
                  threadId: command.threadId,
                  modelSelection,
                  runtimePolicy: resolvedRuntimePolicy,
                  providerSessionId,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestratorProviderAdapterError({
                        commandId: command.commandId,
                        provider: modelSelection.provider,
                        cause,
                      }),
                  ),
                )
            : Option.isSome(activeSession)
              ? activeProviderThread
              : yield* session
                  .resumeThread({
                    providerThread: activeProviderThread,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new OrchestratorProviderAdapterError({
                          commandId: command.commandId,
                          provider: modelSelection.provider,
                          cause,
                        }),
                    ),
                  );
        const providerThread: OrchestrationV2ProviderThread = {
          ...ensuredProviderThread,
          status: "active",
          firstRunOrdinal: ensuredProviderThread.firstRunOrdinal ?? ordinal,
          lastRunOrdinal: ordinal,
          updatedAt: now,
        };

        const runId = idAllocator.derive.run({ threadId: command.threadId, ordinal });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const emitEvent = emit(events, command);
        const checkpointScope = yield* checkpointService
          .prepareRootRunScope({
            threadId: command.threadId,
            runId,
            rootNodeId,
            providerThreadId: providerThread.id,
            cwd: resolvedRuntimePolicy.cwd ?? session.providerSession.cwd,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
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
          queuePosition: null,
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
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: checkpointScope.id,
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
          id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 100,
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
          type: "provider-session.updated",
          threadId: command.threadId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: session.providerSession,
        });
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: command.threadId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: providerThread,
        });
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
          type: "checkpoint-scope.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: yield* checkpointService.ensureScope(checkpointScope).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          ),
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

        yield* runExecution
          .startRootRun({
            commandId: command.commandId,
            providerSessionId,
            session,
            run,
            rootNode,
            checkpointScope,
            providerThread,
            attempt,
            attemptId,
            shouldFinalizeRun: () =>
              projectionStore.getThreadProjection(command.threadId).pipe(
                Effect.map((current) => {
                  const currentRun = current.runs.find((candidate) => candidate.id === run.id);
                  return currentRun?.activeAttemptId === attemptId;
                }),
                Effect.catchCause(() => Effect.succeed(false)),
              ),
            message: {
              messageId: command.messageId,
              text: command.text,
              attachments: command.attachments,
            },
            modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
      });

    const dispatchRuntimeRequestRespond = (
      command: Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>,
      events: Ref.Ref<Array<OrchestrationV2StoredEvent>>,
    ) =>
      Effect.gen(function* () {
        const projection = yield* projectionStore
          .getThreadProjection(command.threadId)
          .pipe(
            Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
          );
        const runtimeRequest = projection.runtimeRequests.find(
          (candidate) => candidate.id === command.requestId,
        );
        if (runtimeRequest === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Runtime request ${command.requestId} was not found.`,
          });
        }
        if (runtimeRequest.status !== "pending") {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Runtime request ${command.requestId} is ${runtimeRequest.status}.`,
          });
        }
        if (runtimeRequest.responseCapability.type !== "live") {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: runtimeRequest.responseCapability.reason,
          });
        }

        const sessionOption = yield* providerSessions
          .get(runtimeRequest.responseCapability.providerSessionId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
        if (Option.isNone(sessionOption)) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Provider session ${runtimeRequest.responseCapability.providerSessionId} is not active.`,
          });
        }

        const session = sessionOption.value;
        yield* session
          .respondToRuntimeRequest({
            requestId: command.requestId,
            ...(command.decision === undefined ? {} : { decision: command.decision }),
            ...(command.answers === undefined ? {} : { answers: command.answers }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: command.commandId,
                  provider: session.provider,
                  cause,
                }),
            ),
          );

        const now = yield* DateTime.now;
        const resolvedRequest = {
          ...runtimeRequest,
          status: "resolved" as const,
          resolvedAt: now,
        };
        const emitEvent = emit(events, command);
        const requestNode = projection.nodes.find((node) => node.id === runtimeRequest.nodeId);
        const resolvedNodeStatus =
          command.decision === "decline" || command.decision === "cancel"
            ? ("cancelled" as const)
            : ("completed" as const);
        yield* emitEvent({
          type: "runtime-request.updated",
          threadId: command.threadId,
          ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
          nodeId: runtimeRequest.nodeId,
          provider: session.provider,
          occurredAt: now,
          payload: resolvedRequest,
        });
        if (requestNode !== undefined) {
          yield* emitEvent({
            type: "node.updated",
            threadId: command.threadId,
            ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
            nodeId: requestNode.id,
            provider: session.provider,
            occurredAt: now,
            payload: {
              ...requestNode,
              status: resolvedNodeStatus,
              completedAt: now,
            },
          });
        }

        const approvalTurnItem = projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === command.requestId,
        );
        if (approvalTurnItem !== undefined) {
          yield* emitEvent({
            type: "turn-item.updated",
            threadId: command.threadId,
            ...(approvalTurnItem.runId === null ? {} : { runId: approvalTurnItem.runId }),
            ...(approvalTurnItem.nodeId === null ? {} : { nodeId: approvalTurnItem.nodeId }),
            provider: session.provider,
            occurredAt: now,
            payload: {
              ...approvalTurnItem,
              status: resolvedNodeStatus,
              completedAt: now,
              updatedAt: now,
            },
          });
        }
      });

    const dispatchQueuedMessagePromoteToSteer = (
      command: Extract<
        OrchestrationV2Command,
        { readonly type: "queued-message.promote-to-steer" }
      >,
      events: Ref.Ref<Array<OrchestrationV2StoredEvent>>,
    ) =>
      Effect.gen(function* () {
        const projection = yield* projectionStore
          .getThreadProjection(command.threadId)
          .pipe(
            Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
          );
        const queuedRun = projection.runs.find((candidate) => candidate.id === command.queuedRunId);
        if (queuedRun === undefined || queuedRun.status !== "queued") {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Queued run ${command.queuedRunId} is not queued.`,
          });
        }
        const queuedRootNode =
          queuedRun.rootNodeId === null
            ? undefined
            : projection.nodes.find((candidate) => candidate.id === queuedRun.rootNodeId);
        const queuedAttempt =
          queuedRun.activeAttemptId === null
            ? undefined
            : projection.attempts.find((candidate) => candidate.id === queuedRun.activeAttemptId);
        const queuedMessage = projection.messages.find(
          (candidate) => candidate.id === queuedRun.userMessageId,
        );
        if (
          queuedRootNode === undefined ||
          queuedAttempt === undefined ||
          queuedMessage === undefined
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Queued run ${queuedRun.id} is missing message or execution state.`,
          });
        }

        const now = yield* DateTime.now;
        const emitEvent = emit(events, command);
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          nodeId: queuedRootNode.id,
          provider: queuedRun.provider,
          occurredAt: now,
          payload: {
            ...queuedRun,
            status: "cancelled",
            queuePosition: null,
            completedAt: now,
          },
        });
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          nodeId: queuedRootNode.id,
          provider: queuedRun.provider,
          occurredAt: now,
          payload: {
            ...queuedAttempt,
            status: "cancelled",
            completedAt: now,
          },
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          nodeId: queuedRootNode.id,
          provider: queuedRun.provider,
          occurredAt: now,
          payload: {
            ...queuedRootNode,
            status: "cancelled",
            completedAt: now,
          },
        });

        yield* dispatchSteerIntoRun({
          command,
          events,
          projection,
          modelSelection: projection.thread.modelSelection,
          targetRunId: command.targetRunId,
          messageId: queuedMessage.id,
          text: queuedMessage.text,
          attachments: queuedMessage.attachments,
        });
      });

    const dispatchQueuedRunReorder = (
      command: Extract<OrchestrationV2Command, { readonly type: "queued-run.reorder" }>,
      events: Ref.Ref<Array<OrchestrationV2StoredEvent>>,
    ) =>
      Effect.gen(function* () {
        const projection = yield* projectionStore
          .getThreadProjection(command.threadId)
          .pipe(
            Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
          );
        const queuedRuns = projection.runs
          .filter((run) => run.status === "queued")
          .toSorted(
            (left, right) =>
              (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
              left.ordinal - right.ordinal,
          );
        const moving = queuedRuns.find((run) => run.id === command.runId);
        if (moving === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Run ${command.runId} is not queued.`,
          });
        }
        const withoutMoving = queuedRuns.filter((run) => run.id !== command.runId);
        const beforeIndex =
          command.beforeRunId === null
            ? withoutMoving.length
            : withoutMoving.findIndex((run) => run.id === command.beforeRunId);
        if (beforeIndex === -1) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Queue target ${command.beforeRunId} is not queued.`,
          });
        }
        const reordered = [
          ...withoutMoving.slice(0, beforeIndex),
          moving,
          ...withoutMoving.slice(beforeIndex),
        ];
        const now = yield* DateTime.now;
        const emitEvent = emit(events, command);
        yield* Effect.forEach(
          reordered,
          (run, index) =>
            Effect.gen(function* () {
              const queuePosition = index + 1;
              if (run.queuePosition === queuePosition) {
                return;
              }
              yield* emitEvent({
                type: "run.updated",
                threadId: command.threadId,
                runId: run.id,
                ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
                provider: run.provider,
                occurredAt: now,
                payload: {
                  ...run,
                  queuePosition,
                },
              });
            }),
          { concurrency: 1 },
        );
      });

    const loadProjectionForCommand = (command: OrchestrationV2Command) =>
      projectionStore
        .getThreadProjection(commandThreadId(command))
        .pipe(
          Effect.mapError(
            () => new OrchestratorProjectionError({ threadId: commandThreadId(command) }),
          ),
        );

    const dispatchRunInterrupt = (
      command: Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>,
      events: Ref.Ref<Array<OrchestrationV2StoredEvent>>,
    ) =>
      Effect.gen(function* () {
        const findInterruptTarget = (
          attemptsRemaining = 100,
        ): Effect.Effect<
          {
            readonly projection: OrchestrationV2ThreadProjection;
            readonly run: OrchestrationV2Run;
            readonly rootNode: OrchestrationV2ExecutionNode;
            readonly providerThread: OrchestrationV2ProviderThread;
            readonly providerTurn: NonNullable<
              OrchestrationV2ThreadProjection["providerTurns"][number]
            >;
          },
          OrchestratorV2Error
        > =>
          Effect.gen(function* () {
            const projection = yield* loadProjectionForCommand(command);
            const run = projection.runs.find((candidate) => candidate.id === command.runId);
            const rootNode =
              run?.rootNodeId === null
                ? undefined
                : projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
            const providerThread =
              run?.providerThreadId === null
                ? undefined
                : projection.providerThreads.find(
                    (candidate) => candidate.id === run?.providerThreadId,
                  );
            const providerTurn = projection.providerTurns.find(
              (candidate) =>
                candidate.runAttemptId === run?.activeAttemptId && candidate.status === "running",
            );

            if (
              run !== undefined &&
              rootNode !== undefined &&
              providerThread !== undefined &&
              providerTurn !== undefined
            ) {
              return { projection, run, rootNode, providerThread, providerTurn };
            }

            if (attemptsRemaining <= 0) {
              return yield* new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: `Run ${command.runId} is not interruptible.`,
              });
            }
            yield* Effect.yieldNow;
            return yield* findInterruptTarget(attemptsRemaining - 1);
          });

        const { projection, run, rootNode, providerThread, providerTurn } =
          yield* findInterruptTarget();
        if (providerThread.providerSessionId === null) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Provider thread ${providerThread.id} has no active provider session.`,
          });
        }
        const sessionOption = yield* providerSessions.get(providerThread.providerSessionId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: command.commandId,
                provider: run.provider,
                cause,
              }),
          ),
        );
        if (Option.isNone(sessionOption)) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Provider session ${providerThread.providerSessionId} is not active.`,
          });
        }

        const now = yield* DateTime.now;
        const emitEvent = emit(events, command);
        /*
         * TODO(interrupt-hardening): before shipping, make these interrupt
         * semantics explicit in tests and policy.
         *
         * Current behavior:
         * - emit a `run_interrupt_request` item as user intent;
         * - call the provider interrupt RPC;
         * - keep the run active and continue ingesting provider chunks;
         * - let RunExecutionService emit `run_interrupt_result` only if the
         *   provider later reports terminal status `interrupted`.
         *
         * Known scenarios we do not fully harden yet:
         * - provider accepts interrupt, then emits more chunks before terminal;
         * - provider accepts interrupt, then completes normally instead;
         * - provider accepts interrupt but never terminalizes;
         * - user queues, steers, or starts another message while the interrupted
         *   provider turn is still active.
         *
         * Likely policy:
         * - queue should wait behind the still-active provider turn;
         * - explicit steer may target the active turn if provider steering is
         *   supported;
         * - starting a new root turn before provider terminalization should be
         *   an explicit policy decision because it can weaken native-item
         *   correlation.
         */
        const interruptRequestItem: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({
            runId: run.id,
            signal: "interrupt-request",
          }),
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: providerTurn.id,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: nextTurnItemOrdinal(projection),
          status: "completed",
          title: "Interrupt requested",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "run_interrupt_request",
          message: "Interrupt requested",
        };
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          provider: run.provider,
          occurredAt: now,
          payload: interruptRequestItem,
        });
        yield* sessionOption.value
          .interruptTurn({
            providerThread,
            providerTurnId: providerTurn.id,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: command.commandId,
                  provider: run.provider,
                  cause,
                }),
            ),
          );
      });

    const dispatchCheckpointRollback = (
      command: Extract<OrchestrationV2Command, { readonly type: "checkpoint.rollback" }>,
      events: Ref.Ref<Array<OrchestrationV2StoredEvent>>,
    ) =>
      Effect.gen(function* () {
        const projection = yield* loadProjectionForCommand(command);
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
        const resolvedRuntimePolicy = yield* runtimePolicy
          .resolve({ thread: projection.thread, modelSelection })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
        const existingProviderSession = projection.providerSessions.find(
          (candidate) => candidate.id === providerThread.providerSessionId,
        );
        const session = yield* providerSessions
          .open({
            threadId: command.threadId,
            providerSessionId: providerThread.providerSessionId,
            modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            ...(existingProviderSession === undefined
              ? {}
              : { resumeFromSession: existingProviderSession }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: command.commandId,
                  provider: modelSelection.provider,
                  cause,
                }),
            ),
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
        const targetOrdinal = targetCheckpoint.appRunOrdinal ?? 0;
        const runsToRollback = projection.runs.filter(
          (run) => run.ordinal > targetOrdinal && run.status === "completed",
        );
        yield* checkpointService
          .restore({
            scope: targetScope,
            checkpoint: targetCheckpoint,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
        const numTurns = runsToRollback.length;
        const snapshot =
          numTurns === 0
            ? { providerThread }
            : yield* session
                .rollbackThread({
                  providerThread,
                  providerPayload: { numTurns },
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestratorProviderAdapterError({
                        commandId: command.commandId,
                        provider: modelSelection.provider,
                        cause,
                      }),
                  ),
                );
        const staleCheckpoints = projection.checkpoints.filter(
          (checkpoint): checkpoint is OrchestrationV2Checkpoint =>
            checkpoint.scopeId === targetScope.id &&
            checkpoint.appRunOrdinal !== null &&
            checkpoint.appRunOrdinal > targetOrdinal &&
            checkpoint.status === "ready",
        );
        if (staleCheckpoints.length > 0) {
          yield* checkpointService
            .deleteStaleRefs({
              scope: targetScope,
              checkpoints: staleCheckpoints,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
        }

        const now = yield* DateTime.now;
        const emitEvent = emit(events, command);
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: command.threadId,
          provider: modelSelection.provider,
          occurredAt: now,
          payload: {
            ...snapshot.providerThread,
            lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
            updatedAt: now,
          },
        });
        for (const checkpoint of staleCheckpoints) {
          yield* emitEvent({
            type: "checkpoint.captured",
            threadId: command.threadId,
            ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
            nodeId: checkpoint.nodeId,
            provider: modelSelection.provider,
            occurredAt: now,
            payload: {
              ...checkpoint,
              status: "stale",
            },
          });
        }

        for (const run of runsToRollback) {
          const rootNode =
            run.rootNodeId === null
              ? undefined
              : projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
          yield* emitEvent({
            type: "run.updated",
            threadId: command.threadId,
            runId: run.id,
            ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
            provider: run.provider,
            occurredAt: now,
            payload: {
              ...run,
              status: "rolled_back",
              completedAt: now,
            },
          });
          if (rootNode !== undefined) {
            yield* emitEvent({
              type: "node.updated",
              threadId: command.threadId,
              runId: run.id,
              nodeId: rootNode.id,
              provider: run.provider,
              occurredAt: now,
              payload: {
                ...rootNode,
                status: "rolled_back",
                completedAt: now,
              },
            });
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

    const dispatchOnce = (
      command: OrchestrationV2Command,
    ): Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, OrchestratorV2Error> =>
      Effect.gen(function* () {
        const events = yield* Ref.make<Array<OrchestrationV2StoredEvent>>([]);
        switch (command.type) {
          case "thread.create":
            yield* dispatchThreadCreate(command, events);
            break;
          case "message.dispatch":
            yield* dispatchMessage(command, events);
            break;
          case "runtime-request.respond":
            yield* dispatchRuntimeRequestRespond(command, events);
            break;
          case "run.interrupt":
            yield* dispatchRunInterrupt(command, events);
            break;
          case "queued-message.promote-to-steer":
            yield* dispatchQueuedMessagePromoteToSteer(command, events);
            break;
          case "queued-run.reorder":
            yield* dispatchQueuedRunReorder(command, events);
            break;
          case "checkpoint.rollback":
            yield* dispatchCheckpointRollback(command, events);
            break;
          default:
            return yield* dispatchUnsupported(command);
        }
        return yield* Ref.get(events);
      });

    const dispatchWithReceipt = (command: OrchestrationV2Command) => {
      const effect = Effect.gen(function* () {
        const existingReceipt = yield* commandReceipts.getByCommandId(command.commandId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );

        if (Option.isSome(existingReceipt)) {
          const receipt = existingReceipt.value;
          if (receipt.status === "rejected") {
            return yield* new OrchestratorCommandPreviouslyRejectedError({
              commandId: command.commandId,
              commandType: command.type,
              detail: receipt.error ?? "Previously rejected.",
            });
          }
          const storedEvents = yield* eventSink
            .readByCommandId({ commandId: command.commandId })
            .pipe(
              Stream.runCollect,
              Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
          return {
            sequence: receipt.resultSequence,
            storedEvents,
          } satisfies OrchestratorV2DispatchResult;
        }

        const storedEvents = yield* dispatchOnce(command);
        const sequence = lastSequence(storedEvents);
        if (sequence === 0) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Command produced no stored events.",
          });
        }

        const acceptedAt = storedEvents.at(-1)?.event.occurredAt ?? (yield* DateTime.now);
        yield* commandReceipts
          .upsert({
            commandId: command.commandId,
            threadId: commandThreadId(command),
            commandType: command.type,
            acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );

        return {
          sequence,
          storedEvents,
        } satisfies OrchestratorV2DispatchResult;
      });

      return dispatchSemaphore.withPermit(effect);
    };

    yield* eventSink.stream().pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (stored.event.payload.status === "completed" ||
            stored.event.payload.status === "interrupted" ||
            stored.event.payload.status === "failed" ||
            stored.event.payload.status === "cancelled" ||
            stored.event.payload.status === "rolled_back"),
      ),
      Stream.runForEach((stored) =>
        dispatchSemaphore
          .withPermit(startNextQueuedRun(stored.event.threadId))
          .pipe(Effect.catchCause(() => Effect.void)),
      ),
      Effect.forkDetach,
    );

    return OrchestratorV2.of({
      dispatch: dispatchWithReceipt,
      getThreadProjection: (threadId) =>
        projectionStore
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(() => new OrchestratorProjectionError({ threadId }))),
      getThreadEventSequence: (threadId) =>
        eventSink
          .latestSequence({ threadId })
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
      streamStoredEvents: eventSink.stream().pipe(
        Stream.mapError(
          (cause) =>
            new OrchestratorDomainEventStreamError({
              cause,
            }),
        ),
      ),
      streamDomainEvents: eventSink.stream().pipe(
        Stream.map((stored) => stored.event),
        Stream.mapError(
          (cause) =>
            new OrchestratorDomainEventStreamError({
              cause,
            }),
        ),
      ),
    });
  }),
);

export const layerUnavailable: Layer.Layer<OrchestratorV2> = Layer.succeed(
  OrchestratorV2,
  OrchestratorV2.of({
    dispatch: (command) =>
      Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadProjection: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadEventSequence: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    streamStoredEvents: Stream.fail(
      new OrchestratorDomainEventStreamError({
        cause: "Orchestration V2 live runtime is not configured.",
      }),
    ),
    streamDomainEvents: Stream.fail(
      new OrchestratorDomainEventStreamError({
        cause: "Orchestration V2 live runtime is not configured.",
      }),
    ),
  } satisfies OrchestratorV2Shape),
);
