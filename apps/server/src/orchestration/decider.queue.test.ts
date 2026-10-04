import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asQueuedTurnId = (value: string): QueuedTurnId => QueuedTurnId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

async function makeThreadReadModel(input: { readonly now: string; readonly threadId: ThreadId }) {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(input.now), {
      sequence: 1,
      eventId: asEventId("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: input.threadId,
      type: "thread.created",
      occurredAt: input.now,
      commandId: CommandId.make("cmd-thread-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: input.threadId,
        projectId: asProjectId("project-1"),
        title: "Queue",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        pendingRuntimeMode: null,
        branch: null,
        worktreePath: null,
        createdAt: input.now,
        updatedAt: input.now,
      },
    }),
  );
}

function makeHandoffCommand(input: {
  readonly now: string;
  readonly threadId: ThreadId;
  readonly branch: string;
  readonly worktreePath: string;
  readonly workspaceBinding?: {
    readonly canonicalPath: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly generation: number;
  };
}) {
  return {
    type: "thread.workspace.handoff",
    commandId: CommandId.make("cmd-workspace-handoff"),
    threadId: input.threadId,
    branch: input.branch,
    worktreePath: input.worktreePath,
    ...(input.workspaceBinding !== undefined ? { workspaceBinding: input.workspaceBinding } : {}),
    markerMessageId: MessageId.make("message-handoff-marker"),
    continuation: {
      id: asQueuedTurnId("queued-turn-handoff"),
      threadId: input.threadId,
      message: {
        messageId: asMessageId("message-handoff"),
        role: "user",
        text: "continue in workspace",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: input.now,
      updatedAt: input.now,
      failedAt: null,
      failureMessage: null,
    },
  } as const;
}

describe("decider queued turns", () => {
  it("preserves pull request monitor provenance on queued turns", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-monitor-owner");
    const readModel = await makeThreadReadModel({ now, threadId });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.create",
          commandId: CommandId.make("cmd-monitor-feedback"),
          threadId,
          queuedTurnId: asQueuedTurnId("queued-monitor-feedback"),
          message: {
            messageId: asMessageId("message-monitor-feedback"),
            role: "user",
            text: "Review new pull request feedback.",
            attachments: [],
          },
          origin: {
            kind: "pull-request-monitor",
            repository: "acme/app",
            number: 42,
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.payload).toMatchObject({
      queuedTurn: {
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
        },
      },
    });

    const withQueuedTurn = await Effect.runPromise(projectEvent(readModel, event));
    const update = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.update",
          commandId: CommandId.make("cmd-monitor-feedback-refresh"),
          threadId,
          queuedTurnId: asQueuedTurnId("queued-monitor-feedback"),
          text: "Review refreshed pull request feedback.",
          origin: {
            kind: "pull-request-monitor",
            repository: "acme/app",
            number: 42,
            headSha: "head-new",
            sourceRevision: "revision-new",
          },
          updatedAt: "2026-03-01T00:00:01.000Z",
        },
        readModel: withQueuedTurn,
      }),
    );
    const updateEvent = Array.isArray(update) ? update[0] : update;
    expect(updateEvent?.payload).toMatchObject({
      origin: {
        kind: "pull-request-monitor",
        headSha: "head-new",
        sourceRevision: "revision-new",
      },
    });
  });

  /**
   * A busy source thread running turn `turn-source` on message `message-source`,
   * plus an idle-or-busy sibling thread in the same project, ready to receive a
   * cross-thread command from it.
   */
  async function makeCrossThreadSendReadModel(input: {
    readonly now: string;
    readonly destinationBusy: boolean;
  }) {
    const sourceThreadId = asThreadId("thread-source");
    const destinationThreadId = asThreadId("thread-nested");
    const sourceMessageId = asMessageId("message-source");
    const source = await makeThreadReadModel({ now: input.now, threadId: sourceThreadId });
    const withSourceMessage = await Effect.runPromise(
      projectEvent(source, {
        sequence: 2,
        eventId: asEventId("evt-source-message"),
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        type: "thread.message-sent",
        occurredAt: input.now,
        commandId: CommandId.make("cmd-source-message"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-source-message"),
        metadata: {},
        payload: {
          threadId: sourceThreadId,
          messageId: sourceMessageId,
          role: "user",
          text: "Investigate the regression.",
          turnId: null,
          streaming: false,
          createdAt: input.now,
          updatedAt: input.now,
        },
      }),
    );
    const withActiveSource = await Effect.runPromise(
      projectEvent(withSourceMessage, {
        sequence: 3,
        eventId: asEventId("evt-source-session"),
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        type: "thread.session-set",
        occurredAt: input.now,
        commandId: CommandId.make("cmd-source-session"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-source-session"),
        metadata: {},
        payload: {
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "running",
            providerName: "copilot",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-source"),
            activeMessageId: sourceMessageId,
            lastError: null,
            updatedAt: input.now,
          },
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withActiveSource, {
        sequence: 4,
        eventId: asEventId("evt-nested-create"),
        aggregateKind: "thread",
        aggregateId: destinationThreadId,
        type: "thread.created",
        occurredAt: input.now,
        commandId: CommandId.make("cmd-nested-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-nested-create"),
        metadata: {},
        payload: {
          threadId: destinationThreadId,
          projectId: asProjectId("project-1"),
          parentThreadId: sourceThreadId,
          title: "Nested investigation",
          modelSelection: {
            instanceId: ProviderInstanceId.make("copilot"),
            model: "gpt-5.6",
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          pendingRuntimeMode: null,
          branch: null,
          worktreePath: null,
          createdAt: input.now,
          updatedAt: input.now,
        },
      }),
    );
    return {
      sourceThreadId,
      destinationThreadId,
      sourceMessageId,
      readModel: {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === destinationThreadId && input.destinationBusy
            ? {
                ...thread,
                session: {
                  threadId: destinationThreadId,
                  status: "running" as const,
                  providerName: "copilot",
                  runtimeMode: "approval-required" as const,
                  activeTurnId: asTurnId("turn-destination"),
                  lastError: null,
                  updatedAt: input.now,
                },
              }
            : thread,
        ),
      },
    };
  }

  it.each(["thread.turn.start", "thread.queued-turn.create"] as const)(
    "derives cross-thread provenance at acceptance for %s",
    async (type) => {
      const now = "2026-03-01T00:00:00.000Z";
      const {
        sourceThreadId,
        destinationThreadId: nestedThreadId,
        sourceMessageId,
        readModel: busyReadModel,
      } = await makeCrossThreadSendReadModel({
        now,
        destinationBusy: type === "thread.queued-turn.create",
      });
      const command = {
        type,
        queuedTurnId: asQueuedTurnId("queued-cross-thread"),
        commandId: CommandId.make("cmd-nested-turn"),
        threadId: nestedThreadId,
        message: {
          messageId: asMessageId("message-nested"),
          role: "user" as const,
          text: "Find the root cause.",
          attachments: [],
        },
        crossThreadSourceThreadId: sourceThreadId,
        runtimeMode: "approval-required" as const,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      };
      const result = await Effect.runPromise(
        decideOrchestrationCommand({
          command,
          readModel: busyReadModel,
        }),
      );

      const event = Array.isArray(result) ? result[0] : result;
      const origin = {
        kind: "cross-thread",
        sourceThreadId,
        sourceMessageId,
        sourceThreadTitle: "Queue",
      };
      if (type === "thread.turn.start") {
        expect(event).toMatchObject({ type: "thread.message-sent", payload: { origin } });
        return;
      }
      expect(event).toMatchObject({
        type: "thread.queued-turn-created",
        payload: { queuedTurn: { origin } },
      });
      const queuedReadModel = await Effect.runPromise(projectEvent(busyReadModel, event));
      await expect(
        Effect.runPromise(
          decideOrchestrationCommand({
            command: {
              type: "thread.queued-turn.dispatch",
              commandId: CommandId.make("cmd-dispatch-busy"),
              threadId: nestedThreadId,
              queuedTurnId: command.queuedTurnId,
              dispatchedAt: now,
            },
            readModel: queuedReadModel,
          }),
        ),
      ).rejects.toThrow();
      const idleReadModel = {
        ...queuedReadModel,
        threads: queuedReadModel.threads.map((thread) => ({
          ...thread,
          session: null,
        })),
      };
      const dispatched = await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.queued-turn.dispatch",
            commandId: CommandId.make("cmd-dispatch-idle"),
            threadId: nestedThreadId,
            queuedTurnId: command.queuedTurnId,
            dispatchedAt: "2026-03-01T00:01:00.000Z",
          },
          readModel: idleReadModel,
        }),
      );
      expect(Array.isArray(dispatched) ? dispatched : [dispatched]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "thread.message-sent",
            payload: expect.objectContaining({ origin }),
          }),
          expect.objectContaining({ type: "thread.turn-start-requested" }),
          expect.objectContaining({ type: "thread.queued-turn-dispatched" }),
        ]),
      );
      for (const invalidSource of [
        { session: null },
        { projectId: asProjectId("different-project") },
        { messages: [] },
      ]) {
        await expect(
          Effect.runPromise(
            decideOrchestrationCommand({
              command,
              readModel: {
                ...busyReadModel,
                threads: busyReadModel.threads.map((thread) =>
                  thread.id === sourceThreadId ? { ...thread, ...invalidSource } : thread,
                ),
              },
            }),
          ),
        ).rejects.toThrow(/Cross-thread source/);
      }
    },
  );

  it.each(["thread.turn.start", "thread.queued-turn.create"] as const)(
    "records the send against the source message for %s",
    async (type) => {
      const now = "2026-03-01T00:00:00.000Z";
      const { sourceThreadId, destinationThreadId, sourceMessageId, readModel } =
        await makeCrossThreadSendReadModel({
          now,
          destinationBusy: type === "thread.queued-turn.create",
        });
      const messageId = asMessageId("message-destination");
      const result = await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type,
            queuedTurnId: asQueuedTurnId("queued-record"),
            commandId: CommandId.make("cmd-record"),
            threadId: destinationThreadId,
            message: { messageId, role: "user", text: "Find the root cause.", attachments: [] },
            crossThreadSourceThreadId: sourceThreadId,
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
          },
          readModel,
        }),
      );

      const events = Array.isArray(result) ? result : [result];
      expect(events.at(-1)).toMatchObject({
        type: "thread.cross-thread-send-recorded",
        aggregateId: sourceThreadId,
        payload: {
          sourceThreadId,
          sourceMessageId,
          sourceTurnId: asTurnId("turn-source"),
          destinationThreadId,
          destinationThreadTitle: "Nested investigation",
          destinationMessageId: messageId,
          createdAt: now,
        },
      });
      // The source-side record projects into the source thread's activities so
      // the timeline can render a receipt under the sending message.
      const sourceThreadIdBefore = sourceThreadId;
      expect(
        (
          await Effect.runPromise(
            projectEvent(readModel, {
              ...events.at(-1)!,
              sequence: 5,
            }),
          )
        ).threads.find((thread) => thread.id === sourceThreadIdBefore)?.activities,
      ).toEqual([
        expect.objectContaining({
          kind: "cross-thread.send",
          tone: "info",
          turnId: asTurnId("turn-source"),
          payload: expect.objectContaining({ destinationThreadId }),
        }),
      ]);
    },
  );

  it("creates queued turns without starting a provider turn", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-queue");
    const queuedTurnId = asQueuedTurnId("queued-turn-1");
    const readModel = await makeThreadReadModel({ now, threadId });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.create",
          commandId: CommandId.make("cmd-queue-create"),
          threadId,
          queuedTurnId,
          message: {
            messageId: asMessageId("message-queued-1"),
            role: "user",
            text: "queued prompt",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.queued-turn-created");
    expect(event.payload).toMatchObject({
      threadId,
      queuedTurn: {
        id: queuedTurnId,
        threadId,
        message: {
          messageId: asMessageId("message-queued-1"),
          text: "queued prompt",
        },
        failedAt: null,
        failureMessage: null,
      },
    });
  });

  it("updates workspace metadata and queues continuation atomically", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-handoff");
    const queuedTurnId = asQueuedTurnId("queued-turn-handoff");
    const readModel = await makeThreadReadModel({ now, threadId });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.workspace.handoff",
          commandId: CommandId.make("cmd-workspace-handoff"),
          threadId,
          branch: "feature/handoff",
          worktreePath: "/tmp/handoff",
          markerMessageId: MessageId.make("message-handoff-marker"),
          continuation: {
            id: queuedTurnId,
            threadId,
            message: {
              messageId: asMessageId("message-handoff"),
              role: "user",
              text: "continue in workspace",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
            updatedAt: now,
            failedAt: null,
            failureMessage: null,
          },
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.message-sent",
      "thread.queued-turn-created",
    ]);
    expect(events[0]?.payload).toMatchObject({
      threadId,
      branch: "feature/handoff",
      worktreePath: "/tmp/handoff",
    });
    expect(events[1]?.payload).toMatchObject({
      threadId,
      messageId: "message-handoff-marker",
      role: "system",
      origin: {
        kind: "workspace-handoff",
        role: "marker",
        branch: "feature/handoff",
        worktreePath: "/tmp/handoff",
      },
    });
    expect(events[2]?.payload).toMatchObject({
      threadId,
      queuedTurn: {
        id: queuedTurnId,
        message: { text: "continue in workspace" },
        // Derived by the decider even though the caller supplied no origin.
        origin: {
          kind: "workspace-handoff",
          role: "continuation",
          branch: "feature/handoff",
          worktreePath: "/tmp/handoff",
        },
      },
    });
  });

  it("rejects a handoff to another active thread's canonical worktree alias", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-handoff");
    const ownerThreadId = asThreadId("thread-worktree-owner");
    const readModel = await makeThreadReadModel({ now, threadId });
    const withOwner = await Effect.runPromise(
      projectEvent(readModel, {
        sequence: 2,
        eventId: asEventId("evt-worktree-owner"),
        aggregateKind: "thread",
        aggregateId: ownerThreadId,
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-worktree-owner"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-worktree-owner"),
        metadata: {},
        payload: {
          threadId: ownerThreadId,
          projectId: asProjectId("project-1"),
          title: "Owner",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          pendingRuntimeMode: null,
          branch: "feature/owner",
          worktreePath: "/tmp/worktree/../shared-worktree",
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.workspace.handoff",
            commandId: CommandId.make("cmd-workspace-handoff-alias"),
            threadId,
            branch: "feature/handoff",
            worktreePath: "/tmp/shared-worktree",
            markerMessageId: MessageId.make("message-handoff-alias-marker"),
            continuation: {
              id: asQueuedTurnId("queued-turn-handoff-alias"),
              threadId,
              message: {
                messageId: asMessageId("message-handoff-alias"),
                role: "user",
                text: "continue in workspace",
                attachments: [],
              },
              runtimeMode: "approval-required",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt: now,
              updatedAt: now,
              failedAt: null,
              failureMessage: null,
            },
          },
          readModel: withOwner,
        }),
      ),
    ).rejects.toThrow("already bound to active thread");
  });

  it("derives the continuation origin instead of trusting the caller", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-handoff");
    const queuedTurnId = asQueuedTurnId("queued-turn-handoff");
    const readModel = await makeThreadReadModel({ now, threadId });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.workspace.handoff",
          commandId: CommandId.make("cmd-workspace-handoff"),
          threadId,
          branch: "feature/handoff",
          worktreePath: "/tmp/handoff",
          markerMessageId: MessageId.make("message-handoff-marker"),
          continuation: {
            id: queuedTurnId,
            threadId,
            message: {
              messageId: asMessageId("message-handoff"),
              role: "user",
              text: "continue in workspace",
              attachments: [],
            },
            // A schema-valid but wrong tag: the marker role would render the
            // continuation as a second divider, and a stale branch would label
            // the move with a workspace the thread is not bound to.
            origin: {
              kind: "workspace-handoff",
              role: "marker",
              branch: "stale/branch",
              worktreePath: "/tmp/stale",
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
            updatedAt: now,
            failedAt: null,
            failureMessage: null,
          },
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events[2]?.payload).toMatchObject({
      queuedTurn: {
        origin: {
          kind: "workspace-handoff",
          role: "continuation",
          branch: "feature/handoff",
          worktreePath: "/tmp/handoff",
        },
      },
    });
  });

  it("uses an existing queued turn instead of appending a duplicate continuation", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-existing-queue");
    const readModel = await makeThreadReadModel({ now, threadId });
    const queuedEvent = (await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.create",
          commandId: CommandId.make("cmd-existing-queue"),
          threadId,
          queuedTurnId: asQueuedTurnId("queued-turn-existing"),
          message: {
            messageId: asMessageId("message-existing"),
            role: "user",
            text: "user follow-up",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
        readModel,
      }),
    )) as OrchestrationEvent;
    const withExistingQueue = await Effect.runPromise(
      projectEvent(readModel, { ...queuedEvent, sequence: 2 }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.workspace.handoff",
          commandId: CommandId.make("cmd-workspace-handoff"),
          threadId,
          branch: "feature/handoff",
          worktreePath: "/tmp/handoff",
          markerMessageId: MessageId.make("message-handoff-marker"),
          continuation: {
            id: asQueuedTurnId("queued-turn-synthetic"),
            threadId,
            message: {
              messageId: asMessageId("message-synthetic"),
              role: "user",
              text: "synthetic continuation",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
            updatedAt: now,
            failedAt: null,
            failureMessage: null,
          },
        },
        readModel: withExistingQueue,
      }),
    );

    const reuseEvents = Array.isArray(result) ? result : [result];
    expect(reuseEvents.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.message-sent",
    ]);
    expect(reuseEvents[1]?.payload).toMatchObject({
      role: "system",
      origin: { kind: "workspace-handoff", role: "marker", branch: "feature/handoff" },
    });
  });

  it("dispatches a queued turn as a user message and turn start", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const dispatchedAt = "2026-03-01T00:00:01.000Z";
    const threadId = asThreadId("thread-queue");
    const queuedTurnId = asQueuedTurnId("queued-turn-1");
    const readModel = await makeThreadReadModel({ now, threadId });
    const createdEvent = (await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.create",
          commandId: CommandId.make("cmd-queue-create"),
          threadId,
          queuedTurnId,
          message: {
            messageId: asMessageId("message-queued-1"),
            role: "user",
            text: "queued prompt",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
        readModel,
      }),
    )) as OrchestrationEvent;
    const withQueue = await Effect.runPromise(
      projectEvent(readModel, { ...createdEvent, sequence: 2 }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make("cmd-queue-dispatch"),
          threadId,
          queuedTurnId,
          dispatchedAt,
        },
        readModel: withQueue,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
      "thread.queued-turn-dispatched",
    ]);
    expect(events[0]?.payload).toMatchObject({
      threadId,
      messageId: asMessageId("message-queued-1"),
      role: "user",
      text: "queued prompt",
    });
    expect(events[1]?.payload).toMatchObject({
      threadId,
      messageId: asMessageId("message-queued-1"),
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
    expect(events[2]?.payload).toMatchObject({
      threadId,
      queuedTurnId,
      messageId: asMessageId("message-queued-1"),
      dispatchedAt,
    });
  });

  it("persists an admitted isolated binding when dispatching a queued turn", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const dispatchedAt = "2026-03-01T00:00:01.000Z";
    const threadId = asThreadId("thread-isolated-dispatch");
    const queuedTurnId = asQueuedTurnId("queued-turn-isolated");
    const readModel = await makeThreadReadModel({ now, threadId });
    const createdEvent = (await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.create",
          commandId: CommandId.make("cmd-isolated-queue-create"),
          threadId,
          queuedTurnId,
          message: {
            messageId: asMessageId("message-isolated-1"),
            role: "user",
            text: "queued prompt",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
        readModel,
      }),
    )) as OrchestrationEvent;
    const withQueue = await Effect.runPromise(
      projectEvent(readModel, { ...createdEvent, sequence: 2 }),
    );

    const binding = {
      canonicalPath: "/tmp/isolated-worktree",
      worktreePath: "/tmp/isolated-worktree",
      branch: "t3/thread/abc",
      generation: 1,
    };
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make("cmd-isolated-queue-dispatch"),
          threadId,
          queuedTurnId,
          workspaceBinding: binding,
          dispatchedAt,
        },
        readModel: withQueue,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.message-sent",
      "thread.turn-start-requested",
      "thread.queued-turn-dispatched",
    ]);
    expect(events[0]?.payload).toMatchObject({
      threadId,
      worktreePath: binding.worktreePath,
      workspaceBinding: binding,
    });

    let projected = withQueue;
    let sequence = 2;
    for (const event of events) {
      sequence += 1;
      projected = await Effect.runPromise(projectEvent(projected, { ...event, sequence }));
    }
    expect(
      projected.threads.find((thread) => thread.id === threadId)?.workspaceBinding,
    ).toMatchObject(binding);
  });

  it("carries a handoff continuation origin onto the dispatched user message", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const dispatchedAt = "2026-03-01T00:00:01.000Z";
    const threadId = asThreadId("thread-handoff-dispatch");
    const queuedTurnId = asQueuedTurnId("queued-turn-continuation");
    const readModel = await makeThreadReadModel({ now, threadId });
    const handoffEvents = (await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.workspace.handoff",
          commandId: CommandId.make("cmd-handoff-dispatch"),
          threadId,
          branch: "feature/handoff",
          worktreePath: "/tmp/handoff",
          markerMessageId: MessageId.make("message-handoff-marker"),
          continuation: {
            id: queuedTurnId,
            threadId,
            message: {
              messageId: asMessageId("message-continuation"),
              role: "user",
              text: "continue in workspace",
              attachments: [],
            },
            origin: {
              kind: "workspace-handoff",
              role: "continuation",
              branch: "feature/handoff",
              worktreePath: "/tmp/handoff",
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
            updatedAt: now,
            failedAt: null,
            failureMessage: null,
          },
        },
        readModel,
      }),
    )) as ReadonlyArray<OrchestrationEvent>;

    let projected = readModel;
    let sequence = 1;
    for (const event of handoffEvents) {
      sequence += 1;
      projected = await Effect.runPromise(projectEvent(projected, { ...event, sequence }));
    }

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make("cmd-handoff-dispatch-turn"),
          threadId,
          queuedTurnId,
          dispatchedAt,
        },
        readModel: projected,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.payload).toMatchObject({
      messageId: asMessageId("message-continuation"),
      role: "user",
      origin: {
        kind: "workspace-handoff",
        role: "continuation",
        branch: "feature/handoff",
      },
    });
  });
});

describe("decider redundant workspace handoff", () => {
  async function makeBoundReadModel(input: {
    readonly now: string;
    readonly threadId: ThreadId;
    readonly branch: string;
    readonly worktreePath: string;
    readonly bound?: boolean;
  }) {
    const readModel = await makeThreadReadModel({ now: input.now, threadId: input.threadId });
    if (input.bound === false) {
      return readModel;
    }
    return {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === input.threadId
          ? {
              ...thread,
              branch: input.branch,
              worktreePath: input.worktreePath,
              workspaceBinding: {
                canonicalPath: input.worktreePath,
                worktreePath: input.worktreePath,
                branch: input.branch,
                generation: 1,
              },
            }
          : thread,
      ),
    };
  }

  it("omits the transition marker when the thread is already bound to that worktree and branch", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-already-bound");
    const readModel = await makeBoundReadModel({
      now,
      threadId,
      branch: "t3code/perf-next-four",
      worktreePath: "/tmp/perf-next-four",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeHandoffCommand({
          now,
          threadId,
          branch: "t3code/perf-next-four",
          worktreePath: "/tmp/perf-next-four",
          workspaceBinding: {
            canonicalPath: "/tmp/perf-next-four",
            worktreePath: "/tmp/perf-next-four",
            branch: "t3code/perf-next-four",
            generation: 1,
          },
        }),
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.queued-turn-created",
    ]);
  });

  it("still queues the continuation so a repeated handoff never strands its caller", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-already-bound-continuation");
    const readModel = await makeBoundReadModel({
      now,
      threadId,
      branch: "t3code/perf-next-four",
      worktreePath: "/tmp/perf-next-four",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeHandoffCommand({
          now,
          threadId,
          branch: "t3code/perf-next-four",
          worktreePath: "/tmp/perf-next-four",
        }),
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.at(-1)?.payload).toMatchObject({
      queuedTurn: { origin: { kind: "workspace-handoff", role: "continuation" } },
    });
  });

  it("treats a worktree alias that resolves to the bound canonical path as already bound", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-alias-bound");
    const readModel = await makeBoundReadModel({
      now,
      threadId,
      branch: "t3code/perf-next-four",
      worktreePath: "/tmp/perf-next-four",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeHandoffCommand({
          now,
          threadId,
          branch: "t3code/perf-next-four",
          worktreePath: "/tmp/alias/../perf-next-four",
          workspaceBinding: {
            canonicalPath: "/tmp/perf-next-four",
            worktreePath: "/tmp/alias/../perf-next-four",
            branch: "t3code/perf-next-four",
            generation: 1,
          },
        }),
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).not.toContain("thread.message-sent");
  });

  it("emits the marker when the bound worktree is re-pointed at a different branch", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-branch-changed");
    const readModel = await makeBoundReadModel({
      now,
      threadId,
      branch: "t3code/perf-next-four",
      worktreePath: "/tmp/perf-next-four",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeHandoffCommand({
          now,
          threadId,
          branch: "t3code/perf-next-five",
          worktreePath: "/tmp/perf-next-four",
        }),
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toContain("thread.message-sent");
  });

  it("emits the marker for a legacy thread that carries no workspace binding", async () => {
    const now = "2026-03-01T00:00:00.000Z";
    const threadId = asThreadId("thread-legacy-unbound");
    const readModel = await makeBoundReadModel({
      now,
      threadId,
      branch: "t3code/perf-next-four",
      worktreePath: "/tmp/perf-next-four",
      bound: false,
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeHandoffCommand({
          now,
          threadId,
          branch: "t3code/perf-next-four",
          worktreePath: "/tmp/perf-next-four",
        }),
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toContain("thread.message-sent");
  });
});
