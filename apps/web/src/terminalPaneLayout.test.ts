import { describe, expect, it } from "vite-plus/test";

import {
  buildFlatLayout,
  isTerminalPaneLayout,
  layoutDirection,
  layoutHasMixedDirections,
  layoutTerminalIds,
  normalizePaneLayout,
  paneLayout,
  removePaneFromLayout,
  resolveTerminalPaneLayout,
  splitPaneLayout,
  terminalPaneLayoutEqual,
} from "./terminalPaneLayout";

describe("terminalPaneLayout", () => {
  it("nests a split inside the active pane instead of re-splitting the whole tree", () => {
    // Regression for: splitting vertically then horizontally used to re-split
    // every pane into 3 horizontal panes instead of only the active one.
    const single = paneLayout("t1");
    const afterVertical = splitPaneLayout(single, "t1", "t2", "vertical");
    expect(afterVertical).toEqual({
      kind: "split",
      direction: "vertical",
      children: [paneLayout("t1"), paneLayout("t2")],
    });

    const afterHorizontal = splitPaneLayout(afterVertical, "t2", "t3", "horizontal");
    expect(afterHorizontal).toEqual({
      kind: "split",
      direction: "vertical",
      children: [
        paneLayout("t1"),
        {
          kind: "split",
          direction: "horizontal",
          children: [paneLayout("t2"), paneLayout("t3")],
        },
      ],
    });
    expect(layoutTerminalIds(afterHorizontal)).toEqual(["t1", "t2", "t3"]);
  });

  it("appends an equal sibling when splitting again in the same direction", () => {
    const layout = splitPaneLayout(paneLayout("t1"), "t1", "t2", "horizontal");
    const next = splitPaneLayout(layout, "t2", "t3", "horizontal");
    expect(next).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [paneLayout("t1"), paneLayout("t2"), paneLayout("t3")],
    });
  });

  it("attaches beside the tree when the active id is stale", () => {
    const layout = paneLayout("t1");
    const next = splitPaneLayout(layout, "missing", "t2", "horizontal");
    expect(next).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [paneLayout("t1"), paneLayout("t2")],
    });
  });

  it("collapses a split down to its remaining sibling when a pane is removed", () => {
    const layout = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    expect(removePaneFromLayout(layout, "t2")).toEqual(paneLayout("t1"));
    expect(removePaneFromLayout(layout, "t1")).toEqual(paneLayout("t2"));
  });

  it("removes the whole tree once its last pane is removed", () => {
    expect(removePaneFromLayout(paneLayout("t1"), "t1")).toBeNull();
  });

  it("drops unknown or duplicate leaves and collapses single-child splits", () => {
    const layout = {
      kind: "split" as const,
      direction: "horizontal" as const,
      children: [paneLayout("t1"), paneLayout("stale")],
    };
    expect(normalizePaneLayout(layout, new Set(["t1"]))).toEqual(paneLayout("t1"));
    expect(normalizePaneLayout(layout, new Set(["stale-only"]))).toBeNull();
  });

  it("falls back to a flat layout for a pre-nested-split group", () => {
    expect(resolveTerminalPaneLayout(undefined, ["t1", "t2"], "vertical")).toEqual(
      buildFlatLayout(["t1", "t2"], "vertical"),
    );
    const validLayout = splitPaneLayout(paneLayout("t1"), "t1", "t2", "horizontal");
    expect(resolveTerminalPaneLayout(validLayout, ["t1", "t2"])).toEqual(validLayout);
  });

  it("rebuilds a flat layout when a corrupt persisted tree would drop a terminal id", () => {
    // A duplicated leaf normalizes structurally fine but silently loses "t2" —
    // must not be trusted, or that terminal disappears from the group.
    const corruptLayout = {
      kind: "split" as const,
      direction: "horizontal" as const,
      children: [paneLayout("t1"), paneLayout("t1")],
    };
    expect(resolveTerminalPaneLayout(corruptLayout, ["t1", "t2"])).toEqual(
      buildFlatLayout(["t1", "t2"]),
    );
  });

  it("validates layout shape defensively", () => {
    expect(isTerminalPaneLayout(paneLayout("t1"))).toBe(true);
    expect(isTerminalPaneLayout({ kind: "split", direction: "horizontal", children: [] })).toBe(
      false,
    );
    expect(isTerminalPaneLayout(undefined)).toBe(false);
    expect(isTerminalPaneLayout({ kind: "pane" })).toBe(false);
  });

  it("reads the root split direction, or null for a single pane", () => {
    expect(layoutDirection(paneLayout("t1"))).toBeNull();
    expect(layoutDirection(splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical"))).toBe(
      "vertical",
    );
  });

  it("detects a tree that nests both split directions", () => {
    const uniform = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    expect(layoutHasMixedDirections(uniform)).toBe(false);

    const mixed = splitPaneLayout(uniform, "t2", "t3", "horizontal");
    expect(layoutHasMixedDirections(mixed)).toBe(true);
  });

  it("compares layouts structurally", () => {
    const a = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    const b = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    expect(terminalPaneLayoutEqual(a, b)).toBe(true);
    expect(terminalPaneLayoutEqual(a, paneLayout("t1"))).toBe(false);
  });
});
