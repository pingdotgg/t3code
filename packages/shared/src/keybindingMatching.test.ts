import { describe, expect, it } from "vite-plus/test";

import {
  isMacPlatform,
  matchesKeybindingShortcut,
  matchesKeybindingShortcutModifiers,
  normalizeEventKey,
  resolveEventKeys,
  shortcutKeyFromEvent,
  type ShortcutEventLike,
} from "./keybindingMatching.ts";

const event = (key: string, overrides: Partial<ShortcutEventLike> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe("isMacPlatform", () => {
  it("matches mac and iOS platform strings case-insensitively", () => {
    expect(isMacPlatform("darwin")).toBe(false);
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPhone")).toBe(true);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });
});

describe("normalizeEventKey", () => {
  it("lowercases and aliases esc to escape", () => {
    expect(normalizeEventKey("Esc")).toBe("escape");
    expect(normalizeEventKey("ArrowDown")).toBe("arrowdown");
  });
});

describe("shortcutKeyFromEvent", () => {
  it("prefers the layout key for plain letters", () => {
    expect(shortcutKeyFromEvent(event("q", { code: "KeyW" }))).toBe("q");
  });

  it("falls back to the physical code when the key is unidentified", () => {
    expect(shortcutKeyFromEvent(event("Unidentified", { code: "Comma" }))).toBe(",");
  });

  it("keeps an unshifted + as a zoom key unless it came from a digit row", () => {
    expect(shortcutKeyFromEvent(event("+", { code: "Equal" }))).toBe("+");
    // Czech layouts type + on Digit1 — that resolves to the digit instead.
    expect(shortcutKeyFromEvent(event("+", { code: "Digit1" }))).toBe("1");
    // Shifted + is an ordinary shifted key, resolved by code.
    expect(shortcutKeyFromEvent(event("+", { code: "Equal", shiftKey: true }))).toBe("=");
  });
});

describe("resolveEventKeys", () => {
  it("includes the layout key, the physical letter, and the shortcut key", () => {
    // A Dvorak layout where the KeyW position types a comma.
    const keys = resolveEventKeys(event(",", { code: "KeyW" }));
    expect(keys.has(",")).toBe(true);
    expect(keys.has("w")).toBe(true);
  });

  it("does not add a physical letter when the layout key is already a letter", () => {
    const keys = resolveEventKeys(event("q", { code: "KeyW" }));
    expect(keys.has("w")).toBe(false);
  });
});

describe("matchesKeybindingShortcutModifiers", () => {
  const modifiers = (m: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }) => ({
    metaKey: m.meta ?? false,
    ctrlKey: m.ctrl ?? false,
    shiftKey: m.shift ?? false,
    altKey: m.alt ?? false,
  });
  const shortcut = {
    key: "s",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
  };

  it("maps modKey to meta on mac and ctrl elsewhere", () => {
    expect(
      matchesKeybindingShortcutModifiers(modifiers({ meta: true }), shortcut, "MacIntel"),
    ).toBe(true);
    expect(
      matchesKeybindingShortcutModifiers(modifiers({ ctrl: true }), shortcut, "MacIntel"),
    ).toBe(false);
    expect(matchesKeybindingShortcutModifiers(modifiers({ ctrl: true }), shortcut, "Win32")).toBe(
      true,
    );
    expect(matchesKeybindingShortcutModifiers(modifiers({ meta: true }), shortcut, "Win32")).toBe(
      false,
    );
  });

  it("requires every modifier flag to match", () => {
    const explicit = { ...shortcut, modKey: false, ctrlKey: true, shiftKey: true };
    expect(
      matchesKeybindingShortcutModifiers(modifiers({ ctrl: true, shift: true }), explicit, "Win32"),
    ).toBe(true);
    expect(
      matchesKeybindingShortcutModifiers(modifiers({ ctrl: true, alt: true }), explicit, "Win32"),
    ).toBe(false);
  });
});

describe("matchesKeybindingShortcut", () => {
  const shortcut = {
    key: "s",
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    modKey: false,
  };

  it("matches when modifiers and key agree", () => {
    expect(matchesKeybindingShortcut(event("s", { ctrlKey: true }), shortcut, "Win32")).toBe(true);
    expect(matchesKeybindingShortcut(event("s"), shortcut, "Win32")).toBe(false);
  });

  it("rejects AltGraph chorded non-alphanumeric keys on non-mac platforms", () => {
    const altGraphEvent = {
      ...event("€", { ctrlKey: true, altKey: true }),
      getModifierState: (k: "AltGraph") => k === "AltGraph",
    };
    const withAlt = { ...shortcut, key: "€", ctrlKey: true, altKey: true };
    expect(matchesKeybindingShortcut(altGraphEvent, withAlt, "Win32")).toBe(false);
    // macOS doesn't apply the AltGraph guard.
    const macEvent = { ...altGraphEvent, ctrlKey: true, metaKey: false };
    expect(matchesKeybindingShortcut(macEvent, { ...withAlt, key: "€" }, "MacIntel")).toBe(true);
  });
});
