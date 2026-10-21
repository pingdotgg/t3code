import { useSyncExternalStore } from "react";

// Share wall-clock ticks so duration labels repaint in one frame.

function currentSecond(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

let nowSecond = currentSecond();
let timerId: number | null = null;
const listeners = new Set<() => void>();

function scheduleTick(): void {
  timerId = window.setTimeout(
    () => {
      nowSecond = currentSecond();
      for (const listener of listeners) listener();
      scheduleTick();
    },
    1000 - (Date.now() % 1000),
  );
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) scheduleTick();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): number {
  if (timerId === null) nowSecond = currentSecond();
  return nowSecond;
}

export function useNowSecond(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
