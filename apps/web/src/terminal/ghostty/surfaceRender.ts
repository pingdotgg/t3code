import { GhosttyTerminalSurface } from "./surface";
import { renderGhosttySnapshot } from "./renderer";
import { shouldBlinkTerminalCursor } from "./surfaceFonts";
import { CONTENT_PADDING, terminalContentOriginY } from "./surfaceGeometry";

const CURSOR_BLINK_INTERVAL_MS = 500;
/** End an unterminated synchronized update instead of freezing the last frame. */
const SYNCHRONIZED_OUTPUT_RENDER_TIMEOUT_MS = 500;

export function surfaceRequestRender(surface: GhosttyTerminalSurface) {
  if (surface.disposed || !surface.visible || !surface.hasSize) return;
  if (surface.deferSynchronizedRender() || surface.frame !== 0) return;
  surface.frame = window.requestAnimationFrame(() => {
    surface.frame = 0;
    surface.renderFrame();
  });
}

export function surfaceCancelRender(surface: GhosttyTerminalSurface) {
  surface.cancelSynchronizedRenderTimer();
  if (surface.frame !== 0) {
    window.cancelAnimationFrame(surface.frame);
    surface.frame = 0;
  }
  if (surface.cursorTimer !== null) {
    window.clearTimeout(surface.cursorTimer);
    surface.cursorTimer = null;
  }
}

export function surfaceCancelSynchronizedRenderTimer(surface: GhosttyTerminalSurface) {
  if (surface.synchronizedRenderTimer === null) return;
  window.clearTimeout(surface.synchronizedRenderTimer);
  surface.synchronizedRenderTimer = null;
}

export function surfaceDeferSynchronizedRender(surface: GhosttyTerminalSurface) {
  if (!surface.core.isSynchronizedOutput()) {
    surface.cancelSynchronizedRenderTimer();
    return false;
  }
  // A frame queued before the opening marker would now consume partial rows.
  if (surface.frame !== 0) {
    window.cancelAnimationFrame(surface.frame);
    surface.frame = 0;
  }
  if (surface.cursorTimer !== null) {
    window.clearTimeout(surface.cursorTimer);
    surface.cursorTimer = null;
  }
  if (surface.synchronizedRenderTimer === null) {
    surface.synchronizedRenderTimer = window.setTimeout(() => {
      surface.synchronizedRenderTimer = null;
      surface.core.endSynchronizedOutput();
      surface.renderFrame();
    }, SYNCHRONIZED_OUTPUT_RENDER_TIMEOUT_MS);
  }
  return true;
}

export function surfaceRenderFrame(surface: GhosttyTerminalSurface) {
  if (surface.disposed || !surface.visible) return;
  if (surface.frame !== 0) {
    window.cancelAnimationFrame(surface.frame);
    surface.frame = 0;
  }
  if (surface.mount.clientWidth === 0 || surface.mount.clientHeight === 0) {
    surface.hasSize = false;
    surface.forceFullRender = true;
    surface.cancelRender();
    return;
  }
  if (surface.deferSynchronizedRender()) return;
  const canvasConfiguration = surface.pendingCanvasConfiguration;
  if (canvasConfiguration !== null) {
    surface.pendingCanvasConfiguration = null;
    surface.canvas.width = canvasConfiguration.width;
    surface.canvas.height = canvasConfiguration.height;
    surface.context.setTransform(canvasConfiguration.ratio, 0, 0, canvasConfiguration.ratio, 0, 0);
    surface.canvasConfigured = true;
    surface.canvasDevicePixelRatio = canvasConfiguration.ratio;
  }
  surface.snapshot = surface.core.snapshot();
  if (!surface.blinkEnabled()) surface.cursorOn = true;
  // Move the origin only on full repaint; dirty-row updates cannot mix origins.
  const scrollState = surface.readScrollbarState();
  const anchorBottom = scrollState !== null && scrollState.total > scrollState.len;
  const nextOriginY = terminalContentOriginY(
    surface.mountHeight,
    CONTENT_PADDING,
    surface.rows,
    surface.metrics.height,
    anchorBottom,
  );
  if (nextOriginY !== surface.originY) {
    surface.originY = nextOriginY;
    surface.forceFullRender = true;
  }
  surface.refreshHoveredLink();
  renderGhosttySnapshot({
    context: surface.context,
    snapshot: surface.snapshot,
    metrics: surface.metrics,
    fontSize: surface.fontSize,
    fontFamily: surface.fontFamily,
    padding: CONTENT_PADDING,
    originY: surface.originY,
    forceFull: surface.forceFullRender,
    cursorOn: surface.cursorOn,
    previousCursorY: surface.renderedCursorY,
    focused: surface.focused,
    hoveredLinkRange: surface.hoveredLink?.range ?? null,
    ...(surface.theme.selectionBackground !== undefined
      ? { selectionBackground: surface.theme.selectionBackground }
      : {}),
  });
  surface.positionInput();
  surface.renderedCursorY =
    surface.cursorOn && surface.snapshot.cursorVisible && surface.snapshot.cursorY >= 0
      ? surface.snapshot.cursorY
      : null;
  if (surface.scrollbarDirty) {
    surface.scrollbarDirty = false;
    surface.updateScrollbar();
  }
  surface.forceFullRender = false;
  surface.scheduleCursorBlink();
}

export function surfaceScheduleCursorBlink(surface: GhosttyTerminalSurface) {
  if (surface.cursorTimer !== null) window.clearTimeout(surface.cursorTimer);
  surface.cursorTimer = null;
  if (!surface.blinkEnabled()) return;
  surface.cursorTimer = window.setTimeout(() => {
    surface.cursorTimer = null;
    surface.cursorOn = !surface.cursorOn;
    surface.requestRender();
  }, CURSOR_BLINK_INTERVAL_MS);
}

export function surfaceBlinkEnabled(surface: GhosttyTerminalSurface) {
  const snapshot = surface.snapshot;
  if (!snapshot || !surface.visible || !surface.hasSize) return false;
  return shouldBlinkTerminalCursor({
    focused: surface.focused,
    cursorBlinking: snapshot.cursorBlinking,
    cursorVisible: snapshot.cursorVisible,
    reducedMotion: surface.reducedMotionMedia?.matches ?? false,
  });
}

export function surfacePositionInput(surface: GhosttyTerminalSurface) {
  const snapshot = surface.snapshot;
  if (!snapshot || !snapshot.cursorVisible || snapshot.cursorX < 0 || snapshot.cursorY < 0) {
    return;
  }
  const left = CONTENT_PADDING + snapshot.cursorX * surface.metrics.width;
  const top = surface.originY + snapshot.cursorY * surface.metrics.height;
  if (left === surface.inputLeft && top === surface.inputTop) return;
  surface.inputLeft = left;
  surface.inputTop = top;
  surface.input.style.left = `${left}px`;
  surface.input.style.top = `${top}px`;
  surface.input.style.height = `${surface.metrics.height}px`;
}
