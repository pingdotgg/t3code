import { isAppActive, subscribeAppState } from "../../lib/appState";
import {
  EnvironmentId,
  type ProviderInstanceId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits, usageLimitsRefreshDelay } from "@t3tools/client-runtime/state/usage";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

/**
 * Whether the last finished limits refresh for an environment failed. Not kept
 * alive: the limits view mounts it, and leaving the view forgets old failures.
 */
const limitsRefreshFailedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(false).pipe(Atom.withLabel(`mobile:limits-refresh-failed:${environmentId}`)),
);

export function instanceLimitsRefreshSelection(
  instanceId: ProviderInstanceId,
  driver?: ProviderDriverKind,
) {
  return {
    key: JSON.stringify([instanceId, driver]),
    resources: [
      ...(driver ? [JSON.stringify(["provider", driver])] : []),
      JSON.stringify(["instance", instanceId, driver]),
    ],
  };
}

function environmentLimitsRefreshKeys(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const config = registry.get(serverEnvironment.configValueAtom(environmentId));
  const keys = (config?.providers ?? []).flatMap(
    (provider) => instanceLimitsRefreshSelection(provider.instanceId, provider.driver).resources,
  );
  for (const source of config?.usageLimitSources ?? []) {
    keys.push(
      JSON.stringify(["source", source.id]),
      ...source.accounts.map((account) => JSON.stringify(["provider", account.driver])),
    );
  }
  return keys.length ? [...new Set(keys)] : [""];
}

export async function refreshEnvironmentLimits(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  options: { readonly automatic?: boolean; readonly afterPending?: boolean } = {},
): Promise<void> {
  if (!isAppActive()) return;
  // One refresh runs per environment at a time, so results land in the order
  // they were started and the newest outcome always wins.
  const result = await refreshUsageLimits(
    environmentId,
    () =>
      runAtomCommand(
        registry,
        serverEnvironment.refreshProviders,
        { environmentId, input: { usage: true } },
        { reportFailure: false },
      ),
    options.automatic,
    options.afterPending,
    { key: "", resources: environmentLimitsRefreshKeys(registry, environmentId) },
  );
  if (result === undefined) return;
  registry.set(limitsRefreshFailedAtom(environmentId), result._tag === "Failure");
}

// Mounting starts an automatic refresh, which refreshUsageLimits throttles to
// one every few minutes per environment.
const limitsAutoRefreshAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!isAppActive() || pending || disposed) return;
      pending = true;
      clearTimeout(timer);
      try {
        await refreshEnvironmentLimits(get.registry, environmentId, { automatic: true });
      } finally {
        pending = false;
        if (!disposed)
          timer = setTimeout(
            () => {
              void refresh();
            },
            usageLimitsRefreshDelay(
              environmentId,
              environmentLimitsRefreshKeys(get.registry, environmentId),
            ),
          );
      }
    };
    void refresh();
    const unsubscribe = subscribeAppState(() => {
      void refresh();
    });
    get.addFinalizer(() => {
      disposed = true;
      unsubscribe();
      clearTimeout(timer);
    });
  }).pipe(Atom.withLabel(`mobile:limits-auto-refresh:${environmentId}`)),
);

export function environmentIdsKey(environmentIds: Iterable<EnvironmentId>): string {
  return [...environmentIds].sort().join(",");
}

function splitEnvironmentIds(key: string): EnvironmentId[] {
  return key === "" ? [] : key.split(",").map((id) => EnvironmentId.make(id));
}

/** Keyed by a sorted, comma-joined id list so equal selections share one atom. */
export const limitsAutoRefreshSetAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) => {
    for (const environmentId of splitEnvironmentIds(environmentIds)) {
      get(limitsAutoRefreshAtom(environmentId));
    }
  }),
);

export const limitsRefreshFailuresAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    splitEnvironmentIds(environmentIds).filter((environmentId) =>
      get(limitsRefreshFailedAtom(environmentId)),
    ),
  ),
);
