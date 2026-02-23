import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

describe("orchestration projector", () => {
  it("applies thread.created events using runtime schema decoding", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);
    const event: OrchestrationEvent = {
      sequence: 1,
      eventId: "event-thread-created",
      type: "thread.created",
      aggregateType: "thread",
      aggregateId: "thread-1",
      occurredAt: now,
      commandId: "cmd-1",
      payload: {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    };

    const next = await Effect.runPromise(projectEvent(model, event));
    expect(next.sequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        latestTurnId: null,
        latestTurnStartedAt: null,
        latestTurnCompletedAt: null,
        latestTurnDurationMs: null,
        messages: [],
        session: null,
        activities: [],
        turnDiffSummaries: [],
        error: null,
      },
    ]);
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);
    const event: OrchestrationEvent = {
      sequence: 1,
      eventId: "event-message-invalid",
      type: "message.sent",
      aggregateType: "thread",
      aggregateId: "thread-1",
      occurredAt: now,
      commandId: "cmd-1",
      payload: {
        id: "message-1",
        threadId: "thread-1",
        text: "hello",
        createdAt: now,
        streaming: false,
      },
    };

    await expect(Effect.runPromise(projectEvent(model, event))).rejects.toBeDefined();
  });

  it("keeps projector forward-compatible for unknown event types", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);
    const event: OrchestrationEvent = {
      sequence: 7,
      eventId: "event-unknown",
      type: "custom.event.ignored",
      aggregateType: "unknown",
      aggregateId: "aggregate-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: null,
      payload: { test: true },
    };

    const next = await Effect.runPromise(projectEvent(model, event));
    expect(next.sequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  it("tracks latest turn timing from session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const completedAt = "2026-02-23T08:00:11.250Z";
    const model = createEmptyReadModel(createdAt);

    const createdEvent: OrchestrationEvent = {
      sequence: 1,
      eventId: "thread-created",
      type: "thread.created",
      aggregateType: "thread",
      aggregateId: "thread-1",
      occurredAt: createdAt,
      commandId: "cmd-create",
      payload: {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        model: "gpt-5.3-codex",
        branch: null,
        worktreePath: null,
        createdAt,
        updatedAt: createdAt,
      },
    };

    const runningSessionEvent: OrchestrationEvent = {
      sequence: 2,
      eventId: "session-running",
      type: "thread.session-set",
      aggregateType: "thread",
      aggregateId: "thread-1",
      occurredAt: startedAt,
      commandId: "cmd-running",
      payload: {
        threadId: "thread-1",
        session: {
          sessionId: "session-1",
          status: "running",
          provider: "codex",
          threadId: "thread-1",
          activeTurnId: "turn-1",
          createdAt,
          updatedAt: startedAt,
          lastError: null,
        },
      },
    };

    const readySessionEvent: OrchestrationEvent = {
      sequence: 3,
      eventId: "session-ready",
      type: "thread.session-set",
      aggregateType: "thread",
      aggregateId: "thread-1",
      occurredAt: completedAt,
      commandId: "cmd-ready",
      payload: {
        threadId: "thread-1",
        session: {
          sessionId: "session-1",
          status: "ready",
          provider: "codex",
          threadId: "thread-1",
          activeTurnId: null,
          createdAt,
          updatedAt: completedAt,
          lastError: null,
        },
      },
    };

    const afterCreate = await Effect.runPromise(projectEvent(model, createdEvent));
    const afterRunning = await Effect.runPromise(projectEvent(afterCreate, runningSessionEvent));
    const afterReady = await Effect.runPromise(projectEvent(afterRunning, readySessionEvent));
    const thread = afterReady.threads[0];

    expect(thread?.latestTurnId).toBe("turn-1");
    expect(thread?.latestTurnStartedAt).toBe(startedAt);
    expect(thread?.latestTurnCompletedAt).toBe(completedAt);
    expect(thread?.latestTurnDurationMs).toBe(6250);
  });

  it("marks assistant messages completed using non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const createdEvent: OrchestrationEvent = {
      sequence: 1,
      eventId: "thread-created",
      type: "thread.created",
      aggregateType: "thread",
      aggregateId: "thread-1",
      occurredAt: createdAt,
      commandId: "cmd-create",
      payload: {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        model: "gpt-5.3-codex",
        branch: null,
        worktreePath: null,
        createdAt,
        updatedAt: createdAt,
      },
    };

    const deltaEvent: OrchestrationEvent = {
      sequence: 2,
      eventId: "assistant-delta",
      type: "message.sent",
      aggregateType: "thread",
      aggregateId: "thread-1",
      occurredAt: deltaAt,
      commandId: "cmd-delta",
      payload: {
        id: "assistant:msg-1",
        role: "assistant",
        text: "hello",
        threadId: "thread-1",
        createdAt: deltaAt,
        streaming: true,
      },
    };

    const completionEvent: OrchestrationEvent = {
      sequence: 3,
      eventId: "assistant-complete",
      type: "message.sent",
      aggregateType: "thread",
      aggregateId: "thread-1",
      occurredAt: completeAt,
      commandId: "cmd-complete",
      payload: {
        id: "assistant:msg-1",
        role: "assistant",
        text: "",
        threadId: "thread-1",
        createdAt: completeAt,
        streaming: false,
      },
    };

    const afterCreate = await Effect.runPromise(projectEvent(model, createdEvent));
    const afterDelta = await Effect.runPromise(projectEvent(afterCreate, deltaEvent));
    const afterComplete = await Effect.runPromise(projectEvent(afterDelta, completionEvent));
    const message = afterComplete.threads[0]?.messages[0];

    expect(message).toEqual({
      id: "assistant:msg-1",
      role: "assistant",
      text: "hello",
      createdAt: deltaAt,
      completedAt: completeAt,
      streaming: false,
    });
  });
});
