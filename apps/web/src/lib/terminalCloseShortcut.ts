import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { isTerminalCloseShortcut, type ShortcutEventLike } from "../keybindings";

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
