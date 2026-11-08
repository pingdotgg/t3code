import { describe, expect, it } from "vite-plus/test";

import { applyChatBackgroundEffect } from "./chatBackgroundEffects";

const solid = (width: number, height: number, rgba: readonly number[]) => ({
  width,
  height,
  pixels: new Uint8ClampedArray(Array.from({ length: width * height }, () => rgba).flat()),
});

describe("applyChatBackgroundEffect", () => {
  it("dithers bright cells to full brightness and dark cells toward black, in 2px blocks", () => {
    const bright = applyChatBackgroundEffect(solid(4, 4, [200, 100, 50, 255]), "dither", false);
    expect(Array.from(bright.subarray(0, 4))).toEqual([255, 127, 64, 255]);
    // Every pixel of the first 2x2 block shares a color.
    expect(bright.slice(4, 8)).toEqual(bright.slice(0, 4));

    const dark = applyChatBackgroundEffect(solid(4, 4, [5, 5, 5, 255]), "dither", false);
    expect(dark[0]).toBe(0);
  });

  it("darkens every third row for scanlines and lightens it on light themes", () => {
    const source = solid(1, 3, [100, 100, 100, 255]);
    expect(applyChatBackgroundEffect(source, "scanlines", false)[0]).toBe(52);
    expect(applyChatBackgroundEffect(source, "scanlines", false)[4]).toBe(100);
    expect(applyChatBackgroundEffect(source, "scanlines", true)[0]).toBe(174);
  });
});
