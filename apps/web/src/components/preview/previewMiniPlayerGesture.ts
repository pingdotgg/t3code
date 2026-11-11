import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import type { PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";
import {
  clampPreviewMiniPlayerPosition,
  type PreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
} from "./previewMiniPlayerLayout";

const HANDLE_TAP_SLOP_PX = 6;

type Direction = BrowserViewportResizeDirection | null;
interface PointerInput {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}
interface CaptureTarget {
  setPointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
  closest(selector: string): Element | null;
}
interface Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly target: CaptureTarget;
  readonly direction: Direction;
  origin: { x: number; y: number };
  frame: PreviewMiniPlayerFrame;
  source: PreviewMiniPlayerSize;
  last: { x: number; y: number };
  currentFrame: PreviewMiniPlayerFrame;
  moved: boolean;
}
type Commit = (frame: PreviewMiniPlayerFrame, direction: Direction) => void;
interface Space {
  readonly container: PreviewMiniPlayerSize;
  readonly source: PreviewMiniPlayerSize;
}

// Computed CSS geometry preserves fractional coordinates in the player's local space.
function readRenderedFrame(target: CaptureTarget): PreviewMiniPlayerFrame | null {
  const preview = target.closest("[data-preview-mini-player]");
  if (!preview) return null;
  const style = getComputedStyle(preview);
  const frame = {
    x: Number.parseFloat(style.left),
    y: Number.parseFloat(style.top),
    width: Number.parseFloat(style.width),
    height: Number.parseFloat(style.height),
  };
  if (!Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) {
    return null;
  }
  return frame;
}

export function createPreviewMiniPlayerGesture() {
  let gesture: Gesture | null = null;

  const finish = (space: Space | null, commit: Commit) => {
    const active = gesture;
    if (!active) return;
    gesture = null;
    if (space && active.moved) {
      const { x, y } = resolvePreviewMiniPlayerFrame({
        width: active.currentFrame.width,
        position: active.currentFrame,
        ...space,
      });
      // Only persist the end position; fitting a smaller viewport must not replace the chosen width.
      commit({ ...active.currentFrame, x, y }, active.direction);
    }
    if (active.target.hasPointerCapture(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId);
    }
  };

  return {
    begin(
      event: PointerInput & {
        readonly button: number;
        readonly pointerType: string;
        readonly currentTarget: CaptureTarget;
      },
      direction: Direction,
      source: PreviewMiniPlayerSize,
    ) {
      if (gesture && !gesture.target.hasPointerCapture(gesture.pointerId)) gesture = null;
      if (event.button !== 0 || gesture) return false;
      const frame = readRenderedFrame(event.currentTarget);
      if (!frame) return false;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        return false;
      }
      gesture = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        target: event.currentTarget,
        origin: { x: event.clientX, y: event.clientY },
        frame,
        source,
        last: { x: event.clientX, y: event.clientY },
        currentFrame: frame,
        direction,
        moved: false,
      };
      return true;
    },
    move(event: PointerInput & { readonly buttons: number }, space: Space | null, commit: Commit) {
      const active = gesture;
      if (!active || active.pointerId !== event.pointerId) return;
      if ((event.buttons & 1) === 0) {
        finish(space, commit);
        return;
      }
      if (!space) return;
      if (
        active.source.width !== space.source.width ||
        active.source.height !== space.source.height
      ) {
        // The player re-rendered at the new source ratio; continue from what is on screen.
        const rendered = readRenderedFrame(active.target);
        if (rendered) {
          active.frame = rendered;
          active.currentFrame = rendered;
          active.origin = active.last;
        }
      }
      active.source = space.source;
      const delta = { x: event.clientX - active.origin.x, y: event.clientY - active.origin.y };
      if (!active.moved && Math.hypot(delta.x, delta.y) < HANDLE_TAP_SLOP_PX) return;
      active.moved = true;
      active.last = { x: event.clientX, y: event.clientY };
      active.currentFrame =
        active.direction === null
          ? {
              ...active.frame,
              ...clampPreviewMiniPlayerPosition(
                { x: active.frame.x + delta.x, y: active.frame.y + delta.y },
                space.container,
                active.frame,
              ),
            }
          : resizePreviewMiniPlayer({
              start: active.frame,
              direction: active.direction,
              delta,
              ...space,
            });
      commit(active.currentFrame, active.direction);
    },
    end(event: PointerInput & { readonly type: string }, space: Space | null, commit: Commit) {
      if (!gesture || gesture.pointerId !== event.pointerId) return null;
      const tapped =
        event.type === "pointerup" &&
        gesture.direction === null &&
        gesture.pointerType === "touch" &&
        !gesture.moved;
      finish(space, commit);
      return tapped;
    },
    finish,
  };
}
