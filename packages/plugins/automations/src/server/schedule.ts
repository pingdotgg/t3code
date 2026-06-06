import { CronExpressionParser } from "cron-parser";

import { AutomationPluginError } from "./errors.ts";

export function validateIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateFiveFieldCron(cron: string, timezone: string): void {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new AutomationPluginError({
      message: "Cron expressions must use five fields.",
    });
  }
  if (!validateIanaTimezone(timezone)) {
    throw new AutomationPluginError({
      message: `Invalid IANA timezone: ${timezone}.`,
    });
  }
  CronExpressionParser.parse(cron, {
    currentDate: "2026-01-01T00:00:00.000Z",
    tz: timezone,
  });
}

export function computeNextRunAt(input: {
  readonly cron: string;
  readonly timezone: string;
  readonly afterIso: string;
}): string {
  validateFiveFieldCron(input.cron, input.timezone);
  const nextRunAt = CronExpressionParser.parse(input.cron, {
    currentDate: input.afterIso,
    tz: input.timezone,
  })
    .next()
    .toDate()
    .toISOString();
  return nextRunAt;
}

export function floorIsoToMinute(iso: string): string {
  return `${iso.slice(0, 16)}:00.000Z`;
}

export function isMissedRun(input: { readonly nextRunAt: string; readonly nowIso: string }) {
  return input.nextRunAt < floorIsoToMinute(input.nowIso);
}
