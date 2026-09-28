import { describe, expect, it } from "vite-plus/test";

import keyEventHeader from "../../../../../native/libghostty-vt/include/ghostty/vt/key/event.h?raw";
import { ghosttyConsumedMods, ghosttyKeyForCode, ghosttyUnshiftedCodepoint } from "./keyCodes";

// GhosttyKey enumerators in declaration order, so each index is its value.
const pinnedGhosttyKeys = Array.from(
  keyEventHeader
    .slice(
      keyEventHeader.indexOf("GHOSTTY_KEY_UNIDENTIFIED"),
      keyEventHeader.indexOf("GHOSTTY_KEY_MAX_VALUE"),
    )
    .matchAll(/GHOSTTY_KEY_\w+/g),
  (match) => match[0],
);

describe("ghosttyKeyForCode", () => {
  it("keeps the tail of the pinned Ghostty key enum in order", () => {
    for (const code of ["F24", "F25", "FnLock", "PrintScreen", "ScrollLock", "Pause", "Paste"]) {
      const enumerator = `GHOSTTY_KEY_${code.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
      expect(ghosttyKeyForCode(code)).toBe(pinnedGhosttyKeys.indexOf(enumerator));
    }
  });
});

describe("ghosttyConsumedMods", () => {
  const shifted = { altKey: false, ctrlKey: false, key: "@", metaKey: false, shiftKey: true };

  it("only consumes a lone Shift producing a character", () => {
    expect(ghosttyConsumedMods(shifted)).toBe(1);
    expect(ghosttyConsumedMods({ ...shifted, ctrlKey: true })).toBe(0);
    expect(ghosttyConsumedMods({ ...shifted, key: "Tab" })).toBe(0);
    // Deliberate: Shift+Space collapses to Space so it still types one.
    expect(ghosttyConsumedMods({ ...shifted, key: " " })).toBe(1);
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
