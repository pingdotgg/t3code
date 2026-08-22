import { describe, expect, it } from "vite-plus/test";

import {
  clampMermaidZoom,
  fitMermaidViewport,
  keepMermaidViewportInScene,
  MAX_MERMAID_OVERLAY_ZOOM,
  mermaidOverlayZoomPercent,
  mermaidSvgContentSize,
  mermaidViewportContentCenter,
  MIN_MERMAID_OVERLAY_ZOOM,
  panMermaidViewport,
  resetMermaidViewport,
  zoomMermaidViewportAtPoint,
} from "./mermaidViewport";

describe("clampMermaidZoom", () => {
  it("keeps in-range zoom unchanged", () => {
    expect(clampMermaidZoom(1)).toBe(1);
    expect(clampMermaidZoom(2.5)).toBe(2.5);
  });

  it("clamps relative to the fitted zoom", () => {
    expect(clampMermaidZoom(0, 0.5)).toBe(0.5 * MIN_MERMAID_OVERLAY_ZOOM);
    expect(clampMermaidZoom(100, 0.5)).toBe(0.5 * MAX_MERMAID_OVERLAY_ZOOM);
    expect(clampMermaidZoom(Number.NaN, 0.5)).toBe(0.5);
  });
});

describe("panMermaidViewport", () => {
  it("shifts translation without changing zoom", () => {
    expect(panMermaidViewport({ x: 10, y: 20, zoom: 2 }, 4, -6)).toEqual({
      x: 14,
      y: 14,
      zoom: 2,
    });
  });

  it("returns the same viewport when the delta is zero", () => {
    const viewport = { x: 1, y: 2, zoom: 3 };
    expect(panMermaidViewport(viewport, 0, 0)).toBe(viewport);
  });
});

describe("zoomMermaidViewportAtPoint", () => {
  it("keeps the focal point stationary", () => {
    const viewport = { x: 10, y: 20, zoom: 1 };
    const point = { x: 100, y: 80 };
    const next = zoomMermaidViewportAtPoint(viewport, 2, point);
    expect(next.zoom).toBe(2);
    expect((point.x - next.x) / next.zoom).toBeCloseTo((point.x - viewport.x) / viewport.zoom);
    expect((point.y - next.y) / next.zoom).toBeCloseTo((point.y - viewport.y) / viewport.zoom);
  });

  it("does not move when zoom is already at a clamp bound", () => {
    const viewport = { x: 5, y: 5, zoom: MAX_MERMAID_OVERLAY_ZOOM };
    expect(zoomMermaidViewportAtPoint(viewport, 99, { x: 40, y: 40 })).toBe(viewport);
  });
});

describe("fitMermaidViewport", () => {
  it("centers a wide diagram and scales it to the scene", () => {
    const viewport = fitMermaidViewport(
      { width: 400, height: 300 },
      { width: 800, height: 100 },
      0,
    );
    expect(viewport.zoom).toBe(0.5);
    expect(viewport.x).toBe(0);
    expect(viewport.y).toBe(125);
  });

  it("falls back to identity when either box is empty", () => {
    expect(fitMermaidViewport({ width: 0, height: 100 }, { width: 10, height: 10 })).toEqual(
      resetMermaidViewport(),
    );
  });
});

describe("mermaidOverlayZoomPercent", () => {
  it("treats the fitted zoom as 100%", () => {
    expect(mermaidOverlayZoomPercent(0.75, 0.75)).toBe(100);
    expect(mermaidOverlayZoomPercent(1.5, 0.75)).toBe(200);
  });
});

describe("keepMermaidViewportInScene", () => {
  it("pulls a diagram that was translated fully off-canvas back into view", () => {
    const next = keepMermaidViewportInScene(
      { x: -4000, y: -4000, zoom: 2 },
      { width: 400, height: 300 },
      { width: 200, height: 80 },
      40,
    );
    expect(next.x).toBe(40 - 400);
    expect(next.y).toBe(40 - 160);
  });
});

describe("zoomMermaidViewportAtPoint around the content center", () => {
  it("keeps the diagram center fixed when zooming from a fitted view", () => {
    const content = { width: 800, height: 100 };
    const fitted = fitMermaidViewport({ width: 400, height: 300 }, content, 0);
    const center = mermaidViewportContentCenter(fitted, content);
    const next = zoomMermaidViewportAtPoint(fitted, fitted.zoom * 2, center, fitted.zoom);
    const nextCenter = mermaidViewportContentCenter(next, content);
    expect(nextCenter.x).toBeCloseTo(center.x);
    expect(nextCenter.y).toBeCloseTo(center.y);
  });
});

describe("mermaidSvgContentSize", () => {
  it("reads viewBox dimensions", () => {
    expect(mermaidSvgContentSize(`<svg viewBox="0 0 248.22 127" width="100%"></svg>`)).toEqual({
      width: 248.22,
      height: 127,
    });
  });

  it("falls back to numeric width and height attributes", () => {
    expect(mermaidSvgContentSize(`<svg width="320px" height="80"></svg>`)).toEqual({
      width: 320,
      height: 80,
    });
  });

  it("ignores percentage width without a viewBox", () => {
    expect(mermaidSvgContentSize(`<svg width="100%" height="100%"></svg>`)).toBeNull();
  });
});
