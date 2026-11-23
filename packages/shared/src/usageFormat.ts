// @effect-diagnostics globalDate:off -- Usage windows are calendar days in the viewer's zone, derived from wall-clock "now" via Intl.
import {
  UsageDay,
  type UsageResolution,
  type UsageSource,
  type UsageSummaryInput,
} from "@t3tools/contracts";

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

// Clients pass their UI locale; English (and the server, which passes none) keeps en-US.
function formatLocale(locale: string | undefined): string {
  return locale === undefined || locale === "en" ? "en-US" : locale;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(locale: string, currency: boolean): Intl.NumberFormat {
  if (locale === "en-US") return currency ? CURRENCY : INTEGER;
  const key = `${locale}:${currency}`;
  let formatter = numberFormatters.get(key);
  if (formatter === undefined) {
    formatter = currency
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : new Intl.NumberFormat(locale);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatMalformedUsageWarning(count: number): string {
  return `${count} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`;
}

export function usageSourceMessages(
  sources: readonly UsageSource[],
  malformedWarning: (count: number) => string = formatMalformedUsageWarning,
): readonly string[] {
  const messages = new Set<string>();
  const malformedBySource = new Map<string, number>();
  for (const source of sources) {
    if (
      source.status !== "partial" &&
      source.status !== "failed" &&
      source.fingerprint.provider !== "cursor" &&
      source.fingerprint.provider !== "vibe" &&
      !(source.status === "missing" && source.malformedRecords > 0)
    ) {
      continue;
    }
    let message = source.message;
    if (source.malformedRecords > 0) {
      const { hostId, provider, resolvedHomePath, volumeId } = source.fingerprint;
      const key = JSON.stringify([hostId, provider, resolvedHomePath, volumeId]);
      malformedBySource.set(
        key,
        Math.max(malformedBySource.get(key) ?? 0, source.malformedRecords),
      );
      // Servers also append this warning to message; retain any preceding read failure.
      const warning = formatMalformedUsageWarning(source.malformedRecords);
      if (message?.endsWith(warning)) message = message.slice(0, -warning.length).trim();
    }
    if (message) messages.add(message);
  }
  const malformedRecords = [...malformedBySource.values()].reduce(
    (total, count) => total + count,
    0,
  );
  if (malformedRecords > 0) messages.add(malformedWarning(malformedRecords));
  return [...messages];
}

export function formatUsd(value: number, locale?: string): string {
  return numberFormatter(formatLocale(locale), true).format(value);
}

export function formatCount(value: number, locale?: string): string {
  return numberFormatter(formatLocale(locale), false).format(Math.round(value));
}

const TOKEN_SUFFIXES = ["K", "M", "B", "T"] as const;

export function formatTokens(value: number): string {
  if (Math.abs(Math.round(value)) < 1e3) return INTEGER.format(Math.round(value));
  let scaled = value / 1e3;
  let unit = 0;
  // Choose the unit after rounding, so 999,999 reads 1M rather than 1000K.
  while (Math.abs(Number(trim(scaled))) >= 1e3 && unit < TOKEN_SUFFIXES.length - 1) {
    scaled /= 1e3;
    unit += 1;
  }
  return `${trim(scaled)}${TOKEN_SUFFIXES[unit]}`;
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  const percent = share * 100;
  const smallest = 10 ** -digits;
  if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`;
  return `${percent.toFixed(digits)}%`;
}

export function formatDayShort(day: string, locale?: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || dayOfMonth === undefined) return day;
  const intlLocale = formatLocale(locale);
  if (intlLocale !== "en-US") {
    const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
    return Number.isNaN(date.getTime())
      ? day
      : dateTimeFormatter(intlLocale, { timeZone: "UTC", month: "short", day: "numeric" }).format(
          date,
        );
  }
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

function hourOptions(hour12: boolean): Intl.DateTimeFormatOptions {
  return hour12 ? { hour: "numeric" } : { hour: "2-digit", hourCycle: "h23" };
}

function formatHour(formatter: Intl.DateTimeFormat, date: Date, hour12: boolean): string {
  if (hour12) return formatter.format(date);
  // Rolling buckets can start between whole hours, but their labels always name the hour.
  return formatter
    .formatToParts(date)
    .map((part) => (part.type === "hour" ? `${part.value}:00` : part.value))
    .join("");
}

/**
 * Repeated wall-clock hours during a fall-back transition include their short zone name so the
 * two distinct buckets remain distinguishable.
 */
export function formatHourShort(
  hourStart: string,
  timeZone?: string,
  hour12 = true,
  locale?: string,
): string {
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const options = timeZone === undefined ? {} : { timeZone };
  const intlLocale = formatLocale(locale);
  const hourFormat = dateTimeFormatter(intlLocale, {
    ...options,
    ...hourOptions(hour12),
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

  if (!isRepeatedHour) return formatHour(hourFormat, instant, hour12);
  const zonedHourFormat = dateTimeFormatter(intlLocale, {
    ...options,
    ...hourOptions(hour12),
    timeZoneName: "short",
  });
  return formatHour(zonedHourFormat, instant, hour12);
}

export function formatDateTimeShort(
  instant: string,
  timeZone?: string,
  hour12 = true,
  locale?: string,
): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const dateHourFormat = dateTimeFormatter(formatLocale(locale), {
    ...(timeZone === undefined ? {} : { timeZone }),
    month: "short",
    day: "numeric",
    ...hourOptions(hour12),
  });
  return formatHour(dateHourFormat, date, hour12);
}

export function formatRelativeHourShort(
  hourStart: string,
  relativeTo: string,
  timeZone?: string,
  hour12 = true,
  relativeDay: (hour: string, daysAgo: 0 | 1) => string = (hour, daysAgo) =>
    daysAgo === 0 ? `${hour} today` : `${hour} yesterday`,
  locale?: string,
): string {
  const instant = new Date(hourStart);
  const reference = new Date(relativeTo);
  if (Number.isNaN(instant.getTime()) || Number.isNaN(reference.getTime())) {
    return formatDateTimeShort(hourStart, timeZone, hour12, locale);
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
  const hour = formatHourShort(hourStart, timeZone, hour12, locale);

  if (calendarDaysAgo === 0 || calendarDaysAgo === 1) return relativeDay(hour, calendarDaysAgo);
  return formatDateTimeShort(hourStart, timeZone, hour12, locale);
}

export function makeWindow(
  days: number,
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
  // Use calendar arithmetic in UTC; fixed millisecond subtraction crosses DST days incorrectly.
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));
  return {
    sinceDay: UsageDay.make(start.toISOString().slice(0, 10)),
    untilDay: UsageDay.make(untilDay),
    timeZone,
    resolution,
  };
}
