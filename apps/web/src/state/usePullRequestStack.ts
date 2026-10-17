import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import {
  savedPullRequestStack,
  pullRequestStackView,
} from "../components/pullRequest/pullRequestStackSnapshot";
import { useThreadShells } from "./entities";
import { pullRequestStackAtom } from "./pullRequests";
import { useEnvironmentQuery } from "./query";

function useSavedPullRequestStack(environmentId: EnvironmentId, reference: PullRequestRef | null) {
  "use memo";
  const threads = useThreadShells();
  return reference === null
    ? null
    : savedPullRequestStack(
        threads
          .filter((thread) => thread.environmentId === environmentId)
          .flatMap((thread) => thread.pullRequests ?? []),
        reference,
      );
}

export function usePullRequestStack(
  environmentId: EnvironmentId,
  reference: PullRequestRef | null,
) {
  const saved = useSavedPullRequestStack(environmentId, reference);
  const query = useEnvironmentQuery(
    reference === null ? null : pullRequestStackAtom({ environmentId, input: reference }),
  );
  return { ...query, ...pullRequestStackView(query, saved) };
}
