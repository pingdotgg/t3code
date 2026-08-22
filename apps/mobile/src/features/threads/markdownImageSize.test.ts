import { describe, expect, it } from "vite-plus/test";

import {
  MARKDOWN_IMAGE_MAX_HEIGHT,
  MARKDOWN_IMAGE_MAX_WIDTH,
  resolveMarkdownImageDisplaySize,
} from "./markdownImageSize";

describe("resolveMarkdownImageDisplaySize", () => {
  it("keeps small images at their intrinsic size", () => {
    expect(
      resolveMarkdownImageDisplaySize({
        sourceWidth: 96,
        sourceHeight: 96,
        availableWidth: 332,
      }),
    ).toEqual({ width: 96, height: 96 });
  });

  it("fits wide images to the available chat width", () => {
    expect(
      resolveMarkdownImageDisplaySize({
        sourceWidth: 960,
        sourceHeight: 540,
        availableWidth: 332,
      }),
    ).toEqual({ width: 332, height: 186.75 });
  });

  it("caps wide images at 480 points on larger screens", () => {
    expect(
      resolveMarkdownImageDisplaySize({
        sourceWidth: 960,
        sourceHeight: 540,
        availableWidth: 900,
      }),
    ).toEqual({ width: MARKDOWN_IMAGE_MAX_WIDTH, height: 270 });
  });

  it("caps tall images by height without changing their aspect ratio", () => {
    expect(
      resolveMarkdownImageDisplaySize({
        sourceWidth: 400,
        sourceHeight: 800,
        availableWidth: 332,
      }),
    ).toEqual({ width: 240, height: MARKDOWN_IMAGE_MAX_HEIGHT });
  });

  it("rejects dimensions that cannot produce a stable layout", () => {
    expect(
      resolveMarkdownImageDisplaySize({ sourceWidth: 0, sourceHeight: 100, availableWidth: 332 }),
    ).toBeNull();
    expect(
      resolveMarkdownImageDisplaySize({
        sourceWidth: 100,
        sourceHeight: Number.NaN,
        availableWidth: 332,
      }),
    ).toBeNull();
  });
});
