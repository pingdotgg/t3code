import type { EnvironmentId, PullRequestMergeMethod } from "@t3tools/contracts";
import type { ClientPullRequestPreferences } from "@t3tools/extension-sdk/environment";

import { legacyProjectMergeMethod } from "~/components/pullRequest/legacyMergeMethod";
import { getClientSettings, subscribeClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useUiStateStore } from "~/uiStateStore";

const MERGE_METHODS: ReadonlySet<string> = new Set(["merge", "squash", "rebase"]);

/**
 * The web and desktop `ClientHost.pullRequestPreferences`: the native pull-request panel's own
 * remembered merge method (the persisted UI state) and its legacy per-project overrides.
 */
export const hostPullRequestPreferences: ClientPullRequestPreferences = {
  version: 1,
  lastMergeMethod: () => useUiStateStore.getState().pullRequestMergeMethod,
  setLastMergeMethod(method) {
    // Plugin input: only a method the native store can hold.
    if (!MERGE_METHODS.has(method)) return;
    useUiStateStore.getState().setPullRequestMergeMethod(method as PullRequestMergeMethod);
  },
  legacyProjectMergeMethod({ environmentId, projectId }) {
    const settings = getClientSettings();
    return (
      legacyProjectMergeMethod({
        projects: readProjects(),
        grouping: selectProjectGroupingSettings(settings),
        overrides: settings.pullRequestMergeMethodOverrides,
        primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
        environmentId: environmentId as EnvironmentId,
        projectId,
      }) ?? null
    );
  },
  subscribe(listener) {
    const stopUiState = useUiStateStore.subscribe((state, previous) => {
      if (state.pullRequestMergeMethod !== previous.pullRequestMergeMethod) listener();
    });
    const stopSettings = subscribeClientSettings(listener);
    return () => {
      stopUiState();
      stopSettings();
    };
  },
};
