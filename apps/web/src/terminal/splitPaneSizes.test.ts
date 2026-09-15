import { describe, expect, it } from "vite-plus/test";

import {
  constrainPaneSizes,
  equalPaneSizes,
  paneBoundaryOffsets,
  paneGridTemplate,
  panePixelBoundaries,
  resizeAdjacentPanes,
  resolvePaneSizes,
  snapPaneSizesToWholePixels,
} from "./splitPaneSizes";

describe("constrainPaneSizes", () => {
  it("returns unchanged when all panes fit at minimum", () => {
    const sizes = [0.25, 0.75];
    const result = constrainPaneSizes(sizes, 1000, 160);
    expect(result).toEqual(sizes);
    expect(result).not.toBe(sizes);
  });

  it("raises a below-min pane and takes the deficit proportionally", () => {
    const result = constrainPaneSizes([0.1, 0.3, 0.6], 1000, 200);
    expect(result[0]!).toBeCloseTo(0.2, 5);
    expect(result[1]!).toBeCloseTo(0.28, 5);
    expect(result[2]!).toBeCloseTo(0.52, 5);
  });

  it("sums to exactly 1", () => {
    const result = constrainPaneSizes([0.05, 0.25, 0.7], 1000, 200);
    expect(result.reduce((total, size) => total + size, 0)).toBe(1);
  });

  it("falls back to equal sizes when the container cannot fit every minimum", () => {
    expect(constrainPaneSizes([0.1, 0.2, 0.7], 400, 160)).toEqual(equalPaneSizes(3));
  });

  it("returns a copy unchanged when containerPx <= 0", () => {
    const sizes = [0.25, 0.75];
    const result = constrainPaneSizes(sizes, 0, 160);
    expect(result).toEqual(sizes);
    expect(result).not.toBe(sizes);
  });

  it("returns a copy unchanged for a single pane", () => {
    const sizes = [1];
    const result = constrainPaneSizes(sizes, 100, 160);
    expect(result).toEqual(sizes);
    expect(result).not.toBe(sizes);
  });

  it("never mutates the input", () => {
    const sizes = [0.1, 0.3, 0.6];
    const copy = [...sizes];
    constrainPaneSizes(sizes, 1000, 200);
    expect(sizes).toEqual(copy);
  });
});

describe("equalPaneSizes", () => {
  it("returns empty array for count <= 0", () => {
    expect(equalPaneSizes(0)).toEqual([]);
    expect(equalPaneSizes(-1)).toEqual([]);
  });

  it("returns equal fractions for count > 0", () => {
    expect(equalPaneSizes(1)).toEqual([1]);
    expect(equalPaneSizes(2)).toEqual([0.5, 0.5]);
    expect(equalPaneSizes(3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(equalPaneSizes(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("sums to 1", () => {
    for (const count of [1, 2, 3, 5, 10]) {
      const sizes = equalPaneSizes(count);
      const sum = sizes.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
    }
  });
});

describe("resolvePaneSizes", () => {
  it("returns equalPaneSizes when sizes is undefined", () => {
    expect(resolvePaneSizes(undefined, 2)).toEqual([0.5, 0.5]);
    expect(resolvePaneSizes(undefined, 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("returns equalPaneSizes when length mismatch", () => {
    expect(resolvePaneSizes([0.5, 0.5], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(resolvePaneSizes([0.25, 0.25, 0.25, 0.25], 2)).toEqual([0.5, 0.5]);
  });

  it("returns equalPaneSizes when entry is non-finite", () => {
    expect(resolvePaneSizes([0.5, NaN], 2)).toEqual([0.5, 0.5]);
    expect(resolvePaneSizes([0.5, Infinity], 2)).toEqual([0.5, 0.5]);
  });

  it("returns equalPaneSizes when entry is <= 0", () => {
    expect(resolvePaneSizes([0.5, 0], 2)).toEqual([0.5, 0.5]);
    expect(resolvePaneSizes([0.5, -0.1], 2)).toEqual([0.5, 0.5]);
  });

  it("normalizes valid sizes to sum to 1", () => {
    expect(resolvePaneSizes([1, 1], 2)).toEqual([0.5, 0.5]);
    expect(resolvePaneSizes([1, 2, 3], 3)).toEqual([1 / 6, 2 / 6, 3 / 6]);
    expect(resolvePaneSizes([2, 3, 5], 3)).toEqual([0.2, 0.3, 0.5]);
  });

  it("returns a new array, not the input", () => {
    const input = [0.5, 0.5];
    const result = resolvePaneSizes(input, 2);
    expect(result).not.toBe(input);
  });
});

describe("resizeAdjacentPanes", () => {
  it("returns a copy when containerPx <= 0", () => {
    const sizes = [0.5, 0.5];
    const result = resizeAdjacentPanes({
      sizes,
      handleIndex: 0,
      deltaPx: 10,
      containerPx: 0,
      minPanePx: 100,
    });
    expect(result).toEqual(sizes);
    expect(result).not.toBe(sizes);
  });

  it("returns a copy when handleIndex out of range", () => {
    const sizes = [0.5, 0.5];
    expect(
      resizeAdjacentPanes({
        sizes,
        handleIndex: -1,
        deltaPx: 10,
        containerPx: 100,
        minPanePx: 50,
      }),
    ).toEqual(sizes);

    expect(
      resizeAdjacentPanes({
        sizes,
        handleIndex: 1,
        deltaPx: 10,
        containerPx: 100,
        minPanePx: 50,
      }),
    ).toEqual(sizes);

    expect(
      resizeAdjacentPanes({
        sizes,
        handleIndex: 2,
        deltaPx: 10,
        containerPx: 100,
        minPanePx: 50,
      }),
    ).toEqual(sizes);
  });

  it("returns a copy when deltaPx is not finite", () => {
    const sizes = [0.5, 0.5];
    expect(
      resizeAdjacentPanes({
        sizes,
        handleIndex: 0,
        deltaPx: NaN,
        containerPx: 100,
        minPanePx: 50,
      }),
    ).toEqual(sizes);

    expect(
      resizeAdjacentPanes({
        sizes,
        handleIndex: 0,
        deltaPx: Infinity,
        containerPx: 100,
        minPanePx: 50,
      }),
    ).toEqual(sizes);
  });

  it("grows left pane and shrinks right with positive deltaPx", () => {
    const result = resizeAdjacentPanes({
      sizes: [0.5, 0.5],
      handleIndex: 0,
      deltaPx: 25,
      containerPx: 200,
      minPanePx: 20,
    });
    expect(result[0]!).toBeCloseTo(0.625, 5);
    expect(result[1]!).toBeCloseTo(0.375, 5);
  });

  it("shrinks left pane and grows right with negative deltaPx", () => {
    const result = resizeAdjacentPanes({
      sizes: [0.5, 0.5],
      handleIndex: 0,
      deltaPx: -25,
      containerPx: 200,
      minPanePx: 20,
    });
    expect(result[0]!).toBeCloseTo(0.375, 5);
    expect(result[1]!).toBeCloseTo(0.625, 5);
  });

  it("preserves combined fraction of two panes", () => {
    const sizes = [0.3, 0.7];
    const result = resizeAdjacentPanes({
      sizes,
      handleIndex: 0,
      deltaPx: 50,
      containerPx: 100,
      minPanePx: 10,
    });
    const combined = (result[0] ?? 0) + (result[1] ?? 0);
    expect(combined).toBeCloseTo(1.0, 5);
  });

  it("clamps to minimum fraction at left edge", () => {
    const result = resizeAdjacentPanes({
      sizes: [0.5, 0.5],
      handleIndex: 0,
      deltaPx: -100,
      containerPx: 200,
      minPanePx: 80,
    });
    expect(result[0]!).toBeCloseTo(0.4, 5);
    expect(result[1]!).toBeCloseTo(0.6, 5);
  });

  it("clamps to minimum fraction at right edge", () => {
    const result = resizeAdjacentPanes({
      sizes: [0.5, 0.5],
      handleIndex: 0,
      deltaPx: 100,
      containerPx: 200,
      minPanePx: 80,
    });
    expect(result[0]!).toBeCloseTo(0.6, 5);
    expect(result[1]!).toBeCloseTo(0.4, 5);
  });

  it("uses half of combined when pair is too small for both mins", () => {
    const result = resizeAdjacentPanes({
      sizes: [0.1, 0.1],
      handleIndex: 0,
      deltaPx: 50,
      containerPx: 100,
      minPanePx: 60,
    });
    expect(result[0]!).toBeCloseTo(0.1, 5);
    expect(result[1]!).toBeCloseTo(0.1, 5);
  });

  it("does not mutate input", () => {
    const sizes = [0.5, 0.5];
    const sizesCopy = [...sizes];
    resizeAdjacentPanes({
      sizes,
      handleIndex: 0,
      deltaPx: 50,
      containerPx: 100,
      minPanePx: 10,
    });
    expect(sizes).toEqual(sizesCopy);
  });

  it("works with multiple panes", () => {
    const sizes = [0.25, 0.25, 0.25, 0.25];
    const result = resizeAdjacentPanes({
      sizes,
      handleIndex: 1,
      deltaPx: 10,
      containerPx: 200,
      minPanePx: 10,
    });
    expect(result[0]!).toBeCloseTo(0.25, 5);
    expect(result[1]!).toBeCloseTo(0.3, 5);
    expect(result[2]!).toBeCloseTo(0.2, 5);
    expect(result[3]!).toBeCloseTo(0.25, 5);
  });
});

describe("paneGridTemplate", () => {
  it("formats single pane", () => {
    expect(paneGridTemplate([1])).toBe("minmax(0, 1fr)");
  });

  it("formats two equal panes", () => {
    expect(paneGridTemplate([0.5, 0.5])).toBe("minmax(0, 0.5fr) minmax(0, 0.5fr)");
  });

  it("formats three equal panes", () => {
    expect(paneGridTemplate([1 / 3, 1 / 3, 1 / 3])).toBe(
      "minmax(0, 0.333333fr) minmax(0, 0.333333fr) minmax(0, 0.333333fr)",
    );
  });

  it("formats unequal panes", () => {
    const result = paneGridTemplate([0.25, 0.75]);
    expect(result).toBe("minmax(0, 0.25fr) minmax(0, 0.75fr)");
  });

  it("limits fractions to 6 decimal places", () => {
    const result = paneGridTemplate([0.3333333, 0.6666667]);
    expect(result).toContain("0.333333");
    expect(result).toContain("0.666667");
  });
});

describe("paneBoundaryOffsets", () => {
  it("returns empty array for single pane", () => {
    expect(paneBoundaryOffsets([1])).toEqual([]);
  });

  it("returns correct offsets for two equal panes", () => {
    expect(paneBoundaryOffsets([0.5, 0.5])).toEqual([0.5]);
  });

  it("returns correct offsets for two unequal panes", () => {
    expect(paneBoundaryOffsets([0.25, 0.75])).toEqual([0.25]);
  });

  it("returns correct offsets for three equal panes", () => {
    expect(paneBoundaryOffsets([1 / 3, 1 / 3, 1 / 3])).toEqual([1 / 3, 2 / 3]);
  });

  it("returns correct offsets for three unequal panes", () => {
    const result = paneBoundaryOffsets([0.25, 0.25, 0.5]);
    expect(result[0]!).toBeCloseTo(0.25, 5);
    expect(result[1]!).toBeCloseTo(0.5, 5);
  });

  it("has length sizes.length - 1", () => {
    for (const count of [1, 2, 3, 5, 10]) {
      const sizes = equalPaneSizes(count);
      const offsets = paneBoundaryOffsets(sizes);
      expect(offsets).toHaveLength(count - 1);
    }
  });

  it("boundary offsets are in range [0, 1)", () => {
    const sizes = [0.1, 0.2, 0.3, 0.4];
    const offsets = paneBoundaryOffsets(sizes);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(1);
    }
  });

  it("boundary offsets are increasing", () => {
    const sizes = [0.1, 0.2, 0.3, 0.4];
    const offsets = paneBoundaryOffsets(sizes);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    }
  });
});

describe("snapPaneSizesToWholePixels", () => {
  it("snaps boundaries to increasing whole pixels and preserves the total", () => {
    const result = snapPaneSizesToWholePixels([0.333333, 0.333333, 0.333334], 101);
    const boundaries = panePixelBoundaries(result, 101);

    expect(boundaries).toEqual([34, 67]);
    expect(boundaries.every(Number.isInteger)).toBe(true);
    expect(boundaries[1]!).toBeGreaterThan(boundaries[0]!);
    expect(result.reduce((total, size) => total + size, 0)).toBe(1);
  });

  it("returns a copy unchanged when containerPx <= 0", () => {
    const sizes = [0.25, 0.75];
    const result = snapPaneSizesToWholePixels(sizes, 0);
    expect(result).toEqual(sizes);
    expect(result).not.toBe(sizes);
  });

  it("returns a copy unchanged for a single pane", () => {
    const sizes = [1];
    const result = snapPaneSizesToWholePixels(sizes, 100);
    expect(result).toEqual(sizes);
    expect(result).not.toBe(sizes);
  });

  it("does not mutate the input", () => {
    const sizes = [0.333333, 0.333333, 0.333334];
    const copy = [...sizes];
    snapPaneSizesToWholePixels(sizes, 101);
    expect(sizes).toEqual(copy);
  });

  it("clamps boundaries within the valid pixel range", () => {
    const result = snapPaneSizesToWholePixels([0.001, 0.001, 0.998], 100);
    expect(panePixelBoundaries(result, 100)).toEqual([1, 2]);

    const endClamped = snapPaneSizesToWholePixels([0.998, 0.001, 0.001], 100);
    expect(panePixelBoundaries(endClamped, 100)).toEqual([98, 99]);
  });
});

describe("panePixelBoundaries", () => {
  it("returns increasing whole-pixel internal boundaries in range", () => {
    const boundaries = panePixelBoundaries([0.25, 0.25, 0.5], 101);
    expect(boundaries).toHaveLength(2);
    expect(boundaries.every(Number.isInteger)).toBe(true);
    expect(boundaries[1]!).toBeGreaterThan(boundaries[0]!);
    for (const boundary of boundaries) {
      expect(boundary).toBeGreaterThanOrEqual(1);
      expect(boundary).toBeLessThanOrEqual(100);
    }
  });
});
