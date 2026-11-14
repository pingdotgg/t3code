import { deadlineStore, minuteTick } from "@t3tools/client-runtime/clock";
import { useState, useSyncExternalStore } from "react";

/** Re-renders once when `deadlineMs` (epoch ms) is reached; `null` never passes. */
export function useDeadlinePassed(deadlineMs: number | null): boolean {
  const store = deadlineStore(deadlineMs);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * `Date.now()` captured at mount and re-read when `deadlineMs` changes or
 * passes, so comparisons against the deadline flip exactly once.
 */
export function useNowAfter(deadlineMs: number | null): number {
  const passed = useDeadlinePassed(deadlineMs);
  const readNow = () => ({ deadlineMs, passed, nowMs: Date.now() });
  const [snapshot, setSnapshot] = useState(readNow);
  // The clock is read inside the updater: the compiler caches a bare
  // `Date.now()` in render once per instance, so a later adjustment would reuse
  // the first reading. React discards this render and re-runs with the update.
  if (snapshot.deadlineMs !== deadlineMs || snapshot.passed !== passed) setSnapshot(readNow);
  return snapshot.nowMs;
}

/**
 * `minuteTick`'s UTC `YYYY-MM-DDTHH:mm` as epoch ms. The snapshot carries no
 * offset, and `Date.parse` reads offset-less date-times as local time.
 */
export function minuteTickToEpochMs(minute: string): number {
  return Date.parse(`${minute}:00Z`);
}

/** Epoch ms floored to the minute, advancing each wall-clock minute. */
export function useNowMinuteMs(): number {
  return minuteTickToEpochMs(
    useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot),
  );
}

/**
 * Epoch ms that advances each wall-clock minute and the moment the next wake
 * passes. The next wake is searched after the latest time returned, not the
 * floored minute, so a second wake later in the same minute arms its own timer.
 */
export function useNowWithWakes(nextWakeAfter: (nowMs: number) => number | null): number {
  const minuteMs = useNowMinuteMs();
  const [latestMs, setLatestMs] = useState(minuteMs);
  const afterWakeMs = useNowAfter(nextWakeAfter(Math.max(minuteMs, latestMs)));
  const nowMs = Math.max(minuteMs, afterWakeMs, latestMs);
  if (nowMs !== latestMs) setLatestMs(nowMs);
  return nowMs;
}
