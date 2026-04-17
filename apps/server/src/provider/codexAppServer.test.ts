import { describe, expect, it } from "vitest";

import { normalizeCodexUsageLimits, readCodexRateLimitsSnapshot } from "./codexAppServer.ts";

describe("codexAppServer", () => {
  it("parses account/rateLimits/read payloads", () => {
    const snapshot = readCodexRateLimitsSnapshot({
      rateLimits: {
        shortWindow: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_776_384_000,
        },
        longWindow: {
          usedPercent: 40,
          windowDurationMins: 10_080,
          resetsAt: 1_776_988_800,
        },
      },
    });

    expect(snapshot).toEqual({
      windows: [
        {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: "2026-04-17T00:00:00.000Z",
        },
        {
          usedPercent: 40,
          windowDurationMins: 10080,
          resetsAt: "2026-04-24T00:00:00.000Z",
        },
      ],
    });
  });

  it("prefers rateLimitsByLimitId.codex when present", () => {
    const snapshot = readCodexRateLimitsSnapshot({
      rateLimits: {
        longWindow: {
          usedPercent: 80,
          windowDurationMins: 10_080,
        },
      },
      rateLimitsByLimitId: {
        codex: {
          rateLimits: {
            shortWindow: {
              usedPercent: 20,
              windowDurationMins: 300,
            },
            longWindow: {
              usedPercent: 30,
              windowDurationMins: 10_080,
            },
          },
        },
      },
    });

    expect(snapshot).toEqual({
      windows: [
        {
          usedPercent: 20,
          windowDurationMins: 300,
        },
        {
          usedPercent: 30,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("tolerates missing rate-limit responses", () => {
    expect(readCodexRateLimitsSnapshot(undefined)).toBeUndefined();
    expect(
      normalizeCodexUsageLimits({
        checkedAt: "2026-04-17T00:00:00.000Z",
      }),
    ).toEqual({
      source: "codexAppServer",
      available: false,
      reason: "No Codex subscription quota windows reported.",
      windows: [],
      checkedAt: "2026-04-17T00:00:00.000Z",
    });
  });

  it("accepts alternate rate-limit field names and unix-ms reset timestamps", () => {
    const snapshot = readCodexRateLimitsSnapshot({
      limits: [
        {
          used_percent: "42",
          window_duration_seconds: 18_000,
          reset_at: 1_776_384_000_000,
        },
      ],
    });

    expect(snapshot).toEqual({
      windows: [
        {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: "2026-04-17T00:00:00.000Z",
        },
      ],
    });
  });

  it("falls back to session and weekly windows when duration metadata is missing", () => {
    const snapshot = readCodexRateLimitsSnapshot({
      rateLimits: {
        shortWindow: {
          usedPercent: 21,
          resetsAt: 1_776_384_000,
        },
        longWindow: {
          usedPercent: 67,
          resetsAt: 1_776_988_800,
        },
      },
    });

    expect(snapshot).toEqual({
      windows: [
        {
          usedPercent: 21,
          windowDurationMins: 300,
          resetsAt: "2026-04-17T00:00:00.000Z",
        },
        {
          usedPercent: 67,
          windowDurationMins: 10080,
          resetsAt: "2026-04-24T00:00:00.000Z",
        },
      ],
    });
  });

  it("derives usage percent from used and limit fields", () => {
    const snapshot = readCodexRateLimitsSnapshot({
      rateLimits: {
        shortWindow: {
          used: 42,
          limit: 100,
          windowDurationMins: 300,
          resetsAt: 1_776_384_000,
        },
      },
    });

    expect(snapshot).toEqual({
      windows: [
        {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: "2026-04-17T00:00:00.000Z",
        },
      ],
    });
  });
});
