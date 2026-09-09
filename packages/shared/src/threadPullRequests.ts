import type {
  RepositoryIdentity,
  SourceControlProviderKind,
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

import { pullRequestHostOf } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "./changeRequestUrl.ts";
import { canonicalRepositoryKey, sourceControlRepositorySelector } from "./sourceControl.ts";

/** Normalize stored link identity, including Azure's SSH and browser host aliases. */
export function normalizeThreadPullRequestKey(key: ThreadPullRequestKey): ThreadPullRequestKey {
  const canonical = canonicalRepositoryKey(
    `${key.host.trim().toLowerCase()}/${key.repository.trim().toLowerCase()}`,
  );
  const separator = canonical.indexOf("/");
  return {
    host: canonical.slice(0, separator),
    repository: canonical.slice(separator + 1),
    number: key.number,
  };
}

/** Legacy Azure selectors omit the organization and project; recover those from the PR URL. */
export function legacyThreadPullRequestKey(
  linked: Pick<ThreadLinkedPullRequest, "repository" | "number" | "url">,
  fallbackHost?: string,
): ThreadPullRequestKey {
  const parsed = parseChangeRequestUrl(linked.url);
  if (parsed !== null && parsed.number === linked.number) {
    const canonical = canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`);
    if (canonical.startsWith("dev.azure.com/")) {
      return normalizeThreadPullRequestKey(parsed);
    }
  }
  let host = fallbackHost;
  if (host === undefined) {
    try {
      host = new URL(linked.url).hostname;
    } catch {
      host = "unknown";
    }
  }
  return {
    host: host.trim().toLowerCase() || "unknown",
    repository: linked.repository.trim().toLowerCase(),
    number: linked.number,
  };
}

/** Identity comparison for links: host-level, case-insensitive on host and repository. */
export function threadPullRequestKeysEqual(
  left: ThreadPullRequestKey,
  right: ThreadPullRequestKey,
): boolean {
  return threadPullRequestKeyOf(left) === threadPullRequestKeyOf(right);
}

export function threadPullRequestKeyOf(key: ThreadPullRequestKey): string {
  const normalized = normalizeThreadPullRequestKey(key);
  return `${normalized.host}/${normalized.repository}#${normalized.number}`;
}

/** Links a user should see. Tombstoned stack members stay in the array only so the
 * sync reactor does not re-add them. */
export function visibleThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestLink> {
  return links.filter((link) => link.source !== "stack-dismissed");
}

function isOpen(link: ThreadPullRequestLink): boolean {
  // Unsynced links are treated as open: they were just linked, and hiding them
  // behind a terminal PR until the first sync would make the link look lost.
  return link.snapshot === null || link.snapshot.state === "open";
}

function latestUpdatedAt(link: ThreadPullRequestLink): number {
  const value = link.snapshot?.updatedAt ?? link.linkedAt;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/** The single pull request a one-slot surface (sidebar badge, tab icon, copy link) shows. */
export type ThreadCurrentPullRequest =
  | { readonly kind: "single"; readonly link: ThreadPullRequestLink }
  | {
      readonly kind: "stack";
      readonly open: ReadonlyArray<ThreadPullRequestLink>;
      /** Highest layer of the open set; the one "View PR" and copy-link target. */
      readonly top: ThreadPullRequestLink;
    };

/**
 * Prefer open work and the highest open layer within a chain. A completed chain still
 * points at its top; unrelated terminal links use the most recently updated request.
 */
export function resolveThreadCurrentPullRequest(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ThreadCurrentPullRequest | null {
  const visible = visibleThreadPullRequests(links);
  if (visible.length === 0) return null;
  const open = visible.filter(isOpen);
  if (open.length === 1) return { kind: "single", link: open[0]! };
  const chains = resolveThreadPullRequestChains(visible);
  if (open.length > 1) {
    const openChains = chains
      .map((chain) => chain.layers.toReversed().filter(isOpen))
      .filter((layers) => layers.length > 0)
      .sort(
        (left, right) =>
          Math.max(...right.map((link) => Date.parse(link.linkedAt))) -
          Math.max(...left.map((link) => Date.parse(link.linkedAt))),
      );
    const ordered = openChains.flat();
    return { kind: "stack", open: ordered, top: ordered[0]! };
  }
  if (chains.length === 1) {
    return { kind: "single", link: chains[0]!.layers.at(-1)! };
  }
  const terminal = [...visible].sort(
    (left, right) => latestUpdatedAt(right) - latestUpdatedAt(left),
  );
  return { kind: "single", link: terminal[0]! };
}

/** The one link a legacy `linkedPullRequest` consumer should see, or null. */
export function resolveThreadCurrentPullRequestLink(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ThreadPullRequestLink | null {
  const current = resolveThreadCurrentPullRequest(links);
  if (current === null) return null;
  return current.kind === "single" ? current.link : current.top;
}

/** Legacy clients can only route links belonging to the thread's own repository. */
export function legacyLinkedPullRequestOf(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: ThreadLinkedPullRequest["projectId"],
  identity: RepositoryIdentity | null | undefined,
): ThreadLinkedPullRequest | null {
  if (!identity) return null;
  const host = pullRequestHostOf(identity, identity.provider as SourceControlProviderKind);
  const repository = sourceControlRepositorySelector(identity);
  if (repository === null) return null;
  const azureKey =
    identity.provider === "azure-devops"
      ? canonicalRepositoryKey(identity.canonicalKey.toLowerCase())
      : null;
  const link = resolveThreadCurrentPullRequestLink(
    links.filter((link) => {
      if (azureKey !== null) {
        const key = legacyThreadPullRequestKey(link, link.host);
        return canonicalRepositoryKey(`${key.host}/${key.repository}`) === azureKey;
      }
      return (
        link.host.toLowerCase() === host.toLowerCase() &&
        link.repository.toLowerCase() === repository.toLowerCase()
      );
    }),
  );
  if (link === null) return null;
  return {
    projectId,
    repository: azureKey === null ? link.repository : repository,
    number: link.number,
    url: link.url,
  };
}

export interface ThreadPullRequestChain {
  readonly kind: "native" | "derived";
  /** Bottom to top. */
  readonly layers: ReadonlyArray<ThreadPullRequestLink>;
}

/**
 * Groups a thread's links into stacks. Native stacks come from the host and win; the rest
 * are chained by matching one link's base branch to another's head branch within the same
 * repository. A link that chains to nothing is a one-layer chain.
 */
export function resolveThreadPullRequestChains(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestChain> {
  const visible = visibleThreadPullRequests(links);
  const chains: Array<ThreadPullRequestChain> = [];
  const placed = new Set<string>();

  const nativeStacks = new Map<string, Array<ThreadPullRequestLink>>();
  for (const link of visible) {
    if (link.stack === null) continue;
    const stackKey = `${link.host.toLowerCase()}/${link.repository.toLowerCase()}#stack:${link.stack.id}`;
    const members = nativeStacks.get(stackKey) ?? [];
    members.push(link);
    nativeStacks.set(stackKey, members);
  }
  for (const members of nativeStacks.values()) {
    const order = new Map(members[0]!.stack!.layers.map((layer, index) => [layer.number, index]));
    members.sort((left, right) => (order.get(left.number) ?? 0) - (order.get(right.number) ?? 0));
    for (const member of members) placed.add(threadPullRequestKeyOf(member));
    chains.push({ kind: "native", layers: members });
  }

  const remaining = visible.filter((link) => !placed.has(threadPullRequestKeyOf(link)));
  const branchKey = (link: ThreadPullRequestLink, branch: string) =>
    `${link.host.toLowerCase()}/${link.repository.toLowerCase()}:${branch}`;
  // Reused head names cannot identify a parent unambiguously.
  const byHead = new Map<string, ThreadPullRequestLink | null>();
  for (const link of remaining) {
    if (link.snapshot === null) continue;
    const key = branchKey(link, link.snapshot.headBranch);
    byHead.set(key, byHead.has(key) ? null : link);
  }
  const hasChild = new Set<string>();
  for (const link of remaining) {
    if (link.snapshot === null) continue;
    const parent = byHead.get(branchKey(link, link.snapshot.baseBranch));
    if (parent != null && parent !== link) hasChild.add(threadPullRequestKeyOf(parent));
  }
  // Walk from each top (a link nothing builds on) down its base chain.
  for (const top of remaining) {
    if (hasChild.has(threadPullRequestKeyOf(top))) continue;
    const layers: Array<ThreadPullRequestLink> = [];
    let cursor: ThreadPullRequestLink | undefined = top;
    while (cursor !== undefined && !placed.has(threadPullRequestKeyOf(cursor))) {
      placed.add(threadPullRequestKeyOf(cursor));
      layers.unshift(cursor);
      cursor =
        cursor.snapshot === null
          ? undefined
          : (byHead.get(branchKey(cursor, cursor.snapshot.baseBranch)) ?? undefined);
    }
    if (layers.length > 0) chains.push({ kind: "derived", layers });
  }
  // Cycles have no top. Keep those links visible without inventing a stack order.
  for (const link of remaining) {
    if (!placed.has(threadPullRequestKeyOf(link))) {
      chains.push({ kind: "derived", layers: [link] });
    }
  }
  return chains;
}

export type ThreadPullRequestBadge =
  | {
      readonly kind: "stack";
      readonly layers: number;
      readonly state: "open" | "closed" | "merged";
    }
  | { readonly kind: "pull-request"; readonly others: number };

/** Aggregate a single chain's state; unrelated links show a count beside the current PR. */
export function resolveThreadPullRequestBadge(
  pullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined,
): ThreadPullRequestBadge | null {
  const visible = visibleThreadPullRequests(pullRequests ?? []);
  if (visible.length === 0) return null;
  const chains = resolveThreadPullRequestChains(visible);
  if (visible.length > 1 && chains.length === 1) {
    const states = visible.map((link) => link.snapshot?.state ?? "open");
    const state = states.includes("open")
      ? "open"
      : states.every((entry) => entry === "merged")
        ? "merged"
        : "closed";
    return { kind: "stack", layers: visible.length, state };
  }
  return { kind: "pull-request", others: visible.length - 1 };
}

/** Search terms for visible PR links, including the legacy single-link projection. */
export function threadPullRequestSearchTerms(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): string[] {
  if (thread.pullRequests !== undefined && thread.pullRequests.length > 0) {
    return visibleThreadPullRequests(thread.pullRequests).flatMap((link) => [
      `#${link.number}`,
      `${link.repository}#${link.number}`,
      link.url,
      link.snapshot?.title ?? "",
    ]);
  }
  const legacy = thread.linkedPullRequest;
  return legacy ? [`#${legacy.number}`, `${legacy.repository}#${legacy.number}`, legacy.url] : [];
}
