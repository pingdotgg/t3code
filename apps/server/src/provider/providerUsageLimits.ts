import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function codexWindowLabel(windowDurationMins: number | null | undefined): string {
  return windowDurationMins !== undefined &&
    windowDurationMins !== null &&
    windowDurationMins >= 7 * 24 * 60
    ? "Weekly"
    : "Session";
}

function mapCodexWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ServerProviderUsageWindow | undefined {
  if (!window) return undefined;
  return {
    label: codexWindowLabel(window.windowDurationMins),
    usedPercent: clampPercent(window.usedPercent),
    ...(window.windowDurationMins !== undefined && window.windowDurationMins !== null
      ? { windowDurationMins: Math.max(0, window.windowDurationMins) }
      : {}),
    ...(window.resetsAt !== undefined && window.resetsAt !== null
      ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt * 1000)) }
      : {}),
  };
}

export function usageLimitsFromCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const windows = [
    mapCodexWindow(response.rateLimits.primary),
    mapCodexWindow(response.rateLimits.secondary),
  ].filter((window): window is ServerProviderUsageWindow => window !== undefined);
  return windows.length > 0 ? { source: "codexAppServer", checkedAt, windows } : undefined;
}

function parseClaudeReset(input: {
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string | undefined;
  readonly meridiem: string;
  readonly timeZone: string;
  readonly checkedAt: string;
}): string | undefined {
  const month =
    MONTHS.indexOf(input.month.toLowerCase().slice(0, 3) as (typeof MONTHS)[number]) + 1;
  if (month === 0) return undefined;
  const checked = DateTime.make(input.checkedAt);
  if (Option.isNone(checked)) return undefined;
  const checkedInResetZone = DateTime.setZoneNamed(checked.value, input.timeZone);
  if (Option.isNone(checkedInResetZone)) return undefined;
  const checkedParts = DateTime.toParts(checkedInResetZone.value);
  const day = Number.parseInt(input.day, 10);
  let hour = Number.parseInt(input.hour, 10);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    day < 1 ||
    day > 31 ||
    hour < 1 ||
    hour > 12
  ) {
    return undefined;
  }
  if (hour === 12) hour = 0;
  if (input.meridiem.toLowerCase() === "pm") hour += 12;
  const year = checkedParts.month === 12 && month === 1 ? checkedParts.year + 1 : checkedParts.year;
  const localDateTime = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${input.minute ?? "00"}:00`;
  const reset = DateTime.makeZoned(localDateTime, {
    timeZone: input.timeZone,
    adjustForTimeZone: true,
  });
  return Option.isSome(reset) ? DateTime.formatIso(reset.value) : undefined;
}

export function parseClaudeUsageLimitsJson(
  output: string,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  let result: string;
  try {
    const decoded: unknown = JSON.parse(output);
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof (decoded as { result?: unknown }).result !== "string"
    ) {
      return undefined;
    }
    result = (decoded as { result: string }).result;
  } catch {
    return undefined;
  }

  const windows: ServerProviderUsageWindow[] = [];
  const pattern =
    /^Current (session|week(?: \([^)]+\))?):\s*(\d{1,3}(?:\.\d+)?)% used\s*[\u00b7-]\s*resets ([A-Za-z]{3,9}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/gim;
  for (const match of result.matchAll(pattern)) {
    const [, rawLabel, percent, month, day, hour, minute, meridiem, timeZone] = match;
    if (!rawLabel || !percent || !month || !day || !hour || !meridiem || !timeZone) continue;
    const usedPercent = Number.parseFloat(percent);
    if (!Number.isFinite(usedPercent)) continue;
    const isSession = rawLabel.toLowerCase() === "session";
    const suffix = rawLabel.match(/\(([^)]+)\)/)?.[1];
    const resetsAt = parseClaudeReset({
      month,
      day,
      hour,
      minute,
      meridiem,
      timeZone,
      checkedAt,
    });
    windows.push({
      label: isSession ? "Session" : suffix ? `Weekly (${suffix})` : "Weekly",
      usedPercent: clampPercent(usedPercent),
      windowDurationMins: isSession ? 5 * 60 : 7 * 24 * 60,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  return windows.length > 0 ? { source: "claudePrint", checkedAt, windows } : undefined;
}
