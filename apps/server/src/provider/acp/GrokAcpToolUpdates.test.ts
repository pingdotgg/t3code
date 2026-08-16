import { describe, expect, it } from "vite-plus/test";

import {
  GROK_TOOL_CONTENT_CHAR_LIMIT,
  boundGrokToolCallForEvent,
  shouldEmitGrokToolUpdate,
} from "./GrokAcpToolUpdates.ts";

const running = {
  toolCallId: "term-1",
  kind: "execute",
  status: "inProgress" as const,
  title: "Terminal",
  data: { content: "x".repeat(200) },
};

describe("GrokAcpToolUpdates", () => {
  it("drops identical in-progress ticks", () => {
    expect(
      shouldEmitGrokToolUpdate({
        toolCall: running,
        previous: {
          fingerprint: `${running.toolCallId}\u001finProgress\u001fTerminal\u001f200`,
          lastEmittedAt: 0,
        },
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  it("rate-limits growing in-progress terminal output", () => {
    expect(
      shouldEmitGrokToolUpdate({
        toolCall: { ...running, data: { content: "x".repeat(400) } },
        previous: { fingerprint: "other", lastEmittedAt: 900 },
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  it("always emits a terminal status", () => {
    expect(
      shouldEmitGrokToolUpdate({
        toolCall: { ...running, status: "completed" },
        previous: { fingerprint: "other", lastEmittedAt: 999 },
        nowMs: 1_000,
      }),
    ).toBe(true);
  });

  it("truncates cumulative content and strips the raw payload", () => {
    const huge = "y".repeat(GROK_TOOL_CONTENT_CHAR_LIMIT + 50);
    const bounded = boundGrokToolCallForEvent({
      toolCall: { ...running, data: { content: huge }, detail: huge },
      rawPayload: { update: { content: huge } },
    });
    expect(String(bounded.toolCall.data.content).length).toBe(GROK_TOOL_CONTENT_CHAR_LIMIT);
    expect(bounded.rawPayload).toEqual({
      truncated: true,
      toolCallId: "term-1",
      status: "inProgress",
    });
  });
});
