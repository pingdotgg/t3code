export type TerminalFocusOwner = "right-panel";

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  const owner = activeElement.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  if (owner === "right-panel") return owner;
  return null;
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}
