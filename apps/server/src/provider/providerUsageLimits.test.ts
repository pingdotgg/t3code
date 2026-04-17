import { describe, expect, it } from "vitest";

import {
  clampPercent,
  makeUsageLimitsSnapshot,
  toIsoDateTimeFromUnixSeconds,
  windowKindFromDuration,
} from "./providerUsageLimits.ts";

describe("providerUsageLimits", () => {
  it("clamps percentages into the supported range", () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(42)).toBe(42);
    expect(clampPercent(150)).toBe(100);
  });

  it("maps the shortest window to session and the longest to weekly", () => {
    expect(
      makeUsageLimitsSnapshot({
        source: "codexAppServer",
        checkedAt: "2026-04-17T10:00:00.000Z",
        unavailableReason: "missing",
        windows: [
          {
            label: "Five hour",
            usedPercent: 10,
            windowDurationMins: 300,
          },
          {
            label: "Seven day",
            usedPercent: 20,
            windowDurationMins: 10_080,
          },
        ],
      }).windows,
    ).toEqual([
      {
        kind: "session",
        label: "Session",
        usedPercent: 10,
        windowDurationMins: 300,
      },
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 20,
        windowDurationMins: 10080,
      },
    ]);
    expect(
      windowKindFromDuration({
        windowDurationMins: 300,
        shortestWindowDurationMins: 300,
        longestWindowDurationMins: 10080,
      }),
    ).toBe("session");
    expect(
      windowKindFromDuration({
        windowDurationMins: 10080,
        shortestWindowDurationMins: 300,
        longestWindowDurationMins: 10080,
      }),
    ).toBe("weekly");
  });

  it("normalizes unix-second reset timestamps", () => {
    expect(toIsoDateTimeFromUnixSeconds(1_713_353_600)).toBe("2024-04-17T11:33:20.000Z");
  });

  it("drops malformed or out-of-range unix-second reset timestamps", () => {
    expect(toIsoDateTimeFromUnixSeconds(Number.MAX_VALUE)).toBeUndefined();
    expect(toIsoDateTimeFromUnixSeconds(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
