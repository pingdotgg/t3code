import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
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

describe("decider queued turns", () => {
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
});
