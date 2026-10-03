import { describe, expect, it } from "vitest";
import { compareQueuedTurns, nextQueuePosition } from "./queuedTurnOrder.ts";

function turn(id: string, queuePosition: number | undefined, createdAt = "2026-01-01T00:00:00Z") {
  return { id, createdAt, queuePosition };
}

describe("compareQueuedTurns", () => {
  it("orders by explicit position rather than creation time", () => {
    const first = turn("a", 0, "2026-01-01T00:00:09Z");
    const second = turn("b", 1, "2026-01-01T00:00:01Z");

    expect([second, first].toSorted(compareQueuedTurns)).toEqual([first, second]);
  });

  it("falls back to creation order when neither turn has a position", () => {
    const older = turn("a", undefined, "2026-01-01T00:00:01Z");
    const newer = turn("b", undefined, "2026-01-01T00:00:02Z");

    expect([newer, older].toSorted(compareQueuedTurns)).toEqual([older, newer]);
  });

  it("sorts a position-less turn last so it never displaces a positioned turn", () => {
    const positioned = turn("a", 3);
    const legacy = turn("b", undefined, "2026-01-01T00:00:01Z");

    expect([legacy, positioned].toSorted(compareQueuedTurns)).toEqual([positioned, legacy]);
    expect([positioned, legacy].toSorted(compareQueuedTurns)).toEqual([positioned, legacy]);
  });

  it("breaks remaining ties on id so the order is total", () => {
    const left = turn("a", 2);
    const right = turn("b", 2);

    expect([right, left].toSorted(compareQueuedTurns)).toEqual([left, right]);
  });
});

describe("nextQueuePosition", () => {
  it("appends after the highest existing position", () => {
    expect(nextQueuePosition([turn("a", 0), turn("b", 4)])).toBe(5);
  });

  it("starts at zero for an empty queue", () => {
    expect(nextQueuePosition([])).toBe(0);
  });

  it("ignores position-less turns so a pre-ordering turn cannot skew the offset", () => {
    expect(nextQueuePosition([turn("legacy", undefined)])).toBe(0);
    expect(nextQueuePosition([turn("legacy", undefined), turn("a", 1)])).toBe(2);
  });
});
