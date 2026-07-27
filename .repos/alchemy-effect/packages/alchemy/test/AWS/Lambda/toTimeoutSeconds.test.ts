import { toTimeoutSeconds } from "@/AWS/Lambda/Function.ts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "alchemy-test";

describe("toTimeoutSeconds", () => {
  it("returns undefined for undefined", () => {
    expect(toTimeoutSeconds(undefined)).toBeUndefined();
  });

  it("converts a Duration to whole seconds", () => {
    expect(toTimeoutSeconds(Duration.seconds(30))).toBe(30);
    expect(toTimeoutSeconds(Duration.minutes(2))).toBe(120);
  });

  it("rounds sub-second and partial durations up", () => {
    expect(toTimeoutSeconds(Duration.millis(1))).toBe(1);
    expect(toTimeoutSeconds(Duration.millis(1500))).toBe(2);
    expect(toTimeoutSeconds(Duration.millis(2001))).toBe(3);
  });

  it("returns undefined for an infinite Duration", () => {
    expect(toTimeoutSeconds(Duration.infinity)).toBeUndefined();
  });

  describe("after state JSON round-trip", () => {
    const roundTrip = (d: Duration.Duration) =>
      JSON.parse(JSON.stringify(d)) as Duration.Duration;

    it("converts a rehydrated Millis Duration", () => {
      const json = roundTrip(Duration.seconds(42));
      expect(json).toEqual({
        _id: "Duration",
        _tag: "Millis",
        millis: 42_000,
      });
      expect(toTimeoutSeconds(json)).toBe(42);
    });

    it("converts a rehydrated Nanos Duration", () => {
      const json = roundTrip(Duration.nanos(5_000_000_000n));
      expect(toTimeoutSeconds(json)).toBe(5);
    });

    it("returns undefined for a rehydrated Infinity Duration", () => {
      expect(toTimeoutSeconds(roundTrip(Duration.infinity))).toBeUndefined();
    });
  });
});
