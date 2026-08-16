import { describe, expect, it } from "vite-plus/test";

import {
  GROK_TOOL_CONTENT_CHAR_LIMIT,
  boundGrokToolCallForEvent,
  grokToolCallFingerprint,
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
          fingerprint: grokToolCallFingerprint(running),
          lastEmittedAt: 0,
        },
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  it("emits same-length content changes after the interval", () => {
    expect(
      shouldEmitGrokToolUpdate({
        toolCall: { ...running, data: { content: "y".repeat(200) } },
        previous: {
          fingerprint: grokToolCallFingerprint(running),
          lastEmittedAt: 0,
        },
        nowMs: 1_000,
      }),
    ).toBe(true);
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

  it("does not stringify large in-progress payloads while rate-limited", () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => `line-${index}`);
    expect(
      shouldEmitGrokToolUpdate({
        toolCall: { ...running, data: { lines } },
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

  it("bounds an array of many short strings by serialized size", () => {
    const bounded = boundGrokToolCallForEvent({
      toolCall: {
        ...running,
        data: { lines: Array.from({ length: 4_000 }, (_, index) => `line-${index}`) },
      },
      rawPayload: { lines: Array.from({ length: 4_000 }, (_, index) => `line-${index}`) },
    });
    expect(bounded.toolCall.data).toMatchObject({ truncated: true });
    expect(String(bounded.toolCall.data.tail).length).toBeLessThanOrEqual(
      GROK_TOOL_CONTENT_CHAR_LIMIT,
    );
    expect(bounded.rawPayload).toMatchObject({ truncated: true, toolCallId: "term-1" });
  });
});
