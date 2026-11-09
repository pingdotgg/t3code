import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { userWaitMs, workingTimerStartedAt } from "./userWait.ts";

const at = (second: number) => DateTime.makeUnsafe(second * 1000);
const request = (from: number, to: number | null) => ({
  startedAt: at(from),
  completedAt: to === null ? null : at(to),
});

describe("userWaitMs", () => {
  it("counts overlapping and nested requests once", () => {
    expect(
      userWaitMs([request(30, 40), request(10, 20), request(15, 25), request(32, 35)], 0, 100_000),
    ).toBe(25_000);
  });

  it("clips requests to the run and runs an open one to its end", () => {
    expect(userWaitMs([request(-5, 5), request(90, null)], 0, 95_000)).toBe(10_000);
  });
});

describe("workingTimerStartedAt", () => {
  it("moves the start past answered requests and ignores an open one", () => {
    expect(
      workingTimerStartedAt(DateTime.formatIso(at(0)), [request(2, 62), request(70, null)]),
    ).toBe(DateTime.formatIso(at(60)));
  });
});
