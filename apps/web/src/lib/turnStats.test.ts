import { describe, expect, it } from "vitest";
import {
  EventId,
  ProviderInstanceId,
  TurnId,
  type ModelSelection,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ChatMessage } from "../types";
import { buildLatestAssistantTurnStatsMap, deriveLatestAssistantTurnStats } from "./turnStats";

const TURN_ID = TurnId.make("turn-1");

function makeLatestTurn(overrides?: Partial<OrchestrationLatestTurn>): OrchestrationLatestTurn {
  return {
    turnId: TURN_ID,
    state: "completed",
    requestedAt: "2026-05-07T23:00:00.000Z",
    startedAt: "2026-05-07T23:00:01.000Z",
    completedAt: "2026-05-07T23:00:11.000Z",
    assistantMessageId: "assistant-1" as never,
    ...overrides,
  };
}

function makeAssistantMessage(overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    id: "assistant-1" as never,
    role: "assistant",
    text: "Done.",
    turnId: TURN_ID,
    createdAt: "2026-05-07T23:00:03.000Z",
    completedAt: "2026-05-07T23:00:11.000Z",
    streaming: false,
    ...overrides,
  };
}

function makeActivity(input: {
  id: string;
  kind: string;
  payload: unknown;
  turnId?: OrchestrationThreadActivity["turnId"];
  createdAt?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: input.kind.startsWith("tool.") ? "tool" : "info",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload,
    turnId: input.turnId === undefined ? TURN_ID : input.turnId,
    createdAt: input.createdAt ?? "2026-05-07T23:00:10.000Z",
  };
}

function makeModelSelection(options?: ModelSelection["options"]): ModelSelection {
  return createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", options);
}

describe("turnStats", () => {
  it("derives a compact stats row for the latest completed assistant turn", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn(),
      assistantMessage: makeAssistantMessage(),
      activities: [
        makeActivity({
          id: "tool-started-1",
          kind: "tool.started",
          payload: { data: { toolCallId: "tool-1" } },
        }),
        makeActivity({
          id: "context-window-1",
          kind: "context-window.updated",
          payload: {
            usedTokens: 9_999,
            lastOutputTokens: 3_276,
            totalProcessedTokens: 8_192,
            durationMs: 5_537,
            timeToFirstTokenMs: 2_000,
          },
        }),
      ],
      modelSelection: makeModelSelection([{ id: "reasoningEffort", value: "high" }]),
    });

    expect(stats).not.toBeNull();
    expect(stats?.items.map((item) => item.label)).toEqual([
      "gpt-5.4 (High)",
      "10 sec",
      "3,276 tokens",
      "592 tok/sec",
      "Time-to-first: 2 sec",
      "1 tool call",
    ]);
    expect(stats?.items.find((item) => item.id === "throughput")?.tooltip).toContain(
      "Approximate throughput",
    );
    expect(stats?.items.find((item) => item.id === "ttft")?.tooltip).toContain(
      "Approximate time-to-first",
    );
  });

  it("hides unavailable metrics instead of fabricating zeros", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn(),
      assistantMessage: makeAssistantMessage(),
      activities: [
        makeActivity({
          id: "context-window-1",
          kind: "context-window.updated",
          payload: { usedTokens: 10 },
        }),
      ],
      modelSelection: null,
    });

    expect(stats?.items.map((item) => item.label)).toEqual(["10 sec"]);
    expect(stats?.summaryLabel).not.toContain("0 tok/sec");
    expect(stats?.summaryLabel).not.toContain("0 tool calls");
  });

  it("formats rounded minute-boundary durations as minutes", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn({
        startedAt: "2026-05-07T23:00:00.000Z",
        completedAt: "2026-05-07T23:00:59.500Z",
      }),
      assistantMessage: makeAssistantMessage({
        createdAt: "2026-05-07T23:00:59.500Z",
        completedAt: "2026-05-07T23:00:59.500Z",
      }),
      activities: [],
      modelSelection: null,
    });

    expect(stats?.items.map((item) => item.label)).toEqual(["1 min"]);
    expect(stats?.summaryLabel).not.toContain("60 sec");
  });

  it("does not derive throughput or TTFT from whole-turn elapsed time", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn({
        startedAt: "2026-05-07T23:00:00.000Z",
        completedAt: "2026-05-07T23:04:44.000Z",
      }),
      assistantMessage: makeAssistantMessage({
        createdAt: "2026-05-07T23:04:43.500Z",
        completedAt: "2026-05-07T23:04:44.000Z",
      }),
      activities: [
        makeActivity({
          id: "context-window-1",
          kind: "context-window.updated",
          payload: {
            usedTokens: 150_000,
            lastOutputTokens: 1_790,
          },
        }),
      ],
      modelSelection: null,
    });

    expect(stats?.items.map((item) => item.label)).toEqual(["4 min 44 sec", "1,790 tokens"]);
    expect(stats?.items.find((item) => item.id === "throughput")).toBeUndefined();
    expect(stats?.items.find((item) => item.id === "ttft")).toBeUndefined();
    expect(stats?.summaryLabel).not.toContain("6.3 tok/sec");
    expect(stats?.summaryLabel).not.toContain("Time-to-first");
  });

  it("derives throughput only from explicit positive generation duration", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn({
        startedAt: "2026-05-07T23:00:00.000Z",
        completedAt: "2026-05-07T23:04:44.000Z",
      }),
      assistantMessage: makeAssistantMessage({
        createdAt: "2026-05-07T23:04:19.000Z",
        completedAt: "2026-05-07T23:04:44.000Z",
      }),
      activities: [
        makeActivity({
          id: "context-window-1",
          kind: "context-window.updated",
          payload: {
            usedTokens: 150_000,
            lastOutputTokens: 1_790,
            durationMs: 25_000,
            timeToFirstTokenMs: 259_000,
          },
        }),
      ],
      modelSelection: null,
    });

    expect(stats?.items.map((item) => item.label)).toEqual([
      "4 min 44 sec",
      "1,790 tokens",
      "71.6 tok/sec",
      "Time-to-first: 4 min 19 sec",
    ]);
    expect(stats?.items.find((item) => item.id === "throughput")?.label).toBe("71.6 tok/sec");
    expect(stats?.summaryLabel).not.toContain("6.3 tok/sec");
  });

  it("formats throughput from corrected response-boundary duration", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn({
        startedAt: "2026-05-08T12:00:00.000Z",
        completedAt: "2026-05-08T12:00:06.700Z",
      }),
      assistantMessage: makeAssistantMessage({
        createdAt: "2026-05-08T12:00:06.186Z",
        completedAt: "2026-05-08T12:00:06.700Z",
      }),
      activities: [
        makeActivity({
          id: "context-window-tiny",
          kind: "context-window.updated",
          createdAt: "2026-05-08T12:00:06.700Z",
          payload: {
            usedTokens: 72_193,
            lastOutputTokens: 16,
            durationMs: 514,
            timeToFirstTokenMs: 6_186,
          },
        }),
      ],
      modelSelection: makeModelSelection([{ id: "reasoningEffort", value: "medium" }]),
    });

    expect(stats?.items.map((item) => item.label)).toEqual([
      "gpt-5.4 (Medium)",
      "6.7 sec",
      "16 tokens",
      "31.1 tok/sec",
      "Time-to-first: 6.2 sec",
    ]);
    expect(stats?.summaryLabel).not.toContain("1,778 tok/sec");
  });

  it("omits observed bad TTFT examples when explicit first-token timing is missing", () => {
    const longTurn = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn({
        startedAt: "2026-05-08T08:15:13.000Z",
        completedAt: "2026-05-08T08:17:30.000Z",
      }),
      assistantMessage: makeAssistantMessage({
        createdAt: "2026-05-08T08:17:30.000Z",
        completedAt: "2026-05-08T08:17:30.000Z",
      }),
      activities: [
        makeActivity({
          id: "context-window-long",
          kind: "context-window.updated",
          payload: {
            usedTokens: 66_957,
            lastOutputTokens: 910,
          },
        }),
      ],
      modelSelection: null,
    });

    const shortTurn = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn({
        startedAt: "2026-05-08T08:17:49.000Z",
        completedAt: "2026-05-08T08:18:20.000Z",
      }),
      assistantMessage: makeAssistantMessage({
        createdAt: "2026-05-08T08:18:20.000Z",
        completedAt: "2026-05-08T08:18:20.000Z",
      }),
      activities: [
        makeActivity({
          id: "context-window-short",
          kind: "context-window.updated",
          payload: {
            usedTokens: 72_193,
            lastOutputTokens: 895,
          },
        }),
      ],
      modelSelection: null,
    });

    expect(longTurn?.items.find((item) => item.id === "ttft")).toBeUndefined();
    expect(longTurn?.summaryLabel).not.toContain("Time-to-first");
    expect(shortTurn?.items.find((item) => item.id === "ttft")).toBeUndefined();
    expect(shortTurn?.summaryLabel).not.toContain("Time-to-first");
  });

  it("skips zero token fields and falls back to the first positive token count", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn(),
      assistantMessage: makeAssistantMessage(),
      activities: [
        makeActivity({
          id: "context-window-1",
          kind: "context-window.updated",
          payload: {
            usedTokens: 10,
            lastOutputTokens: 0,
            lastUsedTokens: 420,
            totalProcessedTokens: 900,
            durationMs: 210_000,
          },
        }),
      ],
      modelSelection: null,
    });

    expect(stats?.items.find((item) => item.id === "tokens")?.label).toBe("420 tokens");
    expect(stats?.items.find((item) => item.id === "throughput")?.label).toBe("2 tok/sec");
    expect(stats?.items.some((item) => item.id === "tokens" && item.label === "0 tokens")).toBe(
      false,
    );
  });

  it("falls back to an unassigned context window snapshot from the completed turn window", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn({
        startedAt: "2026-05-07T23:00:00.000Z",
        completedAt: "2026-05-07T23:03:39.000Z",
      }),
      assistantMessage: makeAssistantMessage({
        createdAt: "2026-05-07T23:03:39.000Z",
        completedAt: "2026-05-07T23:03:39.000Z",
      }),
      activities: [
        makeActivity({
          id: "context-window-old",
          kind: "context-window.updated",
          turnId: null,
          createdAt: "2026-05-07T22:59:59.000Z",
          payload: { usedTokens: 20_000, lastOutputTokens: 99_999 },
        }),
        makeActivity({
          id: "context-window-unassigned",
          kind: "context-window.updated",
          turnId: null,
          createdAt: "2026-05-07T23:03:40.000Z",
          payload: { usedTokens: 4_000, lastOutputTokens: 438 },
        }),
      ],
      modelSelection: null,
    });

    expect(stats?.items.map((item) => item.label)).toEqual(["3 min 39 sec", "438 tokens"]);
    expect(stats?.items.find((item) => item.id === "throughput")).toBeUndefined();
    expect(stats?.items.find((item) => item.id === "ttft")).toBeUndefined();
  });

  it("returns null for incomplete or mismatched assistant turns", () => {
    expect(
      deriveLatestAssistantTurnStats({
        latestTurn: makeLatestTurn({ state: "running", completedAt: null }),
        assistantMessage: makeAssistantMessage(),
        activities: [],
        modelSelection: makeModelSelection(),
      }),
    ).toBeNull();

    expect(
      deriveLatestAssistantTurnStats({
        latestTurn: makeLatestTurn(),
        assistantMessage: makeAssistantMessage({ turnId: TurnId.make("turn-2") }),
        activities: [],
        modelSelection: makeModelSelection(),
      }),
    ).toBeNull();
  });

  it("falls back to completed or updated tool lifecycle events when starts are missing", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn(),
      assistantMessage: makeAssistantMessage(),
      activities: [
        makeActivity({
          id: "tool-updated-1",
          kind: "tool.updated",
          payload: { data: { toolCallId: "tool-1" } },
        }),
        makeActivity({
          id: "tool-completed-1",
          kind: "tool.completed",
          payload: { data: { toolCallId: "tool-2" } },
        }),
      ],
      modelSelection: null,
    });

    expect(stats?.items.find((item) => item.id === "tools")?.label).toBe("2 tool calls");
  });

  it("counts repeated same-title tool starts as distinct tool calls", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn(),
      assistantMessage: makeAssistantMessage(),
      activities: [
        makeActivity({
          id: "tool-started-1",
          kind: "tool.started",
          payload: { itemType: "tool_call" },
        }),
        makeActivity({
          id: "tool-started-2",
          kind: "tool.started",
          payload: { itemType: "tool_call" },
        }),
        makeActivity({
          id: "tool-started-3",
          kind: "tool.started",
          payload: { itemType: "tool_call" },
        }),
      ],
      modelSelection: null,
    });

    expect(stats?.items.find((item) => item.id === "tools")?.label).toBe("3 tool calls");
  });

  it("filters context window snapshots by turn id", () => {
    const stats = deriveLatestAssistantTurnStats({
      latestTurn: makeLatestTurn(),
      assistantMessage: makeAssistantMessage(),
      activities: [
        makeActivity({
          id: "context-window-old",
          kind: "context-window.updated",
          turnId: TurnId.make("turn-0"),
          payload: { usedTokens: 20_000, lastOutputTokens: 99_999 },
        }),
        makeActivity({
          id: "context-window-current",
          kind: "context-window.updated",
          payload: { usedTokens: 4_000, lastOutputTokens: 321 },
        }),
      ],
      modelSelection: null,
    });

    expect(stats?.items.find((item) => item.id === "tokens")?.label).toBe("321 tokens");
  });

  it("builds a message-id keyed stats map only for renderable latest-turn stats", () => {
    const assistantMessage = makeAssistantMessage();
    const statsByMessageId = buildLatestAssistantTurnStatsMap({
      latestTurn: makeLatestTurn(),
      assistantMessage,
      activities: [
        makeActivity({
          id: "context-window-current",
          kind: "context-window.updated",
          payload: { usedTokens: 4_000, lastOutputTokens: 321 },
        }),
      ],
      modelSelection: null,
    });

    expect(statsByMessageId.get(assistantMessage.id)?.items[0]?.label).toBe("10 sec");
  });
});
