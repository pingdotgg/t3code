import { useAtomValue } from "@effect/atom-react";
import { linkableMachines, offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { createPeerLinkEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import { AuthAccessReadScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { environmentPresentations } from "./presentation";
import { relayEnvironmentDiscovery } from "./relay";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentsWithScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const peerLinkEnvironment = createPeerLinkEnvironmentAtoms(connectionAtomRuntime);

/** Whether `environmentId` offers links, so its threads may name another machine. */
export const offersLinkedEnvironmentsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    offersLinkedEnvironments(get(environmentPresentations.serverConfigsAtom).get(environmentId)),
  ).pipe(Atom.withLabel(`peer-links:offered:${environmentId}`)),
);

export function usePeerLinkHosts() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      offersLinkedEnvironments(environment.serverConfig),
  );
  const readable = useEnvironmentsWithScope(supported, AuthAccessReadScope);
  return supported.filter((environment) => readable.has(environment.environmentId));
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
  // oxlint-disable-next-line t3code/react-effect-budget -- discovery follows the picker's visibility, which a card's mount or a dialog's open sets
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
