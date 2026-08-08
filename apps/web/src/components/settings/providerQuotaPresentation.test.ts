import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderAuth } from "@t3tools/contracts";

import {
  formatQuotaReset,
  formatTokenCount,
  hasProviderQuota,
  providerPlanLabel,
  providerQuotaMeters,
  providerQuotaNotice,
  providerQuotaTone,
  providerQuotaWindowLabel,
  providerUsageSummary,
} from "./providerQuotaPresentation.ts";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function auth(overrides: Partial<ServerProviderAuth> = {}): ServerProviderAuth {
  return { status: "authenticated", ...overrides };
}

describe("providerQuotaTone", () => {
  it("escalates at 80% and again at 100%", () => {
    expect(providerQuotaTone(0)).toBe("normal");
    expect(providerQuotaTone(79)).toBe("normal");
    expect(providerQuotaTone(80)).toBe("warning");
    expect(providerQuotaTone(99)).toBe("warning");
    expect(providerQuotaTone(100)).toBe("destructive");
    expect(providerQuotaTone(20, "warning")).toBe("warning");
    expect(providerQuotaTone(20, "normal")).toBe("normal");
  });
});

describe("providerQuotaWindowLabel", () => {
  it("names the window when the provider gave a duration", () => {
    expect(providerQuotaWindowLabel("primary", { usedPercent: 1, windowMinutes: 30 })).toBe(
      "30m limit",
    );
    expect(providerQuotaWindowLabel("primary", { usedPercent: 1, windowMinutes: 300 })).toBe(
      "5h limit",
    );
    expect(providerQuotaWindowLabel("secondary", { usedPercent: 1, windowMinutes: 10_080 })).toBe(
      "7d limit",
    );
  });

  it("never invents a duration", () => {
    expect(providerQuotaWindowLabel("primary", { usedPercent: 1 })).toBe("Current usage");
    expect(providerQuotaWindowLabel("secondary", { usedPercent: 1 })).toBe("Longer window");
  });
});

describe("formatQuotaReset", () => {
  it("counts down in the largest useful unit", () => {
    expect(formatQuotaReset("2026-08-01T12:30:00.000Z", NOW)).toBe("resets in 30m");
    expect(formatQuotaReset("2026-08-01T14:05:00.000Z", NOW)).toBe("resets in 2h 5m");
    expect(formatQuotaReset("2026-08-01T15:00:00.000Z", NOW)).toBe("resets in 3h");
    expect(formatQuotaReset("2026-08-04T12:00:00.000Z", NOW)).toBe("resets in 3d");
  });

  it("collapses an elapsed or malformed stamp", () => {
    expect(formatQuotaReset("2026-08-01T11:00:00.000Z", NOW)).toBe("resets now");
    expect(formatQuotaReset("not-a-date", NOW)).toBeUndefined();
    expect(formatQuotaReset(undefined, NOW)).toBeUndefined();
  });
});

describe("providerQuotaMeters", () => {
  it("is empty without rate limits", () => {
    expect(providerQuotaMeters(undefined, NOW)).toEqual([]);
    expect(providerQuotaMeters(auth(), NOW)).toEqual([]);
  });

  it("renders only the windows that arrived", () => {
    const meters = providerQuotaMeters(
      auth({
        rateLimits: {
          checkedAt: "2026-08-01T11:59:00.000Z",
          secondary: { usedPercent: 92, resetsAt: "2026-08-02T12:00:00.000Z" },
        },
      }),
      NOW,
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]).toEqual({
      id: "secondary",
      label: "Longer window",
      usedPercent: 92,
      tone: "warning",
      detail: "resets in 1d",
    });
  });

  it("keeps primary before secondary", () => {
    const meters = providerQuotaMeters(
      auth({
        rateLimits: {
          checkedAt: "2026-08-01T11:59:00.000Z",
          primary: { usedPercent: 10 },
          secondary: { usedPercent: 20 },
        },
      }),
      NOW,
    );
    expect(meters.map((meter) => meter.id)).toEqual(["primary", "secondary"]);
  });

  it("renders every provider-named Claude window without duplicating legacy slots", () => {
    const meters = providerQuotaMeters(
      auth({
        rateLimits: {
          checkedAt: "2026-08-01T11:59:00.000Z",
          primary: { usedPercent: 1 },
          windows: [
            { id: "session", label: "Session", usedPercent: 73 },
            {
              id: "weekly-scoped:fable",
              label: "Week · Fable",
              usedPercent: 24,
              severity: "normal",
              resetsAt: "2026-08-04T12:00:00.000Z",
            },
          ],
          extraUsage: { isEnabled: true, usedPercent: 8 },
        },
      }),
      NOW,
    );
    expect(meters).toEqual([
      { id: "session", label: "Session", usedPercent: 73, tone: "normal" },
      {
        id: "weekly-scoped:fable",
        label: "Week · Fable",
        usedPercent: 24,
        tone: "normal",
        detail: "resets in 3d",
      },
      { id: "extra-usage", label: "Extra usage", usedPercent: 8, tone: "normal" },
    ]);
  });
});

describe("providerPlanLabel", () => {
  it("humanises known tiers", () => {
    expect(providerPlanLabel(auth({ planType: "pro" }))).toBe("Pro");
    expect(providerPlanLabel(auth({ planType: "max" }))).toBe("Max");
    expect(providerPlanLabel(auth({ planType: "self_serve_business_usage_based" }))).toBe(
      "Business",
    );
  });

  it("passes an unknown open slug through rather than dropping it", () => {
    expect(providerPlanLabel(auth({ planType: "hypergalactic" }))).toBe("hypergalactic");
  });

  it("renders nothing for an absent or deliberately unknown plan", () => {
    expect(providerPlanLabel(auth())).toBeUndefined();
    expect(providerPlanLabel(auth({ planType: "unknown" }))).toBeUndefined();
  });
});

describe("formatTokenCount", () => {
  it("scales the unit", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(940)).toBe("940");
    expect(formatTokenCount(3_500)).toBe("3.5K");
    expect(formatTokenCount(5_000_000)).toBe("5.0M");
    expect(formatTokenCount(2_400_000_000)).toBe("2.4B");
  });
});

describe("providerUsageSummary", () => {
  it("says how many days the recent total covers", () => {
    expect(providerUsageSummary(auth({ usage: { recentTokens: 3_500, recentDays: 2 } }))).toBe(
      "3.5K tokens in the last 2 days",
    );
    expect(providerUsageSummary(auth({ usage: { recentTokens: 100, recentDays: 1 } }))).toBe(
      "100 tokens in the last day",
    );
  });

  it("joins recent and lifetime, and renders nothing when empty", () => {
    expect(
      providerUsageSummary(
        auth({ usage: { recentTokens: 3_500, recentDays: 2, lifetimeTokens: 5_000_000 } }),
      ),
    ).toBe("3.5K tokens in the last 2 days · 5.0M lifetime");
    expect(providerUsageSummary(auth({ usage: {} }))).toBeUndefined();
    expect(providerUsageSummary(auth())).toBeUndefined();
  });
});

describe("providerQuotaNotice", () => {
  it("prefers the reauth warning", () => {
    expect(
      providerQuotaNotice(
        auth({
          requiresReauth: true,
          rateLimits: { checkedAt: "2026-08-01T11:59:00.000Z", limitReached: true },
        }),
        NOW,
      ),
    ).toBe("This account needs to sign in again soon.");
  });

  it("adds a countdown to a reached limit when one is known", () => {
    expect(
      providerQuotaNotice(
        auth({
          rateLimits: {
            checkedAt: "2026-08-01T11:59:00.000Z",
            limitReached: true,
            primary: { usedPercent: 100, resetsAt: "2026-08-01T13:00:00.000Z" },
          },
        }),
        NOW,
      ),
    ).toBe("Usage limit reached — resets in 1h.");
    expect(
      providerQuotaNotice(
        auth({ rateLimits: { checkedAt: "2026-08-01T11:59:00.000Z", limitReached: true } }),
        NOW,
      ),
    ).toBe("Usage limit reached.");
  });

  it("says nothing when the account is fine", () => {
    expect(providerQuotaNotice(auth(), NOW)).toBeUndefined();
    expect(
      providerQuotaNotice(
        auth({
          rateLimits: { checkedAt: "2026-08-01T11:59:00.000Z", primary: { usedPercent: 10 } },
        }),
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("hasProviderQuota", () => {
  it("is false for an auth carrying nothing from increment 2", () => {
    expect(hasProviderQuota(auth({ label: "ChatGPT Pro Subscription" }), NOW)).toBe(false);
  });

  it("is true as soon as any piece arrives", () => {
    expect(
      hasProviderQuota(
        auth({
          rateLimits: { checkedAt: "2026-08-01T11:59:00.000Z", creditBalance: "$4.00" },
        }),
        NOW,
      ),
    ).toBe(true);
    expect(hasProviderQuota(auth({ usage: { lifetimeTokens: 10 } }), NOW)).toBe(true);
  });
});
