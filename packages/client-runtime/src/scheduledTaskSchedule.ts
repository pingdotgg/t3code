import type { ScheduledTaskSchedule } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { formatConjunctionList } from "./listFormat.ts";

type FixedTimeSchedule = Extract<ScheduledTaskSchedule, { readonly type: "fixed_time" }>;

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
export const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
/** Shown when saving days of the month or chosen months to a server without `scheduledTaskMonthDays`. */
export const MONTH_DAYS_UNSUPPORTED = msg(
  "This environment runs an older T3 Code that can't run tasks on days of the month or in chosen months. Update it, or choose days of the week.",
);
const SHORTEST_MONTH_LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Sorted unique values, or null when none or all are chosen: both mean no filter. */
function chosen(values: ReadonlyArray<number> | undefined, all: number): number[] | null {
  const unique = [...new Set(values ?? [])].sort((a, b) => a - b);
  return unique.length === 0 || unique.length >= all ? null : unique;
}

/** Abbreviated month name, 1 = January. */
export function monthShortLabel(month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(
    Date.UTC(2024, month - 1, 1),
  );
}

function weekdayShortName(day: number, locale: string): string {
  // 2024-01-07 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    Date.UTC(2024, 0, 7 + day),
  );
}

export function ordinal(day: number, resolve: MFunctionType = mFallback): string {
  return resolve(
    msg("{day, selectordinal, one {{day}st} two {{day}nd} few {{day}rd} other {{day}th}}", {
      day,
      $context: "a day of the month, as in the 5th",
    }),
  );
}

/** Runs of three or more consecutive values read as a range, such as "1st–5th". */
function rangeList(
  values: ReadonlyArray<number>,
  label: (value: number) => string,
  locale: string,
  resolve: MFunctionType,
): string {
  const runs: Array<{ start: number; end: number }> = [];
  for (const value of values) {
    const run = runs.at(-1);
    if (run && run.end === value - 1) run.end = value;
    else runs.push({ start: value, end: value });
  }
  return formatConjunctionList(
    runs.flatMap(({ start, end }) =>
      end - start >= 2
        ? [`${label(start)}–${label(end)}`]
        : Array.from({ length: end - start + 1 }, (_, offset) => label(start + offset)),
    ),
    locale,
    resolve,
  );
}

/**
 * One sentence for a fixed-time schedule, such as "At 09:00 on the 5th of Jan,
 * Apr, Jul, and Oct". `time` lets a client show the time in its own format.
 */
export function describeFixedTimeSchedule(
  schedule: FixedTimeSchedule,
  time: string = schedule.timeOfDay,
  resolve: MFunctionType = mFallback,
  locale = "en",
): string {
  const weekdays = chosen(schedule.weekdays, 7);
  const monthDays = chosen(schedule.monthDays, 31);
  const chosenMonths = chosen(schedule.months, 12);
  const months =
    chosenMonths &&
    rangeList(chosenMonths, (month) => monthShortLabel(month, locale), locale, resolve);
  if (monthDays) {
    const days = rangeList(monthDays, (day) => ordinal(day, resolve), locale, resolve);
    return months
      ? resolve(msg("At {time} on the {days} of {months}", { time, days, months }))
      : resolve(msg("At {time} on the {days} of every month", { time, days }));
  }
  const weekdayKey = weekdays?.join(",");
  if (weekdayKey === "1,2,3,4,5") {
    return months
      ? resolve(msg("At {time} on weekdays in {months}", { time, months }))
      : resolve(msg("At {time} on weekdays", { time }));
  }
  if (weekdayKey === "0,6") {
    return months
      ? resolve(msg("At {time} on weekends in {months}", { time, months }))
      : resolve(msg("At {time} on weekends", { time }));
  }
  if (weekdays) {
    const days = formatConjunctionList(
      WEEKDAY_ORDER.filter((day) => weekdays.includes(day)).map((day) =>
        weekdayShortName(day, locale),
      ),
      locale,
      resolve,
    );
    return months
      ? resolve(msg("At {time} on {days} in {months}", { time, days, months }))
      : resolve(msg("At {time} on {days}", { time, days }));
  }
  return months
    ? resolve(msg("At {time} every day in {months}", { time, months }))
    : resolve(msg("At {time} every day", { time }));
}

/**
 * Days past a month's end run on its last day. Returns a note saying so when a
 * chosen month is shorter than the latest chosen day, or null.
 */
export function describeMonthEndFallback(
  schedule: FixedTimeSchedule,
  resolve: MFunctionType = mFallback,
): string | null {
  const latest = chosen(schedule.monthDays, 31)?.at(-1);
  if (latest === undefined) return null;
  const months = chosen(schedule.months, 12) ?? MONTHS;
  const shortest = Math.min(...months.map((month) => SHORTEST_MONTH_LENGTH[month - 1] ?? 31));
  return latest > shortest
    ? resolve(
        msg("In months without a {day}, it runs on the last day.", {
          day: ordinal(latest, resolve),
        }),
      )
    : null;
}
