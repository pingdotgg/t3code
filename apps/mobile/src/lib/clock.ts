import { deadlineStore, minuteTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

/** Re-renders once when `deadlineMs` (epoch ms) is reached; `null` never passes. */
export function useDeadlinePassed(deadlineMs: number | null): boolean {
  const store = deadlineStore(deadlineMs);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
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
