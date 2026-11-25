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

export const PULL_SWING_PER_ACTION = 56;
// A finger resting on the line between two actions would flip the selection back and forth.
export const PULL_SWING_HYSTERESIS = 0.2;
export const PULL_WHEEL_SPREAD_DEGREES = 52;

export function swingPosition(dx: number, count: number, defaultIndex: number) {
  "worklet";
  return Math.min(Math.max(defaultIndex + dx / PULL_SWING_PER_ACTION, 0), Math.max(count - 1, 0));
}

export function isPullActionEnabled(enabledMask: number, index: number) {
  "worklet";
  return (enabledMask & (1 << index)) !== 0;
}

export function pointPullAction(position: number, previous: number, count: number) {
  "worklet";
  if (
    previous >= 0 &&
    previous < count &&
    Math.abs(position - previous) <= 0.5 + PULL_SWING_HYSTERESIS
  ) {
    return previous;
  }
  return Math.min(Math.max(Math.round(position), 0), count - 1);
}

export function selectedPullAction(pointed: number, enabledMask: number) {
  "worklet";
  return pointed >= 0 && isPullActionEnabled(enabledMask, pointed) ? pointed : -1;
}

export function wheelAngle(position: number, count: number) {
  "worklet";
  return (position - (count - 1) / 2) * PULL_WHEEL_SPREAD_DEGREES;
}
