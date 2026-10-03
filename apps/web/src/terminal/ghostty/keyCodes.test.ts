import { describe, expect, it } from "vite-plus/test";

import {
  ghosttyConsumedMods,
  ghosttyEncoderMods,
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

describe("ghosttyConsumedMods", () => {
  const shifted = { altKey: false, ctrlKey: false, key: "@", metaKey: false, shiftKey: true };

  it("consumes a lone Shift producing a character", () => {
    expect(ghosttyConsumedMods(shifted, "Linux")).toBe(1);
    expect(ghosttyConsumedMods({ ...shifted, ctrlKey: true }, "MacIntel")).toBe(0);
    expect(ghosttyConsumedMods({ ...shifted, key: "Tab" }, "MacIntel")).toBe(0);
    // Deliberate: Shift+Space collapses to Space so it still types one.
    expect(ghosttyConsumedMods({ ...shifted, key: " " }, "Linux")).toBe(1);
  });

  it("consumes a lone macOS Option that produced a character", () => {
    const option = { altKey: true, ctrlKey: false, key: "@", metaKey: false, shiftKey: false };
    expect(ghosttyConsumedMods(option, "MacIntel")).toBe(1 << 2);
    expect(ghosttyConsumedMods(option, "iPhone")).toBe(1 << 2);
    expect(ghosttyConsumedMods({ ...option, key: "€" }, "MacIntel")).toBe(1 << 2);
    expect(ghosttyConsumedMods({ ...option, key: "\\", shiftKey: true }, "MacIntel")).toBe(
      (1 << 2) | 1,
    );
    expect(ghosttyConsumedMods({ ...option, ctrlKey: true }, "MacIntel")).toBe(0);
    expect(ghosttyConsumedMods({ ...option, metaKey: true }, "MacIntel")).toBe(0);
    expect(ghosttyConsumedMods({ ...option, key: "ArrowLeft" }, "MacIntel")).toBe(0);
    expect(ghosttyConsumedMods({ ...option, key: "Dead" }, "MacIntel")).toBe(0);
    expect(ghosttyConsumedMods(option, "Linux")).toBe(0);
    expect(ghosttyConsumedMods(option, "Win32")).toBe(0);
    expect(ghosttyConsumedMods({ ...option, shiftKey: true }, "Linux")).toBe(0);
  });
});

describe("ghosttyEncoderMods", () => {
  const locksOff = { getModifierState: () => false };

  it("drops consumed Option from the raw mask and keeps a lone Shift", () => {
    expect(
      ghosttyEncoderMods(
        { ...locksOff, altKey: true, ctrlKey: false, key: "@", metaKey: false, shiftKey: false },
        "MacIntel",
      ),
    ).toEqual({ mods: 0, consumedMods: 1 << 2 });
    expect(
      ghosttyEncoderMods(
        { ...locksOff, altKey: true, ctrlKey: false, key: "\\", metaKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toEqual({ mods: 0, consumedMods: (1 << 2) | 1 });
    expect(
      ghosttyEncoderMods(
        { ...locksOff, altKey: false, ctrlKey: false, key: "A", metaKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toEqual({ mods: 1, consumedMods: 1 });
    expect(
      ghosttyEncoderMods(
        { ...locksOff, altKey: true, ctrlKey: true, key: "a", metaKey: false, shiftKey: false },
        "MacIntel",
      ),
    ).toEqual({ mods: (1 << 1) | (1 << 2), consumedMods: 0 });
    expect(
      ghosttyEncoderMods(
        { ...locksOff, altKey: true, ctrlKey: false, key: "@", metaKey: false, shiftKey: false },
        "Linux",
      ),
    ).toEqual({ mods: 1 << 2, consumedMods: 0 });
    expect(
      ghosttyEncoderMods(
        {
          ...locksOff,
          altKey: true,
          ctrlKey: false,
          key: "ArrowLeft",
          metaKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toEqual({ mods: 1 << 2, consumedMods: 0 });
  });

  it("keeps lock modifiers that did not compose the character", () => {
    expect(
      ghosttyEncoderMods(
        {
          altKey: true,
          ctrlKey: false,
          key: "@",
          metaKey: false,
          shiftKey: false,
          getModifierState: (key) => key === "CapsLock",
        },
        "MacIntel",
      ),
    ).toEqual({ mods: 1 << 4, consumedMods: 1 << 2 });
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
