import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const weekdays = selection(schedule.weekdays);
  const monthDays = selection(schedule.monthDays);
  const months = selection(schedule.months);
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    const parts = DateTime.toParts(candidate);
    if (months !== null && !months.has(parts.month)) continue;
    if (weekdays !== null && !weekdays.has(parts.weekDay)) continue;
    if (monthDays !== null && !matchesMonthDay(monthDays, candidate)) continue;
    return candidate;
  }
  return null;
}

// One month filter can put the next run a year away, and a weekday filter can
// push it up to six days further.
const MAX_LOOKAHEAD_DAYS = 366 + 6;

function selection(values: ReadonlyArray<number> | undefined): ReadonlySet<number> | null {
  return values && values.length > 0 ? new Set(values) : null;
}

function matchesMonthDay(monthDays: ReadonlySet<number>, candidate: DateTime.DateTime): boolean {
  const { day } = DateTime.toParts(candidate);
  if (monthDays.has(day)) return true;
  // A day the month doesn't have runs on its last day, so 31 means "month end".
  const lastDay = DateTime.toParts(DateTime.endOf(candidate, "month")).day;
  return day === lastDay && [...monthDays].some((monthDay) => monthDay > lastDay);
}

/** Normalizes a selection where none and all mean the same thing: no filter. */
function selectionKey(values: ReadonlyArray<number> | undefined, all: number): string {
  const unique = [...new Set(values ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === all) return "all";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    selectionKey(a.weekdays, 7) === selectionKey(b.weekdays, 7) &&
    selectionKey(a.monthDays, 31) === selectionKey(b.monthDays, 31) &&
    selectionKey(a.months, 12) === selectionKey(b.months, 12)
  );
}

const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

export function isMissedFixedTimeRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "fixed_time") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_FIXED_TIME_GRACE_MS;
}
