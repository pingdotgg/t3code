import type {
  OrchestrationV2AppThread,
  RepositoryIdentity,
  SourceControlProviderKind,
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

import { pullRequestHostOf } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "./changeRequestUrl.ts";
import { canonicalRepositoryKey, sourceControlRepositorySelector } from "./sourceControl.ts";

type ThreadPullRequestKeySource = ThreadPullRequestKey & {
  readonly authority?: string;
  readonly url?: string;
};

export function normalizeThreadPullRequestKey(
  key: ThreadPullRequestKeySource,
): ThreadPullRequestKey {
  const parsed = key.url === undefined ? null : parseChangeRequestUrl(key.url);
  const authority =
    key.authority ??
    (parsed?.repository === key.repository.trim().toLowerCase() && parsed.number === key.number
      ? parsed.authority
      : undefined);
  const canonical = canonicalRepositoryKey(
    `${(authority ?? key.host).trim().toLowerCase()}/${key.repository.trim().toLowerCase()}`,
  );
  const separator = canonical.indexOf("/");
  return {
    host: canonical.slice(0, separator),
    repository: canonical.slice(separator + 1),
    number: key.number,
  };
}

export function legacyThreadPullRequestKey(
  linked: Pick<ThreadLinkedPullRequest, "repository" | "number" | "url">,
  fallbackHost?: string,
): ThreadPullRequestKey {
  const parsed = parseChangeRequestUrl(linked.url);
  if (parsed !== null && parsed.number === linked.number) {
    const canonical = canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`);
    if (parsed.authority !== undefined || canonical.startsWith("dev.azure.com/")) {
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

export function threadPullRequestKeysEqual(
  left: ThreadPullRequestKeySource,
  right: ThreadPullRequestKeySource,
): boolean {
  return threadPullRequestKeyOf(left) === threadPullRequestKeyOf(right);
}

export function threadPullRequestKeyOf(key: ThreadPullRequestKeySource): string {
  const normalized = normalizeThreadPullRequestKey(key);
  return `${normalized.host}/${normalized.repository}#${normalized.number}`;
}

/** Tombstoned stack members stay in the array only so the
 * sync reactor does not re-add them. */
export function visibleThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestLink> {
  return links.filter((link) => link.source !== "stack-dismissed");
}

function isOpen(link: ThreadPullRequestLink): boolean {
  return link.snapshot === null || link.snapshot.state === "open";
}

function latestUpdatedAt(link: ThreadPullRequestLink): number {
  const value = link.snapshot?.updatedAt ?? link.linkedAt;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export type ThreadCurrentPullRequest =
  | { readonly kind: "single"; readonly link: ThreadPullRequestLink }
  | {
      readonly kind: "stack";
      readonly open: ReadonlyArray<ThreadPullRequestLink>;
      readonly top: ThreadPullRequestLink;
    };

function layersFromTop(chain: ThreadPullRequestChain): Array<ThreadPullRequestLink> {
  // `.sort()` on a fresh array, not `.toSorted()`: this runs on Hermes, which has no ES2023
  // array methods, and a TypeError here is fatal on every mobile launch that renders a stack.
  return chain.layers
    .map((link, index) => ({ link, index, depth: chain.depths[index]! }))
    .sort((left, right) => right.depth - left.depth || right.index - left.index)
    .map((entry) => entry.link);
}

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
      .map((chain) => layersFromTop(chain).filter(isOpen))
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
    return { kind: "single", link: layersFromTop(chains[0]!)[0]! };
  }
  const terminal = [...visible].sort(
    (left, right) => latestUpdatedAt(right) - latestUpdatedAt(left),
  );
  return { kind: "single", link: terminal[0]! };
}

export function resolveThreadCurrentPullRequestLink(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ThreadPullRequestLink | null {
  const current = resolveThreadCurrentPullRequest(links);
  if (current === null) return null;
  return current.kind === "single" ? current.link : current.top;
}

export function legacyLinkedPullRequestOf(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: ThreadLinkedPullRequest["projectId"],
  identity: RepositoryIdentity | null | undefined,
): ThreadLinkedPullRequest | null {
  if (!identity) return null;
  const host = pullRequestHostOf(identity, identity.provider as SourceControlProviderKind);
  if (typeof host !== "string") return null;
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
      const parsed = parseChangeRequestUrl(link.url);
      if (parsed?.authority !== undefined) {
        try {
          const remote = new URL(identity.locator.remoteUrl);
          if (remote.protocol === "http:" || remote.protocol === "https:") {
            return (
              parsed.authority === remote.host && parsed.repository === repository.toLowerCase()
            );
          }
        } catch {}
        return parsed.host === host && parsed.repository === repository.toLowerCase();
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
  readonly layers: ReadonlyArray<ThreadPullRequestLink>;
  /** One per layer: 0 for the base, parent's depth + 1 above it. Siblings share a depth. */
  readonly depths: ReadonlyArray<number>;
}

export function resolveThreadPullRequestChains(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestChain> {
  const visible = visibleThreadPullRequests(links);
  const chains: Array<ThreadPullRequestChain> = [];
  const placed = new Set<string>();

  const nativeStacks = new Map<string, Array<ThreadPullRequestLink>>();
  for (const link of visible) {
    if (link.stack === null) continue;
    const key = normalizeThreadPullRequestKey(link);
    const stackKey = `${key.host}/${key.repository}#stack:${link.stack.id}`;
    const members = nativeStacks.get(stackKey) ?? [];
    members.push(link);
    nativeStacks.set(stackKey, members);
  }
  for (const members of nativeStacks.values()) {
    const order = new Map(members[0]!.stack!.layers.map((layer, index) => [layer.number, index]));
    members.sort((left, right) => (order.get(left.number) ?? 0) - (order.get(right.number) ?? 0));
    for (const member of members) placed.add(threadPullRequestKeyOf(member));
    chains.push({ kind: "native", layers: members, depths: members.map((_, index) => index) });
  }

  const remaining = visible.filter((link) => !placed.has(threadPullRequestKeyOf(link)));
  const branchKey = (link: ThreadPullRequestLink, branch: string) => {
    const key = normalizeThreadPullRequestKey(link);
    return `${key.host}/${key.repository}:${branch}`;
  };
  const byHead = new Map<string, ThreadPullRequestLink | null>();
  for (const link of remaining) {
    if (link.snapshot === null) continue;
    const key = branchKey(link, link.snapshot.headBranch);
    byHead.set(key, byHead.has(key) ? null : link);
  }
  const parentOf = (link: ThreadPullRequestLink) => {
    if (link.snapshot === null) return undefined;
    const parent = byHead.get(branchKey(link, link.snapshot.baseBranch));
    return parent == null || parent === link ? undefined : parent;
  };
  const children = new Map<string, Array<ThreadPullRequestLink>>();
  for (const link of remaining) {
    const parent = parentOf(link);
    if (parent === undefined) continue;
    const key = threadPullRequestKeyOf(parent);
    const siblings = children.get(key) ?? [];
    siblings.push(link);
    children.set(key, siblings);
  }
  for (const base of remaining) {
    if (parentOf(base) !== undefined) continue;
    const layers: Array<ThreadPullRequestLink> = [];
    const depths: Array<number> = [];
    const pending: Array<{ readonly link: ThreadPullRequestLink; readonly depth: number }> = [
      { link: base, depth: 0 },
    ];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const key = threadPullRequestKeyOf(next.link);
      // Two links with one identity would otherwise share a child list and expand forever.
      if (placed.has(key)) continue;
      placed.add(key);
      layers.push(next.link);
      depths.push(next.depth);
      const below = children.get(key) ?? [];
      for (let index = below.length - 1; index >= 0; index -= 1) {
        pending.push({ link: below[index]!, depth: next.depth + 1 });
      }
    }
    if (layers.length > 0) chains.push({ kind: "derived", layers, depths });
  }
  for (const link of remaining) {
    if (!placed.has(threadPullRequestKeyOf(link))) {
      chains.push({ kind: "derived", layers: [link], depths: [0] });
    }
  }
  return chains;
}

export type ThreadPullRequestBadge = {
  readonly state: "open" | "closed" | "merged" | "draft";
} & (
  | {
      readonly kind: "stack";
      readonly layers: number;
    }
  | { readonly kind: "pull-request"; readonly others: number }
);

export function resolveThreadPullRequestBadge(
  pullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined,
): ThreadPullRequestBadge | null {
  const visible = visibleThreadPullRequests(pullRequests ?? []);
  if (visible.length === 0) return null;
  const states = visible.map((link) => link.snapshot?.state ?? "open");
  const state = visible.every((link) => link.snapshot?.state === "open" && link.snapshot.isDraft)
    ? "draft"
    : states.includes("open")
      ? "open"
      : states.every((entry) => entry === "merged")
        ? "merged"
        : "closed";
  const chains = resolveThreadPullRequestChains(visible);
  if (visible.length > 1 && chains.length === 1) {
    return { kind: "stack", layers: visible.length, state };
  }
  return { kind: "pull-request", others: visible.length - 1, state };
}

export function threadPullRequestSearchTerms(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): string[] {
  const branch = thread.branchPullRequest;
  const terms = branch
    ? [`#${branch.number}`, `${branch.repository}#${branch.number}`, branch.url]
    : [];
  if (thread.pullRequests !== undefined && thread.pullRequests.length > 0) {
    return terms.concat(
      visibleThreadPullRequests(thread.pullRequests).flatMap((link) => [
        `#${link.number}`,
        `${link.repository}#${link.number}`,
        link.url,
        link.snapshot?.title ?? "",
      ]),
    );
  }
  const legacy = thread.linkedPullRequest;
  return legacy
    ? terms.concat([`#${legacy.number}`, `${legacy.repository}#${legacy.number}`, legacy.url])
    : terms;
}

/** Older V2 event payloads stored one link; an explicit empty array means it was unlinked. */
export function threadPullRequestsOf(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): ReadonlyArray<ThreadPullRequestLink> {
  if (thread.pullRequests !== undefined) return thread.pullRequests;
  const linked = thread.linkedPullRequest;
  return linked == null
    ? []
    : [
        {
          ...legacyThreadPullRequestKey(linked),
          url: linked.url,
          source: "manual",
          linkedAt: "1970-01-01T00:00:00.000Z",
          snapshot: null,
          stack: null,
        },
      ];
}

export function applyThreadPullRequestLinkUpdate(
  thread: OrchestrationV2AppThread,
  updated: ThreadPullRequestLink,
): OrchestrationV2AppThread {
  return {
    ...thread,
    pullRequests: threadPullRequestsOf(thread).map((link) =>
      threadPullRequestKeysEqual(link, updated) ? updated : link,
    ),
  };
}

export interface PullRequestListLine {
  readonly link: ThreadPullRequestLink;
  readonly depth: number;
  readonly chainKey: string;
  readonly stack: { readonly kind: ThreadPullRequestChain["kind"]; readonly size: number } | null;
}

function chainKeyOf(chain: ThreadPullRequestChain): string {
  const bottom = chain.layers[0]!;
  return `${bottom.host}/${bottom.repository}#${bottom.number}`;
}

export function pullRequestListLines(
  chains: ReadonlyArray<ThreadPullRequestChain>,
): ReadonlyArray<PullRequestListLine> {
  const ordered = [...chains].sort(
    (left, right) =>
      Math.max(...right.layers.map(latestUpdatedAt)) -
      Math.max(...left.layers.map(latestUpdatedAt)),
  );
  return ordered.flatMap((chain) => {
    const chainKey = chainKeyOf(chain);
    return chain.layers.map((link, index) => ({
      link,
      depth: chain.depths[index]!,
      chainKey,
      stack:
        index === 0 && chain.layers.length > 1
          ? { kind: chain.kind, size: chain.layers.length }
          : null,
    }));
  });
}
