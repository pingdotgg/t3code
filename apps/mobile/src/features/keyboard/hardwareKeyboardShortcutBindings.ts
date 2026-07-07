import type { HardwareKeyboardCommand } from "./hardwareKeyboardCommands";

export interface HardwareKeyboardShortcutModifiers {
  readonly ctrl: boolean;
  readonly shift?: boolean;
}

export interface HardwareKeyboardShortcutBinding {
  readonly command: HardwareKeyboardCommand;
  readonly key: string;
  readonly modifiers: HardwareKeyboardShortcutModifiers;
}

/**
 * Canonical shortcut table shared by iOS UIKeyCommand, Android KeyEvent matching,
 * and unit tests. Keep native implementations aligned with this list.
 */
export const HARDWARE_KEYBOARD_SHORTCUT_BINDINGS = [
  { command: "newTask", key: "n", modifiers: { ctrl: true } },
  { command: "focusSearch", key: "f", modifiers: { ctrl: true } },
  { command: "focusSearch", key: "k", modifiers: { ctrl: true } },
  { command: "back", key: "[", modifiers: { ctrl: true } },
  { command: "files", key: "f", modifiers: { ctrl: true, shift: true } },
  { command: "terminal", key: "t", modifiers: { ctrl: true, shift: true } },
  { command: "review", key: "r", modifiers: { ctrl: true, shift: true } },
  { command: "toggleSidebar", key: "\\", modifiers: { ctrl: true } },
] as const satisfies ReadonlyArray<HardwareKeyboardShortcutBinding>;

export function matchHardwareKeyboardShortcut(
  key: string,
  modifiers: HardwareKeyboardShortcutModifiers,
): HardwareKeyboardCommand | null {
  const normalizedKey = key.length === 1 ? key.toLowerCase() : key;
  for (const binding of HARDWARE_KEYBOARD_SHORTCUT_BINDINGS) {
    if (binding.key !== normalizedKey) continue;
    if (!modifiers.ctrl || binding.modifiers.ctrl !== true) continue;
    const bindingShift = "shift" in binding.modifiers && binding.modifiers.shift === true;
    const activeShift = modifiers.shift === true;
    if (bindingShift !== activeShift) continue;
    return binding.command;
  }
  return null;
}
