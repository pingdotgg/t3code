import { describe, expect, it } from "vite-plus/test";

import { formatDuration, deriveActiveWorkStartedAt } from "./orchestrationTiming.ts";

describe("formatDuration", () => {
  it.each([
    [0, "1ms"],
    [250, "250ms"],
    [1_500, "1.5s"],
    [9_950, "10s"],
    [22_000, "22s"],
    [60_000, "1m"],
    [65_000, "1m 5s"],
    [119_500, "2m"],
    [3_599_499, "59m 59s"],
    [3_599_500, "1h"],
    [3_600_000, "1h"],
    [3_601_000, "1h 1s"],
    [3_660_000, "1h 1m"],
    [3_661_000, "1h 1m 1s"],
    [7_199_500, "2h"],
    [25_190_000, "6h 59m 50s"],
    [90_061_000, "25h 1m 1s"],
  ])("formats %d ms as %s", (durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected);
  });

  it.each([-1, NaN, Infinity, -Infinity])("handles invalid durations: %s", (durationMs) => {
    expect(formatDuration(durationMs)).toBe("0ms");
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const running = { orchestrationStatus: "running", activeTurnId: "turn-1" } as const;
  const requestedTurn = {
    turnId: "turn-1",
    startedAt: null,
    completedAt: null,
  };

  // The gap this closes: a queued prompt lands and the session goes running,
  // but the provider has not stamped startedAt yet. Returning null there blinks
  // the working indicator out between "Setting up worktree…" and "Working for".
  it("counts from the last user message while a running turn has no startedAt", () => {
    expect(
      deriveActiveWorkStartedAt(requestedTurn, running, null, "2026-09-06T23:21:00.000Z"),
    ).toBe("2026-09-06T23:21:00.000Z");
  });

  it("prefers the turn's own startedAt once the provider reports it", () => {
    expect(
      deriveActiveWorkStartedAt(
        { ...requestedTurn, startedAt: "2026-09-06T23:21:05.000Z" },
        running,
        null,
        "2026-09-06T23:21:00.000Z",
      ),
    ).toBe("2026-09-06T23:21:05.000Z");
  });

  it("stops counting once the turn settles, despite a user message being present", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: "turn-1",
          startedAt: "2026-09-06T23:21:05.000Z",
          completedAt: "2026-09-06T23:21:09.000Z",
        },
        { orchestrationStatus: "idle", activeTurnId: null },
        null,
        "2026-09-06T23:21:00.000Z",
      ),
    ).toBeNull();
  });

  it("keeps counting an unsettled turn when no session is running", () => {
    expect(
      deriveActiveWorkStartedAt(
        { turnId: "turn-1", startedAt: "2026-09-06T23:21:05.000Z", completedAt: null },
        null,
        null,
      ),
    ).toBe("2026-09-06T23:21:05.000Z");
  });
});
