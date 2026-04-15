export function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.classList.contains("xterm-helper-textarea")) return true;
  return activeElement.closest(".xterm") !== null;
}
