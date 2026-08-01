import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_PREVIEW_CAPTURE_MAX_PIXELS,
  MOBILE_PREVIEW_CAPTURE_MAX_WIDTH,
  mobilePreviewCaptureLogicalSize,
  mobilePreviewScreenshotScale,
} from "./mobilePreviewCaptureModel";

describe("mobile preview capture model", () => {
  it("uses native size when the viewport is already within review limits", () => {
    expect(
      mobilePreviewCaptureLogicalSize({
        layout: { width: 600, height: 800 },
        pixelRatio: 2,
        attempt: 0,
        platform: "ios",
      }),
    ).toBeNull();
  });

  it("caps encoded width and pixel area before native capture", () => {
    const layout = { width: 1_366, height: 1_024 };
    const pixelRatio = 2;
    const size = mobilePreviewCaptureLogicalSize({
      layout,
      pixelRatio,
      attempt: 0,
      platform: "ios",
    });
    expect(size).not.toBeNull();
    const encodedWidth = size!.width * pixelRatio;
    const encodedHeight = size!.height * pixelRatio;
    expect(encodedWidth).toBeLessThanOrEqual(MOBILE_PREVIEW_CAPTURE_MAX_WIDTH);
    expect(encodedWidth * encodedHeight).toBeLessThanOrEqual(MOBILE_PREVIEW_CAPTURE_MAX_PIXELS);
  });

  it("reduces repeated captures when PNG compression exceeds the byte budget", () => {
    const first = mobilePreviewCaptureLogicalSize({
      layout: { width: 1_000, height: 1_000 },
      pixelRatio: 2,
      attempt: 1,
      platform: "ios",
    });
    const second = mobilePreviewCaptureLogicalSize({
      layout: { width: 1_000, height: 1_000 },
      pixelRatio: 2,
      attempt: 2,
      platform: "ios",
    });
    expect(second!.width).toBeLessThan(first!.width);
    expect(second!.height).toBeLessThan(first!.height);
  });

  it("derives pixels per CSS viewport unit and rejects mismatched crops", () => {
    expect(
      mobilePreviewScreenshotScale({
        imageWidth: 1_280,
        imageHeight: 1_024,
        viewportWidth: 1_000,
        viewportHeight: 800,
      }),
    ).toBe(1.28);
    expect(
      mobilePreviewScreenshotScale({
        imageWidth: 1_280,
        imageHeight: 720,
        viewportWidth: 1_000,
        viewportHeight: 800,
      }),
    ).toBeNull();
  });

  it("rejects invalid layouts and dimensions", () => {
    expect(
      mobilePreviewCaptureLogicalSize({
        layout: { width: 0, height: 800 },
        pixelRatio: 2,
        attempt: 0,
        platform: "ios",
      }),
    ).toBeNull();
    expect(
      mobilePreviewScreenshotScale({
        imageWidth: 0,
        imageHeight: 100,
        viewportWidth: 100,
        viewportHeight: 100,
      }),
    ).toBeNull();
  });

  it("passes physical bitmap dimensions to Android and point dimensions to iOS", () => {
    const ios = mobilePreviewCaptureLogicalSize({
      layout: { width: 1_366, height: 1_024 },
      pixelRatio: 2,
      attempt: 0,
      platform: "ios",
    });
    const android = mobilePreviewCaptureLogicalSize({
      layout: { width: 1_366, height: 1_024 },
      pixelRatio: 2,
      attempt: 0,
      platform: "android",
    });
    expect(android?.width).toBe((ios?.width ?? 0) * 2);
    expect(Math.abs((android?.height ?? 0) - (ios?.height ?? 0) * 2)).toBeLessThanOrEqual(1);
    expect(android!.width).toBeLessThanOrEqual(MOBILE_PREVIEW_CAPTURE_MAX_WIDTH);
  });
});
