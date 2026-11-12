import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { isAppActive, subscribeAppState } from "../lib/appState";
import { appAtomRegistry } from "../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import { createWidgetRefresher, WIDGET_REFRESH_INTERVAL } from "./subscriptionUsageSnapshot";

// A quota refresh probes every provider on the host. Waiting for the shell sync keeps a
// resume's probes from slowing the reconnect they would otherwise compete with.
const syncedEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = get(environmentCatalog.catalogValueAtom).isReady
    ? get(connectedEnvironmentIdsAtom).filter(
        (id) => get(environmentShell.statusAtom(id)) === "live",
      )
    : [];
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((id, index) => id === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("mobile:usage-widget-synced-environment-ids"));

/**
 * App-lifetime worker that keeps provider quotas fresh for the usage widget:
 * once a resumed or new connection has synced its shell, and on a fixed interval while active.
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
    if (!isAppActive()) return;
    void refresh(appAtomRegistry.get(syncedEnvironmentIdsAtom), Date.now());
  };

  const unsubscribeSynced = appAtomRegistry.subscribe(syncedEnvironmentIdsAtom, update, {
    immediate: true,
  });
  const unsubscribeAppState = subscribeAppState(update);
  const timer = setInterval(update, WIDGET_REFRESH_INTERVAL);
  return () => {
    unsubscribeSynced();
    unsubscribeAppState();
    clearInterval(timer);
  };
}
