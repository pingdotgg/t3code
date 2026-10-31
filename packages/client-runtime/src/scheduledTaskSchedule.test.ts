import { describe, expect, it } from "vite-plus/test";

import {
  MONTH_DAYS,
  describeFixedTimeSchedule,
  describeMonthEndFallback,
  ordinal,
} from "./scheduledTaskSchedule.ts";

const at = (fields: {
  readonly weekdays?: ReadonlyArray<number>;
  readonly monthDays?: ReadonlyArray<number>;
  readonly months?: ReadonlyArray<number>;
}) => ({ type: "fixed_time" as const, timeOfDay: "09:00", ...fields });

describe("describeFixedTimeSchedule", () => {
  it.each([
    [at({}), "At 09:00 every day"],
    [at({ weekdays: [0, 1, 2, 3, 4, 5, 6] }), "At 09:00 every day"],
    [at({ weekdays: [5, 1, 2, 3, 4] }), "At 09:00 on weekdays"],
    [at({ weekdays: [6, 0] }), "At 09:00 on weekends"],
    [at({ weekdays: [0, 1, 3] }), "At 09:00 on Mon, Wed and Sun"],
    [at({ monthDays: [6, 4] }), "At 09:00 on the 4th and 6th of every month"],
    [at({ monthDays: [5], months: [1, 4, 7, 10] }), "At 09:00 on the 5th of Jan, Apr, Jul and Oct"],
    [at({ monthDays: [1, 2, 3, 4, 5, 15] }), "At 09:00 on the 1st–5th and 15th of every month"],
    [at({ monthDays: MONTH_DAYS }), "At 09:00 every day"],
    [at({ months: [12, 1, 2] }), "At 09:00 every day in Jan, Feb and Dec"],
    [at({ months: [6, 7, 8] }), "At 09:00 every day in Jun–Aug"],
    [at({ weekdays: [1], months: [1] }), "At 09:00 on Mon in Jan"],
  ])("describes %o", (schedule, expected) => {
    expect(describeFixedTimeSchedule(schedule)).toBe(expected);
  });

  it("uses the client's own time format", () => {
    expect(describeFixedTimeSchedule(at({ monthDays: [1] }), "9:00 AM")).toBe(
      "At 9:00 AM on the 1st of every month",
    );
  });
});

describe("describeMonthEndFallback", () => {
  it("explains the last-day fallback only when a chosen month is too short", () => {
    expect(describeMonthEndFallback(at({ monthDays: [4, 6] }))).toBeNull();
    expect(describeMonthEndFallback(at({ weekdays: [1] }))).toBeNull();
    expect(describeMonthEndFallback(at({ monthDays: [31] }))).toBe(
      "In months without a 31st, it runs on the last day.",
    );
    expect(describeMonthEndFallback(at({ monthDays: [31], months: [1, 3] }))).toBeNull();
    expect(describeMonthEndFallback(at({ monthDays: [30], months: [4] }))).toBeNull();
    expect(describeMonthEndFallback(at({ monthDays: [29], months: [2] }))).toBe(
      "In months without a 29th, it runs on the last day.",
    );
  });
});

describe("ordinal", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [22, "22nd"],
    [23, "23rd"],
    [31, "31st"],
  ])("formats %i as %s", (day, expected) => {
    expect(ordinal(day)).toBe(expected);
  });
});
