export const ACTIVE_PREVIEW_WEBVIEW_SELECTOR =
  "webview[data-preview-tab]:not([data-preview-capture-retired])";

export function findActivePreviewWebview<T extends Element>(
  root: ParentNode,
  runtimeTabId: string,
): T | null {
  return (
    Array.from(root.querySelectorAll<T>(ACTIVE_PREVIEW_WEBVIEW_SELECTOR)).find(
      (candidate) =>
        candidate.getAttribute("data-preview-tab") === runtimeTabId &&
        candidate.getAttribute("data-preview-capture-retired") === null,
    ) ?? null
  );
}

export function findActivePreviewWebContentsId(
  root: ParentNode,
  runtimeTabId: string,
): number | null {
  const webview = findActivePreviewWebview<Element & { getWebContentsId: () => number }>(
    root,
    runtimeTabId,
  );
  if (!webview) return null;
  try {
    return webview.getWebContentsId();
  } catch {
    return null;
  }
}
