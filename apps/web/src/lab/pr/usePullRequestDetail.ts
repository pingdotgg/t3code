// Lab: the PR panel's detail comes from a real PR's fixture instead of the server.
import type { PullRequestRef } from "@t3tools/contracts";
import { LAB_PULL_REQUEST } from "./fixture";

export * from "~/components/pullRequest/usePullRequestDetail";
export const usePullRequestDetail = ((_environmentId: unknown, reference: PullRequestRef) => {
  const detail = {
    ...LAB_PULL_REQUEST,
    number: reference.number,
    repository: reference.repository,
  };
  return {
    canWriteSourceControl: true,
    detailQuery: { isPending: false, isSuccess: true, error: null, refresh: () => undefined },
    activityQuery: { isPending: false, isSuccess: true, error: null, refresh: () => undefined },
    activity: null,
    sharedSummary: detail,
    coreDetail: detail,
    detail,
  };
}) as never;
