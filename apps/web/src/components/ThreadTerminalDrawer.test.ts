import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalExit,
  shouldHandleTerminalSelectionMouseUp,
  shouldOpenTerminalSelectionContextMenu,
  shouldRefocusTerminalAfterSelectionMenuDismissal,
  terminalSelectionActionDelayForClickCount,
  terminalSelectionLineRange,
  terminalSelectionMenuItems,
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

describe("terminalSelectionMenuItems", () => {
  it("gives the Copy item the platform's terminal copy chord as accelerator", () => {
    // On macOS the open native menu owns the keyboard, so the accelerator is
    // what keeps Cmd+C copying while the menu is up.
    expect(terminalSelectionMenuItems("MacIntel")).toEqual([
      { id: "add-to-chat", label: "Add to chat" },
      { id: "copy", label: "Copy", accelerator: "Cmd+C" },
    ]);
    // Plain Ctrl+C stays SIGINT off macOS, so the menu advertises Ctrl+Shift+C.
    expect(terminalSelectionMenuItems("Win32")).toEqual([
      { id: "add-to-chat", label: "Add to chat" },
      { id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C" },
    ]);
  });
});

describe("shouldOpenTerminalSelectionContextMenu", () => {
  it("opens the selection menu only for a right-click with a Ghostty selection", () => {
    expect(
      shouldOpenTerminalSelectionContextMenu({ hasSelection: true, defaultPrevented: false }),
    ).toBe(true);
    expect(
      shouldOpenTerminalSelectionContextMenu({ hasSelection: false, defaultPrevented: false }),
    ).toBe(false);
  });

  it("leaves right-click to a mouse-reporting app that already claimed it", () => {
    expect(
      shouldOpenTerminalSelectionContextMenu({ hasSelection: true, defaultPrevented: true }),
    ).toBe(false);
  });
});

describe("shouldRefocusTerminalAfterSelectionMenuDismissal", () => {
  const terminalMount = (containsActive: boolean) => ({ contains: () => containsActive });
  const element = {} as Element;
  const body = {} as Element;

  it("returns focus to the terminal when dismissal left focus in it or nowhere", () => {
    expect(
      shouldRefocusTerminalAfterSelectionMenuDismissal(terminalMount(true), element, body),
    ).toBe(true);
    expect(shouldRefocusTerminalAfterSelectionMenuDismissal(terminalMount(false), null, body)).toBe(
      true,
    );
    expect(shouldRefocusTerminalAfterSelectionMenuDismissal(terminalMount(false), body, body)).toBe(
      true,
    );
  });

  it("keeps focus where the dismissing click put it", () => {
    expect(
      shouldRefocusTerminalAfterSelectionMenuDismissal(terminalMount(false), element, body),
    ).toBe(false);
  });
});
