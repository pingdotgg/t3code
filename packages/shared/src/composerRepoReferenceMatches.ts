import type { RepoReferenceKind, ThreadPullRequestLink } from "@t3tools/contracts";

import { composerPullRequestsFromLinks } from "./composerPullRequestMatches.ts";

export interface ComposerRepoReferenceMatch {
  readonly kind: RepoReferenceKind;
  readonly number: number;
  readonly projectId: string;
  readonly repository: string;
  readonly updatedAt: string;
}

export type LinkedComposerPullRequestReference = ComposerRepoReferenceMatch & {
  readonly kind: "pull-request";
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
};

function repoReferenceMatchKey(entry: ComposerRepoReferenceMatch): string {
  return `${entry.kind}:${entry.repository.trim().toLowerCase()}#${entry.number}`;
}

export function linkedComposerPullRequestReferences(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: string,
): ReadonlyArray<LinkedComposerPullRequestReference> {
  return composerPullRequestsFromLinks(links, projectId).map((entry) => ({
    kind: "pull-request" as const,
    projectId: entry.projectId,
    repository: entry.repository,
    number: entry.number,
    title: entry.title,
    url: entry.url,
    headBranch: entry.headBranch,
    baseBranch: entry.baseBranch,
    state: entry.state,
    isDraft: entry.isDraft,
    updatedAt: entry.updatedAt,
  }));
}

/** Numeric `#` queries: exact number first, then linked PRs, then recency. */
export function filterComposerRepoReferenceMatches<
  Entry extends ComposerRepoReferenceMatch,
  Linked extends ComposerRepoReferenceMatch = never,
>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly linked?: ReadonlyArray<Linked>;
  readonly projectId: string;
  readonly repository: string;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry | Linked> {
  const repository = input.repository.trim().toLowerCase();
  const linked = (input.linked ?? []).filter((entry) => String(entry.number).includes(input.query));
  const linkedKeys = new Set(linked.map(repoReferenceMatchKey));
  const matchingEntries = input.entries.filter(
    (entry) =>
      entry.projectId === input.projectId &&
      entry.repository.trim().toLowerCase() === repository &&
      String(entry.number).includes(input.query),
  );
  const uniqueEntries = new Map<string, Entry | Linked>();
  for (const entry of [...matchingEntries, ...linked]) {
    if (!uniqueEntries.has(repoReferenceMatchKey(entry))) {
      uniqueEntries.set(repoReferenceMatchKey(entry), entry);
    }
  }
  const isExactMatch = (entry: ComposerRepoReferenceMatch) => String(entry.number) === input.query;
  const isLinked = (entry: ComposerRepoReferenceMatch) =>
    linkedKeys.has(repoReferenceMatchKey(entry));
  return [...uniqueEntries.values()]
    .sort(
      (left, right) =>
        Number(isExactMatch(right)) - Number(isExactMatch(left)) ||
        Number(isLinked(right)) - Number(isLinked(left)) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, input.limit);
}

/** Text `#` queries: linked PRs that match the words stay ahead of host search hits. */
export function withLinkedComposerRepoReferencesFirst<
  Entry extends ComposerRepoReferenceMatch,
  Linked extends ComposerRepoReferenceMatch & {
    readonly title: string;
    readonly headBranch?: string;
  },
>(input: {
  readonly matches: ReadonlyArray<Entry>;
  readonly linked: ReadonlyArray<Linked>;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry | Linked> {
  const matchesByKey = new Map(input.matches.map((entry) => [repoReferenceMatchKey(entry), entry]));
  const words = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
  const linked = input.linked.flatMap((entry): Array<Entry | Linked> => {
    const match = matchesByKey.get(repoReferenceMatchKey(entry));
    if (match !== undefined) return [match];
    const text =
      `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word)) ? [entry] : [];
  });
  const linkedKeys = new Set(linked.map(repoReferenceMatchKey));
  return [
    ...linked,
    ...input.matches.filter((entry) => !linkedKeys.has(repoReferenceMatchKey(entry))),
  ].slice(0, input.limit);
}
