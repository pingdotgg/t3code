export interface ContextMenuPosition {
  readonly x: number;
  readonly y: number;
}

export function scaleContextMenuPositionForElectron(
  position: ContextMenuPosition | undefined,
  zoomFactor: number,
): ContextMenuPosition | undefined {
  if (position === undefined) {
    return undefined;
  }

  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: position.x * normalizedZoomFactor,
    y: position.y * normalizedZoomFactor,
  };
}
