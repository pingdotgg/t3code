import {
  resolveBrowserSurfaceBackgroundCaptureRect,
  type BrowserSurfaceRect,
} from "./browserSurfaceStore";

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
  readonly opacity?: number;
  readonly borderRadius?: number;
  readonly visibility?: "visible";
}

export const HIDDEN_BROWSER_WEBVIEW_OFFSET = -100_000;
export const BACKGROUND_CAPTURE_BROWSER_WEBVIEW_Z_INDEX = 31;
export const BACKGROUND_CAPTURE_BROWSER_WEBVIEW_OPACITY = 0.001;

export function resolveHostedBrowserWebviewAriaHidden(active: boolean): true | undefined {
  return active ? undefined : true;
}

export function resolveHostedBrowserWebviewPresentation(input: {
  readonly backgroundCaptureRequested: boolean;
  readonly rect: BrowserSurfaceRect | null;
  readonly rendererViewport: HostedBrowserWebviewSize;
  readonly selected: boolean;
  readonly surfaceVisible: boolean;
}): {
  readonly active: boolean;
  readonly backgroundCapture: boolean;
  readonly rect: BrowserSurfaceRect | null;
} {
  const active = input.selected && input.surfaceVisible && input.rect !== null;
  const backgroundCapture = !active && input.backgroundCaptureRequested;
  return {
    active,
    backgroundCapture,
    rect: backgroundCapture
      ? resolveBrowserSurfaceBackgroundCaptureRect(input.rect, input.rendererViewport)
      : input.rect,
  };
}

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly backgroundCapture: boolean;
  readonly cornerRadius?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
}): HostedBrowserWebviewWrapperStyle {
  const { active, backgroundCapture, cornerRadius = 0, hiddenSize, rect } = input;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex: 30,
      pointerEvents: "auto",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }
  if (backgroundCapture && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex: BACKGROUND_CAPTURE_BROWSER_WEBVIEW_Z_INDEX,
      pointerEvents: "none",
      opacity: BACKGROUND_CAPTURE_BROWSER_WEBVIEW_OPACITY,
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
