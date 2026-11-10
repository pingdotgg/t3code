import type { ThreadPullRequestLink } from "@t3tools/contracts";

import { visibleThreadPullRequests } from "./threadPullRequests.ts";

export interface ComposerPullRequestMatch {
  readonly number: number;
  readonly projectId: string;
  readonly repository: string;
  readonly updatedAt: string;
}

export function composerPullRequestsFromLinks(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: string,
) {
  return visibleThreadPullRequests(links).flatMap((link) =>
    link.snapshot === null
      ? []
      : [
          {
            projectId,
            repository: link.repository,
            number: link.number,
            url: link.url,
            title: link.snapshot.title,
            headBranch: link.snapshot.headBranch,
            baseBranch: link.snapshot.baseBranch,
            state: link.snapshot.state,
            isDraft: link.snapshot.isDraft,
            updatedAt: link.snapshot.updatedAt ?? link.linkedAt,
          },
        ],
  );
}

export function filterComposerPullRequestMatches<
  Entry extends ComposerPullRequestMatch,
  Linked extends ComposerPullRequestMatch = never,
>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly linked?: ReadonlyArray<Linked>;
  readonly projectId: string;
  readonly repository: string;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry | Linked> {
  const repository = input.repository.trim().toLowerCase();
  const keyOf = (entry: ComposerPullRequestMatch) =>
    `${entry.repository.trim().toLowerCase()}#${entry.number}`;
  const linked = (input.linked ?? []).filter((entry) => String(entry.number).includes(input.query));
  const linkedKeys = new Set(linked.map(keyOf));
  const matchingEntries = input.entries.filter(
    (entry) =>
      entry.projectId === input.projectId &&
      entry.repository.trim().toLowerCase() === repository &&
      String(entry.number).includes(input.query),
  );
  const uniqueEntries = new Map<string, Entry | Linked>();
  for (const entry of [...matchingEntries, ...linked]) {
    if (!uniqueEntries.has(keyOf(entry))) {
      uniqueEntries.set(keyOf(entry), entry);
    }
  }
  const isExactMatch = (entry: ComposerPullRequestMatch) => String(entry.number) === input.query;
  const isLinked = (entry: ComposerPullRequestMatch) => linkedKeys.has(keyOf(entry));
  // Hermes has no ES2023 array methods, so sort a fresh array.
  return [...uniqueEntries.values()]
    .sort(
      (left, right) =>
        Number(isExactMatch(right)) - Number(isExactMatch(left)) ||
        Number(isLinked(right)) - Number(isLinked(left)) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, input.limit);
}

/** Puts the thread's linked pull requests that match a text query ahead of the searched ones. */
export function withLinkedComposerPullRequestsFirst<
  Entry extends ComposerPullRequestMatch,
  Linked extends ComposerPullRequestMatch & {
    readonly title: string;
    readonly headBranch: string;
  },
>(input: {
  readonly matches: ReadonlyArray<Entry>;
  readonly linked: ReadonlyArray<Linked>;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry | Linked> {
  const keyOf = (entry: ComposerPullRequestMatch) =>
    `${entry.repository.trim().toLowerCase()}#${entry.number}`;
  const matchesByKey = new Map(input.matches.map((entry) => [keyOf(entry), entry]));
  const words = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
  const linked = input.linked.flatMap((entry): Array<Entry | Linked> => {
    const match = matchesByKey.get(keyOf(entry));
    if (match !== undefined) return [match];
    const text =
      `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch}`.toLowerCase();
    return words.every((word) => text.includes(word)) ? [entry] : [];
  });
  const linkedKeys = new Set(linked.map(keyOf));
  return [...linked, ...input.matches.filter((entry) => !linkedKeys.has(keyOf(entry)))].slice(
    0,
    input.limit,
  );
}
