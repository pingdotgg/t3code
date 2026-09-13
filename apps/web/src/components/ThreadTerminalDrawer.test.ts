import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  terminalContextMenuItems,
  terminalSelectionLineRange,
  terminalSelectionMenuItems,
  terminalThemeFromApp,
} from "./ThreadTerminalDrawer";

describe("terminal selection menus", () => {
  it("omits Add to chat when the terminal has no chat target", () => {
    expect(terminalSelectionMenuItems().map(({ id }) => id)).toEqual(["add-to-chat", "copy"]);
    expect(terminalContextMenuItems({ hasSelection: true }).map(({ id }) => id)).toEqual([
      "add-to-chat",
      "copy",
      "paste",
    ]);

    expect(terminalSelectionMenuItems({ canAddToChat: false }).map(({ id }) => id)).toEqual([
      "copy",
    ]);
    expect(
      terminalContextMenuItems({ hasSelection: true, canAddToChat: false }).map(({ id }) => id),
    ).toEqual(["copy", "paste"]);
  });
});

describe("terminalThemeFromApp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses terminal colors inherited by the mount instead of a light document theme", () => {
    const root = { classList: { contains: () => false } };
    const body = {};
    const drawer = {};
    let canvasColor = "#000";
    const colors: Record<string, [number, number, number, number]> = {
      "#000": [0, 0, 0, 255],
      "#fff": [255, 255, 255, 255],
      "#ddd": [221, 221, 221, 255],
      "#111": [17, 17, 17, 255],
    };

    vi.stubGlobal("document", {
      documentElement: root,
      body,
      querySelector: () => drawer,
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect: () => undefined,
          fillRect: () => undefined,
          get fillStyle() {
            return canvasColor;
          },
          set fillStyle(value: string) {
            canvasColor = value;
          },
          getImageData: () => ({ data: colors[canvasColor] ?? [0, 0, 0, 0] }),
        }),
      }),
    });
    vi.stubGlobal("getComputedStyle", (element: object) => {
      const local = element === drawer;
      const values = local
        ? {
            "--terminal-background": "#000",
            "--terminal-foreground": "#fff",
            "--terminal-cursor": "#ddd",
            "--terminal-selection-background": "rgba(255, 255, 255, 0.2)",
          }
        : {
            "--terminal-background": "#fff",
            "--terminal-foreground": "#111",
          };
      return {
        backgroundColor: local ? "#000" : "#fff",
        color: local ? "#fff" : "#111",
        colorScheme: local ? "dark" : "light",
        getPropertyValue: (name: string) => values[name as keyof typeof values] ?? "",
      };
    });

    const theme = terminalThemeFromApp();

    expect(theme.background).toEqual({ r: 0, g: 0, b: 0 });
    expect(theme.foreground).toEqual({ r: 255, g: 255, b: 255 });
    expect(theme.cursor).toEqual({ r: 221, g: 221, b: 221 });
  });
});

describe("terminal selection actions", () => {
  it("clears a pending or currently owned menu when the selection disappears", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: true,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(true);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 4,
        currentRequestId: 4,
      }),
    ).toBe(true);
  });

  it("does not let an old selection popup cancel its replacement right-click menu", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 3,
        currentRequestId: 4,
      }),
    ).toBe(false);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(false);
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
