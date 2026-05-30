export function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.classList.contains("xterm-helper-textarea")) return true;
  if (activeElement.closest(".thread-terminal-drawer .xterm") !== null) return true;
  // Sidebar / toolbar / resize affordances: still "terminal UI" for split vs diff.toggle (⌘D).
  return activeElement.closest(".thread-terminal-drawer") !== null;
}
