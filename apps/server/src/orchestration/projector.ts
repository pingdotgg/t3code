import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadId,
  WorkspaceBinding,
} from "@t3tools/contracts";
import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";
import { childLifecycleNotificationToActivity } from "@t3tools/shared/orchestrationActivity";
import { sameThreadPullRequest } from "@t3tools/shared/threadPullRequests";
import { Effect, Schema } from "effect";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  applyValidationEvent,
  isValidationLifecycleEvent,
} from "@t3tools/client-runtime/validation-lifecycle";
import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
  checkpointStatusToLatestTurnState,
  isNonAuthoritativeCheckpointStatus,
  planMetaUpdatedPullRequestLinks,
  resolveInitialThreadPullRequest,
  selectRetainedMessageIds,
  shouldPreserveActiveMessageId,
  terminalTurnStateForSessionStatus,
} from "./projection/ProjectionPolicy.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadChildLifecycleNotifiedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDecoupledPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadCollaborationRequestUpdatedPayload,
  ThreadCollaborationStateClearedPayload,
  ThreadPullRequestLinkedPayload,
  ThreadPullRequestRekeyedPayload,
  ThreadPullRequestUnlinkedPayload,
  ThreadPendingRuntimeModeSetPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadQueuedTurnCreatedPayload,
  ThreadQueuedTurnDeletedPayload,
  ThreadQueuedTurnDispatchedPayload,
  ThreadQueuedTurnFailedPayload,
  ThreadQueuedTurnUpdatedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadReviewResultSetPayload,
  ThreadSettledPayload,
  ThreadSnoozedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
  ThreadPinnedPayload,
  ThreadUnpinnedPayload,
  ThreadPinReorderedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  WorkflowArtifactCreatedPayload,
  WorkflowNodeWorkerStartedPayload,
  WorkflowRunFinalizedPayload,
  WorkflowRunRequestedPayload,
  WorkflowWorkerResultRecordedPayload,
} from "./Schemas.ts";

type ThreadPatch = Omit<
  Partial<Omit<OrchestrationThread, "id" | "projectId">>,
  "workspaceBinding"
> & {
  readonly workspaceBinding?: WorkspaceBinding | null;
};
export { MAX_THREAD_ACTIVITIES, MAX_THREAD_CHECKPOINTS, MAX_THREAD_MESSAGES };

function isNonAuthoritativeCheckpoint(status: string | undefined): boolean {
  return isNonAuthoritativeCheckpointStatus(status);
}

function latestTurnFromSession(
  thread: OrchestrationThread,
  session: OrchestrationSession,
): OrchestrationThread["latestTurn"] {
  if (session.status === "running" && session.activeTurnId !== null) {
    return {
      turnId: session.activeTurnId,
      state: "running",
      requestedAt:
        thread.latestTurn?.turnId === session.activeTurnId
          ? thread.latestTurn.requestedAt
          : session.updatedAt,
      startedAt:
        thread.latestTurn?.turnId === session.activeTurnId
          ? (thread.latestTurn.startedAt ?? session.updatedAt)
          : session.updatedAt,
      completedAt: null,
      assistantMessageId:
        thread.latestTurn?.turnId === session.activeTurnId
          ? thread.latestTurn.assistantMessageId
          : null,
    };
  }

  if (thread.latestTurn?.state === "running") {
    return {
      ...thread.latestTurn,
      state: terminalTurnStateForSessionStatus(session.status),
      completedAt: session.updatedAt,
    };
  }

  return thread.latestTurn;
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => {
    if (thread.id !== threadId) return thread;
    const { workspaceBinding, ...patchWithoutBinding } = patch;
    const nextThread = { ...thread, ...patchWithoutBinding };
    if (workspaceBinding === null) {
      const { workspaceBinding: _workspaceBinding, ...threadWithoutBinding } = nextThread;
      return threadWithoutBinding;
    }
    return workspaceBinding === undefined ? nextThread : { ...nextThread, workspaceBinding };
  });
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = selectRetainedMessageIds(
    messages.map((message) => ({
      messageId: message.id,
      turnId: message.turnId,
      role: message.role,
      createdAt: message.createdAt,
    })),
    retainedTurnIds,
    turnCount,
  );
  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function appendThreadActivity(
  thread: OrchestrationThread,
  activity: OrchestrationThread["activities"][number],
): Array<OrchestrationThread["activities"][number]> {
  const tailActivity = thread.activities.at(-1);
  let canAppendInOrder =
    tailActivity === undefined || compareThreadActivities(tailActivity, activity) <= 0;
  if (canAppendInOrder) {
    let previousActivity: OrchestrationThread["activities"][number] | undefined;
    for (const existingActivity of thread.activities) {
      if (
        existingActivity.id === activity.id ||
        (previousActivity !== undefined &&
          compareThreadActivities(previousActivity, existingActivity) > 0)
      ) {
        canAppendInOrder = false;
        break;
      }
      previousActivity = existingActivity;
    }
  }

  if (canAppendInOrder) {
    const activities = thread.activities.slice(1 - MAX_THREAD_ACTIVITIES);
    activities.push(activity);
    return activities;
  }
  return [...thread.activities.filter((entry) => entry.id !== activity.id), activity]
    .toSorted(compareThreadActivities)
    .slice(-MAX_THREAD_ACTIVITIES);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    workflowRuns: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  if (isValidationLifecycleEvent(event)) {
    const currentThread = nextBase.threads.find((thread) => thread.id === event.payload.threadId);
    if (!currentThread) {
      return Effect.succeed(nextBase);
    }
    const validation = applyValidationEvent(
      {
        request: currentThread.validationRequest ?? null,
        run: currentThread.validationRun ?? null,
      },
      event,
    );
    return Effect.succeed({
      ...nextBase,
      threads: updateThread(nextBase.threads, event.payload.threadId, {
        validationRequest: validation.request,
        validationRun: validation.run,
        updatedAt: event.occurredAt,
      }),
    });
  }

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            ...(payload.kind === "chat-import" ? { kind: payload.kind } : {}),
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            autoPull: false,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  ...(payload.autoPull !== undefined ? { autoPull: payload.autoPull } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const { initialPullRequest, source } = resolveInitialThreadPullRequest({
          pullRequest: payload.pullRequest,
          reviewSnapshot: payload.reviewSnapshot,
        });
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            nudging: payload.nudging,
            id: payload.threadId,
            projectId: payload.projectId,
            ...(payload.parentThreadId !== undefined
              ? { parentThreadId: payload.parentThreadId }
              : {}),
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            pendingRuntimeMode: payload.pendingRuntimeMode ?? null,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            ...(payload.workspaceBinding !== undefined
              ? { workspaceBinding: payload.workspaceBinding }
              : {}),
            ...(initialPullRequest !== undefined ? { pullRequest: initialPullRequest } : {}),
            ...(initialPullRequest !== undefined && initialPullRequest !== null
              ? {
                  pullRequests: [
                    {
                      pullRequest: initialPullRequest,
                      source: source ?? ("recovered" as const),
                      linkedAt: payload.createdAt,
                    },
                  ],
                }
              : {}),
            ...(payload.reviewSnapshot !== undefined
              ? { reviewSnapshot: payload.reviewSnapshot }
              : {}),
            reviewResult: null,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            deletedAt: null,
            messages: [],
            queuedTurns: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            titleRegeneration: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            settledAt: payload.settledAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            ...(payload.pinOrderKey !== undefined ? { pinOrderKey: payload.pinOrderKey } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            pinOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pin-reordered":
      return decodeForEvent(ThreadPinReorderedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinOrderKey: payload.orderKey,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.decoupled":
      return decodeForEvent(ThreadDecoupledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            parentThreadId: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread = nextBase.threads.find((thread) => thread.id === payload.threadId);
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.nudging !== undefined ? { nudging: payload.nudging } : {}),
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.titleRegeneration !== undefined
                ? { titleRegeneration: payload.titleRegeneration }
                : {}),
              ...(payload.modelSelection !== undefined
                ? { modelSelection: payload.modelSelection }
                : {}),
              ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
              ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
              ...(payload.workspaceBinding !== undefined
                ? { workspaceBinding: payload.workspaceBinding }
                : {}),
              ...(payload.pullRequest !== undefined
                ? {
                    pullRequest: payload.pullRequest,
                    ...(payload.pullRequest !== null
                      ? {
                          pullRequests: planMetaUpdatedPullRequestLinks({
                            existingLinks: existingThread?.pullRequests,
                            existingLegacyPullRequest: existingThread?.pullRequest,
                            createdAt: existingThread?.createdAt ?? payload.updatedAt,
                            nextPullRequest: payload.pullRequest,
                            updatedAt: payload.updatedAt,
                            source: payload.pullRequestSource,
                          }).allLinks,
                        }
                      : {}),
                  }
                : {}),
              ...(payload.pendingPullRequestAssociation !== undefined
                ? { pendingPullRequestAssociation: payload.pendingPullRequestAssociation }
                : {}),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.collaboration-request-updated":
      return decodeForEvent(
        ThreadCollaborationRequestUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            collaborationRequests: (() => {
              const existing =
                nextBase.threads.find((thread) => thread.id === payload.threadId)
                  ?.collaborationRequests ?? [];
              const withoutRequest = existing.filter(
                (request) => request.requestId !== payload.request.requestId,
              );
              return [...withoutRequest, payload.request].toSorted((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
              );
            })(),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.collaboration-state-cleared":
      return decodeForEvent(
        ThreadCollaborationStateClearedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            collaborationRequests: [],
            updatedAt: payload.clearedAt,
          }),
        })),
      );

    case "thread.pull-request-linked":
      return decodeForEvent(
        ThreadPullRequestLinkedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pullRequests: (() => {
              const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
              if (!thread) return [];
              const existing = thread.pullRequests ?? [];
              const index = existing.findIndex((link) =>
                sameThreadPullRequest(link.pullRequest, payload.link.pullRequest),
              );
              return index < 0
                ? [...existing, payload.link]
                : existing.map((link, linkIndex) => (linkIndex === index ? payload.link : link));
            })(),
            pendingPullRequestAssociation: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pull-request-unlinked":
      return decodeForEvent(
        ThreadPullRequestUnlinkedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(
            nextBase.threads,
            payload.threadId,
            (() => {
              const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
              return {
                ...(thread?.pullRequest &&
                sameThreadPullRequest(thread.pullRequest, payload.pullRequest)
                  ? { pullRequest: null }
                  : {}),
                pullRequests: (thread?.pullRequests ?? []).filter(
                  (link) => !sameThreadPullRequest(link.pullRequest, payload.pullRequest),
                ),
                pendingPullRequestAssociation: null,
                updatedAt: payload.updatedAt,
              };
            })(),
          ),
        })),
      );

    case "thread.pull-request-rekeyed":
      return decodeForEvent(
        ThreadPullRequestRekeyedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(
            nextBase.threads,
            payload.threadId,
            (() => {
              const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
              const pullRequests = [
                ...(thread?.pullRequests ?? []).filter(
                  (link) =>
                    !sameThreadPullRequest(link.pullRequest, payload.previousPullRequest) &&
                    !sameThreadPullRequest(link.pullRequest, payload.link.pullRequest),
                ),
                payload.link,
              ];
              return {
                ...(thread?.pullRequest &&
                sameThreadPullRequest(thread.pullRequest, payload.previousPullRequest)
                  ? { pullRequest: payload.link.pullRequest }
                  : {}),
                pullRequests,
                updatedAt: payload.updatedAt,
              };
            })(),
          ),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            pendingRuntimeMode: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pending-runtime-mode-set":
      return decodeForEvent(
        ThreadPendingRuntimeModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pendingRuntimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            ...(payload.origin !== undefined ? { origin: payload.origin } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text:
                      payload.replaceExisting === true
                        ? message.text
                        : message.streaming
                          ? `${entry.text}${message.text}`
                          : message.text.length > 0
                            ? message.text
                            : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.review-result-set":
      return decodeForEvent(
        ThreadReviewResultSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            reviewResult: payload.result,
            // The result is anchored to this snapshot; keep the diff the panel
            // renders aligned with the findings it annotates.
            reviewSnapshot: payload.result.snapshot,
            updatedAt: event.occurredAt,
          }),
        })),
      );

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const decodedSession: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );
        const session = shouldPreserveActiveMessageId({
          activeTurnId: decodedSession.activeTurnId,
          activeMessageId: decodedSession.activeMessageId,
        })
          ? {
              ...decodedSession,
              ...(thread.session?.activeMessageId !== undefined
                ? { activeMessageId: thread.session.activeMessageId }
                : {}),
            }
          : decodedSession;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn: latestTurnFromSession(thread, session),
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.queued-turn-created":
      return decodeForEvent(
        ThreadQueuedTurnCreatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          const queuedTurns = [
            ...(thread.queuedTurns ?? []).filter(
              (queuedTurn) => queuedTurn.id !== payload.queuedTurn.id,
            ),
            payload.queuedTurn,
          ].toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          );
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              queuedTurns,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.queued-turn-updated":
      return decodeForEvent(
        ThreadQueuedTurnUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          const queuedTurns = (thread.queuedTurns ?? []).map((queuedTurn) =>
            queuedTurn.id === payload.queuedTurnId
              ? {
                  ...queuedTurn,
                  message: { ...queuedTurn.message, text: payload.text },
                  ...(payload.origin !== undefined ? { origin: payload.origin } : {}),
                  updatedAt: payload.updatedAt,
                  failedAt: null,
                  failureMessage: null,
                }
              : queuedTurn,
          );
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              queuedTurns,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.queued-turn-deleted":
      return decodeForEvent(
        ThreadQueuedTurnDeletedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              queuedTurns: (thread.queuedTurns ?? []).filter(
                (queuedTurn) => queuedTurn.id !== payload.queuedTurnId,
              ),
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.queued-turn-dispatched":
      return decodeForEvent(
        ThreadQueuedTurnDispatchedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              queuedTurns: (thread.queuedTurns ?? []).filter(
                (queuedTurn) => queuedTurn.id !== payload.queuedTurnId,
              ),
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.queued-turn-failed":
      return decodeForEvent(
        ThreadQueuedTurnFailedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              queuedTurns: (thread.queuedTurns ?? []).map((queuedTurn) =>
                queuedTurn.id === payload.queuedTurnId
                  ? {
                      ...queuedTurn,
                      failedAt: payload.failedAt,
                      failureMessage: payload.failureMessage,
                      updatedAt: payload.failedAt,
                    }
                  : queuedTurn,
              ),
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            agentTouchedPaths: payload.agentTouchedPaths,
            turnFiles: payload.turnFiles,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a speculative provider diff overwrite a checkpoint that
        // has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later speculative updates would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (
          existing &&
          !isNonAuthoritativeCheckpoint(existing.status) &&
          isNonAuthoritativeCheckpoint(checkpoint.status)
        ) {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: {
              turnId: payload.turnId,
              state: checkpointStatusToLatestTurnState(payload.status),
              requestedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? thread.latestTurn.requestedAt
                  : payload.completedAt,
              startedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? (thread.latestTurn.startedAt ?? payload.completedAt)
                  : payload.completedAt,
              completedAt: payload.completedAt,
              assistantMessageId: payload.assistantMessageId,
            },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-MAX_THREAD_PROPOSED_PLANS);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities: appendThreadActivity(thread, payload.activity),
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.child-lifecycle-notified":
      return decodeForEvent(
        ThreadChildLifecycleNotifiedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const parent = nextBase.threads.find((entry) => entry.id === payload.parentThreadId);
          if (!parent) {
            return nextBase;
          }
          const activity = childLifecycleNotificationToActivity({
            eventId: event.eventId,
            payload,
            sequence: event.sequence,
          });
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.parentThreadId, {
              activities: appendThreadActivity(parent, activity),
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "workflow.run-requested":
      return decodeForEvent(WorkflowRunRequestedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workflowRuns: [
            ...(nextBase.workflowRuns ?? []).filter((run) => run.id !== payload.run.id),
            payload.run,
          ],
        })),
      );

    case "workflow.artifact-created":
      return decodeForEvent(
        WorkflowArtifactCreatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          if (payload.artifact.payload.kind !== "input-context") {
            return nextBase;
          }
          return {
            ...nextBase,
            workflowRuns: (nextBase.workflowRuns ?? []).map((run) =>
              run.id !== payload.artifact.runId
                ? run
                : {
                    ...run,
                    nodes: run.nodes.map((node) =>
                      node.nodeId === payload.artifact.nodeId
                        ? { ...node, inputArtifactId: payload.artifact.id }
                        : node,
                    ),
                    updatedAt: event.occurredAt,
                  },
            ),
          };
        }),
      );

    case "workflow.node-worker-started":
      return decodeForEvent(
        WorkflowNodeWorkerStartedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workflowRuns: (nextBase.workflowRuns ?? []).map((run) =>
            run.id !== payload.runId
              ? run
              : {
                  ...run,
                  status: "running",
                  nodes: run.nodes.map((node) =>
                    node.nodeId === payload.nodeId
                      ? {
                          ...node,
                          status: "running",
                          workerThreadId: payload.workerThreadId,
                          startedAt: payload.startedAt,
                        }
                      : node,
                  ),
                  updatedAt: event.occurredAt,
                },
          ),
        })),
      );

    case "workflow.worker-result-recorded":
      return decodeForEvent(
        WorkflowWorkerResultRecordedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const artifactPayload = payload.artifact.payload;
          if (artifactPayload.kind !== "worker-result") {
            return nextBase;
          }
          return {
            ...nextBase,
            workflowRuns: (nextBase.workflowRuns ?? []).map((run) =>
              run.id !== payload.runId
                ? run
                : {
                    ...run,
                    nodes: run.nodes.map((node) =>
                      node.nodeId === payload.artifact.nodeId
                        ? {
                            ...node,
                            status: artifactPayload.status,
                            resultArtifactId: payload.artifact.id,
                            completedAt: payload.completedAt,
                          }
                        : node,
                    ),
                    updatedAt: event.occurredAt,
                  },
            ),
          };
        }),
      );

    case "workflow.run-finalized":
      return decodeForEvent(WorkflowRunFinalizedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workflowRuns: (nextBase.workflowRuns ?? []).map((run) =>
            run.id !== payload.runId
              ? run
              : {
                  ...run,
                  status: payload.status,
                  nodes:
                    payload.status === "failed"
                      ? run.nodes.map((node) =>
                          node.status === "pending"
                            ? {
                                ...node,
                                status: "failed" as const,
                                completedAt: payload.completedAt,
                              }
                            : node,
                        )
                      : run.nodes,
                  finalArtifactId: payload.artifact.id,
                  updatedAt: payload.completedAt,
                  completedAt: payload.completedAt,
                },
          ),
        })),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
