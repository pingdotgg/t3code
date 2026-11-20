import type { ScheduledTask } from "@t3tools/contracts";
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const INTERVAL_UNITS = [
  [7 * DAY, msg("Every week"), msg("{count, plural, one {{count} week} other {{count} weeks}}")],
  [DAY, msg("Every day"), msg("{count, plural, one {{count} day} other {{count} days}}")],
  [HOUR, msg("Every hour"), msg("{count, plural, one {{count} hour} other {{count} hours}}")],
  [
    MINUTE,
    msg("Every minute"),
    msg("{count, plural, one {{count} minute} other {{count} minutes}}"),
  ],
  [
    1_000,
    msg("Every second"),
    msg("{count, plural, one {{count} second} other {{count} seconds}}"),
  ],
  [
    1,
    msg("Every millisecond"),
    msg("{count, plural, one {{count} millisecond} other {{count} milliseconds}}"),
  ],
] as const;

export function formatScheduledTaskInterval(everyMs: number, resolve: MessageResolver = m): string {
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, every, amount] of INTERVAL_UNITS) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return resolve(every);
    parts.push(resolve(amount, { count }));
    remaining %= size;
  }
  return resolve(msg("Every {duration}", { duration: parts.join(" ") }));
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

const WEEKDAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export function formatNextScheduledTaskRun(
  nextRunAt: string,
  now: number,
  resolve: MessageResolver = m,
): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return resolve(msg("Next run unavailable"));
  if (remaining <= 0) return resolve(msg("Next run due"));

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return resolve(msg("Next run in less than a minute"));
    const minutes = Math.round(remaining / MINUTE);
    if (minutes < 60) {
      return resolve(
        msg(
          "{count, plural, one {Next run in {count} minute} other {Next run in {count} minutes}}",
          { count: minutes },
        ),
      );
    }
    return resolve(
      msg("{count, plural, one {Next run in {count} hour} other {Next run in {count} hours}}", {
        count: Math.round(remaining / HOUR),
      }),
    );
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return resolve(msg("Next run tomorrow at {time}", { time }));
  if (days <= 7) {
    return resolve(
      msg(
        "{day, select, sunday {Next run next Sunday at {time}} monday {Next run next Monday at {time}} tuesday {Next run next Tuesday at {time}} wednesday {Next run next Wednesday at {time}} thursday {Next run next Thursday at {time}} friday {Next run next Friday at {time}} other {Next run next Saturday at {time}}}",
        { day: WEEKDAY_KEYS[next.getDay()] ?? "saturday", time },
      ),
    );
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return resolve(msg("Next run {date} at {time}", { date, time }));
}

export const SCHEDULE_DAYS = [1, 2, 3, 4, 5, 6, 0].map((index) => ({ index }));

// 2024-01-07 was a Sunday, so day index 0 to 6 maps onto Sunday to Saturday.
export function weekdayLabel(index: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    Date.UTC(2024, 0, 7 + index),
  );
}

export function describeSchedule(
  task: ScheduledTask,
  timeZone?: string,
  resolve: MessageResolver = m,
  locale?: string,
): string {
  if (task.schedule.type === "webhook") return resolve(msg("On webhook"));
  if (task.schedule.type === "once") {
    const runAt = new Date(task.schedule.runAt);
    return resolve(
      msg("Once, {date} at {time}", { date: formatRunAtDate(runAt), time: formatRunAtTime(runAt) }),
    );
  }
  if (task.schedule.type === "interval")
    return formatScheduledTaskInterval(task.schedule.everyMs, resolve);
  const days = task.schedule.weekdays?.length
    ? repeatLabel(task.schedule.weekdays, resolve, locale)
    : resolve(msg("Every day"));
  const zone = scheduleTimeZoneLabel(timeZone, task.nextRunAt);
  const time = formatScheduleTime(task.schedule.timeOfDay);
  return zone === undefined
    ? resolve(msg("{days} at {time}", { days, time }))
    : resolve(msg("{days} at {time} {zone}", { days, time, zone }));
}

export function formatScheduleTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatRunAtDate(value: Date): string {
  return value.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function formatRunAtTime(value: Date): string {
  return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function isWeekdays(weekdays: ReadonlyArray<number>): boolean {
  const days = new Set(weekdays);
  return days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day));
}

export function repeatLabel(
  weekdays: ReadonlyArray<number>,
  resolve: MessageResolver = m,
  locale?: string,
): string {
  const days = new Set(weekdays);
  if (days.size === 7) return resolve(msg("Every day"));
  if (isWeekdays(weekdays)) return resolve(msg("Weekdays"));
  return (
    SCHEDULE_DAYS.filter((day) => days.has(day.index))
      .map((day) => weekdayLabel(day.index, locale))
      .join(", ") || resolve(msg("Choose days"))
  );
}
