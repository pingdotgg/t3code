import { describe, expect, it } from "vite-plus/test";

import { deriveTurnActivityTrace } from "./turnActivityTrace.ts";

describe("deriveTurnActivityTrace", () => {
  it("surfaces hidden provider lifecycle events and the latest assistant feedback", () => {
    const trace = deriveTurnActivityTrace({
      activeTurnId: "turn-2" as never,
      activeTurnStartedAt: "2026-01-01T00:00:10Z",
      threadActivities: [
        {
          id: "stale-null-turn-event" as never,
          turnId: null,
          tone: "info",
          kind: "context-window.updated",
          summary: "Old context update",
          payload: {},
          createdAt: "2026-01-01T00:00:09Z" as never,
        },
        {
          id: "tool-started" as never,
          turnId: "turn-2" as never,
          tone: "tool",
          kind: "tool.started",
          summary: "bash started",
          payload: { detail: "  Running   focused tests  " },
          createdAt: "2026-01-01T00:00:11Z" as never,
        },
        {
          id: "context-updated" as never,
          turnId: null,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload: {},
          createdAt: "2026-01-01T00:00:12Z" as never,
        },
        {
          id: "other-turn-event" as never,
          turnId: "turn-1" as never,
          tone: "tool",
          kind: "tool.completed",
          summary: "Other turn command",
          payload: {},
          createdAt: "2026-01-01T00:00:13Z" as never,
        },
      ],
      assistantMessages: [
        {
          id: "assistant-message" as never,
          role: "assistant",
          text: "I am checking the provider trace now.",
          turnId: "turn-2" as never,
          updatedAt: "2026-01-01T00:00:15Z" as never,
          streaming: false,
        },
      ],
    });

    expect(trace).toMatchObject({
      turnId: "turn-2",
      providerEventCount: 2,
      toolCallCount: 1,
      lastFeedbackAt: "2026-01-01T00:00:15Z",
    });
    expect(trace.entries.map((entry) => entry.kind)).toEqual([
      "assistant.updated",
      "context-window.updated",
      "tool.started",
    ]);
    expect(trace.entries.at(-1)?.detail).toBe("Running focused tests");
  });

  it("reports no feedback when a request started but no matching event arrived", () => {
    expect(
      deriveTurnActivityTrace({
        activeTurnId: null,
        activeTurnStartedAt: "2026-01-01T00:00:10Z",
        threadActivities: [],
        assistantMessages: [],
      }),
    ).toEqual({
      turnId: null,
      entries: [],
      providerEventCount: 0,
      toolCallCount: 0,
      lastFeedbackAt: null,
    });
  });
});
