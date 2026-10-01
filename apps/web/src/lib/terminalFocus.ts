export type TerminalFocusOwner = "drawer" | "right-panel" | "extension";

function focusedTerminalFrame(): HTMLElement | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  return activeElement.closest<HTMLElement>("[data-terminal-owner]");
}

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const owner = focusedTerminalFrame()?.dataset.terminalOwner;
  if (owner === "drawer" || owner === "right-panel" || owner === "extension") return owner;
  return null;
}

/**
 * `terminal.toggle` hides the terminal drawer that focus is in. A claiming
 * extension surface in the extension dock is that drawer, just as the native
 * drawer is for its own terminals, so the toggle hides the extension dock
 * instead of stacking the native drawer on top. From anywhere else,
 * including a claiming surface in the side panel, the toggle keeps driving
 * the native drawer, matching a focused native right-panel terminal.
 */
export function isExtensionDockTerminalFocused(): boolean {
  const frame = focusedTerminalFrame();
  return (
    frame?.dataset.terminalOwner === "extension" &&
    frame.dataset.terminalPlacement === "bottom-dock"
  );
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}

/**
 * Commands that act on whichever terminal surface owns focus, rather than on
 * terminal chrome (the drawer toggle stays global no matter who is focused).
 */
const FOCUSED_TERMINAL_COMMANDS: ReadonlySet<string> = new Set([
  "terminal.split",
  "terminal.splitVertical",
  "terminal.new",
  "terminal.close",
]);

/**
 * An extension surface that declared terminal focus owns these commands while
 * its subtree is focused. The dispatcher leaves the event untouched so the
 * surface's own keymap can handle it, and never routes it to a native surface.
 */
export function isExtensionClaimedTerminalCommand(
  command: string,
  owner: TerminalFocusOwner | null,
): boolean {
  return owner === "extension" && FOCUSED_TERMINAL_COMMANDS.has(command);
}
