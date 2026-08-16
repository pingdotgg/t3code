/**
 * Keeping what a reader is looking at true, whichever way they arrived at it.
 *
 * A pull request changes while nobody is looking at it — a push lands, a check finishes, somebody
 * approves — and a view that only reads on mount shows yesterday's answer for as long as the tab
 * stays open. Three moments deserve a read: arriving at the view, coming back to the window, and
 * simply sitting on it while it is open. All three are the same policy, so they live in one hook
 * rather than three; every one of them is bounded by the same minimum interval, so the moments
 * arriving together still cost one read.
 *
 * Every read here shells out to a host's API from the server, so the policy is written to spend as
 * little as it can get away with: the very first arrival at a view spends nothing, because the
 * view's own first read is already on its way, and the interval stops as soon as the reader stops
 * reading.
 */
import { useEffect, useId, useRef } from "react";

/** Long enough that alt-tabbing through windows does not become a request per tab stop. */
export const LIVE_REFRESH_MIN_INTERVAL_MS = 10_000;

/** Slow enough to preserve host quota while still updating a view left open. */
export const LIVE_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * How long a showing window goes untouched before it stops reading. This leaves one minute after
 * the five-minute interval for the first timer tick to run. A window left open on a
 * monitor nobody is sitting at is showing in every sense the browser knows about, and polling it
 * until morning spends a night of somebody's rate limit on an answer nobody read. Their next
 * click, key or scroll starts the interval up again.
 */
export const LIVE_REFRESH_IDLE_AFTER_MS = 6 * 60_000;

/**
 * Whether a view should read again now. Separate from the hook because the rule is the whole of
 * it: only while the window is actually showing, and not again straight away — a reader passing
 * through three windows, or returning to a tab that missed an hour of ticks, is asking for one
 * read, not one per thing that happened while they were away.
 */
export function shouldLiveRefresh(input: {
  readonly visible: boolean;
  readonly now: number;
  readonly lastRefreshedAt: number;
}): boolean {
  return input.visible && input.now - input.lastRefreshedAt >= LIVE_REFRESH_MIN_INTERVAL_MS;
}

/**
 * Whether arriving at a view should read it. A view nobody has read this session is left alone:
 * mounting it starts its own read, and refreshing on top of that cancels the request in flight
 * and pays for the same answer twice. Every later arrival is an ordinary refresh.
 */
export function shouldRefreshOnArrival(input: {
  readonly visible: boolean;
  readonly now: number;
  readonly lastRefreshedAt: number | undefined;
}): boolean {
  return (
    input.lastRefreshedAt !== undefined &&
    shouldLiveRefresh({ ...input, lastRefreshedAt: input.lastRefreshedAt })
  );
}

/**
 * Whether the interval should read again. The same rule as any other read, plus the reader having
 * been here recently enough for the answer to be for somebody.
 */
export function shouldRefreshOnInterval(input: {
  readonly visible: boolean;
  readonly now: number;
  readonly lastRefreshedAt: number;
  readonly lastInteractedAt: number;
}): boolean {
  return (
    input.now - input.lastInteractedAt < LIVE_REFRESH_IDLE_AFTER_MS && shouldLiveRefresh(input)
  );
}

/**
 * When each view last read, kept outside React because a mount is exactly what it has to outlive:
 * a reader who navigates away and straight back mounts a fresh hook, and a timestamp that started
 * at zero would call that first read due. Keyed by whatever the caller calls the view, because two
 * views on screen at once each owe their own reader an answer. Entries are one number and never
 * pruned; there is one per view the session ever read.
 */
const lastRefreshedAtByView = new Map<string, number>();

/**
 * When the reader last did anything. Shared rather than per view: a person is present in the
 * window, not in one component of it. Only tracked while a live view is mounted, and the handler
 * writes a number and nothing else, so a mousemove costs what a mousemove costs.
 */
let lastInteractedAt = 0;
let interactionWatchers = 0;
const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
const noteInteraction = () => {
  lastInteractedAt = Date.now();
};

function watchInteraction(): () => void {
  if (interactionWatchers === 0) {
    // Arriving is itself the reader doing something, and it is what makes the first interval tick
    // after a mount count.
    lastInteractedAt = Date.now();
    for (const event of INTERACTION_EVENTS) {
      document.addEventListener(event, noteInteraction, { passive: true });
    }
  }
  interactionWatchers += 1;
  return () => {
    interactionWatchers -= 1;
    if (interactionWatchers > 0) return;
    for (const event of INTERACTION_EVENTS) {
      document.removeEventListener(event, noteInteraction);
    }
  };
}

export function useLiveRefresh(
  refresh: (() => void) | null,
  options: { readonly enabled?: boolean; readonly key?: string } = {},
): void {
  const { enabled = true, key } = options;
  // Held in a ref so a caller can pass a fresh closure every render without re-arming the
  // listeners, which would otherwise refresh on every render that changed anything at all.
  const latest = useRef(refresh);
  latest.current = refresh;
  // A caller that shows a different thing in the same place — one panel, a pull request at a time —
  // says which thing it is showing, so the reads it owes follow the thing rather than the slot.
  // Anything else is one view per place it appears, which is what the tree position already means.
  const fallbackViewId = useId();
  const viewId = key ?? fallbackViewId;

  useEffect(() => {
    if (!enabled) return;
    const read = (now: number) => {
      lastRefreshedAtByView.set(viewId, now);
      latest.current?.();
    };
    const visible = () => document.visibilityState === "visible";
    const onArrival = () => {
      const now = Date.now();
      const lastRefreshedAt = lastRefreshedAtByView.get(viewId);
      if (lastRefreshedAt === undefined) {
        // Nothing read yet, so nothing to refresh: the mount's own read is what fills this in.
        lastRefreshedAtByView.set(viewId, now);
        return;
      }
      if (shouldRefreshOnArrival({ visible: visible(), now, lastRefreshedAt })) read(now);
    };
    const onInterval = () => {
      const now = Date.now();
      const lastRefreshedAt = lastRefreshedAtByView.get(viewId) ?? now;
      if (shouldRefreshOnInterval({ visible: visible(), now, lastRefreshedAt, lastInteractedAt })) {
        read(now);
      }
    };

    let timer: ReturnType<typeof setInterval> | undefined;
    // The timer exists only while the window is showing: a tab sitting behind another one should
    // cost the host nothing, and the reads it missed collapse into the single one it makes on the
    // way back. Nothing else moves the window between showing and hidden, so nothing else re-arms.
    const syncTimer = () => {
      clearInterval(timer);
      timer = visible() ? setInterval(onInterval, LIVE_REFRESH_INTERVAL_MS) : undefined;
    };
    const onVisibilityChange = () => {
      onArrival();
      syncTimer();
    };

    const stopWatchingInteraction = watchInteraction();
    onArrival();
    syncTimer();
    window.addEventListener("focus", onArrival);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onArrival);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopWatchingInteraction();
    };
  }, [enabled, viewId]);
}
