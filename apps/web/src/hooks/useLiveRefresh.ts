import { useEffect, useEffectEvent, useId } from "react";

export const LIVE_REFRESH_MIN_INTERVAL_MS = 10_000;

export const LIVE_REFRESH_INTERVAL_MS = 5 * 60_000;

export const LIVE_REFRESH_IDLE_AFTER_MS = 6 * 60_000;

export function shouldLiveRefresh(input: {
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
 * at zero would call that first read due.
 */
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
    readonly intervalMs?: number;
  } = {},
): void {
  const { enabled = true, key, intervalMs = LIVE_REFRESH_INTERVAL_MS } = options;
  // An effect event so a caller can pass a fresh closure every render without re-arming the
  // listeners, which would otherwise refresh on every render that changed anything at all.
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
      timer = visible() ? setInterval(onInterval, intervalMs) : undefined;
    };
    const onVisibilityChange = () => {
      onArrival();
      syncTimer();
    };

    const stopWatchingInteraction = watchInteraction(() => {
      onArrival();
      syncTimer();
    });
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
  }, [enabled, viewId, intervalMs]);
}
