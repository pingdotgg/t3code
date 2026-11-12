import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { DEFAULT_PR_LIST_CONTROLS, type PullRequestListControls } from "./pullRequestList";

export function usePullRequestListControls() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.pullRequestListFilters
    : undefined;
  const environmentId = saved?.environmentId ?? null;
  const controlsFor = (environment: string | null) =>
    saved?.controls[environment ?? ""] ?? DEFAULT_PR_LIST_CONTROLS;
  const setEnvironmentId = (next: string | null) =>
    savePreferences({
      transform: (current) => ({
        pullRequestListFilters: {
          controls: current.pullRequestListFilters?.controls ?? {},
          environmentId: next,
        },
      }),
    });
  const setControls = (environment: string | null, controls: PullRequestListControls) =>
    savePreferences({
      transform: (current) => ({
        pullRequestListFilters: {
          environmentId: current.pullRequestListFilters?.environmentId ?? null,
          controls: withEnvironmentControls(
            current.pullRequestListFilters?.controls,
            environment ?? "",
            controls,
          ),
        },
      }),
    });
  return { environmentId, controlsFor, setEnvironmentId, setControls } as const;
}

function withEnvironmentControls(
  saved: Readonly<Record<string, PullRequestListControls>> | undefined,
  environment: string,
  controls: PullRequestListControls,
): Record<string, PullRequestListControls> {
  return { ...saved, [environment]: controls };
}
