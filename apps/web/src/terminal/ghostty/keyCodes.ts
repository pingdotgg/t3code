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

/**
 * Browser keyboard layout, cached for the page. Used to recover the unshifted
 * base key of an Option-composed character such as German Option+L (`@`).
 * Resolves to `undefined` when the Keyboard API is missing or rejects.
 */
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
const GHOSTTY_MOD_CTRL = 1 << 1;
const GHOSTTY_MOD_ALT = 1 << 2;
const GHOSTTY_MOD_SUPER = 1 << 3;

interface GhosttyKeyModState {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  getModifierState?(key: string): boolean;
}

/**
 * `navigator.platform` for the current host, or `""` when there is no DOM.
 * Callers pass an explicit platform in tests so Option handling can be checked
 * without stubbing the browser.
 */
function ghosttyHostPlatform(): string {
  return typeof navigator === "undefined" ? "" : (navigator.platform ?? "");
}

/**
 * True when `platform` is a macOS or iOS `navigator.platform` string.
 * Same host check as `isMacPlatform`. Kept local so key encoding does not
 * import the app utility graph. Option is only consumed on these hosts.
 */
function isGhosttyMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Modifiers the layout consumed to produce `event.key`, as a GhosttyMods bitmask.
 *
 * Browsers do not report which modifiers a layout consumed. A lone Shift is
 * consumed so a shifted character encodes as text. On macOS a lone Option is
 * consumed too: this WASM build is not Darwin, so it ignores macos-option-as-alt
 * and DEC 1036 turns Option+L (`@`) into `ESC @` (readline set-mark). Ctrl and
 * Meta stay unconsumed. Option+arrow is not one character, so word motion is
 * unchanged. There is no Option-as-Meta setting; this matches Terminal.app with
 * that option off.
 */
export function ghosttyConsumedMods(
  event: Pick<GhosttyKeyModState, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = ghosttyHostPlatform(),
): number {
  if ([...event.key].length !== 1 || event.ctrlKey || event.metaKey) return 0;
  const shift = event.shiftKey ? GHOSTTY_MOD_SHIFT : 0;
  if (event.altKey && isGhosttyMacPlatform(platform)) return shift | GHOSTTY_MOD_ALT;
  if (!event.shiftKey || event.altKey) return 0;
  return GHOSTTY_MOD_SHIFT;
}

export interface GhosttyEncoderMods {
  readonly mods: number;
  readonly consumedMods: number;
}

/**
 * Raw mods plus the consumed mask passed to libghostty-vt.
 *
 * Consuming Option is not enough on this build. modifyOtherKeys mode 2 and
 * Kitty report-all read the raw Alt bit and still emit an Alt sequence when
 * that bit is set, even if Alt is also consumed. Clear every modifier that
 * composed the Option character (Option, and Shift when it participated).
 * A lone Shift stays in the raw mask so modifyOtherKeys can still report
 * Shift+letter.
 */
export function ghosttyEncoderMods(
  event: GhosttyKeyModState,
  platform = ghosttyHostPlatform(),
): GhosttyEncoderMods {
  const consumedMods = ghosttyConsumedMods(event, platform);
  let mods =
    (event.shiftKey ? GHOSTTY_MOD_SHIFT : 0) |
    (event.ctrlKey ? GHOSTTY_MOD_CTRL : 0) |
    (event.altKey ? GHOSTTY_MOD_ALT : 0) |
    (event.metaKey ? GHOSTTY_MOD_SUPER : 0) |
    (event.getModifierState?.("CapsLock") ? 1 << 4 : 0) |
    (event.getModifierState?.("NumLock") ? 1 << 5 : 0);
  if ((consumedMods & GHOSTTY_MOD_ALT) !== 0) {
    mods &= ~consumedMods;
  }
  return { mods, consumedMods };
}

/**
 * Unshifted codepoint for Kitty alternate-key encoding.
 *
 * Prefers the active layout map, then US letter and symbol pairs, then
 * lowercasing. Returns 0 when the unshifted form cannot be known. Reporting
 * the shifted character as unshifted corrupts Kitty alternate keys.
 * Option-composed characters such as `@` still report their layout base key.
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
