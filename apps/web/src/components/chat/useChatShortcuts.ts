import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { executeCommand, registerCommand } from "../../commands/registry";
import type { CommandRunContext } from "../../commands/types";
import { resolveChatShortcutCommand, type ShortcutMatchContext } from "../../keybindings";
import { isTerminalCloseConfirmPending } from "../../lib/terminalCloseConfirm";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../../lib/terminalCloseShortcut";
import { isInSideChatPane } from "../../lib/sideChatPane";
import { getTerminalFocusOwner, type TerminalFocusOwner } from "../../lib/terminalFocus";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { BranchToolbarHandle } from "../BranchToolbar";
import { shouldTypeToFocusComposer } from "./composerFocusRedirect";
import { composerShortcutCommands } from "./composerShortcuts";

/** Returning false lets the key event through untouched. */
type ChatShortcutHandler = (context: {
  readonly event: KeyboardEvent;
  readonly terminalFocusOwner: TerminalFocusOwner | null;
}) => boolean | void;

export type ChatShortcutCommands = Partial<Record<KeybindingCommand, ChatShortcutHandler>>;

interface ChatShortcutsInput {
  readonly enabled: boolean;
  /**
   * A side chat inside another chat leaves the window to the outer chat. It runs only
   * composer chords, for keys pressed inside `composerElement`.
   */
  readonly embedded?: boolean;
  readonly composerElement?: HTMLElement | null;
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
  /** Palette titles for dynamic script commands (`script.<id>.run` → script name). */
  readonly scriptTitles?: Partial<Record<KeybindingCommand, string>>;
}

/**
 * The chat's window keyboard shortcuts, plus Escape closing thread find.
 * Listeners attach once; the effect events read the latest input, so handlers
 * act on the current render without re-registering on every change.
 */
export function useChatShortcuts(input: ChatShortcutsInput) {
  const embedded = input.embedded === true;
  const composerElement = embedded ? (input.composerElement ?? null) : null;
  const lookupHandler = useEffectEvent((command: KeybindingCommand) => {
    return (
      input.commands[command] ??
      composerShortcutCommands(input.composerRef, input.branchToolbarRef)[command] ??
      input.fallback(command)
    );
  });
  const runRegistered = useEffectEvent((command: KeybindingCommand, context: CommandRunContext) => {
    const run = lookupHandler(command);
    if (!run) return false;
    const event =
      context.event ?? new KeyboardEvent("keydown", { bubbles: true, cancelable: true });
    return run({ event, terminalFocusOwner: getTerminalFocusOwner() }) !== false;
  });
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
    if (!input.enabled || isCommandPaletteOpen() || isInSideChatPane(event.target)) return;
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
    // Only commands this chat published. Sidebar/app scopes own thread.prev/next
    // and must resolve with their own when-context (e.g. previewOpen).
    if (!lookupHandler(command)) return;
    // Shared registry is the only run path; handlers register below.
    if (executeCommand(command, { source: "keybinding", event })) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  const dismissFind = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      !input.threadFindActive ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      isCommandPaletteOpen() ||
      isInSideChatPane(event.target)
    )
      return;
    const context = input.getShortcutContext(event.target);
    if (context.terminalFocus || context.previewFocus || context.modelPickerOpen) return;
    event.preventDefault();
    input.closeThreadFind();
  });
  const handleComposerShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || isCommandPaletteOpen()) return;
    const command = resolveChatShortcutCommand(event, input.keybindings, input.scriptKeybindings, {
      context: input.getShortcutContext(event.target),
    });
    if (!command) return;
    // Embedded chats do not publish to the registry; never hit the parent's handlers.
    if (embedded) {
      const run = composerShortcutCommands(input.composerRef, input.branchToolbarRef)[command];
      if (!run || run({ event, terminalFocusOwner: null }) === false) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (executeCommand(command, { source: "keybinding", event })) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  const commandIdsKey = Object.keys(input.commands).toSorted().join("\0");
  const scriptCommandIdsKey = input.scriptKeybindings
    .map((binding) => binding.command)
    .toSorted()
    .join("\0");
  const scriptTitlesKey = Object.entries(input.scriptTitles ?? {})
    .map(([command, title]) => `${command}=${title}`)
    .toSorted()
    .join("\0");

  // Publish chat handlers into the shared registry so keys and the palette share one path.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rebinds registry handlers when the chat's command ids change
  useEffect(() => {
    if (embedded || !input.enabled) return;
    const composerCommands = composerShortcutCommands(input.composerRef, input.branchToolbarRef);
    const chatCommandIds = (
      commandIdsKey.length === 0 ? [] : commandIdsKey.split("\0")
    ) as KeybindingCommand[];
    const scriptCommandIds = (
      scriptCommandIdsKey.length === 0 ? [] : scriptCommandIdsKey.split("\0")
    ) as KeybindingCommand[];
    const ids = new Set<KeybindingCommand>([
      ...chatCommandIds,
      ...(Object.keys(composerCommands) as KeybindingCommand[]),
      ...scriptCommandIds,
    ]);
    const scriptTitles = Object.fromEntries(
      scriptTitlesKey.length === 0
        ? []
        : scriptTitlesKey.split("\0").map((entry) => {
            const separator = entry.indexOf("=");
            return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
          }),
    ) as Partial<Record<KeybindingCommand, string>>;
    const disposers = [...ids].map((command) => {
      const scriptTitle = scriptTitles[command];
      return registerCommand(
        command,
        (context) => runRegistered(command, context),
        scriptTitle
          ? {
              contribution: {
                title: `Run Script: ${scriptTitle}`,
                category: "Project scripts",
                searchTerms: [scriptTitle, String(command), "script", "run"],
              },
            }
          : undefined,
      );
    });
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [
    embedded,
    input.enabled,
    commandIdsKey,
    scriptCommandIdsKey,
    scriptTitlesKey,
    input.composerRef,
    input.branchToolbarRef,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches keydown listeners for chat shortcuts and find dismissal: on the window, or on an embedded chat's composer
  useEffect(() => {
    if (embedded) {
      if (composerElement === null) return;
      const onComposerKeyDown = (event: KeyboardEvent) => handleComposerShortcut(event);
      composerElement.addEventListener("keydown", onComposerKeyDown, true);
      return () => composerElement.removeEventListener("keydown", onComposerKeyDown, true);
    }
    const onKeyDownCapture = (event: KeyboardEvent) => handleShortcut(event);
    const onKeyDown = (event: KeyboardEvent) => dismissFind(event);
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [composerElement, embedded]);
}
