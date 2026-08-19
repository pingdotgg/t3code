import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
  type ShortcutEventLike,
} from "../keybindings";
import { preventTerminalCloseShortcut } from "./terminalCloseShortcut";

export interface TerminalBeforeKeyEvent extends ShortcutEventLike {
  readonly preventDefault: () => void;
}

export type TerminalBeforeKeyDecision =
  | { readonly action: "encode" }
  | { readonly action: "suppress" }
  | { readonly action: "send"; readonly data: string; readonly error: string };

const TERMINAL_SHORTCUT_CONTEXT = { terminalFocus: true, terminalOpen: true } as const;

/** Escape with no modifiers. Close is `mod+w`; this must reach the PTY for vim/nvim. */
export function isBareEscapeKey(
  event: Pick<ShortcutEventLike, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  const key = event.key.toLowerCase();
  if (key !== "escape" && key !== "esc") return false;
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Decides whether Ghostty should encode a key into the PTY.
 * Returning `encode` means `beforeKey` is true so the surface does not swallow it.
 */
export function decideTerminalBeforeKey(
  event: TerminalBeforeKeyEvent,
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): TerminalBeforeKeyDecision {
  if (isBareEscapeKey(event)) {
    return { action: "encode" };
  }

  const options = {
    ...(platform === undefined ? {} : { platform }),
    context: TERMINAL_SHORTCUT_CONTEXT,
  };
  if (preventTerminalCloseShortcut(event, keybindings, platform)) {
    return { action: "suppress" };
  }
  if (
    isTerminalToggleShortcut(event, keybindings, options) ||
    isTerminalSplitShortcut(event, keybindings, options) ||
    isTerminalSplitVerticalShortcut(event, keybindings, options) ||
    isTerminalNewShortcut(event, keybindings, options) ||
    isDiffToggleShortcut(event, keybindings, options)
  ) {
    return { action: "suppress" };
  }

  const resolvedPlatform = platform ?? navigator.platform;
  const navigationData = terminalNavigationShortcutData(event, resolvedPlatform);
  if (navigationData !== null) {
    event.preventDefault();
    return { action: "send", data: navigationData, error: "Failed to move cursor" };
  }

  const deleteData = terminalDeleteShortcutData(event, resolvedPlatform);
  if (deleteData !== null) {
    event.preventDefault();
    return { action: "send", data: deleteData, error: "Failed to delete terminal input" };
  }

  if (!isTerminalClearShortcut(event, resolvedPlatform)) {
    return { action: "encode" };
  }
  event.preventDefault();
  return { action: "send", data: "\u000c", error: "Failed to clear terminal" };
}
