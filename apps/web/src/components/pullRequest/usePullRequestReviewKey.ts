import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { pullRequestReviewKey } from "./pullRequestReviewStore";

export function usePullRequestReviewScope(environmentId: EnvironmentId, reference: PullRequestRef) {
  const detail = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: { ...reference, allowStale: false } }),
  );
  return {
    key: pullRequestReviewKey(reference, { environmentId, viewer: detail.data?.viewer }),
    ready: Boolean(detail.data?.viewer?.trim()) && !detail.isPending && !detail.error,
  };
}

export function usePullRequestReviewKey(environmentId: EnvironmentId, reference: PullRequestRef) {
  return usePullRequestReviewScope(environmentId, reference).key;
}
