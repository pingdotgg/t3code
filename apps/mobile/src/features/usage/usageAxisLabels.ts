import { formatDayShort, formatHourShort } from "@t3tools/shared/usageFormat";

import { DEFAULT_LOCALE } from "../../i18n/locales";

const HOUR_MS = 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = locale + "\0" + JSON.stringify(options);
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= 16) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}

/** Month name in the UI language; English keeps the shared formatter's output. */
export function usageAxisDayLabel(day: string, locale: string): string {
  if (locale === DEFAULT_LOCALE) return formatDayShort(day);
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    dayOfMonth === undefined ||
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(dayOfMonth)
  )
    return day;
  return dateTimeFormatter(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, dayOfMonth));
}

/** Hour in the UI language, with the zone name on a repeated fall-back hour like the shared one. */
export function usageAxisHourLabel(hourStart: string, locale: string, timeZone?: string): string {
  if (locale === DEFAULT_LOCALE) return formatHourShort(hourStart, timeZone);
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const zone = timeZone === undefined ? {} : { timeZone };
  const wallHourFormat = dateTimeFormatter("en-CA", {
    ...zone,
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
  return dateTimeFormatter(locale, {
    ...zone,
    hour: "numeric",
    ...(isRepeatedHour ? { timeZoneName: "short" as const } : {}),
  }).format(instant);
}
