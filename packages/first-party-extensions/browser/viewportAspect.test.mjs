/**
 * The aspect-ratio lock's resize math against goldens taken from native
 * `resizeFreeformViewport` / `resizeBrowserViewportFromRail`
 * (the web client's browser viewport layout) with the same inputs.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { resizeViewportBy, resizeViewportFromRail } from "./viewport.ts";

const IPHONE_SE = { width: 375, height: 667 };
const RATIO = 375 / 667;

NodeTest.test("a locked rail keeps the shape, led by the axis that moved most", () => {
  const golden = [
    [{ x: 100, y: 0 }, "east", { width: 475, height: 845 }],
    [{ x: -100, y: 0 }, "west", { width: 475, height: 845 }],
    [{ x: 0, y: 200 }, "south", { width: 487, height: 867 }],
    [{ x: 50, y: 30 }, "southeast", { width: 425, height: 756 }],
    [{ x: -10, y: 300 }, "southwest", { width: 544, height: 967 }],
    // Past the envelope the leading axis clamps and the other follows.
    [{ x: 9000, y: 0 }, "east", { width: 2158, height: 3838 }],
  ];
  for (const [delta, direction, expected] of golden) {
    NodeAssert.deepEqual(resizeViewportBy(IPHONE_SE, delta, direction, RATIO), expected);
  }
});

NodeTest.test("a locked drag keeps the shape", () => {
  NodeAssert.deepEqual(
    resizeViewportFromRail(
      IPHONE_SE,
      { x: 40, y: 0 },
      { width: 800, height: 600 },
      1,
      "east",
      RATIO,
    ),
    { width: 455, height: 809 },
  );
});

NodeTest.test("an unlocked rail still resizes one axis", () => {
  NodeAssert.deepEqual(resizeViewportBy(IPHONE_SE, { x: 100, y: 0 }, "east", null), {
    width: 475,
    height: 667,
  });
});
