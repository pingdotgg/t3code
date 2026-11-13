import { describe, expect, it } from "@effect/vitest";

import { kimiOAuthKey, kimiUsageResponseToLimits } from "./kimiUsageLimits.ts";

/**
 * The shape Kimi's `/usages` endpoint answers with on both managed hosts;
 * `remaining` arrives too but is informational.
 */
const liveResponse = {
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        used: "19",
        remaining: "81",
        resetTime: "2026-11-13T16:16:25.411087Z",
      },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0.1857, reset_time: "2026-11-13T16:16:24Z" },
    limit_month_total: { used_ratio: 0.3616, reset_time: "2026-12-12T00:00:00Z" },
    limit_month_code: { used_ratio: 0.3616, reset_time: "2026-12-12T00:00:00Z" },
  },
} as const;

describe("kimiOAuthKey", () => {
  it("maps the managed deployments to the CLI's shared slot", () => {
    for (const baseUrl of ["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"]) {
      expect(
        kimiOAuthKey({ oauthHost: "https://auth.kimi.com", baseUrl, sha256Hex: "0".repeat(64) }),
      ).toBe("kimi-code");
    }
  });

  it("scopes any other environment to a hash of its endpoints", () => {
    expect(
      kimiOAuthKey({
        oauthHost: "https://auth.kimi.ai",
        baseUrl: "https://api.kimi.ai/coding/v1",
        sha256Hex: "0e4f99c69cc27850594b4d64b6b7126c4e69f04c9deb2f6dd17d2946d0541a2b",
      }),
    ).toBe("kimi-code-env-0e4f99c69cc27850");
  });
});

describe("kimiUsageResponseToLimits", () => {
  it("derives session and monthly windows from Kimi's live shape", () => {
    const limits = kimiUsageResponseToLimits(liveResponse, "2026-11-13T12:00:00.000Z");
    expect(limits).toEqual({
      checkedAt: "2026-11-13T12:00:00.000Z",
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 19,
          resetsAt: "2026-11-13T16:16:25.411Z",
          windowDurationMins: 300,
        },
        {
          id: "monthly",
          kind: "monthly",
          label: "Monthly",
          usedPercent: 36.16,
          resetsAt: "2026-12-12T00:00:00.000Z",
          windowDurationMins: 30 * 24 * 60,
        },
      ],
    });
  });

  it("falls back to ratios when a deployment drops the counted rows", () => {
    const limits = kimiUsageResponseToLimits(
      { usages: liveResponse.usages },
      "2026-11-13T12:00:00.000Z",
    );
    expect(limits.windows).toHaveLength(2);
    expect(limits.windows.find((window) => window.id === "session")).toMatchObject({
      usedPercent: 18.57,
      windowDurationMins: 300,
    });
    expect(limits.windows.find((window) => window.id === "monthly")).toMatchObject({
      usedPercent: 36.16,
    });
  });

  it("produces no windows for a signed-out or non-managed account", () => {
    expect(kimiUsageResponseToLimits({}, "2026-11-13T12:00:00.000Z").windows).toHaveLength(0);
    expect(
      kimiUsageResponseToLimits(
        {
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              // A zero limit cannot produce a percentage.
              detail: { limit: "0", used: "0", resetTime: "2026-11-13T16:16:25.411087Z" },
            },
          ],
        },
        "2026-11-13T12:00:00.000Z",
      ).windows,
    ).toHaveLength(0);
  });

  it("publishes a weekly-kind window when Kimi reports one", () => {
    const limits = kimiUsageResponseToLimits(
      {
        limits: [
          {
            window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" },
            detail: { limit: "10", used: "1" },
          },
        ],
      },
      "2026-11-13T12:00:00.000Z",
    );
    expect(limits.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 10,
        windowDurationMins: 7 * 24 * 60,
      },
    ]);
  });
});
