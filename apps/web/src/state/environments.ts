import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type ConnectionTarget,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useManagedRelayEnvironmentRecords } from "../cloud/managedRelayState";
import { environmentPresentations, useEnvironmentPresentation } from "./presentation";
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
  managedRelayEnvironments: ReadonlyArray<RelayClientEnvironmentRecord> | null,
): EnvironmentPresentation {
  return {
    ...presentation,
    environmentId,
    label: environmentDisplayLabel(
      environmentId,
      presentation.entry.target,
      managedRelayEnvironments,
    ),
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
  };
}

export function environmentDisplayLabel(
  environmentId: EnvironmentId,
  target: ConnectionTarget,
  managedRelayEnvironments: ReadonlyArray<RelayClientEnvironmentRecord> | null,
): string {
  if (target._tag !== "PrimaryConnectionTarget") return target.label;
  return (
    managedRelayEnvironments?.find((environment) => environment.environmentId === environmentId)
      ?.label ?? target.label
  );
}

export function useEnvironments() {
  const managedRelayEnvironments = useManagedRelayEnvironmentRecords();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation, managedRelayEnvironments),
      ),
    [managedRelayEnvironments, presentationById],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const managedRelayEnvironments = useManagedRelayEnvironmentRecords();
  const { presentation } = useEnvironmentPresentation(environmentId);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation, managedRelayEnvironments),
    [environmentId, managedRelayEnvironments, presentation],
  );
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
