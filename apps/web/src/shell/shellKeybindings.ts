import type { KeybindingShortcut, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { ShellKeybinding, ShellKeybindingsState } from "@t3tools/contracts/shell";

import { isMacPlatform } from "../lib/utils";

/** Web `event.key` names (lowercased by the parser) → portable QKeySequence names. */
const QT_KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  backspace: "Backspace",
  delete: "Del",
  end: "End",
  enter: "Return",
  escape: "Esc",
  home: "Home",
  insert: "Ins",
  pagedown: "PgDown",
  pageup: "PgUp",
  tab: "Tab",
};

function qtKeyName(key: string): string | null {
  const named = QT_KEY_NAMES[key];
  if (named !== undefined) return named;
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) return key.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return null;
}

/**
 * One page shortcut as the shell should register it, or null when the shell
 * must leave it alone: unmodified keys belong to whichever native control has
 * focus, and a key Qt has no name for cannot be registered at all.
 */
export function toShellKeybinding(
  shortcut: KeybindingShortcut,
  platform: string,
): ShellKeybinding | null {
  const mac = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && mac);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !mac);
  if (!metaKey && !ctrlKey && !shortcut.altKey) return null;
  const keyName = qtKeyName(shortcut.key);
  if (keyName === null) return null;
  // Qt's portable names are swapped on macOS: "Ctrl" is Command, "Meta" is Control.
  const parts: string[] = [];
  if (mac ? metaKey : ctrlKey) parts.push("Ctrl");
  if (mac ? ctrlKey : metaKey) parts.push("Meta");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  parts.push(keyName);
  return {
    sequence: parts.join("+"),
    key: shortcut.key,
    ctrlKey,
    metaKey,
    shiftKey: shortcut.shiftKey,
    altKey: shortcut.altKey,
  };
}

/**
 * Every distinct sequence the page listens for. Rules that share a sequence
 * (terminal vs. chat variants of the same chord) collapse to one entry: the
 * page resolves the command, with its `when` clauses, once the key is
 * replayed.
 */
export function buildShellKeybindings(
  config: ResolvedKeybindingsConfig,
  platform: string,
): ShellKeybindingsState {
  const seen = new Set<string>();
  const result: ShellKeybinding[] = [];
  for (const rule of config) {
    const binding = toShellKeybinding(rule.shortcut, platform);
    if (binding === null || seen.has(binding.sequence)) continue;
    seen.add(binding.sequence);
    result.push(binding);
  }
  return result;
}
