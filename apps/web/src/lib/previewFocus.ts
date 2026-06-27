/**
 * Returns true when the user's keyboard focus is somewhere inside the
 * preview panel (URL bar, chrome buttons, or the native preview page).
 *
 * Used by the global keybinding handler to gate `preview.refresh` and
 * `preview.focusUrl` to only fire while the preview owns focus.
 */
export function isPreviewFocused(): boolean {
  if (focusedNativePreviewTabs.size > 0) return true;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  return activeElement.closest("[data-preview-panel-mode]") !== null;
}

const focusedNativePreviewTabs = new Set<string>();

export function setNativePreviewFocused(tabId: string, focused: boolean): void {
  if (focused) focusedNativePreviewTabs.add(tabId);
  else focusedNativePreviewTabs.delete(tabId);
}
