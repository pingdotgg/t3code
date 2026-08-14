import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

function makeActivityEvent(input: {
  eventSequence: number;
  threadId: string;
  activityId: string;
  activitySequence?: number;
  createdAt: string;
  summary?: string;
}): OrchestrationEvent {
  return makeEvent({
    sequence: input.eventSequence,
    type: "thread.activity-appended",
    aggregateKind: "thread",
    aggregateId: input.threadId,
    occurredAt: input.createdAt,
    commandId: `cmd-${input.activityId}-${input.eventSequence}`,
    payload: {
      threadId: input.threadId,
      activity: {
        id: input.activityId,
        tone: "info",
        kind: "test.activity",
        summary: input.summary ?? input.activityId,
        payload: {},
        turnId: null,
        ...(input.activitySequence === undefined ? {} : { sequence: input.activitySequence }),
        createdAt: input.createdAt,
      },
    },
  });
}

async function createThreadModel(threadId: string, createdAt: string) {
  return Effect.runPromise(
    projectEvent(
      createEmptyReadModel(createdAt),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: `cmd-${threadId}`,
        payload: {
          threadId,
          projectId: "project-1",
          title: threadId,
          modelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
    ),
  );
}

describe("orchestration projector", () => {
  it("applies thread.created events", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            parentThreadId: "parent-thread",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        parentThreadId: "parent-thread",
        title: "demo",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        pendingRuntimeMode: null,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        reviewResult: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        queuedTurns: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ]);
  });

  it("persists explicit pullRequest association and leaves peers without one", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);
    const pullRequest = {
      number: 42,
      title: "Durable association",
      url: "https://example.test/pr/42",
      baseBranch: "main",
      headBranch: "feature/shared",
      state: "open" as const,
    };

    const withAssociated = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-pr",
          occurredAt: now,
          commandId: "cmd-thread-pr",
          payload: {
            threadId: "thread-pr",
            projectId: "project-1",
            title: "with pr",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: "feature/shared",
            worktreePath: null,
            pullRequest,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const withPeer = await Effect.runPromise(
      projectEvent(
        withAssociated,
        makeEvent({
          sequence: 2,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-peer",
          occurredAt: now,
          commandId: "cmd-thread-peer",
          payload: {
            threadId: "thread-peer",
            projectId: "project-1",
            title: "peer",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: "feature/shared",
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const associated = withPeer.threads.find((thread) => thread.id === "thread-pr");
    const peer = withPeer.threads.find((thread) => thread.id === "thread-peer");
    expect(associated?.pullRequest).toEqual(pullRequest);
    expect(peer?.pullRequest).toBeUndefined();

    const afterBranchOnlyMeta = await Effect.runPromise(
      projectEvent(
        withPeer,
        makeEvent({
          sequence: 3,
          type: "thread.meta-updated",
          aggregateKind: "thread",
          aggregateId: "thread-pr",
          occurredAt: now,
          commandId: "cmd-branch-only",
          payload: {
            threadId: "thread-pr",
            branch: "feature/other",
            updatedAt: now,
          },
        }),
      ),
    );

    expect(
      afterBranchOnlyMeta.threads.find((thread) => thread.id === "thread-pr")?.pullRequest,
    ).toEqual(pullRequest);
  });

  it("recovers explicit PR review provenance from legacy thread.created events", async () => {
    const now = new Date().toISOString();
    const projected = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-review-pr",
          occurredAt: now,
          commandId: "cmd-thread-review-pr",
          payload: {
            threadId: "thread-review-pr",
            projectId: "project-1",
            title: "Review PR #146",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: "unrelated-live-branch",
            worktreePath: null,
            reviewSnapshot: {
              scope: {
                kind: "pull-request",
                number: 146,
                title: "Explicit review",
                url: "https://github.com/acme/repo/pull/146",
                baseBranch: "main",
                headBranch: "feature/pr-146",
              },
              diff: "diff",
              diffHash: "hash",
            },
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(projected.threads[0]?.pullRequest).toEqual({
      number: 146,
      title: "Explicit review",
      url: "https://github.com/acme/repo/pull/146",
      baseBranch: "main",
      headBranch: "feature/pr-146",
      state: null,
    });
  });

  it("fast-appends ordered activities while preserving the 500-item cap", async () => {
    const createdAt = "2026-08-14T12:00:00.000Z";
    const threadId = "thread-activity-fast-append";
    const created = await createThreadModel(threadId, createdAt);
    const events = Array.from({ length: 501 }, (_, index) => {
      const activityNumber = index + 1;
      return makeActivityEvent({
        eventSequence: activityNumber + 1,
        threadId,
        activityId: `activity-${String(activityNumber).padStart(3, "0")}`,
        activitySequence: activityNumber,
        createdAt: `2026-08-14T12:${String(Math.floor(activityNumber / 60)).padStart(
          2,
          "0",
        )}:${String(activityNumber % 60).padStart(2, "0")}.000Z`,
      });
    });
    const projected = await events.reduce<Promise<typeof created>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(created),
    );

    const activities = projected.threads[0]?.activities;
    expect(activities).toHaveLength(500);
    expect(activities?.[0]?.id).toBe("activity-002");
    expect(activities?.at(-1)?.id).toBe("activity-501");
  });

  it("replaces duplicate activity IDs before reordering updates", async () => {
    const createdAt = "2026-08-14T13:00:00.000Z";
    const threadId = "thread-activity-duplicate";
    const created = await createThreadModel(threadId, createdAt);
    const initialEvents = [
      makeActivityEvent({
        eventSequence: 2,
        threadId,
        activityId: "activity-update",
        activitySequence: 1,
        createdAt: "2026-08-14T13:00:01.000Z",
        summary: "before",
      }),
      makeActivityEvent({
        eventSequence: 3,
        threadId,
        activityId: "activity-tail",
        activitySequence: 2,
        createdAt: "2026-08-14T13:00:02.000Z",
      }),
    ];
    const beforeUpdate = await initialEvents.reduce<Promise<typeof created>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(created),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        beforeUpdate,
        makeActivityEvent({
          eventSequence: 4,
          threadId,
          activityId: "activity-update",
          activitySequence: 3,
          createdAt: "2026-08-14T13:00:03.000Z",
          summary: "after",
        }),
      ),
    );

    expect(
      afterUpdate.threads[0]?.activities.map((activity) => ({
        id: activity.id,
        sequence: activity.sequence,
        summary: activity.summary,
      })),
    ).toEqual([
      { id: "activity-tail", sequence: 2, summary: "activity-tail" },
      { id: "activity-update", sequence: 3, summary: "after" },
    ]);
  });

  it("falls back to full ordering for out-of-order activities without sequences", async () => {
    const createdAt = "2026-08-14T14:00:00.000Z";
    const threadId = "thread-activity-out-of-order";
    const created = await createThreadModel(threadId, createdAt);
    const orderedEvents = [
      makeActivityEvent({
        eventSequence: 2,
        threadId,
        activityId: "activity-a",
        createdAt: "2026-08-14T14:00:01.000Z",
      }),
      makeActivityEvent({
        eventSequence: 3,
        threadId,
        activityId: "activity-c",
        createdAt: "2026-08-14T14:00:01.000Z",
      }),
      makeActivityEvent({
        eventSequence: 4,
        threadId,
        activityId: "activity-sequenced",
        activitySequence: 1,
        createdAt: "2026-08-14T14:00:00.000Z",
      }),
    ];
    const beforeOutOfOrder = await orderedEvents.reduce<Promise<typeof created>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(created),
    );

    const afterOutOfOrder = await Effect.runPromise(
      projectEvent(
        beforeOutOfOrder,
        makeActivityEvent({
          eventSequence: 5,
          threadId,
          activityId: "activity-b",
          createdAt: "2026-08-14T14:00:01.000Z",
        }),
      ),
    );

    expect(afterOutOfOrder.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "activity-a",
      "activity-b",
      "activity-c",
      "activity-sequenced",
    ]);
  });

  it("falls back when restart-loaded activities are not comparator-sorted", async () => {
    const createdAt = "2026-08-14T15:00:00.000Z";
    const threadId = "thread-activity-restart-order";
    const created = await createThreadModel(threadId, createdAt);
    const initialEvents = [
      makeActivityEvent({
        eventSequence: 2,
        threadId,
        activityId: "activity-unsequenced",
        createdAt: "2026-08-14T15:00:01.000Z",
      }),
      makeActivityEvent({
        eventSequence: 3,
        threadId,
        activityId: "activity-sequence-1",
        activitySequence: 1,
        createdAt: "2026-08-14T15:00:00.000Z",
      }),
    ];
    const projected = await initialEvents.reduce<Promise<typeof created>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(created),
    );
    const restarted = {
      ...projected,
      threads: projected.threads.map((thread) => ({
        ...thread,
        activities: thread.activities.toReversed(),
      })),
    };

    const afterAppend = await Effect.runPromise(
      projectEvent(
        restarted,
        makeActivityEvent({
          eventSequence: 4,
          threadId,
          activityId: "activity-sequence-2",
          activitySequence: 2,
          createdAt: "2026-08-14T15:00:02.000Z",
        }),
      ),
    );

    expect(afterAppend.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "activity-unsequenced",
      "activity-sequence-1",
      "activity-sequence-2",
    ]);
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5-codex",
              },
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("applies thread.archived and thread.unarchived events", async () => {
    const now = new Date().toISOString();
    const later = new Date(Date.parse(now) + 1_000).toISOString();
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
            updatedAt: later,
          },
        }),
      ),
    );
    expect(archived.threads[0]?.archivedAt).toBe(later);

    const unarchived = await Effect.runPromise(
      projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-unarchive",
          payload: {
            threadId: "thread-1",
            updatedAt: later,
          },
        }),
      ),
    );
    expect(unarchived.threads[0]?.archivedAt).toBeNull();
  });

  it("applies queued turn lifecycle events", async () => {
    const createdAt = "2026-03-01T00:00:00.000Z";
    const updatedAt = "2026-03-01T00:00:01.000Z";
    const failedAt = "2026-03-01T00:00:02.000Z";
    const dispatchedAt = "2026-03-01T00:00:03.000Z";

    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-queue",
          occurredAt: createdAt,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-queue",
            projectId: "project-1",
            title: "queued",
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            pendingRuntimeMode: null,
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const queued = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.queued-turn-created",
          aggregateKind: "thread",
          aggregateId: "thread-queue",
          occurredAt: createdAt,
          commandId: "cmd-queue-create",
          payload: {
            threadId: "thread-queue",
            queuedTurn: {
              id: "queued-turn-1",
              threadId: "thread-queue",
              message: {
                messageId: "message-queued-1",
                role: "user",
                text: "first queued prompt",
                attachments: [],
              },
              runtimeMode: "approval-required",
              interactionMode: "default",
              createdAt,
              updatedAt: createdAt,
              failedAt: null,
              failureMessage: null,
            },
          },
        }),
      ),
    );
    expect(queued.threads[0]?.queuedTurns).toHaveLength(1);
    expect(queued.threads[0]?.queuedTurns?.[0]?.message.text).toBe("first queued prompt");

    const failed = await Effect.runPromise(
      projectEvent(
        queued,
        makeEvent({
          sequence: 3,
          type: "thread.queued-turn-failed",
          aggregateKind: "thread",
          aggregateId: "thread-queue",
          occurredAt: failedAt,
          commandId: "cmd-queue-fail",
          payload: {
            threadId: "thread-queue",
            queuedTurnId: "queued-turn-1",
            failureMessage: "provider refused turn",
            failedAt,
          },
        }),
      ),
    );
    expect(failed.threads[0]?.queuedTurns?.[0]?.failedAt).toBe(failedAt);

    const edited = await Effect.runPromise(
      projectEvent(
        failed,
        makeEvent({
          sequence: 4,
          type: "thread.queued-turn-updated",
          aggregateKind: "thread",
          aggregateId: "thread-queue",
          occurredAt: updatedAt,
          commandId: "cmd-queue-update",
          payload: {
            threadId: "thread-queue",
            queuedTurnId: "queued-turn-1",
            text: "edited queued prompt",
            updatedAt,
          },
        }),
      ),
    );
    expect(edited.threads[0]?.queuedTurns?.[0]?.message.text).toBe("edited queued prompt");
    expect(edited.threads[0]?.queuedTurns?.[0]?.failedAt).toBeNull();
    expect(edited.threads[0]?.queuedTurns?.[0]?.failureMessage).toBeNull();

    const dispatched = await Effect.runPromise(
      projectEvent(
        edited,
        makeEvent({
          sequence: 5,
          type: "thread.queued-turn-dispatched",
          aggregateKind: "thread",
          aggregateId: "thread-queue",
          occurredAt: dispatchedAt,
          commandId: "cmd-queue-dispatch",
          payload: {
            threadId: "thread-queue",
            queuedTurnId: "queued-turn-1",
            messageId: "message-queued-1",
            dispatchedAt,
          },
        }),
      ),
    );
    expect(dispatched.threads[0]?.queuedTurns).toEqual([]);
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  it("tracks latest turn id from session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const thread = afterRunning.threads[0];
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
    expect(thread?.session?.status).toBe("running");
  });

  it("marks running latest turn interrupted when session stops without a diff", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const stoppedAt = "2026-02-23T08:00:10.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const afterStopped = await Effect.runPromise(
      projectEvent(
        afterRunning,
        makeEvent({
          sequence: 3,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: stoppedAt,
          commandId: "cmd-stopped",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "stopped",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: stoppedAt,
            },
          },
        }),
      ),
    );

    const thread = afterStopped.threads[0];
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "interrupted",
      completedAt: stoppedAt,
    });
  });

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("prunes reverted turn messages from in-memory thread snapshot", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:01.000Z",
        commandId: "cmd-user-1",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-1",
          role: "user",
          text: "First edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:01.000Z",
          updatedAt: "2026-02-23T10:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.000Z",
        commandId: "cmd-assistant-1",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "Updated README to v2.\n",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-23T10:00:02.000Z",
          updatedAt: "2026-02-23T10:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.500Z",
        commandId: "cmd-turn-1-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T10:00:02.500Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.750Z",
        commandId: "cmd-activity-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.started",
            summary: "Edit file started",
            payload: { toolKind: "command" },
            turnId: "turn-1",
            createdAt: "2026-02-23T10:00:02.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:03.000Z",
        commandId: "cmd-user-2",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-2",
          role: "user",
          text: "Second edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:03.000Z",
          updatedAt: "2026-02-23T10:00:03.000Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.000Z",
        commandId: "cmd-assistant-2",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-2",
          role: "assistant",
          text: "Updated README to v3.\n",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-23T10:00:04.000Z",
          updatedAt: "2026-02-23T10:00:04.000Z",
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.500Z",
        commandId: "cmd-turn-2-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-2",
          completedAt: "2026-02-23T10:00:04.500Z",
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.750Z",
        commandId: "cmd-activity-2",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-2",
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit file complete",
            payload: { toolKind: "command" },
            turnId: "turn-2",
            createdAt: "2026-02-23T10:00:04.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:05.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ],
    );
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
  });

  it("does not fallback-retain messages tied to removed turn IDs", async () => {
    const createdAt = "2026-02-26T12:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: "cmd-turn-1",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-keep",
          completedAt: "2026-02-26T12:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.100Z",
        commandId: "cmd-assistant-keep",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-keep",
          role: "assistant",
          text: "kept",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-26T12:00:01.100Z",
          updatedAt: "2026-02-26T12:00:01.100Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: "cmd-turn-2",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-remove",
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.050Z",
        commandId: "cmd-user-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "user-remove",
          role: "user",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.050Z",
          updatedAt: "2026-02-26T12:00:02.050Z",
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: "cmd-assistant-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-remove",
          role: "assistant",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-revert",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
  });

  it("caps message and checkpoint retention for long-lived threads", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 2_100 },
      (_, index) =>
        makeEvent({
          sequence: index + 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-message-${index}`,
          payload: {
            threadId: "thread-capped",
            messageId: `msg-${index}`,
            role: "assistant",
            text: `message-${index}`,
            turnId: `turn-${index}`,
            streaming: false,
            createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 600 },
      (_, index) =>
        makeEvent({
          sequence: index + 2_102,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-checkpoint-${index}`,
          payload: {
            threadId: "thread-capped",
            turnId: `turn-${index}`,
            checkpointTurnCount: index + 1,
            checkpointRef: `refs/t3/checkpoints/thread-capped/turn/${index + 1}`,
            status: "ready",
            files: [],
            assistantMessageId: `msg-${index}`,
            completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const finalState = await checkpointEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterMessages),
    );

    const thread = finalState.threads[0];
    expect(thread?.messages).toHaveLength(2_000);
    expect(thread?.messages[0]?.id).toBe("msg-100");
    expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
    expect(thread?.checkpoints).toHaveLength(500);
    expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
    expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
  });
});
