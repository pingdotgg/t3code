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
