import { useAtomValue } from "@effect/atom-react";
import {
  ThreadPullRequestLink,
  type EnvironmentId,
  type PullRequestDetail,
  type PullRequestRef,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  savedPullRequestStack,
  pullRequestStackView,
} from "../components/pullRequest/pullRequestStackSnapshot";
import { allowsSinglePullRequestMerge } from "../components/pullRequest/pullRequestDetail.logic";
import { useServerConfigs } from "./entities";
import { pullRequestStackAtom } from "./pullRequests";
import { useEnvironmentQuery } from "./query";
import { environmentThreadShells } from "./threads";

const sameLinks = Schema.toEquivalence(Schema.Array(ThreadPullRequestLink));

// A shell update re-sends a thread's links as a new array, so equal links keep
// the previous list and a streaming thread does not re-render the stack.
const environmentPullRequestLinksAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous: ReadonlyArray<ThreadPullRequestLink> = [];
  return Atom.make((get) => {
    const next = get(environmentThreadShells.environmentThreadsAtom(environmentId)).flatMap(
      (thread) => thread.pullRequests ?? [],
    );
    if (sameLinks(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-environment-pull-request-links:${environmentId}`));
});

export function usePullRequestStack(
  environmentId: EnvironmentId,
  reference: PullRequestRef | null,
) {
  const links = useAtomValue(environmentPullRequestLinksAtom(environmentId));
  const saved = reference === null ? null : savedPullRequestStack(links, reference);
  const query = useEnvironmentQuery(
    reference === null ? null : pullRequestStackAtom({ environmentId, input: reference }),
  );
  return { ...query, ...pullRequestStackView(query, saved) };
}

/**
 * Every surface that offers Merge for one pull request reads this gate, so a stacked layer is
 * only ever merged through its stack.
 */
export function usePullRequestStackGate(
  environmentId: EnvironmentId,
  detail: Pick<PullRequestDetail, "url" | "capabilities"> | null,
  reference: PullRequestRef | null,
) {
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const supportsThreadPullRequests = capabilities?.threadPullRequests === true;
  const stack = usePullRequestStack(
    environmentId,
    reference === null ||
      detail === null ||
      detail.capabilities.stacks !== true ||
      !supportsThreadPullRequests
      ? null
      : { ...reference, host: reference.host ?? parseChangeRequestUrl(detail.url)?.host },
  );
  const supportsStackActions =
    supportsThreadPullRequests &&
    detail?.capabilities.stacks === true &&
    detail.capabilities.stackActions === true &&
    capabilities?.pullRequestStackActions === true;
  return {
    stack,
    supportsStackActions,
    canMergeSinglePullRequest: allowsSinglePullRequestMerge({
      supportsStackActions,
      hasStack: stack.data !== null,
      stackPending: !stack.isFresh,
      stackError: stack.error,
    }),
  };
}
