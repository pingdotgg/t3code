import { describe, expect, it, vi } from "vite-plus/test";

import { handleMenuZoomAction } from "./menuZoomAction";

describe("handleMenuZoomAction", () => {
  it("zooms the browser when the preview owns focus", () => {
    const dispatchPreviewAction = vi.fn();
    const zoomWindow = vi.fn();

    expect(
      handleMenuZoomAction("zoom-in", {
        dispatchPreviewAction,
        previewFocused: true,
        zoomWindow,
      }),
    ).toBe(true);

    expect(dispatchPreviewAction).toHaveBeenCalledWith("zoom-in");
    expect(zoomWindow).not.toHaveBeenCalled();
  });

  it("zooms the T3 window when focus is outside the preview", () => {
    const dispatchPreviewAction = vi.fn();
    const zoomWindow = vi.fn();

    expect(
      handleMenuZoomAction("zoom-out", {
        dispatchPreviewAction,
        previewFocused: false,
        zoomWindow,
      }),
    ).toBe(true);

    expect(zoomWindow).toHaveBeenCalledWith("out");
    expect(dispatchPreviewAction).not.toHaveBeenCalled();
  });

  it("ignores unrelated menu actions", () => {
    expect(
      handleMenuZoomAction("open-settings", {
        dispatchPreviewAction: vi.fn(),
        previewFocused: true,
        zoomWindow: vi.fn(),
      }),
    ).toBe(false);
  });
});
