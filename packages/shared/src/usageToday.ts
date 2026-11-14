import { DateTime } from "effect";
import type { UsageBucket } from "@t3tools/contracts";

/**
 * Day key is the calendar date (YYYY-MM-DD) of `now` in `timeZone`.
 * Buckets carry the same YYYY-MM-DD day string, so matching is exact.
 */
export interface UsageTodaySummary {
  readonly todayCostUsd: number;
  readonly paceUsd: number;
  readonly deltaPercent: number | null;
  readonly dayKey: string;
}

function timeZoneDayKey(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function priorDayKey(dayKey: string, daysAgo: number): string {
  return DateTime.formatIsoDateUtc(
    DateTime.subtract(DateTime.makeUnsafe(`${dayKey}T00:00:00Z`), { days: daysAgo }),
  );
}

export function summarizeTodayUsage(
  buckets: readonly UsageBucket[],
  now: Date,
  timeZone: string,
): UsageTodaySummary | null {
  if (buckets.length === 0) return null;
  const dayKey = timeZoneDayKey(now, timeZone);
  const costByDay = new Map<string, number>();
  for (const bucket of buckets) {
    costByDay.set(bucket.day, (costByDay.get(bucket.day) ?? 0) + bucket.costUsd);
  }
  const hasToday = costByDay.has(dayKey);
  const todayCostUsd = costByDay.get(dayKey) ?? 0;
  const priorCosts: number[] = [];
  for (let offset = 1; offset <= 7; offset += 1) {
    const priorKey = priorDayKey(dayKey, offset);
    const priorCost = costByDay.get(priorKey);
    if (priorCost !== undefined) priorCosts.push(priorCost);
  }
  if (!hasToday && priorCosts.length === 0) return null;
  const priorTotal = priorCosts.reduce((sum, cost) => sum + cost, 0);
  const paceUsd = priorCosts.length === 0 ? todayCostUsd : priorTotal / priorCosts.length;
  const deltaPercent = paceUsd > 0 ? ((todayCostUsd - paceUsd) / paceUsd) * 100 : null;
  return { todayCostUsd, paceUsd, deltaPercent, dayKey };
}
