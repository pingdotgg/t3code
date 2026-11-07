import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function weekdaySet(weekdays: ReadonlyArray<number> | undefined): ReadonlySet<number> | null {
  return weekdays !== undefined && weekdays.length > 0 ? new Set(weekdays) : null;
}

function isInsideWindow(
  instant: DateTime.DateTime,
  weekdays: ReadonlyArray<number> | undefined,
  start: { readonly hour: number; readonly minute: number },
  end: { readonly hour: number; readonly minute: number },
): boolean {
  const parts = DateTime.toParts(instant);
  const allowed = weekdaySet(weekdays);
  if (allowed !== null && !allowed.has(parts.weekDay)) return false;
  const time = ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 + parts.millisecond;
  const startMs = (start.hour * 60 + start.minute) * 60_000;
  const endMs = (end.hour * 60 + end.minute) * 60_000;
  return time >= startMs && time < endMs;
}

function windowStartAfter(
  candidate: DateTime.DateTime,
  from: DateTime.DateTime,
  start: { readonly hour: number; readonly minute: number },
  end: { readonly hour: number; readonly minute: number },
  weekdays: ReadonlyArray<number> | undefined,
): DateTime.DateTime | null {
  const fromMs = DateTime.toEpochMillis(from);
  const later = DateTime.mutate(candidate, () => {}, { disambiguation: "later" });
  const openings = [candidate, later];
  for (const opening of openings) {
    if (DateTime.toEpochMillis(opening) <= fromMs) continue;
    if (!isInsideWindow(opening, weekdays, start, end)) continue;
    return opening;
  }
  return null;
}

function nextWindowStart(
  from: DateTime.DateTime,
  start: { readonly hour: number; readonly minute: number },
  end: { readonly hour: number; readonly minute: number },
  weekdays: ReadonlyArray<number> | undefined,
): DateTime.DateTime | null {
  // One skipped weekday still leaves the same weekday two weeks out.
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: start.hour,
      minute: start.minute,
      second: 0,
      millisecond: 0,
    });
    const open = windowStartAfter(candidate, from, start, end, weekdays);
    if (open !== null) return open;
  }
  return null;
}

function nextLocalTime(
  from: DateTime.DateTime,
  time: { readonly hour: number; readonly minute: number },
  weekdays: ReadonlyArray<number> | undefined,
): DateTime.DateTime | null {
  const allowed = weekdaySet(weekdays);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (allowed !== null && !allowed.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "once") {
    const runAt = DateTime.make(schedule.runAt);
    return Option.isSome(runAt) &&
      DateTime.toEpochMillis(runAt.value) > DateTime.toEpochMillis(from)
      ? runAt.value
      : null;
  }
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    const candidate = DateTime.addDuration(
      from,
      Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS),
    );
    const window = schedule.window;
    if (window === undefined) return candidate;
    const start = parseTimeOfDay(window.start);
    const end = parseTimeOfDay(window.end);
    if (start === null || end === null) return null;
    if (isInsideWindow(candidate, window.weekdays, start, end)) return candidate;
    return nextWindowStart(from, start, end, window.weekdays);
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  return nextLocalTime(from, time, schedule.weekdays);
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

type IntervalWindow = NonNullable<Extract<ScheduledTaskSchedule, { type: "interval" }>["window"]>;

function sameWindow(a: IntervalWindow | undefined, b: IntervalWindow | undefined): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  const aStart = parseTimeOfDay(a.start);
  const bStart = parseTimeOfDay(b.start);
  const aEnd = parseTimeOfDay(a.end);
  const bEnd = parseTimeOfDay(b.end);
  return (
    aStart !== null &&
    bStart !== null &&
    aEnd !== null &&
    bEnd !== null &&
    aStart.hour === bStart.hour &&
    aStart.minute === bStart.minute &&
    aEnd.hour === bEnd.hour &&
    aEnd.minute === bEnd.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs && sameWindow(a.window, b.window);
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (a.type === "once") return b.type === "once" && Date.parse(a.runAt) === Date.parse(b.runAt);
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

export function isMissedScheduledRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type === "fixed_time") {
    return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_FIXED_TIME_GRACE_MS;
  }
  if (schedule.type !== "interval" || schedule.window === undefined) return false;
  const start = parseTimeOfDay(schedule.window.start);
  const end = parseTimeOfDay(schedule.window.end);
  if (start === null || end === null) return true;
  if (!isInsideWindow(now, schedule.window.weekdays, start, end)) return true;
  const occurrenceStart = DateTime.setParts(now, {
    hour: start.hour,
    minute: start.minute,
    second: 0,
    millisecond: 0,
  });
  return DateTime.toEpochMillis(dueAt) < DateTime.toEpochMillis(occurrenceStart);
}
