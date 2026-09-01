import { describe, expect, it } from "@effect/vitest";

import { compareDateTimeStrings } from "./dateTime.ts";

describe("compareDateTimeStrings", () => {
  it("compares valid date-time strings by absolute time", () => {
    expect(
      compareDateTimeStrings("2026-09-01T12:00:00.000Z", "2026-09-01T05:00:00.000-07:00"),
    ).toBe(0);
    expect(
      compareDateTimeStrings("2026-09-01T12:00:01.000Z", "2026-09-01T12:00:00.000Z"),
    ).toBeGreaterThan(0);
  });

  it("sorts malformed values before valid values", () => {
    expect(compareDateTimeStrings("invalid", "2026-09-01T12:00:00.000Z")).toBeLessThan(0);
    expect(compareDateTimeStrings("2026-09-01T12:00:00.000Z", "invalid")).toBeGreaterThan(0);
  });

  it("uses code-unit order for malformed date-time strings", () => {
    expect(compareDateTimeStrings("invalid-a", "invalid-B")).toBeGreaterThan(0);
    expect(compareDateTimeStrings("invalid-B", "invalid-a")).toBeLessThan(0);
  });

  it("returns zero for equal malformed date-time strings", () => {
    expect(compareDateTimeStrings("invalid", "invalid")).toBe(0);
  });

  it("gives every permutation of mixed values the same order", () => {
    const early = "2026-09-01T12:00:00.000+14:00";
    const late = "2026-09-01T00:00:00.000-12:00";
    const malformed = "2026-09-01T06:invalid";
    const expected = [malformed, early, late];

    const permutations = [
      [early, late, malformed],
      [early, malformed, late],
      [late, early, malformed],
      [late, malformed, early],
      [malformed, early, late],
      [malformed, late, early],
    ];

    for (const values of permutations) {
      expect(values.toSorted(compareDateTimeStrings)).toEqual(expected);
    }
  });
});
