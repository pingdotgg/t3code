import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export interface HostedBrowserWebviewSize {
  readonly width: number;
  readonly height: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly pointerEvents: "auto" | "none";
  readonly borderRadius?: number;
  readonly visibility?: "visible";
}

export const HIDDEN_BROWSER_WEBVIEW_OFFSET = -100_000;
// The root-level native webview must remain below dialogs and command menus
// (z-50) as well as toasts (z-100).
export const HOSTED_BROWSER_WEBVIEW_Z_INDEX = 30;

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly cornerRadius?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
}): HostedBrowserWebviewWrapperStyle {
  const { active, cornerRadius = 0, hiddenSize, rect } = input;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex: HOSTED_BROWSER_WEBVIEW_Z_INDEX,
      pointerEvents: "auto",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  return {
    left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zIndex: -1,
    pointerEvents: "none",
    // Keep the guest CSS-visible even while physically offscreen. Electron
    // webviews can keep metadata/status alive under `visibility:hidden` while
    // CDP Runtime/Input commands stall, which breaks offscreen automation.
    visibility: "visible",
  };
}
