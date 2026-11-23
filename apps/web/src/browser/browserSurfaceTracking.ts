/** Compositor transforms emit no layout events. Remeasure browser slots while motion runs, then stop
 * after several resting frames. */

/** Where a frame belongs in a burst of movement. */
export type BrowserSurfaceSlotPhase = "start" | "frame" | "settle";

/** Re-measures one slot; returns whether its placement changed. Queue DOM writes
 * via `scheduleWrite` so every slot reads layout before any slot writes styles. */
type SlotUpdate = (
  phase: BrowserSurfaceSlotPhase,
  scheduleWrite?: (write: () => void) => void,
) => boolean;

/** Frames without movement or a running animation before a burst settles. */
const REST_FRAMES = 6;
/** A transition of one of these may move or resize a slot. */
const MOVING_PROPERTY =
  /transform|translate|scale|width|height|left|right|top|bottom|inset|margin|flex/;

const slots = new Map<HTMLElement, SlotUpdate>();
let frame: number | null = null;
let quietFrames = 0;
let starting = false;

function underAnimation(): boolean {
  for (const animation of document.getAnimations()) {
    if (animation.playState !== "running") continue;
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (!(target instanceof Element)) continue;
    for (const element of slots.keys()) {
      if (target.contains(element)) return true;
    }
  }
  return false;
}

function runPhase(phase: BrowserSurfaceSlotPhase): boolean {
  let moved = false;
  const writes: (() => void)[] = [];
  const scheduleWrite = (write: () => void) => {
    writes.push(write);
  };
  for (const update of slots.values()) {
    if (update(phase, scheduleWrite)) moved = true;
  }
  for (const write of writes) write();
  return moved;
}

function tick() {
  frame = null;
  const phase = starting ? "start" : "frame";
  starting = false;
  const moved = runPhase(phase);
  quietFrames = moved || underAnimation() ? 0 : quietFrames + 1;
  if (quietFrames < REST_FRAMES) {
    frame = window.requestAnimationFrame(tick);
    return;
  }
  runPhase("settle");
}

/**
 * Something may have moved the slots: follow them each frame until they
 * rest. `now` also places them at once, from a layout effect, so the frame
 * a layout change paints already shows its webviews where they belong.
 */
export function kickBrowserSurfaceTracking(options?: { readonly now?: boolean }): void {
  if (slots.size === 0) return;
  quietFrames = 0;
  if (options?.now) runPhase("start");
  if (frame === null) {
    starting = true;
    frame = window.requestAnimationFrame(tick);
  }
}

const onMove = () => kickBrowserSurfaceTracking();
const onPointerMove = (event: PointerEvent) => {
  // A drag (a column's edge, the overview's camera) moves panes; hovering does not.
  if (event.buttons !== 0) kickBrowserSurfaceTracking();
};
const onTransitionRun = (event: TransitionEvent) => {
  if (MOVING_PROPERTY.test(event.propertyName)) kickBrowserSurfaceTracking();
};
const listenerOptions = { capture: true, passive: true } as const;

function listen(add: boolean) {
  if (add) {
    window.addEventListener("scroll", onMove, listenerOptions);
    window.addEventListener("wheel", onMove, listenerOptions);
    window.addEventListener("resize", onMove, listenerOptions);
    window.addEventListener("pointermove", onPointerMove, listenerOptions);
    window.addEventListener("transitionrun", onTransitionRun, listenerOptions);
    return;
  }
  window.removeEventListener("scroll", onMove, listenerOptions);
  window.removeEventListener("wheel", onMove, listenerOptions);
  window.removeEventListener("resize", onMove, listenerOptions);
  window.removeEventListener("pointermove", onPointerMove, listenerOptions);
  window.removeEventListener("transitionrun", onTransitionRun, listenerOptions);
}

/** Follow a slot while it may move; returns the way to stop. */
export function trackBrowserSurfaceSlot(element: HTMLElement, update: SlotUpdate): () => void {
  if (slots.size === 0) listen(true);
  slots.set(element, update);
  kickBrowserSurfaceTracking();
  return () => {
    if (slots.get(element) !== update) return;
    slots.delete(element);
    if (slots.size > 0) return;
    listen(false);
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
  };
}
