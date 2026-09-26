import type { NetworkStateType } from "expo-network";

/** The string value of a `NetworkStateType`, so the rule below is enum-free. */
export type NetworkPath = `${NetworkStateType}`;

export interface ObservedNetworkPath {
  readonly path: NetworkPath | null;
  readonly changed: boolean;
}

/**
 * Decides whether a network state event is a real interface handoff, given the
 * last known interface. Pass `undefined` for a disconnected or indeterminate
 * state.
 */
export function observeNetworkPath(
  previous: NetworkPath | null,
  next: NetworkPath | undefined,
): ObservedNetworkPath {
  if (next === undefined || next === "UNKNOWN") {
    return { path: null, changed: false };
  }
  // With no baseline there is nothing to hand off from: either this is the
  // first event of the process, or connectivity just returned and the
  // supervisor is already reconnecting on this interface.
  if (previous === null) {
    return { path: next, changed: false };
  }
  return { path: next, changed: next !== previous };
}

/**
 * Tracks the default interface across network and app-state events, applying
 * the two rules the raw listener cannot: seed a baseline it never reports, and
 * hold a handoff that lands while the app is inactive.
 */
export function makeNetworkPathTracker() {
  let path: NetworkPath | null = null;
  let observed = false;
  let pending = false;
  return {
    /** Adopts an initial state read, unless a listener event already beat it. */
    seed: (next: NetworkPath | undefined) => {
      if (!observed) {
        path = observeNetworkPath(null, next).path;
      }
    },
    /** Returns whether this event is a handoff worth waking the supervisor for. */
    observe: (next: NetworkPath | undefined, active: boolean) => {
      observed = true;
      const result = observeNetworkPath(path, next);
      path = result.path;
      if (!result.changed) {
        return false;
      }
      // Foregrounding alone only probes, and the old interface can still answer
      // that probe, so a handoff has to survive the background period.
      pending = !active;
      return active;
    },
    /** Returns whether a handoff arrived while the app was inactive. */
    activate: () => {
      const held = pending;
      pending = false;
      return held;
    },
  };
}
