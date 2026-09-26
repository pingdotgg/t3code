import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readDesktopLocalTopology, type DesktopLocalTopology } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

/**
 * One renderer-wide poller for the desktop's local backend list. The bridge
 * exposes no change event, so we re-read on an interval while anyone is
 * subscribed, and publish a new snapshot only when the topology actually
 * changed so idle polls do not rerender every consumer (there is one per
 * open-in-editor affordance, including each rendered markdown message).
 */
function topologyKey(topology: DesktopLocalTopology): string {
  return JSON.stringify([
    topology.primaryWslDistro,
    topology.secondaries.map((entry) => [entry.id, entry.runningDistro, entry.httpBaseUrl]),
  ]);
}

const EMPTY_TOPOLOGY: DesktopLocalTopology = { secondaries: [], primaryWslDistro: null };
let snapshot: DesktopLocalTopology = EMPTY_TOPOLOGY;
let snapshotKey = topologyKey(snapshot);
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;

/** Re-read the bridge; returns true when the published snapshot changed. */
function poll(): boolean {
  const next = readDesktopLocalTopology();
  const nextKey = topologyKey(next);
  if (nextKey === snapshotKey) return false;
  snapshot = next;
  snapshotKey = nextKey;
  return true;
}

function pollAndNotify(): void {
  if (!poll()) return;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (interval === null) {
    pollAndNotify();
    interval = setInterval(pollAndNotify, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

// The first render of the first subscriber happens before subscribe runs, so
// read synchronously when the poller is idle to avoid a one-frame empty state.
const getSecondaries = () => {
  if (interval === null) poll();
  return snapshot.secondaries;
};
const getPrimaryWslDistro = () => {
  if (interval === null) poll();
  return snapshot.primaryWslDistro;
};

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). Failed reads retain the latest successful snapshot, while a
 * successful empty read clears it.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useSyncExternalStore(subscribe, getSecondaries, getSecondaries);
}

/** Reactively track the primary backend's WSL distro (wsl-only mode). */
export function useDesktopPrimaryWslDistro(): string | null {
  return useSyncExternalStore(subscribe, getPrimaryWslDistro, getPrimaryWslDistro);
}
