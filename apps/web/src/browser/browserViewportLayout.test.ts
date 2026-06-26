import { describe, expect, it } from "vite-plus/test";

import {
  resizeBrowserViewportFromRail,
  resizeFreeformViewport,
  resolveBrowserDeviceViewportLayout,
  resolveBrowserViewportLayout,
  resolveResponsiveBrowserViewportSize,
} from "./browserViewportLayout";

describe("resolveBrowserViewportLayout", () => {
  it("fills the available surface in fill mode", () => {
    expect(resolveBrowserViewportLayout({ width: 700, height: 500 }, { _tag: "fill" })).toEqual({
      canvasWidth: 700,
      canvasHeight: 500,
      viewportX: 0,
      viewportY: 0,
      viewportWidth: 700,
      viewportHeight: 500,
      viewportScale: 1,
      fillsPanel: true,
    });
  });

  it("centers a smaller fixed viewport", () => {
    expect(
      resolveBrowserViewportLayout(
        { width: 700, height: 1000 },
        { _tag: "freeform", width: 393, height: 852 },
      ),
    ).toMatchObject({
      canvasWidth: 700,
      canvasHeight: 1000,
      viewportX: 154,
      viewportY: 74,
      viewportWidth: 393,
      viewportHeight: 852,
    });
  });

  it("scales a larger fixed viewport down to fit without creating overflow", () => {
    const layout = resolveBrowserViewportLayout(
      { width: 600, height: 700 },
      { _tag: "freeform", width: 1440, height: 900 },
    );
    expect(layout).toMatchObject({
      canvasWidth: 600,
      canvasHeight: 700,
      viewportX: 0,
      viewportY: 163,
      viewportWidth: 600,
      viewportHeight: 375,
    });
    expect(layout.viewportScale).toBeCloseTo(5 / 12);
  });

  it("keeps fixed dimensions in page CSS pixels when browser zoom changes", () => {
    expect(
      resolveBrowserViewportLayout(
        { width: 800, height: 700 },
        { _tag: "freeform", width: 400, height: 300 },
        1.5,
      ),
    ).toMatchObject({
      viewportX: 100,
      viewportY: 125,
      viewportWidth: 600,
      viewportHeight: 450,
    });
    expect(resizeFreeformViewport({ width: 400, height: 300 }, { x: 150, y: 75 }, 1.5)).toEqual({
      width: 500,
      height: 350,
    });
  });

  it("bounds freeform drag sizes and total render area", () => {
    expect(resizeFreeformViewport({ width: 1024, height: 768 }, { x: -2000, y: -2000 })).toEqual({
      width: 240,
      height: 240,
    });
    const large = resizeFreeformViewport({ width: 1920, height: 1080 }, { x: 2000, y: 2000 });
    expect(large.width * large.height).toBeLessThanOrEqual(3840 * 2160);
  });

  it("resizes only the axes controlled by each edge", () => {
    expect(
      resizeFreeformViewport({ width: 800, height: 600 }, { x: -100, y: 500 }, 1, "west"),
    ).toEqual({ width: 900, height: 600 });
    expect(
      resizeFreeformViewport({ width: 800, height: 600 }, { x: 500, y: 100 }, 1, "north"),
    ).toEqual({ width: 800, height: 500 });
    expect(
      resizeFreeformViewport({ width: 800, height: 600 }, { x: -100, y: -50 }, 1, "northwest"),
    ).toEqual({ width: 900, height: 650 });
  });

  it("preserves a locked aspect ratio from either axis", () => {
    expect(
      resizeFreeformViewport({ width: 800, height: 600 }, { x: 200, y: 0 }, 1, "east", 4 / 3),
    ).toEqual({ width: 1000, height: 750 });
    expect(
      resizeFreeformViewport({ width: 800, height: 600 }, { x: 0, y: 150 }, 1, "south", 4 / 3),
    ).toEqual({ width: 1000, height: 750 });
  });

  it("reserves persistent device-toolbar rails around the guest viewport", () => {
    expect(
      resolveBrowserDeviceViewportLayout(
        { width: 1200, height: 900 },
        { _tag: "freeform", width: 1180, height: 858 },
      ),
    ).toEqual({
      canvasWidth: 1200,
      canvasHeight: 900,
      viewportX: 10,
      viewportY: 32,
      viewportWidth: 1180,
      viewportHeight: 858,
      viewportScale: 1,
      fillsPanel: false,
    });
  });

  it("captures the available framed area when responsive mode is enabled", () => {
    expect(resolveResponsiveBrowserViewportSize({ width: 1200, height: 900 })).toEqual({
      width: 1180,
      height: 858,
    });
    expect(resolveResponsiveBrowserViewportSize({ width: 1200, height: 900 }, 2)).toEqual({
      width: 590,
      height: 429,
    });
  });

  it("keeps the grabbed rail under the pointer across centered layout boundaries", () => {
    const available = { width: 1120, height: 818 };
    expect(
      resizeBrowserViewportFromRail(
        { width: 1120, height: 818 },
        { x: -100, y: -50 },
        available,
        1,
        "southeast",
      ),
    ).toEqual({ width: 920, height: 718 });
    expect(
      resizeBrowserViewportFromRail(
        { width: 800, height: 600 },
        { x: 300, y: 0 },
        { width: 1200, height: 800 },
        1,
        "east",
      ),
    ).toEqual({ width: 1300, height: 600 });
    expect(
      resizeBrowserViewportFromRail(
        { width: 560, height: 409 },
        { x: -100, y: 0 },
        available,
        2,
        "east",
      ),
    ).toEqual({ width: 460, height: 409 });
  });
});
