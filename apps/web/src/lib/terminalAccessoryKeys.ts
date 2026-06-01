// Byte sequences sent to the pty for on-screen terminal keys on touch devices,
// where the soft keyboard cannot produce Esc/Tab/arrows/control combinations.

export type TerminalModifier = "ctrl";

export const TERMINAL_ESC = "\u001b";
export const TERMINAL_TAB = "\t";
export const TERMINAL_ARROW_UP = "\u001b[A";
export const TERMINAL_ARROW_DOWN = "\u001b[B";
export const TERMINAL_ARROW_RIGHT = "\u001b[C";
export const TERMINAL_ARROW_LEFT = "\u001b[D";
export const TERMINAL_CTRL_C = "\u0003";
export const TERMINAL_CTRL_D = "\u0004";
export const TERMINAL_CTRL_Z = "\u001a";

export interface TerminalAccessoryDataKey {
  id: string;
  kind: "data";
  label: string;
  ariaLabel: string;
  data: string;
}

export interface TerminalAccessoryModifierKey {
  id: string;
  kind: "modifier";
  label: string;
  ariaLabel: string;
  modifier: TerminalModifier;
}

export type TerminalAccessoryKey = TerminalAccessoryDataKey | TerminalAccessoryModifierKey;

export const TERMINAL_ACCESSORY_KEYS: ReadonlyArray<TerminalAccessoryKey> = [
  { id: "esc", kind: "data", label: "Esc", ariaLabel: "Escape", data: TERMINAL_ESC },
  { id: "tab", kind: "data", label: "Tab", ariaLabel: "Tab", data: TERMINAL_TAB },
  { id: "ctrl", kind: "modifier", label: "Ctrl", ariaLabel: "Control", modifier: "ctrl" },
  {
    id: "arrow-left",
    kind: "data",
    label: "←",
    ariaLabel: "Arrow left",
    data: TERMINAL_ARROW_LEFT,
  },
  { id: "arrow-up", kind: "data", label: "↑", ariaLabel: "Arrow up", data: TERMINAL_ARROW_UP },
  {
    id: "arrow-down",
    kind: "data",
    label: "↓",
    ariaLabel: "Arrow down",
    data: TERMINAL_ARROW_DOWN,
  },
  {
    id: "arrow-right",
    kind: "data",
    label: "→",
    ariaLabel: "Arrow right",
    data: TERMINAL_ARROW_RIGHT,
  },
  { id: "ctrl-c", kind: "data", label: "^C", ariaLabel: "Control C", data: TERMINAL_CTRL_C },
  { id: "ctrl-d", kind: "data", label: "^D", ariaLabel: "Control D", data: TERMINAL_CTRL_D },
  { id: "ctrl-z", kind: "data", label: "^Z", ariaLabel: "Control Z", data: TERMINAL_CTRL_Z },
];

// Combine an armed Ctrl modifier with a single character typed on the soft
// keyboard. Returns the control byte, or null when the input cannot be combined
// (multi-character input such as a paste, or a key with no Ctrl equivalent), in
// which case callers should forward the original input unchanged.
export function applyTerminalCtrlModifier(data: string): string | null {
  if (data.length !== 1) {
    return null;
  }
  const upperCodePoint = data.toUpperCase().charCodeAt(0);
  // Ctrl is defined for "@" (0x40) through "_" (0x5f), which covers A-Z and a
  // handful of symbols and maps onto control bytes 0x00-0x1f.
  if (upperCodePoint < 0x40 || upperCodePoint > 0x5f) {
    return null;
  }
  return String.fromCharCode(upperCodePoint & 0x1f);
}
