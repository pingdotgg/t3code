import { describe, expect, it } from "vite-plus/test";

import { ghosttyConsumedMods, ghosttyKeyForCode, ghosttyUnshiftedCodepoint } from "./keyCodes";

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

describe("ghosttyConsumedMods", () => {
  it("marks Shift consumed when it produces a different printable character", () => {
    expect(ghosttyConsumedMods({ key: ":", shiftKey: true }, ";".codePointAt(0)!)).toBe(1);
    expect(ghosttyConsumedMods({ key: "C", shiftKey: true }, "c".codePointAt(0)!)).toBe(1);
  });

  it("uses the active layout's unshifted character", () => {
    const event = { code: "Period", key: ":", shiftKey: true };
    const unshiftedCodepoint = ghosttyUnshiftedCodepoint(event, new Map([["Period", "."]]));
    expect(ghosttyConsumedMods(event, unshiftedCodepoint)).toBe(1);
  });

  it("preserves Shift when it did not transform printable text", () => {
    expect(ghosttyConsumedMods({ key: " ", shiftKey: true }, " ".codePointAt(0)!)).toBe(0);
    expect(ghosttyConsumedMods({ key: "Tab", shiftKey: true }, 0)).toBe(0);
    expect(ghosttyConsumedMods({ key: ":", shiftKey: false }, ":".codePointAt(0)!)).toBe(0);
  });
});
