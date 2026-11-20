import { useAtomValue } from "@effect/atom-react";
import {
  linkableMachines,
  linkedEnvironmentNames,
  offersLinkedEnvironments,
} from "@t3tools/client-runtime/link-request";
import { linkBackOffer, type LinkBackOffer } from "@t3tools/client-runtime/link-batch";
import { createPeerLinkEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import { AuthAccessReadScope, AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironmentIdentities, useEnvironments } from "./environments";
import { environmentPresentations } from "./presentation";
import { relayEnvironmentDiscovery } from "./relay";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentsWithScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const peerLinkEnvironment = createPeerLinkEnvironmentAtoms(connectionAtomRuntime);

/** Each environment's link list as the settings list loads it, in the order of the ids. */
export const peerLinkListsAtom = environmentAtomList("peer-links:lists", (environmentId) =>
  peerLinkEnvironment.list({ environmentId, input: {} }),
);

/** Whether `environmentId` offers links, so its threads may name another machine. */
export const offersLinkedEnvironmentsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    offersLinkedEnvironments(get(environmentPresentations.serverConfigsAtom).get(environmentId)),
  ).pipe(Atom.withLabel(`peer-links:offered:${environmentId}`)),
);

const offersNoLinksAtom = Atom.make(false).pipe(Atom.withLabel("peer-links:offered:none"));

/**
 * The machines `environmentId` links to, by name, while it offers links, and none otherwise.
 * Its agents can read threads there, and so can a client allowed to read threads on it.
 */
export function useLinkedEnvironments(
  environmentId: EnvironmentId | null,
): ReadonlyMap<EnvironmentId, string> {
  const offered = useAtomValue(
    environmentId === null ? offersNoLinksAtom : offersLinkedEnvironmentsAtom(environmentId),
  );
  const identities = useEnvironmentIdentities();
  const links = useEnvironmentQuery(
    offered && environmentId !== null
      ? peerLinkEnvironment.names({ environmentId, input: {} })
      : null,
  );
  return linkedEnvironmentNames({
    links: offered ? (links.data?.links ?? []) : [],
    environments: identities,
  });
}

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

const NOT_OFFERED: LinkBackOffer = { kind: "hidden" };

/**
 * Whether linking `sourceId` to each of `targetIds` can also link that machine back, and the
 * source as the reverse link names it. Only machines that could link back are asked for their
 * links, and only while `enabled`: listing asks every machine they link to whether it answers.
 */
export function useLinkBackOffers(
  sourceId: EnvironmentId,
  targetIds: ReadonlyArray<EnvironmentId>,
  enabled: boolean,
) {
  const { environments } = useEnvironments();
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const writable = useEnvironmentsWithScope(environments, AuthAccessWriteScope);
  const source = linkableMachines({
    environments,
    threadEnvironmentId: null,
    links: [],
    connect: discovery.environments,
  }).find((machine) => machine.environmentId === sourceId);
  const wanted = new Set(targetIds);
  const targets = environments.filter((environment) => wanted.has(environment.environmentId));
  const listed = targets
    .filter(
      (target) =>
        enabled &&
        target.connection.phase === "connected" &&
        offersLinkedEnvironments(target.serverConfig) &&
        writable.has(target.environmentId),
    )
    .map((target) => target.environmentId);
  const lists = useAtomValue(peerLinkListsAtom(environmentIdsKey(listed)));
  const offers = new Map<EnvironmentId, LinkBackOffer>();
  for (const target of targets) {
    if (source === undefined) break;
    const list = lists[listed.indexOf(target.environmentId)];
    offers.set(
      target.environmentId,
      linkBackOffer({
        source: {
          environmentId: sourceId,
          connected: source.connected,
          writable: writable.has(sourceId),
          urls: source.urls,
        },
        target: {
          connected: target.connection.phase === "connected",
          offersLinks: offersLinkedEnvironments(target.serverConfig),
          writable: writable.has(target.environmentId),
          links: list?._tag === "Success" ? list.value.links : null,
        },
      }),
    );
  }
  return {
    source: source ?? null,
    offerFor: (targetId: EnvironmentId | null): LinkBackOffer =>
      (targetId === null ? undefined : offers.get(targetId)) ?? NOT_OFFERED,
  };
}
