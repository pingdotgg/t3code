import type { ThreadPullRequestKey, ThreadPullRequestLink } from "@t3tools/contracts";

import { visibleThreadPullRequests } from "./threadPullRequests.ts";

export interface ComposerPullRequestMatch extends ThreadPullRequestKey {
  readonly projectId: string;
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
            host: link.host,
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
  readonly repository: string | null;
  readonly query: string;
  readonly limit: number;
  readonly keyOf: (entry: Entry | Linked) => string;
}): ReadonlyArray<Entry | Linked> {
  const repository = input.repository?.trim().toLowerCase() ?? null;
  const { keyOf } = input;
  // Compare numerically so a zero-padded query like "0042" still finds #42.
  const queryNumber = /^\d+$/u.test(input.query) ? Number(input.query) : Number.NaN;
  const isExactMatch = (entry: ComposerPullRequestMatch) => entry.number === queryNumber;
  const matchesQuery = (entry: ComposerPullRequestMatch) =>
    isExactMatch(entry) || String(entry.number).includes(input.query);
  const linked = (input.linked ?? []).filter(matchesQuery);
  const linkedKeys = new Set(linked.map(keyOf));
  const matchingEntries = input.entries.filter(
    (entry) =>
      entry.projectId === input.projectId &&
      (repository === null || entry.repository.trim().toLowerCase() === repository) &&
      matchesQuery(entry),
  );
  const uniqueEntries = new Map<string, Entry | Linked>();
  for (const entry of [...matchingEntries, ...linked]) {
    if (!uniqueEntries.has(keyOf(entry))) {
      uniqueEntries.set(keyOf(entry), entry);
    }
  }
  const isLinked = (entry: Entry | Linked) => linkedKeys.has(keyOf(entry));
  const updatedAtMs = (entry: ComposerPullRequestMatch) => Date.parse(entry.updatedAt) || 0;
  // Hermes has no ES2023 array methods, so sort a fresh array.
  return [...uniqueEntries.values()]
    .sort(
      (left, right) =>
        Number(isExactMatch(right)) - Number(isExactMatch(left)) ||
        Number(isLinked(right)) - Number(isLinked(left)) ||
        updatedAtMs(right) - updatedAtMs(left),
    )
    .slice(0, input.limit);
}

export interface ComposerPullRequestRepositoryTarget {
  readonly host?: string | undefined;
  readonly repository: string;
}

/** Repositories of a project that still need an exact-number detail lookup. */
export function composerExactPullRequestRepositories(input: {
  readonly projectId: string;
  readonly repository: string | null;
  readonly listedRepositories?: ReadonlyArray<ComposerPullRequestRepositoryTarget> | undefined;
  readonly entries: ReadonlyArray<
    Pick<ComposerPullRequestMatch, "projectId" | "host" | "repository" | "number">
  >;
  readonly number: number;
}): ReadonlyArray<ComposerPullRequestRepositoryTarget> {
  const candidates: ComposerPullRequestRepositoryTarget[] = [];
  const seen = new Set<string>();
  const add = (repository: string, host?: string) => {
    const trimmedRepository = repository.trim();
    const normalizedRepository = trimmedRepository.toLowerCase();
    const trimmedHost = host?.trim();
    const normalizedHost = trimmedHost ? trimmedHost.toLowerCase() : undefined;
    const key = `${normalizedHost ?? ""}\0${normalizedRepository}`;
    if (normalizedRepository.length === 0 || seen.has(key)) return;
    seen.add(key);
    candidates.push(
      normalizedHost === undefined
        ? { repository: trimmedRepository }
        : { host: trimmedHost, repository: trimmedRepository },
    );
  };
  if (input.repository !== null) {
    add(input.repository);
  } else {
    for (const candidate of input.listedRepositories ?? []) {
      add(candidate.repository, candidate.host);
    }
    for (const entry of input.entries) {
      if (entry.projectId === input.projectId) add(entry.repository, entry.host);
    }
  }
  return candidates.filter((candidate) => {
    const normalizedRepository = candidate.repository.toLowerCase();
    const normalizedHost = candidate.host?.toLowerCase();
    return !input.entries.some(
      (entry) =>
        entry.projectId === input.projectId &&
        entry.repository.trim().toLowerCase() === normalizedRepository &&
        (normalizedHost === undefined || entry.host.trim().toLowerCase() === normalizedHost) &&
        entry.number === input.number,
    );
  });
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
  readonly keyOf: (entry: Entry | Linked) => string;
}): ReadonlyArray<Entry | Linked> {
  const { keyOf } = input;
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
