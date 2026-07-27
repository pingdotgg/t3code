import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useSyncExternalStore } from "react";

import {
  getEnvironmentHttpBaseUrl,
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
