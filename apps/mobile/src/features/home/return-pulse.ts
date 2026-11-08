import { useSyncExternalStore } from "react";

/**
 * Coming back from a thread to the list scrolls that thread's row into view and
 * pulses its background once, so it is easy to spot where you were. Undoing a
 * settle made from the thread screen reveals the restored row the same way.
 */

/** One brighter/darker cycle: rise, then fall back to the row's own colour. */
export const RETURN_PULSE_RISE_MS = 600;
export const RETURN_PULSE_FALL_MS = 900;
/** The back transition has to finish before the list moves. */
export const RETURN_PULSE_TRANSITION_MS = 350;
/** A reveal whose row never shows up (filtered out, archived) is dropped. */
const REVEAL_EXPIRY_MS = 4_000;
/** Pulse key for the folded Settled shelf header, standing in for a thread inside it. */
export const SETTLED_SHELF_PULSE_KEY = "shelf:settled";

export type PendingReveal = {
  readonly threadKey: string;
  /** Don't move the list before this time (the back transition is still running). */
  readonly notBefore: number;
  readonly expiresAt: number;
  /** The thread may have just been settled into the folded shelf: pulse the shelf header if it's on screen. */
  readonly settledShelfFallback: boolean;
};

let lastViewedThreadKey: string | null = null;
let pendingReveal: PendingReveal | null = null;
let pulse: { readonly key: string; readonly token: number } | null = null;
let nextToken = 1;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
const pulseListeners = new Set<() => void>();
const revealListeners = new Set<() => void>();

function notify(listeners: Set<() => void>) {
  for (const listener of listeners) listener();
}

/** The thread screen in front of the list records which thread it shows. */
export function recordThreadViewed(threadKey: string): void {
  lastViewedThreadKey = threadKey;
}

/** The list just came back into view: reveal the thread it is returning from, once. */
export function revealReturnTarget(now = Date.now()): void {
  const threadKey = lastViewedThreadKey;
  lastViewedThreadKey = null;
  if (threadKey === null) return;
  pendingReveal = {
    threadKey,
    notBefore: now + RETURN_PULSE_TRANSITION_MS,
    expiresAt: now + RETURN_PULSE_TRANSITION_MS + REVEAL_EXPIRY_MS,
    settledShelfFallback: true,
  };
  notify(revealListeners);
}

/** Reveal a row as soon as it appears in the list, such as after Undo restores it. */
export function requestThreadReveal(threadKey: string, now = Date.now()): void {
  pendingReveal = {
    threadKey,
    notBefore: now,
    expiresAt: now + REVEAL_EXPIRY_MS,
    settledShelfFallback: false,
  };
  notify(revealListeners);
}

export function clearPendingReveal(reveal: PendingReveal): void {
  if (pendingReveal !== reveal) return;
  pendingReveal = null;
  notify(revealListeners);
}

export function usePendingReveal(): PendingReveal | null {
  return useSyncExternalStore(
    (listener) => {
      revealListeners.add(listener);
      return () => {
        revealListeners.delete(listener);
      };
    },
    () => pendingReveal,
  );
}

export function startReturnPulse(key: string): void {
  pulse = { key, token: nextToken++ };
  clearTimeout(clearTimer);
  // Unmount the overlay after the cycle (plus slack for a slow frame).
  clearTimer = setTimeout(
    () => {
      pulse = null;
      notify(pulseListeners);
    },
    RETURN_PULSE_RISE_MS + RETURN_PULSE_FALL_MS + 500,
  );
  notify(pulseListeners);
}

/** A token that changes each time this row should pulse, or null. */
export function useReturnPulseToken(key: string): number | null {
  return useSyncExternalStore(
    (listener) => {
      pulseListeners.add(listener);
      return () => {
        pulseListeners.delete(listener);
      };
    },
    () => (pulse !== null && pulse.key === key ? pulse.token : null),
  );
}

export function readPendingRevealForTests(): PendingReveal | null {
  return pendingReveal;
}

export function resetReturnPulseForTests(): void {
  lastViewedThreadKey = null;
  pendingReveal = null;
  pulse = null;
  clearTimeout(clearTimer);
}
