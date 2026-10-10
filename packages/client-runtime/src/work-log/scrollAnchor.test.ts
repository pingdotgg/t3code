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

  it.each([
    { scroll: 302, start: 0, rowId: "call-9", offsetWithinRow: 5 },
    { scroll: 40, start: 12, rowId: "call-1", offsetWithinRow: 7 },
    { scroll: 165, start: 4, rowId: "call-5", offsetWithinRow: 0 },
  ])("uses the measured position at $scroll rather than cached row $start", (example) => {
    expect(resolveWorkGroupScrollAnchor({ ...state, ...example })).toEqual({
      rowId: example.rowId,
      offsetWithinRow: example.offsetWithinRow,
      scrollOffset: example.scroll,
    });
  });

  it("preserves an offset within expanded output", () => {
    const positions = [0, 33, 600];
    expect(
      resolveWorkGroupScrollAnchor({
        data: [{ id: "first" }, { id: "output" }, { id: "last" }],
        scroll: 153,
        positionAtIndex: (index) => positions[index],
      }),
    ).toEqual({ rowId: "output", offsetWithinRow: 120, scrollOffset: 153 });
  });

  it("does not preserve overscroll before the first row", () => {
    expect(resolveWorkGroupScrollAnchor({ ...state, scroll: -20 })).toEqual({
      rowId: "call-0",
      offsetWithinRow: 0,
      scrollOffset: 0,
    });
  });

  it("skips incomplete layout snapshots instead of saving an invalid anchor", () => {
    expect(resolveWorkGroupScrollAnchor({ ...state, data: [], scroll: 0 })).toBeUndefined();
    expect(resolveWorkGroupScrollAnchor({ ...state, scroll: Number.NaN })).toBeUndefined();
    expect(
      resolveWorkGroupScrollAnchor({ ...state, scroll: 165, positionAtIndex: () => undefined }),
    ).toBeUndefined();
    expect(
      resolveWorkGroupScrollAnchor({
        ...state,
        scroll: 165,
        positionAtIndex: (index) => (index === 0 ? 0 : Number.NaN),
      }),
    ).toBeUndefined();
  });
});
