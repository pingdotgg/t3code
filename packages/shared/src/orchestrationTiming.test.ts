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
  it.each([null, "2026-09-06T23:34:00.000Z"])(
    "does not time a superseded turn when the active turn differs",
    (sendStartedAt) => {
      expect(
        deriveActiveWorkStartedAt(
          {
            turnId: "old",
            requestedAt: "2026-09-06T23:33:00.000Z",
            startedAt: null,
            completedAt: null,
          },
          { orchestrationStatus: "running", activeTurnId: "new" },
          sendStartedAt,
        ),
      ).toBe(sendStartedAt);
    },
  );

  it("stops timing a turn that failed before its provider started", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: null,
          completedAt: "2026-09-06T23:33:05.000Z",
        },
        { orchestrationStatus: "error", activeTurnId: null },
        null,
      ),
    ).toBeNull();
  });
  // The gap this closes. The projector stamps startedAt in the same update
  // that moves the session to "running", so during provider spin-up the turn
  // is requested with no startedAt and the session is "starting". Returning
  // null there blinks the working indicator out between "Setting up
  // worktree..." and "Working for 0s".
  it("counts from requestedAt while the provider is still starting", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: null,
          completedAt: null,
        },
        { orchestrationStatus: "starting", activeTurnId: null },
        null,
      ),
    ).toBe("2026-09-06T23:33:00.000Z");
  });

  it("prefers the turn's own startedAt once the provider reports it", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: null,
        },
        { orchestrationStatus: "running", activeTurnId: "turn-1" },
        null,
      ),
    ).toBe("2026-09-06T23:33:05.000Z");
  });

  // requestedAt must not leak past the end of the work.
  it("stops counting once the turn has settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: "2026-09-06T23:33:09.000Z",
        },
        { orchestrationStatus: "idle", activeTurnId: null },
        null,
      ),
    ).toBeNull();
  });

  // A session restarting with no new turn must not resurrect the old one.
  it("does not count a settled turn while a session is starting again", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: "2026-09-06T23:33:09.000Z",
        },
        { orchestrationStatus: "starting", activeTurnId: null },
        null,
      ),
    ).toBeNull();
  });

  it("falls back to the caller's send timestamp when there is no turn yet", () => {
    expect(deriveActiveWorkStartedAt(null, null, "2026-09-06T23:33:00.000Z")).toBe(
      "2026-09-06T23:33:00.000Z",
    );
  });
});
