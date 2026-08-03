import { describe, expect, it } from "vite-plus/test";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  codexAccountPlanType,
  codexAuthQuotaFields,
  mapCodexAccountUsage,
  mapCodexRateLimits,
  normalizeEpochToIso,
} from "./codexAccountQuota.ts";

const CHECKED_AT = "2026-08-01T12:00:00.000Z";

function rateLimits(
  limits: Partial<CodexSchema.V2GetAccountRateLimitsResponse["rateLimits"]>,
): CodexSchema.V2GetAccountRateLimitsResponse {
  return { rateLimits: limits } as CodexSchema.V2GetAccountRateLimitsResponse;
}

describe("normalizeEpochToIso", () => {
  it("reads a plausible int64 stamp as unix seconds", () => {
    // 2026-08-01T12:00:00Z
    expect(normalizeEpochToIso(1_785_585_600)).toBe("2026-08-01T12:00:00.000Z");
  });

  it("reads an implausibly large stamp as milliseconds", () => {
    expect(normalizeEpochToIso(1_785_585_600_000)).toBe("2026-08-01T12:00:00.000Z");
  });

  it("returns undefined for absent, zero, negative and non-finite values", () => {
    expect(normalizeEpochToIso(undefined)).toBeUndefined();
    expect(normalizeEpochToIso(null)).toBeUndefined();
    expect(normalizeEpochToIso(0)).toBeUndefined();
    expect(normalizeEpochToIso(-1)).toBeUndefined();
    expect(normalizeEpochToIso(Number.NaN)).toBeUndefined();
  });
});

describe("mapCodexRateLimits", () => {
  it("returns undefined when the provider sent nothing renderable", () => {
    expect(mapCodexRateLimits(undefined, { checkedAt: CHECKED_AT })).toBeUndefined();
    expect(mapCodexRateLimits(rateLimits({}), { checkedAt: CHECKED_AT })).toBeUndefined();
    expect(
      mapCodexRateLimits(rateLimits({ limitName: "codex" }), { checkedAt: CHECKED_AT }),
    ).toBeUndefined();
  });

  it("maps both windows and stamps the read", () => {
    const mapped = mapCodexRateLimits(
      rateLimits({
        primary: { usedPercent: 42, resetsAt: 1_785_585_600, windowDurationMins: 300 },
        secondary: { usedPercent: 8 },
      }),
      { checkedAt: CHECKED_AT },
    );
    expect(mapped).toEqual({
      checkedAt: CHECKED_AT,
      primary: {
        usedPercent: 42,
        resetsAt: "2026-08-01T12:00:00.000Z",
        windowMinutes: 300,
      },
      secondary: { usedPercent: 8 },
    });
  });

  it("clamps a percentage rather than trusting it", () => {
    const mapped = mapCodexRateLimits(rateLimits({ primary: { usedPercent: 140 } }), {
      checkedAt: CHECKED_AT,
    });
    expect(mapped?.primary?.usedPercent).toBe(100);
  });

  it("never turns an absent window into a zeroed one", () => {
    const mapped = mapCodexRateLimits(
      rateLimits({ primary: null, secondary: { usedPercent: 3 } }),
      { checkedAt: CHECKED_AT },
    );
    expect(mapped?.primary).toBeUndefined();
    expect(mapped?.secondary?.usedPercent).toBe(3);
  });

  it("surfaces a reached limit with its reason", () => {
    const mapped = mapCodexRateLimits(
      rateLimits({ rateLimitReachedType: "rate_limit_reached", primary: { usedPercent: 100 } }),
      { checkedAt: CHECKED_AT },
    );
    expect(mapped?.limitReached).toBe(true);
    expect(mapped?.limitReason).toBe("rate_limit_reached");
  });

  it("treats a spend-control stop as a reached limit even with no reason", () => {
    const mapped = mapCodexRateLimits(rateLimits({ spendControlReached: true }), {
      checkedAt: CHECKED_AT,
    });
    expect(mapped?.limitReached).toBe(true);
    expect(mapped?.limitReason).toBeUndefined();
  });

  it("carries a credit balance but not an unlimited one", () => {
    expect(
      mapCodexRateLimits(
        rateLimits({ credits: { balance: "$12.40", hasCredits: true, unlimited: false } }),
        { checkedAt: CHECKED_AT },
      )?.creditBalance,
    ).toBe("$12.40");
    expect(
      mapCodexRateLimits(
        rateLimits({ credits: { balance: "$12.40", hasCredits: true, unlimited: true } }),
        { checkedAt: CHECKED_AT },
      ),
    ).toBeUndefined();
  });
});

describe("mapCodexAccountUsage", () => {
  it("returns undefined when nothing usable came back", () => {
    expect(mapCodexAccountUsage(undefined)).toBeUndefined();
    expect(
      mapCodexAccountUsage({
        summary: {},
      } as CodexSchema.V2GetAccountTokenUsageResponse),
    ).toBeUndefined();
  });

  it("sums the daily buckets and reports how many days they cover", () => {
    expect(
      mapCodexAccountUsage({
        summary: { lifetimeTokens: 5_000_000 },
        dailyUsageBuckets: [
          { startDate: "2026-07-30", tokens: 1_000 },
          { startDate: "2026-07-31", tokens: 2_500 },
        ],
      } as CodexSchema.V2GetAccountTokenUsageResponse),
    ).toEqual({
      lifetimeTokens: 5_000_000,
      recentTokens: 3_500,
      recentDays: 2,
    });
  });

  it("keeps a lifetime total even with no buckets", () => {
    expect(
      mapCodexAccountUsage({
        summary: { lifetimeTokens: 42 },
        dailyUsageBuckets: null,
      } as CodexSchema.V2GetAccountTokenUsageResponse),
    ).toEqual({ lifetimeTokens: 42 });
  });
});

describe("codexAccountPlanType", () => {
  it("reads the plan of a ChatGPT account only", () => {
    expect(codexAccountPlanType({ type: "chatgpt", email: "a@b.c", planType: "pro" })).toBe("pro");
    expect(codexAccountPlanType({ type: "apiKey" })).toBeUndefined();
    expect(codexAccountPlanType(null)).toBeUndefined();
  });
});

describe("codexAuthQuotaFields", () => {
  it("is empty for an unauthenticated probe", () => {
    expect(
      codexAuthQuotaFields({
        account: { requiresOpenaiAuth: true },
        rateLimits: undefined,
        usage: undefined,
        checkedAt: CHECKED_AT,
      }),
    ).toEqual({});
  });

  it("flags reauth only when an account is present alongside the flag", () => {
    expect(
      codexAuthQuotaFields({
        account: {
          requiresOpenaiAuth: true,
          account: { type: "chatgpt", email: "a@b.c", planType: "plus" },
        },
        rateLimits: undefined,
        usage: undefined,
        checkedAt: CHECKED_AT,
      }),
    ).toEqual({ planType: "plus", requiresReauth: true });
  });

  it("assembles plan, quota and usage into one auth patch", () => {
    const fields = codexAuthQuotaFields({
      account: {
        requiresOpenaiAuth: false,
        account: { type: "chatgpt", email: "a@b.c", planType: "pro" },
      },
      rateLimits: rateLimits({ primary: { usedPercent: 12 } }),
      usage: {
        summary: { lifetimeTokens: 10 },
      } as CodexSchema.V2GetAccountTokenUsageResponse,
      checkedAt: CHECKED_AT,
    });
    expect(fields.planType).toBe("pro");
    expect(fields.requiresReauth).toBeUndefined();
    expect(fields.rateLimits?.primary?.usedPercent).toBe(12);
    expect(fields.usage?.lifetimeTokens).toBe(10);
  });
});
