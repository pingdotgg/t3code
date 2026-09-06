import { describe, expect, it } from "vite-plus/test";

import { exceedsMoveTolerance, LONG_PRESS_MOVE_TOLERANCE } from "./useLongPress";

describe("exceedsMoveTolerance", () => {
  const start = { x: 100, y: 100 };

  it("keeps the gesture alive for the small drift of a stationary finger", () => {
    expect(exceedsMoveTolerance(start, { x: 103, y: 104 })).toBe(false);
  });

  it("measures diagonal drift rather than either axis alone", () => {
    // 8px on each axis stays inside a per-axis check but is ~11.3px of travel.
    expect(exceedsMoveTolerance(start, { x: 108, y: 108 })).toBe(true);
  });

  it("treats travel exactly at the tolerance as still pressing", () => {
    expect(exceedsMoveTolerance(start, { x: 100 + LONG_PRESS_MOVE_TOLERANCE, y: 100 })).toBe(false);
  });

  it("releases the gesture to the scroll once the finger travels", () => {
    expect(exceedsMoveTolerance(start, { x: 100, y: 140 })).toBe(true);
  });
});
