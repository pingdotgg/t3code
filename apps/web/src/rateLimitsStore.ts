import { useSyncExternalStore } from "react";
import { onRateLimitsUpdated, type RateLimitsPayload } from "./wsNativeApi";

let snapshot: RateLimitsPayload | null = null;
let listeners: Array<() => void> = [];

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

let unsubWs: (() => void) | null = null;

function ensureSubscription(): void {
  if (unsubWs) return;
  unsubWs = onRateLimitsUpdated((payload) => {
    snapshot = payload;
    emitChange();
  });
}

function subscribe(listener: () => void): () => void {
  ensureSubscription();
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

function getSnapshot(): RateLimitsPayload | null {
  return snapshot;
}

export function useRateLimits(): RateLimitsPayload | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
