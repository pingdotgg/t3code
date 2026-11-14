import { GhosttyTerminalSurface } from "./surface";
import {
  CONTENT_PADDING,
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAtPointer,
} from "./surfaceGeometry";

export function surfaceOnScrollbarPointerDown(
  surface: GhosttyTerminalSurface,
  event: PointerEvent,
) {
  if (event.button !== 0) return;
  const state = surface.readScrollbarState();
  if (state === null) return;
  const bounds = surface.scrollbar.getBoundingClientRect();
  const geometry = terminalScrollbarGeometry(state, bounds.height);
  if (geometry === null) return;
  event.preventDefault();
  event.stopPropagation();
  surface.scrollbarPointerId = event.pointerId;
  surface.scrollbarPointerOffset =
    event.target === surface.scrollbarThumb
      ? event.clientY - bounds.top - geometry.thumbTop
      : geometry.thumbHeight / 2;
  surface.scrollbar.setPointerCapture(event.pointerId);
  surface.scrollbarToPointer(event.clientY, bounds);
}

export function surfaceOnScrollbarPointerMove(
  surface: GhosttyTerminalSurface,
  event: PointerEvent,
) {
  if (event.pointerId !== surface.scrollbarPointerId || surface.scrollbarState === null) return;
  event.preventDefault();
  surface.scrollbarToPointer(event.clientY, surface.scrollbar.getBoundingClientRect());
}

export function surfaceOnScrollbarPointerUp(surface: GhosttyTerminalSurface, event: PointerEvent) {
  if (event.pointerId !== surface.scrollbarPointerId) return;
  event.preventDefault();
  surface.scrollbarPointerId = null;
  if (surface.scrollbar.hasPointerCapture(event.pointerId)) {
    surface.scrollbar.releasePointerCapture(event.pointerId);
  }
}

export function surfaceOnScrollbarKeyDown(surface: GhosttyTerminalSurface, event: KeyboardEvent) {
  const state = surface.readScrollbarState();
  if (state === null) return;
  let delta = 0;
  switch (event.key) {
    case "ArrowUp":
      delta = -1;
      break;
    case "ArrowDown":
      delta = 1;
      break;
    case "PageUp":
      delta = -Math.max(1, state.len);
      break;
    case "PageDown":
      delta = Math.max(1, state.len);
      break;
    case "Home":
      delta = -state.offset;
      break;
    case "End":
      delta = state.total - state.len - state.offset;
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  surface.scrollViewport(delta);
}

export function surfaceScrollViewport(surface: GhosttyTerminalSurface, deltaRows: number) {
  let delta = Math.trunc(deltaRows);
  const state = surface.readScrollbarState();
  if (state !== null) {
    const maxOffset = Math.max(0, state.total - state.len);
    const offset = Math.max(0, Math.min(state.offset + delta, maxOffset));
    delta = offset - state.offset;
    surface.scrollbarState = { ...state, offset };
  }
  if (delta === 0) return;
  surface.core.scroll(delta);
  surface.forceFullRender = true;
  surface.scrollbarDirty = true;
  surface.requestRender();
}

export function surfaceScrollbarToPointer(
  surface: GhosttyTerminalSurface,
  clientY: number,
  bounds: DOMRect,
) {
  const state = surface.scrollbarState;
  if (state === null) return;
  const offset = terminalScrollbarOffsetAtPointer(
    state,
    bounds.height,
    clientY - bounds.top,
    surface.scrollbarPointerOffset,
  );
  surface.scrollViewport(offset - state.offset);
}

export function surfaceUpdateScrollbar(surface: GhosttyTerminalSurface) {
  const state = surface.readScrollbarState();
  const geometry =
    state === null
      ? null
      : terminalScrollbarGeometry(
          state,
          Math.max(0, surface.mount.clientHeight - CONTENT_PADDING * 2),
        );
  surface.scrollbar.hidden = geometry === null;
  if (state === null || geometry === null) return;
  surface.scrollbar.setAttribute("aria-valuemin", "0");
  surface.scrollbar.setAttribute("aria-valuemax", String(geometry.maxOffset));
  surface.scrollbar.setAttribute(
    "aria-valuenow",
    String(Math.max(0, Math.min(state.offset, geometry.maxOffset))),
  );
  surface.scrollbarThumb.style.height = `${geometry.thumbHeight}px`;
  surface.scrollbarThumb.style.transform = `translateY(${geometry.thumbTop}px)`;
}

export function surfaceReadScrollbarState(surface: GhosttyTerminalSurface) {
  const state = surface.core.scrollbarState();
  surface.scrollbarState = state;
  return state;
}
