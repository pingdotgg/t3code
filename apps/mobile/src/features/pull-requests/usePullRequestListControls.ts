import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { DEFAULT_PR_LIST_CONTROLS, type PullRequestListControls } from "./pullRequestList";
import type { PullRequestSavedView } from "../../persistence/mobile-preferences";
import { pullRequestSavedViewPreferences } from "./pullRequestSavedViews";

export function usePullRequestListControls() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const applyPreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
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
  const applyView = (view: PullRequestSavedView) =>
      applyPreferences({
        transform: (current) => pullRequestSavedViewPreferences(current, view),
      });
  return { environmentId, controlsFor, setEnvironmentId, setControls, applyView } as const;
}

const EMPTY_SAVED_VIEWS: ReadonlyArray<PullRequestSavedView> = [];

export function usePullRequestSavedViews() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const views = AsyncResult.isSuccess(preferences)
    ? (preferences.value.pullRequestSavedViews ?? EMPTY_SAVED_VIEWS)
    : EMPTY_SAVED_VIEWS;
  const update = (
    transform: (
      current: ReadonlyArray<PullRequestSavedView>,
    ) => ReadonlyArray<PullRequestSavedView>,
  ) =>
    savePreferences({
      transform: (current) => ({
        pullRequestSavedViews: transform(current.pullRequestSavedViews ?? EMPTY_SAVED_VIEWS),
      }),
    });
  return { views, ready, update } as const;
}

function withEnvironmentControls(
  saved: Readonly<Record<string, PullRequestListControls>> | undefined,
  environment: string,
  controls: PullRequestListControls,
): Record<string, PullRequestListControls> {
  return { ...saved, [environment]: controls };
}
