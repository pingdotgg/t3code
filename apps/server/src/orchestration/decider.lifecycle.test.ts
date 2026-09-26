import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const commandId = CommandId.make("cmd-lifecycle");
const projectId = ProjectId.make("project-lifecycle");
const threadId = ThreadId.make("thread-lifecycle");
const parentThreadId = ThreadId.make("parent-lifecycle");
const childThreadId = ThreadId.make("child-lifecycle");

async function lifecycleReadModel(): Promise<OrchestrationReadModel> {
  const now = "2026-07-30T00:00:00.000Z";
  const model = createEmptyReadModel(now);
  return Effect.runPromise(
    projectEvent(model, {
      sequence: 1,
      eventId: EventId.make("event-thread-lifecycle"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      payload: {
        threadId,
        projectId,
        parentThreadId: null,
        title: "Lifecycle thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        pendingRuntimeMode: null,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function nestedLifecycleReadModel(): Promise<OrchestrationReadModel> {
  const now = "2026-07-30T00:00:00.000Z";
  const createThread = (
    sequence: number,
    id: typeof parentThreadId,
    parentId: typeof parentThreadId | null,
    title: string,
  ) => ({
    sequence,
    eventId: EventId.make(`event-${id}`),
    aggregateKind: "thread" as const,
    aggregateId: id,
    type: "thread.created" as const,
    occurredAt: now,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
    payload: {
      threadId: id,
      projectId,
      parentThreadId: parentId,
      title,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required" as const,
      pendingRuntimeMode: null,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  let model = createEmptyReadModel(now);
  model = await Effect.runPromise(
    projectEvent(model, createThread(1, parentThreadId, null, "Parent thread")),
  );
  return Effect.runPromise(
    projectEvent(model, createThread(2, childThreadId, parentThreadId, "Release assistant")),
  );
}

async function nestedActiveTurnReadModel(turnId: TurnId): Promise<OrchestrationReadModel> {
  const model = await nestedLifecycleReadModel();
  const now = "2026-07-30T00:30:00.000Z";
  return Effect.runPromise(
    projectEvent(model, {
      sequence: 3,
      eventId: EventId.make(`event-active-${turnId}`),
      aggregateKind: "thread",
      aggregateId: childThreadId,
      type: "thread.session-set",
      occurredAt: now,
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      payload: {
        threadId: childThreadId,
        session: {
          threadId: childThreadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
      },
    }),
  );
}

function eventsOf(
  result: ReturnType<typeof decideOrchestrationCommand> extends Effect.Effect<
    infer A,
    unknown,
    unknown
  >
    ? A
    : never,
) {
  return Array.isArray(result) ? result : [result];
}

describe("decider thread lifecycle", () => {
  it("routes child facts to the parent and persists only external actions", async () => {
    const readModel = await nestedLifecycleReadModel();
    const at = "2026-07-30T01:00:00.000Z";
    const commands: ReadonlyArray<
      readonly [string, OrchestrationCommand, { readonly url: string } | undefined]
    > = [
      [
        "started",
        {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-started"),
          threadId: childThreadId,
          message: {
            messageId: MessageId.make("message-started"),
            role: "user",
            text: "Start",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          titleSeed: "Start",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: at,
        },
        undefined,
      ],
      ...(["approval.requested", "user-input.requested"] as const).map((kind) => {
        const lifecycle = kind === "approval.requested" ? "approval-required" : "input-required";
        return [
          lifecycle,
          {
            type: "thread.activity.append",
            commandId: CommandId.make(`cmd-${lifecycle}`),
            threadId: childThreadId,
            activity: {
              id: EventId.make(`activity-${lifecycle}`),
              tone: "approval",
              kind,
              summary: "Action required",
              payload: { requestId: `request-${lifecycle}` },
              turnId: TurnId.make(`turn-${lifecycle}`),
              createdAt: at,
            },
            createdAt: at,
          } satisfies OrchestrationCommand,
          undefined,
        ] as const;
      }),
      [
        "pr-created",
        {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-pr-created"),
          threadId: childThreadId,
          pullRequest: {
            number: 42,
            title: "Release",
            url: "https://github.com/acme/app/pull/42",
            baseBranch: "main",
            headBranch: "release",
            state: "open",
          },
        },
        {
          url: "https://github.com/acme/app/pull/42",
        },
      ],
    ];

    for (const [lifecycle, command, expectedAction] of commands) {
      const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
      const notification = eventsOf(result).find(
        (event) => event.type === "thread.child-lifecycle-notified",
      );
      expect(notification).toMatchObject({
        aggregateId: parentThreadId,
        payload: {
          parentThreadId,
          childThreadId,
          lifecycle,
        },
      });
      if (notification?.type !== "thread.child-lifecycle-notified") {
        throw new Error(`Expected ${lifecycle} child lifecycle notification.`);
      }
      expect(notification.payload).not.toHaveProperty("notification");
      expect(notification.payload).not.toHaveProperty("action");
      expect(
        notification.payload.lifecycle === "pr-created"
          ? notification.payload.externalAction
          : undefined,
      ).toEqual(expectedAction);
    }
  });

  it.each([
    ["ready", "completed"],
    ["error", "failed"],
    ["stopped", "blocked"],
  ] as const)(
    "reports an authoritative provider transition to %s as %s",
    async (status, lifecycle) => {
      const turnId = TurnId.make(`turn-${lifecycle}`);
      const readModel = await nestedActiveTurnReadModel(turnId);
      const at = "2026-07-30T01:00:00.000Z";
      const result = await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-${lifecycle}`),
            threadId: childThreadId,
            session: {
              threadId: childThreadId,
              status,
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: status === "error" ? "Provider turn failed" : null,
              updatedAt: at,
            },
            createdAt: at,
          },
          readModel,
        }),
      );

      expect(
        eventsOf(result).find((event) => event.type === "thread.child-lifecycle-notified"),
      ).toMatchObject({
        payload: {
          lifecycle,
          dedupeKey: `child:${childThreadId}:${lifecycle}:${turnId}`,
        },
      });
    },
  );

  it("reports runtime errors while the failed turn remains active", async () => {
    const turnId = TurnId.make("turn-runtime-error");
    const readModel = await nestedActiveTurnReadModel(turnId);
    const at = "2026-07-30T01:00:00.000Z";
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-runtime-error"),
          threadId: childThreadId,
          activity: {
            id: EventId.make("activity-runtime-error"),
            tone: "error",
            kind: "runtime.error",
            summary: "Runtime error",
            payload: { message: "Provider turn failed" },
            turnId,
            createdAt: at,
          },
          createdAt: at,
        },
        readModel,
      }),
    );

    expect(
      eventsOf(result).find((event) => event.type === "thread.child-lifecycle-notified"),
    ).toMatchObject({
      payload: {
        lifecycle: "failed",
        dedupeKey: `child:${childThreadId}:failed:${turnId}`,
      },
    });
  });

  it.each(["ready", "missing", "error", "speculative"] as const)(
    "does not derive lifecycle state from a %s checkpoint",
    async (status) => {
      const readModel = await nestedLifecycleReadModel();
      const at = "2026-07-30T01:00:00.000Z";
      const result = await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-checkpoint-${status}`),
            threadId: childThreadId,
            turnId: TurnId.make(`turn-checkpoint-${status}`),
            completedAt: at,
            checkpointRef: CheckpointRef.make(`checkpoint-${status}`),
            status,
            files: [],
            agentTouchedPaths: [],
            turnFiles: [],
            checkpointTurnCount: 1,
            createdAt: at,
          },
          readModel,
        }),
      );

      expect(
        eventsOf(result).some((event) => event.type === "thread.child-lifecycle-notified"),
      ).toBe(false);
    },
  );

  it("emits a durable started notification when queued child work is dispatched", async () => {
    let readModel = await nestedLifecycleReadModel();
    const at = "2026-07-30T01:00:00.000Z";
    const queuedTurnId = QueuedTurnId.make("queued-child-start");
    const messageId = MessageId.make("message-queued-child-start");
    const queued = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.create",
          commandId: CommandId.make("cmd-queued-child-create"),
          threadId: childThreadId,
          queuedTurnId,
          message: {
            messageId,
            role: "user",
            text: "Start queued child work",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: at,
        },
        readModel,
      }),
    );
    readModel = await Effect.runPromise(
      projectEvent(readModel, { ...eventsOf(queued)[0]!, sequence: 3 }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make("cmd-queued-child-dispatch"),
          threadId: childThreadId,
          queuedTurnId,
          dispatchedAt: at,
        },
        readModel,
      }),
    );
    const events = eventsOf(result);

    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
      "thread.queued-turn-dispatched",
      "thread.child-lifecycle-notified",
    ]);
    expect(events.at(-1)).toMatchObject({
      aggregateId: parentThreadId,
      payload: {
        lifecycle: "started",
        dedupeKey: `child:${childThreadId}:started:${messageId}`,
      },
    });
  });

  it("emits a stable semantic dedupe key for retried lifecycle notifications", async () => {
    let readModel = await nestedLifecycleReadModel();
    const command = {
      type: "thread.activity.append",
      commandId: CommandId.make("cmd-approval-first"),
      threadId: childThreadId,
      activity: {
        id: EventId.make("activity-approval-first"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Approval required",
        payload: { requestId: "approval-42" },
        turnId: TurnId.make("turn-approval"),
        createdAt: "2026-07-30T01:00:00.000Z",
      },
      createdAt: "2026-07-30T01:00:00.000Z",
    } satisfies OrchestrationCommand;
    const first = eventsOf(
      await Effect.runPromise(decideOrchestrationCommand({ command, readModel })),
    );
    const persistedNotification = first.find(
      (event) => event.type === "thread.child-lifecycle-notified",
    );
    expect(persistedNotification).toBeDefined();
    readModel = await Effect.runPromise(
      projectEvent(readModel, { ...persistedNotification!, sequence: 3 }),
    );

    const retried = eventsOf(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            ...command,
            commandId: CommandId.make("cmd-approval-retry"),
            activity: {
              ...command.activity,
              id: EventId.make("activity-approval-retry"),
            },
          },
          readModel,
        }),
      ),
    );

    const retriedNotification = retried.find(
      (event) => event.type === "thread.child-lifecycle-notified",
    );
    expect(retriedNotification?.payload.dedupeKey).toBe(persistedNotification?.payload.dedupeKey);
  });

  it("uses distinct dedupe keys for request-less prompts in the same turn", async () => {
    const readModel = await nestedLifecycleReadModel();
    const turnId = TurnId.make("turn-request-less-prompts");
    const notificationKeys = await Promise.all(
      (["approval.requested", "user-input.requested"] as const).map(async (kind) => {
        const activityId = EventId.make(`activity-${kind}`);
        const result = await Effect.runPromise(
          decideOrchestrationCommand({
            command: {
              type: "thread.activity.append",
              commandId: CommandId.make(`cmd-${kind}`),
              threadId: childThreadId,
              activity: {
                id: activityId,
                tone: "approval",
                kind,
                summary: "Action required",
                payload: {},
                turnId,
                createdAt: "2026-07-30T01:00:00.000Z",
              },
              createdAt: "2026-07-30T01:00:00.000Z",
            },
            readModel,
          }),
        );
        return eventsOf(result).find((event) => event.type === "thread.child-lifecycle-notified")
          ?.payload.dedupeKey;
      }),
    );

    expect(notificationKeys).toEqual([
      `child:${childThreadId}:approval-required:activity-approval.requested`,
      `child:${childThreadId}:input-required:activity-user-input.requested`,
    ]);
  });

  it("propagates explicit pull request ownership transfer intent", async () => {
    const readModel = await lifecycleReadModel();
    const updated = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId,
          threadId,
          pullRequest: {
            number: 42,
            title: "Explicit association",
            url: "https://github.com/acme/app/pull/42",
            baseBranch: "main",
            headBranch: "feature",
            state: "open",
          },
          pullRequestOwnership: "transfer",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );

    expect(updated).toMatchObject({
      type: "thread.meta-updated",
      payload: {
        threadId,
        pullRequestOwnership: "transfer",
      },
    });
  });

  it("persists pending pull request association intent without associating it", async () => {
    const readModel = await lifecycleReadModel();
    const pendingPullRequestAssociation = {
      requestId: CommandId.make("associate-pr"),
      reference: "https://github.com/acme/app/pull/42",
      requestedAt: "2026-09-08T00:00:00.000Z",
      nextAttemptAt: "2026-09-08T00:01:00.000Z",
      status: "pending" as const,
    };
    const updated = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId,
          threadId,
          pendingPullRequestAssociation,
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );

    expect(updated).toMatchObject({
      type: "thread.meta-updated",
      payload: {
        threadId,
        pendingPullRequestAssociation,
      },
    });
    expect(updated).not.toHaveProperty("payload.pullRequest");
  });

  it("emits an unlink when it is needed to cancel pending association intent", async () => {
    const readModel = await lifecycleReadModel();
    const pendingPullRequestAssociation = {
      requestId: CommandId.make("associate-pr"),
      reference: "https://github.com/acme/app/pull/42",
      requestedAt: "2026-09-08T00:00:00.000Z",
      nextAttemptAt: "2026-09-08T00:01:00.000Z",
      status: "pending" as const,
    };
    const modelWithPendingIntent = {
      ...readModel,
      threads: readModel.threads.map((thread) => ({
        ...thread,
        pendingPullRequestAssociation,
      })),
    };
    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: modelWithPendingIntent,
        command: {
          type: "thread.pull-request.unlink",
          commandId,
          threadId,
          pullRequest: {
            number: 42,
            title: "Pending association",
            url: "https://github.com/acme/app/pull/42",
            baseBranch: "main",
            headBranch: "feature",
            state: "open",
          },
        },
      }),
    );

    expect(event).toMatchObject({
      type: "thread.pull-request-unlinked",
      payload: { threadId },
    });
  });

  it("ignores stale recovery writes after another thread update", async () => {
    const readModel = await lifecycleReadModel();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.meta.update",
          commandId,
          threadId,
          expectedUpdatedAt: "2026-07-29T00:00:00.000Z",
          pullRequest: {
            number: 42,
            title: "Recovered PR",
            url: "https://github.com/acme/app/pull/42",
            baseBranch: "main",
            headBranch: "feature",
            state: "open",
          },
        },
      }),
    );
    expect(result).toEqual([]);
  });

  it("settles and reopens an eligible thread", async () => {
    const readModel = await lifecycleReadModel();
    const settled = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId,
          threadId,
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    if (!("type" in settled)) {
      throw new Error("Expected settlement to emit one event.");
    }
    expect(settled.type).toBe("thread.settled");

    const reopened = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId,
          threadId,
          reason: "user",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(reopened).toMatchObject({
      type: "thread.unsettled",
      payload: { threadId, reason: "user" },
    });
  });

  it("stores a future snooze and permits an explicit wake", async () => {
    const readModel = await lifecycleReadModel();
    const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const snoozed = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId,
          threadId,
          snoozedUntil,
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(snoozed).toMatchObject({
      type: "thread.snoozed",
      payload: { threadId, snoozedUntil },
    });

    const woken = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unsnooze",
          commandId,
          threadId,
          reason: "user",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(woken).toMatchObject({
      type: "thread.unsnoozed",
      payload: { threadId, reason: "user" },
    });
  });

  it("rejects a wake time that cannot be parsed", async () => {
    const readModel = await lifecycleReadModel();
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.snooze",
            commandId,
            threadId,
            // IsoDateTime is structurally a plain string, so an unparseable
            // wake time reaches the decider and must not persist as a snooze.
            snoozedUntil: "not-a-date",
          } satisfies OrchestrationCommand,
          readModel,
        }),
      ),
    ).rejects.toThrow("A snooze must end in the future.");
  });

  it("re-settling a settled thread keeps its settledAt and ordering", async () => {
    const settledAt = "2026-07-30T01:00:00.000Z";
    const updatedAt = "2026-07-30T02:00:00.000Z";
    const readModel = await Effect.runPromise(
      projectEvent(await lifecycleReadModel(), {
        sequence: 2,
        eventId: EventId.make("event-thread-settled"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.settled",
        occurredAt: settledAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: { threadId, settledAt, updatedAt },
      }),
    );

    const resettled = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId,
          threadId,
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );

    expect(resettled).toMatchObject({
      type: "thread.settled",
      payload: { threadId, settledAt, updatedAt },
    });
  });

  it("re-unsettling a thread already pinned active keeps its ordering", async () => {
    const updatedAt = "2026-07-30T03:00:00.000Z";
    const readModel = await Effect.runPromise(
      projectEvent(await lifecycleReadModel(), {
        sequence: 2,
        eventId: EventId.make("event-thread-unsettled"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.unsettled",
        occurredAt: updatedAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: { threadId, reason: "user", updatedAt },
      }),
    );

    const reopened = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId,
          threadId,
          reason: "user",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );

    expect(reopened).toMatchObject({
      type: "thread.unsettled",
      payload: { threadId, reason: "user", updatedAt },
    });
  });

  it("pins idempotently without moving an existing pin", async () => {
    const pinnedAt = "2026-07-30T04:00:00.000Z";
    const updatedAt = "2026-07-30T05:00:00.000Z";
    const readModel = await Effect.runPromise(
      projectEvent(await lifecycleReadModel(), {
        sequence: 2,
        eventId: EventId.make("event-thread-pinned"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.pinned",
        occurredAt: pinnedAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: { threadId, pinnedAt, pinOrderKey: "a", updatedAt },
      }),
    );

    const repinned = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.pin",
          commandId,
          threadId,
          orderKey: "b",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );

    expect(repinned).toMatchObject({
      type: "thread.pinned",
      payload: { threadId, pinnedAt, updatedAt },
    });
    if (!("type" in repinned)) {
      throw new Error("Expected re-pin to emit one event.");
    }
    expect("pinOrderKey" in repinned.payload).toBe(false);
  });

  it("clears parked lifecycle states when pinning", async () => {
    const snoozedAt = "2026-07-30T04:00:00.000Z";
    const readModel = await Effect.runPromise(
      projectEvent(await lifecycleReadModel(), {
        sequence: 2,
        eventId: EventId.make("event-thread-snoozed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.snoozed",
        occurredAt: snoozedAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: {
          threadId,
          snoozedUntil: "2027-07-30T04:00:00.000Z",
          snoozedAt,
          updatedAt: snoozedAt,
        },
      }),
    );

    const events = await Effect.runPromise(
      decideOrchestrationCommand({
        command: { type: "thread.pin", commandId, threadId } satisfies OrchestrationCommand,
        readModel,
      }),
    );

    expect(Array.isArray(events) ? events.map((event) => event.type) : []).toEqual([
      "thread.pinned",
      "thread.unsnoozed",
    ]);
  });

  it("rejects reordering an unpinned thread", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.pin.reorder",
            commandId,
            threadId,
            orderKey: "a",
          } satisfies OrchestrationCommand,
          readModel: await lifecycleReadModel(),
        }),
      ),
    ).rejects.toThrow("is not pinned and cannot be reordered");
  });
});
