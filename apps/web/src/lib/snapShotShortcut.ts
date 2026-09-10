import {
  isModifierPairShortcut,
  snapShotModifierPairLabel,
  snapShotShortcutModifierPair,
  type KeybindingShortcut,
  type SnapShotModifier,
  type SnapShotShortcut,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import { formatShortcutKeyLabel, formatShortcutLabel, shortcutConflictKey } from "../keybindings";
import { isMacPlatform, isWindowsPlatform } from "./utils";

const DESKTOP_KEY_ALIASES: Readonly<Record<string, string>> = {
  return: "enter",
  page_up: "pageup",
  page_down: "pagedown",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  plus: "+",
  minus: "-",
};

/** Portal labels are descriptions, not a keybinding protocol. Only parse known key notation. */
export function parseDesktopSnapShotShortcut(label: string): KeybindingShortcut | null {
  const text = label.trim().replace(/^Press\s+/i, "");
  if (!text) return null;
  const gtk = text.match(/^((?:<[^<>]+>)+)([^<>]+)$/);
  const input = (gtk ? gtk[1]!.replace(/<([^<>]+)>/g, "$1+") + gtk[2]! : text).replace(
    /\b(super|win|primary)\b/gi,
    (modifier) => (modifier.toLowerCase() === "primary" ? "ctrl" : "meta"),
  );
  if (input !== "+" && input.endsWith("+") && !input.endsWith("++")) return null;
  const shortcut = parseKeybindingShortcut(input);
  if (!shortcut) return null;
  const key = DESKTOP_KEY_ALIASES[shortcut.key] ?? shortcut.key;
  if (
    key !== " " &&
    !/^[^\s<>]$/u.test(key) &&
    !/^(?:f(?:[1-9]|1\d|2[0-4])|enter|tab|escape|backspace|delete|insert|home|end|pageup|pagedown|arrow(?:left|right|up|down)|pause|printscreen)$/i.test(
      key,
    )
  ) {
    return null;
  }
  return { ...shortcut, key };
}

export function formatSnapShotShortcutLabel(
  shortcut: SnapShotShortcut,
  platform = navigator.platform,
): string {
  return isModifierPairShortcut(shortcut)
    ? snapShotModifierPairLabel(snapShotShortcutModifierPair(shortcut), isMacPlatform(platform))
    : formatShortcutLabel(shortcut, platform);
}

function modifierKeyLabel(modifier: SnapShotModifier, platform: string): string {
  if (modifier === "shift") return "⇧";
  if (isMacPlatform(platform)) {
    if (modifier === "meta") return "⌘";
    if (modifier === "control") return "⌃";
    return "⌥";
  }
  if (modifier === "meta") return isWindowsPlatform(platform) ? "⊞" : "Super";
  return modifier === "control" ? "Ctrl" : "Alt";
}

export function snapShotShortcutKeyLabels(
  shortcut: SnapShotShortcut,
  platform = navigator.platform,
): readonly string[] {
  if (isModifierPairShortcut(shortcut)) {
    const label = modifierKeyLabel(snapShotShortcutModifierPair(shortcut), platform);
    return [label, label];
  }

  const useMetaForMod = isMacPlatform(platform);
  const modifiers: readonly [boolean, SnapShotModifier][] = [
    [shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod), "control"],
    [shortcut.altKey, "alt"],
    [shortcut.shiftKey, "shift"],
    [shortcut.metaKey || (shortcut.modKey && useMetaForMod), "meta"],
  ];
  return [
    ...modifiers
      .filter(([enabled]) => enabled)
      .map(([, modifier]) => modifierKeyLabel(modifier, platform)),
    formatShortcutKeyLabel(shortcut.key),
  ];
}

export function sameSnapShotShortcut(
  left: SnapShotShortcut,
  right: SnapShotShortcut,
  platform = navigator.platform,
): boolean {
  if (isModifierPairShortcut(left) || isModifierPairShortcut(right)) {
    return (
      isModifierPairShortcut(left) &&
      isModifierPairShortcut(right) &&
      snapShotShortcutModifierPair(left) === snapShotShortcutModifierPair(right)
    );
  }
  return shortcutConflictKey(left, platform) === shortcutConflictKey(right, platform);
}

export function snapShotKeybindingConflict<Command extends string>(
  shortcut: SnapShotShortcut,
  keybindings: ReadonlyArray<{ readonly command: Command; readonly shortcut: KeybindingShortcut }>,
  platform = navigator.platform,
): Command | null {
  if (isModifierPairShortcut(shortcut)) return null;
  const key = shortcutConflictKey(shortcut, platform);
  return (
    keybindings.find((binding) => shortcutConflictKey(binding.shortcut, platform) === key)
      ?.command ?? null
  );
}
