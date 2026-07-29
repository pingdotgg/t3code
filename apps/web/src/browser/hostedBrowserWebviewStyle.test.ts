import { describe, expect, it } from "vite-plus/test";

import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  HOSTED_BROWSER_WEBVIEW_Z_INDEX,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: HOSTED_BROWSER_WEBVIEW_Z_INDEX,
      pointerEvents: "auto",
    });
  });

  it("stays below the global overlay layer after mounting at the app root", () => {
    expect(HOSTED_BROWSER_WEBVIEW_Z_INDEX).toBeLessThan(50);
  });

  it("keeps an inactive webview paintable while moving it offscreen", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
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
