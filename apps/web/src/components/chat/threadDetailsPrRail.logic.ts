import type { ThreadPullRequestLink } from "@t3tools/contracts";
import {
  pullRequestListLines,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
  type PullRequestListLine,
} from "@t3tools/shared/threadPullRequests";

export interface PrRailGroup {
  readonly key: string;
  /** Tip first, base last: the order the stack reads on the host. */
  readonly layers: ReadonlyArray<ThreadPullRequestLink>;
  readonly base: string | null;
}

export function threadDetailsPrGroups(
  links: ReadonlyArray<ThreadPullRequestLink>,
  currentLink: ThreadPullRequestLink | null,
): { readonly current: PrRailGroup | null; readonly others: ReadonlyArray<PrRailGroup> } {
  const byChain = new Map<string, Array<PullRequestListLine>>();
  for (const line of pullRequestListLines(
    resolveThreadPullRequestChains(visibleThreadPullRequests(links)),
  )) {
    const lines = byChain.get(line.chainKey) ?? [];
    lines.push(line);
    byChain.set(line.chainKey, lines);
  }
  // A derived chain is a tree: PRs that share a base branch are siblings, not layers of one
  // stack. Only a chain where each line sits one level above the last reads as a rail.
  const chains = [...byChain].flatMap(([key, lines]) =>
    lines.every((line, index) => line.depth === index)
      ? [{ key, baseFirst: lines.map((line) => line.link) }]
      : lines.map((line) => ({ key: threadPullRequestKeyOf(line.link), baseFirst: [line.link] })),
  );
  const currentKey = currentLink === null ? null : threadPullRequestKeyOf(currentLink);
  let current: PrRailGroup | null = null;
  const others: Array<PrRailGroup> = [];
  for (const { key, baseFirst } of chains) {
    const bottom = baseFirst[0]!;
    const group = {
      key,
      layers: baseFirst.toReversed(),
      base: bottom.stack?.base ?? bottom.snapshot?.baseBranch ?? null,
    };
    if (current === null && baseFirst.some((link) => threadPullRequestKeyOf(link) === currentKey)) {
      current = group;
    } else {
      others.push(group);
    }
  }
  return { current, others };
}

export type PrRailItem =
  | { readonly kind: "layer"; readonly link: ThreadPullRequestLink }
  | { readonly kind: "fold"; readonly first: ThreadPullRequestLink; readonly count: number };

const RAIL_EDGE = 2;
const RAIL_RADIUS = 2;

/**
 * Long stacks keep the tip, the base, and the layers around the current one; every gap
 * between them collapses into one fold.
 */
export function prRailItems(
  layers: ReadonlyArray<ThreadPullRequestLink>,
  currentLink: ThreadPullRequestLink | null,
  unfolded: boolean,
): ReadonlyArray<PrRailItem> {
  const currentKey = currentLink === null ? null : threadPullRequestKeyOf(currentLink);
  const anchor = layers.findIndex((link) => threadPullRequestKeyOf(link) === currentKey);
  const kept = (index: number) =>
    unfolded ||
    index < RAIL_EDGE ||
    index >= layers.length - RAIL_EDGE ||
    (anchor >= 0 && Math.abs(index - anchor) <= RAIL_RADIUS);
  const items: Array<PrRailItem> = [];
  let hidden = 0;
  layers.forEach((link, index) => {
    if (!kept(index)) {
      hidden += 1;
      return;
    }
    // A fold that would hide a single layer takes as much room as the layer itself.
    if (hidden === 1) items.push({ kind: "layer", link: layers[index - 1]! });
    else if (hidden > 1)
      items.push({ kind: "fold", first: layers[index - hidden]!, count: hidden });
    hidden = 0;
    items.push({ kind: "layer", link });
  });
  return items;
}

export type PrRailBlocker = "failing" | "conflicting" | "draft" | "closed";

/** A stack merges as one unit, so any unmerged layer that cannot merge blocks the stack. */
export function prRailBlocker(
  layers: ReadonlyArray<ThreadPullRequestLink>,
): { readonly link: ThreadPullRequestLink; readonly reason: PrRailBlocker } | null {
  for (const link of layers.toReversed()) {
    const snapshot = link.snapshot;
    if (snapshot === null || snapshot.state === "merged") continue;
    if (snapshot.state === "closed") return { link, reason: "closed" };
    if (snapshot.isDraft) return { link, reason: "draft" };
    if (snapshot.mergeability === "conflicting") return { link, reason: "conflicting" };
    if (snapshot.checksState === "failing") return { link, reason: "failing" };
  }
  return null;
}
