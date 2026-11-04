const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function formatScheduledTaskInterval(
  everyMs: number,
  window?: {
    readonly start: string;
    readonly end: string;
    readonly weekdays?: ReadonlyArray<number>;
  },
): string {
  const interval = formatInterval(everyMs);
  if (!window) return interval;
  const minutes = everyMs / MINUTE;
  const amount = everyMs % MINUTE === 0 && minutes >= 1 ? `Every ${minutes} min` : interval;
  return `${amount}, ${formatIntervalWindowDays(window.weekdays)} ${window.start}–${window.end}`;
}

function formatIntervalWindowDays(weekdays: ReadonlyArray<number> | undefined): string {
  const selected = new Set<number>();
  for (const day of weekdays ?? []) {
    if (day >= 0 && day <= 6) selected.add(day);
  }
  if (selected.size === 0 || selected.size === 7) return "every day";
  if (selected.size === 5 && [1, 2, 3, 4, 5].every((day) => selected.has(day))) return "Mon–Fri";
  return WEEKDAY_ORDER.filter((day) => selected.has(day))
    .map((day) => WEEKDAY_LABELS[day])
    .join(", ");
}

function formatInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return `Every ${unit}`;
    parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    remaining %= size;
  }
  return `Every ${parts.join(" ")}`;
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(nextRunAt: string, now: number): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return "Next run unavailable";
  if (remaining <= 0) return "Next run due";

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return "Next run in less than a minute";
    const unit = remaining < HOUR ? "minute" : "hour";
    const count = Math.round(remaining / (remaining < HOUR ? MINUTE : HOUR));
    return `Next run in ${count} ${unit}${count === 1 ? "" : "s"}`;
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return `Next run tomorrow at ${time}`;
  if (days <= 7) {
    return `Next run next ${next.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return `Next run ${date} at ${time}`;
}
