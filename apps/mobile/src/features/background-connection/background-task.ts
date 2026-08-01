import { startBackgroundManagedRelayAuth } from "../cloud/backgroundManagedRelayAuth";
import {
  acknowledgeBackgroundConnectionStop,
  addBackgroundConnectionStopRequestListener,
  getBackgroundConnectionStatus,
  setBackgroundConnectionRuntimeReady,
} from "../../native/backgroundConnection";
import { appAtomRegistry } from "../../state/atom-registry";
import { acquireThreadOutboxDrain } from "../../state/use-thread-outbox-drain";
import { acquireBackgroundConnectionRoot } from "./background-root";

let activeTask: Promise<void> | null = null;

function bestEffortCleanup(label: string, cleanup: (() => void) | null): void {
  if (cleanup === null) {
    return;
  }
  try {
    cleanup();
  } catch (error) {
    console.error(`[background-connection] ${label} cleanup failed`, error);
  }
}

async function runTask(): Promise<void> {
  let hasStopBeenRequested = false;
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = () => {
      hasStopBeenRequested = true;
      resolve();
    };
  });
  // Subscribe before acquiring anything so a disable request cannot race the
  // cold React runtime bootstrap and leave the service waiting indefinitely.
  const stopSubscription = addBackgroundConnectionStopRequestListener(requestStop);
  // Native may have stopped the service before this cold JS runtime finished
  // loading and installed its listener. Treat the persisted disabled state as
  // the same stop request so that a late task cannot leak its leases.
  if (!getBackgroundConnectionStatus().enabled) {
    requestStop();
  }
  let relayAuth: ReturnType<typeof startBackgroundManagedRelayAuth> | null = null;
  let releaseRoot: (() => void) | null = null;
  let releaseOutbox: (() => void) | null = null;

  try {
    if (hasStopBeenRequested) {
      return;
    }
    relayAuth = startBackgroundManagedRelayAuth();
    releaseRoot = acquireBackgroundConnectionRoot(appAtomRegistry);
    releaseOutbox = acquireThreadOutboxDrain(appAtomRegistry);
    // Relay authentication owns its own retry loop. Direct/Tailscale
    // connections and the shared outbox are fully operational once these
    // leases are mounted, even if Clerk is slow or temporarily unavailable.
    setBackgroundConnectionRuntimeReady(true);
    await stopRequested;
  } catch (error) {
    console.error("[background-connection] headless runtime failed", error);
    // Normal completion lets native release React Native's wake lock and use
    // its bounded exponential restart ladder for bootstrap defects.
  } finally {
    bestEffortCleanup("outbox", releaseOutbox);
    bestEffortCleanup("root", releaseRoot);
    bestEffortCleanup("relay authentication", () => relayAuth?.stop());
    bestEffortCleanup("stop listener", () => stopSubscription.remove());
    setBackgroundConnectionRuntimeReady(false);
    acknowledgeBackgroundConnectionStop();
  }
}

/** Native guards task creation too; this JS guard protects hot reloads and races. */
export function runBackgroundConnectionHeadlessTask(): Promise<void> {
  if (activeTask !== null) {
    return activeTask;
  }
  const task = runTask().finally(() => {
    if (activeTask === task) {
      activeTask = null;
    }
  });
  activeTask = task;
  return task;
}
