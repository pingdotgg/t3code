import type {
  MessageId,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
  requireQueuedTurn,
  requireThreadReadyForTurnStart,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import { assistantTurnCount } from "./Utils.ts";

const FORK_TITLE_PREFIX = "Forked: ";
const nowIso = () => new Date().toISOString();
const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

function forkedTitle(title: string): string {
  return title.startsWith(FORK_TITLE_PREFIX) ? title : `${FORK_TITLE_PREFIX}${title}`;
}

function remapForkTurnId(
  sourceTurnId: TurnId | null,
  turnIdBySourceId: Map<string, TurnId>,
): TurnId | null {
  if (sourceTurnId === null) {
    return null;
  }
  const existing = turnIdBySourceId.get(sourceTurnId);
  if (existing) {
    return existing;
  }
  const nextTurnId = crypto.randomUUID() as TurnId;
  turnIdBySourceId.set(sourceTurnId, nextTurnId);
  return nextTurnId;
}

function messageForkEvents(input: {
  readonly command: Extract<OrchestrationCommand, { type: "thread.fork" }>;
  readonly messages: OrchestrationReadModel["threads"][number]["messages"];
}): PlannedOrchestrationEvent[] {
  const turnIdBySourceId = new Map<string, TurnId>();
  return input.messages.map((message) => {
    const nextMessageId = crypto.randomUUID() as MessageId;
    const nextTurnId = remapForkTurnId(message.turnId, turnIdBySourceId);
    return {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: input.command.threadId,
        occurredAt: message.createdAt,
        commandId: input.command.commandId,
      }),
      type: "thread.message-sent",
      payload: {
        threadId: input.command.threadId,
        messageId: nextMessageId,
        role: message.role,
        text: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        turnId: nextTurnId,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    };
  });
}

type MessageSentPayload = Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"];
type TurnStartRequestedPayload = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>["payload"];

function buildTurnStartEvents(input: {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly threadId: MessageSentPayload["threadId"];
  readonly message: Pick<MessageSentPayload, "messageId" | "text" | "attachments">;
  readonly modelSelection: TurnStartRequestedPayload["modelSelection"];
  readonly titleSeed: TurnStartRequestedPayload["titleSeed"];
  readonly runtimeMode: TurnStartRequestedPayload["runtimeMode"];
  readonly interactionMode: TurnStartRequestedPayload["interactionMode"];
  readonly sourceProposedPlan: TurnStartRequestedPayload["sourceProposedPlan"];
  readonly at: string;
}): {
  readonly userMessageEvent: PlannedOrchestrationEvent;
  readonly turnStartRequestedEvent: PlannedOrchestrationEvent;
} {
  const eventBase = () =>
    withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.at,
      commandId: input.commandId,
    });
  const userMessageEvent: PlannedOrchestrationEvent = {
    ...eventBase(),
    type: "thread.message-sent",
    payload: {
      threadId: input.threadId,
      messageId: input.message.messageId,
      role: "user",
      text: input.message.text,
      attachments: input.message.attachments,
      turnId: null,
      streaming: false,
      createdAt: input.at,
      updatedAt: input.at,
    },
  };
  const turnStartRequestedEvent: PlannedOrchestrationEvent = {
    ...eventBase(),
    causationEventId: userMessageEvent.eventId,
    type: "thread.turn-start-requested",
    payload: {
      threadId: input.threadId,
      messageId: input.message.messageId,
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      ...(input.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: input.sourceProposedPlan }
        : {}),
      createdAt: input.at,
    },
  };
  return { userMessageEvent, turnStartRequestedEvent };
}

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<ReadonlyArray<PlannedOrchestrationEvent>, OrchestrationCommandInvariantError> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<DecideOrchestrationCommandResult, OrchestrationCommandInvariantError> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          parentThreadId: command.parentThreadId ?? null,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          pendingRuntimeMode: null,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.fork": {
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (sourceThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.sourceThreadId}' is deleted and cannot be forked.`,
        });
      }
      const targetMessageIndex = sourceThread.messages.findIndex(
        (message) => message.id === command.targetMessageId,
      );
      const targetMessage =
        targetMessageIndex >= 0 ? sourceThread.messages[targetMessageIndex] : undefined;
      if (!targetMessage) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.targetMessageId}' does not exist on thread '${command.sourceThreadId}'.`,
        });
      }
      if (targetMessage.role !== "assistant") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.targetMessageId}' is not an assistant response and cannot be forked.`,
        });
      }
      if (targetMessage.streaming) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.targetMessageId}' is still streaming and cannot be forked.`,
        });
      }

      const forkedMessages = sourceThread.messages.slice(0, targetMessageIndex + 1);
      const forkCreatedEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created" as const,
        payload: {
          threadId: command.threadId,
          projectId: sourceThread.projectId,
          parentThreadId: command.sourceThreadId,
          title: forkedTitle(sourceThread.title),
          modelSelection: sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
          pendingRuntimeMode: null,
          interactionMode: sourceThread.interactionMode,
          branch: sourceThread.branch,
          worktreePath: sourceThread.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const providerForkRequestedEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: forkCreatedEvent.eventId,
        type: "thread.provider-fork-requested" as const,
        payload: {
          sourceThreadId: command.sourceThreadId,
          threadId: command.threadId,
          targetMessageId: command.targetMessageId,
          targetTurnId: targetMessage.turnId,
          targetTurnCount: assistantTurnCount(forkedMessages),
          createdAt: command.createdAt,
        },
      };
      return [
        forkCreatedEvent,
        providerForkRequestedEvent,
        ...messageForkEvents({ command, messages: forkedMessages }),
      ];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pending-runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pending-runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThreadReadyForTurnStart({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const { userMessageEvent, turnStartRequestedEvent } = buildTurnStartEvents({
        commandId: command.commandId,
        threadId: command.threadId,
        message: {
          messageId: command.message.messageId,
          text: command.message.text,
          attachments: command.message.attachments,
        },
        modelSelection: command.modelSelection,
        titleSeed: command.titleSeed,
        runtimeMode: targetThread.runtimeMode,
        interactionMode: targetThread.interactionMode,
        sourceProposedPlan,
        at: command.createdAt,
      });
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.queued-turn.create": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if ((thread.queuedTurns ?? []).some((queuedTurn) => queuedTurn.id === command.queuedTurnId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.queuedTurnId}' already exists on thread '${command.threadId}'.`,
        });
      }
      const queuedTurn = {
        id: command.queuedTurnId,
        threadId: command.threadId,
        message: command.message,
        ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
        ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        ...(command.sourceProposedPlan !== undefined
          ? { sourceProposedPlan: command.sourceProposedPlan }
          : {}),
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        failedAt: null,
        failureMessage: null,
      };
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-created",
        payload: {
          threadId: command.threadId,
          queuedTurn,
        },
      };
    }

    case "thread.queued-turn.update": {
      yield* requireQueuedTurn({
        readModel,
        command,
        threadId: command.threadId,
        queuedTurnId: command.queuedTurnId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-updated",
        payload: {
          threadId: command.threadId,
          queuedTurnId: command.queuedTurnId,
          text: command.text,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "thread.queued-turn.delete": {
      yield* requireQueuedTurn({
        readModel,
        command,
        threadId: command.threadId,
        queuedTurnId: command.queuedTurnId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.deletedAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-deleted",
        payload: {
          threadId: command.threadId,
          queuedTurnId: command.queuedTurnId,
          deletedAt: command.deletedAt,
        },
      };
    }

    case "thread.queued-turn.dispatch": {
      const { thread: targetThread, queuedTurn } = yield* requireQueuedTurn({
        readModel,
        command,
        threadId: command.threadId,
        queuedTurnId: command.queuedTurnId,
      });
      yield* requireThreadReadyForTurnStart({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (queuedTurn.failedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.queuedTurnId}' is failed and must be edited before dispatch.`,
        });
      }
      const events: PlannedOrchestrationEvent[] = [];
      if (queuedTurn.modelSelection !== undefined) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.dispatchedAt,
            commandId: command.commandId,
          }),
          type: "thread.meta-updated",
          payload: {
            threadId: command.threadId,
            modelSelection: queuedTurn.modelSelection,
            updatedAt: command.dispatchedAt,
          },
        });
      }
      if (targetThread.runtimeMode !== queuedTurn.runtimeMode) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.dispatchedAt,
            commandId: command.commandId,
          }),
          type: "thread.runtime-mode-set",
          payload: {
            threadId: command.threadId,
            runtimeMode: queuedTurn.runtimeMode,
            updatedAt: command.dispatchedAt,
          },
        });
      }
      if (targetThread.interactionMode !== queuedTurn.interactionMode) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.dispatchedAt,
            commandId: command.commandId,
          }),
          type: "thread.interaction-mode-set",
          payload: {
            threadId: command.threadId,
            interactionMode: queuedTurn.interactionMode,
            updatedAt: command.dispatchedAt,
          },
        });
      }
      const { userMessageEvent, turnStartRequestedEvent } = buildTurnStartEvents({
        commandId: command.commandId,
        threadId: command.threadId,
        message: {
          messageId: queuedTurn.message.messageId,
          text: queuedTurn.message.text,
          attachments: queuedTurn.message.attachments,
        },
        modelSelection: queuedTurn.modelSelection,
        titleSeed: queuedTurn.titleSeed,
        runtimeMode: queuedTurn.runtimeMode,
        interactionMode: queuedTurn.interactionMode,
        sourceProposedPlan: queuedTurn.sourceProposedPlan,
        at: command.dispatchedAt,
      });
      const dispatchedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.dispatchedAt,
          commandId: command.commandId,
        }),
        causationEventId: turnStartRequestedEvent.eventId,
        type: "thread.queued-turn-dispatched",
        payload: {
          threadId: command.threadId,
          queuedTurnId: command.queuedTurnId,
          messageId: queuedTurn.message.messageId,
          dispatchedAt: command.dispatchedAt,
        },
      };
      return [...events, userMessageEvent, turnStartRequestedEvent, dispatchedEvent];
    }

    case "thread.queued-turn.fail": {
      yield* requireQueuedTurn({
        readModel,
        command,
        threadId: command.threadId,
        queuedTurnId: command.queuedTurnId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.failedAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-failed",
        payload: {
          threadId: command.threadId,
          queuedTurnId: command.queuedTurnId,
          failureMessage: command.failureMessage,
          failedAt: command.failedAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          agentTouchedPaths: command.agentTouchedPaths,
          turnFiles: command.turnFiles,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
