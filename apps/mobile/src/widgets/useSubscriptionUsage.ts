import { refreshEnvironmentLimits } from "../features/usage/usageLimitsRefresh";

import { environmentCatalog } from "../connection/catalog";
import { isAppActive, subscribeAppState } from "../lib/appState";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentPresentations } from "../state/presentation";

/**
 * App-lifetime worker that keeps provider quotas fresh for the usage widget:
 * on resume and connection changes; periodic reads belong to visible usage UI.
 */
export function installSubscriptionUsageRefresh(): () => void {
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
    void Promise.allSettled(
      connected.map((environmentId) =>
        refreshEnvironmentLimits(appAtomRegistry, environmentId, { automatic: true }),
      ),
    );
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
