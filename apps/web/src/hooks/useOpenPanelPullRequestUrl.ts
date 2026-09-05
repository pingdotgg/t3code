import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import {
  readPullRequestDetailSnapshot,
  resolveDisplayedPullRequestDetail,
} from "../components/pullRequest/pullRequestDetail.logic";
import { gitHubPullRequestBrowserUrl } from "../lib/openPullRequestLink";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useProject } from "../state/entities";
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
  const project = useProject(
    reference && environmentId
      ? scopeProjectRef(environmentId, ProjectId.make(reference.projectId))
      : null,
  );
  const detail = useEnvironmentQuery(
    reference && environmentId
      ? pullRequestEnvironment.detail({
          environmentId,
          input: {
            projectId: ProjectId.make(reference.projectId),
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
        gitHubPullRequestBrowserUrl(
          project?.repositoryIdentity,
          reference.repository,
          reference.number,
        ))
    : undefined;
}
