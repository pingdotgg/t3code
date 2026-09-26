import { describe, expect, it } from "vite-plus/test";

import {
  imagePointFromClient,
  imageRegionBetween,
  imageRegionCitationName,
  imageRegionCrop,
  isCitableImageRegion,
} from "./imageRegionCitation";

describe("image region selection", () => {
  const bounds = { left: 100, top: 50, width: 400, height: 200 };

  it("spans the same region whichever way the drag went, clamped to the image", () => {
    const start = imagePointFromClient({ x: 150, y: 100 }, bounds);
    const end = imagePointFromClient({ x: 50, y: 300 }, bounds);
    const expected = { x: 0, y: 0.25, width: 0.125, height: 0.75 };

    expect(imageRegionBetween(start, end)).toEqual(expected);
    expect(imageRegionBetween(end, start)).toEqual(expected);
  });

  it("measures stray clicks at the zoom the region was drawn", () => {
    const sliver = { x: 0.5, y: 0.25, width: 0.01, height: 0.5 };

    expect(isCitableImageRegion(sliver, bounds)).toBe(false);
    expect(isCitableImageRegion(sliver, { ...bounds, width: 800, height: 400 })).toBe(true);
  });
});

describe("imageRegionCrop", () => {
  it("pads the region by a quarter of its longer side", () => {
    const crop = imageRegionCrop(
      { x: 0.4, y: 0.5, width: 0.2, height: 0.1 },
      { width: 1000, height: 800 },
    );

    expect(crop.source).toEqual({ x: 350, y: 350, width: 300, height: 180 });
    expect(crop).toMatchObject({ width: 300, height: 180, lineWidth: 2 });
    expect(crop.region).toEqual({ x: 50, y: 50, width: 200, height: 80 });
  });

  it("clamps the padding at the image edges", () => {
    const crop = imageRegionCrop(
      { x: 0, y: 0, width: 0.1, height: 0.1 },
      { width: 1000, height: 800 },
    );

    expect(crop.source).toEqual({ x: 0, y: 0, width: 125, height: 105 });
    expect(crop.region).toEqual({ x: 0, y: 0, width: 100, height: 80 });
  });

  it("keeps some surroundings around a tiny region in a large image", () => {
    const crop = imageRegionCrop(
      { x: 0.5, y: 0.5, width: 0.01, height: 0.01 },
      { width: 4000, height: 3000 },
    );

    expect(crop.source).toEqual({ x: 1920, y: 1420, width: 200, height: 190 });
    expect(crop.region).toEqual({ x: 80, y: 80, width: 40, height: 30 });
  });

  it("downscales large crops and maps the region into the smaller crop", () => {
    const crop = imageRegionCrop(
      { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      { width: 8000, height: 6000 },
    );

    expect(crop.source).toEqual({ x: 0, y: 0, width: 8000, height: 6000 });
    expect(crop).toMatchObject({ width: 2048, height: 1536, lineWidth: 5 });
    expect(crop.region.x).toBeCloseTo(204.8);
    expect(crop.region.y).toBeCloseTo(153.6);
    expect(crop.region.width).toBeCloseTo(1638.4);
    expect(crop.region.height).toBeCloseTo(1228.8);
  });
});

describe("imageRegionCitationName", () => {
  it("names the crop after the source file", () => {
    expect(imageRegionCitationName("docs/shots/settings.png")).toBe("settings region.png");
    expect(imageRegionCitationName("C:\\Users\\me\\shot.JPEG")).toBe("shot region.png");
    expect(imageRegionCitationName("Settings page")).toBe("Settings page region.png");
  });

  it("falls back when the source has no usable name", () => {
    expect(imageRegionCitationName("")).toBe("image region.png");
    expect(imageRegionCitationName(".png")).toBe("image region.png");
  });
});
