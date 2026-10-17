import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import {
  savedPullRequestStack,
  pullRequestStackView,
} from "../components/pullRequest/pullRequestStackSnapshot";
import { useThreadShells } from "./entities";
import { pullRequestStackAtom } from "./pullRequests";
import { useEnvironmentQuery } from "./query";

export function usePullRequestStack(
  environmentId: EnvironmentId,
  reference: PullRequestRef | null,
) {
  const threads = useThreadShells();
  const query = useEnvironmentQuery(
    reference === null ? null : pullRequestStackAtom({ environmentId, input: reference }),
  );
  const saved =
    reference === null
      ? null
      : savedPullRequestStack(
          threads
            .filter((thread) => thread.environmentId === environmentId)
            .flatMap((thread) => thread.pullRequests ?? []),
          reference,
        );
  return { ...query, ...pullRequestStackView(query, saved) };
}
