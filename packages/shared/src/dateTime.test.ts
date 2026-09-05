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

  it.each([
    ["2024-02-29T12:00:00Z", "2024-02-29T17:30:00+05:30"],
    ["2000-02-29T00:00:00.100Z", "2000-02-28T20:30:00.1-03:30"],
    ["0000-01-01T00:00:00.000Z", "+000000-01-01T00:00:00.000+00:00"],
    ["+010000-01-01T00:00:00.000Z", "9999-12-31T23:00:00.000-01:00"],
    ["2026-09-01T24:00:00Z", "2026-09-02T00:00:00Z"],
    ["2026-09-01T24:00:00.0000Z", "2026-09-02T00:00:00.000Z"],
    ["2024-02-29T24:00:00+05:30", "2024-03-01T00:00:00+05:30"],
    ["2026-12-31T24:00:00-07:00", "2027-01-01T07:00:00Z"],
    ["2026-09-01T12:00Z", "2026-09-01T12:00:00.000Z"],
    ["2026-09-01T05:00-07:00", "2026-09-01T12:00:00Z"],
    ["2026-09-01T24:00Z", "2026-09-02T00:00:00Z"],
    ["2026-09-01T24:00+05:30", "2026-09-02T00:00:00+05:30"],
  ])("preserves equal ISO instants %s and %s", (left, right) => {
    expect(compareDateTimeStrings(left, right)).toBe(0);
  });

  it("sorts malformed values before valid values", () => {
    expect(compareDateTimeStrings("invalid", "2026-09-01T12:00:00.000Z")).toBeLessThan(0);
    expect(compareDateTimeStrings("2026-09-01T12:00:00.000Z", "invalid")).toBeGreaterThan(0);
  });

  it.each([
    "2014-02-30",
    "2014-03-02",
    "2014-03-02T00:00:00",
    "2014-03-02T00:00:00.000",
    "03/02/2014",
    "March 2, 2014",
    "Sun, 02 Mar 2014 00:00:00 GMT",
    "2014-03-02T00:00:00.000Z\n",
    "2014-02-30T00:00:00.000Z",
    "1900-02-29T00:00:00.000-07:00",
    "2024-04-31T00:00:00.000+05:30",
    "2024-03-02T12:00:00.000+24:00",
    "2026-09-01T24:01:00Z",
    "2026-09-01T24:00:01Z",
    "2026-09-01T24:00:00.0001Z",
    "2026-09-01T24:01Z",
    "2026-09-01T25:00Z",
  ])("treats %s as malformed without native date guessing", (malformed) => {
    const valid = "1970-01-01T00:00:00.000Z";
    expect(compareDateTimeStrings(malformed, valid)).toBeLessThan(0);
    expect(compareDateTimeStrings(valid, malformed)).toBeGreaterThan(0);
    expect(compareDateTimeStrings(malformed, "invalid")).toBeLessThan(0);
    expect(compareDateTimeStrings("invalid", malformed)).toBeGreaterThan(0);
    expect(compareDateTimeStrings(malformed, malformed)).toBe(0);
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
