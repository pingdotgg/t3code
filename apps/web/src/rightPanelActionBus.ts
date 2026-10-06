/** Lets the command palette reach the chat view's panel layout handler. */
const TOGGLE_MAXIMIZED_EVENT = "t3code:toggle-right-panel-maximized";

export function dispatchToggleRightPanelMaximized(): void {
  window.dispatchEvent(new Event(TOGGLE_MAXIMIZED_EVENT));
}

export function onToggleRightPanelMaximized(listener: () => void): () => void {
  window.addEventListener(TOGGLE_MAXIMIZED_EVENT, listener);
  return () => window.removeEventListener(TOGGLE_MAXIMIZED_EVENT, listener);
}
