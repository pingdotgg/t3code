export interface DesktopZoomCssVariables {
  readonly titlebarHeight: string;
  readonly titlebarLeadingOffset: string;
}

export const DESKTOP_TITLEBAR_HEIGHT_PX = 52;
export const DESKTOP_TITLEBAR_LEADING_OFFSET_PX = 90;
export const DESKTOP_TITLEBAR_MIN_SCREEN_LEADING_OFFSET_PX = 82;
export const DESKTOP_TITLEBAR_ZOOM_OUT_SCREEN_OFFSET_STEP_PX = 24;

export function normalizeDesktopZoomFactor(zoomFactor: number): number {
  return Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
}

export function resolveDesktopZoomCssVariables(zoomFactor: number): DesktopZoomCssVariables {
  const normalizedZoomFactor = normalizeDesktopZoomFactor(zoomFactor);
  const screenLeadingOffset =
    normalizedZoomFactor >= 1
      ? DESKTOP_TITLEBAR_LEADING_OFFSET_PX
      : Math.max(
          DESKTOP_TITLEBAR_MIN_SCREEN_LEADING_OFFSET_PX,
          DESKTOP_TITLEBAR_LEADING_OFFSET_PX -
            (1 - normalizedZoomFactor) * DESKTOP_TITLEBAR_ZOOM_OUT_SCREEN_OFFSET_STEP_PX,
        );

  return {
    titlebarHeight: `${DESKTOP_TITLEBAR_HEIGHT_PX / normalizedZoomFactor}px`,
    titlebarLeadingOffset: `${screenLeadingOffset / normalizedZoomFactor}px`,
  };
}
