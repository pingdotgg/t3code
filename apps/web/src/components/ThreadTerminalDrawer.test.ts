import { describe, expect, it } from "vite-plus/test";

import {
  classifyTerminalExitTransition,
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  shouldHandleLiveTerminalExit,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer";

describe("classifyTerminalExitTransition", () => {
  it("keeps an initially exited session visible after its buffer is replayed", () => {
    expect(
      classifyTerminalExitTransition({
        previousVersion: 0,
        previousStatus: "closed",
        currentStatus: "exited",
      }),
    ).toBe("initial");
  });

  it("treats the synthetic closed baseline as an initial closed snapshot", () => {
    expect(
      classifyTerminalExitTransition({
        previousVersion: 0,
        previousStatus: "closed",
        currentStatus: "closed",
      }),
    ).toBe("initial");
  });

  it("distinguishes a live exit from unchanged or already-handled state", () => {
    expect(
      classifyTerminalExitTransition({
        previousVersion: 3,
        previousStatus: "running",
        currentStatus: "exited",
      }),
    ).toBe("live");
    expect(
      classifyTerminalExitTransition({
        previousVersion: 4,
        previousStatus: "exited",
        currentStatus: "exited",
      }),
    ).toBe("none");
  });
});

describe("shouldHandleLiveTerminalExit", () => {
  it("tracks live exits independently of an xterm remount baseline", () => {
    expect(
      shouldHandleLiveTerminalExit({
        previousStatus: "running",
        currentStatus: "exited",
        hasHandledExit: false,
      }),
    ).toBe(true);
  });

  it("ignores initial or already-handled exited snapshots", () => {
    expect(
      shouldHandleLiveTerminalExit({
        previousStatus: "exited",
        currentStatus: "exited",
        hasHandledExit: false,
      }),
    ).toBe(false);
    expect(
      shouldHandleLiveTerminalExit({
        previousStatus: "running",
        currentStatus: "exited",
        hasHandledExit: true,
      }),
    ).toBe(false);
  });
});

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
});
