import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { useProjects } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { useWorkspaceState } from "../../state/workspace";
import {
  DEFAULT_PR_LIST_CONTROLS,
  pullRequestListInput,
  withoutScratchProjectScope,
  type PullRequestListControls,
} from "./pullRequestList";

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

/** The list reads for the saved controls; the PRs tab and its warm-up share these keys. */
export function usePullRequestListTargets(query: string) {
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const allProjects = useProjects();
  const listControls = usePullRequestListControls();
  const selectedEnvironmentId = listControls.environmentId;
  const environmentId = environments.some((item) => item.environmentId === selectedEnvironmentId)
    ? selectedEnvironmentId
    : null;
  const savedControls = listControls.controlsFor(environmentId);
  const controls = useMemo(
    () => withoutScratchProjectScope(savedControls, allProjects),
    [allProjects, savedControls],
  );
  const targets = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            configs.get(environment.environmentId) !== undefined &&
            (environmentId === null || environment.environmentId === environmentId) &&
            (!controls.projectEnvironmentId ||
              environment.environmentId === controls.projectEnvironmentId),
        )
        .sort((left, right) => left.environmentId.localeCompare(right.environmentId))
        .map((environment) => ({
          environmentId: environment.environmentId,
          input: pullRequestListInput(controls, query),
        })),
    [environments, environmentId, configs, controls, query],
  );
  return { listControls, environmentId, controls, targets };
}
