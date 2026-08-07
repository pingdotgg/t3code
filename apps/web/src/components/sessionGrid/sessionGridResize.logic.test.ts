import { describe, expect, it } from "vite-plus/test";

import {
  equalSessionGridTrackSizes,
  resizeSessionGridTrackBoundary,
  resolveSessionGridTrackSizes,
  sessionGridTrackBoundaryPositions,
  sessionGridTrackTemplate,
} from "./sessionGridResize.logic";

describe("session grid resize tracks", () => {
  it("falls back to equal tracks when persisted sizing is missing or invalid", () => {
    expect(equalSessionGridTrackSizes(3)).toEqual([1, 1, 1]);
    expect(resolveSessionGridTrackSizes(undefined, 2)).toEqual([1, 1]);
    expect(resolveSessionGridTrackSizes([2, 1], 3)).toEqual([1, 1, 1]);
    expect(resolveSessionGridTrackSizes([2, Number.NaN], 2)).toEqual([1, 1]);
    expect(resolveSessionGridTrackSizes([2, 1], 2)).toEqual([2, 1]);
  });

  it("resizes only the two tracks adjacent to a dragged boundary", () => {
    const next = resizeSessionGridTrackBoundary({
      sizes: [1, 1, 1],
      boundaryIndex: 0,
      deltaPx: 100,
      availableSizePx: 1_000,
      minimumTrackSizePx: 200,
    });

    expect(next[0]).toBeCloseTo(1.3);
    expect(next[1]).toBeCloseTo(0.7);
    expect(next[2]).toBe(1);
    expect(next.reduce((sum, size) => sum + size, 0)).toBeCloseTo(3);
  });

  it("clamps both sides of a boundary to the minimum usable pane size", () => {
    const leadingMinimum = resizeSessionGridTrackBoundary({
      sizes: [1, 1],
      boundaryIndex: 0,
      deltaPx: -10_000,
      availableSizePx: 1_000,
      minimumTrackSizePx: 240,
    });
    const trailingMinimum = resizeSessionGridTrackBoundary({
      sizes: [1, 1],
      boundaryIndex: 0,
      deltaPx: 10_000,
      availableSizePx: 1_000,
      minimumTrackSizePx: 240,
    });

    expect(leadingMinimum).toEqual([0.48, 1.52]);
    expect(trailingMinimum).toEqual([1.52, 0.48]);
  });

  it("positions handles in the middle of fixed grid gaps", () => {
    expect(sessionGridTrackBoundaryPositions({ sizes: [1, 1], gapPx: 12 })).toEqual([
      { boundaryKey: "track-boundary:0", percentage: 50, offsetPx: 0 },
    ]);
    expect(sessionGridTrackBoundaryPositions({ sizes: [2, 1, 1], gapPx: 12 })).toEqual([
      { boundaryKey: "track-boundary:0", percentage: 50, offsetPx: -6 },
      { boundaryKey: "track-boundary:1", percentage: 75, offsetPx: 0 },
    ]);
  });

  it("builds flexible templates without allowing collapsed tracks", () => {
    expect(sessionGridTrackTemplate([2, 0, 1])).toBe(
      "minmax(0, 2fr) minmax(0, 0.1fr) minmax(0, 1fr)",
    );
  });
});
