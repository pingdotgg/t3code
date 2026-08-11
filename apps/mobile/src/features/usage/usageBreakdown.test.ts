import { describe, expect, it } from "vite-plus/test";

import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { getRecentUsageDays } from "./usageBreakdown";

function makeDay(day: string): DailyTotals {
  return {
    day,
    costUsd: 0,
    totalTokens: 0,
    byProvider: new Map(),
  };
}

describe("getRecentUsageDays", () => {
  it("returns the newest days first", () => {
    const daily = [makeDay("2026-08-01"), makeDay("2026-08-02"), makeDay("2026-08-03")];

    expect(getRecentUsageDays(daily).map((entry) => entry.day)).toEqual([
      "2026-08-03",
      "2026-08-02",
      "2026-08-01",
    ]);
  });

  it("limits the breakdown to eight days", () => {
    const daily = Array.from({ length: 10 }, (_, index) =>
      makeDay(`2026-08-${String(index + 1).padStart(2, "0")}`),
    );

    expect(getRecentUsageDays(daily).map((entry) => entry.day)).toEqual([
      "2026-08-10",
      "2026-08-09",
      "2026-08-08",
      "2026-08-07",
      "2026-08-06",
      "2026-08-05",
      "2026-08-04",
      "2026-08-03",
    ]);
  });

  it("returns an empty list when there is no activity", () => {
    expect(getRecentUsageDays([])).toEqual([]);
  });

  it("does not mutate the source list", () => {
    const daily = [makeDay("2026-08-01"), makeDay("2026-08-02")];
    const original = [...daily];

    getRecentUsageDays(daily);

    expect(daily).toEqual(original);
  });
});
