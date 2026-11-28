import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";

export interface UsageChartRange {
  readonly start: string;
  readonly end: string;
}

export function usageRange(first: string, second: string): UsageChartRange {
  return first <= second ? { start: first, end: second } : { start: second, end: first };
}

export function usageRangeWindow(
  window: UsageSummaryInput,
  range: UsageChartRange,
): UsageSummaryInput {
  if (window.resolution !== "hour") {
    return { ...window, sinceDay: UsageDay.make(range.start), untilDay: UsageDay.make(range.end) };
  }

  // The chart selects whole buckets, while the API takes an exclusive end instant.
  const untilTime = new Date(Date.parse(range.end) + 3_600_000).toISOString();
  const localDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: window.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return {
    ...window,
    sinceTime: range.start,
    untilTime,
    sinceDay: UsageDay.make(localDay.format(new Date(range.start))),
    untilDay: UsageDay.make(localDay.format(new Date(untilTime))),
  };
}
