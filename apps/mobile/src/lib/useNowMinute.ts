import { useSyncExternalStore } from "react";

/** Minute-quantized UI clock in epoch ms. One module-level timer feeds every
    consumer through useSyncExternalStore. */

function currentMinuteMs(): number {
  const now = new Date();
  now.setSeconds(0, 0);
  return now.getTime();
}

let nowMs = currentMinuteMs();
let timerId: ReturnType<typeof setTimeout> | null = null;
let timerIsInterval = false;
const listeners = new Set<() => void>();

function tick(): void {
  const next = currentMinuteMs();
  if (next !== nowMs) {
    nowMs = next;
    for (const listener of listeners) listener();
  }
}

function startTimer(): void {
  // Align to the next minute boundary, then tick every 60s. Ticks re-read the
  // clock, so a throttled or late timer self-corrects when it fires.
  timerIsInterval = false;
  timerId = setTimeout(
    () => {
      tick();
      timerIsInterval = true;
      timerId = setInterval(tick, 60_000);
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
      if (timerIsInterval) clearInterval(timerId);
      else clearTimeout(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): number {
  // With no timer running (no subscribers yet — e.g. the first render after
  // a full unmount), the stored minute may be stale; re-read it so a fresh
  // mount renders the current minute instead of waiting for the first tick.
  // While the timer runs the cached value is returned untouched, as
  // useSyncExternalStore requires between change notifications.
  if (timerId === null) {
    nowMs = currentMinuteMs();
  }
  return nowMs;
}

export function useNowMinute(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
