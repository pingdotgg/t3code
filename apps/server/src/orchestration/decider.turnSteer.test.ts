import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

async function readModelWithRunningTurn() {
  const now = new Date().toISOString();
  const threadId = ThreadId.make("thread-1");
  const activeTurnId = asTurnId("turn-active");
  const initial = createEmptyReadModel(now);
  const withProject = await Effect.runPromise(
    projectEvent(initial, {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-1"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  const withThread = await Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-thread-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId,
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        pendingRuntimeMode: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  const baseThread = withThread.threads.find((thread) => thread.id === threadId);
  if (!baseThread) {
    throw new Error("missing thread");
  }
  return {
    now,
    threadId,
    activeTurnId,
    readModel: {
      ...withThread,
      threads: [
        {
          ...baseThread,
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: "2026-05-16T18:00:00.000Z",
            startedAt: "2026-05-16T18:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            threadId,
            status: "running" as const,
            providerName: "codex",
            runtimeMode: "approval-required" as const,
            activeTurnId,
            lastError: null,
            updatedAt: "2026-05-16T18:00:01.000Z",
          },
        },
      ],
    },
  };
}

describe("decider thread.turn.steer", () => {
  it("emits user message and turn-steer-requested for the active turn", async () => {
    const { threadId, activeTurnId, readModel } = await readModelWithRunningTurn();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.make("cmd-turn-steer"),
          threadId,
          message: {
            messageId: asMessageId("message-steer-1"),
            role: "user",
            text: "actually use tabs",
            attachments: [],
          },
          createdAt: "2026-05-16T18:00:02.000Z",
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    if (events[0]?.type !== "thread.message-sent") {
      return;
    }
    expect(events[0].payload).toMatchObject({
      messageId: asMessageId("message-steer-1"),
      turnId: activeTurnId,
    });
    const steerEvent = events[1];
    expect(steerEvent?.type).toBe("thread.turn-steer-requested");
    expect(steerEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (steerEvent?.type !== "thread.turn-steer-requested") {
      return;
    }
    expect(steerEvent.payload).toMatchObject({
      threadId,
      messageId: asMessageId("message-steer-1"),
      turnId: activeTurnId,
    });
  });

  it("accepts an explicit turnId matching the active turn", async () => {
    const { threadId, activeTurnId, readModel } = await readModelWithRunningTurn();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.make("cmd-turn-steer-explicit"),
          threadId,
          turnId: activeTurnId,
          message: {
            messageId: asMessageId("message-steer-2"),
            role: "user",
            text: "steer with explicit turn",
            attachments: [],
          },
          createdAt: "2026-05-16T18:00:02.000Z",
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events[1]?.type).toBe("thread.turn-steer-requested");
  });

  it("rejects a steer naming a turn that is no longer active", async () => {
    const { threadId, readModel } = await readModelWithRunningTurn();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.steer",
            commandId: CommandId.make("cmd-turn-steer-stale"),
            threadId,
            turnId: asTurnId("turn-old"),
            message: {
              messageId: asMessageId("message-steer-stale"),
              role: "user",
              text: "late steer",
              attachments: [],
            },
            createdAt: "2026-05-16T18:00:02.000Z",
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("no longer the active turn");
  });

  it("rejects a steer when no turn is in flight", async () => {
    const { threadId, readModel } = await readModelWithRunningTurn();
    const idleReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) => {
        if (thread.id !== threadId || thread.latestTurn === null || thread.session === undefined) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: {
            ...thread.latestTurn,
            state: "completed" as const,
            completedAt: "2026-05-16T18:00:01.000Z",
          },
          session: {
            ...thread.session,
            status: "ready" as const,
            activeTurnId: null,
          },
        };
      }),
    };

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.steer",
            commandId: CommandId.make("cmd-turn-steer-idle"),
            threadId,
            message: {
              messageId: asMessageId("message-steer-idle"),
              role: "user",
              text: "nothing running",
              attachments: [],
            },
            createdAt: "2026-05-16T18:00:02.000Z",
          },
          readModel: idleReadModel,
        }),
      ),
    ).rejects.toThrow("no active turn to steer");
  });
});
