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
interface Gesture extends PointerInput {
  readonly pointerType: string;
  readonly target: CaptureTarget;
  readonly direction: Direction;
  frame: PreviewMiniPlayerFrame;
  currentFrame: PreviewMiniPlayerFrame;
  source: PreviewMiniPlayerSize;
  moved: boolean;
}
type Commit = (frame: PreviewMiniPlayerFrame, direction: Direction) => void;
interface Space {
  readonly container: PreviewMiniPlayerSize;
  readonly source: PreviewMiniPlayerSize;
}

// Rendering derives height from the live source ratio, so a source change mid-resize would move the
// anchored edge. Refit the gesture's frames to the new ratio around the edges it holds fixed.
function followSource(active: Gesture, space: Space | null) {
  if (!space) return;
  const { source } = space;
  if (source.width === active.source.width && source.height === active.source.height) return;
  active.source = source;
  const refit = (frame: PreviewMiniPlayerFrame) => {
    const height = (frame.width * source.height) / source.width;
    const north = active.direction?.includes("north") ?? false;
    return { ...frame, height, y: north ? frame.y + frame.height - height : frame.y };
  };
  active.frame = refit(active.frame);
  active.currentFrame = refit(active.currentFrame);
  if (active.direction !== null) active.moved = true;
}

export function createPreviewMiniPlayerGesture() {
  let gesture: Gesture | null = null;

  const finish = (space: Space | null, commit: Commit) => {
    const active = gesture;
    if (!active) return;
    gesture = null;
    followSource(active, space);
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
      const preview = event.currentTarget.closest("[data-preview-mini-player]");
      if (!preview) return false;
      // Computed CSS geometry preserves fractional coordinates in the player's local space.
      const style = getComputedStyle(preview);
      const frame = {
        x: Number.parseFloat(style.left),
        y: Number.parseFloat(style.top),
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
      };
      if (!Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) {
        return false;
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        return false;
      }
      gesture = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.currentTarget,
        frame,
        currentFrame: frame,
        source,
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
      followSource(active, space);
      const delta = { x: event.clientX - active.clientX, y: event.clientY - active.clientY };
      if (!active.moved && Math.hypot(delta.x, delta.y) < HANDLE_TAP_SLOP_PX) return;
      active.moved = true;
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
