import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";

export function getRecentUsageDays(daily: readonly DailyTotals[]): readonly DailyTotals[] {
  const recent: DailyTotals[] = [];
  for (let index = daily.length - 1; index >= 0 && recent.length < 8; index -= 1) {
    const entry = daily[index];
    if (entry) recent.push(entry);
  }
  return recent;
}

export function getHourlyUsagePeriods(
  hourStarts: readonly string[],
  hourly: readonly HourlyTotals[],
): readonly DailyTotals[] {
  const byHour = new Map(hourly.map((entry) => [entry.hourStart, entry]));
  return hourStarts.map((hourStart) => {
    const entry = byHour.get(hourStart);
    return {
      day: hourStart,
      costUsd: entry?.costUsd ?? 0,
      totalTokens: entry?.totalTokens ?? 0,
      byProvider: entry?.byProvider ?? new Map(),
    };
  });
}
