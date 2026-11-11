import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";

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
  readonly context?: () => Partial<ShortcutMatchContext>;
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

function runScope(scope: CommandScope, event: KeyboardEvent): boolean {
  const { commands, options } = scope;
  if (options.when && !options.when(event)) return false;
  if (options.onKeyDown && options.onKeyDown(event) !== false) return true;
  const command = resolveShortcutCommand(
    event,
    options.keybindings?.() ?? appAtomRegistry.get(primaryServerKeybindingsAtom),
    { context: { ...readFocusContext(event), ...options.context?.() } },
  );
  const handler = command === null ? undefined : commands[command];
  if (handler === undefined) return false;
  if (isInsideConfirmation(event.target)) {
    event.preventDefault();
    return true;
  }
  return handler(event) !== false;
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
  list.push(scope);
  return () => {
    const index = list.lastIndexOf(scope);
    if (index !== -1) list.splice(index, 1);
  };
}

/** App-global commands, registered once at module level or bootstrap. */
export function registerCommands(
  commands: CommandHandlers,
  options: CommandScopeOptions = {},
): () => void {
  const scopes = options.observe ? observerScopes : options.capture ? captureScopes : globalScopes;
  return pushScope(scopes, { commands, options });
}

type MenuActionHandler = () => void;
const menuActionHandlers = new Map<string, MenuActionHandler[]>();
let menuActionInstalled = false;

export function dispatchMenuAction(action: string): void {
  const handlers = menuActionHandlers.get(action);
  handlers?.at(-1)?.();
}

function ensureMenuActionListener() {
  if (menuActionInstalled || typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (typeof bridge?.onMenuAction !== "function") return;
  menuActionInstalled = true;
  bridge.onMenuAction(dispatchMenuAction);
}

/** Desktop menu actions; the newest handler for an action wins. */
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
