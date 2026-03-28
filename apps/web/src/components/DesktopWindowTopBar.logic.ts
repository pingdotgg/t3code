import type { DesktopWindowState } from "@t3tools/contracts";

export const DESKTOP_WINDOW_TOP_BAR_HEIGHT_PX = 44;
export const DESKTOP_WINDOW_TOP_BAR_REVEAL_ZONE_PX = 4;
export const DESKTOP_WINDOW_TOP_BAR_MARGIN_X_PX = 8;
export const DESKTOP_WINDOW_TOP_BAR_MARGIN_TOP_PX = 8;

export function resolveDesktopWindowTopBarZoomFactor(
  windowState: DesktopWindowState | null,
): number {
  const zoomFactor = windowState?.zoomFactor ?? 1;
  return Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
}

export function shouldUseDesktopWindowTopBar(windowState: DesktopWindowState | null): boolean {
  return (
    windowState !== null &&
    windowState.platform !== "other" &&
    windowState.titleBarMode === "t3code"
  );
}

export function shouldOverlayDesktopWindowTopBar(windowState: DesktopWindowState | null): boolean {
  return shouldUseDesktopWindowTopBar(windowState) && windowState?.isFullScreen === true;
}

export function nextDesktopWindowTopBarVisibility(input: {
  windowState: DesktopWindowState | null;
  pointerY: number | null;
  isHovered: boolean;
  wasVisible: boolean;
}): boolean {
  if (!shouldUseDesktopWindowTopBar(input.windowState)) {
    return false;
  }

  if (input.windowState?.isFullScreen !== true) {
    return true;
  }

  if (input.isHovered) {
    return true;
  }

  if (input.pointerY === null) {
    return false;
  }

  const zoomFactor = resolveDesktopWindowTopBarZoomFactor(input.windowState);
  const revealThreshold = input.wasVisible
    ? DESKTOP_WINDOW_TOP_BAR_HEIGHT_PX / zoomFactor
    : DESKTOP_WINDOW_TOP_BAR_REVEAL_ZONE_PX / zoomFactor;

  return input.pointerY <= revealThreshold;
}
