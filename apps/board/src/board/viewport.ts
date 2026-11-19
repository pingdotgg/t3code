export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;
export const FIT_FLOOR = 0.7;
const FIT_PADDING = 40;

export interface View {
  x: number;
  y: number;
  k: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}

export const INITIAL_VIEW: View = { x: 0, y: 0, k: 1 };

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export const panBy = (view: View, dx: number, dy: number): View => ({
  ...view,
  x: view.x + dx,
  y: view.y + dy,
});

/** Zoom to `k`, keeping the world point under screen point (px, py) fixed. */
export function zoomAt(view: View, k: number, px: number, py: number): View {
  const next = clampZoom(k);
  const ratio = next / view.k;
  return { x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio, k: next };
}

/**
 * Never fits below FIT_FLOOR so content stays readable; content wider than the
 * screen at that zoom is aligned to its top left corner and panned instead.
 */
export function fitToContent(content: Rect | null, size: Size): View {
  if (!content) return INITIAL_VIEW;
  const availW = size.width - FIT_PADDING * 2;
  const availH = size.height - FIT_PADDING * 2;
  const k = Math.max(FIT_FLOOR, Math.min(1, availW / content.width, availH / content.height));
  const fitsW = content.width * k <= availW;
  const fitsH = content.height * k <= availH;
  return {
    k,
    x: (fitsW ? (size.width - content.width * k) / 2 : FIT_PADDING) - content.x * k,
    y: (fitsH ? (size.height - content.height * k) / 2 : FIT_PADDING) - content.y * k,
  };
}
