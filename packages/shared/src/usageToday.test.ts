// @effect-diagnostics globalDate:off -- Fixed instants keep calendar-day assertions deterministic.
import type { UsageBucket, UsageDay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { summarizeTodayUsage } from "./usageToday.ts";

function bucket(day: string, costUsd: number, hourStart?: string): UsageBucket {
  return {
    day: day as UsageDay,
    ...(hourStart === undefined ? {} : { hourStart }),
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  };
}

describe("summarizeTodayUsage", () => {
  it("sums today's cost across day and hourStart buckets, ignoring other days", () => {
    const buckets = [
      bucket("2026-11-04", 4),
      bucket("2026-11-04", 3, "2026-11-04T10:00:00Z"),
      bucket("2026-11-03", 100),
    ];
    const summary = summarizeTodayUsage(buckets, new Date("2026-11-04T15:00:00Z"), "UTC");
    expect(summary?.todayCostUsd).toBe(7);
    expect(summary?.dayKey).toBe("2026-11-04");
  });

  it("computes pace as the 7-day trailing average excluding today", () => {
    const priorDays = [
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ];
    const buckets = [bucket("2026-11-04", 10), ...priorDays.map((day) => bucket(day, 7))];
    const summary = summarizeTodayUsage(buckets, new Date("2026-11-04T15:00:00Z"), "UTC");
    expect(summary?.paceUsd).toBe(7);
    expect(summary?.deltaPercent).toBeCloseTo(42.857142857142854, 10);
  });

  it("returns null for empty buckets, but a zero today when only prior days exist", () => {
    const now = new Date("2026-11-04T15:00:00Z");
    expect(summarizeTodayUsage([], now, "UTC")).toBeNull();
    // Idle today is reported with todayCostUsd 0 so the caller can distinguish
    // "no data ever" (null) from "nothing spent today" (a real summary).
    const summary = summarizeTodayUsage([bucket("2026-11-03", 14)], now, "UTC");
    expect(summary).toEqual({
      todayCostUsd: 0,
      paceUsd: 14,
      deltaPercent: -100,
      dayKey: "2026-11-04",
    });
  });

  it("keys today in the given timeZone, not UTC", () => {
    const buckets = [bucket("2026-11-03", 5), bucket("2026-11-04", 9)];
    // 2026-11-03 23:30 in America/Los_Angeles is still Nov 3 there (Nov 4 06:30 UTC).
    const beforeMidnight = summarizeTodayUsage(
      buckets,
      new Date("2026-11-04T06:30:00Z"),
      "America/Los_Angeles",
    );
    expect(beforeMidnight?.dayKey).toBe("2026-11-03");
    expect(beforeMidnight?.todayCostUsd).toBe(5);
    // 2026-11-04 00:30 in America/Los_Angeles is Nov 4 there (Nov 4 08:30 UTC).
    const afterMidnight = summarizeTodayUsage(
      buckets,
      new Date("2026-11-04T08:30:00Z"),
      "America/Los_Angeles",
    );
    expect(afterMidnight?.dayKey).toBe("2026-11-04");
    expect(afterMidnight?.todayCostUsd).toBe(9);
  });

  it("divides pace by the number of prior days present, not 7", () => {
    const buckets = [bucket("2026-11-04", 8), bucket("2026-11-02", 2), bucket("2026-11-03", 4)];
    const summary = summarizeTodayUsage(buckets, new Date("2026-11-04T15:00:00Z"), "UTC");
    expect(summary?.paceUsd).toBe(3);
  });
});
