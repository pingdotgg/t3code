import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_VIEWPORT_PRESETS,
  previewViewportLabel,
  previewViewportPresetOrientation,
  resolvePreviewViewport,
} from "./previewViewport.ts";

describe("previewViewport", () => {
  it("resolves fill and exact freeform viewports", () => {
    expect(resolvePreviewViewport({ mode: "fill" })).toEqual({ _tag: "fill" });
    expect(resolvePreviewViewport({ mode: "freeform", width: 1024, height: 768 })).toEqual({
      _tag: "freeform",
      width: 1024,
      height: 768,
    });
  });

  it("resolves device presets in either orientation", () => {
    expect(resolvePreviewViewport({ mode: "preset", preset: "iphone-12-pro" })).toEqual({
      _tag: "preset",
      width: 390,
      height: 844,
      presetId: "iphone-12-pro",
    });
    expect(
      resolvePreviewViewport({
        mode: "preset",
        preset: "iphone-12-pro",
        orientation: "landscape",
      }),
    ).toEqual({
      _tag: "preset",
      width: 844,
      height: 390,
      presetId: "iphone-12-pro",
    });
  });

  it("matches Chrome's standard device catalog ordering", () => {
    expect(PREVIEW_VIEWPORT_PRESETS.map((preset) => preset.label)).toEqual([
      "iPhone SE",
      "iPhone XR",
      "iPhone 12 Pro",
      "iPhone 14 Pro Max",
      "Pixel 7",
      "Samsung Galaxy S8+",
      "Samsung Galaxy S20 Ultra",
      "iPad Mini",
      "iPad Air",
      "iPad Pro",
      "Surface Pro 7",
      "Surface Duo",
      "Galaxy Z Fold 5",
      "Asus Zenbook Fold",
      "Samsung Galaxy A51/71",
      "Nest Hub",
      "Nest Hub Max",
    ]);
  });

  it("formats settings for compact UI", () => {
    expect(previewViewportLabel({ _tag: "fill" })).toBe("Fill panel");
    expect(previewViewportLabel({ _tag: "freeform", width: 393, height: 852 })).toBe("393 × 852");
    expect(previewViewportPresetOrientation({ _tag: "freeform", width: 852, height: 393 })).toBe(
      "landscape",
    );
  });
});
