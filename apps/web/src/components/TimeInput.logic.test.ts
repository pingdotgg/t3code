import { describe, expect, it } from "vite-plus/test";
import { formatTimeOfDay, parseTimeOfDay } from "./TimeInput.logic";

describe("formatTimeOfDay", () => {
  it.each([
    ["17:30", false, "17:30"],
    ["17:30", true, "5:30 PM"],
    ["00:05", true, "12:05 AM"],
    ["12:00", true, "12:00 PM"],
    ["", true, ""],
  ])("%s with hour12=%s is %s", (value, hour12, expected) => {
    expect(formatTimeOfDay(value, hour12)).toBe(expected);
  });
});

describe("parseTimeOfDay", () => {
  it.each([
    ["17:30", "17:30"],
    ["8:45", "08:45"],
    ["1730", "17:30"],
    ["5:30 PM", "17:30"],
    ["5:30pm", "17:30"],
    ["12:05 a.m.", "00:05"],
    ["12:00 PM", "12:00"],
    ["24:00", null],
    ["13:00 PM", null],
    ["0:30 AM", null],
    ["9:60", null],
    ["noon", null],
    ["", null],
  ])("%s reads as %s", (text, expected) => {
    expect(parseTimeOfDay(text)).toBe(expected);
  });
});
