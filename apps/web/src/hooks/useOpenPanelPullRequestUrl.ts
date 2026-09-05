import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import {
  readPullRequestDetailSnapshot,
  resolveDisplayedPullRequestDetail,
} from "../components/pullRequest/pullRequestDetail.logic";
import { gitHubPullRequestBrowserUrl } from "../lib/openPullRequestLink";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useProject, useServerConfigs } from "../state/entities";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useEnvironmentQuery } from "../state/query";

export function useOpenPanelPullRequestUrl(threadRef: ScopedThreadRef | null) {
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const reference = surface?.kind === "pull-request" ? surface : null;
  const environmentId = reference?.environmentId
    ? EnvironmentId.make(reference.environmentId)
    : threadRef?.environmentId;
  const serverConfigs = useServerConfigs();
  const project = useProject(
    reference && reference.projectId !== null && environmentId
      ? scopeProjectRef(environmentId, ProjectId.make(reference.projectId))
      : null,
  );
  const detail = useEnvironmentQuery(
    reference &&
      environmentId &&
      (reference.projectId !== null ||
        serverConfigs.get(environmentId)?.environment.capabilities.unlinkedGitHubPullRequests ===
          true)
      ? pullRequestEnvironment.detail({
          environmentId,
          input: {
            projectId: reference.projectId === null ? null : ProjectId.make(reference.projectId),
            repository: reference.repository,
            number: reference.number,
          },
        })
      : null,
  ).data;
  const cachedDetail = useMemo(
    () =>
      reference && environmentId
        ? readPullRequestDetailSnapshot(
            typeof window === "undefined" ? undefined : window.localStorage,
            environmentId,
            reference,
          )
        : null,
    [environmentId, reference],
  );
  return reference
    ? (resolveDisplayedPullRequestDetail({ live: detail, cached: cachedDetail, reference })?.url ??
        (reference.projectId === null
          ? `https://github.com/${reference.repository}/pull/${reference.number}`
          : gitHubPullRequestBrowserUrl(
              project?.repositoryIdentity,
              reference.repository,
              reference.number,
            )))
    : undefined;
}
