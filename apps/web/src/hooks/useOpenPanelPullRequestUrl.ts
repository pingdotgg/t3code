import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";

import {
  readPullRequestDetailSnapshot,
  resolveDisplayedPullRequestDetail,
  resolvePullRequestReferenceHost,
} from "../components/pullRequest/pullRequestDetail.logic";
import { gitHubPullRequestBrowserUrl } from "../lib/openPullRequestLink";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useProject } from "../state/entities";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useEnvironmentQuery } from "../state/query";
import { useSupportsMultiplePullRequests } from "./useSupportsMultiplePullRequests";

type PanelPullRequestSurface = Extract<
  NonNullable<ReturnType<typeof selectActiveRightPanelSurface>>,
  { kind: "pull-request" }
>;

// The reference keys the detail query atom, so it must keep its identity across renders.
function usePanelPullRequestReference(
  requestedReference: PanelPullRequestSurface | null,
  supportsMultiplePullRequests: boolean,
  repositoryIdentity: Parameters<typeof resolvePullRequestReferenceHost>[1],
) {
  "use memo";
  if (requestedReference === null) return null;
  const input = {
    projectId: ProjectId.make(requestedReference.projectId),
    repository: requestedReference.repository,
    number: requestedReference.number,
  };
  return supportsMultiplePullRequests
    ? resolvePullRequestReferenceHost(
        {
          ...input,
          ...(requestedReference.host === undefined ? {} : { host: requestedReference.host }),
        },
        repositoryIdentity,
      )
    : input;
}

export function useOpenPanelPullRequestUrl(threadRef: ScopedThreadRef | null) {
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const requestedReference = surface?.kind === "pull-request" ? surface : null;
  const environmentId = requestedReference?.environmentId
    ? EnvironmentId.make(requestedReference.environmentId)
    : threadRef?.environmentId;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(environmentId ?? null);
  const project = useProject(
    requestedReference && environmentId
      ? scopeProjectRef(environmentId, ProjectId.make(requestedReference.projectId))
      : null,
  );
  const reference = usePanelPullRequestReference(
    requestedReference,
    supportsMultiplePullRequests,
    project?.repositoryIdentity,
  );
  const detail = useEnvironmentQuery(
    reference && environmentId
      ? pullRequestEnvironment.detail({
          environmentId,
          input: reference,
        })
      : null,
  ).data;
  const cachedDetail =
    reference && environmentId
      ? readPullRequestDetailSnapshot(
          typeof window === "undefined" ? undefined : window.localStorage,
          environmentId,
          reference,
        )
      : null;
  return reference
    ? (resolveDisplayedPullRequestDetail({ live: detail, cached: cachedDetail, reference })?.url ??
        requestedReference?.url ??
        gitHubPullRequestBrowserUrl(
          project?.repositoryIdentity,
          reference.repository,
          reference.number,
        ))
    : undefined;
}
