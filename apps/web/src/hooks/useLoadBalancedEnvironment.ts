import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  createHostResourcesAtom,
  selectLoadBalancedFromHostResources,
} from "@t3tools/client-runtime/state/host-resources-balancing";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext } from "react";

import { serverEnvironment } from "../state/server";

const hostResourcesAtom = createHostResourcesAtom(serverEnvironment.hostResources);

/** Only mounted for unresolved automatic picks, so idle clients do not poll hosts. */
export function useLoadBalancedEnvironment(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  const registry = useContext(RegistryContext);
  const refresh = (ids: readonly EnvironmentId[]) => {
    for (const environmentId of ids) {
      registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
    }
  };
  const snapshot = useAtomValue(hostResourcesAtom(environmentIds.join("\n")));
  return { refresh, ...selectLoadBalancedFromHostResources(snapshot, weights) };
}
