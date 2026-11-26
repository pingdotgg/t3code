import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const V1_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const V2_PREFIX = `${THREAD_LINK_PROTOCOL}://v2/`;
const HOSTED_PREFIX = `${DEFAULT_HOSTED_APP_URL}/threads/`;
const HOSTED_SEGMENT = "[A-Za-z0-9_%-]+";
const HOSTED_LINK = `${HOSTED_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}${HOSTED_SEGMENT}/${HOSTED_SEGMENT}`;
const THREAD_HREF = String.raw`t3-thread:\/\/v[12]\/`;
// A label stops at any bracket, so a run of unclosed brackets is scanned once, not once per bracket.
const LABEL = String.raw`[^[\]\n]*`;
const LIST_MARKERS = String.raw`(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*`;
const QUOTE_PREFIX = new RegExp(String.raw`^([ \t]*${LIST_MARKERS})(>(?:[ \t]*>)+)`, "gm");
// Move inter-marker spacing before the quote so fence depth matches and offsets stay intact. A label
// may span \r or U+2028, which multiline `^` follows, so labels and output are read from the original.
const threadLinkSource = (markdown: string) =>
  markdown.replace(QUOTE_PREFIX, (_source, indent: string, quote: string) => {
    const markers = quote.replace(/[ \t]/g, "");
    return indent + " ".repeat(quote.length - markers.length) + markers;
  });
// CommonMark fences start on their own line (optional blockquotes, indentation, or list markers)
// and close on a line with at least as many of the same marker; backtick info strings hold no `.
// Quote markers are compared from the first `>`, so lines may indent them differently.
// Space after the markers is matched only after a `>`: two adjacent `[ \t]*` backtrack quadratically.
const AFTER_QUOTE = String.raw`(?:(?<=>)[ \t]*)?`;
const fencedCode = (char: "`" | "~", name: string) => {
  const bq = `${name}Bq`;
  const info = char === "`" ? "[^`\\r\\n]*" : "[^\\r\\n]*";
  const closer = String.raw`[ \t]*\k<${bq}>${AFTER_QUOTE}\k<${name}>${char}*(?!${char})[ \t]*\r?$`;
  return String.raw`^[ \t]*${LIST_MARKERS}(?<${bq}>(?:>(?:[ \t]*>)*)?)(?:(?<=>)[ \t]*${LIST_MARKERS})?(?<${name}>${char}{3,}(?!${char}))${info}(?=\r?$)(?:(?:\r\n?|\n)(?!${closer})[ \t]*\k<${bq}>[^\r\n]*)*(?:(?:\r\n?|\n)${closer})?`;
};
// A code span may wrap lines until its paragraph ends: a blank line, heading, list item, fence, rule,
// setext underline, or deeper blockquote.
const SPAN_BREAK_LINE =
  /[ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|(?:[-*+]|\d{1,9}[.)])[ \t]|`{3,}[^`\r\n]*\r?$|~{3,})/my;
const LINE_PREFIX = /([ \t]*)(>|(?:[-*+]|\d{1,9}[.)])[ \t]+)?/y;
const THEMATIC_BREAK = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/;
const SETEXT_UNDERLINE = /^(?:-+|=+)[ \t]*\r?$/;
// Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
// nothing, code is literal, and a link to anywhere else keeps a thread URL in its label or href.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[!-/:-@[-\`{-~]`,
    fencedCode("`", "bt"),
    fencedCode("~", "tl"),
    String.raw`(?<spanTicks>\`+)`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[(?<label>${LABEL})\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+|${HOSTED_LINK})>|(?<href>${THREAD_HREF}[^\s>)]+|${HOSTED_LINK}))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
    String.raw`<(?<autolink>${THREAD_HREF}[^\s<>]+|${HOSTED_LINK})>`,
    // After a URL character the hosted link is part of a longer URL, such as a redirect target.
    String.raw`(?<![A-Za-z0-9%/?#=&@+-])(?<bare>${HOSTED_LINK})(?![\w%/?#-])`,
  ].join("|"),
  "gm",
);

function codeSpanLines(markdown: string) {
  const lines: Array<{ start: number; depth: number; breaksSpan: boolean }> = [];
  const listIndents: number[] = [];
  let paragraphDepth: number | undefined;
  let start = 0;
  for (const line of markdown.split("\n")) {
    let offset = 0;
    let depth = 0;
    let hasList = false;
    let listOffset = 0;
    while (offset < line.length) {
      LINE_PREFIX.lastIndex = offset;
      const prefix = LINE_PREFIX.exec(line);
      if (prefix === null) break;
      const indent = prefix[1]!.replace(/\t/g, "    ").length;
      if (
        listOffset === 0 &&
        paragraphDepth === undefined &&
        indent < (listIndents[depth] ?? 0) &&
        line.trim()
      ) {
        listIndents.length = depth;
      }
      const containerIndent = listIndents[depth] ?? 0;
      const continuedIndent = indent >= containerIndent ? containerIndent : 0;
      if (prefix[2] === undefined || indent - continuedIndent > 3) break;
      offset = LINE_PREFIX.lastIndex;
      if (prefix[2] === ">") {
        depth++;
        listOffset = 0;
        if (line[offset] === " " || line[offset] === "\t") offset++;
      } else {
        listOffset += indent + prefix[2]!.replace(/\t/g, "    ").length;
        listIndents[depth] = listOffset;
        hasList = true;
      }
    }
    const content = line.slice(offset);
    const text = content.trimStart();
    const indent = content.slice(0, content.length - text.length).replace(/\t/g, "    ").length;
    const containerIndent = hasList ? 0 : (listIndents[depth] ?? 0);
    const lazy = indent < containerIndent || depth < (paragraphDepth ?? 0);
    // Rules and setext underlines end a paragraph unless indented as code; a lazy line is never an underline.
    const breaksSpan =
      !hasList &&
      (lazy ? indent : indent - containerIndent) <= 3 &&
      (THEMATIC_BREAK.test(text) ||
        (paragraphDepth !== undefined && !lazy && SETEXT_UNDERLINE.test(text)));
    const endsParagraph =
      breaksSpan ||
      /^(?:[ \t\r]*$|[ \t]*#{1,6}(?:[ \t]|$)|[ \t]*`{3,}[^`]*$|[ \t]*~{3,})/.test(content);
    const effectiveDepth = endsParagraph || hasList ? depth : Math.max(depth, paragraphDepth ?? 0);
    lines.push({ start, depth: effectiveDepth, breaksSpan });
    paragraphDepth = endsParagraph ? undefined : effectiveDepth;
    start += line.length + 1;
  }
  return lines;
}

function findCodeSpanEnd(
  markdown: string,
  openIndex: number,
  tickCount: number,
  lines: ReturnType<typeof codeSpanLines>,
  lineIndex: number,
): number {
  const openDepth = lines[lineIndex]!.depth;
  for (let i = openIndex + tickCount; i < markdown.length; i++) {
    if (markdown[i] === "`") {
      let runEnd = i + 1;
      while (markdown[runEnd] === "`") runEnd++;
      if (runEnd - i === tickCount) return runEnd;
      i = runEnd - 1;
    } else if (markdown[i] === "\n") {
      lineIndex++;
      SPAN_BREAK_LINE.lastIndex = i + 1;
      const line = lines[lineIndex]!;
      if (SPAN_BREAK_LINE.test(markdown) || line.breaksSpan || line.depth > openDepth) return -1;
    }
  }
  return -1;
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

/** Every thread the markdown's links can name, so their titles are keyed reads. */
export function threadLinkRefs(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  replaceThreadLinks(markdown, (link) => {
    for (const ref of threadLinkCandidates(link, messageEnvironmentId)) {
      refs.set(`${ref.environmentId}/${ref.threadId}`, ref);
    }
    return undefined;
  });
  return [...refs.values()];
}

/** Rewrites each link outside code `replace` answers for. `label` is a Markdown link's own text. */
export function replaceThreadLinks(
  markdown: string,
  replace: (link: ThreadLink, label: string | undefined) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  // Hermes' matchAll yields matches without `groups`; exec keeps them.
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  const source = threadLinkSource(markdown);
  let result = "";
  let cursor = 0;
  let lines: ReturnType<typeof codeSpanLines> | undefined;
  let lineIndex = 0;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const spanTicks = match.groups?.spanTicks;
    if (spanTicks !== undefined) {
      lines ??= codeSpanLines(markdown);
      while (lineIndex + 1 < lines.length && lines[lineIndex + 1]!.start <= match.index)
        lineIndex++;
      const spanEnd = findCodeSpanEnd(markdown, match.index, spanTicks.length, lines, lineIndex);
      if (spanEnd !== -1) pattern.lastIndex = spanEnd;
      continue;
    }
    const href =
      match.groups?.angleHref ?? match.groups?.href ?? match.groups?.autolink ?? match.groups?.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    const label = match.groups?.label;
    const rewritten =
      link === null
        ? undefined
        : replace(link, label && markdown.slice(match.index + 1, match.index + 1 + label.length));
    if (rewritten === undefined) continue;
    result += markdown.slice(cursor, match.index) + rewritten;
    cursor = match.index + match[0].length;
  }
  return cursor === 0 ? markdown : result + markdown.slice(cursor);
}
