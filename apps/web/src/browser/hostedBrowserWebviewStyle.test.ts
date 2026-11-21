import { expect, it } from "vite-plus/test";

import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";

it.each([
  { hiddenSize: { width: 1440, height: 900 }, windowSize: { width: 1840, height: 1016 }, scale: 1 },
  {
    hiddenSize: { width: 3440, height: 1440 },
    windowSize: { width: 1720, height: 1016 },
    scale: 0.5,
  },
  {
    hiddenSize: { width: 1000, height: 2000 },
    windowSize: { width: 1840, height: 500 },
    scale: 0.25,
  },
  { hiddenSize: { width: 3440, height: 1440 }, windowSize: { width: 0, height: 0 }, scale: 1 },
])(
  "fits a $hiddenSize.width x $hiddenSize.height capture guest in a $windowSize.width x $windowSize.height window",
  ({ hiddenSize, windowSize, scale }) => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: true,
      rect: null,
      hiddenSize,
      windowSize,
    });
    expect(style).toMatchObject({ left: 0, top: 0, ...hiddenSize, visibility: "visible" });
    expect(style.transform).toBe(scale < 1 ? `scale(${scale})` : undefined);
    expect(style.transformOrigin).toBe(scale < 1 ? "top left" : undefined);
  },
);
