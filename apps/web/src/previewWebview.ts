import type { DesktopPreviewBridge, PreviewNavStatus } from "@t3tools/contracts";
import { clampPreviewTitle } from "@t3tools/shared/preview";

export type PreviewWebviewElement = HTMLElement & {
  src?: string;
  getURL?: () => string;
  getTitle?: () => string;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  getWebContentsId?: () => number;
};

export function getDesktopPreviewBridge(): DesktopPreviewBridge | null {
  return window.desktopBridge?.preview ?? null;
}

export function statusFromWebview(
  webview: PreviewWebviewElement | null,
  fallbackUrl: string,
  tag: "Loading" | "Success",
): PreviewNavStatus {
  const url = webview?.getURL?.() || fallbackUrl;
  const title = clampPreviewTitle(webview?.getTitle?.() || url);
  return tag === "Loading" ? { _tag: "Loading", url, title } : { _tag: "Success", url, title };
}
