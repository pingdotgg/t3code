/**
 * Planning space scene math — pure module, no DOM.
 *
 * Spec: docs/t3work-mvp/29-planning-space.md §3 (scene model), §4 (groupings).
 * Hard rules encoded here and guarded by tests:
 *  - layout is zoom-independent (no camera-coupled spacing)
 *  - cursor-anchored zoom is exact
 *  - masonry packing is deterministic and disjoint at every band
 */

export const FOCAL = 600;
export const Z_STORY = 260;
export const Z_EPIC = 520;
export const Z_CAMERA_MAX = 590;

export interface PlanningCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export function scaleForPlane(camZ: number, planeZ: number): number {
  return FOCAL / (FOCAL + planeZ - camZ);
}

export function projectPoint(
  camera: PlanningCamera,
  viewport: Viewport,
  point: WorldPoint,
  planeZ: number,
): { x: number; y: number; scale: number } {
  const scale = scaleForPlane(camera.z, planeZ);
  return {
    x: (point.x - camera.x) * scale + viewport.width / 2,
    y: (point.y - camera.y) * scale + viewport.height / 2,
    scale,
  };
}

export function unprojectAtStoryPlane(
  camera: PlanningCamera,
  viewport: Viewport,
  screenX: number,
  screenY: number,
): WorldPoint {
  const scale = scaleForPlane(camera.z, Z_STORY);
  return {
    x: (screenX - viewport.width / 2) / scale + camera.x,
    y: (screenY - viewport.height / 2) / scale + camera.y,
  };
}

/**
 * Perceptually constant zoom: Δz proportional to camera distance from the
 * story plane (§3.1). A constant Δz is too slow far out, too fast close in.
 */
export const ZOOM_DELTA_FACTOR = 0.00045;

export function zoomedZ(
  camZ: number,
  wheelDeltaY: number,
  zMin: number,
): number {
  const distance = FOCAL + Z_STORY - camZ;
  const next = camZ - wheelDeltaY * distance * ZOOM_DELTA_FACTOR;
  return Math.max(zMin, Math.min(Z_CAMERA_MAX, next));
}

/**
 * Cursor-anchored zoom (§3.1): the world point under the pointer stays under
 * the pointer. Operates on the camera *target* so successive wheel events
 * compose exactly.
 */
export function cursorAnchoredZoom(
  camera: PlanningCamera,
  viewport: Viewport,
  cursorX: number,
  cursorY: number,
  wheelDeltaY: number,
  zMin: number,
): PlanningCamera {
  const anchor = unprojectAtStoryPlane(camera, viewport, cursorX, cursorY);
  const z = zoomedZ(camera.z, wheelDeltaY, zMin);
  const scale = scaleForPlane(z, Z_STORY);
  return {
    x: anchor.x - (cursorX - viewport.width / 2) / scale,
    y: anchor.y - (cursorY - viewport.height / 2) / scale,
    z,
  };
}

/**
 * Multitouch pinch (§3.1): scales the camera distance by the pinch ratio and
 * keeps the world point under the pinch midpoint fixed — the two-finger
 * analogue of cursor-anchored wheel zoom.
 */
export function pinchZoom(
  camera: PlanningCamera,
  viewport: Viewport,
  centerX: number,
  centerY: number,
  ratio: number,
  zMin: number,
): PlanningCamera {
  const anchor = unprojectAtStoryPlane(camera, viewport, centerX, centerY);
  const clamped = Math.max(0.2, Math.min(5, ratio));
  const distance = FOCAL + Z_STORY - camera.z;
  const z = Math.max(
    zMin,
    Math.min(Z_CAMERA_MAX, FOCAL + Z_STORY - distance / clamped),
  );
  const scale = scaleForPlane(z, Z_STORY);
  return {
    x: anchor.x - (centerX - viewport.width / 2) / scale,
    y: anchor.y - (centerY - viewport.height / 2) / scale,
    z,
  };
}


export {
  BAND_THRESHOLDS,
  type PlanningBand,
  bandForScale,
  cameraZForStoryScale,
  counterScale,
  epicCounterScale,
  HOUR_STEPS_SECONDS,
  planningBandChromeBucket,
  planningBandChromeChanged,
  planningGaugeActiveLabel,
  steppedHours,
} from "./t3work-planningSpaceBands";
export {
  FRAME_GAP,
  FRAME_HEADER_HEIGHT,
  FRAME_PADDING,
  FRAME_WIDTH_BUDGET,
  SUBTASK_CELL_HEIGHT,
  type PackedFrame,
  type SceneBounds,
  boundsOfFrames,
  fitCameraToBounds,
  frameHeight,
  orderEpicsByAffinity,
  packMasonry,
} from "./t3work-planningSpaceMasonry";
