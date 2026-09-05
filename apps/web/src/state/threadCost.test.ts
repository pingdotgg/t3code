import { ThreadId, UsageDay, type UsageThreadRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeThreadCostInput,
  millisecondsUntilNextThreadCostDay,
  resolveThreadCostState,
  summarizeThreadCost,
  supportsThreadCostBreakdown,
} from "./threadCost";

const threadId = ThreadId.make("thread-cost-test");

function row(overrides: Partial<UsageThreadRow> = {}): UsageThreadRow {
  return {
    key: "row",
    threadId,
    title: "Thread",
    provider: "claude",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 200,
      cacheCreationTokens: 300,
      outputTokens: 400,
      reasoningTokens: 0,
    },
    costUsd: 4,
    cacheWriteUsd: 1,
    sessions: 1,
    agents: [],
    daily: [{ day: UsageDay.make("2026-09-01"), cacheWriteUsd: 1, cacheReadUsd: 2, freshUsd: 0.5 }],
    ...overrides,
  };
}

describe("thread cost state", () => {
  it("requests the thread's full lifetime and scopes the server response", () => {
    const input = makeThreadCostInput(
      threadId,
      "2026-08-30T23:30:00.000Z",
      new Date("2026-09-02T01:00:00.000Z"),
    );

    expect(input.threadId).toBe(threadId);
    expect(input.sinceDay <= input.untilDay).toBe(true);
  });

  it("schedules a refresh at the next local calendar day", () => {
    const delay = millisecondsUntilNextThreadCostDay(new Date(2026, 8, 2, 23, 59, 30));

    expect(delay).toBeGreaterThan(30_000);
    expect(delay).toBeLessThan(32_000);
  });

  it("only enables the thread RPC when the server advertises pre-cap filtering", () => {
    expect(supportsThreadCostBreakdown(null)).toBeNull();
    expect(supportsThreadCostBreakdown({})).toBe(false);
    expect(supportsThreadCostBreakdown({ usageThreadFilter: true })).toBe(true);
  });

  it("does not read the breakdown query while the capability is absent or loading", () => {
    let queryReads = 0;
    const readBreakdown = () => {
      queryReads += 1;
      return { breakdown: null, isPending: false };
    };

    expect(resolveThreadCostState(null, readBreakdown)).toEqual({
      breakdown: null,
      isPending: true,
      supported: null,
    });
    expect(resolveThreadCostState({}, readBreakdown)).toEqual({
      breakdown: null,
      isPending: false,
      supported: false,
    });
    expect(queryReads).toBe(0);

    resolveThreadCostState({ usageThreadFilter: true }, readBreakdown);
    expect(queryReads).toBe(1);
  });

  it("combines provider rows and keeps provider-reported cost visible", () => {
    const result = summarizeThreadCost(
      [
        row(),
        row({
          key: "codex-row",
          provider: "codex",
          costUsd: 1.25,
          cacheWriteUsd: 0,
          totals: {
            uncachedInputTokens: 10,
            cachedInputTokens: 20,
            cacheCreationTokens: 0,
            outputTokens: 30,
            reasoningTokens: 5,
          },
          daily: [],
        }),
        row({ key: "other-thread", threadId: ThreadId.make("other-thread"), costUsd: 100 }),
      ],
      threadId,
    );

    expect(result.costUsd).toBe(5.25);
    expect(result.cacheWriteUsd).toBe(1);
    expect(result.cacheReadUsd).toBe(2);
    expect(result.freshUsd).toBe(0.5);
    expect(result.providerReportedUsd).toBe(1.75);
    expect(result.cachedInputTokens).toBe(220);
  });

  it("marks cache-write cost unavailable and keeps priced writes in the remainder", () => {
    const result = summarizeThreadCost([row({ cacheWriteUsd: null })], threadId);

    expect(result.cacheWriteUsd).toBeNull();
    expect(result.providerReportedUsd).toBe(1.5);
  });
});
