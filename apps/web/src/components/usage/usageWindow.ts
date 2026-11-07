import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

export const ALL_TIME_WINDOW_DAYS = 0;
const ALL_TIME_SINCE_DAY = UsageDay.make("1970-01-01");

export function makeUsageWindow(days: number): UsageSummaryInput {
  const window = makeWindow(
    days === ALL_TIME_WINDOW_DAYS ? 30 : days,
    undefined,
    days === 1 ? "hour" : "day",
  );
  return days === ALL_TIME_WINDOW_DAYS ? { ...window, sinceDay: ALL_TIME_SINCE_DAY } : window;
}

export function trimUsageWindow(
  window: UsageSummaryInput,
  daily: readonly DailyTotals[],
): UsageSummaryInput {
  if (window.sinceDay !== ALL_TIME_SINCE_DAY) return window;
  // Merged daily totals are sorted, and include usage even when its price is unknown.
  const firstDay = daily[0]?.day;
  const fallbackStart = new Date(Date.parse(`${window.untilDay}T00:00:00Z`) - 29 * 86_400_000);
  return {
    ...window,
    sinceDay: UsageDay.make(firstDay ?? fallbackStart.toISOString().slice(0, 10)),
  };
}
