import { describe, expect, it } from "@effect/vitest";

import {
  parseLinuxBatteryCapacity,
  parseLinuxMainsOnlineStates,
  parsePmsetBatt,
  parsePmsetOnBattery,
} from "./hostBattery.ts";

describe("parsePmsetBatt", () => {
  it("reads a charged AC-connected battery", () => {
    expect(
      parsePmsetBatt(`Now drawing from 'AC Power'
 -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true
`),
    ).toBe(100);
  });

  it("reads a discharging battery", () => {
    expect(
      parsePmsetBatt(`Now drawing from 'Battery Power'
 -InternalBattery-0 (id=1)\t72%; discharging; 3:14 remaining present: true
`),
    ).toBe(72);
  });

  it("returns null when no battery is present", () => {
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -No batteries available.\n")).toBeNull();
  });
});

describe("parsePmsetOnBattery", () => {
  const cases: ReadonlyArray<{
    readonly output: string;
    readonly expected: boolean | null;
  }> = [
    { output: "Now drawing from 'Battery Power'\n", expected: true },
    { output: "Now drawing from 'AC Power'\n", expected: false },
    { output: "something else\n", expected: null },
  ];
  it.each(cases)("$output → $expected", ({ output, expected }) => {
    expect(parsePmsetOnBattery(output)).toBe(expected);
  });
});

describe("parseLinuxBatteryCapacity", () => {
  const cases: ReadonlyArray<{
    readonly output: string;
    readonly expected: number | null;
  }> = [
    { output: "64\n", expected: 64 },
    { output: "100", expected: 100 },
    { output: "", expected: null },
    { output: "nope", expected: null },
  ];
  it.each(cases)("$output → $expected", ({ output, expected }) => {
    expect(parseLinuxBatteryCapacity(output)).toBe(expected);
  });
});

describe("parseLinuxMainsOnlineStates", () => {
  const cases: ReadonlyArray<{
    readonly onlineValues: ReadonlyArray<string>;
    readonly expected: boolean | null;
  }> = [
    { onlineValues: [], expected: null },
    { onlineValues: ["0"], expected: true },
    { onlineValues: ["1"], expected: false },
    { onlineValues: ["0", "1"], expected: false },
    { onlineValues: ["0", "0"], expected: true },
    { onlineValues: ["0", "2"], expected: null },
  ];
  it.each(cases)("$onlineValues → $expected", ({ onlineValues, expected }) => {
    expect(parseLinuxMainsOnlineStates(onlineValues)).toBe(expected);
  });
});
