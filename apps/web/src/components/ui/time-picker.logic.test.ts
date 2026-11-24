import { describe, expect, it } from "vite-plus/test";

import {
  applyHourDigit,
  applyMinuteDigit,
  buildMinuteOptions,
  formatTimeValue,
  parseTimeValue,
  stepHour,
  stepMinute,
  to12Hour,
  to24Hour,
} from "./time-picker.logic";

describe("time-picker.logic", () => {
  it("parses and formats HH:mm values", () => {
    expect(parseTimeValue("00:00")).toEqual({ hours: 0, minutes: 0 });
    expect(parseTimeValue("23:59")).toEqual({ hours: 23, minutes: 59 });
    expect(parseTimeValue("24:00")).toBeNull();
    expect(parseTimeValue("09:60")).toBeNull();
    expect(parseTimeValue("9:00")).toBeNull();
    expect(formatTimeValue(9, 5)).toBe("09:05");
    expect(formatTimeValue(24, 60)).toBe("00:00");
  });

  it("converts between 12-hour and 24-hour representations", () => {
    expect(to12Hour(0)).toEqual({ hour12: 12, period: "am" });
    expect(to12Hour(12)).toEqual({ hour12: 12, period: "pm" });
    expect(to12Hour(13)).toEqual({ hour12: 1, period: "pm" });
    expect(to24Hour(12, "am")).toBe(0);
    expect(to24Hour(12, "pm")).toBe(12);
    expect(to24Hour(1, "pm")).toBe(13);
    expect(to24Hour(1, "am")).toBe(1);
  });

  it("steps hours and minutes with wrap-around", () => {
    expect(stepHour(0, -1, false)).toBe(23);
    expect(stepHour(23, 1, false)).toBe(0);
    // In 12-hour mode stepping keeps the period and wraps 12 -> 1 / 1 -> 12
    expect(stepHour(11, 1, true)).toBe(0);
    expect(stepHour(0, -1, true)).toBe(11);
    expect(stepHour(13, -1, true)).toBe(12);
    expect(stepMinute(0, -1)).toBe(59);
    expect(stepMinute(58, 5)).toBe(3);
  });

  it("handles two-digit and auto-advancing hour typing", () => {
    // 12-hour: "1" waits for second digit, "1"+"0" commits 10 and advances
    const first = applyHourDigit("", "1", true, "am");
    expect(first).toEqual({ nextBuffer: "1", nextHour24: 1, advance: false });
    expect(applyHourDigit(first.nextBuffer, "0", true, "am")).toEqual({
      nextBuffer: "",
      nextHour24: 10,
      advance: true,
    });
    // 12-hour: "7" cannot start a two-digit hour, so it commits and advances immediately
    expect(applyHourDigit("", "7", true, "pm")).toEqual({
      nextBuffer: "",
      nextHour24: 19,
      advance: true,
    });
    // 24-hour: "2"+"3" commits 23 and advances; "5" commits 05 and advances
    const h2 = applyHourDigit("", "2", false, "am");
    expect(h2).toEqual({ nextBuffer: "2", nextHour24: 2, advance: false });
    expect(applyHourDigit(h2.nextBuffer, "3", false, "am")).toEqual({
      nextBuffer: "",
      nextHour24: 23,
      advance: true,
    });
    expect(applyHourDigit("", "5", false, "am")).toEqual({
      nextBuffer: "",
      nextHour24: 5,
      advance: true,
    });
  });

  it("handles minute digit typing", () => {
    const m3 = applyMinuteDigit("", "3");
    expect(m3).toEqual({ nextBuffer: "3", nextMinute: 3, advance: false });
    expect(applyMinuteDigit(m3.nextBuffer, "5")).toEqual({
      nextBuffer: "",
      nextMinute: 35,
      advance: true,
    });
    expect(applyMinuteDigit("", "8")).toEqual({
      nextBuffer: "",
      nextMinute: 8,
      advance: true,
    });
  });

  it("includes off-step minutes in sorted order", () => {
    const standard = buildMinuteOptions(15, 5);
    expect(standard).toHaveLength(12);
    expect(standard.every((option) => !option.offStep)).toBe(true);

    const withOffStep = buildMinuteOptions(17, 5);
    expect(withOffStep).toHaveLength(13);
    expect(withOffStep[4]).toEqual({ minute: 17, offStep: true });
    expect(withOffStep[3]).toEqual({ minute: 15, offStep: false });
    expect(withOffStep[5]).toEqual({ minute: 20, offStep: false });
  });
});
