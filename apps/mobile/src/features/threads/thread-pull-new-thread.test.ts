import { describe, expect, it } from "vite-plus/test";

import { overscrollPastEnd, shouldStartNewThread, trackPull } from "./thread-pull-new-thread";

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
    expect(overscrollPastEnd(scroll(1020, 1700, inset))).toBe(0);
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

  it("starts a thread only for a pull held armed and let go slowly, not a flick or a cancel", () => {
    const held = pull([
      [1000, 40],
      [1050, 80],
      [1150, 95],
      [1250, 90],
    ]);
    expect(shouldStartNewThread(held, 1260, true, 0.2)).toBe(true);
    expect(shouldStartNewThread(held, 1260, true, -3)).toBe(false);
    expect(shouldStartNewThread(held, 1260, false, 0)).toBe(false);
    expect(shouldStartNewThread(pull([[1000, 120]]), 1070, true, 0)).toBe(false);
    expect(
      shouldStartNewThread(
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
