import { describe, expect, it } from "vite-plus/test";

import {
  layoutPaneRects,
  paneLayout,
  removePaneFromLayout,
  resolveTerminalPaneLayout,
  splitPaneLayout,
} from "./terminalPaneLayout";

describe("terminalPaneLayout", () => {
  it("nests a split in the other direction at the active pane only", () => {
    const stacked = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    const nested = splitPaneLayout(stacked, "t2", "t3", "horizontal");
    expect(nested).toEqual({
      kind: "split",
      direction: "vertical",
      children: [
        paneLayout("t1"),
        { kind: "split", direction: "horizontal", children: [paneLayout("t2"), paneLayout("t3")] },
      ],
    });
    expect(layoutPaneRects(nested)).toEqual([
      { terminalId: "t1", left: 0, top: 0, width: 1, height: 0.5 },
      { terminalId: "t2", left: 0, top: 0.5, width: 0.5, height: 0.5 },
      { terminalId: "t3", left: 0.5, top: 0.5, width: 0.5, height: 0.5 },
    ]);
  });

  it("appends an equal sibling when splitting again in the same direction", () => {
    const layout = splitPaneLayout(paneLayout("t1"), "t1", "t2", "horizontal");
    expect(splitPaneLayout(layout, "t1", "t3", "horizontal")).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [paneLayout("t1"), paneLayout("t3"), paneLayout("t2")],
    });
  });

  it("collapses a nested split to its remaining pane when one closes", () => {
    const nested = splitPaneLayout(
      splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical"),
      "t2",
      "t3",
      "horizontal",
    );
    expect(removePaneFromLayout(nested, "t3")).toEqual(
      splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical"),
    );
    expect(removePaneFromLayout(paneLayout("t1"), "t1")).toBeNull();
  });

  it("rebuilds a flat layout when a persisted tree does not match the group's ids", () => {
    const duplicated = {
      kind: "split",
      direction: "horizontal",
      children: [paneLayout("t1"), paneLayout("t1")],
    };
    expect(resolveTerminalPaneLayout(duplicated, ["t1", "t2"], "vertical")).toEqual({
      kind: "split",
      direction: "vertical",
      children: [paneLayout("t1"), paneLayout("t2")],
    });
  });
});
