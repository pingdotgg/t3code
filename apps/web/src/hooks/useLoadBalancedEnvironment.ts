import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { chooseLoadBalancedEnvironment } from "@t3tools/client-runtime/load-balancing";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useMemo } from "react";

import { serverEnvironment } from "../state/server";

/** Only mounted for unresolved automatic drafts, so idle clients do not poll hosts. */
export function useLoadBalancedEnvironment(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  const registry = useContext(RegistryContext);
  const refresh = useCallback(
    (ids: readonly EnvironmentId[]) => {
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
    },
    [registry],
  );
  const resourcesAtom = useMemo(
    () =>
      Atom.make((get) =>
        environmentIds.map((environmentId) => {
          const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
          return {
            environmentId,
            resources: result._tag === "Success" ? result.value : null,
            receivedAt: result._tag === "Success" ? result.timestamp : 0,
            pending: result._tag === "Initial" || result.waiting,
          };
        }),
      ),
    [environmentIds],
  );
  const resources = useAtomValue(resourcesAtom);
  const pending = resources.some((resource) => resource.pending);
  const selection = chooseLoadBalancedEnvironment(
    resources.map((resource) => ({
      ...resource,
      weight: weights[resource.environmentId] ?? 50,
    })),
    Date.now(),
  );
  const environmentId = selection.environmentId as EnvironmentId | null;
  useEffect(() => {
    if (resources.length === 0 || pending || environmentId !== null) return;
    // A rejected sample must not strand the draft after the host recovers.
    const timer = setTimeout(
      () => refresh(resources.map((resource) => resource.environmentId)),
      5_000,
    );
    return () => clearTimeout(timer);
  }, [resources, pending, environmentId, refresh]);
  return {
    refresh,
    pending,
    environmentId,
    status: pending ? ("checking" as const) : selection.status,
  };
}
