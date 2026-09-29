import { type TimestampFormat } from "@t3tools/contracts/settings";

function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

/**
 * Pick the locale to format wall-clock times in, given the locale the host
 * reports. Hosts that report nothing fall back to `undefined`, which is the
 * runtime default and the right answer in a browser.
 *
 * A host reports a locale only when it knows better than the runtime does —
 * see `getSystemLocale` on the desktop bridge for why desktop does.
 */
export function resolveTimestampLocale(
  systemLocale: string | null | undefined,
): string | undefined {
  const tag = systemLocale?.trim();
  if (!tag) return undefined;

  try {
    // Every timestamp in the UI runs through this formatter, so a tag the host
    // could not normalize falls back rather than throwing. Throws on a
    // structurally invalid tag; a well-formed tag ICU has no data for resolves
    // here and is left to ICU's own fallback.
    Intl.DateTimeFormat.supportedLocalesOf([tag]);
    return tag;
  } catch {
    return undefined;
  }
}

function readHostSystemLocale(): string | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.getSystemLocale?.() ?? null;
}

const timestampLocale = resolveTimestampLocale(readHostSystemLocale());

/** Locale selected for the interface, falling back to the host locale. */
function currentTimestampLocale(): string | undefined {
  const interfaceLocale =
    typeof document === "undefined" ? undefined : document.documentElement.lang.trim();
  return interfaceLocale || timestampLocale;
}

export function getCurrentTimestampLocale(): string | undefined {
  return currentTimestampLocale();
}

const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;
type WeekdayIndex = (typeof WEEKDAY_INDEXES)[number];

type LocaleWithWeekInfo = Intl.Locale & {
  readonly weekInfo?: { readonly firstDay: number };
  getWeekInfo?: () => { readonly firstDay: number };
};

/**
 * First weekday of a locale as a `Date#getDay` index (0 is Sunday), or
 * `undefined` when the runtime has no week data, so callers keep their own
 * default. Without a locale it reads the runtime's.
 */
export function resolveWeekStartsOn(locale: string | undefined): WeekdayIndex | undefined {
  try {
    const resolved: LocaleWithWeekInfo = new Intl.Locale(
      locale ?? Intl.DateTimeFormat().resolvedOptions().locale,
    );
    // Week info counts Monday as 1 and Sunday as 7.
    const firstDay = resolved.getWeekInfo?.().firstDay ?? resolved.weekInfo?.firstDay;
    return firstDay === undefined ? undefined : WEEKDAY_INDEXES[firstDay % 7];
  } catch {
    return undefined;
  }
}

/** Week start for calendars, from the same locale timestamps are shown in. */
export const weekStartsOn = resolveWeekStartsOn(timestampLocale);

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const relativeDayFormatterCache = new Map<string, Intl.RelativeTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  const locale = currentTimestampLocale();
  const cacheKey = `${locale ?? "default"}:${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    locale,
    getTimestampFormatOptions(timestampFormat, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function parseTimestampDate(isoDate: string): Date | null {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = currentTimestampLocale();
  const cacheKey = `${locale ?? "default"}:${JSON.stringify(options)}`;
  let formatter = dateFormatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

function formatRelativeDay(dayOffset: -1 | 1, time: string, locale: string | undefined): string {
  const cacheKey = locale ?? "default";
  let formatter = relativeDayFormatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeDayFormatterCache.set(cacheKey, formatter);
  }
  const relativeDay = formatter.format(dayOffset, "day");
  return formatter.resolvedOptions().locale.startsWith("zh")
    ? `${relativeDay} ${time}`
    : `${relativeDay} at ${time}`;
}

/**
 * Long-form tooltip label in the active interface locale.
 */
export function formatChatTimestampTooltip(
  isoDate: string,
  timestampFormat: TimestampFormat,
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = formatShortTimestamp(isoDate, timestampFormat);
  const dateLabel = getDateFormatter({ dateStyle: "long" }).format(date);
  return `${time}, ${dateLabel}`;
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return getTimestampFormatter(timestampFormat, false).format(date);
}

/**
 * Chat timestamp that adds the date once the message is no longer from today:
 * today `12:34 PM`, yesterday `yesterday at 12:34 PM`, older with a localized
 * date and time, adding the year once the calendar year differs.
 * Boundaries are local calendar days, not 24-hour windows.
 */
export function formatDayAwareTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = getTimestampFormatter(timestampFormat, false).format(date);

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / 86_400_000);

  if (dayDiff <= 0) return time;
  const locale = currentTimestampLocale();
  if (dayDiff === 1) return formatRelativeDay(-1, time, locale);
  const dateLabel = getDateFormatter(
    date.getFullYear() === now.getFullYear()
      ? { month: "numeric", day: "numeric" }
      : { month: "numeric", day: "numeric", year: "numeric" },
  ).format(date);
  return `${dateLabel} ${time}`;
}

/**
 * The forward-looking counterpart of {@link formatDayAwareTimestamp} for an
 * instant that has not happened yet (a usage-limit reset), using localized
 * date and relative-day labels.
 */
export function formatUpcomingTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = getTimestampFormatter(timestampFormat, false).format(date);

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTargetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfTargetDay - startOfToday) / 86_400_000);

  if (dayDiff <= 0) return time;
  const locale = currentTimestampLocale();
  if (dayDiff === 1) return formatRelativeDay(1, time, locale);
  const dateLabel = getDateFormatter(
    date.getFullYear() === now.getFullYear()
      ? { month: "numeric", day: "numeric" }
      : { month: "numeric", day: "numeric", year: "numeric" },
  ).format(date);
  return `${dateLabel} ${time}`;
}

/**
 * Format a relative time string from an ISO date.
 * Returns `{ value: "20s", suffix: "ago" }` or `{ value: "just now", suffix: null }`
 * so callers can style the numeric portion independently.
 */
type RelativeTimeParts = { value: string; suffix: string | null };
export type RelativeTimeState =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "relative"; value: string; suffix: string | null };

export function formatRelativeTime(
  isoDate: string,
  locale = currentTimestampLocale(),
): RelativeTimeParts | null {
  const date = parseTimestampDate(isoDate);
  if (!date) return null;
  const diffMs = Date.now() - date.getTime();
  const isChinese = locale?.startsWith("zh") === true;
  const justNow = isChinese ? "刚刚" : "just now";
  if (diffMs < 0) return { value: justNow, suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { value: justNow, suffix: null };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return isChinese
      ? { value: `${minutes}分钟前`, suffix: null }
      : { value: `${minutes}m`, suffix: "ago" };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return isChinese
      ? { value: `${hours}小时前`, suffix: null }
      : { value: `${hours}h`, suffix: "ago" };
  }
  const days = Math.floor(hours / 24);
  return isChinese ? { value: `${days}天前`, suffix: null } : { value: `${days}d`, suffix: "ago" };
}

export function formatRelativeTimeLabel(isoDate: string, locale = currentTimestampLocale()) {
  const relative = formatRelativeTime(isoDate, locale);
  if (!relative) return "";
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

export function getRelativeTimeState(
  isoDate: string | null,
  locale = currentTimestampLocale(),
): RelativeTimeState {
  if (!isoDate) return { status: "missing" };
  const relative = formatRelativeTime(isoDate, locale);
  if (!relative) return { status: "invalid" };
  return { status: "relative", ...relative };
}

/**
 * Relative elapsed duration since an ISO instant, without an "ago" suffix.
 * Useful for labels like "Connected for 3m".
 */
export function formatElapsedDurationLabel(
  isoDate: string,
  nowMs: number = Date.now(),
  locale = currentTimestampLocale(),
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const diffMs = nowMs - date.getTime();
  if (diffMs <= 0) return locale?.startsWith("zh") ? "刚刚" : "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return locale?.startsWith("zh") ? "刚刚" : "just now";
  if (seconds < 60) return locale?.startsWith("zh") ? `${seconds}秒` : `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return locale?.startsWith("zh") ? `${minutes}分钟` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return locale?.startsWith("zh") ? `${hours}小时` : `${hours}h`;

  const days = Math.floor(hours / 24);
  return locale?.startsWith("zh") ? `${days}天` : `${days}d`;
}

/**
 * Countdown for a future instant (e.g. link expiry): "Expires in 4m 12s", with second precision under one hour.
 * Pass `nowMs` when a parent tick drives re-renders so the diff matches that snapshot.
 */
export function formatExpiresInLabel(
  isoDate: string,
  nowMs: number = Date.now(),
  locale = currentTimestampLocale(),
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const diffMs = date.getTime() - nowMs;
  const isChinese = locale?.startsWith("zh") === true;
  const expired = isChinese ? "已过期" : "Expired";
  const withExpiry = (duration: string) =>
    isChinese ? `将在 ${duration}后过期` : `Expires in ${duration}`;
  if (diffMs <= 0) return expired;

  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 5) return isChinese ? "即将过期" : "Expires in a moment";
  if (totalSeconds < 60) return withExpiry(isChinese ? `${totalSeconds}秒` : `${totalSeconds}s`);

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const duration = isChinese
      ? `${minutes}分钟${seconds === 0 ? "" : ` ${seconds}秒`}`
      : seconds === 0
        ? `${minutes}m`
        : `${minutes}m ${seconds}s`;
    return withExpiry(duration);
  }

  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3600);
    const rem = totalSeconds % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    const parts = isChinese ? [`${hours}小时`] : [`${hours}h`];
    if (minutes > 0) parts.push(isChinese ? `${minutes}分钟` : `${minutes}m`);
    if (seconds > 0) parts.push(isChinese ? `${seconds}秒` : `${seconds}s`);
    return withExpiry(parts.join(" "));
  }

  const days = Math.floor(totalSeconds / 86_400);
  const remAfterDays = totalSeconds % 86_400;
  if (remAfterDays === 0) return withExpiry(isChinese ? `${days}天` : `${days}d`);
  const hours = Math.floor(remAfterDays / 3600);
  const rem = remAfterDays % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  const tail: string[] = [];
  if (hours > 0) tail.push(isChinese ? `${hours}小时` : `${hours}h`);
  if (minutes > 0) tail.push(isChinese ? `${minutes}分钟` : `${minutes}m`);
  if (seconds > 0) tail.push(isChinese ? `${seconds}秒` : `${seconds}s`);
  const duration = `${isChinese ? `${days}天` : `${days}d`}${tail.length > 0 ? ` ${tail.join(" ")}` : ""}`;
  return withExpiry(duration);
}
