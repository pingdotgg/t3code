import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PANE_LAYOUT,
  MAX_PANES,
  addPane,
  closePane,
  MIN_PANE_FRACTION,
  minPaneFraction,
  equalPaneSizes,
  paneRowCounts,
  resizeBoundary,
  resolvePaneSizes,
  snapShift,
  swapPanes,
  focusPane,
  followRoute,
  replacePane,
  type PaneLayout,
} from "./paneLayout";

const env = EnvironmentId.make("env");
const ref = (name: string) => scopeThreadRef(env, ThreadId.make(name));
const idGenerator = () => {
  let next = 0;
  return () => `pane-${next++}`;
};
const threads = (layout: PaneLayout) => layout.panes.map((pane) => pane.ref.threadId);

function splitOf(names: ReadonlyArray<string>, focusedIndex = 0): PaneLayout {
  return {
    panes: names.map((name, i) => ({ id: `pane-${i}`, ref: ref(name) })),
    focusedIndex,
  };
}

describe("paneLayout", () => {
  describe("addPane", () => {
    it("starts a split from the current thread and focuses the new pane", () => {
      const layout = addPane(EMPTY_PANE_LAYOUT, ref("a"), ref("b"), idGenerator());
      expect(threads(layout)).toEqual(["a", "b"]);
      expect(layout.focusedIndex).toBe(1);
    });

    it("starts from the thread on screen, not a leftover single pane", () => {
      const layout = addPane(splitOf(["stale"]), ref("a"), ref("b"), idGenerator());
      expect(threads(layout)).toEqual(["a", "b"]);
      expect(layout.panes[0]?.id).toBe("pane-0");
    });

    it("focuses an open thread instead of duplicating it", () => {
      const layout = addPane(splitOf(["a", "b", "c"], 2), ref("a"), ref("a"), idGenerator());
      expect(threads(layout)).toEqual(["a", "b", "c"]);
      expect(layout.focusedIndex).toBe(0);
    });

    it("replaces the focused pane once the limit is reached", () => {
      const names = ["a", "b", "c", "d", "e", "f"];
      expect(names).toHaveLength(MAX_PANES);
      const layout = addPane(splitOf(names, 3), ref("a"), ref("g"), idGenerator());
      expect(threads(layout)).toEqual(["a", "b", "c", "g", "e", "f"]);
      expect(layout.focusedIndex).toBe(3);
    });
  });

  describe("replacePane", () => {
    it("keeps the slot id when a different thread takes the pane", () => {
      const layout = replacePane(splitOf(["a", "b"]), 1, ref("c"), idGenerator());
      expect(layout.panes[1]).toEqual({ id: "pane-1", ref: ref("c") });
    });

    it("swaps with the pane that already shows the thread", () => {
      const layout = replacePane(splitOf(["a", "b", "c"]), 0, ref("c"), idGenerator());
      expect(threads(layout)).toEqual(["c", "b", "a"]);
      expect(layout.focusedIndex).toBe(0);
    });
  });

  describe("closePane", () => {
    it.each([
      { focused: 2, close: 0, expected: 1 },
      { focused: 0, close: 0, expected: 0 },
      { focused: 2, close: 2, expected: 1 },
      { focused: 0, close: 2, expected: 0 },
    ])("focus $focused closing $close keeps focus on $expected", ({ focused, close, expected }) => {
      const layout = closePane(splitOf(["a", "b", "c"], focused), close);
      expect(layout.panes).toHaveLength(2);
      expect(layout.focusedIndex).toBe(expected);
    });
  });

  describe("followRoute", () => {
    it("focuses the pane that already shows the routed thread", () => {
      expect(followRoute(splitOf(["a", "b"]), ref("b")).focusedIndex).toBe(1);
    });

    it("takes over the focused pane for a thread that is not open", () => {
      const layout = followRoute(splitOf(["a", "b"], 1), ref("c"));
      expect(threads(layout)).toEqual(["a", "c"]);
    });

    it("leaves a single view alone", () => {
      const single = splitOf(["a"]);
      expect(followRoute(single, ref("b"))).toBe(single);
    });
  });

  it("focusPane ignores a missing pane", () => {
    const layout = splitOf(["a", "b"]);
    expect(focusPane(layout, 5)).toBe(layout);
  });

  describe("paneRowCounts", () => {
    it.each([
      { count: 1, rows: [1] },
      { count: 2, rows: [2] },
      { count: 3, rows: [3] },
      { count: 4, rows: [2, 2] },
      { count: 5, rows: [3, 2] },
      { count: 6, rows: [3, 3] },
    ])("tiles $count panes", ({ count, rows }) => {
      expect(paneRowCounts(count)).toEqual(rows);
    });
  });

  describe("snapShift", () => {
    it("jumps to the nearest candidate inside the threshold", () => {
      expect(snapShift(47, [0, 50, 55], 10)).toEqual({ shift: 50, snapped: true });
      expect(snapShift(53, [0, 50, 55], 10)).toEqual({ shift: 55, snapped: true });
    });

    it("leaves the shift alone outside the threshold", () => {
      expect(snapShift(30, [0, 50], 10)).toEqual({ shift: 30, snapped: false });
      expect(snapShift(30, [], 10)).toEqual({ shift: 30, snapped: false });
    });
  });

  describe("swapPanes", () => {
    it("exchanges threads but keeps each slot id", () => {
      const layout = swapPanes(splitOf(["a", "b", "c"]), 0, 2);
      expect(threads(layout)).toEqual(["c", "b", "a"]);
      expect(layout.panes.map((pane) => pane.id)).toEqual(["pane-0", "pane-1", "pane-2"]);
    });

    it("moves focus with the conversation", () => {
      expect(swapPanes(splitOf(["a", "b", "c"], 0), 0, 2).focusedIndex).toBe(2);
      expect(swapPanes(splitOf(["a", "b", "c"], 2), 0, 2).focusedIndex).toBe(0);
      expect(swapPanes(splitOf(["a", "b", "c"], 1), 0, 2).focusedIndex).toBe(1);
    });

    it("ignores a missing or identical slot", () => {
      const layout = splitOf(["a", "b"]);
      expect(swapPanes(layout, 0, 0)).toBe(layout);
      expect(swapPanes(layout, 0, 5)).toBe(layout);
    });
  });

  describe("pane sizes", () => {
    it("starts equal and sums to one in every row", () => {
      const sizes = equalPaneSizes(5);
      expect(sizes.rows).toEqual([0.5, 0.5]);
      expect(sizes.cols.map((row) => row.length)).toEqual([3, 2]);
      for (const row of sizes.cols) expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    });

    it("drops saved sizes once the pane count changes", () => {
      const saved = { ...equalPaneSizes(4), rows: [0.7, 0.3] };
      expect(resolvePaneSizes(saved, 4)).toBe(saved);
      expect(resolvePaneSizes(saved, 5)).toEqual(equalPaneSizes(5));
      expect(resolvePaneSizes(null, 2)).toEqual(equalPaneSizes(2));
    });

    it("moves a boundary and conserves the total", () => {
      const next = resizeBoundary([0.5, 0.5], 0, 0.1);
      expect(next[0]).toBeCloseTo(0.6);
      expect(next[1]).toBeCloseTo(0.4);
    });

    it("stops at the minimum share on either side", () => {
      expect(resizeBoundary([0.5, 0.5], 0, 0.9)[1]).toBeCloseTo(MIN_PANE_FRACTION);
      expect(resizeBoundary([0.5, 0.5], 0, -0.9)[0]).toBeCloseTo(MIN_PANE_FRACTION);
    });

    it("uses a pixel-derived minimum, capped to what the pair can give", () => {
      expect(minPaneFraction(260, 1000)).toBe(0.26);
      expect(minPaneFraction(260, 100)).toBe(2.6);
      expect(minPaneFraction(260, 0)).toBe(MIN_PANE_FRACTION);
      const next = resizeBoundary([0.3, 0.3], 0, 0.2, 0.5);
      expect(next[0]).toBeCloseTo(0.3);
      expect(next[1]).toBeCloseTo(0.3);
    });

    it("only touches the two panes beside the boundary", () => {
      const next = resizeBoundary([0.3, 0.3, 0.4], 1, 0.05);
      expect(next[0]).toBe(0.3);
      expect(next[2]).toBeCloseTo(0.35);
    });
  });
});
