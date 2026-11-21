import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentPresentation,
  EnvironmentServerConfig,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "./server";

export const environmentPresentations = createEnvironmentPresentationAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const environmentSummaries = createEnvironmentSummaryAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

// Per-environment booleans, so a row reading one doesn't re-render when any other config changes.
export function createEnvironmentServerConfigFlagAtoms(
  serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentServerConfig>>,
) {
  return {
    hasServerConfigAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => get(serverConfigsAtom).has(environmentId)),
    ),
    issuesSupportedAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make(
        (get) =>
          get(serverConfigsAtom).get(environmentId)?.environment.capabilities.issues === true,
      ),
    ),
  };
}

export const environmentServerConfigFlags = createEnvironmentServerConfigFlagAtoms(
  environmentPresentations.serverConfigsAtom,
);

const EMPTY_ENVIRONMENT_PRESENTATION_ATOM = Atom.make<EnvironmentPresentation | null>(null).pipe(
  Atom.withLabel("web-environment-presentation:empty"),
);

export function useEnvironmentPresentation(environmentId: EnvironmentId | null) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const presentation = useAtomValue(
    environmentId === null
      ? EMPTY_ENVIRONMENT_PRESENTATION_ATOM
      : environmentPresentations.presentationAtom(environmentId),
  );
  return {
    isReady: catalog.isReady,
    presentation,
  };
}
