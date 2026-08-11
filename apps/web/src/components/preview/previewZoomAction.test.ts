import { describe, expect, it, vi } from "vite-plus/test";

import { handlePreviewZoomAction } from "./previewZoomAction";

describe("handlePreviewZoomAction", () => {
  it("routes zoom actions to the active runtime tab", () => {
    const bridge = {
      zoomIn: vi.fn(async () => undefined),
      zoomOut: vi.fn(async () => undefined),
      resetZoom: vi.fn(async () => undefined),
    };

    expect(handlePreviewZoomAction("zoom-in", bridge, "runtime-tab")).toBe(true);
    expect(handlePreviewZoomAction("zoom-out", bridge, "runtime-tab")).toBe(true);
    expect(handlePreviewZoomAction("reset-zoom", bridge, "runtime-tab")).toBe(true);

    expect(bridge.zoomIn).toHaveBeenCalledWith("runtime-tab");
    expect(bridge.zoomOut).toHaveBeenCalledWith("runtime-tab");
    expect(bridge.resetZoom).toHaveBeenCalledWith("runtime-tab");
  });

  it("leaves non-zoom preview actions for their owning surface", () => {
    const bridge = {
      zoomIn: vi.fn(async () => undefined),
      zoomOut: vi.fn(async () => undefined),
      resetZoom: vi.fn(async () => undefined),
    };

    expect(handlePreviewZoomAction("refresh", bridge, "runtime-tab")).toBe(false);
    expect(bridge.zoomIn).not.toHaveBeenCalled();
  });
});
