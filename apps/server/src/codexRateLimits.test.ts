import { describe, expect, it } from "vitest";

import { normalizeCodexRateLimitsResponse } from "./codexRateLimits";

describe("normalizeCodexRateLimitsResponse", () => {
  it("normalizes direct rate-limit responses", () => {
    const result = normalizeCodexRateLimitsResponse(
      {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          planType: "team",
          primary: {
            usedPercent: 14,
            windowDurationMins: 300,
            resetsAt: 1_772_898_386,
          },
          secondary: {
            usedPercent: 46,
            windowDurationMins: 10_080,
            resetsAt: 1_773_235_492,
          },
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: null,
          },
        },
      },
      "2026-03-07T12:00:00.000Z",
    );

    expect(result).toEqual({
      fetchedAt: "2026-03-07T12:00:00.000Z",
      limitId: "codex",
      limitName: null,
      planType: "team",
      primary: {
        usedPercent: 14,
        remainingPercent: 86,
        windowDurationMins: 300,
        resetsAt: "2026-03-07T15:46:26.000Z",
      },
      secondary: {
        usedPercent: 46,
        remainingPercent: 54,
        windowDurationMins: 10080,
        resetsAt: "2026-03-11T13:24:52.000Z",
      },
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: null,
      },
    });
  });

  it("falls back to rateLimitsByLimitId when needed", () => {
    const result = normalizeCodexRateLimitsResponse({
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          planType: "team",
          primary: {
            usedPercent: 22,
            windowDurationMins: 300,
            resetsAt: 1_772_898_386,
          },
        },
      },
    });

    expect(result.limitId).toBe("codex");
    expect(result.primary?.remainingPercent).toBe(78);
    expect(result.secondary).toBeNull();
  });

  it("throws when no usable rate-limit payload exists", () => {
    expect(() => normalizeCodexRateLimitsResponse({ account: { type: "chatgpt" } })).toThrow(
      "Codex rate-limit response did not include rate-limit data.",
    );
  });
});
