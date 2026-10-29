/**
 * Snap the mobile sidebar sheet open or closed from a touch or pen drag.
 *
 * The closed sheet is not in the DOM, so an open drag has to start on the
 * page, inside a narrow left-edge band. A close drag starts on the open
 * sheet. Vertical movement cancels the drag so the thread list still scrolls.
 */

export const SIDEBAR_SWIPE_EDGE_PX = 24;
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
 * Mouse drags at the left edge would fight text selection in a narrow window.
 * Touch and pen are the only pointers that should move the sheet.
 */
function isSidebarSwipePointer(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

export function beginSidebarSwipe(input: {
  pointerType: string;
  pointerId: number;
  x: number;
  y: number;
  time: number;
  intent: SidebarSwipeIntent;
  edgePx?: number;
}): SidebarSwipeGesture | null {
  if (!isSidebarSwipePointer(input.pointerType)) return null;
  if (input.intent === "open" && input.x > (input.edgePx ?? SIDEBAR_SWIPE_EDGE_PX)) return null;

  return {
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
  if (gesture.phase === "cancelled") return false;
  if (gesture.phase === "horizontal") return true;
  const dx = gesture.x - gesture.startX;
  const dy = gesture.y - gesture.startY;
  if (dx === 0 && dy === 0) return false;
  const towardSheet = gesture.intent === "open" ? dx > 0 : dx < 0;
  return towardSheet && Math.abs(dx) > Math.abs(dy);
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
