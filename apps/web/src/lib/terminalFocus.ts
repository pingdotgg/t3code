export function isTerminalFocusedInDom(): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }
  if (activeElement.classList.contains("xterm-helper-textarea")) {
    return true;
  }
  return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
}
