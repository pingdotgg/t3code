import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  QueuedTurnId,
  ProviderInstanceId,
  ThreadContextId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessageContext,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-04-01T00:00:00.000Z";
const projectId = ProjectId.make("project-thread-context");
const threadId = ThreadId.make("thread-with-context");

const context: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      kind: "thread",
      contextId: ThreadContextId.make("ctx_1"),
      label: "Auth refactor",
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-attached"),
      title: "Auth refactor thread",
    },
  ],
};

const messageText = "see [Auth](t3-context://v1/thread/ctx_1)";

function readModelWithThread(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-thread-context",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId,
        parentThreadId: null,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        pendingRuntimeMode: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

function turnStartCommand(
  messageId: string,
): Extract<OrchestrationCommand, { type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-${messageId}`),
    threadId,
    message: {
      messageId: MessageId.make(messageId),
      role: "user",
      text: messageText,
      attachments: [],
      context,
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: now,
  };
}

function toEvents(result: unknown): Array<{ type: string; payload: Record<string, unknown> }> {
  const events = (Array.isArray(result) ? result : [result]) as Array<{
    type: string;
    payload: Record<string, unknown>;
  }>;
  return events;
}

describe("thread context preservation", () => {
  it("carries context from turn start into message and turn-request events", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: turnStartCommand("message-1"),
        readModel: readModelWithThread(),
      }),
    );
    const events = toEvents(result);
    const sent = events.find((event) => event.type === "thread.message-sent");
    const requested = events.find((event) => event.type === "thread.turn-start-requested");
    expect(sent?.payload).toMatchObject({ context });
    expect(requested?.payload).toMatchObject({ context });
  });

  it("projects context onto the read-model message for provider retry and restart", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: turnStartCommand("message-2"),
        readModel: readModelWithThread(),
      }),
    );
    let model = readModelWithThread();
    for (const event of toEvents(decided)) {
      model = await Effect.runPromise(projectEvent(model, event as unknown as OrchestrationEvent));
    }
    const message = model.threads
      .find((thread) => thread.id === threadId)
      ?.messages.find((entry) => entry.id === "message-2");
    expect(message?.context).toEqual(context);
    // The provider reactor resolves this message by id on retry; the text keeps its refs.
    expect(message?.text).toBe(messageText);
  });

  it("preserves message context across updates that omit it", async () => {
    const messageId = MessageId.make("message-stream");
    const sent = {
      sequence: 1,
      eventId: EventId.make("event-ctx-1"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: now,
      commandId: CommandId.make("cmd-ctx"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId,
        role: "user",
        text: messageText,
        context,
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    } as unknown as OrchestrationEvent;
    let model = await Effect.runPromise(projectEvent(readModelWithThread(), sent));
    // A later delta for the same message carries no context; the binding survives.
    const delta = {
      ...sent,
      sequence: 2,
      eventId: EventId.make("event-ctx-2"),
      payload: {
        threadId,
        messageId,
        role: "user",
        text: `${messageText} edited`,
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    } as unknown as OrchestrationEvent;
    model = await Effect.runPromise(projectEvent(model, delta));
    const message = model.threads
      .find((thread) => thread.id === threadId)
      ?.messages.find((entry) => entry.id === messageId);
    expect(message?.text).toBe(`${messageText} edited`);
    expect(message?.context).toEqual(context);
  });

  it("carries context through queued-turn create, update, and dispatch", async () => {
    const created = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.create",
          commandId: CommandId.make("cmd-queued-create"),
          threadId,
          queuedTurnId: QueuedTurnId.make("queued-1"),
          message: {
            messageId: MessageId.make("message-queued"),
            role: "user",
            text: messageText,
            attachments: [],
            context,
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
        readModel: readModelWithThread(),
      }),
    );
    const createdEvent = toEvents(created).find(
      (event) => event.type === "thread.queued-turn-created",
    );
    expect(createdEvent?.payload).toMatchObject({
      queuedTurn: { message: { text: messageText, context } },
    });

    let model = readModelWithThread();
    for (const event of toEvents(created)) {
      model = await Effect.runPromise(projectEvent(model, event as unknown as OrchestrationEvent));
    }

    const updated = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.update",
          commandId: CommandId.make("cmd-queued-update"),
          threadId,
          queuedTurnId: QueuedTurnId.make("queued-1"),
          text: "see [Auth](t3-context://v1/thread/ctx_1) plus more",
          context,
          updatedAt: now,
        },
        readModel: model,
      }),
    );
    const updatedEvent = toEvents(updated).find(
      (event) => event.type === "thread.queued-turn-updated",
    );
    expect(updatedEvent?.payload).toMatchObject({ context });
    for (const event of toEvents(updated)) {
      model = await Effect.runPromise(projectEvent(model, event as unknown as OrchestrationEvent));
    }

    const dispatched = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make("cmd-queued-dispatch"),
          threadId,
          queuedTurnId: QueuedTurnId.make("queued-1"),
          dispatchedAt: now,
        },
        readModel: model,
      }),
    );
    const dispatchedEvents = toEvents(dispatched);
    expect(dispatchedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.message-sent",
          payload: expect.objectContaining({ context }),
        }),
        expect.objectContaining({ type: "thread.turn-start-requested" }),
      ]),
    );
  });
});
