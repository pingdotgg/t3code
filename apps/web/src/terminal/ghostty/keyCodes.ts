// This order mirrors GhosttyKey in ghostty/vt/key/event.h. The values are
// intentionally derived from the official W3C-aligned enum instead of
// maintaining a second keyboard protocol.
const ghosttyKeyboardCodes = [
  "Unidentified",
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Equal",
  "IntlBackslash",
  "IntlRo",
  "IntlYen",
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Minus",
  "Period",
  "Quote",
  "Semicolon",
  "Slash",
  "AltLeft",
  "AltRight",
  "Backspace",
  "CapsLock",
  "ContextMenu",
  "ControlLeft",
  "ControlRight",
  "Enter",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
  "Space",
  "Tab",
  "Convert",
  "KanaMode",
  "NonConvert",
  "Delete",
  "End",
  "Help",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "NumLock",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "NumpadAdd",
  "NumpadBackspace",
  "NumpadClear",
  "NumpadClearEntry",
  "NumpadComma",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadEqual",
  "NumpadMemoryAdd",
  "NumpadMemoryClear",
  "NumpadMemoryRecall",
  "NumpadMemoryStore",
  "NumpadMemorySubtract",
  "NumpadMultiply",
  "NumpadParenLeft",
  "NumpadParenRight",
  "NumpadSubtract",
  "NumpadSeparator",
  "NumpadArrowUp",
  "NumpadArrowDown",
  "NumpadArrowRight",
  "NumpadArrowLeft",
  "NumpadBegin",
  "NumpadHome",
  "NumpadEnd",
  "NumpadInsert",
  "NumpadDelete",
  "NumpadPageUp",
  "NumpadPageDown",
  "Escape",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "F25",
  "Fn",
  "FnLock",
  "PrintScreen",
  "ScrollLock",
  "Pause",
  "BrowserBack",
  "BrowserFavorites",
  "BrowserForward",
  "BrowserHome",
  "BrowserRefresh",
  "BrowserSearch",
  "BrowserStop",
  "Eject",
  "LaunchApp1",
  "LaunchApp2",
  "LaunchMail",
  "MediaPlayPause",
  "MediaSelect",
  "MediaStop",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "Power",
  "Sleep",
  "AudioVolumeDown",
  "AudioVolumeMute",
  "AudioVolumeUp",
  "WakeUp",
  "Copy",
  "Cut",
  "Paste",
] as const;

const codeToGhosttyKey = new Map<string, number>(
  ghosttyKeyboardCodes.map((code, index) => [code, index]),
);

/**
 * GhosttyKey enum index for a `KeyboardEvent.code`, or Unidentified (0).
 *
 * Values match GhosttyKey in ghostty/vt/key/event.h so the WASM encoder sees
 * the same key identity as Ghostty. Used with consumed mods when encoding a
 * composed character such as German Option+L (`@`).
 */
export function ghosttyKeyForCode(code: string): number {
  return codeToGhosttyKey.get(code) ?? 0;
}

export interface GhosttyKeyboardLayoutMap {
  get(code: string): string | undefined;
}

const shiftedToUnshiftedCharacter = new Map<string, string>([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["~", "`"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
]);

let keyboardLayoutMapPromise: Promise<GhosttyKeyboardLayoutMap | undefined> | undefined;

export function loadGhosttyKeyboardLayoutMap(): Promise<GhosttyKeyboardLayoutMap | undefined> {
  if (keyboardLayoutMapPromise) return keyboardLayoutMapPromise;
  const browserNavigator = globalThis.navigator as
    | (Navigator & {
        readonly keyboard?: {
          getLayoutMap(): Promise<GhosttyKeyboardLayoutMap>;
        };
      })
    | undefined;
  const keyboard = browserNavigator?.keyboard;
  const promise = keyboard?.getLayoutMap().catch(() => undefined) ?? Promise.resolve(undefined);
  keyboardLayoutMapPromise = promise;
  return promise;
}

const GHOSTTY_MOD_SHIFT = 1 << 0;
const GHOSTTY_MOD_ALT = 1 << 2;

/**
 * True when `platform` is a macOS or iOS `navigator.platform` string.
 *
 * Same host check as isMacPlatform in lib/utils.ts. Kept local so this module
 * stays free of the app utility graph. Option is only consumed on these hosts.
 */
function isGhosttyMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Modifiers the layout consumed to produce `event.key`, as a GhosttyMods bitmask.
 *
 * The DOM does not report consumed modifiers. A lone Shift is consumed so a
 * shifted character is encoded as text. On macOS a lone Option is consumed too,
 * along with Shift when Shift participated. This WASM build of libghostty-vt is
 * not macOS, so it ignores `macos-option-as-alt` and DEC 1036 prefixes Alt:
 * German Option+L (`@`) becomes `ESC @` (readline set-mark) and the rest of the
 * Option layer (`€`, `~`, `[]{}|`, `\`) is dropped the same way. Consuming
 * Option makes the encoder write the composed character, matching Ghostty's
 * default of `macos-option-as-alt = false`. Ctrl and Meta are never consumed,
 * so those chords stay intact. Option+arrow is not a single character, so word
 * motion is unchanged.
 *
 * @param event - DOM key state (`key` plus Shift/Ctrl/Alt/Meta).
 * @param platform - `navigator.platform`; defaults to the current host, or `""` off-DOM.
 * @returns Consumed GhosttyMods bits, or `0` when the chord must stay intact.
 */
export function ghosttyConsumedMods(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = typeof navigator === "undefined" ? "" : (navigator.platform ?? ""),
): number {
  if ([...event.key].length !== 1 || event.ctrlKey || event.metaKey) return 0;
  const shift = event.shiftKey ? GHOSTTY_MOD_SHIFT : 0;
  if (event.altKey && isGhosttyMacPlatform(platform)) return shift | GHOSTTY_MOD_ALT;
  if (!event.shiftKey || event.altKey) return 0;
  return GHOSTTY_MOD_SHIFT;
}

/**
 * Unshifted codepoint for Kitty alternate-key encoding.
 *
 * Prefers the active layout map. Falls back to US letter/symbol pairs, then
 * lowercasing. Returns 0 when the unshifted form cannot be known, rather than
 * reporting the shifted character as unshifted (which corrupts Kitty alts).
 * Option-composed characters such as `@` still report their layout base key.
 *
 * @param event - Physical `code`, produced `key`, and whether Shift was held.
 * @param layoutMap - Optional KeyboardLayoutMap from {@link loadGhosttyKeyboardLayoutMap}.
 * @returns Unicode code point, or `0` when unshifted form is unknown / not a character.
 */
export function ghosttyUnshiftedCodepoint(
  event: Pick<KeyboardEvent, "code" | "key" | "shiftKey">,
  layoutMap?: GhosttyKeyboardLayoutMap,
): number {
  if ([...event.key].length !== 1) return 0;
  const layoutCharacter = layoutMap?.get(event.code);
  if (layoutCharacter && [...layoutCharacter].length === 1) {
    return layoutCharacter.codePointAt(0) ?? 0;
  }
  if (/^[A-Z]$/u.test(event.key)) return event.key.charCodeAt(0) + 32;
  if (event.shiftKey) {
    const unshiftedCharacter = shiftedToUnshiftedCharacter.get(event.key);
    if (unshiftedCharacter) return unshiftedCharacter.codePointAt(0) ?? 0;
    const lowercase = event.key.toLowerCase();
    if (lowercase !== event.key && [...lowercase].length === 1) {
      return lowercase.codePointAt(0) ?? 0;
    }
    // Without layout data the unshifted form of a shifted key is unknowable;
    // reporting the shifted character as unshifted corrupts Kitty alternate keys.
    return 0;
  }
  return event.key.codePointAt(0) ?? 0;
}
