import type { DailyTotals } from "@t3tools/shared/usageMerge";

export const DAILY_USAGE_BUDGET = {
  claudeUsd: { warn: 500, approval: 1_000, pause: 2_000 },
  apiEquivalentUsd: { warn: 1_000, approval: 1_500, pause: 2_000 },
} as const;

export type UsageBudgetLevel = "warn" | "approval" | "pause";

export interface UsageBudgetAlert {
  readonly day: string;
  readonly level: UsageBudgetLevel;
  readonly kind: "claude" | "apiEquivalent";
  readonly valueUsd: number;
  readonly thresholdUsd: number;
}

const LEVELS = ["warn", "approval", "pause"] as const;
const LEVEL_RANK: Record<UsageBudgetLevel, number> = { warn: 0, approval: 1, pause: 2 };

function crossed(
  valueUsd: number,
  thresholds: Readonly<Record<UsageBudgetLevel, number>>,
): { readonly level: UsageBudgetLevel; readonly thresholdUsd: number } | null {
  let result: { readonly level: UsageBudgetLevel; readonly thresholdUsd: number } | null = null;
  for (const level of LEVELS) {
    if (valueUsd >= thresholds[level]) result = { level, thresholdUsd: thresholds[level] };
  }
  return result;
}

/** Returns the strongest deterministic budget crossing on the requested day. */
export function evaluateDailyUsageBudget(
  daily: readonly DailyTotals[],
  requestedDay: string,
): UsageBudgetAlert | null {
  const alerts: UsageBudgetAlert[] = [];
  for (const period of daily) {
    if (period.day !== requestedDay) continue;
    const claudeUsd = period.byProvider.get("claude")?.costUsd ?? 0;
    const claude = crossed(claudeUsd, DAILY_USAGE_BUDGET.claudeUsd);
    if (claude !== null) {
      alerts.push({
        day: period.day,
        kind: "claude",
        valueUsd: claudeUsd,
        ...claude,
      });
    }

    const apiEquivalent = crossed(period.costUsd, DAILY_USAGE_BUDGET.apiEquivalentUsd);
    if (apiEquivalent !== null) {
      alerts.push({
        day: period.day,
        kind: "apiEquivalent",
        valueUsd: period.costUsd,
        ...apiEquivalent,
      });
    }
  }

  return (
    alerts.toSorted(
      (left, right) =>
        LEVEL_RANK[right.level] - LEVEL_RANK[left.level] ||
        right.valueUsd / right.thresholdUsd - left.valueUsd / left.thresholdUsd ||
        right.day.localeCompare(left.day),
    )[0] ?? null
  );
}
