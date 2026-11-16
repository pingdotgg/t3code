import type { ServerProvider } from "@t3tools/contracts";
import {
  displayLimitWindows,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";

// Model-scoped and spend windows bind only some work, so only these set the headline.
const HEADLINE_WINDOW_IDS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ["codex", new Set(["session", "weekly"])],
  ["claudeAgent", new Set(["five_hour", "seven_day"])],
];

export interface SidebarUsageSummary {
  readonly driver: ServerProvider["driver"];
  /** The tightest of the account-wide windows, which is what is usable right now. */
  readonly remainingPercent: number;
  readonly windows: readonly LimitPoolWindow[];
}

export function sidebarUsageSummaries(pools: readonly LimitPool[]): SidebarUsageSummary[] {
  return HEADLINE_WINDOW_IDS.flatMap(([driver, ids]) => {
    const pool = pools.find((candidate) => candidate.driver === driver);
    const headline = pool?.windows.filter((window) => ids.has(window.id)) ?? [];
    if (!pool || headline.length === 0) return [];
    return [
      {
        driver: pool.driver,
        remainingPercent: Math.min(...headline.map((window) => window.remainingPercent)),
        windows: displayLimitWindows(pool),
      },
    ];
  });
}
