import type { ThreadLinkedPullRequest } from "@t3tools/contracts";

/**
 * Pure derivation of pull-request stacks for the sidebar's active section.
 *
 * A stack is a chain of open PRs in one project where each PR's base ref is
 * another's head ref (the GitButler / stacked-PR workflow). Threads whose
 * displayed PRs chain render as one group; chain positions whose PR has no
 * thread anywhere render as slim ghost entries inside the group. Everything
 * here works on data the sidebar already holds — no requests, no effects.
 */

export interface SidebarStackPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRef: string;
  readonly baseRef: string;
  /** Prebuilt link payload for "open a thread on this PR". Present on
      open-list entries (ghost candidates); thread-backed PRs don't need it. */
  readonly link?: ThreadLinkedPullRequest;
}

interface StackThreadShape {
  readonly environmentId: string;
  readonly projectId: string;
  readonly id: string;
}

export interface SidebarStackEntry<T extends StackThreadShape> {
  readonly pr: SidebarStackPullRequest;
  /** null = ghost: the PR exists on the host but no visible thread drives it. */
  readonly thread: T | null;
}

export interface SidebarStackGroupModel<T extends StackThreadShape> {
  readonly key: string;
  /** The group's most recent member thread; carries the scoped project ref
      for actions (ghost click) without the module knowing branded types. */
  readonly anchor: T;
  /** Top of stack first, base last. */
  readonly entries: readonly SidebarStackEntry<T>[];
}

export type SidebarActiveListItem<T extends StackThreadShape> =
  | { readonly kind: "thread"; readonly thread: T }
  | { readonly kind: "stack"; readonly group: SidebarStackGroupModel<T> };

/** Unambiguous: a raw `env:project` join collides for ids that contain the
    separator, which would let one project's threads suppress another's ghosts. */
export function sidebarStackProjectKey(ref: {
  readonly environmentId: string;
  readonly projectId: string;
}): string {
  return JSON.stringify([ref.environmentId, ref.projectId]);
}

/** Projects whose active threads display ≥2 open PRs — the only ones worth an
    open-PR list read for ghost discovery. Sorted for a stable query key. */
export function stackOpenPrListProjectRefs<T extends StackThreadShape>(input: {
  readonly activeThreads: readonly T[];
  readonly threadKeyOf: (thread: T) => string;
  readonly displayedOpenPrByThreadKey: ReadonlyMap<string, SidebarStackPullRequest>;
}): Array<{ environmentId: T["environmentId"]; projectId: T["projectId"] }> {
  const counts = new Map<string, { thread: T; count: number }>();
  for (const thread of input.activeThreads) {
    if (!input.displayedOpenPrByThreadKey.has(input.threadKeyOf(thread))) continue;
    const projectKey = sidebarStackProjectKey(thread);
    const existing = counts.get(projectKey);
    if (existing) existing.count += 1;
    else counts.set(projectKey, { thread, count: 1 });
  }
  return [...counts.entries()]
    .filter(([, value]) => value.count >= 2)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => ({
      environmentId: value.thread.environmentId,
      projectId: value.thread.projectId,
    }));
}

interface StackMember<T extends StackThreadShape> {
  readonly pr: SidebarStackPullRequest;
  readonly thread: T | null;
  readonly threadKey: string | null;
}

export function planActiveThreadsWithStacks<T extends StackThreadShape>(input: {
  readonly activeThreads: readonly T[];
  readonly threadKeyOf: (thread: T) => string;
  /** Each active thread's displayed pull request, open state only. */
  readonly displayedOpenPrByThreadKey: ReadonlyMap<string, SidebarStackPullRequest>;
  /** Open PRs per project key (ghost candidates), from the open-PR list. */
  readonly openPrsByProjectKey: ReadonlyMap<string, readonly SidebarStackPullRequest[]>;
  /** PR numbers displayed by ANY visible thread (pinned/snoozed/settled
      included), per project key. Suppresses ghosts for PRs that already have
      a thread outside the active section. */
  readonly threadBackedPrNumbersByProjectKey: ReadonlyMap<string, ReadonlySet<number>>;
}): Array<SidebarActiveListItem<T>> {
  const nodesByProject = new Map<string, Array<{ thread: T; threadKey: string }>>();
  for (const thread of input.activeThreads) {
    const threadKey = input.threadKeyOf(thread);
    if (!input.displayedOpenPrByThreadKey.has(threadKey)) continue;
    const projectKey = sidebarStackProjectKey(thread);
    const nodes = nodesByProject.get(projectKey);
    if (nodes) nodes.push({ thread, threadKey });
    else nodesByProject.set(projectKey, [{ thread, threadKey }]);
  }

  const groupByAnchorThreadKey = new Map<string, SidebarStackGroupModel<T>>();
  const groupedThreadKeys = new Set<string>();

  for (const [projectKey, nodes] of nodesByProject) {
    if (nodes.length < 2) continue;
    // Membership: active threads' PRs win over list entries with the same
    // number, so a slightly stale list can never demote a thread to a ghost.
    const members = new Map<number, StackMember<T>>();
    for (const node of nodes) {
      const pr = input.displayedOpenPrByThreadKey.get(node.threadKey);
      if (pr === undefined || members.has(pr.number)) continue;
      members.set(pr.number, { pr, thread: node.thread, threadKey: node.threadKey });
    }
    for (const pr of input.openPrsByProjectKey.get(projectKey) ?? []) {
      if (members.has(pr.number)) continue;
      members.set(pr.number, { pr, thread: null, threadKey: null });
    }

    // A sits on B when A.baseRef === B.headRef. Duplicate head refs keep the
    // first claimant; a repo in that state has no honest chain to draw.
    const numberByHeadRef = new Map<string, number>();
    for (const member of members.values()) {
      if (!numberByHeadRef.has(member.pr.headRef)) {
        numberByHeadRef.set(member.pr.headRef, member.pr.number);
      }
    }
    const baseOf = (number: number): number | undefined => {
      const member = members.get(number);
      if (member === undefined) return undefined;
      const below = numberByHeadRef.get(member.pr.baseRef);
      return below === number ? undefined : below;
    };
    // A rail is a line, and two PRs based on the same branch are not one:
    // they are siblings, and drawing them one above the other would claim an
    // order the repository does not have. Where a PR carries more than one PR
    // on top of it, the fork is dropped rather than flattened.
    const aboveCount = new Map<number, number>();
    for (const number of members.keys()) {
      const below = baseOf(number);
      if (below === undefined) continue;
      aboveCount.set(below, (aboveCount.get(below) ?? 0) + 1);
    }
    const belowOf = (number: number): number | undefined => {
      const below = baseOf(number);
      return below !== undefined && aboveCount.get(below) === 1 ? below : undefined;
    };

    // Connected components via union-find over PR numbers.
    const parent = new Map<number, number>();
    const find = (start: number): number => {
      let n = start;
      while ((parent.get(n) ?? n) !== n) n = parent.get(n) ?? n;
      parent.set(start, n);
      return n;
    };
    for (const number of members.keys()) parent.set(number, number);
    for (const number of members.keys()) {
      const below = belowOf(number);
      if (below !== undefined) parent.set(find(number), find(below));
    }
    const componentsByRoot = new Map<number, number[]>();
    for (const number of members.keys()) {
      const root = find(number);
      const component = componentsByRoot.get(root);
      if (component) component.push(number);
      else componentsByRoot.set(root, [number]);
    }

    for (const component of componentsByRoot.values()) {
      const threadMembers = component
        .map((number) => members.get(number))
        .filter((member): member is StackMember<T> => member?.thread != null);
      if (threadMembers.length < 2) continue;

      // Depth from the base (0), walking baseRef links; cycles bottom out at 0.
      const depthCache = new Map<number, number>();
      const depthOf = (start: number): number => {
        const cached = depthCache.get(start);
        if (cached !== undefined) return cached;
        const chain: number[] = [];
        const seen = new Set<number>();
        let current: number | undefined = start;
        let base = -1;
        while (current !== undefined) {
          const known = depthCache.get(current);
          if (known !== undefined) {
            base = known;
            break;
          }
          if (seen.has(current)) break;
          seen.add(current);
          chain.push(current);
          current = belowOf(current);
        }
        for (let index = chain.length - 1; index >= 0; index -= 1) {
          base += 1;
          depthCache.set(chain[index] as number, base);
        }
        return depthCache.get(start) ?? 0;
      };

      const backedNumbers = input.threadBackedPrNumbersByProjectKey.get(projectKey);
      const entries = component
        .map((number) => members.get(number))
        .filter((member): member is StackMember<T> => member !== undefined)
        // A PR driven by a pinned/snoozed/settled thread is neither a card
        // here nor a ghost: it renders in its own section and the rail
        // simply skips it.
        .filter((member) => member.thread !== null || backedNumbers?.has(member.pr.number) !== true)
        .sort((left, right) => {
          const depthDelta = depthOf(right.pr.number) - depthOf(left.pr.number);
          return depthDelta !== 0 ? depthDelta : right.pr.number - left.pr.number;
        })
        .map((member) => ({ pr: member.pr, thread: member.thread }));

      const componentNumbers = new Set(component);
      const anchorNode = nodes.find((node) => {
        const pr = input.displayedOpenPrByThreadKey.get(node.threadKey);
        return pr !== undefined && componentNumbers.has(pr.number);
      });
      if (anchorNode === undefined) continue;
      for (const member of threadMembers) {
        if (member.threadKey !== null) groupedThreadKeys.add(member.threadKey);
      }
      groupByAnchorThreadKey.set(anchorNode.threadKey, {
        key: `stack:${projectKey}:${Math.min(...component)}`,
        anchor: anchorNode.thread,
        entries,
      });
    }
  }

  const items: Array<SidebarActiveListItem<T>> = [];
  for (const thread of input.activeThreads) {
    const threadKey = input.threadKeyOf(thread);
    const group = groupByAnchorThreadKey.get(threadKey);
    if (group) {
      items.push({ kind: "stack", group });
      continue;
    }
    if (groupedThreadKeys.has(threadKey)) continue;
    items.push({ kind: "thread", thread });
  }
  return items;
}
