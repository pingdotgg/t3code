import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  hasRelayRoute,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import type { ComposerEnvironmentCandidate } from "@t3tools/client-runtime/composerThreadItems";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}

export function projectEnvironmentPresentation(
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

const environmentsAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom).entries()].map(
    ([environmentId, presentation]) => projectEnvironmentPresentation(environmentId, presentation),
  ),
).pipe(Atom.withLabel("mobile-environments"));

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const environments = useAtomValue(environmentsAtom);

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

/** The user's machines as `@` mention candidates, drawn with their machine kind. */
export function useMentionableEnvironments(): ReadonlyArray<ComposerEnvironmentCandidate> {
  const { environments } = useEnvironments();
  return environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    machine: resolveEnvironmentMachineKind(environment.serverConfig),
  }));
}
