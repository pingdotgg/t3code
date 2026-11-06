import { describe, expect, it } from "vite-plus/test";

import { resolveWorkGroupScrollAnchor } from "./scrollAnchor.js";

describe("tool-group scroll anchors", () => {
  const data = Array.from({ length: 18 }, (_, index) => ({ id: `call-${index}` }));
  const state = { data, positionAtIndex: (index: number) => index * 33 };

  it("returns to the top after a fast flick even when the cached start is five rows behind", () => {
    const snapshot = { ...state, scroll: 0, start: 5 };
    expect(resolveWorkGroupScrollAnchor(snapshot)).toEqual({
      rowId: "call-0",
      offsetWithinRow: 0,
      scrollOffset: 0,
    });
  });
});
