import type { ProjectId, ThreadPullRequestLink } from "@t3tools/contracts";

export interface ComposerPullRequestMatch {
  readonly number: number;
  readonly projectId: string;
  /**
   * The host below which `repository` is addressed: the same `owner/repo` exists on two forges.
   * Absent on a row the project's own lookup produced; `composerProjectPullRequestHost` fills it
   * in from the rows that know the project's host before matching.
   */
  readonly host?: string | undefined;
  readonly repository: string;
  readonly updatedAt: string;
}

/** A pull request linked to the thread, which the composer offers from any repository. */
export interface ComposerLinkedPullRequest {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

type ComposerPullRequestIdentity = Pick<ComposerPullRequestMatch, "host" | "repository" | "number">;

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * Whether two composer rows name the same pull request: the host-level identity a thread link
 * carries, whatever the casing. A row still without a host only matches another such row, so a
 * lookup row can never stand in for a linked pull request on a different host.
 */
function isSameComposerPullRequest(
  left: ComposerPullRequestIdentity,
  right: ComposerPullRequestIdentity,
): boolean {
  return (
    left.number === right.number &&
    normalize(left.repository) === normalize(right.repository) &&
    normalize(left.host ?? "") === normalize(right.host ?? "")
  );
}

/**
 * The host of the project's own repository, as the project's listing knows it; the exact lookup
 * (`PullRequestDetail`) carries none. Only rows the project produced may answer: a thread link
 * naming the same `owner/repo` may live on another forge. Absent while the listing is empty.
 */
export function composerProjectPullRequestHost(
  listing: ReadonlyArray<ComposerPullRequestMatch>,
  repository: string,
): string | undefined {
  const target = normalize(repository);
  return listing.find((row) => row.host !== undefined && normalize(row.repository) === target)
    ?.host;
}

/** The rows with each pull request once, keeping the first row that names it. */
export function uniqueComposerPullRequests<Entry extends ComposerPullRequestMatch>(
  rows: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  const unique: Array<Entry> = [];
  for (const row of rows) {
    if (!unique.some((kept) => isSameComposerPullRequest(kept, row))) unique.push(row);
  }
  return unique;
}

function isLinkedPullRequest(
  entry: ComposerPullRequestIdentity,
  linked: ReadonlyArray<ComposerLinkedPullRequest>,
): boolean {
  return linked.some((link) => isSameComposerPullRequest(link, entry));
}

/**
 * Pull requests matching the numeric fragment typed after `#`, de-duplicated per pull request. A
 * pull request linked to the thread outranks the project's own, so `#4` offers the thread's
 * `owner/other#4` before an unrelated `#4` in the project's repository. Below that an exact
 * number match outranks a substring match so the result limit can never drop the pull request
 * the user typed in full; the rest stay newest first.
 */
export function filterComposerPullRequestMatches<Entry extends ComposerPullRequestMatch>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly projectId: string;
  readonly repository: string;
  readonly query: string;
  readonly limit: number;
  /** Linked to the thread: matched from any repository and suggested first. */
  readonly linked?: ReadonlyArray<ComposerLinkedPullRequest>;
}): ReadonlyArray<Entry> {
  const repository = normalize(input.repository);
  const linked = input.linked ?? [];
  const uniqueEntries: Array<Entry> = [];
  for (const entry of input.entries) {
    if (
      entry.projectId !== input.projectId ||
      !(normalize(entry.repository) === repository || isLinkedPullRequest(entry, linked)) ||
      !String(entry.number).includes(input.query) ||
      uniqueEntries.some((kept) => isSameComposerPullRequest(kept, entry))
    ) {
      continue;
    }
    uniqueEntries.push(entry);
  }
  const isExactMatch = (entry: Entry) => String(entry.number) === input.query;
  // `.sort()` on a copy, not `.toSorted()`: this runs on Hermes, which has no ES2023 array
  // methods, and reaching for one here crashed the composer as the suggestions loaded.
  return [...uniqueEntries]
    .sort((left, right) => {
      const linkage =
        Number(isLinkedPullRequest(right, linked)) - Number(isLinkedPullRequest(left, linked));
      if (linkage !== 0) return linkage;
      const exactness = Number(isExactMatch(right)) - Number(isExactMatch(left));
      return exactness !== 0 ? exactness : right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, input.limit);
}

/** A thread's linked pull request as the composer offers it, taken from the link's snapshot. */
export interface ComposerLinkedPullRequestEntry extends ComposerPullRequestMatch {
  readonly host: string;
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: NonNullable<ThreadPullRequestLink["snapshot"]>["state"];
  readonly isDraft: boolean;
}

/**
 * Suggestion rows for the pull requests linked to a thread, from any repository. The listing the
 * composer searches only covers the project's own repository, so these are what let `#` reach a
 * pull request the thread opened elsewhere. A link the server has not synced yet has nothing to
 * show and is left out until it has.
 */
export function composerPullRequestEntriesFromLinks(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: ProjectId,
): ReadonlyArray<ComposerLinkedPullRequestEntry> {
  const entries: Array<ComposerLinkedPullRequestEntry> = [];
  for (const link of links) {
    if (link.snapshot === null) continue;
    entries.push({
      number: link.number,
      projectId,
      host: link.host,
      repository: link.repository,
      title: link.snapshot.title,
      url: link.url,
      headBranch: link.snapshot.headBranch,
      baseBranch: link.snapshot.baseBranch,
      state: link.snapshot.state,
      isDraft: link.snapshot.isDraft,
      updatedAt: link.snapshot.updatedAt ?? link.snapshot.syncedAt,
    });
  }
  return entries;
}

/**
 * Whether every word of a text query appears in the pull request's number, title, repository or
 * branches; the repository is what tells a linked row from another repository apart in the menu.
 */
export function matchesComposerPullRequestWords(
  entry: Pick<
    ComposerLinkedPullRequestEntry,
    "number" | "title" | "repository" | "headBranch" | "baseBranch"
  >,
  query: string,
): boolean {
  const haystack =
    `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.baseBranch}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
