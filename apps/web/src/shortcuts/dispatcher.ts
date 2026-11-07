import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { executeCommand, registerCommand } from "../commands/registry";
import type { CommandRunHandler } from "../commands/types";
import { resolveShortcutCommand, type ShortcutMatchContext } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";

/** Return `false` to let the next scope handle the event. */
export type CommandHandler = (event: KeyboardEvent) => boolean | void;

export type CommandHandlers = Partial<Record<KeybindingCommand, CommandHandler>>;

export interface CommandScopeOptions {
  /** Read at event time; a scope whose guard fails is skipped. */
  readonly when?: (event: KeyboardEvent) => boolean;
  /** When-clause context the dispatcher cannot know (terminalOpen, previewOpen), read at event time. */
  readonly context?: (event: KeyboardEvent) => Partial<ShortcutMatchContext>;
  readonly keybindings?: () => ResolvedKeybindingsConfig;
  /** For shortcuts that are not keybinding commands (Escape, "/"); runs before command lookup. */
  readonly onKeyDown?: CommandHandler;
  /**
   * Run in the capture phase, ahead of focused widgets that consume the key
   * themselves (the terminal encodes Ctrl+Shift+T and stops propagation).
   */
  readonly capture?: boolean;
  /**
   * Hear every bubbling keydown after the scopes ran, with whether one of them
   * (or the page) consumed it. Observers never consume. For listeners that react to keys other
   * scopes may also handle, such as scroll keys.
   */
  readonly observe?: (event: KeyboardEvent, consumed: boolean) => void;
}

interface CommandScope {
  readonly commands: CommandHandlers;
  readonly options: CommandScopeOptions;
}

// Within each list the newest scope wins.
const globalScopes: CommandScope[] = [];
const captureScopes: CommandScope[] = [];
const observerScopes: CommandScope[] = [];

function readFocusContext(event: KeyboardEvent): Partial<ShortcutMatchContext> {
  return {
    terminalFocus: isTerminalFocused(),
    previewFocus: isPreviewFocused(),
    editableFocus: isEditableFocused(event.target),
    modelPickerOpen: isModelPickerOpen(),
  };
}

function isInsideConfirmation(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="alertdialog"]') !== null;
}

function toRegistryHandler(handler: CommandHandler): CommandRunHandler {
  return (context) => {
    if (context.event) return handler(context.event);
    // Palette/menu invocations synthesize a non-repeating keydown-shaped stub.
    const synthetic = new KeyboardEvent("keydown", { bubbles: true, cancelable: true });
    return handler(synthetic);
  };
}

function runScope(scope: CommandScope, event: KeyboardEvent): boolean {
  const { commands, options } = scope;
  if (options.when && !options.when(event)) return false;
  if (options.onKeyDown && options.onKeyDown(event) !== false) return true;
  const command = resolveShortcutCommand(
    event,
    options.keybindings?.() ?? appAtomRegistry.get(primaryServerKeybindingsAtom),
    { context: { ...readFocusContext(event), ...options.context?.(event) } },
  );
  if (command === null) return false;
  // Only a scope that registered this command claims the chord; execution goes
  // through the shared registry so keys/palette/menu share one handler stack.
  if (commands[command] === undefined) return false;
  if (isInsideConfirmation(event.target)) {
    event.preventDefault();
    return true;
  }
  return executeCommand(command, { source: "keybinding", event });
}

function runScopes(scopes: readonly CommandScope[], event: KeyboardEvent): boolean {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (event.defaultPrevented) return true;
    const scope = scopes[index];
    if (scope && runScope(scope, event)) return true;
  }
  return false;
}

function dispatchCaptureKeyDown(event: KeyboardEvent): void {
  runScopes(captureScopes, event);
}

function dispatchKeyDown(event: KeyboardEvent): void {
  const consumed = runScopes(globalScopes, event) || event.defaultPrevented;
  for (const scope of observerScopes.slice()) scope.options.observe?.(event, consumed);
}

let keydownInstalled = false;
function ensureKeydownListener() {
  if (keydownInstalled || typeof window === "undefined") return;
  keydownInstalled = true;
  window.addEventListener("keydown", dispatchCaptureKeyDown, true);
  window.addEventListener("keydown", dispatchKeyDown);
}

function pushScope(list: CommandScope[], scope: CommandScope): () => void {
  ensureKeydownListener();
  // Re-check on every scope so a replaced desktopBridge (tests) still reaches executeCommand.
  ensureMenuActionListener();
  list.push(scope);
  return () => {
    const index = list.lastIndexOf(scope);
    if (index !== -1) list.splice(index, 1);
  };
}

/**
 * App-global commands. Registers both a keydown scope and the shared command
 * registry so the palette can invoke the same handlers.
 */
export function registerCommands(
  commands: CommandHandlers,
  options: CommandScopeOptions = {},
): () => void {
  const scopes = options.observe ? observerScopes : options.capture ? captureScopes : globalScopes;
  const disposeScope = pushScope(scopes, { commands, options });
  const disposers: Array<() => void> = [disposeScope];
  if (!options.observe) {
    for (const [command, handler] of Object.entries(commands) as Array<
      [KeybindingCommand, CommandHandler]
    >) {
      if (!handler) continue;
      disposers.push(
        registerCommand(
          command,
          toRegistryHandler(handler),
          options.when ? { when: options.when } : undefined,
        ),
      );
    }
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}

type MenuActionHandler = () => void;
const menuActionHandlers = new Map<string, MenuActionHandler[]>();
let menuActionBridge: NonNullable<typeof window.desktopBridge> | null = null;
let menuActionUnsubscribe: (() => void) | null = null;

export function dispatchMenuAction(action: string): void {
  // Menu-specific handlers win (e.g. workspace focus with "panel" mode). Otherwise
  // fall through to the shared registry so keybinding commands work from the menu too.
  const handlers = menuActionHandlers.get(action);
  const menuHandler = handlers?.at(-1);
  if (menuHandler) {
    menuHandler();
    return;
  }
  executeCommand(action as KeybindingCommand, { source: "menu" });
}

function ensureMenuActionListener() {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (typeof bridge?.onMenuAction !== "function") return;
  // Tests (and rare host remounts) replace the bridge; re-bind when it changes.
  if (menuActionBridge === bridge) return;
  menuActionUnsubscribe?.();
  menuActionBridge = bridge;
  menuActionUnsubscribe = bridge.onMenuAction(dispatchMenuAction) ?? null;
}

/**
 * Desktop menu actions only. Does not touch the command registry — keybinding
 * commands already register there via `registerCommands`, and dual-writing let
 * menu handlers outrank key handlers in `executeCommand`.
 */
export function registerMenuAction(action: string, handler: MenuActionHandler): () => void {
  ensureMenuActionListener();
  const handlers = menuActionHandlers.get(action) ?? [];
  handlers.push(handler);
  menuActionHandlers.set(action, handlers);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
  };
}
