import type { ScheduledTaskSchedule } from "@t3tools/contracts";

type FixedTimeSchedule = Extract<ScheduledTaskSchedule, { readonly type: "fixed_time" }>;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
export const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
export const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
/** Shown when saving days of the month or chosen months to a server without `scheduledTaskMonthDays`. */
export const MONTH_DAYS_UNSUPPORTED =
  "This environment runs an older T3 Code that can't run tasks on days of the month or in chosen months. Update it, or choose days of the week.";
const SHORTEST_MONTH_LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Sorted unique values, or null when none or all are chosen: both mean no filter. */
function chosen(values: ReadonlyArray<number> | undefined, all: number): number[] | null {
  const unique = [...new Set(values ?? [])].sort((a, b) => a - b);
  return unique.length === 0 || unique.length >= all ? null : unique;
}

export function ordinal(day: number): string {
  const suffix =
    day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}

function joinList(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Runs of three or more consecutive values read as a range, such as "1st–5th". */
function rangeList(values: ReadonlyArray<number>, label: (value: number) => string): string {
  const runs: Array<{ start: number; end: number }> = [];
  for (const value of values) {
    const run = runs.at(-1);
    if (run && run.end === value - 1) run.end = value;
    else runs.push({ start: value, end: value });
  }
  return joinList(
    runs.flatMap(({ start, end }) =>
      end - start >= 2
        ? [`${label(start)}–${label(end)}`]
        : Array.from({ length: end - start + 1 }, (_, offset) => label(start + offset)),
    ),
  );
}

function weekdayPhrase(weekdays: ReadonlyArray<number>): string {
  const key = weekdays.join(",");
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  return joinList(
    WEEKDAY_ORDER.filter((day) => weekdays.includes(day)).map((day) => WEEKDAY_NAMES[day]),
  );
}

/**
 * One sentence for a fixed-time schedule, such as "At 09:00 on the 5th of Jan,
 * Apr, Jul and Oct". `time` lets a client show the time in its own format.
 */
export function describeFixedTimeSchedule(
  schedule: FixedTimeSchedule,
  time: string = schedule.timeOfDay,
): string {
  const weekdays = chosen(schedule.weekdays, 7);
  const monthDays = chosen(schedule.monthDays, 31);
  const months = chosen(schedule.months, 12);
  const monthList = months && rangeList(months, (month) => MONTH_NAMES[month - 1] ?? "");
  if (monthDays) {
    return `At ${time} on the ${rangeList(monthDays, ordinal)} of ${monthList ?? "every month"}`;
  }
  const inMonths = monthList ? ` in ${monthList}` : "";
  return weekdays
    ? `At ${time} on ${weekdayPhrase(weekdays)}${inMonths}`
    : `At ${time} every day${inMonths}`;
}

/**
 * Days past a month's end run on its last day. Returns a note saying so when a
 * chosen month is shorter than the latest chosen day, or null.
 */
export function describeMonthEndFallback(schedule: FixedTimeSchedule): string | null {
  const latest = chosen(schedule.monthDays, 31)?.at(-1);
  if (latest === undefined) return null;
  const months = chosen(schedule.months, 12) ?? MONTHS;
  const shortest = Math.min(...months.map((month) => SHORTEST_MONTH_LENGTH[month - 1] ?? 31));
  return latest > shortest
    ? `In months without a ${ordinal(latest)}, it runs on the last day.`
    : null;
}
