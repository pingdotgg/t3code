import {
  ScheduledTaskError,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RRuleTemporal } from "rrule-temporal";

type CustomSchedule = Extract<ScheduledTaskSchedule, { type: "custom" }>;
type CustomInput = Extract<ScheduledTaskUpsertSchedule, { type: "custom" }>;
const isScheduledTaskError = Schema.is(ScheduledTaskError);

function invalid(message: string): never {
  throw new ScheduledTaskError({ message });
}

function zone(value: string): string {
  try {
    return DateTime.zoneToString(DateTime.zoneMakeNamedUnsafe(value));
  } catch {
    return invalid("Invalid time zone. Use an IANA name such as Europe/Berlin or UTC.");
  }
}

function parseStart(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (
    !match ||
    !Number.isFinite(Date.parse(value)) ||
    DateTime.formatIso(DateTime.makeUnsafe(`${match[1]}T00:00:00Z`)).slice(0, 10) !== match[1]
  ) {
    return invalid(
      "Invalid start date. Use an ISO 8601 date-time with seconds and an offset, such as 2026-10-26T09:00:00+01:00.",
    );
  }
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

function compactStart(startAt: string, timeZone: string): string {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(startAt, { timeZone }));
  const pad = (n: number, length = 2) => String(n).padStart(length, "0");
  return `${pad(parts.year, 4)}${pad(parts.month)}${pad(parts.day)}T${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
}

function ruleFor(schedule: Pick<CustomSchedule, "expression" | "startAt" | "timeZone">) {
  return new RRuleTemporal({
    rruleString: schedule.expression,
    tzid: schedule.timeZone,
    // Preserve the instant too: rebuilding a local DTSTART string would lose
    // an explicitly selected second occurrence of a fall-back wall time.
    dtstart: {
      timeZoneId: schedule.timeZone,
      toString: () => `${schedule.startAt}[${schedule.timeZone}]`,
    },
    strict: true,
    // Bound pathological or impossible rules without enumerating infinite sets.
    maxIterations: 10_000,
    maxCandidateEvaluations: 100_000,
    cache: false,
  });
}

// rrule-temporal validates syntax, WKST, UNTIL and field combinations,
// but silently drops unknown fields, repeated keys and out-of-range numbers
// (BYHOUR=25 just disappears), which would save a different rule than shown.
const ranges: Readonly<Record<string, readonly [min: number, max: number, nonZero?: boolean]>> = {
  INTERVAL: [1, 10_000],
  COUNT: [1, 10_000],
  BYSECOND: [0, 59],
  BYMINUTE: [0, 59],
  BYHOUR: [0, 23],
  BYMONTH: [1, 12],
  BYMONTHDAY: [-31, 31, true],
  BYYEARDAY: [-366, 366, true],
  BYWEEKNO: [-53, 53, true],
  BYSETPOS: [-366, 366, true],
};
// One BYSECOND value keeps runs at most once per minute, like the interval floor.
const singleValued = new Set(["INTERVAL", "COUNT", "BYSECOND"]);
const libraryValidated = new Set(["WKST", "UNTIL"]);

function validateRuleBody(body: string): string {
  const seen = new Set<string>();
  for (const part of body.split(";")) {
    const match = /^([A-Z]+)=([^;=]+)$/.exec(part);
    if (!match) return invalid("Invalid RRULE. Use semicolon-separated KEY=value fields.");
    const key = match[1]!;
    const value = match[2]!;
    if (seen.has(key)) return invalid(`Duplicate RRULE field: ${key}.`);
    seen.add(key);
    if (libraryValidated.has(key)) continue;
    if (key === "BYDAY") {
      // The library accepts out-of-range ordinals if an ended rule never iterates.
      if (
        value
          .split(",")
          .some(
            (day) =>
              !/^([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(day) ||
              Math.abs(Number(day.slice(0, -2))) > 53,
          )
      )
        return invalid(
          "Invalid BYDAY. Use weekdays such as MO or ordinals from -53 to 53, excluding zero.",
        );
      continue;
    }
    if (key === "FREQ") {
      if (!/^(YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY)$/.test(value))
        return invalid("Unsupported FREQ. Use MINUTELY through YEARLY; SECONDLY is unsupported.");
      continue;
    }
    const range = ranges[key];
    if (!range)
      return invalid(
        `Unsupported RRULE field: ${key}. Use one RFC 5545 rule without RDATE, EXDATE or extensions.`,
      );
    const [min, max, nonZero] = range;
    const values = value.split(",");
    const valid = values.every((item) => {
      const n = Number(item);
      return /^-?\d+$/.test(item) && n >= min && n <= max && !(nonZero && n === 0);
    });
    if (!valid || (singleValued.has(key) && values.length !== 1))
      return invalid(
        `Invalid ${key}. Use ${singleValued.has(key) ? "one value in " : ""}${min}–${max}${nonZero ? ", excluding zero" : ""}.`,
      );
  }
  return `RRULE:${body}`;
}

function evaluator(schedule: CustomSchedule): (after: number) => number | null {
  if (schedule.format === "cron") {
    const parsed = Cron.parse(schedule.expression, schedule.timeZone);
    if (Result.isFailure(parsed))
      return invalid("Invalid cron expression. Check the five fields and their ranges.");
    const start = DateTime.toEpochMillis(DateTime.makeUnsafe(schedule.startAt));
    return (after) =>
      Cron.next(parsed.success, DateTime.makeUnsafe(Math.max(after, start - 1))).getTime();
  }
  const rule = ruleFor(schedule);
  return (after) =>
    rule.next(DateTime.toDateUtc(DateTime.makeUnsafe(after)))?.epochMilliseconds ?? null;
}

export function customOccurrences(
  schedule: CustomSchedule,
  from: DateTime.DateTime,
  count: number,
  inclusive = false,
): string[] {
  const next = evaluator(schedule);
  const occurrences: string[] = [];
  let after = DateTime.toEpochMillis(from) - (inclusive ? 1 : 0);
  for (let index = 0; index < count; index += 1) {
    const at = next(after);
    if (at === null) break;
    if (!Number.isFinite(at) || at <= after)
      return invalid("Could not advance this recurrence. Check its start and date limits.");
    occurrences.push(DateTime.formatIso(DateTime.makeUnsafe(at)));
    after = at;
  }
  return occurrences;
}

export function normalizeCustomSchedule(
  input: CustomInput,
  now: DateTime.DateTime,
  previous?: ScheduledTaskSchedule,
): CustomSchedule {
  const existing = previous?.type === "custom" ? previous : undefined;
  const timeZone = zone(
    input.timeZone ?? existing?.timeZone ?? DateTime.zoneToString(DateTime.zoneMakeLocal()),
  );
  const defaultStart = DateTime.formatIso(now);
  const startAt = parseStart(input.startAt ?? existing?.startAt ?? defaultStart);
  const text = input.expression.trim();
  const isRule = /(?:^|[;:\s])FREQ\s*=|^RRULE:|^DTSTART/i.test(text);
  try {
    let schedule: CustomSchedule;
    if (!isRule) {
      const expression = text.split(/\s+/).join(" ").toUpperCase();
      if (expression.split(" ").length !== 5 || !/^[\dA-Z*,/\- ]+$/.test(expression))
        return invalid(
          "Use a standard five-field cron expression: minute hour day-of-month month weekday; or an RRULE containing FREQ.",
        );
      schedule = { type: "custom", format: "cron", expression, timeZone, startAt };
    } else {
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const starts = lines.filter((line) => /^DTSTART/i.test(line));
      const rules = lines.filter((line) => !/^DTSTART/i.test(line));
      if (starts.length > 1 || rules.length !== 1)
        return invalid(
          "Use one RRULE and at most one DTSTART line. Recurrence sets and calendar files are unsupported.",
        );
      const expression = validateRuleBody(rules[0]!.replace(/^RRULE:/i, "").toUpperCase());
      const embedded = starts[0];
      if (embedded) {
        const match = /^DTSTART(?:;TZID=([^:;\s]+))?:(\d{8}T\d{6})(Z)?$/i.exec(embedded);
        if (!match || (match[1] && match[3]))
          return invalid(
            "Invalid DTSTART. Use DTSTART:20261026T090000Z or DTSTART;TZID=Europe/Berlin:20261026T090000.",
          );
        const embeddedZone = match[3] ? "UTC" : match[1] ? zone(match[1]) : timeZone;
        const rule = new RRuleTemporal({
          rruleString: `${embedded}\n${expression}`,
          tzid: embeddedZone,
          strict: true,
        });
        const anchor = DateTime.formatIso(
          DateTime.makeUnsafe(rule.options().dtstart.epochMilliseconds),
        );
        if (compactStart(anchor, embeddedZone) !== match[2])
          return invalid(
            "Invalid DTSTART. Choose an existing local date and time (outside a DST gap).",
          );
        schedule = {
          type: "custom",
          format: "rrule",
          expression,
          timeZone: embeddedZone,
          startAt: anchor,
        };
      } else {
        schedule = {
          type: "custom",
          format: "rrule",
          expression,
          timeZone,
          startAt,
        };
      }
      // Let the library enforce RFC combinations after rejecting fields it
      // otherwise silently ignores or sanitizes, even for already-ended rules.
      ruleFor(schedule);
    }
    customOccurrences(schedule, now, 5, true);
    return schedule;
  } catch (cause) {
    if (isScheduledTaskError(cause)) throw cause;
    return invalid(
      isRule
        ? `Invalid RRULE or DTSTART: ${cause instanceof Error ? cause.message : String(cause)}`
        : "Invalid cron expression or no reachable occurrence. Check field ranges and calendar dates.",
    );
  }
}
