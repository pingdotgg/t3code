/** Move the native scroller to its target immediately, then animate the stage back to rest; caret
 * measurements must see the final camera position. */
import {
  FINE_STEP_MS,
  MotionAnimation,
  playMotion,
  toDevicePixel,
  type MotionRun,
} from "./animation";

let current: { scroller: HTMLElement; run: MotionRun } | null = null;

const claimed = new WeakSet<HTMLElement>();

/** Drop external scroll writes while camera motion owns the strip; editor focus otherwise follows
 * transformed caret geometry and flashes undrawn content. */
function claimStripScroll(scroller: HTMLElement): void {
  if (claimed.has(scroller)) return;
  const nativeScrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
  if (!nativeScrollLeft?.get || !nativeScrollLeft.set) return;
  claimed.add(scroller);
  const { get, set } = nativeScrollLeft;
  Object.defineProperty(scroller, "scrollLeft", {
    configurable: true,
    get() {
      return get.call(scroller);
    },
    set(value: number) {
      if (current?.scroller === scroller) return;
      set.call(scroller, value);
    },
  });
}

/** When the user last scrolled the strip sideways; a camera move ends it. */
let userScrollAt = Number.NEGATIVE_INFINITY;

/** A wheel, swipe or drag of the user's is scrolling the strip. */
export function noteUserStripScroll(): void {
  userScrollAt = performance.now();
}

/** How long since the user last scrolled the strip, in ms; a camera move ends it. */
export function userStripScrollAge(): number {
  return performance.now() - userScrollAt;
}

/** The user's scroll was handled; the next settle is not theirs until they scroll again. */
export function endUserStripScroll(): void {
  userScrollAt = Number.NEGATIVE_INFINITY;
}

/**
 * Spring the camera from where it shows now to `target` (a scrollLeft). With `carryOn` (a focus key,
 * whose layout does not change), a move in flight carries on in this frame at the speed it had.
 * With `jump` (a switch to another thread) it lands there at once.
 */
export function moveStripCamera(
  scroller: HTMLElement,
  stage: HTMLElement,
  target: number,
  { carryOn = false, jump = false }: { carryOn?: boolean; jump?: boolean } = {},
): void {
  claimStripScroll(scroller);
  userScrollAt = Number.NEGATIVE_INFINITY;
  const running = current?.scroller === scroller ? current : null;
  const from = current ? current.run.value() : scroller.scrollLeft;
  const velocity = running && carryOn ? running.run.velocity() : 0;
  const previous = current;
  current = null;
  // On a whole device pixel, where the compositor and layout agree.
  scroller.scrollLeft = toDevicePixel(target);
  // The browser clamps a scroll past the strip's end.
  const landed = scroller.scrollLeft;
  if (jump) {
    previous?.run.cancel();
    return;
  }
  const motion = MotionAnimation.start("horizontal-view-movement", from, landed, velocity);
  let finished = false;
  const keyframe = (camera: number) => ({
    transform: `translateX(${toDevicePixel(landed - camera)}px)`,
  });
  const onFinish = () => {
    finished = true;
    current = null;
  };
  // Retargeted in place, the running animation goes on from this frame; a new
  // one would hold the camera still for a frame on every key repeat.
  let run = running && carryOn ? running.run.retarget(motion, keyframe, onFinish) : null;
  if (!run) {
    previous?.run.cancel();
    // Starts on the frame that first shows the new layout, with the panes'
    // own slides: a keypress whose commit takes a few frames would
    // otherwise land mid-move, skipping the start and out of step with them.
    run = playMotion(stage, motion, keyframe, onFinish, undefined, FINE_STEP_MS);
  }
  if (!finished) current = { scroller, run };
}

/** Where the camera shows now, in scroll px: mid-move, not where the scroll already landed. */
export function stripCameraPosition(scroller: HTMLElement): number {
  return current?.scroller === scroller ? current.run.value() : scroller.scrollLeft;
}

/**
 * Stop a camera move where it shows now: the scroll takes the in-between
 * position, so a wheel, a drag or the overview carries on from the eye.
 */
export function settleStripCamera(): void {
  if (!current) return;
  const { scroller, run } = current;
  const camera = run.value();
  run.cancel();
  current = null;
  scroller.scrollLeft = camera;
}
