const resetters = new Map<string, () => void>();

/** Lets preview commands undo a pinch zoom on the webview that hosts a tab. */
export function registerBrowserPageZoomReset(runtimeTabId: string, reset: () => void) {
  resetters.set(runtimeTabId, reset);
  return () => {
    if (resetters.get(runtimeTabId) === reset) resetters.delete(runtimeTabId);
  };
}

export function resetBrowserPageZoom(runtimeTabId: string) {
  resetters.get(runtimeTabId)?.();
}
