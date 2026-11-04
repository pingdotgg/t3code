import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { isAppActive, subscribeAppState } from "../lib/appState";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { createWidgetRefresher } from "./subscriptionUsageSnapshot";

/**
 * App-lifetime worker that keeps provider quotas fresh for the usage widget:
 * on resume and connection changes; periodic reads belong to visible usage UI.
 * Each environment is refreshed at most once per interval.
 */
export function installSubscriptionUsageRefresh(): () => void {
  const refresh = createWidgetRefresher((environmentId: EnvironmentId) =>
    runAtomCommand(
      appAtomRegistry,
      serverEnvironment.refreshProviders,
      { environmentId, input: { usage: true } },
      { label: serverEnvironment.refreshProviders.label, reportFailure: false },
    ),
  );
  let lastConnections = "";
  const update = () => {
    if (!isAppActive()) {
      lastConnections = "";
      return;
    }
    if (!appAtomRegistry.get(environmentCatalog.catalogValueAtom).isReady) return;
    const connected = [...appAtomRegistry.get(environmentPresentations.presentationsAtom)]
      .filter(([, presentation]) => presentation.connection.phase === "connected")
      .map(([id]) => id);
    const key = [...connected].sort().join(",");
    if (key === lastConnections) return;
    lastConnections = key;
    void refresh(connected, Date.now());
  };

  const unsubscribeCatalog = appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, update);
  const unsubscribePresentations = appAtomRegistry.subscribe(
    environmentPresentations.presentationsAtom,
    update,
    { immediate: true },
  );
  const unsubscribeAppState = subscribeAppState(update);
  return () => {
    unsubscribeCatalog();
    unsubscribePresentations();
    unsubscribeAppState();
  };
}
