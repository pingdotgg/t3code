import { describe, expect, it } from "vite-plus/test";
import ghosttyKeyHeader from "../../../../../native/libghostty-vt/include/ghostty/vt/key/event.h?raw";

import {
  ghosttyConsumedMods,
  ghosttyKeyForCode,
  ghosttyKeyForEvent,
  ghosttyUnshiftedCodepoint,
} from "./keyCodes";

describe("ghosttyKeyForCode", () => {
  it("matches the pinned native key enum after the function keys", () => {
    const enumBody = ghosttyKeyHeader.slice(
      ghosttyKeyHeader.indexOf("GHOSTTY_KEY_UNIDENTIFIED"),
      ghosttyKeyHeader.indexOf("GHOSTTY_KEY_MAX_VALUE"),
    );
    const keys = [...enumBody.matchAll(/GHOSTTY_KEY_([A-Z0-9_]+)/g)].map((match) => match[1]);
    for (const [code, native] of [
      ["F24", "F24"],
      ["F25", "F25"],
      ["FnLock", "FN_LOCK"],
      ["PrintScreen", "PRINT_SCREEN"],
      ["ScrollLock", "SCROLL_LOCK"],
      ["Pause", "PAUSE"],
      ["Paste", "PASTE"],
    ]) {
      expect(keys).toContain(native);
      expect(ghosttyKeyForCode(code!)).toBe(keys.indexOf(native));
    }
  });
});

describe("ghosttyKeyForEvent", () => {
  it("prefers recognized physical codes over logical keys", () => {
    expect(ghosttyKeyForEvent({ code: "Delete", key: "Backspace" })).toBe(
      ghosttyKeyForCode("Delete"),
    );
    expect(ghosttyKeyForEvent({ code: "NumpadEnter", key: "Enter" })).toBe(
      ghosttyKeyForCode("NumpadEnter"),
    );
  });
});

describe("ghosttyConsumedMods", () => {
  const shifted = { altKey: false, ctrlKey: false, key: "@", metaKey: false, shiftKey: true };

  it("only consumes a lone Shift producing a character", () => {
    expect(ghosttyConsumedMods(shifted)).toBe(1);
    expect(ghosttyConsumedMods({ ...shifted, ctrlKey: true })).toBe(0);
    expect(ghosttyConsumedMods({ ...shifted, key: "Tab" })).toBe(0);
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
