import type { PullRequestRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProjects } from "../../state/entities";
import {
  resolvePullRequestRouteReference,
  type PullRequestDetailRouteParams,
} from "./pullRequestNavigation";

export function useResolvedPullRequestReference(
  params: PullRequestDetailRouteParams,
): PullRequestRef | null {
  const { environmentId, projectId, number, repository } = params;
  const projects = useProjects();
  return useMemo(
    () =>
      resolvePullRequestRouteReference({ environmentId, projectId, number, repository }, projects),
    [environmentId, number, projectId, projects, repository],
  );
}
