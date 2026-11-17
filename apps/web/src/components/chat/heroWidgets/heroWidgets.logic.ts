import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";

const HOUR_MS = 60 * 60 * 1000;

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * The server serves hourly buckets only for windows of 24h or less, so a week of hours is one
 * window per local day: midnight to midnight, with today ending at `now`. Oldest first.
 */
export function hourlyDayWindows(now: Date, days: number): ReadonlyArray<UsageSummaryInput> {
  const timeZone = localTimeZone();
  const format = dayFormat(timeZone);
  const untilMs = Math.floor(now.getTime() / 60_000) * 60_000;
  const today = startOfLocalDay(now);
  return Array.from({ length: days }, (_, index) => {
    const since = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - (days - 1 - index),
    );
    const nextMidnight = new Date(since.getFullYear(), since.getMonth(), since.getDate() + 1);
    const until = new Date(Math.min(untilMs, nextMidnight.getTime()));
    return {
      sinceDay: UsageDay.make(format.format(since)),
      untilDay: UsageDay.make(format.format(new Date(until.getTime() - 1))),
      timeZone,
      resolution: "hour",
      sinceTime: since.toISOString(),
      untilTime: until.toISOString(),
    };
  });
}

/** Day-resolution window from the first of `now`'s month through today. */
export function monthToDateWindow(now: Date): UsageSummaryInput {
  const timeZone = localTimeZone();
  const format = dayFormat(timeZone);
  return {
    sinceDay: UsageDay.make(format.format(new Date(now.getFullYear(), now.getMonth(), 1))),
    untilDay: UsageDay.make(format.format(now)),
    timeZone,
    resolution: "day",
  };
}

export interface PunchcardRow {
  readonly label: string;
  /** Tokens per local hour, 24 entries. */
  readonly hours: ReadonlyArray<number>;
}

export interface Punchcard {
  readonly rows: ReadonlyArray<PunchcardRow>;
  readonly max: number;
  readonly peak: { readonly label: string; readonly hour: number } | null;
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** Bins hourly buckets into one row per local day, oldest first, ending today. */
export function buildPunchcard(
  now: Date,
  days: number,
  hourly: ReadonlyArray<HourlyTotals>,
): Punchcard {
  const today = startOfLocalDay(now);
  const rowStarts = Array.from(
    { length: days },
    (_, index) =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - index)),
  );
  const rows = rowStarts.map(() => Array.from({ length: 24 }, () => 0));
  for (const bucket of hourly) {
    const start = new Date(bucket.hourStart);
    if (Number.isNaN(start.getTime())) continue;
    const day = startOfLocalDay(start).getTime();
    const rowIndex = rowStarts.findIndex((rowStart) => rowStart.getTime() === day);
    if (rowIndex < 0) continue;
    rows[rowIndex]![start.getHours()]! += bucket.totalTokens;
  }
  let max = 0;
  let peak: Punchcard["peak"] = null;
  rows.forEach((hours, rowIndex) =>
    hours.forEach((tokens, hour) => {
      if (tokens <= max) return;
      max = tokens;
      peak = { label: WEEKDAY.format(rowStarts[rowIndex]!), hour };
    }),
  );
  return {
    rows: rows.map((hours, index) => ({ label: WEEKDAY.format(rowStarts[index]!), hours })),
    max,
    peak,
  };
}

export interface SpendSeries {
  /** Cumulative cost at the end of each elapsed day of the month, starting with day 1. */
  readonly cumulative: ReadonlyArray<number>;
  readonly daysInMonth: number;
  readonly monthToDate: number;
  /** Linear projection of month-to-date spend to the end of the month. */
  readonly pace: number;
}

export function buildSpendSeries(now: Date, daily: ReadonlyArray<DailyTotals>): SpendSeries {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsedDays = now.getDate();
  const costByDay = new Map(daily.map((entry) => [entry.day, entry.costUsd]));
  const format = dayFormat(localTimeZone());
  const cumulative: number[] = [];
  let running = 0;
  for (let day = 1; day <= elapsedDays; day += 1) {
    running += costByDay.get(format.format(new Date(now.getFullYear(), now.getMonth(), day))) ?? 0;
    cumulative.push(running);
  }
  const startOfToday = startOfLocalDay(now).getTime();
  const elapsedFraction = elapsedDays - 1 + (now.getTime() - startOfToday) / (24 * HOUR_MS);
  const pace = elapsedFraction > 0 ? (running / elapsedFraction) * daysInMonth : running;
  return { cumulative, daysInMonth, monthToDate: running, pace };
}

export function formatHour(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

const WIDGET_GRID = {
  maxColumns: 3,
  maxRows: 2,
  minCardWidth: 300,
  minRowHeight: 196,
  maxRowHeight: 236,
  gap: 10,
} as const;

export interface WidgetGrid {
  readonly columns: number;
  readonly rows: number;
  readonly rowHeight: number;
}

/**
 * How many widgets fit without scrolling: up to 3 columns by 2 rows, each card at least
 * `minCardWidth` wide and `minRowHeight` tall. Returns null when not even one card fits.
 */
export function fitWidgetGrid(
  space: { readonly width: number; readonly height: number },
  widgetCount: number,
): WidgetGrid | null {
  const { gap } = WIDGET_GRID;
  const columns = Math.min(
    WIDGET_GRID.maxColumns,
    widgetCount,
    Math.floor((space.width + gap) / (WIDGET_GRID.minCardWidth + gap)),
  );
  const rowsThatFit = Math.floor((space.height + gap) / (WIDGET_GRID.minRowHeight + gap));
  const rows = Math.min(
    WIDGET_GRID.maxRows,
    rowsThatFit,
    Math.ceil(widgetCount / Math.max(1, columns)),
  );
  if (columns < 1 || rows < 1) return null;
  const rowHeight = Math.min(
    WIDGET_GRID.maxRowHeight,
    Math.floor((space.height - gap * (rows - 1)) / rows),
  );
  return { columns, rows, rowHeight };
}
