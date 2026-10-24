import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { normalizeCustomSchedule, customOccurrences } from "./CustomSchedule.ts";

const now = DateTime.makeZonedUnsafe("2026-01-01T00:00:00Z", { timeZone: "Europe/Berlin" });
const input = (expression: string) => ({
  type: "custom" as const,
  expression,
  timeZone: "Europe/Berlin",
});
const normalize = (expression: string) => normalizeCustomSchedule(input(expression), now);

describe("custom recurrence", () => {
  it("detects five-field cron and normalizes whitespace", () => {
    expect(normalize("  10  0,4,8-20 * * * ")).toMatchObject({
      type: "custom",
      format: "cron",
      expression: "10 0,4,8-20 * * *",
      timeZone: "Europe/Berlin",
    });
  });

  it.each(["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"])(
    "detects %s",
    (expression) => {
      expect(normalize(expression)).toMatchObject({
        format: "rrule",
        expression: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
      });
    },
  );

  it.each([
    ["* * * * * *", "five"],
    ["@daily", "five"],
    ["0 0 31 2 *", "occurrence"],
    ["FREQ=DAILY;FOO=1", "FOO"],
    ["FREQ=DAILY;BYHOUR=25", "BYHOUR"],
    ["FREQ=DAILY;FREQ=WEEKLY", "Duplicate"],
    ["FREQ=SECONDLY", "SECONDLY"],
    ["FREQ=DAILY;COUNT=0", "COUNT"],
    ["FREQ=DAILY;INTERVAL=0", "INTERVAL"],
    ["FREQ=DAILY;BYSECOND=0,30", "BYSECOND"],
    ["FREQ=DAILY;COUNT=2;UNTIL=20260102T000000Z", "COUNT"],
    ["FREQ=WEEKLY;BYDAY=XX", "BYDAY"],
    ["FREQ=MONTHLY;BYDAY=54MO;UNTIL=20251231T235959Z", "BYDAY"],
    ["FREQ=MONTHLY;BYDAY=-54MO;UNTIL=20260115T000000Z", "BYDAY"],
    ["FREQ=DAILY;UNTIL=20260102T000000", "UNTIL"],
    ["RRULE:BYHOUR=9", "FREQ"],
    ["DTSTART;VALUE=DATE:20260101\nRRULE:FREQ=DAILY", "DTSTART"],
    ["DTSTART:20260230T090000\nRRULE:FREQ=DAILY", "Invalid"],
    ["RRULE:FREQ=DAILY\nEXDATE:20260101T000000Z", "one"],
  ])("rejects unsupported or invalid input %s", (expression, message) => {
    expect(() => normalize(expression)).toThrow(message);
  });

  it("rejects invalid time zones", () => {
    expect(() =>
      normalizeCustomSchedule({ ...input("0 9 * * *"), timeZone: "Invalid/Zone" }, now),
    ).toThrow("time zone");
  });

  it("keeps a missing start and zone stable across edits and restarts", () => {
    const first = normalize("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    expect(first.startAt).toBe(DateTime.formatIso(now));
    const later = DateTime.add(now, { days: 10 });
    const edited = normalizeCustomSchedule(
      { type: "custom", expression: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU" },
      later,
      first,
    );
    expect(edited.startAt).toBe(first.startAt);
    expect(edited.timeZone).toBe(first.timeZone);
    const restarted = JSON.parse(JSON.stringify(first));
    expect(customOccurrences(restarted, later, 3)).toEqual(customOccurrences(first, later, 3));
  });

  it("keeps every-two-week rules aligned to DTSTART", () => {
    const schedule = normalize(
      "DTSTART;TZID=Europe/Berlin:20260105T090000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
    );
    expect(customOccurrences(schedule, now, 3)).toEqual([
      "2026-01-05T08:00:00.000Z",
      "2026-01-19T08:00:00.000Z",
      "2026-02-02T08:00:00.000Z",
    ]);
  });

  it("skips nonexistent month days rather than clamping them", () => {
    const schedule = normalize("DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31");
    expect(customOccurrences(schedule, now, 3)).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-05-31T09:00:00.000Z",
    ]);
  });

  it("skips DST gaps without consuming COUNT and uses the first fall-back occurrence", () => {
    const spring = normalize(
      "DTSTART;TZID=Europe/Berlin:20260328T023000\nRRULE:FREQ=DAILY;COUNT=3",
    );
    expect(customOccurrences(spring, now, 5)).toEqual([
      "2026-03-28T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ]);
    const fall = normalize("DTSTART;TZID=Europe/Berlin:20261024T023000\nRRULE:FREQ=DAILY;COUNT=3");
    expect(customOccurrences(fall, now, 5)).toEqual([
      "2026-10-24T00:30:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ]);
  });

  it("includes UNTIL and returns no occurrence after finite rules end", () => {
    const schedule = normalize("DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260102T090000Z");
    expect(customOccurrences(schedule, now, 5)).toEqual([
      "2026-01-01T09:00:00.000Z",
      "2026-01-02T09:00:00.000Z",
    ]);
    expect(customOccurrences(schedule, DateTime.makeUnsafe("2026-01-02T09:00:00Z"), 5)).toEqual([]);
    const count = normalize("DTSTART:20251201T090000Z\nRRULE:FREQ=DAILY;COUNT=2");
    expect(customOccurrences(count, now, 5)).toEqual([]);
  });

  it("evaluates cron in its saved zone across DST and month boundaries", () => {
    const schedule = normalize("0 9 1 * *");
    expect(customOccurrences(schedule, DateTime.makeUnsafe("2026-03-01T09:00:00Z"), 3)).toEqual([
      "2026-04-01T07:00:00.000Z",
      "2026-05-01T07:00:00.000Z",
      "2026-06-01T07:00:00.000Z",
    ]);
  });
});

it("preserves an explicitly selected second fall-back instant", () => {
  const schedule = normalizeCustomSchedule(
    { ...input("FREQ=DAILY;COUNT=2"), startAt: "2026-10-25T02:30:00+01:00" },
    now,
  );
  expect(customOccurrences(schedule, now, 3)).toEqual([
    "2026-10-25T01:30:00.000Z",
    "2026-10-26T01:30:00.000Z",
  ]);
});

it("accepts floating starts, UTC starts, named zones and last-weekday rules", () => {
  const floating = normalize("DTSTART:20260105T090000\nFREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
  expect(floating.timeZone).toBe("Europe/Berlin");
  expect(floating.startAt).toBe("2026-01-05T08:00:00.000Z");
  const monthly = normalize(
    "DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
  );
  expect(customOccurrences(monthly, now, 3)).toEqual([
    "2026-01-30T09:00:00.000Z",
    "2026-02-27T09:00:00.000Z",
    "2026-03-31T09:00:00.000Z",
  ]);
});

it.each(["2026-01-01", "2026-02-30T09:00:00Z", "2026-01-01T09:00:00", "not a date"])(
  "rejects ambiguous or invalid start dates: %s",
  (startAt) => {
    expect(() => normalizeCustomSchedule({ ...input("0 9 * * *"), startAt }, now)).toThrow(
      "start date",
    );
  },
);

it("follows effect/Cron DST gap and repeat behavior", () => {
  const schedule = normalize("30 2 * * *");
  expect(customOccurrences(schedule, DateTime.makeUnsafe("2026-03-28T02:00:00Z"), 2)).toEqual([
    "2026-03-29T01:30:00.000Z",
    "2026-03-30T00:30:00.000Z",
  ]);
  expect(customOccurrences(schedule, DateTime.makeUnsafe("2026-10-24T02:00:00Z"), 2)).toEqual([
    "2026-10-25T00:30:00.000Z",
    "2026-10-26T01:30:00.000Z",
  ]);
});
