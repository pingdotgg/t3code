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

function activityAt(link: ThreadPullRequestLink): number {
  const ms = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

function chainKeyOf(chain: ThreadPullRequestChain): string {
  const bottom = chain.layers[0]!;
  return `${bottom.host}/${bottom.repository}#${bottom.number}`;
}

/**
 * Flattens chains into indented lines, newest first. A stack sorts by its most recent layer and
 * then reads bottom to top beneath that slot, so the layer you would review first is at the
 * bottom of the indent and a fresh push anywhere in the stack floats the whole stack up.
 */
export function pullRequestListLines(
  chains: ReadonlyArray<ThreadPullRequestChain>,
): ReadonlyArray<PullRequestListLine> {
  const ordered = [...chains].sort(
    (left, right) =>
      Math.max(...right.layers.map(activityAt)) - Math.max(...left.layers.map(activityAt)),
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

export interface PullRequestRepositoryGroup {
  readonly key: string;
  /** The repository path, prefixed with its host when another group shares that path. */
  readonly label: string;
  readonly lines: ReadonlyArray<PullRequestListLine>;
}

/**
 * Groups lines by repository in the order each repository first appears, keeping each group's
 * line order, so a stack stays contiguous under its repository.
 */
export function groupPullRequestListLinesByRepository(
  lines: ReadonlyArray<PullRequestListLine>,
): ReadonlyArray<PullRequestRepositoryGroup> {
  const groups = new Map<
    string,
    { repository: string; host: string; lines: PullRequestListLine[] }
  >();
  for (const line of lines) {
    const key = `${line.link.host}/${line.link.repository}`.toLowerCase();
    const group = groups.get(key);
    if (group) group.lines.push(line);
    else groups.set(key, { repository: line.link.repository, host: line.link.host, lines: [line] });
  }
  const pathCounts = new Map<string, number>();
  for (const group of groups.values()) {
    const path = group.repository.toLowerCase();
    pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  }
  return [...groups].map(([key, group]) => ({
    key,
    label:
      (pathCounts.get(group.repository.toLowerCase()) ?? 0) > 1
        ? `${group.host}/${group.repository}`
        : group.repository,
    lines: group.lines,
  }));
}
