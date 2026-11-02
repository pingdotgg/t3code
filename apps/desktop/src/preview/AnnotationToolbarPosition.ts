export type ToolbarPosition = { left: number; top: number };

export function clampToolbarPosition(
  position: ToolbarPosition,
  viewport: { width: number; height: number },
  toolbar: { width: number; height: number },
): ToolbarPosition {
  return {
    left: Math.max(0, Math.min(position.left, viewport.width - toolbar.width)),
    top: Math.max(0, Math.min(position.top, viewport.height - toolbar.height)),
  };
}
