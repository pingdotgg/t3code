import { assert, it } from "vite-plus/test";

import { gridLines } from "./gridLines.ts";

it("draws round values across the range", () => {
  assert.deepEqual(gridLines(-10, 10), [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]);
  assert.deepEqual(gridLines(0, 0.8), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
});

it("ends for ranges numbers cannot step through", () => {
  for (const [from, to] of [
    [1e17, 1e17 + 32],
    [-1e300, 1e300],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
    [0, Number.MIN_VALUE],
    [5, 5],
    [10, -10],
    [Number.NaN, 1],
  ] as const) {
    assert.isAtMost(gridLines(from, to).length, 20);
  }
});
