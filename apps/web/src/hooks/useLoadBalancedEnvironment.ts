import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { chooseLoadBalancedEnvironment } from "@t3tools/client-runtime/load-balancing";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useMemo } from "react";

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
            failed: result._tag === "Failure",
          };
        }),
      ),
    [environmentIds],
  );
  const resources = useAtomValue(resourcesAtom);
  const pending = resources.some((resource) => resource.pending);
  const environmentId = chooseLoadBalancedEnvironment(
    resources.map((resource) => ({
      ...resource,
      weight: weights[resource.environmentId] ?? 50,
    })),
    Date.now(),
  ) as EnvironmentId | null;
  return {
    refresh,
    pending,
    environmentId,
    failed: !pending && environmentId === null && resources.some((resource) => resource.failed),
  };
}
