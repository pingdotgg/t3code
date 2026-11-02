import { useAtomValue } from "@effect/atom-react";
import {
  changeRequestTerms,
  setMergeRequestTerms,
} from "@t3tools/client-runtime/source-control-clients";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom } from "./preferences";

export function createChangeRequestTermsAtom(preferencesAtom: typeof mobilePreferencesAtom) {
  return Atom.map(preferencesAtom, (preferences) =>
    changeRequestTerms(
      AsyncResult.isSuccess(preferences) && preferences.value.mergeRequestTerminology === true,
    ),
  );
}

const changeRequestTermsAtom = createChangeRequestTermsAtom(mobilePreferencesAtom);

export function useChangeRequestTerms() {
  return useAtomValue(changeRequestTermsAtom);
}

export function installChangeRequestTerminologyRuntime(
  registry = appAtomRegistry,
  termsAtom = changeRequestTermsAtom,
) {
  return registry.subscribe(termsAtom, (terms) => setMergeRequestTerms(terms.shortLabel === "MR"), {
    immediate: true,
  });
}
