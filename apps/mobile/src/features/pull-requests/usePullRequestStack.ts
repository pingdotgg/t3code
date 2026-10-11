import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import type { PullRequestDetail } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { useMemo } from "react";
import { useEnvironmentServerConfig, useNavigationThreadShells } from "../../state/entities";
import { pullRequestStackAtom } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { savedPullRequestStack } from "./pullRequestStack";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export function usePullRequestStack(params: PullRequestParams, pr: PullRequestDetail | null) {
  const target = pullRequestTarget(params);
  const config = useEnvironmentServerConfig(target.environmentId);
  const threads = useNavigationThreadShells();
  const supported =
    threadPullRequestLinkMode(config?.environment.capabilities) === "multiple" &&
    pr?.capabilities.stacks === true;
  const reference = useMemo(
    () => ({
      ...pullRequestTarget(params).input,
      host: params.host ?? (pr ? parseChangeRequestUrl(pr.url)?.host : undefined),
    }),
    [params, pr],
  );
  const saved = useMemo(
    () =>
      savedPullRequestStack(
        threads
          .filter((thread) => thread.environmentId === target.environmentId)
          .flatMap((thread) => thread.pullRequests ?? []),
        reference,
      ),
    [threads, target.environmentId, reference],
  );
  const query = useEnvironmentQuery(
    supported ? pullRequestStackAtom({ ...target, input: reference }) : null,
  );
  const stack = query.isSuccess ? query.data : (query.data ?? saved);
  return {
    ...query,
    stack,
    isFresh: supported && query.isSuccess && !query.isPending,
    supportsStackActions:
      supported &&
      pr?.capabilities.stackActions === true &&
      config?.environment.capabilities.pullRequestStackActions === true,
  };
}

export type PullRequestStackState = ReturnType<typeof usePullRequestStack>;
