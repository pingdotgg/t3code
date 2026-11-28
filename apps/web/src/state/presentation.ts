import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "./server";
import { expectsPrimaryEnvironment } from "./shell";

export const environmentPresentations = createEnvironmentPresentationAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const environmentSummaries = createEnvironmentSummaryAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

const EMPTY_ENVIRONMENT_PRESENTATION_ATOM = Atom.make<EnvironmentPresentation | null>(null).pipe(
  Atom.withLabel("web-environment-presentation:empty"),
);

/** The catalog has loaded without a usable connection to the environment (as `enabledEnvironmentIds` counts them). */
export const environmentUnreachableAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    if (environmentId === null) return false;
    const catalog = get(environmentCatalog.catalogValueAtom);
    if (!catalog.isReady) return false;
    // The catalog is ready before primary discovery lands; until then it cannot prove absence.
    if (
      expectsPrimaryEnvironment() &&
      !Array.from(catalog.entries.values()).some(
        (entry) => entry.target._tag === "PrimaryConnectionTarget",
      )
    ) {
      return false;
    }
    const entry = catalog.entries.get(environmentId);
    return !entry?.enabled || entry.unsupportedReason !== undefined;
  }),
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
