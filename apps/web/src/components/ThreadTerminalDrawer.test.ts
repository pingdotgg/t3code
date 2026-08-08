import { describe, expect, it } from "vite-plus/test";

import {
  resolveDrawerResizeStartHeight,
  resolveDrawerResizeStoredHeight,
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalExit,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  terminalSelectionLineRange,
} from "./ThreadTerminalDrawer";

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });

  it("uses Ghostty's physical screen range for visually wrapped selections", () => {
    expect(
      terminalSelectionLineRange({
        start: { y: 4 },
        end: { y: 6 },
      }),
    ).toEqual({ lineStart: 5, lineEnd: 7 });
  });

  it("handles an exit that lands while the terminal surface is still loading", () => {
    expect(shouldHandleTerminalExit("exited", "running", false)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "exited", false)).toBe(false);
    expect(shouldHandleTerminalExit("closed", "running", true)).toBe(false);
  });
});

describe("resolveDrawerResizeStartHeight", () => {
  it("starts the drag from the height the layout granted, not the stored one", () => {
    expect(resolveDrawerResizeStartHeight(462.4, 700)).toBe(462);
  });

  it("falls back to the stored height when the drawer has not been measured", () => {
    expect(resolveDrawerResizeStartHeight(null, 320)).toBe(320);
    expect(resolveDrawerResizeStartHeight(0, 320)).toBe(320);
    expect(resolveDrawerResizeStartHeight(Number.NaN, 320)).toBe(320);
  });
});

describe("resolveDrawerResizeStoredHeight", () => {
  it("persists a drag that shrinks the drawer", () => {
    expect(
      resolveDrawerResizeStoredHeight({
        draggedHeight: 400,
        dragStartHeight: 444,
        storedHeight: 675,
      }),
    ).toBe(400);
  });

  it("keeps the taller stored height when a squeezed drag asks for more room", () => {
    // Divider squeezed to 444 by the composer reserve; nudging it up must not
    // quietly rewrite the user's 675 preference down to 454.
    expect(
      resolveDrawerResizeStoredHeight({
        draggedHeight: 454,
        dragStartHeight: 444,
        storedHeight: 675,
      }),
    ).toBe(675);
  });

  it("grows normally when the drawer was not squeezed", () => {
    expect(
      resolveDrawerResizeStoredHeight({
        draggedHeight: 600,
        dragStartHeight: 500,
        storedHeight: 500,
      }),
    ).toBe(600);
  });

  it("keeps the stored height when a drag ends back where it started", () => {
    // The drag re-anchors on the squeezed height, so a drag that returns to its
    // starting point still reaches this function — with no net resize.
    expect(
      resolveDrawerResizeStoredHeight({
        draggedHeight: 444,
        dragStartHeight: 444,
        storedHeight: 675,
      }),
    ).toBe(675);
  });

  it("takes the dragged height when it already exceeds the stored one", () => {
    expect(
      resolveDrawerResizeStoredHeight({
        draggedHeight: 700,
        dragStartHeight: 444,
        storedHeight: 675,
      }),
    ).toBe(700);
  });
});
