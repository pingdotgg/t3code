import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  hasRelayRoute,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import {
  type EnvironmentId,
  isBoatCloudHttpBaseUrl,
  isBoxdCloudHttpBaseUrl,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

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
  /**
   * A Boat cloud VM. Lists of machines leave these out, since the one Boat
   * cloud entry stands for all of them, and they all go by that name.
   */
  readonly boatCloud: boolean;
  /** A boxd cloud machine, listed the same way as a Boat cloud VM. */
  readonly boxdCloud: boolean;
}

export const BOAT_CLOUD_LABEL = "Boat cloud";
export const BOXD_CLOUD_LABEL = "boxd cloud";

function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
): EnvironmentPresentation {
  const displayUrl = connectionCatalogDisplayUrl(presentation.entry);
  const boatCloud = isBoatCloudHttpBaseUrl(displayUrl);
  const boxdCloud = isBoxdCloudHttpBaseUrl(displayUrl);
  return {
    ...presentation,
    environmentId,
    label: boatCloud
      ? BOAT_CLOUD_LABEL
      : boxdCloud
        ? BOXD_CLOUD_LABEL
        : presentation.entry.target.label,
    displayUrl,
    relayManaged: hasRelayRoute(presentation.entry),
    boatCloud,
    boxdCloud,
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
