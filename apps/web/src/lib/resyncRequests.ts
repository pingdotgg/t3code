import { ResyncRequests } from "@t3tools/client-runtime/connection";

/**
 * Coalescing wrapper around the shared resync signal.
 *
 * A reconcile costs a snapshot fetch and a resubscribe, and the callers that
 * need one arrive in bursts — settling twenty threads at once would otherwise
 * ask twenty times for work that a single reconcile already covers for the
 * whole environment.
 *
 * Coalescing here is trailing-edge, not leading-edge-only. A request exists
 * because something observed the client disagreeing with the server, so
 * dropping it outright would defeat the recovery this exists to perform: a
 * request suppressed behind an earlier one would leave that disagreement
 * standing until the user happened to act again. Suppressed requests instead
 * collapse into one reconcile at the end of the window.
 */

/** Minimum spacing between reconciles. */
export const RESYNC_MIN_INTERVAL_MS = 5_000;

export interface ResyncScheduler {
  readonly now: () => number;
  readonly setTimer: (run: () => void, delayMs: number) => void;
}

const defaultScheduler: ResyncScheduler = {
  now: () => Date.now(),
  setTimer: (run, delayMs) => {
    setTimeout(run, delayMs);
  },
};

let lastFiredAtMs: number | null = null;
let trailingScheduled = false;
/** Whether a request has arrived that no reconcile has covered yet. */
let requestOutstanding = false;

function fire(atMs: number): void {
  lastFiredAtMs = atMs;
  requestOutstanding = false;
  ResyncRequests.requestResync();
}

/**
 * Request a reconcile. Fires immediately when the window is open, otherwise
 * defers to the end of the current window — never drops the request.
 */
export function requestResync(scheduler: ResyncScheduler = defaultScheduler): void {
  const nowMs = scheduler.now();
  const elapsedMs = lastFiredAtMs === null ? null : nowMs - lastFiredAtMs;
  // A clock that jumped backward (NTP correction, manual change) must not
  // wedge the throttle shut until wall time catches back up: a negative
  // elapsed means the recorded timestamp is meaningless, so start a fresh
  // window rather than suppressing every reconcile in the meantime.
  if (elapsedMs === null || elapsedMs < 0 || elapsedMs >= RESYNC_MIN_INTERVAL_MS) {
    fire(nowMs);
    return;
  }
  requestOutstanding = true;
  if (trailingScheduled) {
    return;
  }
  trailingScheduled = true;
  scheduler.setTimer(() => {
    trailingScheduled = false;
    // An immediate reconcile may have landed since this was scheduled — an
    // open window, or a backward clock jump. It already covered whatever was
    // outstanding, so firing again would be the double reconcile the
    // coalescing exists to prevent. Tracking outstanding work rather than
    // cancelling the timer keeps a request that arrived *after* that
    // reconcile from being dropped along with the obsolete one.
    if (!requestOutstanding) {
      return;
    }
    fire(scheduler.now());
  }, RESYNC_MIN_INTERVAL_MS - elapsedMs);
}

/** Test seam: forget the coalescing window and any pending trailing fire. */
export function resetResyncThrottleForTesting(): void {
  lastFiredAtMs = null;
  trailingScheduled = false;
  requestOutstanding = false;
}
