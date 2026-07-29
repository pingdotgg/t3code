/**
 * Snooze preset resolution and wake-time formatting for the mobile thread
 * list. Mobile port of the web sidebar's preset math
 * (apps/web/src/components/Sidebar.snooze.ts) — same boundaries and label
 * conventions, ported off DOM `toLocale*` calls onto `Intl.DateTimeFormat`
 * to match this file's neighbors (ThreadFeed.tsx, threadActivity.ts). Pure
 * functions so the preset math (evening/tomorrow/next-week boundaries) is
 * unit-testable against a pinned Date.
 *
 * Presets deliberately skew short: agent-thread rhythms are hours (a CI run,
 * a teammate review, the next work session), not days.
 */

export type SnoozePresetId = "hour" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /**
   * Menu-row time column. Complements the label instead of repeating it:
   * "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM".
   */
  readonly whenLabel: string;
  /** ISO wake time. */
  readonly snoozedUntil: string;
}

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function timeOfDayLabel(date: Date): string {
  return TIME_FORMATTER.format(date);
}

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day is
// 23 hours, so 23:30 + 24h skips the whole next day).
function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function parseTimestampDate(isoDate: string): Date | null {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Presets for "snooze until", computed against local time. "This evening"
 * only appears while it is still meaningfully before evening; after that the
 * list starts at "Tomorrow".
 */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
  ];

  const evening = atHour(now, EVENING_HOUR);
  // Suppress the evening preset once it is within an hour (or past): it would
  // duplicate "In 1 hour" or point at the past.
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  // Next Monday 9:00 (a week out when today is Monday).
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${WEEKDAY_FORMATTER.format(nextWeek)} ${timeOfDayLabel(nextWeek)}`,
    snoozedUntil: nextWeek.toISOString(),
  });

  return presets;
}

/**
 * Compact "wakes in" label for snoozed rows: "2h", "18h", "3d". Minutes round
 * up so a snooze never reads "0m" while still hidden.
 */
export function snoozeWakeLabel(snoozedUntil: string, now: Date): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "now";
  const remainingMs = wake.getTime() - now.getTime();
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

/**
 * Human wake time for row hints and menus: "tomorrow 9:00 AM", "Mon 9:00 AM",
 * "5:30 PM" (today).
 */
export function snoozeWakeDescription(snoozedUntil: string, now: Date): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = timeOfDayLabel(wake);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  if (dayDelta < 7) return `${WEEKDAY_FORMATTER.format(wake)} ${time}`;
  return `${MONTH_DAY_FORMATTER.format(wake)}, ${time}`;
}
