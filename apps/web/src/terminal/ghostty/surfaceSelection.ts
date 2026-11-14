import { GhosttyTerminalSurface } from "./surface";
import { CONTENT_PADDING } from "./surfaceGeometry";

export function surfaceHasSelection(surface: GhosttyTerminalSurface) {
  return surface.core.selectionText().length > 0;
}

export function surfaceGetSelection(surface: GhosttyTerminalSurface) {
  return surface.core.selectionText();
}

/** An upper bound on the selection's size, read without formatting its text. */
export function surfaceGetSelectionCellCount(surface: GhosttyTerminalSurface) {
  const range = surface.core.selectionRange();
  return range ? (Math.abs(range.end.y - range.start.y) + 1) * surface.cols : 0;
}

export function surfaceSelectAll(surface: GhosttyTerminalSurface) {
  surface.clearPrimedCopy();
  const range = surface.core.selectAll();
  surface.selectionAnchorScreen = range?.start ?? null;
  surface.selectionEnd = range
    ? surface.core.screenPointToViewport(range.end.x, range.end.y)
    : null;
  surface.selectionMode = "cell";
  surface.selectionBase = null;
  surface.setSelectionAutoscroll(0);
  surface.options.onSelectionChange();
  surface.forceFullRender = true;
  surface.requestRender();
}

export function surfaceGetSelectionPosition(surface: GhosttyTerminalSurface) {
  // Ask Ghostty rather than the gesture's coordinates, which go stale once
  // output scrolls the selected rows (alternate screen, scrollback pruning).
  const range = surface.hasSelection() ? surface.core.selectionRange() : null;
  if (!range) return null;
  const { start, end } = range;
  const before = start.y < end.y || (start.y === end.y && start.x <= end.x);
  return before ? { start, end } : { start: end, end: start };
}

export function surfaceGetSelectionEndClientRect(surface: GhosttyTerminalSurface) {
  const position = surface.getSelectionPosition();
  if (!position) return null;
  const viewportEnd = surface.core.screenPointToViewport(position.end.x, position.end.y);
  if (
    !viewportEnd ||
    viewportEnd.x < 0 ||
    viewportEnd.x >= surface.cols ||
    viewportEnd.y < 0 ||
    viewportEnd.y >= surface.rows
  ) {
    return null;
  }
  const bounds = surface.canvas.getBoundingClientRect();
  return {
    right: bounds.left + CONTENT_PADDING + (viewportEnd.x + 1) * surface.metrics.width,
    bottom: bounds.top + surface.originY + (viewportEnd.y + 1) * surface.metrics.height,
  };
}

export function surfaceClearSelection(surface: GhosttyTerminalSurface) {
  surface.clearPrimedCopy();
  surface.core.clearSelection();
  surface.selectionEnd = null;
  surface.selectionAnchorScreen = null;
  surface.selectionMode = "cell";
  surface.selectionBase = null;
  surface.setSelectionAutoscroll(0);
  surface.options.onSelectionChange();
  // Selection highlights span rows Ghostty may not mark dirty for this change.
  surface.forceFullRender = true;
  surface.requestRender();
}
