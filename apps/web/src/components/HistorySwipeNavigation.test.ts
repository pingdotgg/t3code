import { describe, expect, it } from "vite-plus/test";

import { isMomentumTail } from "./HistorySwipeNavigation";

describe("isMomentumTail", () => {
  it.each([
    ["steady momentum decay", [40, 37, 34, 31.3, 28.8], true],
    ["fingers still moving", [12, 18, 9, 15, 11], false],
    ["fingers slowing unevenly", [30, 22, 20, 12, 11], false],
    ["reversing", [10, 8, 6, 4, -2], false],
    ["too few samples", [40, 37, 34], false],
  ])("%s", (_name, deltas, expected) => {
    expect(isMomentumTail(deltas)).toBe(expected);
  });
});
