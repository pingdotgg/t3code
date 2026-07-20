import { describe, expect, it } from "vitest";
import {
  EventId,
  IsoDateTime,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { deriveInsights } from "./insights";

function activity(input: {
  id: string;
  kind: string;
  at: number;
  turnId?: string;
  payload?: Record<string, unknown>;
  summary?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    kind: input.kind,
    tone: "info",
    summary: input.summary ?? input.kind,
    payload: input.payload ?? {},
    turnId: input.turnId ? TurnId.make(input.turnId) : null,
    createdAt: IsoDateTime.make(new Date(input.at).toISOString()),
  };
}

describe("deriveInsights", () => {
  it("separates overlapping tool and waiting intervals from thinking time", () => {
    const result = deriveInsights(
      [
        activity({
          id: "start",
          kind: "insights.turn.started",
          at: 0,
          turnId: "turn-1",
          payload: { provider: ProviderDriverKind.make("copilot") },
        }),
        activity({
          id: "tool-start",
          kind: "tool.started",
          at: 1_000,
          turnId: "turn-1",
          summary: "Read file started",
          payload: {
            itemId: RuntimeItemId.make("tool-1"),
            itemType: "dynamic_tool_call",
          },
        }),
        activity({
          id: "wait-start",
          kind: "approval.requested",
          at: 2_000,
          turnId: "turn-1",
          payload: { requestId: "request-1" },
        }),
        activity({
          id: "tool-end",
          kind: "tool.completed",
          at: 4_000,
          turnId: "turn-1",
          summary: "Read file",
          payload: {
            itemId: RuntimeItemId.make("tool-1"),
            itemType: "dynamic_tool_call",
          },
        }),
        activity({
          id: "wait-end",
          kind: "approval.resolved",
          at: 5_000,
          turnId: "turn-1",
          payload: { requestId: "request-1" },
        }),
        activity({
          id: "end",
          kind: "insights.turn.completed",
          at: 10_000,
          turnId: "turn-1",
          payload: { state: "completed" },
        }),
      ],
      20_000,
    );

    expect(result.durationMs).toBe(10_000);
    expect(result.toolDurationMs).toBe(3_000);
    expect(result.waitingMs).toBe(3_000);
    expect(result.thinkingMs).toBe(6_000);
    expect(result.turns[0]?.tools[0]?.category).toBe("Read");
  });

  it("uses the first update as a tool start and the current time for active intervals", () => {
    const result = deriveInsights(
      [
        activity({
          id: "start",
          kind: "insights.turn.started",
          at: 1_000,
          turnId: "turn-1",
        }),
        activity({
          id: "tool-update",
          kind: "tool.updated",
          at: 2_000,
          turnId: "turn-1",
          summary: "Run tests",
          payload: { itemId: "tool-1", itemType: "command_execution" },
        }),
      ],
      7_000,
    );

    expect(result.durationMs).toBe(6_000);
    expect(result.toolDurationMs).toBe(5_000);
    expect(result.thinkingMs).toBe(1_000);
    expect(result.turns[0]?.tools[0]?.category).toBe("Shell");
  });
});
