import { useAtomValue } from "@effect/atom-react";
import { ThreadPullRequestLink, type EnvironmentId, type PullRequestRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  savedPullRequestStack,
  pullRequestStackView,
} from "../components/pullRequest/pullRequestStackSnapshot";
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
