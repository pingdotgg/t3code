import { describe, expect, it } from "vite-plus/test";

import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";

const hiddenSize = { width: 1280, height: 800 };

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("keeps a capture-active guest drawn but unseen behind translucent themes", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: true,
      rect: null,
      hiddenSize,
    });
    expect(style).toMatchObject({ left: 0, top: 0, zIndex: -1, visibility: "visible" });
    expect(style.opacity).toBeGreaterThan(0);
    expect(style.opacity).toBeLessThan(0.05);
  });
});
