import { describe, expect, it } from "@effect/vitest";

import type { AccountView } from "@t3tools/vibe-app-server/client";

import { accountViewToUsageLimits, MISTRAL_USAGE_URL } from "./usageLimits.ts";

const account = (budget: AccountView["budget"]): AccountView =>
  ({
    status: "ready",
    plan: { kind: "chat", name: "PRO", title: "Pro" },
    budget,
  }) as AccountView;

describe("accountViewToUsageLimits", () => {
  it("maps the monthly Vibe Code budget to a monthly window", () => {
    const limits = accountViewToUsageLimits(
      account({ usagePercentage: 42.5, resetAt: "2026-12-01T00:00:00Z", paygEnabled: false }),
      "2026-11-15T00:00:00.000Z",
    );
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toHaveLength(1);
    expect(limits.windows[0]).toMatchObject({
      id: "vibe-code-monthly",
      kind: "monthly",
      usedPercent: 42.5,
      resetsAt: "2026-12-01T00:00:00Z",
      // November has 30 days; the length lets the UI show pace.
      windowDurationMins: 30 * 24 * 60,
    });
  });

  it("clamps out-of-range percentages", () => {
    const limits = accountViewToUsageLimits(
      account({ usagePercentage: 250, resetAt: null, paygEnabled: true }),
      "2026-11-15T00:00:00.000Z",
    );
    expect(limits.windows[0]?.usedPercent).toBe(100);
    expect(limits.windows[0]?.windowDurationMins).toBeUndefined();
    expect(limits.windows[0]?.label).toContain("pay-as-you-go");
  });

  it("reports unsupported with a console link when no budget is exposed", () => {
    const limits = accountViewToUsageLimits(account(null), "2026-11-15T00:00:00.000Z");
    expect(limits.unavailable?.reason).toBe("unsupported");
    expect(limits.externalUsage?.url).toBe(MISTRAL_USAGE_URL);
    expect(limits.windows).toHaveLength(0);
  });
});
