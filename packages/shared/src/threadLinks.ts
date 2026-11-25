import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isLocalLoopbackHost } from "./hostClassification.ts";
import { parseUrl } from "./url.ts";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const V1_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const V2_PREFIX = `${THREAD_LINK_PROTOCOL}://v2/`;
const APP_THREAD_LINK_ORIGIN = "t3code://";
const SHARED_SEGMENT = "[A-Za-z0-9_%-]+";
// Links copied before the fork stopped using upstream's hosted app still name a thread.
const SHARED_PREFIX = String.raw`(?:t3code(?:-[a-z]+)?:\/\/|https:\/\/app\.t3\.codes\/)threads\/`;
const SHARED_LINK = `${SHARED_PREFIX}${SHARED_SEGMENT}/${SHARED_SEGMENT}`;
const SHARED_PREFIX_ANYWHERE = new RegExp(SHARED_PREFIX);
const THREAD_HREF = String.raw`t3-thread:\/\/v[12]\/`;
// A label stops at any bracket, so a run of unclosed brackets is scanned once, not once per bracket.
const LABEL = String.raw`[^[\]\n]*`;
// Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
// nothing, code is literal, and a link to anywhere else keeps a thread URL in its label or href.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[!-/:-@[-\`{-~]`,
    String.raw`(?<fence>(\`{3,}|~{3,})[\s\S]*?(?:\2|$))`,
    String.raw`(?<span>(\`+)[^\n]*?\4)`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[(?<label>${LABEL})\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+|${SHARED_LINK})>|(?<href>${THREAD_HREF}[^\s>)]+|${SHARED_LINK}))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
    String.raw`<(?<autolink>${THREAD_HREF}[^\s<>]+|${SHARED_LINK})>`,
    // After a URL character the shared link is part of a longer URL, such as a redirect target.
    String.raw`(?<![A-Za-z0-9%/?#=&@+-])(?<bare>${SHARED_LINK})(?![\w%/?#-])`,
  ].join("|"),
  "g",
);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

/** A v1 link names no environment; the message's own, or a unique match, stands in. */
export interface ThreadLink {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
}

// Escapes even URL-safe punctuation, so a sentence's closing period never reads as part of an id.
const sharedSegment = (id: string) =>
  encodeURIComponent(id).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const threadPath = (ref: ScopedThreadRef) =>
  `threads/${sharedSegment(ref.environmentId)}/${sharedSegment(ref.threadId)}`;

/** The first http(s) origin another device can open; a loopback address only reaches its own machine. */
export function shareableOrigin(candidates: Iterable<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const url = candidate ? parseUrl(candidate) : null;
    if (url && /^https?:$/.test(url.protocol) && !isLocalLoopbackHost(url.hostname)) {
      return url.origin;
    }
  }
  return null;
}

/** Opens the thread in its server's web app, or in the installed app when no origin is known. */
export function shareableThreadLink(ref: ScopedThreadRef, origin: string | null): string {
  const path = threadPath(ref);
  return origin === null ? `${APP_THREAD_LINK_ORIGIN}${path}` : new URL(`/${path}`, origin).href;
}

/** Server links to the threads a copy carried, as app links: only that copy vouches a server URL names a thread. */
export function withCopiedThreadLinks(text: string, refs: ReadonlyArray<ScopedThreadRef>): string {
  return refs.reduce((result, ref) => {
    const path = threadPath(ref);
    const serverLink = new RegExp(
      String.raw`(?<![\w%/?#=&@+-])https?:\/\/[^\s/?#<>()[\]]+\/${path}(?![\w%/?#-])`,
      "g",
    );
    return result.replace(serverLink, `${APP_THREAD_LINK_ORIGIN}${path}`);
  }, text);
}

const SHARED_HREF = new RegExp(`^${SHARED_PREFIX}(${SHARED_SEGMENT})/(${SHARED_SEGMENT})$`);

function parseSharedThreadLink(href: string): ThreadLink | null {
  const match = SHARED_HREF.exec(href);
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
 * except in a shared link, which escapes them itself.
 */
export function parseThreadLinkHref(href: string): ThreadLink | null {
  const shared = parseSharedThreadLink(href);
  if (shared !== null) return shared;
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

/** What a person copies out of T3 Code: a Markdown link that opens the thread on its server. */
export function formatShareableThreadLink(
  ref: ScopedThreadRef,
  label: string,
  origin: string | null,
): string {
  const href = shareableThreadLink(ref, origin);
  const cleaned = linkLabel(label);
  return cleaned ? `[${cleaned}](${href})` : href;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`${THREAD_LINK_PROTOCOL}://v`) || SHARED_PREFIX_ANYWHERE.test(markdown);
}

/** Every thread the markdown's links can name, so their titles are keyed reads. */
export function threadLinkRefs(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  // Hermes' matchAll yields matches without `groups`; exec keeps them.
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    const href =
      match.groups?.angleHref ?? match.groups?.href ?? match.groups?.autolink ?? match.groups?.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    if (link === null) continue;
    for (const ref of threadLinkCandidates(link, messageEnvironmentId)) {
      refs.set(`${ref.environmentId}/${ref.threadId}`, ref);
    }
  }
  return [...refs.values()];
}

/** Rewrites each link outside code `replace` answers for. `label` is a Markdown link's own text. */
export function replaceThreadLinks(
  markdown: string,
  replace: (link: ThreadLink, label: string | undefined) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const groups = args.at(-1) as Partial<
      Record<"angleHref" | "href" | "autolink" | "bare" | "label", string>
    >;
    const href = groups.angleHref ?? groups.href ?? groups.autolink ?? groups.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    return (link && replace(link, groups.label)) ?? source;
  });
}
