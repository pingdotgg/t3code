import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { DEFAULT_PR_LIST_CONTROLS, type PullRequestListControls } from "./pullRequestList";

export function usePullRequestListControls() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.pullRequestListFilters
    : undefined;
  const environmentId = saved?.environmentId ?? null;
  const controlsFor = useCallback(
    (environment: string | null) => saved?.controls[environment ?? ""] ?? DEFAULT_PR_LIST_CONTROLS,
    [saved],
  );
  const setEnvironmentId = useCallback(
    (next: string | null) =>
      savePreferences({
        transform: (current) => ({
          pullRequestListFilters: {
            controls: current.pullRequestListFilters?.controls ?? {},
            environmentId: next,
          },
        }),
      }),
    [savePreferences],
  );
  const setControls = useCallback(
    (environment: string | null, controls: PullRequestListControls) =>
      savePreferences({
        transform: (current) => ({
          pullRequestListFilters: {
            environmentId: current.pullRequestListFilters?.environmentId ?? null,
            controls: {
              ...current.pullRequestListFilters?.controls,
              [environment ?? ""]: controls,
            },
          },
        }),
      }),
    [savePreferences],
  );
  return { environmentId, controlsFor, setEnvironmentId, setControls } as const;
}
