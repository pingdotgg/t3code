export function isPreviewFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.tagName.toLowerCase() === "webview") return true;
  return activeElement.closest("[data-preview-panel-mode]") !== null;
}

/** Focus is in a browser, not in another tab the side panel shell hosts (diff, files, pull requests). */
export function isBrowserFocused(): boolean {
  if (!isPreviewFocused()) return false;
  const kind = document.activeElement?.closest<HTMLElement>("[data-right-panel-surface-kind]")
    ?.dataset.rightPanelSurfaceKind;
  return kind === undefined || kind === "preview";
}
