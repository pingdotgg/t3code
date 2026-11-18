export const PULL_NEW_THREAD_THRESHOLD = 72;

// Finger travel past the end, in dp, that arms an Android pull. iOS rubber-banding turns about
// this much travel into its 72 pt of bounce.
export const STRETCH_PULL_TRAVEL = 140;

export function pullFromStretch(travel: number) {
  "worklet";
  return (travel * PULL_NEW_THREAD_THRESHOLD) / STRETCH_PULL_TRAVEL;
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

export function shouldStartNewThread(
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
