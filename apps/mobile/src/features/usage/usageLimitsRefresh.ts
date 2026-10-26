import { EnvironmentId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

/**
 * Whether the last finished limits refresh for an environment failed. Not kept
 * alive: the limits view mounts it, and leaving the view forgets old failures.
 */
export const limitsRefreshFailedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(false).pipe(Atom.withLabel(`mobile:limits-refresh-failed:${environmentId}`)),
);

export async function refreshEnvironmentLimits(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  options: { readonly automatic?: boolean; readonly afterPending?: boolean } = {},
): Promise<void> {
  // One refresh runs per environment at a time, so results land in the order
  // they were started and the newest outcome always wins.
  const result = await refreshUsageLimits(
    environmentId,
    () =>
      runAtomCommand(
        registry,
        serverEnvironment.refreshProviders,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
    options.automatic,
    options.afterPending,
  );
  if (result === undefined) return;
  registry.set(limitsRefreshFailedAtom(environmentId), result._tag === "Failure");
}

// Mounting starts an automatic refresh, which refreshUsageLimits throttles to
// one every few minutes per environment.
const limitsAutoRefreshAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    void refreshEnvironmentLimits(get.registry, environmentId, { automatic: true });
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
