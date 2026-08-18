import { describe, expect, it, vi } from "vite-plus/test";

import { applyPreviewGuestViewport, previewGuestViewportOverride } from "./previewGuestViewport";

describe("previewGuestViewportOverride", () => {
  it("clears fill mode and uses explicit dimensions for fixed viewports", () => {
    expect(previewGuestViewportOverride({ _tag: "fill" })).toEqual({ clear: true });
    expect(previewGuestViewportOverride({ _tag: "freeform", width: 1024, height: 768 })).toEqual({
      width: 1024,
      height: 768,
    });
    expect(
      previewGuestViewportOverride({
        _tag: "preset",
        presetId: "iphone-12-pro",
        width: 390,
        height: 844,
      }),
    ).toEqual({ width: 390, height: 844 });
  });
});

describe("applyPreviewGuestViewport", () => {
  it("skips older desktops and applies the mapped override otherwise", async () => {
    await applyPreviewGuestViewport(undefined, "tab-1", { _tag: "fill" });

    const setViewport = vi.fn(async () => undefined);
    await applyPreviewGuestViewport(setViewport, "tab-1", {
      _tag: "freeform",
      width: 800,
      height: 600,
    });
    expect(setViewport).toHaveBeenCalledWith("tab-1", { width: 800, height: 600 });
  });
});
