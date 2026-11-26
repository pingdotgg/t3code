export type WheelZoomDirection = "in" | "out";

interface WheelZoomInput {
  readonly deltaY: number;
  readonly timeStamp: number;
}

// A wheel event after this long a pause starts a new gesture.
const GESTURE_GAP_MS = 250;
// Chromium sends a slow macOS mouse notch as 40px before zoom; a little less absorbs rounding.
const STEP_DISTANCE_PX = 36;

// A mouse sends one event per notch and a trackpad a stream of small deltas, both divided by the
// zoom factor. The first event of a gesture steps at once and the rest once per STEP_DISTANCE_PX
// of unzoomed scrolling.
export const makeWheelZoomStepper = (zoomFactor: () => number) => {
  let delta = 0;
  let lastAt = Number.NEGATIVE_INFINITY;
  return (event: WheelZoomInput): WheelZoomDirection | null => {
    if (event.deltaY === 0) return null;
    const startsGesture = event.timeStamp - lastAt > GESTURE_GAP_MS;
    lastAt = event.timeStamp;
    const unzoomed = event.deltaY * zoomFactor();
    delta = startsGesture ? unzoomed : delta + unzoomed;
    if (!startsGesture && Math.abs(delta) < STEP_DISTANCE_PX) return null;
    const direction = delta < 0 ? "in" : "out";
    delta = 0;
    return direction;
  };
};
