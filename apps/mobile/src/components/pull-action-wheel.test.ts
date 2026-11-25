import { describe, expect, it } from "vite-plus/test";

import {
  PULL_SWING_PER_ACTION,
  overscrollPastEnd,
  pointPullAction,
  selectedPullAction,
  shouldRunPullAction,
  swingPosition,
  trackPull,
} from "./pull-action-wheel";

function scroll(offsetY: number, contentHeight: number, inset = { top: 0, bottom: 0 }) {
  return {
    contentOffset: { y: offsetY },
    contentSize: { height: contentHeight },
    layoutMeasurement: { height: 800 },
    contentInset: inset,
  };
}

describe("overscrollPastEnd", () => {
  it("counts only the bounce past the end, from the bottom inset or a short feed's top inset", () => {
    const inset = { top: 0, bottom: 120 };
    expect(overscrollPastEnd(scroll(1060, 1700, inset))).toBe(40);
    expect(overscrollPastEnd(scroll(-60, 300, { top: 100, bottom: 0 }))).toBe(40);
    expect(overscrollPastEnd(scroll(-80, 3000))).toBe(0);
  });
});

describe("pull release", () => {
  function pull(moves: ReadonlyArray<readonly [time: number, distance: number]>) {
    return moves.reduce<number | null>(
      (armedAt, [time, distance]) => trackPull(armedAt, distance, 72, time),
      null,
    );
  }

  it("runs only for a pull held armed and let go slowly, not a flick or a cancel", () => {
    const held = pull([
      [1000, 40],
      [1050, 80],
      [1150, 95],
      [1250, 90],
    ]);
    expect(shouldRunPullAction(held, 1260, true, 0.2)).toBe(true);
    expect(shouldRunPullAction(held, 1260, true, -3)).toBe(false);
    expect(shouldRunPullAction(pull([[1000, 120]]), 1070, true, 0)).toBe(false);
    expect(
      shouldRunPullAction(
        pull([
          [1000, 90],
          [1200, 50],
        ]),
        1300,
        true,
        0,
      ),
    ).toBe(false);
  });
});

describe("pull wheel selection", () => {
  const ALL = 0b111;
  function swing(moves: ReadonlyArray<number>, options = { count: 3, defaultIndex: 1, mask: ALL }) {
    const pointed = moves.reduce(
      (previous, dx) =>
        pointPullAction(
          swingPosition(dx, options.count, options.defaultIndex),
          previous,
          options.count,
        ),
      pointPullAction(options.defaultIndex, -1, options.count),
    );
    return selectedPullAction(pointed, options.mask);
  }

  it("follows the finger with a dead band, clamps, and selects nothing on a disabled action", () => {
    const half = PULL_SWING_PER_ACTION / 2;
    expect(swing([0])).toBe(1);
    expect(swing([-half - 4])).toBe(1);
    expect(swing([-PULL_SWING_PER_ACTION])).toBe(0);
    expect(swingPosition(-PULL_SWING_PER_ACTION * 9, 3, 1)).toBe(0);
    expect(swingPosition(PULL_SWING_PER_ACTION * 9, 3, 1)).toBe(2);
    expect(swing([-PULL_SWING_PER_ACTION], { count: 3, defaultIndex: 1, mask: 0b110 })).toBe(-1);
  });
});
