import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { isTerminalCloseShortcut, type ShortcutEventLike } from "../keybindings";
import type { TerminalFocusOwner } from "./terminalFocus";

export interface TerminalCloseShortcutEvent extends ShortcutEventLike {
  readonly repeat?: boolean;
  readonly preventDefault: () => void;
}

function terminalCloseShortcutOptions(platform?: string) {
  return {
    ...(platform === undefined ? {} : { platform }),
    context: { terminalFocus: true, terminalOpen: true },
  };
}

export function preventTerminalCloseShortcut(
  event: TerminalCloseShortcutEvent,
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): boolean {
  if (!isTerminalCloseShortcut(event, keybindings, terminalCloseShortcutOptions(platform))) {
    return false;
  }
  event.preventDefault();
  return true;
}

export function preventRepeatedTerminalCloseShortcut(
  event: TerminalCloseShortcutEvent,
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): boolean {
  if (!event.repeat) return false;
  return preventTerminalCloseShortcut(event, keybindings, platform);
}

/**
 * Capture-phase close suppression for native terminal surfaces only. An
 * extension-owned terminal handles close through its own keymap — including
 * held repeats — so both guards must leave its events untouched for the
 * surface to receive them.
 */
export function suppressNativeTerminalCloseShortcut(
  event: TerminalCloseShortcutEvent,
  keybindings: ResolvedKeybindingsConfig,
  terminalFocusOwner: TerminalFocusOwner | null,
  confirmationPending: boolean,
  platform?: string,
): boolean {
  if (terminalFocusOwner === "extension") return false;
  if (preventRepeatedTerminalCloseShortcut(event, keybindings, platform)) return true;
  return confirmationPending && preventTerminalCloseShortcut(event, keybindings, platform);
}
