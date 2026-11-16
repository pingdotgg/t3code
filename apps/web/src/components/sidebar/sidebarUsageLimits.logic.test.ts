import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { sidebarUsageSummaries } from "./sidebarUsageLimits.logic";

const NOW = Date.parse("2026-11-16T00:00:00.000Z");

function account(driver: string, windows: ServerProviderUsageWindow[]): LimitAccount {
  return {
    key: `${driver}:me`,
    driver: ProviderDriverKind.make(driver),
    displayName: null,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: "2026-11-16T00:00:00.000Z", windows },
  };
}

function window(
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
): ServerProviderUsageWindow {
  return { id, kind, label: id, usedPercent };
}

describe("sidebarUsageSummaries", () => {
  it("headlines the tightest account-wide window and ignores scoped or other providers", () => {
    const pools = collectLimitPools(
      [
        account("claudeAgent", [
          window("five_hour", "session", 30),
          window("seven_day", "weekly", 55),
          window("seven_day_scoped_opus", "weekly", 98),
          window("monthly_spend", "monthly", 99),
        ]),
        account("codex", [window("primary", "session", 10), window("secondary", "weekly", 5)]),
        account("cursor", [window("totalPercentUsed", "monthly", 90)]),
      ],
      NOW,
    );

    expect(
      sidebarUsageSummaries(pools).map(({ driver, remainingPercent }) => ({
        driver,
        remainingPercent,
      })),
    ).toEqual([
      { driver: "codex", remainingPercent: 90 },
      { driver: "claudeAgent", remainingPercent: 45 },
    ]);
  });

  it("omits a provider that reports no account-wide window", () => {
    const pools = collectLimitPools(
      [account("claudeAgent", [window("monthly_spend", "monthly", 40)])],
      NOW,
    );

    expect(sidebarUsageSummaries(pools)).toEqual([]);
  });
});
