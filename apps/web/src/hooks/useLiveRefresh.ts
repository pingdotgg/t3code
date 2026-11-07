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
const pendingRefreshesByView = new Map<string, Promise<unknown>>();
const overdueRefreshesByView = new Set<string>();

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
  refresh: (() => void | Promise<unknown>) | null,
  options: {
    readonly enabled?: boolean;
    readonly key?: string;
    /** Shared deadlines for resources read by this view. */
    readonly refreshKeys?: readonly string[];
    readonly refreshDeadline?: (result: unknown) => number | undefined;
    /** `null` turns off the periodic refresh, for a read too costly to repeat unasked. */
    readonly intervalMs?: number | null;
    /**
     * Refresh on showing a view with stale data. Views that refresh while idle reuse their
     * polling interval; other views use the minimum refresh floor.
     */
    readonly refreshOnShow?: boolean;
    readonly refreshWhileIdle?: boolean;
  } = {},
): void {
  const {
    enabled = true,
    key,
    refreshKeys,
    intervalMs = LIVE_REFRESH_INTERVAL_MS,
    refreshOnShow = false,
    refreshWhileIdle = false,
  } = options;
  const sharedKeys =
    refreshWhileIdle && refreshKeys?.length ? JSON.stringify([...refreshKeys].sort()) : undefined;
  const runRefresh = useEffectEvent((viewId: string, now: number) => {
    if (refresh === null) return;
    if (sharedKeys === undefined) lastRefreshedAtByView.set(viewId, now);
    return refresh();
  });
  const serverDeadline = useEffectEvent((result: unknown) => options.refreshDeadline?.(result));
  const fallbackViewId = useId();
  const viewId = key ?? fallbackViewId;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh interval tied to page visibility and user interaction listeners
  useEffect(() => {
    if (!enabled) return;
    const resourceKeys = sharedKeys === undefined ? [viewId] : (JSON.parse(sharedKeys) as string[]);
    const requestKey = sharedKeys === undefined ? viewId : `resources:${sharedKeys}`;
    const lastRefresh = () => {
      const last = Math.min(
        ...resourceKeys.map((key) => lastRefreshedAtByView.get(key) ?? -Infinity),
      );
      return Number.isFinite(last) ? last : undefined;
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
    let pending = false;
    const refreshFloorMs =
      refreshWhileIdle && intervalMs !== null
        ? Math.max(LIVE_REFRESH_MIN_INTERVAL_MS, intervalMs)
        : LIVE_REFRESH_MIN_INTERVAL_MS;
    const read = (now: number) => {
      if (refreshWhileIdle && pending) return;
      if (!refreshWhileIdle) {
        runRefresh(viewId, now);
        return;
      }
      let result = pendingRefreshesByView.get(requestKey);
      if (result === undefined) {
        const refreshedKeys = resourceKeys.filter(
          (key) => now - (lastRefreshedAtByView.get(key) ?? -Infinity) >= refreshFloorMs,
        );
        for (const key of refreshedKeys) lastRefreshedAtByView.set(key, now);
        let deadline: number | undefined;
        result = Promise.resolve(runRefresh(viewId, now))
          .then((value) => {
            deadline = serverDeadline(value);
            return value;
          })
          .finally(() => {
            pendingRefreshesByView.delete(requestKey);
            const completedAt = Date.now();
            const overdue = deadline !== undefined && deadline <= completedAt;
            if (overdue && overdueRefreshesByView.has(requestKey)) {
              deadline = completedAt + LIVE_REFRESH_MIN_INTERVAL_MS;
            }
            if (overdue) overdueRefreshesByView.add(requestKey);
            else overdueRefreshesByView.delete(requestKey);
            const observedAt =
              deadline !== undefined
                ? Math.min(completedAt, deadline - refreshFloorMs)
                : completedAt;
            for (const key of refreshedKeys) lastRefreshedAtByView.set(key, observedAt);
          });
        pendingRefreshesByView.set(requestKey, result);
      }
      pending = true;
      clearInterval(timer);
      const completed = () => {
        pending = false;
        if (disposed) return;
        syncTimer();
      };
      void Promise.resolve(result).then(completed, completed);
    };
    const visible = () => document.visibilityState === "visible";
    const onArrival = () => {
      const now = Date.now();
      if (!refreshWhileIdle && now - lastInteractedAt >= LIVE_REFRESH_IDLE_AFTER_MS) return;
      if (refreshWhileIdle && visible() && pendingRefreshesByView.has(requestKey)) {
        read(now);
        return;
      }
      const lastRefreshedAt = lastRefresh();
      if (lastRefreshedAt === undefined) {
        if (!refreshOnShow) {
          for (const key of resourceKeys) {
            if (!lastRefreshedAtByView.has(key)) lastRefreshedAtByView.set(key, now);
          }
        } else if (visible()) read(now);
        return;
      }
      if (refreshWhileIdle && now - lastRefreshedAt < refreshFloorMs) return;
      if (shouldRefreshOnArrival({ visible: visible(), now, lastRefreshedAt })) read(now);
    };
    const onInterval = () => {
      const now = Date.now();
      const lastRefreshedAt = lastRefresh() ?? now;
      if (
        (!refreshWhileIdle || now - lastRefreshedAt >= refreshFloorMs) &&
        shouldRefreshOnInterval({
          visible: visible(),
          now,
          lastRefreshedAt,
          lastInteractedAt: refreshWhileIdle ? now : lastInteractedAt,
        })
      ) {
        read(now);
      } else if (refreshWhileIdle) syncTimer();
    };

    const syncTimer = () => {
      clearInterval(timer);
      timer =
        visible() && intervalMs !== null && !pending
          ? refreshWhileIdle
            ? setTimeout(
                onInterval,
                Math.max(0, refreshFloorMs - (Date.now() - (lastRefresh() ?? Date.now()))),
              )
            : setInterval(onInterval, intervalMs)
          : undefined;
    };
    const onVisibilityChange = () => {
      onArrival();
      syncTimer();
    };

    const stopWatchingInteraction = watchInteraction(() => {
      onArrival();
      syncTimer();
    });
    if (refreshOnShow && visible()) {
      const now = Date.now();
      const lastRefreshedAt = lastRefresh();
      if (
        (refreshWhileIdle && pendingRefreshesByView.has(requestKey)) ||
        lastRefreshedAt === undefined ||
        now - lastRefreshedAt >= refreshFloorMs
      ) {
        read(now);
      }
    } else onArrival();
    syncTimer();
    window.addEventListener("focus", onArrival);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", onArrival);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopWatchingInteraction();
    };
  }, [enabled, viewId, sharedKeys, intervalMs, refreshOnShow, refreshWhileIdle]);
}
