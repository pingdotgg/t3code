import { useSyncExternalStore } from "react";

/** Minute-quantized clock ("YYYY-MM-DDTHH:MM") for settled-state resolution.
    One module-level timer feeds every consumer through useSyncExternalStore,
    so all surfaces resolving effectiveSettled against it (sidebar partition,
    composer banner) share a single value by construction and tick on UTC
    minute boundaries together. */

function currentMinute(): string {
  return new Date().toISOString().slice(0, 16);
}

let nowMinute = currentMinute();
let timerId: number | null = null;
let timerIsInterval = false;
const listeners = new Set<() => void>();

function tick(): void {
  const next = currentMinute();
  if (next !== nowMinute) {
    nowMinute = next;
    for (const listener of listeners) listener();
  }
}

function startTimer(): void {
  // Align to the next UTC minute boundary, then tick every 60s. Ticks re-read
  // the clock, so a throttled or late timer self-corrects when it fires.
  timerIsInterval = false;
  timerId = window.setTimeout(
    () => {
      tick();
      timerIsInterval = true;
      timerId = window.setInterval(tick, 60_000);
    },
    60_000 - (Date.now() % 60_000),
  );
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    startTimer();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timerId !== null) {
      if (timerIsInterval) window.clearInterval(timerId);
      else window.clearTimeout(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): string {
  // With no timer running (no subscribers yet — e.g. the first render after
  // a full unmount), the stored minute may be stale; re-read it so a fresh
  // mount renders the current minute instead of waiting for the first tick.
  // While the timer runs the cached value is returned untouched, as
  // useSyncExternalStore requires between change notifications.
  if (timerId === null) {
    nowMinute = currentMinute();
  }
  return nowMinute;
}

export function useNowMinute(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
