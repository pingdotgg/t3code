/**
 * Android markdown links are nested React Native `Text` nodes with `onPress`.
 * Pressability fires that callback on finger-up while the touch is still
 * inside the link. Nested text measures as an empty rect, so a move never
 * counts as leaving, and there is no `onLongPress` to cancel the press.
 * A selection drag that starts on the link therefore opens it and dismisses
 * the selection.
 *
 * Pressability's own long-press deactivation distance is 10dp, but it bails
 * out before applying that check when the measured rect is empty. Apply the
 * same distance here: a tap still opens, a drag does not.
 */
export const ANDROID_LINK_SELECTION_DRAG_SLOP_DP = 10;

export interface AndroidLinkPressPoint {
  readonly pageX: number;
  readonly pageY: number;
}

export interface AndroidLinkGesture {
  pageX: number;
  pageY: number;
  moved: boolean;
}

interface PressEventLike {
  readonly nativeEvent?: {
    readonly pageX?: number;
    readonly pageY?: number;
    readonly touches?: ReadonlyArray<Partial<AndroidLinkPressPoint>>;
    readonly changedTouches?: ReadonlyArray<Partial<AndroidLinkPressPoint>>;
  };
}

export interface AndroidMarkdownLinkPressHandlers {
  onPress: (event?: PressEventLike) => void;
  onPressIn: (event: PressEventLike) => void;
  onResponderMove: (event: PressEventLike) => void;
  onResponderTerminate: () => void;
}

export function androidLinkPressPoint(
  event: PressEventLike | undefined,
): AndroidLinkPressPoint | null {
  const native = event?.nativeEvent;
  if (native == null) return null;
  const touch = native.touches?.[0] ?? native.changedTouches?.[0] ?? native;
  const { pageX, pageY } = touch;
  if (typeof pageX !== "number" || typeof pageY !== "number") return null;
  if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return null;
  return { pageX, pageY };
}

export function beginAndroidLinkGesture(point: AndroidLinkPressPoint): AndroidLinkGesture {
  return { pageX: point.pageX, pageY: point.pageY, moved: false };
}

/** True once the finger has traveled far enough to be a selection drag. */
export function androidLinkPressMoved(
  start: AndroidLinkPressPoint,
  point: AndroidLinkPressPoint,
  slopDp = ANDROID_LINK_SELECTION_DRAG_SLOP_DP,
): boolean {
  if (
    !Number.isFinite(start.pageX) ||
    !Number.isFinite(start.pageY) ||
    !Number.isFinite(point.pageX) ||
    !Number.isFinite(point.pageY) ||
    !Number.isFinite(slopDp)
  ) {
    return false;
  }
  const dx = point.pageX - start.pageX;
  const dy = point.pageY - start.pageY;
  return dx * dx + dy * dy > slopDp * slopDp;
}

export function trackAndroidLinkGestureMove(
  gesture: AndroidLinkGesture,
  point: AndroidLinkPressPoint,
  slopDp = ANDROID_LINK_SELECTION_DRAG_SLOP_DP,
): void {
  if (gesture.moved) return;
  if (androidLinkPressMoved(gesture, point, slopDp)) gesture.moved = true;
}

/**
 * A link opens on finger-up when the gesture never moved past the slop.
 * No tracked gesture (an accessibility activate) still opens.
 */
export function shouldOpenAndroidMarkdownLink(
  gesture: AndroidLinkGesture | null,
  end: AndroidLinkPressPoint | null,
  slopDp = ANDROID_LINK_SELECTION_DRAG_SLOP_DP,
): boolean {
  if (gesture == null) return true;
  if (gesture.moved) return false;
  if (end == null) return true;
  return !androidLinkPressMoved(gesture, end, slopDp);
}

export function androidMarkdownLinkPressHandlers(
  gesture: { current: AndroidLinkGesture | null },
  openLink: () => void,
): AndroidMarkdownLinkPressHandlers {
  return {
    onPressIn(event) {
      const point = androidLinkPressPoint(event);
      gesture.current = point == null ? null : beginAndroidLinkGesture(point);
    },
    onResponderMove(event) {
      const current = gesture.current;
      const point = androidLinkPressPoint(event);
      if (current != null && point != null) trackAndroidLinkGestureMove(current, point);
    },
    onResponderTerminate() {
      gesture.current = null;
    },
    onPress(event) {
      const current = gesture.current;
      gesture.current = null;
      if (!shouldOpenAndroidMarkdownLink(current, androidLinkPressPoint(event))) return;
      openLink();
    },
  };
}
