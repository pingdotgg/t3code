import type { PullRequestContextMetadata, PullRequestSummary } from "@t3tools/contracts";

// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>https?:\/\/[^\s)]+)\)|<(?<autolink>https?:\/\/[^\s<>]+)>|(?<bare>https?:\/\/[^\s<>()[\]`]+)/giu;
const SENTENCE_PUNCTUATION = /[.,:;!?'"*_~]+$/u;
const ENDS_IN_NUMBER = /^[^?#]*\/\d+\/?$/u;

export interface PastedLink {
  readonly start: number;
  readonly end: number;
  readonly url: string;
}

/** Each bare, `<autolink>` or `[label](url)` link outside code whose path ends in a number. */
export function findPullRequestLinks(markdown: string): PastedLink[] {
  if (!/https?:\/\//iu.test(markdown)) return [];
  const links: PastedLink[] = [];
  for (const match of markdown.matchAll(LINK_OUTSIDE_CODE)) {
    const groups = match.groups ?? {};
    const bare = groups.bare?.replace(SENTENCE_PUNCTUATION, "");
    const url = groups.href ?? groups.autolink ?? bare;
    if (url === undefined || !ENDS_IN_NUMBER.test(url)) continue;
    const start = match.index;
    links.push({ start, end: start + (bare ?? match[0]).length, url });
  }
  return links;
}

/** A link to one comment, file or commit keeps its anchor, so only the pull request's own page converts. */
export function isPullRequestPage(url: string, number: number): boolean {
  return new RegExp(
    `^[^?#]*/(?:pulls?|-/merge_requests|pull-requests|pullrequest)/${number}/?$`,
    "u",
  ).test(url);
}

export function pullRequestContextFromSummary(
  summary: Pick<
    PullRequestSummary,
    "number" | "title" | "url" | "headBranch" | "baseBranch" | "state" | "isDraft"
  >,
): PullRequestContextMetadata {
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    headBranch: summary.headBranch,
    baseBranch: summary.baseBranch,
    state: summary.state,
    isDraft: summary.isDraft ?? false,
  };
}

/** The one span `before` and `after` differ in, as `[start, beforeEnd)` and `[start, afterEnd)`. */
function changedSpan(
  before: string,
  after: string,
): { readonly start: number; readonly beforeEnd: number; readonly afterEnd: number } {
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) start += 1;
  let tail = 0;
  while (
    tail < shorter - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { start, beforeEnd: before.length - tail, afterEnd: after.length - tail };
}

/**
 * Where a range of `before` sits in `after`, or null when the edits between them touched it or
 * landed on both sides of it, since then no offset arithmetic can prove it is the same text.
 */
export function mapUntouchedRange<Range extends { readonly start: number; readonly end: number }>(
  range: Range,
  before: string,
  after: string,
): Range | null {
  const span = changedSpan(before, after);
  if (range.end <= span.start) return range;
  if (range.start < span.beforeEnd) return null;
  const shift = span.afterEnd - span.beforeEnd;
  return { ...range, start: range.start + shift, end: range.end + shift };
}

/** Where a caret in `before` sits in `after`, at the end of the edit when it was inside it. */
export function mapCursor(cursor: number, before: string, after: string): number {
  const span = changedSpan(before, after);
  if (cursor <= span.start) return cursor;
  if (cursor >= span.beforeEnd) return cursor + span.afterEnd - span.beforeEnd;
  return span.afterEnd;
}

/** Keeps a caret on the same text while the range before or around it is replaced. */
export function cursorAfterRangeReplacement(
  cursor: number,
  range: { readonly start: number; readonly end: number },
  replacementLength: number,
): number {
  if (cursor <= range.start) return cursor;
  if (cursor >= range.end) return cursor + replacementLength - (range.end - range.start);
  return range.start + replacementLength;
}
