import { describe, expect, it } from "vite-plus/test";

import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  terminalLinkChatText,
  terminalLinkCopyText,
  terminalSelectionLineRange,
} from "./ThreadTerminalDrawer";

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

  it("leaves URLs intact regardless of scheme casing", () => {
    expect(terminalLinkChatText("HTTPS://t3.codes/docs", "/Users/olive/project")).toBe(
      "HTTPS://t3.codes/docs",
    );
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
