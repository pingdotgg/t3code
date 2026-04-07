export const SWIPE_THRESHOLD = 80;
// Minimum horizontal movement before we consider it a swipe intent
export const SWIPE_LOCK_PX = 20;
// Horizontal movement must be this many times greater than vertical to count as a swipe
export const SWIPE_AXIS_RATIO = 2;
// If vertical movement exceeds this before horizontal lock-in, treat as a scroll and cancel
export const SCROLL_CANCEL_PX = 12;

export type SwipeGestureState = "idle" | "swiping" | "cancelled";

/**
 * Pure state transition function for swipe gesture detection.
 * Given the current gesture state and cumulative delta from touch start,
 * returns the next state.
 *
 * Rules (evaluated in order):
 * 1. Already committed (swiping or cancelled) → state is terminal, return as-is
 * 2. Vertical movement exceeds SCROLL_CANCEL_PX → treat as scroll, cancel
 * 3. Horizontal movement exceeds SWIPE_LOCK_PX and is 2× the vertical → lock in as swipe
 * 4. Otherwise → remain idle
 */
export function resolveSwipeGestureState(
  current: SwipeGestureState,
  delta: { dx: number; dy: number },
): SwipeGestureState {
  if (current !== "idle") return current;

  if (Math.abs(delta.dy) > SCROLL_CANCEL_PX) return "cancelled";

  if (
    Math.abs(delta.dx) > SWIPE_LOCK_PX &&
    Math.abs(delta.dx) > Math.abs(delta.dy) * SWIPE_AXIS_RATIO
  ) {
    return "swiping";
  }

  return "idle";
}

// --- Pull-to-reveal (vertical) gesture ---

export const PULL_THRESHOLD = 64;
// Minimum downward movement before locking in as a pull gesture
const PULL_LOCK_PY = 16;
// Vertical movement must be this many times greater than horizontal
const PULL_AXIS_RATIO = 1.5;

export type PullGestureState = "idle" | "pulling" | "cancelled";

/**
 * Pure state transition for pull-down gesture detection.
 * Mirrors resolveSwipeGestureState but for the vertical axis.
 *
 * Rules:
 * 1. Already committed → terminal, return as-is
 * 2. Horizontal movement too large → treat as swipe, cancel
 * 3. Upward movement → cancel
 * 4. Downward movement exceeds lock-in and dominates horizontal → lock in as pull
 * 5. Otherwise → remain idle
 */
export function resolvePullGestureState(
  current: PullGestureState,
  delta: { dx: number; dy: number },
): PullGestureState {
  if (current !== "idle") return current;
  if (Math.abs(delta.dx) > SWIPE_LOCK_PX) return "cancelled";
  if (delta.dy < 0) return "cancelled";
  if (delta.dy > PULL_LOCK_PY && delta.dy > Math.abs(delta.dx) * PULL_AXIS_RATIO) {
    return "pulling";
  }
  return "idle";
}
