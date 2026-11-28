import type { PreviewAnnotationPoint } from "@t3tools/contracts";

// Same geometry as apps/desktop/src/preview/AnnotationStroke.ts: the preview preload bundle
// must stay self-contained, so the browser Draw tool keeps its own copy.

// Setting a path's `d` makes Chromium parse the whole string again, so a long
// stroke is drawn as a run of paths and only the last one is rewritten per move.
const STROKE_SEGMENTS_PER_PATH = 100;

export interface StrokeGeometry {
  readonly points: PreviewAnnotationPoint[];
  // The curve through the newest point is still open: where it ends depends on
  // the point after it. This holds only the settled segments of the last path.
  openPath: string;
  openSegments: number;
}

export function startStroke(point: PreviewAnnotationPoint): StrokeGeometry {
  return {
    points: [point],
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
  return closedPath;
}

export function openStrokePath(geometry: StrokeGeometry): string {
  const last = geometry.points[geometry.points.length - 1]!;
  return `${geometry.openPath} L ${last.x} ${last.y}`;
}
