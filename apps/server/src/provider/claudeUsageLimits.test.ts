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

  it("maps a valid spend-only budget and preserves its precise percentage", () => {
    const { limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: null,
          seven_day: null,
          extra_usage: {
            is_enabled: true,
            monthly_limit: 50_000,
            // Conflicting older data must not override the valid spend budget.
            used_credits: 30_000,
            utilization: 60,
          },
          ...({
            spend: {
              enabled: true,
              used: { amount_minor: 4_631, currency: " USD ", exponent: 2 },
              limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
              percent: 9,
            },
          } as object),
        },
      },
    });

    expect(limits).toMatchObject({
      checkedAt,
      windows: [{ id: "monthly_spend", kind: "monthly", label: "Monthly spend" }],
    });
    expect(limits.windows[0]?.usedPercent).toBeCloseTo(9.262);
  });

  it("ignores disabled spend and clamps extra usage percentages", () => {
    const { limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          ...({
            spend: {
              enabled: false,
              used: { amount_minor: 1, currency: "USD", exponent: 2 },
              limit: { amount_minor: 2, currency: "USD", exponent: 2 },
            },
          } as object),
          extra_usage: {
            is_enabled: true,
            monthly_limit: 100,
            used_credits: 250,
            utilization: 250,
          },
        },
      },
    });

    expect(limits.windows).toEqual([
      { id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: 100 },
    ]);
  });

  it("falls back to valid extra usage beside rolling windows", () => {
    const { limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12, resets_at: null },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 2_000,
            used_credits: 1_500,
            utilization: 75,
          },
          ...({ spend: { enabled: true, used: null, limit: null } } as object),
        },
      },
    });

    expect(limits.windows.map((window) => window.id)).toEqual(["five_hour", "monthly_spend"]);
    expect(limits.windows[1]).toEqual({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: 75,
    });
  });

  it("uses extra usage utilization when its amounts are unavailable", () => {
    const { limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          extra_usage: {
            is_enabled: true,
            monthly_limit: null,
            used_credits: null,
            utilization: 9.262,
          },
        },
      },
    });

    expect(limits.windows).toEqual([
      { id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: 9.262 },
    ]);
  });

  it.each([
    { used: -1, limit: 100, label: "negative amount" },
    { used: Number.NaN, limit: 100, label: "non-finite amount" },
    { used: 1, limit: 0, label: "zero limit" },
    { used: 1, limit: 100, label: "currency mismatch", limitCurrency: "EUR" },
    { used: 1, limit: 100, label: "exponent mismatch", limitExponent: 3 },
  ])(
    "ignores a malformed spend budget ($label)",
    ({ used, limit, limitCurrency, limitExponent }) => {
      expect(
        claudeUsageResponseToLimits({
          checkedAt,
          response: {
            rate_limits_available: true,
            rate_limits: {
              ...({
                spend: {
                  enabled: true,
                  used: { amount_minor: used, currency: "USD", exponent: 2 },
                  limit: {
                    amount_minor: limit,
                    currency: limitCurrency ?? "USD",
                    exponent: limitExponent ?? 2,
                  },
                },
              } as object),
            },
          },
        }).limits.windows,
      ).toEqual([]);
    },
  );
});

describe("claudeRateLimitEventToUpdate", () => {
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
