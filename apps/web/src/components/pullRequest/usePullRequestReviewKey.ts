import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { pullRequestReviewKey } from "./pullRequestReviewStore";

export function usePullRequestReviewKey(environmentId: EnvironmentId, reference: PullRequestRef) {
  const detail = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: { ...reference, allowStale: false } }),
  );
  return pullRequestReviewKey(reference, { environmentId, viewer: detail.data?.viewer });
}
