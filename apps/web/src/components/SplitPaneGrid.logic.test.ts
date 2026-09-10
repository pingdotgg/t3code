import { describe, expect, test } from "vite-plus/test";

import {
  canDropPaneTab,
  calculatePaneSplitRatio,
  resolveKeyboardResizeDelta,
  resolvePaneDropZone,
} from "./SplitPaneGrid.logic";
import { createPaneTree, splitPane, type PaneId, type PaneTabId } from "~/splitPaneTree";

const paneId = (value: string) => `pane:${value}` as PaneId;
const tabId = (value: string) => `pane-tab:${value}` as PaneTabId;

describe("split pane pointer and keyboard geometry", () => {
  test("resolves edge and center drop zones", () => {
    const bounds = { left: 100, top: 100, width: 400, height: 300 };

    expect(resolvePaneDropZone({ clientX: 110, clientY: 250, bounds })).toBe("left");
    expect(resolvePaneDropZone({ clientX: 490, clientY: 250, bounds })).toBe("right");
    expect(resolvePaneDropZone({ clientX: 300, clientY: 110, bounds })).toBe("up");
    expect(resolvePaneDropZone({ clientX: 300, clientY: 390, bounds })).toBe("down");
    expect(resolvePaneDropZone({ clientX: 300, clientY: 250, bounds })).toBe("center");
  });

  test("clamps pointer ratios to usable pane sizes", () => {
    expect(calculatePaneSplitRatio(0, 0, 100)).toBe(0.1);
    expect(calculatePaneSplitRatio(50, 0, 100)).toBe(0.5);
    expect(calculatePaneSplitRatio(100, 0, 100)).toBe(0.9);
    expect(calculatePaneSplitRatio(50, 0, 0)).toBeNull();
  });

  test("maps arrow keys along the split orientation", () => {
    expect(resolveKeyboardResizeDelta("ArrowLeft", "horizontal")).toBe(-0.05);
    expect(resolveKeyboardResizeDelta("ArrowRight", "horizontal")).toBe(0.05);
    expect(resolveKeyboardResizeDelta("ArrowUp", "vertical")).toBe(-0.05);
    expect(resolveKeyboardResizeDelta("ArrowDown", "vertical")).toBe(0.05);
    expect(resolveKeyboardResizeDelta("ArrowUp", "horizontal")).toBeNull();
  });

  test("allows a sole surface tab to copy into a split without emptying its pane", () => {
    const tree = createPaneTree({ paneId: paneId("source"), tabIds: [tabId("surface")] });
    const draggedTab = { sourcePaneId: paneId("source"), sourceTabId: tabId("surface") };

    expect(
      canDropPaneTab({
        tree,
        draggedTab,
        targetPaneId: paneId("source"),
        zone: "right",
        canCopyFromSolePane: false,
      }),
    ).toBe(false);
    expect(
      canDropPaneTab({
        tree,
        draggedTab,
        targetPaneId: paneId("source"),
        zone: "right",
        canCopyFromSolePane: true,
      }),
    ).toBe(true);
  });

  test("allows tabs to move into another pane but not swap with their own pane", () => {
    const initial = createPaneTree({ paneId: paneId("source"), tabIds: [tabId("surface")] });
    const tree = splitPane(initial, {
      sourcePaneId: paneId("source"),
      targetPaneId: paneId("target"),
      splitId: "pane-split:root",
      direction: "right",
    });
    const draggedTab = { sourcePaneId: paneId("source"), sourceTabId: tabId("surface") };

    expect(
      canDropPaneTab({
        tree,
        draggedTab,
        targetPaneId: paneId("target"),
        zone: "center",
        canCopyFromSolePane: false,
      }),
    ).toBe(true);
    expect(
      canDropPaneTab({
        tree,
        draggedTab,
        targetPaneId: paneId("source"),
        zone: "center",
        canCopyFromSolePane: true,
      }),
    ).toBe(false);
  });
});
