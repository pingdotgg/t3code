import { describe, expect, it } from "vite-plus/test";

import {
  ghosttyControlShortcutCodepoint,
  ghosttyKeyForCode,
  ghosttyUnshiftedCodepoint,
} from "./keyCodes";

describe("ghosttyKeyForCode", () => {
  it("keeps the tail of the pinned Ghostty key enum in order", () => {
    expect(ghosttyKeyForCode("F25")).toBe(ghosttyKeyForCode("F24") + 1);
    expect(ghosttyKeyForCode("PrintScreen")).toBe(ghosttyKeyForCode("FnLock") + 1);
    expect(ghosttyKeyForCode("Pause")).toBe(ghosttyKeyForCode("ScrollLock") + 1);
    expect(ghosttyKeyForCode("Paste")).toBe(ghosttyKeyForCode("Cut") + 1);
  });
});

describe("ghosttyUnshiftedCodepoint", () => {
  it("provides the logical base character for Kitty keyboard encoding", () => {
    expect(ghosttyUnshiftedCodepoint({ code: "KeyC", key: "c", shiftKey: false })).toBe(
      "c".codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: "KeyC", key: "C", shiftKey: true })).toBe(
      "c".codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: "Digit1", key: "!", shiftKey: true })).toBe(
      "1".codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: "Slash", key: "?", shiftKey: true })).toBe(
      "/".codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: "Digit1", key: "&", shiftKey: false })).toBe(
      "&".codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: "Enter", key: "Enter", shiftKey: false })).toBe(0);
  });

  it("reports unknown instead of the shifted character without layout data", () => {
    expect(ghosttyUnshiftedCodepoint({ code: "Digit7", key: "/", shiftKey: true })).toBe(0);
    expect(ghosttyUnshiftedCodepoint({ code: "KeyD", key: "Д", shiftKey: true })).toBe(
      "д".codePointAt(0),
    );
  });

  it("prefers the active browser layout over US physical key positions", () => {
    const layoutMap = new Map([
      ["Digit1", "&"],
      ["KeyC", "j"],
    ]);
    expect(ghosttyUnshiftedCodepoint({ code: "Digit1", key: "1", shiftKey: true }, layoutMap)).toBe(
      "&".codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: "KeyC", key: "J", shiftKey: true }, layoutMap)).toBe(
      "j".codePointAt(0),
    );
  });
});

describe("ghosttyControlShortcutCodepoint", () => {
  const event = (overrides: Partial<KeyboardEvent> = {}) => ({
    code: "KeyA",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  });

  it("uses physical A and E positions independently of the active layout", () => {
    expect(ghosttyControlShortcutCodepoint(event({ code: "KeyA", key: "ф" }))).toBe(
      "a".codePointAt(0),
    );
    expect(ghosttyControlShortcutCodepoint(event({ code: "KeyE", key: "ε" }))).toBe(
      "e".codePointAt(0),
    );
  });

  it("leaves other and additionally modified chords to normal encoding", () => {
    expect(ghosttyControlShortcutCodepoint(event({ code: "KeyC" }))).toBeUndefined();
    expect(ghosttyControlShortcutCodepoint(event({ shiftKey: true }))).toBeUndefined();
    expect(ghosttyControlShortcutCodepoint(event({ altKey: true }))).toBeUndefined();
    expect(ghosttyControlShortcutCodepoint(event({ metaKey: true }))).toBeUndefined();
    expect(ghosttyControlShortcutCodepoint(event({ ctrlKey: false }))).toBeUndefined();
  });
});
