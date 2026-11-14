import { GhosttyTerminalSurface } from "./surface";
import { terminalLinkAtPositionWithRange } from "./surfaceParts";
import { CONTENT_PADDING, terminalGridCellAt } from "./surfaceGeometry";
import {
  TerminalMouseAction,
  isMiddleClickPastePlatform,
  resolveTerminalMouseData,
  resolveTerminalMouseTrackingState,
  shouldReportTerminalMouse,
  terminalWheelArrowData,
  terminalWheelDeltaRows,
} from "./surfaceInput";

export function surfaceOnWheel(surface: GhosttyTerminalSurface, event: WheelEvent) {
  if (event.deltaY === 0) return;
  event.preventDefault();
  const delta = terminalWheelDeltaRows(
    event,
    surface.metrics.height,
    surface.rows,
    surface.wheelRemainder,
  );
  surface.wheelRemainder = delta.remainder;
  surface.scrollRows(delta.rows, event);
}

export function surfaceScrollRows(
  surface: GhosttyTerminalSurface,
  rows: number,
  event: MouseEvent,
) {
  if (rows === 0) return;
  const magnitude = Math.abs(rows);
  if (shouldReportTerminalMouse(surface.core.isMouseTracking(), event)) {
    const button = rows < 0 ? 4 : 5;
    for (let index = 0; index < magnitude; index += 1) {
      surface.sendMouse("press", button, event);
    }
    return;
  }
  if (surface.core.isAlternateScreen()) {
    // Alternate screens have no scrollback; send arrow keys like xterm.
    surface.options.onData(terminalWheelArrowData(rows, surface.core.isApplicationCursorKeys()));
    return;
  }
  surface.scrollViewport(rows);
}

export function surfaceOnMouseDown(surface: GhosttyTerminalSurface, event: MouseEvent) {
  if (event.button === 0 || (event.button === 1 && isMiddleClickPastePlatform())) {
    event.preventDefault();
  }
  surface.focus();
}

export function surfaceOnMouseUp(surface: GhosttyTerminalSurface, event: MouseEvent) {
  if (event.button === 1 && isMiddleClickPastePlatform()) event.preventDefault();
}

export function surfaceOnContextMenu(surface: GhosttyTerminalSurface, event: MouseEvent) {
  if (shouldReportTerminalMouse(surface.core.isMouseTracking(), event)) {
    event.preventDefault();
    return;
  }
  surface.options.onContextMenu?.(event);
}

export function surfaceCellAt(surface: GhosttyTerminalSurface, clientX: number, clientY: number) {
  const bounds = surface.canvas.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        surface.cols - 1,
        Math.floor((clientX - bounds.left - CONTENT_PADDING) / surface.metrics.width),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        surface.rows - 1,
        Math.floor((clientY - bounds.top - surface.originY) / surface.metrics.height),
      ),
    ),
  };
}

export function surfaceLinkAt(surface: GhosttyTerminalSurface, clientX: number, clientY: number) {
  const link = surface.findLinkAt(clientX, clientY);
  return link && surface.options.canActivateLink?.(link.text) !== false ? link : null;
}

export function surfaceFindLinkAt(
  surface: GhosttyTerminalSurface,
  clientX: number,
  clientY: number,
) {
  if (!surface.snapshot) return null;
  const cell = terminalGridCellAt({
    bounds: surface.canvas.getBoundingClientRect(),
    clientX,
    clientY,
    cols: surface.cols,
    rows: surface.rows,
    metrics: surface.metrics,
    padding: CONTENT_PADDING,
    originY: surface.originY,
  });
  if (!cell) return null;
  const explicitHyperlink = surface.core.hyperlinkAt(cell.x, cell.y);
  if (explicitHyperlink) {
    const start = { ...cell };
    const end = { ...cell };
    while (true) {
      const previous =
        start.x > 0
          ? { x: start.x - 1, y: start.y }
          : start.y > 0 && surface.snapshot.rowData[start.y]?.isWrapContinuation
            ? { x: surface.cols - 1, y: start.y - 1 }
            : null;
      if (!previous || surface.core.hyperlinkAt(previous.x, previous.y) !== explicitHyperlink)
        break;
      start.x = previous.x;
      start.y = previous.y;
    }
    while (true) {
      const next =
        end.x + 1 < surface.cols
          ? { x: end.x + 1, y: end.y }
          : end.y + 1 < surface.rows && surface.snapshot.rowData[end.y]?.wrapsToNext
            ? { x: 0, y: end.y + 1 }
            : null;
      if (!next || surface.core.hyperlinkAt(next.x, next.y) !== explicitHyperlink) break;
      end.x = next.x;
      end.y = next.y;
    }
    return {
      text: explicitHyperlink,
      range: { start, end },
    };
  }
  return terminalLinkAtPositionWithRange(surface.snapshot.rowData, cell.y, cell.x);
}

export function surfaceSendMouse(
  surface: GhosttyTerminalSurface,
  action: TerminalMouseAction,
  button: number | null,
  event: MouseEvent,
) {
  const bounds = surface.canvas.getBoundingClientRect();
  const data = surface.core.encodeMouse({
    action,
    button,
    mods:
      (event.shiftKey ? 1 : 0) |
      (event.ctrlKey ? 1 << 1 : 0) |
      (event.altKey ? 1 << 2 : 0) |
      (event.metaKey ? 1 << 3 : 0),
    x: Math.max(0, event.clientX - bounds.left),
    y: Math.max(0, event.clientY - bounds.top),
    screenWidth: bounds.width,
    screenHeight: bounds.height,
    cellWidth: surface.metrics.width,
    cellHeight: surface.metrics.height,
    paddingLeft: CONTENT_PADDING,
    paddingRight: CONTENT_PADDING,
    paddingTop: surface.originY,
    paddingBottom: Math.max(
      0,
      bounds.height - surface.originY - surface.rows * surface.metrics.height,
    ),
    anyButtonPressed: event.buttons !== 0,
  });
  const resolution = resolveTerminalMouseData(action, data, surface.lastMouseMotionData);
  surface.lastMouseMotionData = resolution.nextMotionData;
  if (resolution.send) surface.options.onData(data);
}

export function surfaceSynchronizeMouseTrackingState(surface: GhosttyTerminalSurface) {
  // Output can toggle DEC 1003; track the prior mode so same-cell motion can start a new session.
  const tracking = surface.core.isMouseAnyEventTracking();
  const state = resolveTerminalMouseTrackingState(
    surface.mouseAnyEventTracking,
    tracking,
    surface.lastMouseMotionData,
  );
  surface.mouseAnyEventTracking = state.tracking;
  surface.lastMouseMotionData = state.motionData;
  return tracking;
}

export function surfaceButtonFromButtons(surface: GhosttyTerminalSurface, buttons: number) {
  if ((buttons & 1) !== 0) return 1;
  if ((buttons & 4) !== 0) return 3;
  if ((buttons & 2) !== 0) return 2;
  if ((buttons & 8) !== 0) return 4;
  if ((buttons & 16) !== 0) return 5;
  return null;
}
