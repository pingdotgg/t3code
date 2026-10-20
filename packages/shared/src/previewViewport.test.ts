import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewViewport } from "./previewViewport.ts";

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
});
