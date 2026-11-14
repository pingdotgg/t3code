import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

import {
  clampPreviewMiniPlayerPosition,
  type PreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
} from "./previewMiniPlayerLayout";

const HANDLE_TAP_SLOP_PX = 6;

export interface PreviewMiniPlayerGesture {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  /** Null drags the player; a direction resizes it from that handle. */
  readonly direction: BrowserViewportResizeDirection | null;
  /** The source size a resize keeps the frame's shape to until it ends. */
  readonly source: PreviewMiniPlayerSize;
  readonly moved: boolean;
}

interface GesturePointer {
  readonly pointerId: number;
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
}

export type PreviewMiniPlayerGestureStep =
  | { readonly kind: "ignore" }
  | { readonly kind: "end" }
  | { readonly kind: "move"; readonly position: PreviewMiniPlayerPosition }
  | { readonly kind: "resize"; readonly frame: PreviewMiniPlayerFrame };

/** What a pointer move does to the gesture in progress. */
export function stepPreviewMiniPlayerGesture(
  gesture: PreviewMiniPlayerGesture,
  pointer: GesturePointer,
  container: PreviewMiniPlayerSize,
): PreviewMiniPlayerGestureStep {
  if (pointer.pointerId !== gesture.pointerId) return { kind: "ignore" };
  // A release the handle never saw (over a native view, another window) leaves only this trace.
  if ((pointer.buttons & 1) === 0) return { kind: "end" };
  const delta = { x: pointer.clientX - gesture.pointerX, y: pointer.clientY - gesture.pointerY };
  if (!gesture.moved && Math.hypot(delta.x, delta.y) < HANDLE_TAP_SLOP_PX) {
    return { kind: "ignore" };
  }
  if (gesture.direction === null) {
    return {
      kind: "move",
      position: clampPreviewMiniPlayerPosition(
        { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
        container,
        gesture.frame,
      ),
    };
  }
  return {
    kind: "resize",
    frame: resizePreviewMiniPlayer({
      start: gesture.frame,
      direction: gesture.direction,
      delta,
      source: gesture.source,
      container,
    }),
  };
}

/**
 * The frame a finished resize leaves when the source changed shape under it: the new shape, with
 * the edges opposite the handle where the gesture left them. Null when the shape is unchanged.
 */
export function settlePreviewMiniPlayerResize(input: {
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection;
  readonly held: PreviewMiniPlayerSize;
  readonly source: PreviewMiniPlayerSize;
  readonly container: PreviewMiniPlayerSize;
}): PreviewMiniPlayerFrame | null {
  const { frame, direction, held, source, container } = input;
  if (held.width * source.height === source.width * held.height) return null;
  return resizePreviewMiniPlayer({
    start: frame,
    direction,
    delta: { x: 0, y: 0 },
    source,
    container,
  });
}
