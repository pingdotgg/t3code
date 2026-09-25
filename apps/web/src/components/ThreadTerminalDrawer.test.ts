import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  terminalContextMenuItems,
  terminalSelectionLineRange,
  terminalSelectionMenuItems,
  terminalThemeFromApp,
  terminalLinkChatText,
  terminalLinkCopyText,
  terminalLinkTargetForEditor,
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

describe("terminal link menus", () => {
  it("adds path actions before selection actions", () => {
    const items = terminalContextMenuItems({
      hasSelection: true,
      link: { text: "src/main.ts:12", editorLabel: "Open in VS Code" },
    });

    expect(items.map(({ id }) => id)).toEqual([
      "open-terminal-path",
      "add-terminal-path-to-chat",
      "copy-terminal-path",
      "add-to-chat",
      "copy",
      "paste",
    ]);
    expect(items[0]).toMatchObject({ id: "open-terminal-path", label: "Open in VS Code" });
    expect(items.find(({ id }) => id === "add-to-chat")).toMatchObject({
      separatorBefore: true,
    });
    expect(items.slice(0, 3).every((item) => !item.separatorBefore)).toBe(true);
  });

  it.each([
    ["with reveal", "Reveal in Finder", true],
    ["without reveal", undefined, false],
  ])("handles path reveal action %s", (_name, revealLabel, hasReveal) => {
    const items = terminalContextMenuItems({
      hasSelection: true,
      link: { text: "src/main.ts:12", ...(revealLabel ? { revealLabel } : {}) },
    });
    const ids = items.map(({ id }) => id);
    expect(ids.includes("reveal-terminal-path")).toBe(hasReveal);
    if (hasReveal) {
      expect(ids.indexOf("reveal-terminal-path")).toBe(ids.indexOf("open-terminal-path") + 1);
    }
  });

  it("does not add reveal action to URL links", () => {
    expect(
      terminalContextMenuItems({
        hasSelection: true,
        link: { text: "https://example.com", revealLabel: "Reveal in Finder" },
      }).map(({ id }) => id),
    ).not.toContain("reveal-terminal-path");
  });

  it("keeps the selection menu unchanged when there is no link", () => {
    const items = terminalContextMenuItems({ hasSelection: true });

    expect(items.map(({ id }) => id)).toEqual(["add-to-chat", "copy", "paste"]);
    expect(items.every((item) => !item.separatorBefore)).toBe(true);
  });

  it("omits URL chat actions when adding to chat is unavailable", () => {
    const items = terminalContextMenuItems({
      hasSelection: true,
      canAddToChat: false,
      link: { text: "https://example.com", canOpenPreview: true },
    });

    expect(items.map(({ id }) => id)).not.toContain("add-terminal-link-to-chat");
    expect(items.map(({ id }) => id)).not.toContain("add-to-chat");
  });

  it("gates the link add-to-chat item separately from the selection one", () => {
    const ids = terminalContextMenuItems({
      hasSelection: true,
      link: { text: "src/main.ts", canAddToChat: false },
    }).map(({ id }) => id);

    expect(ids).not.toContain("add-terminal-path-to-chat");
    expect(ids).toContain("add-to-chat");
  });

  it("places URL actions before selection actions", () => {
    expect(
      terminalContextMenuItems({
        hasSelection: true,
        link: { text: "https://example.com", canOpenPreview: true },
      }).map(({ id }) => id),
    ).toEqual([
      "open-terminal-link-preview",
      "open-terminal-link-browser",
      "add-terminal-link-to-chat",
      "copy-terminal-link",
      "add-to-chat",
      "copy",
      "paste",
    ]);
  });

  it("serializes paths for chat and strips positions for copying", () => {
    expect(terminalLinkChatText("src/main.ts:12:3", "/repo")).toContain("src/main.ts");
    expect(terminalLinkChatText("/", "/repo")).toBe("/");
    expect(terminalLinkChatText("src\\", "/repo")).toBe("[src](/repo/src)");
    expect(terminalLinkChatText("C:\\", "C:\\repo")).toBe("C:\\");
    expect(terminalLinkChatText("https://example.com/a", "/repo")).toBe("https://example.com/a");
    expect(terminalLinkCopyText("src/main.ts:12:3")).toBe("src/main.ts");
    expect(terminalLinkCopyText("https://example.com:8080/a")).toBe("https://example.com:8080/a");
  });

  it("keeps Windows directory paths as directory links", () => {
    expect(terminalLinkChatText("C:\\work\\", "C:\\repo")).toBe("C:\\work\\");
  });

  it("strips positions only for the file manager", () => {
    expect(terminalLinkTargetForEditor("/repo/src/main.ts:12:3", "file-manager")).toBe(
      "/repo/src/main.ts",
    );
    expect(terminalLinkTargetForEditor("/repo/src/main.ts:12:3", "vscode")).toBe(
      "/repo/src/main.ts:12:3",
    );
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
