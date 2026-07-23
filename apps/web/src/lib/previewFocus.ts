/**
 * Returns true when the user's keyboard focus is somewhere inside the
 * preview panel (URL bar, chrome buttons, or — once detected via Electron
 * `<webview>` focus events — the embedded page).
 *
 * Used by the global keybinding handler to gate `preview.refresh` and
 * `preview.focusUrl` to only fire while the preview owns focus.
 */
export function isPreviewFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.tagName.toLowerCase() === "webview") return true;
  return activeElement.closest("[data-preview-panel-mode]") !== null;
}
