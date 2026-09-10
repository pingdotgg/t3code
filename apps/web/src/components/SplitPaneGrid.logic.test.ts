import { describe, expect, test } from "vite-plus/test";

import {
  calculatePaneSplitRatio,
  resolveKeyboardResizeDelta,
  resolvePaneDropZone,
} from "./SplitPaneGrid.logic";

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
});
