import { describe, expect, it } from "vite-plus/test";

import {
  adjustedLuminance,
  BAYER_8,
  bottomPlacementFactor,
  composerFadeFactor,
  downscaledSize,
  errorDiffusionDither,
  heroFadeFactor,
  orderedDither,
  placeImage,
} from "./backdropMath";

const count = (cells: Uint8Array) => cells.reduce((sum, cell) => sum + cell, 0);

describe("errorDiffusionDither", () => {
  it("keeps the overall brightness of a flat grey field", () => {
    const field = new Float32Array(16 * 16).fill(0.5);
    const floyd = errorDiffusionDither(field, 16, 16, 0.5, "floyd");
    expect(count(floyd) / floyd.length).toBeCloseTo(0.5, 1);
  });

  it("pushes error to the right and down with Floyd–Steinberg weights", () => {
    const field = new Float32Array([0.6, 0, 0, 0]);
    const on = errorDiffusionDither(field, 2, 2, 0.5, "floyd");
    expect([...on]).toEqual([1, 0, 0, 0]);
    // The first cell overshot by -0.4: 7/16 right, 5/16 below, 1/16 diagonal.
    expect(field[1]).toBeCloseTo(-0.4 * (7 / 16));
    expect(field[2]).toBeCloseTo(-0.4 * (5 / 16));
    // Cell 1 went negative; clamped cells pass on no error of their own.
    expect(field[3]).toBeCloseTo(-0.4 * (1 / 16));
  });

  it("spreads only 6/8 of the error with Atkinson, so mid-grey reads lighter", () => {
    const field = new Float32Array([0.4, 0, 0, 0, 0, 0, 0, 0, 0]);
    errorDiffusionDither(field, 3, 3, 0.5, "atkinson");
    expect(field[1]).toBeCloseTo(0.05);
    expect(field[2]).toBeCloseTo(0.05 + 0.05 / 8);
    expect(field[3]).toBeCloseTo(0.05 + 0.05 / 8);
  });

  it("turns everything on for white and nothing on for black", () => {
    expect(count(errorDiffusionDither(new Float32Array(9).fill(1), 3, 3, 0.5, "atkinson"))).toBe(9);
    expect(count(errorDiffusionDither(new Float32Array(9).fill(0), 3, 3, 0.5, "floyd"))).toBe(0);
  });
});

describe("orderedDither", () => {
  it("uses every Bayer level exactly once in an 8×8 tile", () => {
    expect(BAYER_8.flat().toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 64 }, (_, i) => i),
    );
  });

  it("lights a share of cells that follows the value", () => {
    const quarter = orderedDither(new Float32Array(64).fill(0.25), 8, 8);
    expect(count(quarter)).toBe(16);
  });

  it("lights more cells when the threshold drops", () => {
    const field = new Float32Array(64).fill(0.5);
    expect(count(orderedDither(field, 8, 8, 0.3))).toBeGreaterThan(
      count(orderedDither(field, 8, 8)),
    );
  });
});

describe("image adjustments", () => {
  it("inverts, raises contrast and brightens around mid-grey", () => {
    expect(adjustedLuminance(255, 255, 255, 0, 0, false)).toBeCloseTo(1);
    expect(adjustedLuminance(255, 255, 255, 0, 0, true)).toBeCloseTo(0);
    expect(adjustedLuminance(160, 160, 160, 100, 0, false)).toBeGreaterThan(
      adjustedLuminance(160, 160, 160, 0, 0, false),
    );
    expect(adjustedLuminance(100, 100, 100, 0, 50, false)).toBeGreaterThan(
      adjustedLuminance(100, 100, 100, 0, 0, false),
    );
  });

  it("downscales the longer side and never enlarges", () => {
    expect(downscaledSize(4000, 3000, 960)).toEqual({ width: 960, height: 720 });
    expect(downscaledSize(300, 200, 960)).toEqual({ width: 300, height: 200 });
  });

  it("covers for fill and contains for fit around the focal point", () => {
    expect(placeImage(200, 100, 100, 100, "fill", 0.5, 0.5)).toEqual({
      x: -50,
      y: 0,
      width: 200,
      height: 100,
    });
    expect(placeImage(200, 100, 100, 100, "fill", 0, 0.5).x).toBeCloseTo(0);
    expect(placeImage(200, 100, 100, 100, "fit", 0.5, 0.5)).toEqual({
      x: 0,
      y: 25,
      width: 100,
      height: 50,
    });
  });
});

describe("masks", () => {
  it("clears the art under the composer and leaves the top alone", () => {
    expect(composerFadeFactor(0.5, 1, 0.75)).toBeLessThan(0.3);
    expect(composerFadeFactor(0.5, 0.1, 0.75)).toBe(1);
    expect(composerFadeFactor(0.5, 1, 0)).toBe(1);
  });

  it("dims at most 40% of the fade behind the headline", () => {
    expect(heroFadeFactor(0.5, 0.42, 0.42, 1)).toBeCloseTo(0.6);
    expect(heroFadeFactor(0.05, 0.9, 0.42, 1)).toBe(1);
  });

  it("keeps only the lower part for bottom placement", () => {
    expect(bottomPlacementFactor(0.1)).toBe(0);
    expect(bottomPlacementFactor(0.9)).toBe(1);
  });
});
