import { describe, expect, it } from "vite-plus/test";

import { readTimeOfDay, writeTimeOfDay, type TimeOfDayPart } from "./TimeOfDayInput.logic";

describe("readTimeOfDay", () => {
  it.each([
    ["00:05", true, { hour: "12", minute: "05", period: "AM" }],
    ["12:00", true, { hour: "12", minute: "00", period: "PM" }],
    ["17:30", true, { hour: "05", minute: "30", period: "PM" }],
    ["00:05", false, { hour: "00", minute: "05", period: "AM" }],
    ["17:30", false, { hour: "17", minute: "30", period: "PM" }],
  ] as const)("reads %s with hour12=%s", (value, hour12, expected) => {
    expect(readTimeOfDay(value, hour12)).toEqual(expected);
  });
});

describe("writeTimeOfDay", () => {
  it.each<[string, TimeOfDayPart, string, boolean, string]>([
    ["17:30", "hour", "12", true, "12:30"],
    ["05:30", "hour", "12", true, "00:30"],
    ["17:30", "hour", "03", true, "15:30"],
    ["12:15", "period", "AM", true, "00:15"],
    ["00:15", "period", "PM", true, "12:15"],
    ["23:59", "period", "PM", true, "23:59"],
    ["17:30", "hour", "00", false, "00:30"],
    ["17:30", "minute", "05", true, "17:05"],
  ])("sets %s %s to %s with hour12=%s", (value, part, next, hour12, expected) => {
    expect(writeTimeOfDay(value, part, next, hour12)).toBe(expected);
  });
});
