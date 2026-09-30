import { describe, expect, it } from "vite-plus/test";

import {
  BACKGROUND_CAPTURE_BROWSER_WEBVIEW_OPACITY,
  BACKGROUND_CAPTURE_BROWSER_WEBVIEW_Z_INDEX,
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewAriaHidden,
  resolveHostedBrowserWebviewPresentation,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserWebviewAriaHidden", () => {
  it("exposes only the active guest to host assistive technology", () => {
    expect(resolveHostedBrowserWebviewAriaHidden(true)).toBeUndefined();
    expect(resolveHostedBrowserWebviewAriaHidden(false)).toBe(true);
  });
});

describe("resolveHostedBrowserWebviewPresentation", () => {
  it("stages a background capture when visibility is stale after selection changes", () => {
    expect(
      resolveHostedBrowserWebviewPresentation({
        backgroundCaptureRequested: true,
        rect: { x: -20, y: -10, width: 800, height: 600 },
        rendererViewport: { width: 640, height: 480 },
        selected: false,
        surfaceVisible: true,
      }),
    ).toEqual({
      active: false,
      backgroundCapture: true,
      rect: { x: 0, y: 0, width: 640, height: 480 },
    });
  });

  it("keeps the selected visible surface in the foreground during a capture request", () => {
    expect(
      resolveHostedBrowserWebviewPresentation({
        backgroundCaptureRequested: true,
        rect: { x: -20, y: -10, width: 800, height: 600 },
        rendererViewport: { width: 640, height: 480 },
        selected: true,
        surfaceVisible: true,
      }),
    ).toEqual({
      active: true,
      backgroundCapture: false,
      rect: { x: -20, y: -10, width: 800, height: 600 },
    });
  });

  it("supplies a deterministic staging rectangle before a surface has presented", () => {
    expect(
      resolveHostedBrowserWebviewPresentation({
        backgroundCaptureRequested: true,
        rect: null,
        rendererViewport: { width: 640, height: 480 },
        selected: false,
        surfaceVisible: false,
      }),
    ).toEqual({
      active: false,
      backgroundCapture: true,
      rect: { x: 0, y: 0, width: 640, height: 480 },
    });
  });
});

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        backgroundCapture: false,
        renderingActive: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: 30,
      pointerEvents: "auto",
    });
  });

  it("places a nearly transparent background target above the active surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        backgroundCapture: true,
        renderingActive: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 393, height: 852 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: BACKGROUND_CAPTURE_BROWSER_WEBVIEW_Z_INDEX,
      pointerEvents: "none",
      opacity: BACKGROUND_CAPTURE_BROWSER_WEBVIEW_OPACITY,
    });
  });

  it("clips a floating webview to the mini-player frame", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        backgroundCapture: false,
        renderingActive: true,
        cornerRadius: 12,
        zIndex: 48,
        rect: { x: 12, y: 34, width: 360, height: 203 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toMatchObject({
      left: 12,
      top: 34,
      width: 360,
      height: 203,
      borderRadius: 12,
      zIndex: 48,
    });
  });

  it("suspends painting for an inactive webview", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      backgroundCapture: false,
      renderingActive: false,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 393,
      height: 852,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "hidden",
    });
  });

  it("keeps an active background task paintable behind the app", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      backgroundCapture: false,
      renderingActive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
  });

  it("keeps an inactive webview paintable without marking it as rendering-active", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      keepPaintableWhenInactive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
  });
});
