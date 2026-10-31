/** Move the native scroller to its target immediately, then animate the stage back to rest; caret
 * measurements must see the final camera position. */
import { MotionAnimation, playMotion, toDevicePixel, type MotionRun } from "./animation";

let current: { scroller: HTMLElement; run: MotionRun } | null = null;

const nativeScrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
const claimed = new WeakSet<HTMLElement>();

/** Drop external scroll writes while camera motion owns the strip; editor focus otherwise follows
 * transformed caret geometry and flashes undrawn content. */
function claimStripScroll(scroller: HTMLElement): void {
  if (claimed.has(scroller) || !nativeScrollLeft?.get || !nativeScrollLeft.set) return;
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

/** Spring the camera from where it shows now to `target` (a scrollLeft), keeping its velocity. */
export function moveStripCamera(scroller: HTMLElement, stage: HTMLElement, target: number): void {
  claimStripScroll(scroller);
  userScrollAt = Number.NEGATIVE_INFINITY;
  let from = scroller.scrollLeft;
  let velocity = 0;
  if (current) {
    from = current.run.value();
    velocity = current.run.velocity();
    current.run.cancel();
    current = null;
  }
  // On a whole device pixel, where the compositor and layout agree.
  scroller.scrollLeft = toDevicePixel(target);
  // The browser clamps a scroll past the strip's end.
  const landed = scroller.scrollLeft;
  const motion = MotionAnimation.start("horizontal-view-movement", from, landed, velocity);
  if (motion.durationMs <= 0) return;
  const move = {
    scroller,
    run: playMotion(
      stage,
      motion,
      (camera) => ({ transform: `translateX(${toDevicePixel(landed - camera)}px)` }),
      () => {
        if (current === move) current = null;
      },
      // Starts on the frame that first shows the new layout, with the panes'
      // own slides: a keypress whose commit takes a few frames would
      // otherwise land mid-move, skipping the start and out of step with them.
      undefined,
      true,
    ),
  };
  current = move;
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
