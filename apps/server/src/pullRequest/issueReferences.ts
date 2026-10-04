import type { IssueLink } from "@t3tools/contracts";

/**
 * An issue a change request's own words name. Nothing has checked that it exists yet, which is
 * the whole difference between this and a link the host itself reported.
 */
export interface IssueReference {
  readonly repository: string;
  readonly number: number;
}

/** The words a reference can be read out of, and what a bare number means inside them. */
export interface IssueReferenceSource {
  /** GitHub names a repository with one slash; a GitLab project nests as deep as its groups. */
  readonly kind: "github" | "gitlab";
  readonly host: string;
  /** What a bare `#12` points at, which is the change request's own repository. */
  readonly repository: string;
  readonly title: string;
  readonly body: string;
}

/**
 * How many parsed references one detail read carries. A body that names more issues than this is
 * a listing of its own, and every one of them would have to be looked up before the change
 * request could be shown at all.
 */
export const CITED_ISSUE_REFERENCES_MAX = 10;

/**
 * `#12`, `owner/repo#12` and GitLab's arbitrarily nested `group/sub/project#12`. The `#` may not
 * follow a word, a path or another `#`, which is what keeps `abc#12` and a heading out; the
 * boundary after the digits is what keeps the `#1234ab` of a colour out.
 */
const REFERENCE = /(?<![\w/#])((?:[A-Za-z0-9][\w.-]*\/)+[A-Za-z0-9][\w.-]*)?#(\d{1,9})\b/gu;

const URL_TOKEN = /https?:\/\/\S+/giu;

/** `/owner/repo/issues/12`, and GitLab's `/group/project/-/issues/12`. */
const ISSUE_PATH = /^\/(.+?)\/(?:-\/)?issues\/(\d{1,9})$/u;

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/**
 * The prose alone. A reference inside a fence or an inline span is being shown rather than made,
 * and an unclosed fence runs to the end of the text the way every Markdown reader treats it.
 */
function withoutCode(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker !== undefined && marker.startsWith(fence)) fence = null;
      lines.push("");
      continue;
    }
    if (marker !== undefined) fence = marker;
    lines.push(marker === undefined ? line : "");
  }
  return lines.join("\n").replace(/(`+)[^`]*\1/gu, " ");
}

function referenceKey(reference: { readonly repository: string; readonly number: number }): string {
  return `${reference.repository.trim().toLowerCase()}#${reference.number}`;
}

function toReference(
  source: IssueReferenceSource,
  path: string | undefined,
  number: number,
): IssueReference | null {
  if (number <= 0) return null;
  const repository = path ?? source.repository;
  if (source.kind === "github" && repository.split("/").length !== 2) return null;
  return { repository, number };
}

/**
 * The issue a URL names, or null for every other link. Trailing punctuation is dropped first
 * because a link at the end of a sentence carries the full stop, and a Markdown one carries the
 * bracket that closed it.
 */
function urlReference(token: string, source: IssueReferenceSource): IssueReference | null {
  const url = URL.parse(token.replace(/[)\]>.,;:!?'"]+$/u, ""));
  if (url === null || url.host.toLowerCase() !== source.host.trim().toLowerCase()) return null;
  const path = ISSUE_PATH.exec(url.pathname);
  return path?.[1] === undefined ? null : toReference(source, path[1], Number(path[2]));
}

/**
 * Every issue the change request's title and body point at, in the order they are written.
 *
 * These are citations and never closures: only the host knows what merging will actually close,
 * so a reference read out of the words says the change mentions an issue and no more than that.
 *
 * A link whose URL is not an issue is removed before the numbers are scanned, so the fragment of
 * an ordinary URL never reads as one.
 */
export function parseIssueReferences(
  source: IssueReferenceSource,
  include: (reference: IssueReference) => boolean = () => true,
): ReadonlyArray<IssueReference> {
  const found = new Map<string, IssueReference>();
  const add = (reference: IssueReference | null) => {
    if (reference === null) return;
    const key = referenceKey(reference);
    if (!found.has(key)) found.set(key, reference);
  };
  for (const text of [source.title, source.body]) {
    const prose = withoutCode(text);
    for (const token of prose.match(URL_TOKEN) ?? []) add(urlReference(token, source));
    for (const match of prose.replace(URL_TOKEN, " ").matchAll(REFERENCE)) {
      add(toReference(source, match[1], Number(match[2])));
    }
  }
  return [...found.values()].filter(include).slice(0, CITED_ISSUE_REFERENCES_MAX);
}

/** The references the host said nothing about, which are the only ones worth a lookup. */
export function unlinkedIssueReferences(
  references: ReadonlyArray<IssueReference>,
  hostLinks: ReadonlyArray<IssueLink>,
): ReadonlyArray<IssueReference> {
  const linked = new Set(hostLinks.map(referenceKey));
  return references.filter((reference) => !linked.has(referenceKey(reference)));
}

/**
 * The host's own links, then the ones its words gave. The host wins every conflict: it is the
 * only side that can say merging closes an issue, and a parsed reference never claims that.
 */
export function mergeIssueLinks(
  hostLinks: ReadonlyArray<IssueLink>,
  citedLinks: ReadonlyArray<IssueLink>,
): ReadonlyArray<IssueLink> {
  const merged = new Map<string, IssueLink>();
  for (const link of [...hostLinks, ...citedLinks]) {
    const key = referenceKey(link);
    if (!merged.has(key)) merged.set(key, link);
  }
  return [...merged.values()];
}
