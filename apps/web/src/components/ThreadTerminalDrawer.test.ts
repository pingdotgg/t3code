import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalSelectionActionPosition,
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  shouldHandleTerminalSelectionMouseUp,
  terminalContextMenuItems,
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

  it("offers paste on the right-click menu even with nothing selected", () => {
    expect(terminalContextMenuItems({ hasSelection: false })).toEqual([
      { id: "add-to-chat", label: "Add to chat", disabled: true },
      { id: "copy", label: "Copy", disabled: true },
      { id: "paste", label: "Paste" },
    ]);
  });

  it("enables the selection actions once the terminal has a selection", () => {
    expect(terminalContextMenuItems({ hasSelection: true })).toEqual([
      { id: "add-to-chat", label: "Add to chat", disabled: false },
      { id: "copy", label: "Copy", disabled: false },
      { id: "paste", label: "Paste" },
    ]);
  });

  it("cancels the selection action while its popup timer or menu is current", () => {
    expect(
      shouldClearTerminalSelectionAction({
        timerPending: true,
        openMenuRequestId: null,
        currentRequestId: 3,
      }),
    ).toBe(true);
    expect(
      shouldClearTerminalSelectionAction({
        timerPending: false,
        openMenuRequestId: 3,
        currentRequestId: 3,
      }),
    ).toBe(true);
  });

  it("keeps a context-menu paste alive when no selection popup is current", () => {
    // Nothing pending at all: routine buffer sync must not cancel anything.
    expect(
      shouldClearTerminalSelectionAction({
        timerPending: false,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(false);
    // A popup superseded by a right-click (its menu promise not yet settled)
    // must not cancel the newer context-menu flow.
    expect(
      shouldClearTerminalSelectionAction({
        timerPending: false,
        openMenuRequestId: 3,
        currentRequestId: 4,
      }),
    ).toBe(false);
  });
});
