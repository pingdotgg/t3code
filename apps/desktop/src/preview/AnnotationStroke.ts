/**
 * Incremental geometry for one freehand stroke of the in-app browser's
 * annotation Draw tool. Lives in its own electron-free module so the math can
 * be unit-tested without spinning up an Electron preload context
 * (`PickPreload.ts` itself imports `electron` and `react-grab/primitives`,
 * which can't load under vitest).
 *
 * A stroke grows by one point per `pointermove`, so everything here is O(1) in
 * the number of points already collected: points are pushed in place instead of
 * copied, the extents widen against the new point alone, and the SVG path keeps
 * the prefix it has already built so a new segment is one concatenation. That
 * also keeps the points out of `Math.min(...)`/`Math.max(...)`, which throws
 * `RangeError` once a stroke outgrows the engine's argument limit.
 */

import type { PreviewAnnotationPoint, PreviewAnnotationRect } from "@t3tools/contracts";

/**
 * Curve segments per rendered `<path>`. Rewriting a `d` attribute makes the
 * renderer re-parse the whole string, so the stroke is split across chunk
 * paths and only the growing chunk is ever rewritten: per-move parse cost is
 * bounded by this constant instead of growing with the stroke.
 */
export const STROKE_CHUNK_SEGMENTS = 100;

export interface StrokeGeometry {
  /** Shared with the stroke target: appended in place, never reallocated. */
  readonly points: PreviewAnnotationPoint[];
  /** Running extents of every point so far, before stroke-width padding. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** The `d` attribute minus its trailing segment, which the last point owns. */
  prefix: string;
  /** Same, for the chunk currently being rendered. */
  chunk: string;
  /** Curve segments committed to the current chunk so far. */
  chunkSegments: number;
  /** Final `d` of the chunk the last append closed, until the renderer takes it. */
  closedChunk: string | null;
}

export function beginStroke(point: PreviewAnnotationPoint): StrokeGeometry {
  return {
    points: [point],
    minX: point.x,
    minY: point.y,
    maxX: point.x,
    maxY: point.y,
    prefix: `M ${point.x} ${point.y}`,
    chunk: `M ${point.x} ${point.y}`,
    chunkSegments: 0,
    closedChunk: null,
  };
}

/** Appends `point`, widening the extents and the smoothed path to match. */
export function extendStroke(geometry: StrokeGeometry, point: PreviewAnnotationPoint): void {
  const previous = geometry.points[geometry.points.length - 1]!;
  // The quadratic through `previous` needs the point after it, so it can only
  // join the prefix now that `point` has arrived.
  if (geometry.points.length > 1) {
    const midX = (previous.x + point.x) / 2;
    const midY = (previous.y + point.y) / 2;
    const segment = ` Q ${previous.x} ${previous.y} ${midX} ${midY}`;
    geometry.prefix += segment;
    geometry.chunk += segment;
    geometry.chunkSegments += 1;
    // Cutting at a committed midpoint keeps the chunks tangent-continuous, so
    // adjacent chunk paths paint the same pixels as one uncut path.
    if (geometry.chunkSegments >= STROKE_CHUNK_SEGMENTS) {
      geometry.closedChunk = geometry.chunk;
      geometry.chunk = `M ${midX} ${midY}`;
      geometry.chunkSegments = 0;
    }
  }
  geometry.points.push(point);
  geometry.minX = Math.min(geometry.minX, point.x);
  geometry.minY = Math.min(geometry.minY, point.y);
  geometry.maxX = Math.max(geometry.maxX, point.x);
  geometry.maxY = Math.max(geometry.maxY, point.y);
}

/** The `d` attribute for the stroke as it stands, as one uncut path. */
export function strokePath(geometry: StrokeGeometry): string {
  if (geometry.points.length === 1) return `${geometry.prefix} l 0.01 0.01`;
  const last = geometry.points[geometry.points.length - 1]!;
  return `${geometry.prefix} L ${last.x} ${last.y}`;
}

/** The `d` attribute for the chunk currently being rendered. */
export function strokeChunkPath(geometry: StrokeGeometry): string {
  if (geometry.points.length === 1) return `${geometry.chunk} l 0.01 0.01`;
  const last = geometry.points[geometry.points.length - 1]!;
  return `${geometry.chunk} L ${last.x} ${last.y}`;
}

/** The finalized `d` of a chunk the last append closed, once per cut. */
export function takeClosedChunk(geometry: StrokeGeometry): string | null {
  const closed = geometry.closedChunk;
  geometry.closedChunk = null;
  return closed;
}

/** The stroke's painted extent, padded for the round cap of `width`. */
export function strokeBounds(geometry: StrokeGeometry, width: number): PreviewAnnotationRect {
  const padding = width + 3;
  const left = geometry.minX - padding;
  const top = geometry.minY - padding;
  const right = geometry.maxX + padding;
  const bottom = geometry.maxY + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
