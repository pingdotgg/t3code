import { describe, expect, it } from "vitest";
import {
  clampPercent,
  makeUsageLimitsSnapshot,
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

  it("keeps intermediate windows as session instead of dropping them", () => {
    expect(
      makeUsageLimitsSnapshot({
        source: "codexAppServer",
        checkedAt: "2026-04-17T10:00:00.000Z",
        unavailableReason: "missing",
        windows: [
          { label: "Short", usedPercent: 10, windowDurationMins: 60 },
          { label: "Middle", usedPercent: 20, windowDurationMins: 1440 },
          { label: "Long", usedPercent: 30, windowDurationMins: 4320 },
        ],
      }).windows,
    ).toEqual([
      {
        kind: "session",
        label: "Session",
        usedPercent: 10,
        windowDurationMins: 60,
      },
      {
        kind: "session",
        label: "Session",
        usedPercent: 20,
        windowDurationMins: 1440,
      },
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 30,
        windowDurationMins: 4320,
      },
    ]);
  });
});
