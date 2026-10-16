import type { UsageProviderKind } from "@t3tools/contracts";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { PROVIDER_ORDER } from "./usageProviders";

export type UsageChartMetric = "cost" | "tokens";

export interface UsageChartDay {
  readonly day: string;
  readonly values: readonly { readonly provider: UsageProviderKind; readonly value: number }[];
  readonly total: number;
}

export function buildChartDays(
  days: readonly string[],
  daily: readonly DailyTotals[],
  metric: UsageChartMetric,
): readonly UsageChartDay[] {
  const byDay = new Map(daily.map((totals) => [totals.day, totals]));
  return days.map((day) => {
    const totals = byDay.get(day);
    const values = PROVIDER_ORDER.map((provider) => {
      const entry = totals?.byProvider.get(provider);
      const value = entry === undefined ? 0 : metric === "cost" ? entry.costUsd : entry.totalTokens;
      return { provider, value };
    });
    return {
      day,
      values,
      total: values.reduce((sum, entry) => sum + entry.value, 0),
    };
  });
}
