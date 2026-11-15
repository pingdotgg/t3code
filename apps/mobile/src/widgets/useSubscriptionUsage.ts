import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { refreshEnvironmentLimits } from "../features/usage/usageLimitsRefresh";

import { environmentCatalog } from "../connection/catalog";
import { isAppActive, subscribeAppState } from "../lib/appState";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentPresentations } from "../state/presentation";
import { environmentShell } from "../state/shell";

// A shell that failed never goes live, and its environment still needs fresh quotas.
const shellSettledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    return shell.status === "live" || Option.isSome(shell.error);
  }),
);

/**
 * Connected environments whose thread list has loaded. A refresh re-probes every provider on
 * the host, so on a cold start it waits until it cannot compete with the thread list.
 */
const refreshableEnvironmentsAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" && get(shellSettledAtom(environmentId)),
    )
    .map(([environmentId]) => environmentId),
);

// Keeps the published reading well inside the widget snapshot's 15-minute expiry.
const WIDGET_REFRESH_INTERVAL = 5 * 60_000;

/**
 * App-lifetime worker that keeps provider quotas fresh for the usage widget:
 * on resume, on connection changes, and on a fixed interval while active.
 */
export function installSubscriptionUsageRefresh(): () => void {
  let lastConnections = "";
  const update = () => {
    if (!isAppActive()) {
      lastConnections = "";
      return;
    }
    if (!appAtomRegistry.get(environmentCatalog.catalogValueAtom).isReady) return;
    const connected = appAtomRegistry.get(refreshableEnvironmentsAtom);
    const key = [...connected].sort().join(",");
    if (key === lastConnections) return;
    lastConnections = key;
    void Promise.allSettled(
      connected.map((environmentId) =>
        refreshEnvironmentLimits(appAtomRegistry, environmentId, { automatic: true }),
      ),
    );
  };

  const unsubscribeCatalog = appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, update);
  const unsubscribeEnvironments = appAtomRegistry.subscribe(refreshableEnvironmentsAtom, update, {
    immediate: true,
  });
  const unsubscribeAppState = subscribeAppState(update);
  const timer = setInterval(() => {
    lastConnections = "";
    update();
  }, WIDGET_REFRESH_INTERVAL);
  return () => {
    unsubscribeCatalog();
    unsubscribeEnvironments();
    unsubscribeAppState();
    clearInterval(timer);
  };
}
