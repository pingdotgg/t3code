// @effect-diagnostics globalTimers:off globalDate:off - Render clocks for React hooks, outside an Effect runtime.

/**
 * A `useSyncExternalStore`-shaped clock. Snapshots stay cached between
 * notifications while subscribed, as `useSyncExternalStore` requires.
 */
export interface ClockStore<A> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => A;
}

// setTimeout fires immediately for delays beyond a signed 32-bit int.
const MAX_TIMEOUT_MS = 2_147_483_647;

function makeTickStore<A>(read: () => A, periodMs: number): ClockStore<A> {
  let value = read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  // Each tick lands on a wall-clock boundary so every subscriber updates in
  // the same frame instead of each drifting on its own phase.
  const schedule = () => {
    timer = setTimeout(
      () => {
        timer = undefined;
        const next = read();
        if (next !== value) {
          value = next;
          for (const listener of listeners) listener();
        }
        // Listeners may unsubscribe (stopping the clock) or resubscribe (arming
        // a fresh timer) while notified; only continue a clock nobody re-armed.
        if (listeners.size > 0 && timer === undefined) schedule();
      },
      periodMs - (Date.now() % periodMs),
    );
  };

  return {
    subscribe: (listener) => {
      if (listeners.size === 0) {
        value = read();
        schedule();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => {
      if (timer === undefined) value = read();
      return value;
    },
  };
}

/** Epoch ms floored to the second, advancing on each wall-clock second. */
export const secondTick: ClockStore<number> = makeTickStore(
  () => Math.floor(Date.now() / 1000) * 1000,
  1000,
);

/** ISO timestamp truncated to the minute (`YYYY-MM-DDTHH:mm`). */
export const minuteTick: ClockStore<string> = makeTickStore(
  () => new Date().toISOString().slice(0, 16),
  60_000,
);

export interface DeadlineStore extends ClockStore<boolean> {
  /**
   * Re-checks `Date.now()` and notifies if the deadline has passed. For callers
   * that observe the deadline first, e.g. a click after a throttled or slept
   * timer, so the snapshot catches up without waiting for the late timer.
   */
  readonly refresh: () => void;
}

const neverPassed: DeadlineStore = {
  subscribe: () => () => {},
  getSnapshot: () => false,
  refresh: () => {},
};

interface DeadlineEntry {
  readonly store: DeadlineStore;
  readonly listeners: Set<() => void>;
  passed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// The single owner of each subscribed deadline. Handles obtained before the
// entry exists join it on subscribe, so they share its timer and notifications.
const deadlines = new Map<number, DeadlineEntry>();

function passDeadline(entry: DeadlineEntry) {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.passed = true;
  for (const listener of entry.listeners) listener();
}

function armDeadline(entry: DeadlineEntry, deadlineMs: number) {
  const delay = deadlineMs - Date.now();
  if (delay <= 0) {
    passDeadline(entry);
    return;
  }
  entry.timer = setTimeout(() => armDeadline(entry, deadlineMs), Math.min(delay, MAX_TIMEOUT_MS));
}

/**
 * Whether `Date.now()` has reached `deadlineMs`. One timer per distinct
 * deadline, shared by its subscribers; once passed the snapshot stays true.
 * Deadlines register only while subscribed, so renders React discards leak nothing.
 * A non-finite deadline never passes.
 */
export function deadlineStore(deadlineMs: number | null): DeadlineStore {
  if (deadlineMs === null || !Number.isFinite(deadlineMs)) return neverPassed;
  const existing = deadlines.get(deadlineMs);
  if (existing !== undefined) return existing.store;

  const store: DeadlineStore = {
    subscribe: (listener) => {
      let entry = deadlines.get(deadlineMs);
      if (entry === undefined) {
        entry = { store, listeners: new Set(), passed: Date.now() >= deadlineMs, timer: undefined };
        deadlines.set(deadlineMs, entry);
        if (!entry.passed) armDeadline(entry, deadlineMs);
      }
      const joined = entry;
      joined.listeners.add(listener);
      return () => {
        joined.listeners.delete(listener);
        if (joined.listeners.size > 0) return;
        clearTimeout(joined.timer);
        joined.timer = undefined;
        if (deadlines.get(deadlineMs) === joined) deadlines.delete(deadlineMs);
      };
    },
    getSnapshot: () => deadlines.get(deadlineMs)?.passed ?? Date.now() >= deadlineMs,
    refresh: () => {
      const entry = deadlines.get(deadlineMs);
      if (entry !== undefined && !entry.passed && Date.now() >= deadlineMs) passDeadline(entry);
    },
  };
  return store;
}
