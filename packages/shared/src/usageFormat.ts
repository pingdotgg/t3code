// @effect-diagnostics globalDate:off -- Usage windows are calendar days in the viewer's zone, derived from wall-clock "now" via Intl.
/**
 * Display formatting for the usage page.
 *
 * @module usageFormat
 */
import {
  UsageDay,
  type UsageProviderKind,
  type UsageResolution,
  type UsageSummaryInput,
} from "@t3tools/contracts";

import type { DailyTotals } from "./usageMerge.ts";

/**
 * Span the page can request: a count of days ending today, or everything.
 *
 * "All time" is sent as a fixed floor day rather than an open-ended window so
 * the request stays valid for every server version. The floor predates the
 * first release of every provider CLI, so nothing can fall before it.
 */
export type UsageWindowSpan = number | "all";
export const USAGE_ALL_TIME_SINCE_DAY = UsageDay.make("2020-01-01");

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

/**
 * Compacts a token count to three significant figures with a unit suffix, so
 * columns of numbers line up at a glance (`19.9B`, `76.7M`, `804K`).
 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

/** `2026-08-07` to `Aug 7`. */
export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || dayOfMonth === undefined) return day;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
}

/** Inclusive day list between two `YYYY-MM-DD` bounds. */
export function enumerateDays(sinceDay: string, untilDay: string): readonly string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;

  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Charts draw one point per day up to this many days. Beyond it the page rolls
 * days up into weeks: an all-time span can run for years, and a bar per day
 * would be narrower than a pixel on a phone.
 */
export const MAX_DAILY_CHART_DAYS = 120;

/** The Monday on or before `day`, as `YYYY-MM-DD`. */
export function weekStart(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed)) return day;
  const date = new Date(parsed);
  // getUTCDay: Sunday is 0, so Monday-based weeks shift Sunday to the end.
  const offset = (date.getUTCDay() + 6) % 7;
  return new Date(parsed - offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Rolls daily totals up into Monday-based weeks, keyed by week start day.
 *
 * Returns every week between the first and last of `days` so the chart still
 * zero-fills quiet stretches, exactly as it does per day for short windows.
 */
export function groupDailyByWeek(
  days: readonly string[],
  daily: readonly DailyTotals[],
): { readonly periods: readonly string[]; readonly totals: readonly DailyTotals[] } {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return { periods: [], totals: [] };

  const periods: string[] = [];
  const start = Date.parse(`${weekStart(first)}T00:00:00Z`);
  const end = Date.parse(`${weekStart(last)}T00:00:00Z`);
  for (let cursor = start; cursor <= end; cursor += 7 * DAY_MS) {
    periods.push(new Date(cursor).toISOString().slice(0, 10));
  }

  const byWeek = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  for (const totals of daily) {
    const week = weekStart(totals.day);
    const entry = byWeek.get(week) ?? { costUsd: 0, totalTokens: 0, byProvider: new Map() };
    entry.costUsd += totals.costUsd;
    entry.totalTokens += totals.totalTokens;
    for (const [provider, value] of totals.byProvider) {
      const current = entry.byProvider.get(provider) ?? { costUsd: 0, totalTokens: 0 };
      current.costUsd += value.costUsd;
      current.totalTokens += value.totalTokens;
      entry.byProvider.set(provider, current);
    }
    byWeek.set(week, entry);
  }

  return {
    periods,
    totals: [...byWeek.entries()]
      .map(([day, entry]) => ({ day, ...entry }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  if (options.timeZone === undefined) return new Intl.DateTimeFormat(locale, options);
  const key = JSON.stringify([locale, options]);
  let formatter = dateTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (dateTimeFormatters.size >= 16) dateTimeFormatters.clear();
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/** Every fixed-duration bucket start in an hourly rolling window. */
export function enumerateHourStarts(sinceTime: string, untilTime: string): readonly string[] {
  const starts: string[] = [];
  const start = Date.parse(sinceTime);
  const end = Date.parse(untilTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return starts;

  for (let cursor = start; cursor < end; cursor += HOUR_MS) {
    starts.push(new Date(cursor).toISOString());
  }
  return starts;
}

/**
 * A rolling bucket start rendered in the viewer's requested time zone.
 *
 * Repeated wall-clock hours during a fall-back transition include their short
 * zone name so the two distinct buckets remain distinguishable.
 */
export function formatHourShort(hourStart: string, timeZone?: string): string {
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const options = timeZone === undefined ? {} : { timeZone };
  const hourFormat = dateTimeFormatter("en-US", {
    ...options,
    hour: "numeric",
  });
  const wallHourFormat = dateTimeFormatter("en-CA", {
    ...options,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const wallHour = wallHourFormat.format(instant);
  const isRepeatedHour = [-HOUR_MS, HOUR_MS].some(
    (offset) => wallHourFormat.format(new Date(instant.getTime() + offset)) === wallHour,
  );

  if (!isRepeatedHour) return hourFormat.format(instant);
  return dateTimeFormatter("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: "numeric",
    timeZoneName: "short",
  }).format(instant);
}

/** `2026-08-11T14:37:00Z` to `Aug 11, 2 PM` in the requested zone. */
export function formatDateTimeShort(instant: string, timeZone?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return dateTimeFormatter("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    month: "short",
    day: "numeric",
    hour: "numeric",
  }).format(date);
}

/** An hourly tooltip label relative to the rolling window's end date. */
export function formatRelativeHourShort(
  hourStart: string,
  relativeTo: string,
  timeZone?: string,
): string {
  const instant = new Date(hourStart);
  const reference = new Date(relativeTo);
  if (Number.isNaN(instant.getTime()) || Number.isNaN(reference.getTime())) {
    return formatDateTimeShort(hourStart, timeZone);
  }

  const dayFormat = dateTimeFormatter("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const instantDay = Date.parse(`${dayFormat.format(instant)}T00:00:00Z`);
  const referenceDay = Date.parse(`${dayFormat.format(reference)}T00:00:00Z`);
  const calendarDaysAgo = Math.round((referenceDay - instantDay) / (24 * HOUR_MS));
  const hour = formatHourShort(hourStart, timeZone);

  if (calendarDaysAgo === 0) return `${hour} today`;
  if (calendarDaysAgo === 1) return `${hour} yesterday`;
  return formatDateTimeShort(hourStart, timeZone);
}

/**
 * The window the page requests, expressed in the viewer's own time zone so days
 * line up with what they actually experienced.
 */
export function makeWindow(
  span: UsageWindowSpan,
  now = new Date(),
  resolution: UsageResolution = "day",
): UsageSummaryInput {
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone should degrade to UTC rather than crash the page.
    timeZone = "UTC";
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const untilDay = format.format(now);
  if (resolution === "hour") {
    // Minute-aligned bounds keep labels readable while still representing an
    // exact rolling 24-hour duration. Fixed-duration buckets remain correct
    // across offset changes and daylight-saving transitions.
    const untilTimeMs = Math.floor(now.getTime() / 60_000) * 60_000;
    const sinceTimeMs = untilTimeMs - 24 * HOUR_MS;
    const sinceTime = new Date(sinceTimeMs);
    const untilTime = new Date(untilTimeMs);
    return {
      sinceDay: UsageDay.make(format.format(sinceTime)),
      untilDay: UsageDay.make(format.format(untilTime)),
      timeZone,
      resolution,
      sinceTime: sinceTime.toISOString(),
      untilTime: untilTime.toISOString(),
    };
  }
  if (span === "all") {
    return {
      sinceDay: USAGE_ALL_TIME_SINCE_DAY,
      untilDay: UsageDay.make(untilDay),
      timeZone,
      resolution,
    };
  }
  // Subtracting fixed milliseconds from `now` lands on the wrong calendar day
  // around a DST transition. The window start is pure calendar arithmetic on
  // the local end day, done in UTC where days are uniform.
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (span - 1)));
  return {
    sinceDay: UsageDay.make(start.toISOString().slice(0, 10)),
    untilDay: UsageDay.make(untilDay),
    timeZone,
    resolution,
  };
}

/**
 * The days a chart should draw for a window.
 *
 * An all-time window starts at a floor years before any transcript exists, so
 * it is clipped to the first day that saw activity; every other window draws
 * its full span, quiet days included.
 */
export function enumerateChartDays(
  window: Pick<UsageSummaryInput, "sinceDay" | "untilDay">,
  daily: readonly DailyTotals[],
): readonly string[] {
  const firstActive = daily[0]?.day;
  const sinceDay =
    window.sinceDay === USAGE_ALL_TIME_SINCE_DAY
      ? (firstActive ?? window.untilDay)
      : window.sinceDay;
  return enumerateDays(sinceDay, window.untilDay);
}
