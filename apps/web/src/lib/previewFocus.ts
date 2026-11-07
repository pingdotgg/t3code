export function isPreviewFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.tagName.toLowerCase() === "webview") return true;
  // A side chat shares the preview's right panel but is a chat, not the preview.
  return (
    activeElement.closest("[data-preview-panel-mode]") !== null &&
    activeElement.closest("[data-side-chat-pane]") === null
  );
}
