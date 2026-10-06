import { describe, expect, it } from "vite-plus/test";

import { claudeRateLimitEventToUpdate, claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("updates all windows carried by a stream-json rate-limit event", () => {
    // Synthetic values using the Claude Code 2.1.281 stream-json serializer shape.
    const event = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed" as const,
        unifiedWindows: {
          five_hour: { utilization: 0.25, resetsAt: 1_900_000_000 },
          seven_day: { utilization: 0.5, resetsAt: 1_900_000_001 },
          seven_day_overage_included: { utilization: 0.2, resetsAt: 1_900_000_002 },
        },
      },
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "00000000-0000-4000-8000-000000000002",
    };
    const update = claudeRateLimitEventToUpdate(event.rate_limit_info, {
      overageIncluded: "Example",
    });
    expect(
      update?.windows.map(({ id, usedPercent, resetsAt }) => ({ id, usedPercent, resetsAt })),
    ).toEqual([
      { id: "five_hour", usedPercent: 25, resetsAt: "2030-03-17T17:46:40.000Z" },
      { id: "seven_day", usedPercent: 50, resetsAt: "2030-03-17T17:46:41.000Z" },
      { id: "seven_day_example", usedPercent: 20, resetsAt: "2030-03-17T17:46:42.000Z" },
    ]);
    expect(
      claudeRateLimitEventToUpdate(event.rate_limit_info, noNames)?.windows.map(({ id }) => id),
    ).toEqual(["five_hour", "seven_day"]);
  });

  it("lets the top-level update override the same unified window", () => {
    const info = {
      status: "allowed" as const,
      rateLimitType: "five_hour" as const,
      utilization: 0.75,
      resetsAt: 1_900_000_010,
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: 1_900_000_000 },
        seven_day: { utilization: 0.5, resetsAt: 1_900_000_001 },
      },
    };
    expect(
      claudeRateLimitEventToUpdate(info, noNames)?.windows.map(({ id, usedPercent }) => [
        id,
        usedPercent,
      ]),
    ).toEqual([
      ["five_hour", 75],
      ["seven_day", 50],
    ]);
    expect(claudeRateLimitEventToUpdate(info, noNames)?.windows[0]?.resetsAt).toBe(
      "2030-03-17T17:46:50.000Z",
    );
  });

  it("ignores malformed and unknown unified windows", () => {
    const info = {
      status: "allowed" as const,
      unifiedWindows: {
        five_hour: { utilization: NaN },
        seven_day: { utilization: -1 },
        unknown: { utilization: 1 },
        constructor: { utilization: 1 },
        toString: { utilization: 1 },
        seven_day_overage_included: null,
      },
    };
    expect(claudeRateLimitEventToUpdate(info, noNames)).toBeUndefined();
  });

  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });
});
