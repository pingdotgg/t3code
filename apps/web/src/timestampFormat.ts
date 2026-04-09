import { type TimestampFormat } from "@t3tools/contracts/settings";

export function getTimestampFormatOptions(
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

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  const cacheKey = `${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    undefined,
    getTimestampFormatOptions(timestampFormat, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, true).format(new Date(isoDate));
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, false).format(new Date(isoDate));
}

/**
 * Format a relative time string from an ISO date.
 * Returns `{ value: "20s", suffix: "ago" }` or `{ value: "just now", suffix: null }`
 * so callers can style the numeric portion independently.
 */
export function formatRelativeTime(isoDate: string): { value: string; suffix: string | null } {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 0) return { value: "just now", suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return { value: "just now", suffix: null };
  if (seconds < 60) return { value: `${seconds}s`, suffix: "ago" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}m`, suffix: "ago" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}h`, suffix: "ago" };
  const days = Math.floor(hours / 24);
  return { value: `${days}d`, suffix: "ago" };
}

export function formatRelativeTimeLabel(isoDate: string) {
  const relative = formatRelativeTime(isoDate);
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

/**
 * Relative elapsed duration since an ISO instant, without an "ago" suffix.
 * Useful for labels like "Connected for 3m".
 */
export function formatElapsedDurationLabel(isoDate: string, nowMs: number = Date.now()): string {
  const diffMs = nowMs - new Date(isoDate).getTime();
  if (diffMs <= 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Relative time until an ISO instant (e.g. expiry). Mirrors {@link formatRelativeTime} but for future times.
 */
export function formatRelativeTimeUntil(isoDate: string): { value: string; suffix: string | null } {
  const diffMs = new Date(isoDate).getTime() - Date.now();
  if (diffMs <= 0) return { value: "Expired", suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return { value: "Soon", suffix: null };
  if (seconds < 60) return { value: `${seconds}s`, suffix: "left" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}m`, suffix: "left" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}h`, suffix: "left" };
  const days = Math.floor(hours / 24);
  return { value: `${days}d`, suffix: "left" };
}

export function formatRelativeTimeUntilLabel(isoDate: string): string {
  const relative = formatRelativeTimeUntil(isoDate);
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

/**
 * Countdown for a future instant (e.g. link expiry): "Expires in 4m 12s", with second precision under one hour.
 * Pass `nowMs` when a parent tick drives re-renders so the diff matches that snapshot.
 */
export function formatExpiresInLabel(isoDate: string, nowMs: number = Date.now()): string {
  const diffMs = new Date(isoDate).getTime() - nowMs;
  if (diffMs <= 0) return "Expired";

  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 5) return "Expires in a moment";
  if (totalSeconds < 60) return `Expires in ${totalSeconds}s`;

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `Expires in ${minutes}m` : `Expires in ${minutes}m ${seconds}s`;
  }

  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3600);
    const rem = totalSeconds % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    const parts = [`${hours}h`];
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);
    return `Expires in ${parts.join(" ")}`;
  }

  const days = Math.floor(totalSeconds / 86_400);
  const remAfterDays = totalSeconds % 86_400;
  if (remAfterDays === 0) return `Expires in ${days}d`;
  const hours = Math.floor(remAfterDays / 3600);
  const rem = remAfterDays % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  const tail: string[] = [];
  if (hours > 0) tail.push(`${hours}h`);
  if (minutes > 0) tail.push(`${minutes}m`);
  if (seconds > 0) tail.push(`${seconds}s`);
  return tail.length > 0 ? `Expires in ${days}d ${tail.join(" ")}` : `Expires in ${days}d`;
}
