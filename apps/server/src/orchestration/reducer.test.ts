import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, reduceEvent } from "./reducer.ts";

describe("orchestration reducer", () => {
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

    const next = await Effect.runPromise(reduceEvent(model, event));
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

    await expect(Effect.runPromise(reduceEvent(model, event))).rejects.toBeDefined();
  });

  it("keeps reducer forward-compatible for unknown event types", async () => {
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

    const next = await Effect.runPromise(reduceEvent(model, event));
    expect(next.sequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });
});
