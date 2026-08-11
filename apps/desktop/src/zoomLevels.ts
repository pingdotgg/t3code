/** Discrete zoom levels mirroring Chrome's preset list. */
export const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

export const DEFAULT_ZOOM_FACTOR = 1.0;
export const ZOOM_EPSILON = 0.001;

export type ZoomDirection = "in" | "out";

/**
 * Next preset in the travel direction. An off-ladder factor snaps to the
 * neighbouring preset on that side rather than skipping past it, matching how
 * Chrome resumes stepping from an arbitrary zoom factor.
 */
export function nextZoomLevel(current: number, direction: ZoomDirection): number {
  const zoomFactor = Number.isFinite(current) && current > 0 ? current : DEFAULT_ZOOM_FACTOR;
  const lowest = ZOOM_LEVELS[0] ?? DEFAULT_ZOOM_FACTOR;
  const highest = ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? DEFAULT_ZOOM_FACTOR;

  if (direction === "in") {
    return ZOOM_LEVELS.find((level) => level > zoomFactor + ZOOM_EPSILON) ?? highest;
  }
  return [...ZOOM_LEVELS].reverse().find((level) => level < zoomFactor - ZOOM_EPSILON) ?? lowest;
}
