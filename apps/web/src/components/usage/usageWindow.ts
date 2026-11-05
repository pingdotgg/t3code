/**
 * The span of time the Usage page shows, and the summary request for it.
 * Short spans are read hourly so the chart can show hours or six-hour
 * intervals; longer ones are read by day.
 */
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import {
  enumerateDays,
  enumerateHourStarts,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  makeWindow,
} from "@t3tools/shared/usageFormat";

import { autoBinMinutes, type BinMinutes } from "./usageExplorerModel";

export type UsagePeriodDays = 1 | 7 | 30 | 90;

export type UsageRange =
  | { readonly kind: "period"; readonly days: UsagePeriodDays }
  | { readonly kind: "days"; readonly sinceDay: string; readonly untilDay: string }
  | {
      readonly kind: "zoom";
      readonly sinceMs: number;
      readonly untilMs: number;
      /** Where Reset zoom goes back to. */
      readonly from: Exclude<UsageRange, { kind: "zoom" }>;
    };

const HOUR_MS = 60 * 60 * 1000;
/** The server reads hourly buckets for at most this long a span. */
const MAX_HOURLY_SPAN_MS = 14 * 24 * HOUR_MS;

function zoneOf(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function dayIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** The instant a local calendar day starts in `timeZone`. */
export function startOfDayMs(day: string, timeZone: string): number {
  return wallClockMs(day, 0, timeZone);
}

/** The instant the local clock in `timeZone` reads `hour`:00 on `day`. */
function wallClockMs(day: string, hour: number, timeZone: string): number {
  const wallAsUtc = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const offsetAt = (ms: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(ms))
        .map((part) => [part.type, part.value]),
    );
    const wall = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`,
    );
    return wall - ms;
  };
  // Two passes settle the offset on either side of a DST change.
  let guess = wallAsUtc - offsetAt(wallAsUtc);
  guess = wallAsUtc - offsetAt(guess);
  return guess;
}

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 24 * HOUR_MS).toISOString().slice(0, 10);

function hourlyWindow(sinceMs: number, untilMs: number, timeZone: string): UsageSummaryInput {
  return {
    sinceDay: UsageDay.make(dayIn(sinceMs, timeZone)),
    untilDay: UsageDay.make(dayIn(untilMs - 1, timeZone)),
    timeZone,
    resolution: "hour",
    sinceTime: new Date(sinceMs).toISOString(),
    untilTime: new Date(untilMs).toISOString(),
    groupByThread: true,
  };
}

/** The summary request for a range, always split by thread. */
export function windowFor(range: UsageRange, now = new Date()): UsageSummaryInput {
  const timeZone = zoneOf();
  // Minute-aligned, so repeated renders ask for the same window.
  const nowMs = Math.floor(now.getTime() / 60_000) * 60_000;
  switch (range.kind) {
    case "period": {
      if (range.days === 1) return { ...makeWindow(1, now, "hour"), groupByThread: true };
      if (range.days === 7) {
        const today = dayIn(nowMs, timeZone);
        return hourlyWindow(startOfDayMs(addDays(today, -6), timeZone), nowMs, timeZone);
      }
      return { ...makeWindow(range.days, now, "day"), groupByThread: true };
    }
    case "days": {
      const sinceMs = startOfDayMs(range.sinceDay, timeZone);
      const untilMs = Math.min(nowMs, startOfDayMs(addDays(range.untilDay, 1), timeZone));
      if (untilMs > sinceMs && untilMs - sinceMs <= MAX_HOURLY_SPAN_MS) {
        return hourlyWindow(sinceMs, untilMs, timeZone);
      }
      return {
        sinceDay: UsageDay.make(range.sinceDay),
        untilDay: UsageDay.make(range.untilDay),
        timeZone,
        resolution: "day",
        groupByThread: true,
      };
    }
    case "zoom": {
      const untilMs = Math.min(range.untilMs, nowMs);
      if (untilMs - range.sinceMs <= MAX_HOURLY_SPAN_MS) {
        return hourlyWindow(range.sinceMs, untilMs, timeZone);
      }
      return {
        sinceDay: UsageDay.make(dayIn(range.sinceMs, timeZone)),
        untilDay: UsageDay.make(dayIn(untilMs - 1, timeZone)),
        timeZone,
        resolution: "day",
        groupByThread: true,
      };
    }
  }
}

export interface WindowTimeline {
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly binMinutes: BinMinutes;
}

export function timelineFor(window: UsageSummaryInput): WindowTimeline {
  const days = enumerateDays(window.sinceDay, window.untilDay);
  if (window.resolution === "hour" && window.sinceTime && window.untilTime) {
    const hours = enumerateHourStarts(window.sinceTime, window.untilTime);
    return { days, hours, binMinutes: autoBinMinutes(hours.length) };
  }
  return { days, hours: [], binMinutes: 1440 };
}

const clock = (hour: number) => {
  const h = hour % 24;
  return h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`;
};

/** A chart interval, e.g. "Oct 1", "Oct 1, 6am–12pm" or "3 PM". */
export function formatBin(bin: string, timeZone: string): string {
  if (bin.length === 10) return formatDayShort(bin);
  if (bin.length === 13) {
    const hour = Number(bin.slice(11, 13));
    return `${formatDayShort(bin.slice(0, 10))}, ${clock(hour)}–${clock(hour + 6)}`;
  }
  return `${formatDayShort(dayIn(Date.parse(bin), timeZone))}, ${formatHourShort(bin, timeZone)}`;
}

/**
 * The first instant of a chart interval. Six-hour intervals are local clock
 * spans, so each edge is resolved on the clock: a DST change makes one of
 * them five or seven hours long.
 */
export function binStartMs(bin: string, timeZone: string): number {
  if (bin.length === 10) return startOfDayMs(bin, timeZone);
  if (bin.length === 13) return wallClockMs(bin.slice(0, 10), Number(bin.slice(11)), timeZone);
  return Date.parse(bin);
}

export function binEndMs(bin: string, binMinutes: BinMinutes, timeZone: string): number {
  if (bin.length === 10) return startOfDayMs(addDays(bin, 1), timeZone);
  if (bin.length === 13) {
    const next = Number(bin.slice(11)) + 6;
    return next >= 24
      ? startOfDayMs(addDays(bin.slice(0, 10), 1), timeZone)
      : wallClockMs(bin.slice(0, 10), next, timeZone);
  }
  return Date.parse(bin) + binMinutes * 60_000;
}

/** "Sep 26 to Oct 2", or exact times for a span inside a day or two. */
export function formatWindow(window: UsageSummaryInput): string {
  if (window.resolution === "hour" && window.sinceTime && window.untilTime) {
    const spanMs = Date.parse(window.untilTime) - Date.parse(window.sinceTime);
    if (spanMs <= 2 * 24 * HOUR_MS) {
      return `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`;
    }
  }
  return window.sinceDay === window.untilDay
    ? formatDayShort(window.sinceDay)
    : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
}

/** The same length of time just before, for the Change column. */
export function previousWindow(window: UsageSummaryInput): UsageSummaryInput {
  if (window.resolution === "hour" && window.sinceTime && window.untilTime) {
    const sinceMs = Date.parse(window.sinceTime);
    const span = Date.parse(window.untilTime) - sinceMs;
    return hourlyWindow(sinceMs - span, sinceMs, window.timeZone);
  }
  const days = enumerateDays(window.sinceDay, window.untilDay).length;
  return {
    ...window,
    sinceDay: UsageDay.make(addDays(window.sinceDay, -days)),
    untilDay: UsageDay.make(addDays(window.sinceDay, -1)),
  };
}
