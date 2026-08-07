import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;
const EMPTY_BOOTSTRAPS: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

let bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap> = EMPTY_BOOTSTRAPS;
let pollId: number | null = null;
const listeners = new Set<() => void>();

function sameBootstrap(
  left: DesktopEnvironmentBootstrap,
  right: DesktopEnvironmentBootstrap,
): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.runningDistro === right.runningDistro &&
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl &&
    left.bootstrapToken === right.bootstrapToken
  );
}

function sameBootstraps(
  left: ReadonlyArray<DesktopEnvironmentBootstrap>,
  right: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => sameBootstrap(entry, right[index]!))
  );
}

function read(): void {
  const next = readDesktopSecondaryBootstraps();
  if (sameBootstraps(bootstraps, next)) {
    return;
  }
  bootstraps = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    read();
    pollId = window.setInterval(read, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollId !== null) {
      window.clearInterval(pollId);
      pollId = null;
    }
  };
}

function getSnapshot(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  if (pollId === null && typeof window !== "undefined") {
    read();
  }
  return bootstraps;
}

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). The bridge exposes no change event, so we re-read on an interval;
 * failed reads retain the latest successful snapshot, while a successful empty
 * read clears it. Use this instead of polling the bridge ad hoc so every
 * renderer consumer reads the same topology.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_BOOTSTRAPS);
}
