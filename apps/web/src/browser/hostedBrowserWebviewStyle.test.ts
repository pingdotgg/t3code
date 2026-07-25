import { describe, expect, it } from "vite-plus/test";

import {
  BACKGROUND_CAPTURE_BROWSER_WEBVIEW_OPACITY,
  BACKGROUND_CAPTURE_BROWSER_WEBVIEW_Z_INDEX,
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        backgroundCapture: false,
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

  it("keeps an inactive webview paintable while moving it offscreen", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      backgroundCapture: false,
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
      visibility: "visible",
    });
  });
});
