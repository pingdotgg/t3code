import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { visibleCatalogValueAtom } from "../connection/visibleCatalog";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { createThreadListEnvironmentsAtom } from "./thread-list-environments";

export const environmentPresentations = createEnvironmentPresentationAtoms({
  catalogValueAtom: visibleCatalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const { connectedEnvironmentIdsAtom } = createEnvironmentSummaryAtoms({
  catalogValueAtom: visibleCatalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

export const threadListEnvironmentsAtom = createThreadListEnvironmentsAtom(
  environmentServerConfigsAtom,
  connectedEnvironmentIdsAtom,
);

const EMPTY_ENVIRONMENT_PRESENTATION_ATOM = Atom.make<EnvironmentPresentation | null>(null).pipe(
  Atom.withLabel("mobile-environment-presentation:empty"),
);

export function useEnvironmentPresentation(environmentId: EnvironmentId | null) {
  const catalog = useAtomValue(visibleCatalogValueAtom);
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
