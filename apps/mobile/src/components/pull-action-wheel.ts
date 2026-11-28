export const PULL_THRESHOLD = 72;

// Android finger travel in dp that iOS rubber-banding turns into its 72 pt of bounce.
export const STRETCH_PULL_TRAVEL = 140;

export function pullFromStretch(travel: number) {
  "worklet";
  return (travel * PULL_THRESHOLD) / STRETCH_PULL_TRAVEL;
}

interface ScrollMetrics {
  readonly contentOffset: { readonly y: number };
  readonly contentSize: { readonly height: number };
  readonly layoutMeasurement: { readonly height: number };
  readonly contentInset?: { readonly top: number; readonly bottom: number };
}

export function overscrollPastEnd(event: ScrollMetrics): number {
  "worklet";
  const top = event.contentInset?.top ?? 0;
  const bottom = event.contentInset?.bottom ?? 0;
  const end = Math.max(-top, event.contentSize.height + bottom - event.layoutMeasurement.height);
  return Math.max(0, event.contentOffset.y - end);
}

// A flick crosses the threshold and lifts within ~70ms while still moving; a deliberate pull
// holds there first and slows down to let go. Speeds are in pt or dp per ms.
export const PULL_HOLD_MS = 150;
export const PULL_RELEASE_MAX_SPEED = 1;

export function trackPull(
  armedAt: number | null,
  distance: number,
  threshold: number,
  now: number,
) {
  "worklet";
  return distance < threshold ? null : (armedAt ?? now);
}

export function shouldRunPullAction(
  armedAt: number | null,
  releasedAt: number,
  released: boolean,
  velocity: number,
) {
  "worklet";
  return (
    released &&
    Math.abs(velocity) <= PULL_RELEASE_MAX_SPEED &&
    armedAt !== null &&
    releasedAt - armedAt >= PULL_HOLD_MS
  );
}

// Equal cones across this fan, centred on straight up; past its edges the outer action holds.
export const PULL_FAN_DEGREES = 135;
// A finger resting on the line between two cones would flip the selection back and forth.
export const PULL_AIM_HYSTERESIS_DEGREES = 6;
// Closer to where the pull started than this, the finger's direction is noise.
export const PULL_AIM_MIN_TRAVEL = 16;

/** Degrees from straight up, positive to the right, of `dx` sideways and `dy` upward travel. */
export function pullFingerAngle(dx: number, dy: number) {
  "worklet";
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

export function pullSlotAngle(index: number, count: number) {
  "worklet";
  return -PULL_FAN_DEGREES / 2 + (PULL_FAN_DEGREES / count) * (index + 0.5);
}

export function pullNeedleAngle(dx: number, dy: number, count: number, defaultIndex: number) {
  "worklet";
  if (Math.hypot(dx, dy) < PULL_AIM_MIN_TRAVEL) return pullSlotAngle(defaultIndex, count);
  const half = PULL_FAN_DEGREES / 2;
  return Math.min(Math.max(pullFingerAngle(dx, dy), -half), half);
}

export function isPullActionEnabled(enabledMask: number, index: number) {
  "worklet";
  return (enabledMask & (1 << index)) !== 0;
}

/** The action whose cone the finger is in; the default until the pull is armed. */
export function pointPullAction(
  dx: number,
  dy: number,
  armed: boolean,
  previous: number,
  count: number,
  defaultIndex: number,
) {
  "worklet";
  if (!armed || Math.hypot(dx, dy) < PULL_AIM_MIN_TRAVEL) return defaultIndex;
  const angle = pullNeedleAngle(dx, dy, count, defaultIndex);
  const cone = PULL_FAN_DEGREES / count;
  if (
    previous >= 0 &&
    previous < count &&
    Math.abs(angle - pullSlotAngle(previous, count)) <= cone / 2 + PULL_AIM_HYSTERESIS_DEGREES
  ) {
    return previous;
  }
  return Math.min(Math.max(Math.floor((angle + PULL_FAN_DEGREES / 2) / cone), 0), count - 1);
}

export function selectedPullAction(pointed: number, enabledMask: number) {
  "worklet";
  return pointed >= 0 && isPullActionEnabled(enabledMask, pointed) ? pointed : -1;
}
