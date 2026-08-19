import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalExit,
  shouldHandleTerminalSelectionMouseUp,
  terminalContextMenuItems,
  terminalLinkChatText,
  terminalSelectionActionDelayForClickCount,
  terminalSelectionLineRange,
} from "./ThreadTerminalDrawer";

describe("terminalLinkChatText", () => {
  it("resolves relative paths against the terminal cwd", () => {
    expect(
      terminalLinkChatText("src/components/ThreadTerminalDrawer.tsx", "/Users/olive/project"),
    ).toBe(
      "[ThreadTerminalDrawer.tsx](/Users/olive/project/src/components/ThreadTerminalDrawer.tsx)",
    );
  });

  it("removes terminal positions before serializing a file link", () => {
    expect(terminalLinkChatText("src/index.ts:12:3", "/Users/olive/project")).toBe(
      "[index.ts](/Users/olive/project/src/index.ts)",
    );
  });

  it("trims trailing separators before serializing a directory link", () => {
    expect(terminalLinkChatText("/Users/olive/project/dist/", "/Users/olive/project")).toBe(
      "[dist](/Users/olive/project/dist)",
    );
  });

  it("leaves URLs intact regardless of scheme casing", () => {
    expect(terminalLinkChatText("HTTPS://t3.codes/docs", "/Users/olive/project")).toBe(
      "HTTPS://t3.codes/docs",
    );
  });
});

describe("terminalContextMenuItems", () => {
  it("offers path actions for a detected terminal path", () => {
    const options = {
      hasSelection: false,
      link: "src/components/ThreadTerminalDrawer.tsx",
    };

    expect(terminalContextMenuItems(options)).toEqual([
      { id: "open-link", label: "Open in editor" },
      { id: "add-link-to-chat", label: "Add path to chat" },
      { id: "copy-link", label: "Copy path", icon: "copy" },
      { id: "add-to-chat", label: "Add to chat", disabled: true },
      { id: "copy", label: "Copy", disabled: true },
      { id: "paste", label: "Paste" },
    ]);
  });

  it("offers URL actions while preserving enabled selection actions", () => {
    const options = {
      hasSelection: true,
      link: "https://t3.codes",
    };

    expect(terminalContextMenuItems(options)).toEqual([
      { id: "open-link", label: "Open link" },
      { id: "add-link-to-chat", label: "Add link to chat" },
      { id: "copy-link", label: "Copy link", icon: "copy" },
      { id: "add-to-chat", label: "Add to chat", disabled: false },
      { id: "copy", label: "Copy", disabled: false },
      { id: "paste", label: "Paste" },
    ]);
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
