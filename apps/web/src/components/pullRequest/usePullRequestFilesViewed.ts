import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { filesViewedScope } from "./filesViewedStore";
import {
  isFileViewed,
  isStaleViewedState,
  toFileViewedStates,
} from "./pullRequestFilesViewed.logic";

export interface PullRequestFilesViewedView {
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  readonly setViewed: (path: string, viewed: boolean) => void;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

const NO_OVERLAY = new Map<string, boolean>();
// Without this a change request that cannot record views would still be handed a scope handle.
const DISABLED_SCOPE = {
  subscribe: () => () => {},
  getSnapshot: () => NO_OVERLAY,
  setViewed: () => {},
};

export function usePullRequestFilesViewed(options: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly enabled: boolean;
}): PullRequestFilesViewedView {
  const { environmentId, reference, enabled } = options;
  const query = useEnvironmentQuery(
    enabled ? pullRequestEnvironment.filesViewed({ environmentId, input: reference }) : null,
  );
  const states = toFileViewedStates(query.data);
  // Stable per scope: `setViewed` is handed to every file header the viewer draws.
  const scope = enabled ? filesViewedScope({ environmentId, reference }) : DISABLED_SCOPE;
  const overlay = useSyncExternalStore(scope.subscribe, scope.getSnapshot);

  return {
    enabled,
    isViewed: (path: string) => isFileViewed(path, states, overlay),
    isStale: (path: string) => !overlay.has(path) && isStaleViewedState(states?.get(path)),
    setViewed: scope.setViewed,
    truncated: query.data?.truncated === true,
    error: query.error,
    refresh: query.refresh,
  };
}
