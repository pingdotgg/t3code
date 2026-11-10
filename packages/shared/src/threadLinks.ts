import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const V1_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const V2_PREFIX = `${THREAD_LINK_PROTOCOL}://v2/`;
const HOSTED_PREFIX = `${DEFAULT_HOSTED_APP_URL}/threads/`;
const HOSTED_SEGMENT = "[A-Za-z0-9_%-]+";
const HOSTED_LINK = `${HOSTED_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}${HOSTED_SEGMENT}/${HOSTED_SEGMENT}`;
// Every inline link is taken whole, so a hosted URL in another link's label or href stays as written.
// Labels and destinations stop at the next `[`, while titles may contain literal brackets.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  String.raw`\[(?<label>[^[\]\n]*)\]\((?:<(?<angleHref>[^\s<>[]*)>|(?<href>[^\s<>)[]*))(?<title>\s+(?:"(?:\\[^\n]|[^"\\\n])*"|'(?:\\[^\n]|[^'\\\n])*'|\((?:\\[^\n]|[^()\\\n])*\))[ \t]*)?\)|<(?<autolink>t3-thread:\/\/v[12]\/[^\s<>]+|${HOSTED_LINK})>|(?<![\w%/?#=&.:@+~-])(?<bare>${HOSTED_LINK})(?![\w%/?#-])`,
  "g",
);

const codeParser = unified().use(remarkParse).freeze();

// Let CommonMark own block precedence and complete backtick runs. Only offsets are used:
// links still follow the bounded policy above, and untouched source is never serialized.
function codeRanges(markdown: string) {
  const ranges: Array<{ start: number; end: number; inline: boolean }> = [];
  const visit = (node: Root | Root["children"][number]) => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        ranges.push({ start, end, inline: node.type === "inlineCode" });
      }
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(codeParser.parse(markdown));
  return ranges;
}

function* threadLinkMatches(markdown: string) {
  if (!hasThreadLinks(markdown)) return;
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  let ranges: ReturnType<typeof codeRanges> | undefined;
  let rangeIndex = 0;
  const mayContainCode = /[`~\t]| {4}/.test(markdown);
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    // Most messages need no Markdown parse; defer it until a candidate and code syntax coexist.
    if (!mayContainCode) {
      yield match;
      continue;
    }
    ranges ??= codeRanges(markdown);
    while (ranges[rangeIndex] && ranges[rangeIndex]!.end <= match.index) rangeIndex++;
    const end = match.index + match[0].length;
    const labelEnd = match.index + 1 + (match.groups?.label?.length ?? 0);
    let protectedEnd: number | undefined;
    for (let index = rangeIndex; ranges[index] && ranges[index]!.start < end; index++) {
      const range = ranges[index]!;
      // Balanced code inside a link label belongs to that whole link.
      if (range.inline && range.start > match.index && range.end <= labelEnd) continue;
      protectedEnd = range.end;
      break;
    }
    if (protectedEnd === undefined) yield match;
    else pattern.lastIndex = Math.max(pattern.lastIndex, protectedEnd);
  }
}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

/** A v1 link names no environment; the message's own, or a unique match, stands in. */
export interface ThreadLink {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
}

// Escapes even URL-safe punctuation, so a sentence's closing period never reads as part of an id.
const hostedSegment = (id: string) =>
  encodeURIComponent(id).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Opens the thread from anywhere: the hosted app offers the desktop app, the mobile app, or itself. */
export function hostedThreadLink(ref: ScopedThreadRef, origin = DEFAULT_HOSTED_APP_URL): string {
  const path = `/threads/${hostedSegment(ref.environmentId)}/${hostedSegment(ref.threadId)}`;
  return new URL(path, origin).toString();
}

const HOSTED_PATH = new RegExp(`^(${HOSTED_SEGMENT})/(${HOSTED_SEGMENT})$`);

function parseHostedThreadLink(href: string): ThreadLink | null {
  const match = HOSTED_PATH.exec(href.slice(HOSTED_PREFIX.length));
  if (!match) return null;
  try {
    const environmentId = Option.getOrNull(decodeEnvironmentId(decodeURIComponent(match[1]!)));
    const threadId = Option.getOrNull(decodeThreadId(decodeURIComponent(match[2]!)));
    return environmentId === null || threadId === null ? null : { environmentId, threadId };
  } catch {
    return null;
  }
}

/**
 * The ids as written. Thread ids can hold percent escapes of their own, so they are not decoded,
 * except in a hosted link, which escapes them itself.
 */
export function parseThreadLinkHref(href: string): ThreadLink | null {
  if (href.startsWith(HOSTED_PREFIX)) return parseHostedThreadLink(href);
  if (href.startsWith(V1_PREFIX)) {
    const threadId = Option.getOrNull(decodeThreadId(href.slice(V1_PREFIX.length)));
    return threadId === null ? null : { environmentId: null, threadId };
  }
  if (!href.startsWith(V2_PREFIX)) return null;
  const path = href.slice(V2_PREFIX.length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const environmentId = Option.getOrNull(decodeEnvironmentId(path.slice(0, slash)));
  const threadId = Option.getOrNull(decodeThreadId(path.slice(slash + 1)));
  return environmentId === null || threadId === null ? null : { environmentId, threadId };
}

function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/** The threads a link can name, in its own environment or else the message's: as written, then decoded. */
export function threadLinkCandidates(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const environmentId = link.environmentId ?? messageEnvironmentId;
  const decodedId = percentDecodedThreadLinkId(link.threadId);
  const written = { environmentId, threadId: link.threadId };
  return decodedId === null ? [written] : [written, { environmentId, threadId: decodedId }];
}

/** A v1 link its message's environment lacks opens a unique match elsewhere; a v2 link never does. */
export function guessThreadLinkRef(
  link: ThreadLink,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  if (link.environmentId !== null) return null;
  const decodedId = percentDecodedThreadLinkId(link.threadId);
  for (const threadId of decodedId === null ? [link.threadId] : [link.threadId, decodedId]) {
    let match: ScopedThreadRef | null = null;
    for (const ref of refs) {
      if (ref.threadId !== threadId) continue;
      if (match !== null) return null;
      match = ref;
    }
    if (match !== null) return match;
  }
  return null;
}

function threadLinkHref(link: ThreadLink): string {
  return link.environmentId === null
    ? `${V1_PREFIX}${link.threadId}`
    : `${V2_PREFIX}${link.environmentId}/${link.threadId}`;
}

const linkLabel = (label: string | undefined) =>
  label
    ?.replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Without a label, an autolink: clients show the thread's current title. */
export function formatThreadLink(ref: ThreadLink, label?: string): string {
  const cleaned = linkLabel(label);
  const href = threadLinkHref(ref);
  const destination = /[()]/.test(href) ? `<${href}>` : href;
  return cleaned ? `[${cleaned}](${destination})` : `<${href}>`;
}

/** What a person copies out of T3 Code: a Markdown link that opens the thread anywhere. */
export function formatHostedThreadLink(
  ref: ScopedThreadRef,
  label: string,
  origin?: string,
): string {
  const href = hostedThreadLink(ref, origin);
  const cleaned = linkLabel(label);
  return cleaned ? `[${cleaned}](${href})` : href;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`${THREAD_LINK_PROTOCOL}://v`) || markdown.includes(HOSTED_PREFIX);
}

/** Source and accepted links only; preparation retains no Markdown AST or resolved titles. */
export function prepareThreadLinks(markdown: string) {
  const matches = [];
  // Hermes' matchAll yields matches without `groups`; exec keeps them.
  for (const match of threadLinkMatches(markdown)) {
    const groups = match.groups!;
    if (groups.title !== undefined) continue;
    const href = groups.angleHref ?? groups.href ?? groups.autolink ?? groups.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    if (link !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        link,
        label: groups.label,
      });
    }
  }
  return { markdown, matches };
}

type PreparedThreadLinks = ReturnType<typeof prepareThreadLinks>;

/** Every thread the markdown's links can name, so their titles are keyed reads. */
export function threadLinkRefs(
  source: string | PreparedThreadLinks,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  const prepared = typeof source === "string" ? prepareThreadLinks(source) : source;
  for (const { link } of prepared.matches) {
    for (const ref of threadLinkCandidates(link, messageEnvironmentId)) {
      refs.set(`${ref.environmentId}/${ref.threadId}`, ref);
    }
  }
  return [...refs.values()];
}

export function unknownThreadLinkLabel(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): string {
  return link.environmentId === null || link.environmentId === messageEnvironmentId
    ? "Thread no longer available"
    : "Thread on another machine";
}

/** Rewrites each link outside code `replace` answers for. `label` is a Markdown link's own text. */
export function replaceThreadLinks(
  source: string | PreparedThreadLinks,
  replace: (link: ThreadLink, label: string | undefined) => string | undefined,
): string {
  const { markdown, matches } = typeof source === "string" ? prepareThreadLinks(source) : source;
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    const replacement = replace(match.link, match.label);
    if (replacement === undefined) continue;
    result += markdown.slice(cursor, match.start) + replacement;
    cursor = match.end;
  }
  return result + markdown.slice(cursor);
}

/**
 * Writes each link with its thread's current title, a hosted link as a v2 link. A link `title`
 * cannot resolve becomes plain text, its written label or a neutral one, except a labeled v1
 * link, which may open elsewhere.
 */
export function relabelThreadLinks(
  source: string | PreparedThreadLinks,
  messageEnvironmentId: EnvironmentId,
  title: (ref: ScopedThreadRef) => string | undefined,
): string {
  return replaceThreadLinks(source, (written, label) => {
    const environmentId = written.environmentId ?? messageEnvironmentId;
    const decoded = percentDecodedThreadLinkId(written.threadId);
    const threadId =
      title({ environmentId, threadId: written.threadId }) === undefined &&
      decoded !== null &&
      title({ environmentId, threadId: decoded }) !== undefined
        ? decoded
        : written.threadId;
    const current = title({ environmentId, threadId });
    if (current === undefined) {
      if (label !== undefined && written.environmentId === null) return undefined;
      return label?.trim() || unknownThreadLinkLabel(written, messageEnvironmentId);
    }
    return formatThreadLink(
      { environmentId: written.environmentId, threadId },
      current.trim() || label || threadId,
    );
  });
}
