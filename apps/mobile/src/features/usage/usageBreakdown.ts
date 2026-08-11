import type { DailyTotals } from "@t3tools/shared/usageMerge";

export function getRecentUsageDays(daily: readonly DailyTotals[]): readonly DailyTotals[] {
  const recent: DailyTotals[] = [];
  for (let index = daily.length - 1; index >= 0 && recent.length < 8; index -= 1) {
    const entry = daily[index];
    if (entry) recent.push(entry);
  }
  return recent;
}
