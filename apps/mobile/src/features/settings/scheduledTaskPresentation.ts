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
