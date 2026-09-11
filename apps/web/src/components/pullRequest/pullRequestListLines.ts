import type { ThreadPullRequestLink } from "@t3tools/contracts";
import type { ThreadPullRequestChain } from "@t3tools/shared/threadPullRequests";

/** One line of a thread's pull-request list: a link plus how deep it sits in its stack. */
export interface PullRequestListLine {
  readonly link: ThreadPullRequestLink;
  /** 0 for a pull request on the base branch; each layer above steps in by one. */
  readonly depth: number;
  /** Which chain the line belongs to, so callers can tell one stack's lines from another's. */
  readonly chainKey: string;
  /** Set on the bottom layer of a multi-layer stack, so that row can name the whole stack. */
  readonly stack: { readonly kind: ThreadPullRequestChain["kind"]; readonly size: number } | null;
}

function chainKeyOf(chain: ThreadPullRequestChain): string {
  const bottom = chain.layers[0]!;
  return `${bottom.host}/${bottom.repository}#${bottom.number}`;
}

/**
 * Flattens chains into indented lines, highest PR number first. A stack sorts by its highest
 * numbered layer and stays together in bottom-to-top order.
 */
export function pullRequestListLines(
  chains: ReadonlyArray<ThreadPullRequestChain>,
): ReadonlyArray<PullRequestListLine> {
  const ordered = [...chains].sort(
    (left, right) =>
      Math.max(...right.layers.map((link) => link.number)) -
      Math.max(...left.layers.map((link) => link.number)),
  );
  return ordered.flatMap((chain) => {
    const chainKey = chainKeyOf(chain);
    return chain.layers.map((link, depth) => ({
      link,
      depth,
      chainKey,
      stack:
        depth === 0 && chain.layers.length > 1
          ? { kind: chain.kind, size: chain.layers.length }
          : null,
    }));
  });
}
