import type { KeybindingShortcut } from "@t3tools/contracts";

// Matching only: the desktop preview guest bundles this file without the rest of the
// keybindings module, so it stays free of parsing, defaults, and contracts runtime code.

export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  type?: string;
  code?: string;
  key: string;
  repeat?: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

export type ShortcutKeyboardLayoutMap = Pick<ReadonlyMap<string, string>, "get">;

export function shortcutKeyFromEvent(
  event: Pick<ShortcutEventLike, "key" | "code">,
  keyboardLayoutMap?: ShortcutKeyboardLayoutMap,
): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const mappedKey = event.code ? keyboardLayoutMap?.get(event.code)?.toLowerCase() : undefined;
  if (mappedKey && /^[a-z]$/.test(mappedKey)) return mappedKey;
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

export function resolveEventKeys(
  event: ShortcutEventLike,
  keyboardLayoutMap?: ShortcutKeyboardLayoutMap,
): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  const shortcutKey = shortcutKeyFromEvent(event, keyboardLayoutMap);
  if (letterCode && !/^[a-z]$/.test(shortcutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  keys.add(shortcutKey);
  // Layout letters supplement, rather than replace, physical punctuation shortcuts.
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

export function matchesKeybindingShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

export function matchesKeybindingShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform: string,
  keyboardLayoutMap?: ShortcutKeyboardLayoutMap,
): boolean {
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  if (!matchesKeybindingShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(
    event,
    isMacPlatform(platform) && event.altKey ? keyboardLayoutMap : undefined,
  ).has(shortcut.key);
}
