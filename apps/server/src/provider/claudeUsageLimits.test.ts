import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
  makeClaudeScopedLimitNames,
  recordClaudeRateLimitEvent,
  recordClaudeUsageResponse,
  rememberClaudeListedWindows,
} from "./claudeUsageLimits.ts";

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

  const enterpriseResponse = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: null,
      seven_day: null,
      spend: {
        enabled: true,
        used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
        limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
        percent: 9,
      },
      extra_usage: {
        is_enabled: true,
        used_credits: 4_631,
        monthly_limit: 50_000,
        utilization: 9.261999999999999,
        currency: "USD",
        decimal_places: 2,
      },
    },
  };
  const monthlyWindow = {
    id: "monthly_spend",
    kind: "monthly",
    label: "Monthly spend",
    usedPercent: expect.closeTo(9.262, 10),
  };

  it("maps the captured Enterprise budget precisely, preferring spend beside rolling windows", () => {
    expect(claudeUsageResponseToLimits({ checkedAt, response: enterpriseResponse }).limits).toEqual(
      {
        checkedAt,
        windows: [monthlyWindow],
      },
    );
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        five_hour: { utilization: 12, resets_at: null },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: 30_000,
          utilization: 60,
        },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        windowDurationMins: 300,
      },
      monthlyWindow,
    ]);
  });

  it("falls back to enabled extra usage amounts or utilization when spend is unusable", () => {
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        spend: {
          ...enterpriseResponse.rate_limits.spend,
          enabled: false,
          used: { amount_minor: 30_000, currency: "USD", exponent: 2 },
        },
        extra_usage: { ...enterpriseResponse.rate_limits.extra_usage, utilization: 9 },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      monthlyWindow,
    ]);
    const utilizationOnly = {
      ...response,
      rate_limits: {
        ...response.rate_limits,
        spend: { enabled: true, used: null, limit: null, percent: 9 },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: null,
          monthly_limit: null,
        },
      },
    };
    expect(
      claudeUsageResponseToLimits({ checkedAt, response: utilizationOnly }).limits.windows,
    ).toEqual([monthlyWindow]);
  });

  it("omits disabled budgets and refuses invalid money without an enabled fallback", () => {
    const rateLimits = enterpriseResponse.rate_limits;
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...rateLimits,
        spend: { ...rateLimits.spend, enabled: false },
        extra_usage: { ...rateLimits.extra_usage, is_enabled: false },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, currency: "EUR" },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, amount_minor: 0 },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
  });
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
});

// Captured from a verified Ultra account on 2026-10-31: the headers list only the week, while
// `get_usage` still reports the 5-hour window at 0% with a running reset clock.
const ultraEvent = {
  status: "allowed",
  resetsAt: 1_793_563_200,
  rateLimitType: "seven_day",
  ...({
    unifiedWindows: {
      seven_day: { utilization: 0.56, resetsAt: 1_793_563_200, status: "allowed" },
    },
  } as object),
} as const;
const maxEvent = {
  status: "allowed",
  resetsAt: 1_793_463_600,
  rateLimitType: "five_hour",
  utilization: 0.05,
  ...({
    unifiedWindows: {
      five_hour: { utilization: 0.05, resetsAt: 1_793_463_600 },
      seven_day: { utilization: 0.47, resetsAt: 1_793_563_200 },
    },
  } as object),
} as const;
const ultraUsage = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 0, resets_at: "2026-10-31T16:19:59.509959+00:00" },
    seven_day: { utilization: 47, resets_at: "2026-11-01T19:59:59.509976+00:00" },
    ...({
      model_scoped: [
        { display_name: "Fable", utilization: 4, resets_at: "2026-11-01T19:59:59.510080+00:00" },
      ],
    } as object),
  },
};
const weeklyOnly = { overageIncluded: undefined, enforcedWindows: new Set(["seven_day"]) };

describe("rememberClaudeListedWindows", () => {
  it("keeps the windows the headers list and restores one they list again", () => {
    const weekly = rememberClaudeListedWindows(noNames, ultraEvent);
    expect([...weekly.enforcedWindows!]).toEqual(["seven_day"]);
    const restored = rememberClaudeListedWindows(weekly, maxEvent);
    expect([...restored.enforcedWindows!].toSorted()).toEqual(["five_hour", "seven_day"]);
  });

  it("counts the representative claim as listed when its window lapsed at a reset boundary", () => {
    // Captured 2026-10-17T22:00:01Z, one second after the 5-hour reset the claim still names.
    const lapsed = {
      status: "allowed",
      resetsAt: 1_792_274_400,
      rateLimitType: "five_hour",
      ...({
        unifiedWindows: { seven_day: { utilization: 0.66, resetsAt: 1_792_353_600 } },
      } as object),
    } as const;
    const names = rememberClaudeListedWindows(noNames, lapsed);
    expect([...names.enforcedWindows!].toSorted()).toEqual(["five_hour", "seven_day"]);
  });

  it("learns nothing from an event without a usable listing", () => {
    expect(rememberClaudeListedWindows(noNames, { status: "allowed" })).toBe(noNames);
    expect(
      rememberClaudeListedWindows(noNames, {
        status: "allowed",
        ...({ unifiedWindows: { five_hour: null, seven_day: { utilization: "56" } } } as object),
      }),
    ).toBe(noNames);
  });
});

describe("claudeRateLimitEventToUpdate with retired windows", () => {
  it("removes the session row even when the event names no top-level utilization", () => {
    expect(claudeRateLimitEventToUpdate(ultraEvent, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(ultraEvent, weeklyOnly)).toEqual({
      windows: [],
      removeWindowIds: ["five_hour"],
    });
  });

  it("does not let a stale 5-hour claim resurrect a retired row", () => {
    expect(claudeRateLimitEventToUpdate(maxEvent, weeklyOnly)).toEqual({
      windows: [],
      removeWindowIds: ["five_hour"],
    });
    expect(claudeRateLimitEventToUpdate(maxEvent, noNames)?.windows.map((w) => w.id)).toEqual([
      "five_hour",
    ]);
  });
});

describe("recordClaudeRateLimitEvent", () => {
  effectIt.effect(
    "drops the idle 5-hour window a verified Ultra account's get_usage keeps reporting",
    () =>
      Effect.gen(function* () {
        const names = yield* makeClaudeScopedLimitNames;
        const before = yield* recordClaudeUsageResponse(names, { checkedAt, response: ultraUsage });
        expect(before.windows.map((w) => w.id)).toEqual([
          "five_hour",
          "seven_day",
          "seven_day_fable",
        ]);
        expect(yield* recordClaudeRateLimitEvent(names, ultraEvent)).toEqual({
          windows: [],
          removeWindowIds: ["five_hour"],
        });
        const after = yield* recordClaudeUsageResponse(names, { checkedAt, response: ultraUsage });
        expect(after.windows.map((w) => w.id)).toEqual(["seven_day", "seven_day_fable"]);
        expect((yield* Ref.get(names)).overageIncluded).toBe("Fable");
      }),
  );
});
