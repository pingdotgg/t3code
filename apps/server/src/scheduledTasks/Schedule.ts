import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60_000;

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function minutesOfDay(value: string): number | null {
  const time = parseTimeOfDay(value);
  return time === null ? null : time.hour * 60 + time.minute;
}

function atMidnight(date: DateTime.DateTime): DateTime.DateTime {
  return DateTime.setParts(date, { hour: 0, minute: 0, second: 0, millisecond: 0 });
}

function startOfNextDay(date: DateTime.DateTime): DateTime.DateTime {
  return atMidnight(DateTime.add(date, { days: 1 }));
}

/**
 * Next occurrence of an interval schedule that honours its optional weekday
 * mask and time window. Out-of-window candidates snap forward: before the
 * window opens today, the run moves to the window's opening time; past the
 * window (or on a disallowed day), it moves to the next allowed day — at
 * 00:00 when only weekdays restrict, at the window's opening time otherwise.
 * The loop is bounded because every hop either returns or advances a day;
 * 16 hops cover one allowed weekday plus a window lost to a DST gap.
 */
function nextRestrictedIntervalRun(
  schedule: Extract<ScheduledTaskSchedule, { type: "interval" }>,
  from: DateTime.DateTime,
  everyMs: number,
): DateTime.DateTime | null {
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  const windowStart = schedule.window ? minutesOfDay(schedule.window.start) : null;
  const windowEnd = schedule.window ? minutesOfDay(schedule.window.end) : null;
  // Elapsed-time arithmetic: a calendar add would re-resolve a repeated
  // fall-back hour to its first occurrence and step backwards.
  let candidate = DateTime.addDuration(from, everyMs);
  for (let hop = 0; hop < 16; hop += 1) {
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) {
      candidate = startOfNextDay(candidate);
      continue;
    }
    if (windowStart === null || windowEnd === null) return candidate;
    // Compare local minutes rather than instants so a DST gap or overlap
    // cannot stretch the window: the check stays in the zone's wall clock.
    const local = localMinutes(candidate);
    if (local >= windowEnd) {
      const repeated = repeatedWindowOpening(candidate, local, windowStart, windowEnd);
      if (repeated !== null) return repeated;
      candidate = startOfNextDay(candidate);
      continue;
    }
    if (local >= windowStart) return candidate;
    const wallClockOpening = DateTime.setParts(atMidnight(candidate), {
      hour: Math.floor(windowStart / 60),
      minute: windowStart % 60,
      second: 0,
      millisecond: 0,
    });
    // In a fall-back overlap the wall-clock opening resolves to its earlier
    // occurrence, which can precede the candidate; step forward on the
    // candidate's own offset to the repeated opening instead.
    const { second, millisecond } = DateTime.toParts(candidate);
    const opensAt = DateTime.isGreaterThan(wallClockOpening, candidate)
      ? wallClockOpening
      : DateTime.addDuration(
          candidate,
          (windowStart - local) * MINUTE_MS - second * 1000 - millisecond,
        );
    // A window opening inside a spring-forward gap does not exist that day.
    if (localMinutes(opensAt) === windowStart) return opensAt;
    candidate = startOfNextDay(candidate);
  }
  return null;
}

/**
 * A window overlapping a fall-back hour is entered again once the hour
 * repeats. Returns the earliest such re-entry later the same day: the
 * repeated opening, or the fall-back itself when the window began before
 * the repeated hour.
 */
function repeatedWindowOpening(
  candidate: DateTime.DateTime,
  local: number,
  windowStart: number,
  windowEnd: number,
): DateTime.DateTime | null {
  if (!DateTime.isZoned(candidate)) return null;
  const endOfDay = DateTime.subtractDuration(startOfNextDay(candidate), 1);
  if (!DateTime.isZoned(endOfDay)) return null;
  const offsetBefore = DateTime.zonedOffset(candidate);
  const fallBackMs = offsetBefore - DateTime.zonedOffset(endOfDay);
  if (fallBackMs <= 0) return null;
  const { second, millisecond } = DateTime.toParts(candidate);
  const opening = DateTime.addDuration(
    candidate,
    (windowStart - local) * MINUTE_MS + fallBackMs - second * 1000 - millisecond,
  );
  if (
    DateTime.isGreaterThan(opening, candidate) &&
    DateTime.isLessThan(opening, endOfDay) &&
    localMinutes(opening) === windowStart
  ) {
    return opening;
  }
  // The window began before the repeated hour: find the fall-back instant
  // (first instant on the later offset) and use it if it lands in the window.
  let before = DateTime.toEpochMillis(candidate);
  let after = DateTime.toEpochMillis(endOfDay);
  while (after - before > 1) {
    const middle = before + Math.floor((after - before) / 2);
    const probe = DateTime.addDuration(candidate, middle - DateTime.toEpochMillis(candidate));
    if (DateTime.isZoned(probe) && DateTime.zonedOffset(probe) === offsetBefore) before = middle;
    else after = middle;
  }
  const fallBack = DateTime.addDuration(candidate, after - DateTime.toEpochMillis(candidate));
  const wall = localMinutes(fallBack);
  return wall >= windowStart && wall < windowEnd ? fallBack : null;
}

function localMinutes(date: DateTime.DateTime): number {
  const parts = DateTime.toParts(date);
  return parts.hour * 60 + parts.minute;
}

/**
 * True when an interval run that came due is being dispatched outside its
 * weekday mask or time window, as after downtime or sleep. Such a run is
 * rescheduled to the next opening instead of firing late.
 */
export function isOutsideIntervalRestrictions(
  schedule: ScheduledTaskSchedule,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "interval") return false;
  if (
    schedule.weekdays !== undefined &&
    schedule.weekdays.length > 0 &&
    !schedule.weekdays.includes(DateTime.toParts(now).weekDay)
  ) {
    return true;
  }
  if (schedule.window === undefined) return false;
  const start = minutesOfDay(schedule.window.start);
  const end = minutesOfDay(schedule.window.end);
  if (start === null || end === null) return false;
  const local = localMinutes(now);
  return local < start || local >= end;
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "interval") {
    // Persisted rows created before the one-minute floor remain readable, but
    // they must not retain their old high-frequency execution rate.
    const everyMs = Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS);
    if (schedule.weekdays === undefined && schedule.window === undefined) {
      return DateTime.add(from, { milliseconds: everyMs });
    }
    return nextRestrictedIntervalRun(schedule, from, everyMs);
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

/**
 * Canonical form of a weekday mask, mirroring how `nextScheduledRunAt` reads
 * it: order and duplicates are irrelevant, and an empty/omitted mask means the
 * same as explicitly listing all seven days — daily.
 */
function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

/** Semantic equality for schedules: true iff both fire at the same times. */
export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    if (b.type !== "interval" || a.everyMs !== b.everyMs) return false;
    if (weekdayKey(a.weekdays) !== weekdayKey(b.weekdays)) return false;
    const aStart = a.window === undefined ? null : minutesOfDay(a.window.start);
    const aEnd = a.window === undefined ? null : minutesOfDay(a.window.end);
    const bStart = b.window === undefined ? null : minutesOfDay(b.window.start);
    const bEnd = b.window === undefined ? null : minutesOfDay(b.window.end);
    return aStart === bStart && aEnd === bEnd;
  }
  if (b.type !== "fixed_time") return false;
  // The contract accepts padded and unpadded hours ("9:00" and "09:00"), so
  // compare the parsed time — string equality would treat a format-only edit
  // as a schedule change and recompute the pending run.
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

/**
 * How late a fixed-time run may fire before it counts as missed. Covers poll
 * jitter and short sleeps, while a server booted hours after the slot skips
 * to the next occurrence instead of firing stale work at a random time.
 */
const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

/**
 * True when a due fixed-time run was missed by more than the grace window and
 * should be rescheduled to its next occurrence instead of firing now.
 * Interval schedules are never considered missed: an overdue interval task
 * catching up with a single run is the desired behaviour.
 */
export function isMissedFixedTimeRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "fixed_time") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_FIXED_TIME_GRACE_MS;
}
