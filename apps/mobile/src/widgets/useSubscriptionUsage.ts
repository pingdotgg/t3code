import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { isAppActive, subscribeAppState } from "../lib/appState";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import { createWidgetRefresher, WIDGET_REFRESH_INTERVAL } from "./subscriptionUsageSnapshot";

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

/**
 * Keeps provider quotas fresh for the usage widget whenever an environment becomes refreshable
 * and on an interval while active. Resume itself never refreshes: the shell reads a stale "live"
 * until its wakeup resync, so refreshing then would compete with the reload.
 * Each environment is refreshed at most once per interval.
 */
export function installSubscriptionUsageRefresh(): () => void {
  const refresh = createWidgetRefresher((environmentId: EnvironmentId) =>
    runAtomCommand(
      appAtomRegistry,
      serverEnvironment.refreshProviders,
      { environmentId, input: {} },
      { label: serverEnvironment.refreshProviders.label, reportFailure: false },
    ),
  );
  const update = () => {
    if (!isAppActive() || !appAtomRegistry.get(environmentCatalog.catalogValueAtom).isReady) return;
    void refresh(appAtomRegistry.get(refreshableEnvironmentsAtom), Date.now());
  };

  const unsubscribeCatalog = appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, update);
  const unsubscribeEnvironments = appAtomRegistry.subscribe(refreshableEnvironmentsAtom, update, {
    immediate: true,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  // Restarted on resume: a tick that came due while suspended would otherwise fire before the resync.
  const restartInterval = () => {
    clearInterval(timer);
    timer = isAppActive() ? setInterval(update, WIDGET_REFRESH_INTERVAL) : undefined;
  };
  restartInterval();
  const unsubscribeAppState = subscribeAppState(restartInterval);
  return () => {
    unsubscribeCatalog();
    unsubscribeEnvironments();
    unsubscribeAppState();
    clearInterval(timer);
  };
}
