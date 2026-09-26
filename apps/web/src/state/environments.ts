import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
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

type ScopeEnvironment = Pick<EnvironmentPresentation, "environmentId" | "label" | "displayUrl">;

/**
 * Menu row label for an environment. Labels are not unique, so a name shared
 * with another environment gets its address appended, and the id as well when
 * the address is shared too (two SSH backends on one host); two machines must
 * never read as one row.
 */
export function environmentScopeLabel(
  environment: ScopeEnvironment,
  environments: readonly ScopeEnvironment[],
): string {
  const sameLabel = environments.filter(
    (other) =>
      other.environmentId !== environment.environmentId && other.label === environment.label,
  );
  if (sameLabel.length === 0) return environment.label;
  if (environment.displayUrl === null) return `${environment.label} · ${environment.environmentId}`;
  const sameAddress = sameLabel.some((other) => other.displayUrl === environment.displayUrl);
  return sameAddress
    ? `${environment.label} · ${environment.displayUrl} · ${environment.environmentId}`
    : `${environment.label} · ${environment.displayUrl}`;
}

/**
 * Environments the sidebar can scope to: enabled catalog entries in catalog
 * order. Switched-off entries contribute no projects or threads, so they are
 * not choices. Fewer than two enabled environments is no choice either, so
 * the result is empty and the header renders no control.
 */
export function buildSidebarEnvironmentScopeItems(
  environments: readonly EnvironmentPresentation[],
): readonly EnvironmentPresentation[] {
  const enabled = environments.filter((environment) => environment.entry.enabled);
  return enabled.length < 2 ? [] : enabled;
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
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation),
      ),
    [presentationById],
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
  const { presentation } = useEnvironmentPresentation(environmentId);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation),
    [environmentId, presentation],
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
