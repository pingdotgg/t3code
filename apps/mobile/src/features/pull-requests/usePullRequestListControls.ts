import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { DEFAULT_PR_LIST_CONTROLS, type PullRequestListControls } from "./pullRequestList";
import type { PullRequestSavedView } from "../../persistence/mobile-preferences";
import { pullRequestSavedViewPreferences } from "./pullRequestSavedViews";

export function usePullRequestListControls() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences, { reportFailure: false });
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.pullRequestListFilters
    : undefined;
  const environmentId = saved?.environmentId ?? null;
  const controlsFor = (environment: string | null) =>
    saved?.controls[environment ?? ""] ?? DEFAULT_PR_LIST_CONTROLS;
  const setEnvironmentId = (next: string | null) => {
    void savePreferences({
      transform: (current) => ({
        pullRequestListFilters: {
          controls: current.pullRequestListFilters?.controls ?? {},
          environmentId: next,
        },
      }),
    });
  };
  const setControls = (environment: string | null, controls: PullRequestListControls) => {
    void savePreferences({
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
  };
  const applyView = async (view: PullRequestSavedView) => {
    const result = await savePreferences({
      transform: (current) => pullRequestSavedViewPreferences(current, view),
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };
  return { environmentId, controlsFor, setEnvironmentId, setControls, applyView } as const;
}

function withEnvironmentControls(
  saved: Readonly<Record<string, PullRequestListControls>> | undefined,
  environment: string,
  controls: PullRequestListControls,
): Record<string, PullRequestListControls> {
  return { ...saved, [environment]: controls };
}
