import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveChatShortcutCommand, type ShortcutMatchContext } from "../../keybindings";
import { isTerminalCloseConfirmPending } from "../../lib/terminalCloseConfirm";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../../lib/terminalCloseShortcut";
import { getTerminalFocusOwner, type TerminalFocusOwner } from "../../lib/terminalFocus";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { BranchToolbarHandle } from "../BranchToolbar";
import { shouldTypeToFocusComposer } from "./composerFocusRedirect";
import { composerShortcutCommands } from "./composerShortcuts";

/** Returning false lets the key through, except for cycling while a terminal owns focus. */
type ChatShortcutHandler = (context: {
  readonly event: KeyboardEvent;
  readonly terminalFocusOwner: TerminalFocusOwner | null;
}) => boolean | void;

export type ChatShortcutCommands = Partial<Record<KeybindingCommand, ChatShortcutHandler>>;

interface ChatShortcutsInput {
  readonly enabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly scriptKeybindings: ResolvedKeybindingsConfig;
  readonly getShortcutContext: (target: EventTarget | null) => ShortcutMatchContext & {
    readonly modelPickerOpen: boolean;
  };
  readonly threadFindActive: boolean;
  /** Takes type-to-focus keys and the composer and branch toolbar chords. */
  readonly composerRef: ComposerHandleRef;
  readonly branchToolbarRef: { readonly current: BranchToolbarHandle | null };
  readonly closeThreadFind: () => void;
  readonly commands: ChatShortcutCommands;
  /** Handles commands not in `commands`, such as project scripts. */
  readonly fallback: (command: KeybindingCommand) => ChatShortcutHandler | undefined;
}

/**
 * The chat's window keyboard shortcuts, plus Escape closing thread find.
 * Listeners attach once; the effect events read the latest input, so handlers
 * act on the current render without re-registering on every change.
 */
export function useChatShortcuts(input: ChatShortcutsInput) {
  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const { keybindings } = input;
    if (preventRepeatedTerminalCloseShortcut(event, keybindings)) {
      event.stopPropagation();
      return;
    }
    if (input.threadFindActive && event.key === "Escape") return;
    if (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings)) {
      event.stopPropagation();
      return;
    }
    if (!input.enabled || isCommandPaletteOpen()) return;
    const terminalFocusOwner = getTerminalFocusOwner();
    if (event.defaultPrevented && terminalFocusOwner === null) return;
    const shortcutContext = input.getShortcutContext(event.target);

    if (
      !shortcutContext.terminalFocus &&
      !shortcutContext.modelPickerOpen &&
      shouldTypeToFocusComposer(event) &&
      input.composerRef.current?.insertTextAtEnd(event.key) === true
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const command = resolveChatShortcutCommand(event, keybindings, input.scriptKeybindings, {
      context: shortcutContext,
    });
    if (!command) return;
    const run =
      input.commands[command] ??
      composerShortcutCommands(input.composerRef, input.branchToolbarRef)[command] ??
      input.fallback(command);
    if (!run) return;
    const handled = run({ event, terminalFocusOwner });
    if (
      handled === false &&
      (terminalFocusOwner === null ||
        (command !== "terminal.previous" && command !== "terminal.next"))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
  });
  const dismissFind = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      !input.threadFindActive ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      isCommandPaletteOpen()
    )
      return;
    const context = input.getShortcutContext(event.target);
    if (context.terminalFocus || context.previewFocus || context.modelPickerOpen) return;
    event.preventDefault();
    input.closeThreadFind();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches window keydown listeners for chat shortcuts and find dismissal for the component's lifetime
  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => handleShortcut(event);
    const onKeyDown = (event: KeyboardEvent) => dismissFind(event);
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
