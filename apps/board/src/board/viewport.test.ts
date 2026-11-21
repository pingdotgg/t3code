import { describe, expect, it } from "vite-plus/test";

import {
  FIT_FLOOR,
  INITIAL_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  fitToContent,
  panBy,
  revealDelta,
  zoomAt,
  type View,
} from "./viewport";

const worldPointAt = (view: View, px: number, py: number) => ({
  x: (px - view.x) / view.k,
  y: (py - view.y) / view.k,
});

describe("zoomAt", () => {
  it("keeps the point under the cursor within 0.5 px", () => {
    const start: View = { x: 120, y: -45, k: 0.85 };
    for (const [px, py] of [
      [0, 0],
      [333, 417],
      [1200, 80],
    ] as const) {
      for (const factor of [1.2, 1 / 1.2, 1.5, 0.6]) {
        const before = worldPointAt(start, px, py);
        const next = zoomAt(start, start.k * factor, px, py);
        const after = { x: next.x + before.x * next.k, y: next.y + before.y * next.k };
        expect(Math.abs(after.x - px)).toBeLessThan(0.5);
        expect(Math.abs(after.y - py)).toBeLessThan(0.5);
      }
    }
  });

  it("clamps zoom to 0.3 and 2", () => {
    expect(zoomAt(INITIAL_VIEW, 100, 10, 10).k).toBe(MAX_ZOOM);
    expect(zoomAt(INITIAL_VIEW, 0.001, 10, 10).k).toBe(MIN_ZOOM);
  });

  it("keeps the cursor point fixed when the zoom is clamped", () => {
    const next = zoomAt({ x: 40, y: 60, k: 1.9 }, 5, 200, 300);
    expect(next.k).toBe(MAX_ZOOM);
    expect(next.x + ((200 - 40) / 1.9) * MAX_ZOOM).toBeCloseTo(200, 6);
  });
});

describe("panBy", () => {
  it("moves the origin without changing zoom", () => {
    expect(panBy({ x: 5, y: 6, k: 1.5 }, 200, -10)).toEqual({ x: 205, y: -4, k: 1.5 });
  });
});

describe("fitToContent", () => {
  const size = { width: 1000, height: 800 };

  it("never returns less than 0.7", () => {
    for (const side of [1500, 5000, 100_000]) {
      const view = fitToContent({ x: 0, y: 0, width: side, height: side }, size);
      expect(view.k).toBeGreaterThanOrEqual(FIT_FLOOR);
    }
  });

  it("shows the top left of content that is too large to fit", () => {
    const view = fitToContent({ x: 50, y: 20, width: 5000, height: 5000 }, size);
    expect(view.k).toBe(FIT_FLOOR);
    expect(view.x + 50 * view.k).toBeCloseTo(40, 6);
    expect(view.y + 20 * view.k).toBeCloseTo(40, 6);
  });

  it("resets to the initial view when there is no content", () => {
    expect(fitToContent(null, size)).toEqual(INITIAL_VIEW);
  });
});

describe("revealDelta", () => {
  const frame = { x: 0, y: 0, width: 800, height: 600 };

  it("Given a target already inside the frame, when it is revealed, then nothing pans", () => {
    expect(revealDelta({ x: 100, y: 100, width: 200, height: 200 }, frame, 24)).toEqual({
      dx: 0,
      dy: 0,
    });
  });

  it("Given a target below the frame, when it is revealed, then it pans up to the bottom margin", () => {
    expect(revealDelta({ x: 100, y: 500, width: 200, height: 200 }, frame, 24)).toEqual({
      dx: 0,
      dy: -124,
    });
  });

  it("Given a target left of the frame, when it is revealed, then it pans right to the left margin", () => {
    expect(revealDelta({ x: -300, y: 100, width: 200, height: 200 }, frame, 24)).toEqual({
      dx: 324,
      dy: 0,
    });
  });
});
