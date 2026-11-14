import { GhosttyTerminalSurface } from "./surface";
import {
  CONTENT_PADDING,
  TERMINAL_LINK_DRAG_THRESHOLD_PX,
  TerminalLinkWithRange,
  advanceTerminalSelectionClickSequence,
  isSameTerminalLink,
} from "./surfaceGeometry";
import {
  ghosttyMouseButton,
  isMiddleClickPastePlatform,
  shouldReportTerminalMouse,
  terminalSelectionAutoscrollRows,
  terminalWheelDeltaRows,
} from "./surfaceInput";

export function surfaceOnPointerDown(surface: GhosttyTerminalSurface, event: PointerEvent) {
  if (event.pointerType === "touch") {
    event.preventDefault();
    if (!event.isPrimary || surface.touchScroll !== null) return;
    surface.touchScroll = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      remainder: 0,
      moved: false,
    };
    surface.clearHoveredLink();
    surface.canvas.setPointerCapture(event.pointerId);
    return;
  }
  surface.focus();
  if (shouldReportTerminalMouse(surface.core.isMouseTracking(), event)) {
    const button = ghosttyMouseButton(event.button);
    if (button === null) return;
    event.preventDefault();
    event.stopPropagation();
    surface.clearHoveredLink("default");
    surface.mouseReportingPointerId = event.pointerId;
    surface.mouseReportingButton = button;
    surface.sendMouse("press", button, event);
    surface.canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button === 1 && isMiddleClickPastePlatform()) {
    // Keep pointerdown uncancelled so compatibility mousedown activates the split pane.
    surface.pasteTerminalSelection();
    return;
  }
  if (event.button !== 0) return;
  const clickCount = surface.recordSelectionClick(event);
  const link = surface.linkAt(event.clientX, event.clientY);
  if (link && !event.shiftKey && clickCount === 1) {
    event.preventDefault();
    event.stopPropagation();
    surface.linkActivationPointerId = event.pointerId;
    surface.linkActivationLink = link;
    surface.linkActivationOrigin = {
      x: event.clientX,
      y: event.clientY,
      clickCount,
    };
    surface.canvas.setPointerCapture(event.pointerId);
    return;
  }
  surface.clearHoveredLink();
  surface.beginSelection(event, clickCount);
  surface.canvas.setPointerCapture(event.pointerId);
}

export function surfaceRecordSelectionClick(
  surface: GhosttyTerminalSurface,
  event: Pick<PointerEvent, "clientX" | "clientY" | "timeStamp">,
) {
  surface.selectionClickSequence = advanceTerminalSelectionClickSequence(
    surface.selectionClickSequence,
    event,
  );
  return surface.selectionClickSequence.count;
}

export function surfaceBeginSelection(
  surface: GhosttyTerminalSurface,
  event: { clientX: number; clientY: number },
  clickCount: number,
) {
  const cell = surface.cellAt(event.clientX, event.clientY);
  surface.selectionMoved = false;
  surface.selectionMode = clickCount >= 3 ? "line" : clickCount === 2 ? "word" : "cell";
  const range =
    surface.selectionMode === "line"
      ? surface.core.selectLine(cell.x, cell.y)
      : surface.selectionMode === "word"
        ? surface.core.selectWord(cell.x, cell.y)
        : null;
  if (range) {
    surface.selectionBase = range.screen;
    surface.selectionEnd = range.viewport.end;
    surface.selectionAnchorScreen = range.screen.start;
    surface.options.onSelectionChange();
  } else {
    surface.selectionMode = "cell";
    surface.selectionBase = null;
    surface.selectionEnd = cell;
    const screen = surface.core.viewportPointToScreen(cell.x, cell.y);
    surface.selectionAnchorScreen = screen;
    if (screen) {
      surface.core.setSelection({ ...screen, tag: 2 }, { ...screen, tag: 2 });
    } else {
      surface.core.setSelection(cell, cell);
    }
  }
  surface.forceFullRender = true;
  surface.requestRender();
}

export function surfaceOnPointerMove(surface: GhosttyTerminalSurface, event: PointerEvent) {
  if (event.pointerType === "touch") {
    const touch = surface.touchScroll;
    if (touch?.pointerId !== event.pointerId) return;
    event.preventDefault();
    touch.moved ||=
      Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) >
      TERMINAL_LINK_DRAG_THRESHOLD_PX;
    if (!touch.moved) return;
    const delta = terminalWheelDeltaRows(
      { deltaY: touch.lastY - event.clientY, deltaMode: 0 },
      surface.metrics.height,
      surface.rows,
      touch.remainder,
    );
    touch.lastY = event.clientY;
    touch.remainder = delta.remainder;
    surface.scrollRows(delta.rows, event);
    return;
  }
  if (surface.linkActivationPointerId === event.pointerId) {
    const origin = surface.linkActivationOrigin;
    if (
      origin === null ||
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <=
        TERMINAL_LINK_DRAG_THRESHOLD_PX
    ) {
      return;
    }
    surface.linkActivationPointerId = null;
    surface.linkActivationLink = null;
    surface.linkActivationOrigin = null;
    surface.clearHoveredLink();
    surface.beginSelection(
      {
        clientX: origin.x,
        clientY: origin.y,
      },
      origin.clickCount,
    );
  }
  // Only DEC 1003 reports hover motion without a captured pressed button.
  const anyEventTracking = surface.synchronizeMouseTrackingState();
  if (
    surface.mouseReportingPointerId === event.pointerId ||
    shouldReportTerminalMouse(anyEventTracking, event)
  ) {
    event.preventDefault();
    surface.hoverPointer = { x: event.clientX, y: event.clientY };
    surface.setHoveredLink(null);
    surface.canvas.style.cursor = "default";
    surface.sendMouse("motion", surface.buttonFromButtons(event.buttons), event);
    return;
  }
  surface.lastMouseMotionData = "";
  if (!surface.selectionAnchorScreen || !surface.canvas.hasPointerCapture(event.pointerId)) {
    surface.updateHoverCursor(event);
    return;
  }
  surface.clearHoveredLink();
  surface.selectionPointer = { x: event.clientX, y: event.clientY };
  const bounds = surface.canvas.getBoundingClientRect();
  const top = Math.max(bounds.top, 0) + CONTENT_PADDING;
  const bottom = Math.min(bounds.bottom, window.innerHeight) - CONTENT_PADDING;
  surface.setSelectionAutoscroll(terminalSelectionAutoscrollRows(event.clientY, top, bottom));
  const cell = surface.cellAt(event.clientX, event.clientY);
  if (cell.x === surface.selectionEnd?.x && cell.y === surface.selectionEnd.y) return;
  surface.extendSelectionTo(event.clientX, event.clientY);
}

export function surfaceExtendSelectionTo(
  surface: GhosttyTerminalSurface,
  clientX: number,
  clientY: number,
) {
  if (surface.selectionAnchorScreen === null) return;
  // Ghostty moves its selection with output; keep the drag on those rows too.
  const anchorScreen = surface.core.selectionRange()?.start;
  if (!anchorScreen) return;
  const rowDelta = anchorScreen.y - surface.selectionAnchorScreen.y;
  if (surface.selectionBase && rowDelta !== 0) {
    const { start, end } = surface.selectionBase;
    surface.selectionBase = {
      start: { x: start.x, y: start.y + rowDelta },
      end: { x: end.x, y: end.y + rowDelta },
    };
  }
  const cell = surface.cellAt(clientX, clientY);
  surface.selectionMoved = true;
  surface.selectionEnd = cell;
  const range =
    surface.selectionMode === "line"
      ? surface.core.selectLine(cell.x, cell.y)
      : surface.selectionMode === "word"
        ? surface.core.selectWord(cell.x, cell.y)
        : null;
  const cellScreen = surface.core.viewportPointToScreen(cell.x, cell.y);
  if (cellScreen === null) return;
  const base = surface.selectionBase;
  const beforeBase =
    base !== null &&
    (cellScreen.y < base.start.y || (cellScreen.y === base.start.y && cellScreen.x < base.start.x));
  const anchor = base === null ? anchorScreen : beforeBase ? base.end : base.start;
  const end = range === null ? cellScreen : beforeBase ? range.screen.start : range.screen.end;
  surface.selectionAnchorScreen = anchor;
  surface.core.setSelection({ ...anchor, tag: 2 }, { ...end, tag: 2 });
  surface.options.onSelectionChange();
  surface.forceFullRender = true;
  surface.requestRender();
}

export function surfaceSetSelectionAutoscroll(surface: GhosttyTerminalSurface, delta: number) {
  surface.selectionScrollDelta = delta;
  if (delta === 0) {
    if (surface.selectionScrollTimer !== null) {
      window.clearInterval(surface.selectionScrollTimer);
      surface.selectionScrollTimer = null;
    }
    return;
  }
  if (surface.selectionScrollTimer !== null) return;
  surface.selectionScrollTimer = window.setInterval(() => {
    if (surface.disposed || surface.selectionScrollDelta === 0) return;
    surface.scrollViewport(surface.selectionScrollDelta);
    const pointer = surface.selectionPointer;
    if (pointer) surface.extendSelectionTo(pointer.x, pointer.y);
  }, 80);
}

export function surfaceUpdateHoverCursor(surface: GhosttyTerminalSurface, event: PointerEvent) {
  surface.hoverPointer = { x: event.clientX, y: event.clientY };
  surface.refreshHoveredLink();
}

export function surfaceOnPointerLeave(surface: GhosttyTerminalSurface) {
  surface.lastMouseMotionData = "";
  surface.clearHoveredLink();
}

export function surfaceClearHoveredLink(surface: GhosttyTerminalSurface, cursor = "") {
  surface.hoverPointer = null;
  surface.setHoveredLink(null);
  surface.canvas.style.cursor = cursor;
}

export function surfaceRefreshHoveredLink(surface: GhosttyTerminalSurface) {
  const pointer = surface.hoverPointer;
  const link = pointer ? surface.linkAt(pointer.x, pointer.y) : null;
  surface.setHoveredLink(link);
}

export function surfaceSetHoveredLink(
  surface: GhosttyTerminalSurface,
  link: TerminalLinkWithRange | null,
) {
  const previous = surface.hoveredLink;
  const unchanged =
    previous?.text === link?.text &&
    previous?.range.start.x === link?.range.start.x &&
    previous?.range.start.y === link?.range.start.y &&
    previous?.range.end.x === link?.range.end.x &&
    previous?.range.end.y === link?.range.end.y;
  surface.canvas.style.cursor = link ? "pointer" : "";
  if (unchanged) return;
  surface.hoveredLink = link;
  surface.forceFullRender = true;
  surface.requestRender();
}

export function surfaceOnPointerUp(surface: GhosttyTerminalSurface, event: PointerEvent) {
  if (event.pointerType === "touch") {
    const touch = surface.touchScroll;
    if (touch?.pointerId !== event.pointerId) return;
    surface.touchScroll = null;
    event.preventDefault();
    if (surface.canvas.hasPointerCapture(event.pointerId)) {
      surface.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.type === "pointercancel" || touch.moved) return;
    surface.focus();
    if (shouldReportTerminalMouse(surface.core.isMouseTracking(), event)) {
      surface.sendMouse("press", ghosttyMouseButton(0), event);
      surface.sendMouse("release", ghosttyMouseButton(0), event);
    } else {
      const link = surface.linkAt(event.clientX, event.clientY);
      if (link) surface.options.onLinkActivate(link.text, event);
      else surface.clearSelection();
    }
    return;
  }
  surface.setSelectionAutoscroll(0);
  if (surface.linkActivationPointerId === event.pointerId) {
    event.preventDefault();
    event.stopPropagation();
    const link = surface.linkActivationLink;
    surface.linkActivationPointerId = null;
    surface.linkActivationLink = null;
    surface.linkActivationOrigin = null;
    if (surface.canvas.hasPointerCapture(event.pointerId)) {
      surface.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.type !== "pointercancel") {
      if (link && isSameTerminalLink(link, surface.linkAt(event.clientX, event.clientY))) {
        surface.options.onLinkActivate(link.text, event);
      }
    }
    return;
  }
  if (surface.mouseReportingPointerId === event.pointerId) {
    event.preventDefault();
    event.stopPropagation();
    surface.sendMouse("release", surface.mouseReportingButton, event);
    surface.mouseReportingPointerId = null;
    surface.mouseReportingButton = null;
    if (surface.canvas.hasPointerCapture(event.pointerId)) {
      surface.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.type === "pointercancel") {
      surface.clearHoveredLink();
    } else {
      surface.hoverPointer = { x: event.clientX, y: event.clientY };
      surface.refreshHoveredLink();
    }
    return;
  }
  if (surface.canvas.hasPointerCapture(event.pointerId)) {
    surface.canvas.releasePointerCapture(event.pointerId);
  }
  if (event.button === 1 && isMiddleClickPastePlatform()) {
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  if (!surface.selectionMoved && surface.selectionMode === "cell") {
    surface.clearSelection();
  }
  surface.options.onSelectionChange();
}
