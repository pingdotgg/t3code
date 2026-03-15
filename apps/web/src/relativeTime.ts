const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
let relativeTimeFormatter: Intl.RelativeTimeFormat | null = null;
export type RelativeTimeStyle = "long" | "short";

function formatRelativeUnit(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  if (relativeTimeFormatter === null) {
    relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  }
  return relativeTimeFormatter.format(-value, unit);
}

function formatShortRelativeUnit(value: number, suffix: string): string {
  return `${value}${suffix} ago`;
}

export function formatRelativeTime(
  isoDate: string,
  nowMs = Date.now(),
  style: RelativeTimeStyle = "long",
): string {
  const targetMs = Date.parse(isoDate);
  if (Number.isNaN(targetMs)) {
    return "";
  }

  const diffMs = Math.max(0, nowMs - targetMs);
  const formatUnit = (value: number, unit: Intl.RelativeTimeFormatUnit, shortSuffix: string) =>
    style === "short"
      ? formatShortRelativeUnit(value, shortSuffix)
      : formatRelativeUnit(value, unit);

  if (diffMs < MINUTE_MS) {
    return "just now";
  }
  if (diffMs < HOUR_MS) {
    return formatUnit(Math.floor(diffMs / MINUTE_MS), "minute", "m");
  }
  if (diffMs < DAY_MS) {
    return formatUnit(Math.floor(diffMs / HOUR_MS), "hour", "h");
  }
  if (diffMs < WEEK_MS) {
    return formatUnit(Math.floor(diffMs / DAY_MS), "day", "d");
  }
  if (diffMs < MONTH_MS) {
    return formatUnit(Math.floor(diffMs / WEEK_MS), "week", "w");
  }
  if (diffMs < YEAR_MS) {
    return formatUnit(Math.floor(diffMs / MONTH_MS), "month", "mo");
  }
  return formatUnit(Math.floor(diffMs / YEAR_MS), "year", "y");
}
