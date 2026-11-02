import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useDiffWhitespacePreference() {
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const ignoreWhitespace = AsyncResult.isSuccess(result)
    ? result.value.diffIgnoreWhitespace === true
    : false;
  return {
    ignoreWhitespace,
    setIgnoreWhitespace: (value: boolean) => save({ diffIgnoreWhitespace: value }),
  };
}
