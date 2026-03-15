import { assert, describe, it } from "vitest";

import {
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
  type TerminalClipboardShortcutEvent,
} from "./terminalClipboard";

function event(
  overrides: Partial<TerminalClipboardShortcutEvent> = {},
): TerminalClipboardShortcutEvent {
  return {
    key: "c",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("isTerminalCopyShortcut", () => {
  it("copies selected terminal text with Ctrl+C on Windows", () => {
    assert.isTrue(isTerminalCopyShortcut(event({ ctrlKey: true }), true, "Win32"));
  });

  it("does not override Ctrl+C when nothing is selected on Windows", () => {
    assert.isFalse(isTerminalCopyShortcut(event({ ctrlKey: true }), false, "Win32"));
  });

  it("matches Ctrl+Shift+C without requiring a selection on Windows", () => {
    assert.isTrue(
      isTerminalCopyShortcut(event({ ctrlKey: true, shiftKey: true }), false, "Win32"),
    );
  });

  it("matches Cmd+C only when selected text exists on macOS", () => {
    assert.isTrue(isTerminalCopyShortcut(event({ metaKey: true }), true, "MacIntel"));
    assert.isFalse(isTerminalCopyShortcut(event({ metaKey: true }), false, "MacIntel"));
  });

  it("matches Ctrl+Insert as a copy shortcut on non-macOS", () => {
    assert.isTrue(isTerminalCopyShortcut(event({ key: "Insert", ctrlKey: true }), true, "Linux"));
  });
});

describe("isTerminalPasteShortcut", () => {
  it("matches Ctrl+Shift+V on Windows", () => {
    assert.isTrue(
      isTerminalPasteShortcut(event({ key: "v", ctrlKey: true, shiftKey: true }), "Win32"),
    );
  });

  it("matches Shift+Insert on non-macOS", () => {
    assert.isTrue(isTerminalPasteShortcut(event({ key: "Insert", shiftKey: true }), "Linux"));
  });

  it("matches Cmd+V on macOS", () => {
    assert.isTrue(isTerminalPasteShortcut(event({ key: "v", metaKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isFalse(
      isTerminalPasteShortcut(
        event({ type: "keyup", key: "v", ctrlKey: true, shiftKey: true }),
        "Win32",
      ),
    );
  });
});
