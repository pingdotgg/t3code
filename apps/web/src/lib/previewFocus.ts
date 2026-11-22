export function isPreviewFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.tagName.toLowerCase() === "webview") return true;
  return activeElement.closest("[data-preview-panel-mode]") !== null;
}

/** Narrower than isPreviewFocused, whose panel also hosts PR, diff, files and other surfaces. */
export function isBrowserSurfaceFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !activeElement.isConnected) return false;
  if (activeElement.tagName.toLowerCase() === "webview") return true;
  const panel = activeElement.closest("[data-preview-panel-mode]");
  return panel?.querySelector("[data-preview-view]") != null;
}
