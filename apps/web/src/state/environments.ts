import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  hasRelayRoute,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  environmentPresentations,
  environmentSummaries,
  useEnvironmentPresentation,
} from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}

function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
): EnvironmentPresentation {
  return {
    ...presentation,
    environmentId,
    label: presentation.entry.target.label,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: hasRelayRoute(presentation.entry),
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = [...presentationById.entries()].map(([environmentId, presentation]) =>
    projectEnvironmentPresentation(environmentId, presentation),
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

/** Provider statuses change on every push, so they live apart from the presentations. */
export function useEnvironmentProviders() {
  return useAtomValue(environmentPresentations.providersByEnvironmentAtom);
}

export function readEnvironmentProviders(environmentId: EnvironmentId) {
  return appAtomRegistry
    .get(environmentPresentations.providersByEnvironmentAtom)
    .get(environmentId);
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function readPrimaryEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(primaryEnvironmentIdAtom);
}

/** The environment's state now, for handlers that should not re-render on every change. */
export function readEnvironment(environmentId: EnvironmentId): EnvironmentPresentation | null {
  const presentation = appAtomRegistry
    .get(environmentPresentations.presentationsAtom)
    .get(environmentId);
  return presentation ? projectEnvironmentPresentation(environmentId, presentation) : null;
}

/** Every saved environment's id now, this machine's own included. */
export function readEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return new Set(appAtomRegistry.get(environmentPresentations.presentationsAtom).keys());
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  return environmentId === null || presentation === null
    ? null
    : projectEnvironmentPresentation(environmentId, presentation);
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

/**
 * The account's T3 Connect machines for a view that keeps one in front of the user. A refresh
 * empties the list until it answers; the machines last seen stay meanwhile.
 */
export function useRetainedRelayEnvironments() {
  const discovery = useRelayEnvironmentDiscovery();
  const [seen, setSeen] = useState(discovery.environments);
  const emptied = discovery.refreshing && discovery.environments.size === 0;
  if (!emptied && seen !== discovery.environments) setSeen(discovery.environments);
  return emptied ? seen : discovery.environments;
}

export function useEnvironmentIdentities() {
  return useAtomValue(environmentSummaries.identitiesAtom);
}

export function usePullRequestsSupported() {
  return useAtomValue(environmentSummaries.pullRequestsSupportedAtom);
}

export function useIssuesSupported() {
  return useAtomValue(environmentSummaries.issuesSupportedAtom);
}

export function useEnvironmentMachines() {
  return useAtomValue(environmentSummaries.machineByIdAtom);
}

export function useConnectedEnvironmentIds() {
  return useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
}
