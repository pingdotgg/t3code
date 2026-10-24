import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";

import {
  readPullRequestDetailSnapshot,
  resolvePullRequestReferenceHost,
} from "../components/pullRequest/pullRequestDetail.logic";
import { projectChangeRequestUrl } from "@t3tools/client-runtime/change-request-links";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useProject } from "../state/entities";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useEnvironmentQuery } from "../state/query";
import { useSupportsMultiplePullRequests } from "./useSupportsMultiplePullRequests";

type PanelPullRequestSurface = Extract<
  NonNullable<ReturnType<typeof selectActiveRightPanelSurface>>,
  { kind: "pull-request" }
>;

function panelPullRequestReference(
  requestedReference: PanelPullRequestSurface | null,
  supportsMultiplePullRequests: boolean,
  repositoryIdentity: Parameters<typeof resolvePullRequestReferenceHost>[1],
) {
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
  const reference = panelPullRequestReference(
    requestedReference,
    supportsMultiplePullRequests,
    project?.repositoryIdentity,
  );
  // Everything that reads reference or the project runs before the query hook; a plain
  // call on either after it would leave reference, and the detail atom it keys, uncached.
  // The snapshot is already checked against reference, so live detail just wins below.
  const cachedDetail =
    reference && environmentId
      ? readPullRequestDetailSnapshot(
          typeof window === "undefined" ? undefined : window.localStorage,
          environmentId,
          reference,
        )
      : null;
  const fallbackUrl = reference
    ? (requestedReference?.url ??
      projectChangeRequestUrl(project?.repositoryIdentity, reference.repository, reference.number))
    : undefined;
  const detail = useEnvironmentQuery(
    reference && environmentId
      ? pullRequestEnvironment.detail({
          environmentId,
          input: reference,
        })
      : null,
  ).data;
  return reference ? ((detail ?? cachedDetail)?.url ?? fallbackUrl) : undefined;
}
