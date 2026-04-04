import type {
  ChatAttachment,
  MessageId,
  OrchestrationEvent,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import { sortCopy } from "./arrayCompat";

const MAX_THREAD_PROPOSED_PLANS = 200;

function updateThread(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  updater: (
    thread: OrchestrationReadModel["threads"][number],
  ) => OrchestrationReadModel["threads"][number],
): OrchestrationReadModel["threads"] {
  return snapshot.threads.map((thread) => (thread.id === threadId ? updater(thread) : thread));
}

function updateProject(
  snapshot: OrchestrationReadModel,
  projectId: OrchestrationProject["id"],
  updater: (project: OrchestrationProject) => OrchestrationProject,
): OrchestrationReadModel["projects"] {
  return snapshot.projects.map((project) =>
    project.id === projectId ? updater(project) : project,
  );
}

function upsertProject(
  snapshot: OrchestrationReadModel,
  nextProject: OrchestrationProject,
): OrchestrationReadModel["projects"] {
  const existing = snapshot.projects.find((project) => project.id === nextProject.id);
  if (existing) {
    return updateProject(snapshot, nextProject.id, () => nextProject);
  }
  return [...snapshot.projects, nextProject];
}

function upsertThread(
  snapshot: OrchestrationReadModel,
  nextThread: OrchestrationThread,
): OrchestrationReadModel["threads"] {
  const existing = snapshot.threads.find((thread) => thread.id === nextThread.id);
  if (existing) {
    return updateThread(snapshot, nextThread.id, () => nextThread);
  }
  return [...snapshot.threads, nextThread];
}

export function applyRealtimeEvent(
  snapshot: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  const nextBase: OrchestrationReadModel = {
    ...snapshot,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return {
        ...nextBase,
        projects: upsertProject(nextBase, {
          id: event.payload.projectId,
          title: event.payload.title,
          workspaceRoot: event.payload.workspaceRoot,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          deletedAt: null,
        }),
      };

    case "project.meta-updated":
      return {
        ...nextBase,
        projects: updateProject(nextBase, event.payload.projectId, (project) => ({
          ...project,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.workspaceRoot !== undefined
            ? { workspaceRoot: event.payload.workspaceRoot }
            : {}),
          ...(event.payload.defaultModelSelection !== undefined
            ? { defaultModelSelection: event.payload.defaultModelSelection }
            : {}),
          ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
          updatedAt: event.payload.updatedAt,
        })),
      };

    case "project.deleted":
      return {
        ...nextBase,
        projects: updateProject(nextBase, event.payload.projectId, (project) => ({
          ...project,
          deletedAt: event.payload.deletedAt,
          updatedAt: event.payload.deletedAt,
        })),
      };

    case "thread.created":
      return {
        ...nextBase,
        threads: upsertThread(nextBase, {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        }),
      };

    case "thread.deleted":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          deletedAt: event.payload.deletedAt,
          updatedAt: event.payload.deletedAt,
        })),
      };

    case "thread.archived":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          archivedAt: event.payload.archivedAt,
          updatedAt: event.payload.updatedAt,
        })),
      };

    case "thread.unarchived":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          archivedAt: null,
          updatedAt: event.payload.updatedAt,
        })),
      };

    case "thread.meta-updated":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        })),
      };

    case "thread.runtime-mode-set":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        })),
      };

    case "thread.interaction-mode-set":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        })),
      };

    case "thread.message-sent":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => {
          const existing = thread.messages.find(
            (message) => message.id === event.payload.messageId,
          );
          const nextMessages = existing
            ? thread.messages.map((message) =>
                message.id === event.payload.messageId
                  ? {
                      ...message,
                      text: event.payload.streaming
                        ? `${message.text}${event.payload.text}`
                        : event.payload.text.length > 0
                          ? event.payload.text
                          : message.text,
                      turnId: event.payload.turnId,
                      streaming: event.payload.streaming,
                      updatedAt: event.payload.updatedAt,
                      ...(event.payload.attachments
                        ? { attachments: event.payload.attachments }
                        : {}),
                    }
                  : message,
              )
            : [
                ...thread.messages,
                {
                  id: event.payload.messageId,
                  role: event.payload.role,
                  text: event.payload.text,
                  turnId: event.payload.turnId,
                  streaming: event.payload.streaming,
                  createdAt: event.payload.createdAt,
                  updatedAt: event.payload.updatedAt,
                  ...(event.payload.attachments ? { attachments: event.payload.attachments } : {}),
                },
              ];

          return {
            ...thread,
            messages: nextMessages,
            updatedAt: event.occurredAt,
          };
        }),
      };

    case "thread.turn-start-requested":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          updatedAt: event.occurredAt,
        })),
      };

    case "thread.session-set":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          session: event.payload.session,
          latestTurn:
            event.payload.session.status === "running" &&
            event.payload.session.activeTurnId !== null
              ? {
                  turnId: event.payload.session.activeTurnId,
                  state: "running",
                  requestedAt:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? thread.latestTurn.requestedAt
                      : event.payload.session.updatedAt,
                  startedAt:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                      : event.payload.session.updatedAt,
                  completedAt: null,
                  assistantMessageId:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? thread.latestTurn.assistantMessageId
                      : null,
                }
              : thread.latestTurn,
          updatedAt: event.occurredAt,
        })),
      };

    case "thread.proposed-plan-upserted":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          proposedPlans: sortCopy(
            [
              ...thread.proposedPlans.filter((proposedPlan) => {
                return proposedPlan.id !== event.payload.proposedPlan.id;
              }),
              event.payload.proposedPlan,
            ],
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          ).slice(-MAX_THREAD_PROPOSED_PLANS),
          updatedAt: event.occurredAt,
        })),
      };

    case "thread.turn-diff-completed":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => {
          const checkpoints = sortCopy(
            [
              ...thread.checkpoints.filter(
                (checkpoint) => checkpoint.turnId !== event.payload.turnId,
              ),
              {
                turnId: event.payload.turnId,
                checkpointTurnCount: event.payload.checkpointTurnCount,
                checkpointRef: event.payload.checkpointRef,
                status: event.payload.status,
                files: event.payload.files,
                assistantMessageId: event.payload.assistantMessageId,
                completedAt: event.payload.completedAt,
              },
            ],
            (left, right) => left.checkpointTurnCount - right.checkpointTurnCount,
          );

          const latestTurnState =
            event.payload.status === "error"
              ? "error"
              : event.payload.status === "missing"
                ? "interrupted"
                : "completed";

          return {
            ...thread,
            checkpoints,
            latestTurn: {
              turnId: event.payload.turnId,
              state: latestTurnState,
              requestedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.completedAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.startedAt ?? event.payload.completedAt)
                  : event.payload.completedAt,
              completedAt: event.payload.completedAt,
              assistantMessageId: event.payload.assistantMessageId,
            },
            updatedAt: event.occurredAt,
          };
        }),
      };

    case "thread.activity-appended":
      return {
        ...nextBase,
        threads: updateThread(nextBase, event.payload.threadId, (thread) => ({
          ...thread,
          activities: sortCopy(
            [
              ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
              event.payload.activity,
            ],
            (left, right) => {
              const leftSequence = left.sequence ?? Number.MIN_SAFE_INTEGER;
              const rightSequence = right.sequence ?? Number.MIN_SAFE_INTEGER;
              if (leftSequence !== rightSequence) {
                return leftSequence - rightSequence;
              }
              return (
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
              );
            },
          ),
          updatedAt: event.occurredAt,
        })),
      };

    default:
      return nextBase;
  }
}

export function requiresSnapshotRefresh(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
    case "thread.created":
    case "thread.deleted":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.meta-updated":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
    case "thread.message-sent":
    case "thread.turn-start-requested":
    case "thread.session-set":
    case "thread.proposed-plan-upserted":
    case "thread.turn-diff-completed":
    case "thread.activity-appended":
      return false;
    default:
      return true;
  }
}

export function applyOptimisticUserMessage(
  snapshot: OrchestrationReadModel,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly createdAt: string;
  },
): OrchestrationReadModel {
  return {
    ...snapshot,
    updatedAt: input.createdAt,
    threads: updateThread(snapshot, input.threadId, (thread) => {
      if (thread.messages.some((message) => message.id === input.messageId)) {
        return thread;
      }
      return {
        ...thread,
        updatedAt: input.createdAt,
        messages: [
          ...thread.messages,
          {
            id: input.messageId,
            role: "user",
            text: input.text,
            turnId: null,
            streaming: false,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
            ...(input.attachments && input.attachments.length > 0
              ? { attachments: input.attachments }
              : {}),
          },
        ],
      };
    }),
  };
}
