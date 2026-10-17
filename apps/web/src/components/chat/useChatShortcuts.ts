import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveChatShortcutCommand, type ShortcutMatchContext } from "../../keybindings";
import { isTerminalCloseConfirmPending } from "../../lib/terminalCloseConfirm";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../../lib/terminalCloseShortcut";
import { getTerminalFocusOwner, type TerminalFocusOwner } from "../../lib/terminalFocus";
import { shouldTypeToFocusComposer } from "./composerFocusRedirect";

/** Runs a command. Returning false lets the key event through untouched. */
export type ChatShortcutHandler = (context: {
  readonly event: KeyboardEvent;
  readonly terminalFocusOwner: TerminalFocusOwner | null;
}) => boolean | void;

export interface ChatShortcutsInput {
  readonly enabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly scriptKeybindings: ResolvedKeybindingsConfig;
  readonly getShortcutContext: (target: EventTarget | null) => ShortcutMatchContext & {
    readonly modelPickerOpen: boolean;
  };
  readonly threadFindActive: boolean;
  /** Types a printable key into the composer; false when it could not take it. */
  readonly typeIntoComposer: (key: string) => boolean;
  readonly closeThreadFind: () => void;
  readonly commands: Partial<Record<KeybindingCommand, ChatShortcutHandler>>;
  /** Handles commands not in `commands`, such as project scripts. */
  readonly fallback: (command: KeybindingCommand) => ChatShortcutHandler | undefined;
}

/**
 * The chat's window keyboard shortcuts, plus Escape closing thread find.
 * Listeners attach once and read the latest input on each event, so handlers
 * act on the current render without re-registering on every change.
 */
export function useChatShortcuts(input: ChatShortcutsInput) {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const current = latest.current;
      const { keybindings } = current;
      if (preventRepeatedTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (current.threadFindActive && event.key === "Escape") return;
      if (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (!current.enabled || isCommandPaletteOpen()) return;
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) return;
      const shortcutContext = current.getShortcutContext(event.target);

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event) &&
        current.typeIntoComposer(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const command = resolveChatShortcutCommand(event, keybindings, current.scriptKeybindings, {
        context: shortcutContext,
      });
      if (!command) return;
      const run = current.commands[command] ?? current.fallback(command);
      if (!run || run({ event, terminalFocusOwner }) === false) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const dismissFind = (event: KeyboardEvent) => {
      const current = latest.current;
      if (
        event.key !== "Escape" ||
        !current.threadFindActive ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        isCommandPaletteOpen()
      )
        return;
      const context = current.getShortcutContext(event.target);
      if (context.terminalFocus || context.previewFocus || context.modelPickerOpen) return;
      event.preventDefault();
      current.closeThreadFind();
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keydown", dismissFind);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keydown", dismissFind);
    };
  }, []);
}
