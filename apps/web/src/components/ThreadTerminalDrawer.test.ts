import { describe, expect, it } from "vite-plus/test";

import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  terminalContextMenuItems,
  terminalFileManagerPath,
  terminalLinkChatText,
  terminalLinkCopyText,
  terminalSelectionLineRange,
} from "./ThreadTerminalDrawer";

describe("terminalFileManagerPath", () => {
  it("resolves relative paths and removes terminal positions", () => {
    expect(terminalFileManagerPath("src/index.ts:12:3", "/Users/olive/project")).toBe(
      "/Users/olive/project/src/index.ts",
    );
  });
});

describe("terminalLinkCopyText", () => {
  it("removes terminal positions from paths", () => {
    expect(terminalLinkCopyText("src/index.ts:12:3")).toBe("src/index.ts");
  });

  it("leaves URLs intact", () => {
    expect(terminalLinkCopyText("https://t3.codes/docs#terminal")).toBe(
      "https://t3.codes/docs#terminal",
    );
  });
});

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

  it("keeps a Windows drive root intact", () => {
    const separator = String.fromCharCode(92);
    expect(
      terminalLinkChatText(
        `C:${separator}`,
        `C:${separator}Users${separator}olive${separator}project`,
      ),
    ).toBe("[](C:%5C)");
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
      canOpenInPreview: false,
      openLabel: "Open in Zed",
      revealLabel: "Reveal in Finder",
    };

    expect(terminalContextMenuItems(options)).toEqual([
      { id: "open-link", label: "Open in Zed" },
      { id: "reveal-link", label: "Reveal in Finder" },
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
      canOpenInPreview: true,
      openLabel: "Open in editor",
      revealLabel: null,
    };

    expect(terminalContextMenuItems(options)).toEqual([
      { id: "open-link-in-preview", label: "Open in integrated browser" },
      { id: "open-link-external", label: "Open in system browser" },
      { id: "add-link-to-chat", label: "Add link to chat" },
      { id: "copy-link", label: "Copy link", icon: "copy" },
      { id: "add-to-chat", label: "Add to chat", disabled: false },
      { id: "copy", label: "Copy", disabled: false },
      { id: "paste", label: "Paste" },
    ]);
  });

  it("omits file-manager actions when reveal is unavailable", () => {
    expect(
      terminalContextMenuItems({
        hasSelection: false,
        link: "src/index.ts",
        canOpenInPreview: false,
        openLabel: "Open in editor",
        revealLabel: null,
      }),
    ).toEqual([
      { id: "open-link", label: "Open in editor" },
      { id: "add-link-to-chat", label: "Add path to chat" },
      { id: "copy-link", label: "Copy path", icon: "copy" },
      { id: "add-to-chat", label: "Add to chat", disabled: true },
      { id: "copy", label: "Copy", disabled: true },
      { id: "paste", label: "Paste" },
    ]);
  });

  it("omits selection chat actions when no chat target is available", () => {
    expect(
      terminalContextMenuItems({
        hasSelection: true,
        link: null,
        canOpenInPreview: false,
        openLabel: "Open in editor",
        revealLabel: null,
        canAddToChat: false,
      }),
    ).toEqual([
      { id: "copy", label: "Copy", disabled: false },
      { id: "paste", label: "Paste" },
    ]);
  });

  it("omits link chat actions when no chat target is available", () => {
    expect(
      terminalContextMenuItems({
        hasSelection: false,
        link: "https://t3.codes",
        canAddLinkToChat: false,
        canOpenInPreview: false,
        openLabel: "Open in editor",
        revealLabel: null,
      }),
    ).toEqual([
      { id: "open-link-external", label: "Open in system browser" },
      { id: "copy-link", label: "Copy link", icon: "copy" },
      { id: "add-to-chat", label: "Add to chat", disabled: true },
      { id: "copy", label: "Copy", disabled: true },
      { id: "paste", label: "Paste" },
    ]);
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
