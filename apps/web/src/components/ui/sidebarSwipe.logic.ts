/**
 * Snap the mobile sidebar sheet open or closed from a touch or pen drag.
 *
 * An open drag can start anywhere on the page. A close drag starts on the
 * open sheet. Vertical movement cancels the drag so content still scrolls.
 */

export const SIDEBAR_SWIPE_AXIS_LOCK_PX = 12;
export const SIDEBAR_SWIPE_COMMIT_PX = 48;
export const SIDEBAR_SWIPE_FLICK_MIN_PX = 16;
export const SIDEBAR_SWIPE_FLICK_PX_PER_MS = 0.6;

export type SidebarSwipeIntent = "open" | "close";
export type SidebarSwipePhase = "pending" | "horizontal" | "cancelled";

export interface SidebarSwipePoint {
  x: number;
  y: number;
  time: number;
}

export interface SidebarSwipeGesture {
  pointerType: "touch" | "pen";
  phase: SidebarSwipePhase;
  intent: SidebarSwipeIntent;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  startTime: number;
  time: number;
}

/**
 * Mouse drags would fight text selection in a narrow window.
 * Touch and pen are the only pointers that should move the sheet.
 */
function isSidebarSwipePointer(
  pointerType: string,
): pointerType is SidebarSwipeGesture["pointerType"] {
  return pointerType === "touch" || pointerType === "pen";
}

export function beginSidebarSwipe(input: {
  pointerType: string;
  pointerId: number;
  x: number;
  y: number;
  time: number;
  intent: SidebarSwipeIntent;
}): SidebarSwipeGesture | null {
  if (!isSidebarSwipePointer(input.pointerType)) return null;

  return {
    pointerType: input.pointerType,
    phase: "pending",
    intent: input.intent,
    pointerId: input.pointerId,
    startX: input.x,
    startY: input.y,
    x: input.x,
    y: input.y,
    startTime: input.time,
    time: input.time,
  };
}

/**
 * Claim the pointer once horizontal motion is clearly the user's intent, before
 * the browser turns that same touch into a scroll.
 */
export function shouldClaimSidebarSwipe(gesture: SidebarSwipeGesture): boolean {
  // Wait for axis lock so ordinary tap drift does not cancel native clicks.
  // Claim on touchmove, before waiting for the larger commit distance.
  return gesture.phase === "horizontal";
}

export function moveSidebarSwipe(
  gesture: SidebarSwipeGesture,
  point: SidebarSwipePoint,
  lockPx = SIDEBAR_SWIPE_AXIS_LOCK_PX,
): SidebarSwipeGesture {
  const next: SidebarSwipeGesture = {
    ...gesture,
    x: point.x,
    y: point.y,
    time: point.time,
  };
  if (next.phase !== "pending") return next;

  const dx = point.x - gesture.startX;
  const dy = point.y - gesture.startY;
  if (Math.abs(dx) < lockPx && Math.abs(dy) < lockPx) return next;

  const towardSheet = gesture.intent === "open" ? dx > 0 : dx < 0;
  next.phase = towardSheet && Math.abs(dx) > Math.abs(dy) ? "horizontal" : "cancelled";
  return next;
}

/**
 * A committed drag snaps the sheet. A short fast flick counts, so the finger
 * does not have to cross half the screen. Anything still pending or vertical
 * is a tap or a scroll and leaves the sheet alone.
 */
export function endSidebarSwipe(
  gesture: SidebarSwipeGesture,
  options?: {
    commitPx?: number;
    flickMinPx?: number;
    flickPxPerMs?: number;
  },
): "commit" | "ignore" {
  if (gesture.phase !== "horizontal") return "ignore";

  const dx = gesture.x - gesture.startX;
  const directed = gesture.intent === "open" ? dx : -dx;
  if (directed >= (options?.commitPx ?? SIDEBAR_SWIPE_COMMIT_PX)) return "commit";

  const elapsed = Math.max(gesture.time - gesture.startTime, 1);
  const flickMin = options?.flickMinPx ?? SIDEBAR_SWIPE_FLICK_MIN_PX;
  const flickSpeed = options?.flickPxPerMs ?? SIDEBAR_SWIPE_FLICK_PX_PER_MS;
  if (directed >= flickMin && directed / elapsed >= flickSpeed) return "commit";
  return "ignore";
}

export type SidebarSwipeModality = SidebarSwipeGesture["pointerType"];

export interface SidebarSwipeContact {
  modality: SidebarSwipeModality;
  id: number;
  x: number;
  y: number;
  time: number;
}

export interface SidebarSwipeRelease {
  /** The intent to apply, or null when the drag did not commit. */
  commit: SidebarSwipeIntent | null;
  /** A claimed drag still ends with a click that must not reach the page. */
  claimed: boolean;
}

/**
 * Follow one drag at a time across touch and pen streams. Touch identifiers
 * and pen pointer IDs are unrelated, so every event matches on both. A right
 * drawer mirrors x so its open drag still moves toward the sheet.
 */
export function createSidebarSwipeTracker(side: "left" | "right" = "left") {
  let gesture: SidebarSwipeGesture | null = null;
  let claimed = false;
  const project = (x: number) => (side === "right" ? -x : x);
  const owns = (modality: SidebarSwipeModality, id: number) =>
    gesture?.pointerType === modality && gesture.pointerId === id;

  return {
    get idle() {
      return gesture === null;
    },
    /** A new press ends a stale drag of the same modality whose release never arrived. */
    drop(modality: SidebarSwipeModality) {
      if (gesture?.pointerType === modality) gesture = null;
    },
    begin(contact: SidebarSwipeContact, intent: SidebarSwipeIntent) {
      if (gesture !== null) return;
      gesture = beginSidebarSwipe({
        pointerType: contact.modality,
        pointerId: contact.id,
        x: project(contact.x),
        y: contact.y,
        time: contact.time,
        intent,
      });
      claimed = false;
    },
    /** Returns true when the drag is claimed and the browser must not scroll. */
    move(contact: SidebarSwipeContact): boolean {
      if (gesture === null || !owns(contact.modality, contact.id)) return false;
      gesture = moveSidebarSwipe(gesture, {
        x: project(contact.x),
        y: contact.y,
        time: contact.time,
      });
      if (!shouldClaimSidebarSwipe(gesture)) return false;
      claimed = true;
      return true;
    },
    release(contact: SidebarSwipeContact): SidebarSwipeRelease | null {
      if (gesture === null || !owns(contact.modality, contact.id)) return null;
      const finished = moveSidebarSwipe(gesture, {
        x: project(contact.x),
        y: contact.y,
        time: contact.time,
      });
      gesture = null;
      return {
        commit: endSidebarSwipe(finished) === "commit" ? finished.intent : null,
        claimed: claimed || shouldClaimSidebarSwipe(finished),
      };
    },
    cancel(modality: SidebarSwipeModality, id: number) {
      if (owns(modality, id)) gesture = null;
    },
  };
}
