import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_PULL_REQUEST_VIEWING_PREFERENCES,
  type PullRequestViewingPreferences,
} from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Use the device preference store so review filters survive navigation and restarts. */
export function usePullRequestViewingPreferences() {
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const preferences =
    (AsyncResult.isSuccess(result) ? result.value.pullRequestViewing : undefined) ??
    DEFAULT_PULL_REQUEST_VIEWING_PREFERENCES;
  const update = (patch: Partial<PullRequestViewingPreferences>) =>
    save({
      transform: (current) => ({
        pullRequestViewing: {
          ...(current.pullRequestViewing ?? DEFAULT_PULL_REQUEST_VIEWING_PREFERENCES),
          ...patch,
        },
      }),
    });
  return { preferences, update };
}
