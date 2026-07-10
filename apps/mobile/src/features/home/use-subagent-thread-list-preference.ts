import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Device-persisted opt-in for exposing subagent threads in navigation lists. */
export function useSubagentThreadListPreference() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const showSubagentThreads = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.showSubagentThreads ?? false)
    : false;
  const setShowSubagentThreads = useCallback(
    (show: boolean) => {
      savePreferences({ showSubagentThreads: show });
    },
    [savePreferences],
  );

  return { showSubagentThreads, setShowSubagentThreads } as const;
}
