import { describe, expect, it } from "vitest";

import {
  isTerminalClearShortcut,
  isTerminalToggleShortcut,
  type ShortcutEventLike,
} from "./terminal-shortcuts";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("isTerminalToggleShortcut", () => {
  it("matches Cmd+J on macOS", () => {
    expect(
      isTerminalToggleShortcut(event({ metaKey: true }), "MacIntel"),
    ).toBe(true);
  });

  it("matches Ctrl+J on non-macOS", () => {
    expect(
      isTerminalToggleShortcut(event({ ctrlKey: true }), "Win32"),
    ).toBe(true);
  });

  it("rejects wrong modifiers", () => {
    expect(
      isTerminalToggleShortcut(
        event({ ctrlKey: true, shiftKey: true }),
        "Win32",
      ),
    ).toBe(false);
    expect(
      isTerminalToggleShortcut(event({ metaKey: true, altKey: true }), "MacIntel"),
    ).toBe(false);
  });

  it("rejects non-j keys", () => {
    expect(
      isTerminalToggleShortcut(event({ key: "k", ctrlKey: true }), "Linux"),
    ).toBe(false);
  });
});

describe("isTerminalClearShortcut", () => {
  it("matches Ctrl+L on all platforms", () => {
    expect(
      isTerminalClearShortcut(event({ key: "l", ctrlKey: true }), "Linux"),
    ).toBe(true);
    expect(
      isTerminalClearShortcut(event({ key: "l", ctrlKey: true }), "MacIntel"),
    ).toBe(true);
  });

  it("matches Cmd+K on macOS", () => {
    expect(
      isTerminalClearShortcut(event({ key: "k", metaKey: true }), "MacIntel"),
    ).toBe(true);
  });

  it("rejects Cmd+K on non-macOS", () => {
    expect(
      isTerminalClearShortcut(event({ key: "k", metaKey: true }), "Win32"),
    ).toBe(false);
  });

  it("rejects wrong modifiers", () => {
    expect(
      isTerminalClearShortcut(
        event({ key: "l", ctrlKey: true, shiftKey: true }),
        "Linux",
      ),
    ).toBe(false);
    expect(
      isTerminalClearShortcut(
        event({ key: "k", metaKey: true, altKey: true }),
        "MacIntel",
      ),
    ).toBe(false);
  });
});
