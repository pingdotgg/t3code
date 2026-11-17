import type { PreviewAnnotationPoint, PreviewAnnotationRect } from "@t3tools/contracts";

// Setting a path's `d` makes Chromium parse the whole string again, so a long
// stroke is drawn as a run of paths and only the last one is rewritten per move.
export const STROKE_SEGMENTS_PER_PATH = 100;

export interface StrokeGeometry {
  readonly points: PreviewAnnotationPoint[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  // The curve through the newest point is still open: where it ends depends on
  // the point after it. This holds only the settled segments of the last path.
  openPath: string;
  openSegments: number;
}

export function startStroke(point: PreviewAnnotationPoint): StrokeGeometry {
  return {
    points: [point],
    minX: point.x,
    minY: point.y,
    maxX: point.x,
    maxY: point.y,
    openPath: `M ${point.x} ${point.y}`,
    openSegments: 0,
  };
}

// Returns the final `d` of the path this point filled, if it filled one.
export function addStrokePoint(
  geometry: StrokeGeometry,
  point: PreviewAnnotationPoint,
): string | null {
  const previous = geometry.points[geometry.points.length - 1]!;
  let closedPath: string | null = null;
  if (geometry.points.length > 1) {
    const midX = (previous.x + point.x) / 2;
    const midY = (previous.y + point.y) / 2;
    geometry.openPath += ` Q ${previous.x} ${previous.y} ${midX} ${midY}`;
    geometry.openSegments += 1;
    if (geometry.openSegments === STROKE_SEGMENTS_PER_PATH) {
      closedPath = geometry.openPath;
      geometry.openPath = `M ${midX} ${midY}`;
      geometry.openSegments = 0;
    }
  }
  geometry.points.push(point);
  geometry.minX = Math.min(geometry.minX, point.x);
  geometry.minY = Math.min(geometry.minY, point.y);
  geometry.maxX = Math.max(geometry.maxX, point.x);
  geometry.maxY = Math.max(geometry.maxY, point.y);
  return closedPath;
}

export function openStrokePath(geometry: StrokeGeometry): string {
  const last = geometry.points[geometry.points.length - 1]!;
  return `${geometry.openPath} L ${last.x} ${last.y}`;
}

export function strokeBounds(geometry: StrokeGeometry, width: number): PreviewAnnotationRect {
  const padding = width + 3;
  const left = geometry.minX - padding;
  const top = geometry.minY - padding;
  const right = geometry.maxX + padding;
  const bottom = geometry.maxY + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
