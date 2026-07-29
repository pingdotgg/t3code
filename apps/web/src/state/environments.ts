import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  getEnvironmentHttpBaseUrl,
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
} from "~/environments/runtime";
import { getPrimaryKnownEnvironment } from "~/environments/primary";

export interface EnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Fork adapter for the browser slice. The preview components only need the
 * connected environment identities plus their HTTP base URLs; the fork keeps
 * those in the primary-environment descriptor and the saved catalog store.
 */
export function useEnvironments(): { readonly environments: readonly EnvironmentPresentation[] } {
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const primary = usePrimaryEnvironment();

  const environments = useMemo(() => {
    const byId = new Map<EnvironmentId, EnvironmentPresentation>();
    if (primary) byId.set(primary.environmentId, primary);
    for (const record of Object.values(savedById)) {
      byId.set(record.environmentId, {
        environmentId: record.environmentId,
        label: record.label,
      });
    }
    return [...byId.values()];
  }, [primary, savedById]);

  return { environments };
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  const primary = useSyncExternalStore(
    subscribeToPrimaryEnvironment,
    readPrimaryEnvironmentKey,
    readPrimaryEnvironmentKey,
  );
  return useMemo(() => {
    if (primary === null) return null;
    const [environmentId, label] = JSON.parse(primary) as [EnvironmentId, string];
    return { environmentId, label };
  }, [primary]);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environmentId === null
        ? null
        : (environments.find((entry) => entry.environmentId === environmentId) ?? null),
    [environmentId, environments],
  );
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const { environments } = useEnvironments();
  return useMemo(
    // `environments` changes whenever a connection is added or removed, which is
    // exactly when a base URL can start or stop resolving.
    () => (environmentId === null ? null : getEnvironmentHttpBaseUrl(environmentId)),
    [environmentId, environments],
  );
}

/**
 * Identifies the live websocket connection for an environment, or `null` while
 * none is registered. Consumers that build on `readEnvironmentConnection`
 * (which throws when the connection is missing) must not mount before this is
 * non-null, and must remount when it changes so they rebind to the new
 * connection. Returning a number keeps the `useSyncExternalStore` snapshot
 * referentially stable.
 */
export function useEnvironmentConnectionEpoch(environmentId: EnvironmentId): number | null {
  const readEpoch = useCallback(() => environmentConnectionEpoch(environmentId), [environmentId]);
  return useSyncExternalStore(subscribeEnvironmentConnections, readEpoch, readEpoch);
}

let lastConnectionEpoch = 0;
const connectionEpochs = new WeakMap<object, number>();

function environmentConnectionEpoch(environmentId: EnvironmentId): number | null {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) return null;
  const existing = connectionEpochs.get(connection);
  if (existing !== undefined) return existing;
  lastConnectionEpoch += 1;
  connectionEpochs.set(connection, lastConnectionEpoch);
  return lastConnectionEpoch;
}

/**
 * The primary descriptor is bootstrapped once and then stable, so a snapshot
 * key is enough to keep `useSyncExternalStore` referentially stable.
 */
function readPrimaryEnvironmentKey(): string | null {
  const primary = getPrimaryKnownEnvironment();
  return primary ? JSON.stringify([primary.environmentId, primary.label]) : null;
}

function subscribeToPrimaryEnvironment(onStoreChange: () => void): () => void {
  return useSavedEnvironmentRegistryStore.subscribe(onStoreChange);
}
