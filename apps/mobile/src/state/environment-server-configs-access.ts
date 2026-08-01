import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";

export type EnvironmentServerConfigsMap = ReadonlyMap<EnvironmentId, ServerConfig>;

/**
 * Narrow registry surface used by outbox delivery to keep the multi-environment
 * config graph live and read it at send time without a hook subscription.
 */
export type EnvironmentServerConfigsRegistry = {
  readonly get: (atom: typeof environmentServerConfigsAtom) => EnvironmentServerConfigsMap;
  readonly subscribe: (
    atom: typeof environmentServerConfigsAtom,
    listener: (configs: EnvironmentServerConfigsMap) => void,
  ) => () => void;
};

/** Keep the config graph live and notify a non-hook consumer when it changes. */
export function subscribeEnvironmentServerConfigs(
  listener: (configs: EnvironmentServerConfigsMap) => void,
  registry: Pick<EnvironmentServerConfigsRegistry, "subscribe"> = appAtomRegistry,
): () => void {
  return registry.subscribe(environmentServerConfigsAtom, listener);
}

/**
 * Fresh delivery-time read of the multi-environment server-config map.
 * Callers must re-invoke on each use rather than capturing the map identity.
 */
export function readEnvironmentServerConfigs(
  registry: Pick<EnvironmentServerConfigsRegistry, "get"> = appAtomRegistry,
): EnvironmentServerConfigsMap {
  return registry.get(environmentServerConfigsAtom);
}
