import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  linkableMachines,
  linkedEnvironmentNames,
  offersLinkedEnvironments,
} from "@t3tools/client-runtime/link-request";
import { createPeerLinkEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useEffect, useEffectEvent, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { relayEnvironmentDiscovery } from "./relay";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const peerLinkEnvironment = createPeerLinkEnvironmentAtoms(connectionAtomRuntime);

/**
 * The machines `environmentId` links to, by name, while it offers links, and none otherwise.
 * Its agents can read threads there, and so can a client allowed to read threads on it.
 * A `wanted` machine this app is not connected to and the names lack makes them reread.
 */
export function useLinkedEnvironments(
  environmentId: EnvironmentId | null,
  wanted: ReadonlyArray<EnvironmentId> = [],
): ReadonlyMap<EnvironmentId, string> {
  const { environments } = useEnvironments();
  const offered = offersLinkedEnvironments(
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig,
  );
  const queried = offered ? environmentId : null;
  const links = useEnvironmentQuery(
    queried === null ? null : peerLinkEnvironment.names({ environmentId: queried, input: {} }),
  );
  const connected = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const missing = [...new Set(wanted)].filter((id) => id !== environmentId && !connected.has(id));
  const refreshKey =
    queried === null || missing.length === 0 ? "" : [queried, ...[...missing].sort()].join(" ");
  const registry = useContext(RegistryContext);
  const refreshLacking = useEffectEvent(() => {
    if (queried !== null) peerLinkEnvironment.refreshNamesLacking(registry, queried, missing);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- links made outside this app are not pushed, so meeting an unknown machine asks the server again
  useEffect(() => {
    if (refreshKey !== "") refreshLacking();
  }, [refreshKey]);
  return useMemo(
    () => linkedEnvironmentNames({ links: offered ? (links.data?.links ?? []) : [], environments }),
    [environments, links.data, offered],
  );
}

/**
 * The user's other machines, for picking one to link `environmentId` to,
 * including those only on their T3 Connect account. Reads that environment's
 * links only while `enabled`, since listing them asks every linked machine
 * whether it answers.
 */
export function useLinkableMachines(environmentId: EnvironmentId, enabled: boolean) {
  const { environments } = useEnvironments();
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  // Connect hosts are listed only once something asked for them, so ask on open.
  const discoverIfUnasked = useEffectEvent(() => {
    if (discovery.environments.size === 0 && !discovery.refreshing) void refreshDiscovery();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discovery follows the picker's visibility, which a card's mount or a dialog's open sets
  useEffect(() => {
    if (enabled) discoverIfUnasked();
  }, [enabled]);
  const links = useEnvironmentQuery(
    enabled ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  return linkableMachines({
    environments,
    threadEnvironmentId: environmentId,
    links: links.data?.links ?? [],
    connect: discovery.environments,
  });
}
