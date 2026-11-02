import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentElapsedMs, formatLiveDuration } from "./orchestrationTiming.ts";

describe("formatLiveDuration", () => {
  it.each([
    [Number.NaN, "0s"],
    [Number.POSITIVE_INFINITY, "0s"],
    [-100, "0s"],
    [0, "0s"],
    [999, "0s"],
    [1_000, "1s"],
    [9_999, "9s"],
    [10_000, "10s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [61_999, "1m 1s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h"],
    [3_661_999, "1h 1m 1s"],
  ])("formats %s ms as %s", (duration, expected) => {
    expect(formatLiveDuration(duration)).toBe(expected);
  });
});

describe("deriveSubagentElapsedMs", () => {
  const startedAt = "2026-09-21T12:00:00.000Z";
  const completedAt = "2026-09-21T12:00:10.000Z";
  const now = Date.parse("2026-09-21T13:00:00.000Z");
  it.each(["idle", "completed", "failed"] as const)(
    "does not count the age of %s work with unknown completion timing",
    (status) => {
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt: null }, now)).toBeNull();
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt }, now)).toBe(10_000);
    },
  );
  it("counts a resumed activation despite a stale previous completion timestamp", () => {
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs({ status: "running", startedAt: null, completedAt: null }, now),
    ).toBeNull();
  });
});
