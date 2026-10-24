import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Without a zone, `from` keeps the environment's local zone it was read in. */
function inTimeZone(from: DateTime.DateTime, timeZone: string | undefined) {
  if (timeZone === undefined) return from;
  return Option.getOrNull(DateTime.setZoneNamed(from, timeZone));
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "interval") {
    // Persisted rows created before the one-minute floor remain readable, but
    // they must not retain their old high-frequency execution rate.
    // Intervals advance elapsed time, including across daylight-saving changes.
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const zoned = inTimeZone(from, schedule.timeZone);
  if (zoned === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  // A wall-clock time skipped by a daylight-saving jump runs that much later;
  // a repeated one runs at its first occurrence only.
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(zoned, { days: offset }), {
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
 * An omitted optional field keeps its stored value, so a client that predates
 * the field can re-save a task without clearing it. Null clears it.
 */
function kept<A>(value: A | null | undefined, stored: A | undefined): A | undefined {
  return value === undefined ? stored : (value ?? undefined);
}

export function timerScheduleToStore(
  input: Exclude<ScheduledTaskUpsertSchedule, { readonly type: "webhook" }>,
  stored: ScheduledTaskSchedule | undefined,
): ScheduledTaskSchedule {
  if (input.type === "interval") return input;
  const timeZone = kept(
    input.timeZone,
    stored?.type === "fixed_time" ? stored.timeZone : undefined,
  );
  return {
    type: "fixed_time",
    timeOfDay: input.timeOfDay,
    ...(input.weekdays === undefined ? {} : { weekdays: input.weekdays }),
    ...(timeZone === undefined ? {} : { timeZone }),
  };
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") return b.type === "webhook";
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
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays) &&
    a.timeZone === b.timeZone
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

function describeSchedule(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / MINUTE_MS;
    if (Number.isInteger(minutes)) {
      return `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
    }
    return `Every ${Math.round(schedule.everyMs / 1000)} seconds`;
  }

  const weekdayCount = schedule.weekdays?.length ?? 0;
  const days =
    weekdayCount === 0
      ? "day"
      : weekdayCount === 5 && schedule.weekdays?.every((day) => day >= 1 && day <= 5)
        ? "weekday"
        : "selected day";
  return `At ${schedule.timeOfDay} every ${days}`;
}
