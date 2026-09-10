import { isMacPlatform } from "../../lib/utils";
import { keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";

const MODIFIER_KEYS = new Set(["alt", "control", "meta", "shift"]);
const PUNCTUATION_KEYS = new Set(["-", "=", "[", "]", ";", "'", "`", "\\", ",", ".", "/"]);
const NAMED_KEYS = new Set([
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowup",
  "backspace",
  "delete",
  "end",
  "enter",
  "home",
  "pagedown",
  "pageup",
  "space",
  "tab",
]);

function concreteModifiers(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
): string[] {
  const modifiers: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) modifiers.push("meta");
    if (event.ctrlKey) modifiers.push("ctrl");
  } else {
    if (event.ctrlKey) modifiers.push("ctrl");
    if (event.metaKey) modifiers.push("meta");
  }
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  return modifiers;
}

function standaloneKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (normalized === " ") return "space";
  if (NAMED_KEYS.has(normalized)) return normalized;
  if (/^f(?:[1-9]|1[0-2])$/.test(normalized)) return normalized;
  if (/^[a-z0-9]$/.test(normalized)) return normalized;
  if (PUNCTUATION_KEYS.has(normalized)) return normalized;
  return null;
}

export function dictationKeybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
): string | null {
  const keybinding = keybindingFromKeyboardEvent(event, platform);
  if (!keybinding) {
    const modifiers = concreteModifiers(event, platform);
    if (MODIFIER_KEYS.has(event.key.toLowerCase())) {
      return modifiers.length > 0 ? modifiers.join("+") : null;
    }
    const keyToken = standaloneKeyToken(event.key);
    return keyToken ? [...modifiers, keyToken].join("+") : null;
  }
  const concreteModifier = isMacPlatform(platform) ? "meta" : "ctrl";
  return keybinding
    .split("+")
    .map((token) => (token === "mod" ? concreteModifier : token))
    .join("+");
}
