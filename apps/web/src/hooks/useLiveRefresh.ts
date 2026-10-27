import { useEffect, useEffectEvent, useId } from "react";

export const LIVE_REFRESH_MIN_INTERVAL_MS = 10_000;

const LIVE_REFRESH_INTERVAL_MS = 5 * 60_000;

const LIVE_REFRESH_IDLE_AFTER_MS = 6 * 60_000;

function shouldLiveRefresh(input: {
  readonly visible: boolean;
  readonly now: number;
  readonly lastRefreshedAt: number;
}): boolean {
  return input.visible && input.now - input.lastRefreshedAt >= LIVE_REFRESH_MIN_INTERVAL_MS;
}

/**
 * A view nobody has read this session is left alone: mounting it starts its own read, and
 * refreshing on top of that cancels the request in flight and pays for the same answer twice.
 */
function shouldRefreshOnArrival(input: {
  readonly visible: boolean;
  readonly now: number;
  readonly lastRefreshedAt: number | undefined;
}): boolean {
  return (
    input.lastRefreshedAt !== undefined &&
    shouldLiveRefresh({ ...input, lastRefreshedAt: input.lastRefreshedAt })
  );
}

function shouldRefreshOnInterval(input: {
  readonly visible: boolean;
  readonly now: number;
  readonly lastRefreshedAt: number;
  readonly lastInteractedAt: number;
}): boolean {
  return (
    input.now - input.lastInteractedAt < LIVE_REFRESH_IDLE_AFTER_MS && shouldLiveRefresh(input)
  );
}

// Survive remounts so returning to a view does not make fresh reads look overdue.
const lastRefreshedAtByView = new Map<string, number>();

let lastInteractedAt = 0;
const interactionWatchers = new Set<() => void>();
const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
const noteInteraction = () => {
  const now = Date.now();
  const wasIdle = now - lastInteractedAt >= LIVE_REFRESH_IDLE_AFTER_MS;
  lastInteractedAt = now;
  if (wasIdle) for (const resume of interactionWatchers) resume();
};

function watchInteraction(resume: () => void): () => void {
  if (interactionWatchers.size === 0) {
    lastInteractedAt = Date.now();
    for (const event of INTERACTION_EVENTS) {
      document.addEventListener(event, noteInteraction, { passive: true });
    }
  }
  interactionWatchers.add(resume);
  return () => {
    interactionWatchers.delete(resume);
    if (interactionWatchers.size > 0) return;
    for (const event of INTERACTION_EVENTS) {
      document.removeEventListener(event, noteInteraction);
    }
  };
}

export function useLiveRefresh(
  refresh: (() => void) | null,
  options: {
    readonly enabled?: boolean;
    readonly key?: string;
    /** `null` turns off the periodic refresh, for a read too costly to repeat unasked. */
    readonly intervalMs?: number | null;
    /**
     * Refresh every time the view is enabled unless it read within the floor, skipping the
     * first-read rule: for a view that stays mounted while hidden, so its mount-time read can be
     * long stale when shown.
     */
    readonly refreshOnShow?: boolean;
  } = {},
): void {
  const {
    enabled = true,
    key,
    intervalMs = LIVE_REFRESH_INTERVAL_MS,
    refreshOnShow = false,
  } = options;
  const runRefresh = useEffectEvent((viewId: string, now: number) => {
    if (refresh === null) return;
    lastRefreshedAtByView.set(viewId, now);
    refresh();
  });
  const fallbackViewId = useId();
  const viewId = key ?? fallbackViewId;

  useEffect(() => {
    if (!enabled) return;
    const read = (now: number) => runRefresh(viewId, now);
    const visible = () => document.visibilityState === "visible";
    const onArrival = () => {
      const now = Date.now();
      if (now - lastInteractedAt >= LIVE_REFRESH_IDLE_AFTER_MS) return;
      const lastRefreshedAt = lastRefreshedAtByView.get(viewId);
      if (lastRefreshedAt === undefined) {
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
    const syncTimer = () => {
      clearInterval(timer);
      timer = visible() && intervalMs !== null ? setInterval(onInterval, intervalMs) : undefined;
    };
    const onVisibilityChange = () => {
      onArrival();
      syncTimer();
    };

    const stopWatchingInteraction = watchInteraction(() => {
      onArrival();
      syncTimer();
    });
    if (refreshOnShow) {
      const now = Date.now();
      const lastRefreshedAt = lastRefreshedAtByView.get(viewId);
      if (lastRefreshedAt === undefined || now - lastRefreshedAt >= LIVE_REFRESH_MIN_INTERVAL_MS) {
        read(now);
      }
    } else onArrival();
    syncTimer();
    window.addEventListener("focus", onArrival);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onArrival);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopWatchingInteraction();
    };
  }, [enabled, viewId, intervalMs, refreshOnShow]);
}
