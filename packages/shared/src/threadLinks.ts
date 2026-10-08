import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Agents mention another thread in Markdown as `[title](t3-thread://v1/<threadId>)`. The id is
 * the reference and resolves in the environment of the message that holds it. Titles change, so
 * clients show the thread's current title; the label only stands in for a thread they cannot see.
 */
export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>t3-thread:\/\/v1\/[^\s)]+)\)/g;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The id as written. Thread ids can hold percent escapes of their own, so it is not decoded. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  return Option.getOrNull(decodeThreadId(href.slice(THREAD_LINK_HREF_PREFIX.length)));
}

/**
 * Agents often percent-encode the id anyway. When the id as written names no thread, clients try
 * this decoded form. Null when decoding changes nothing or fails.
 */
export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/** A thread link whose label survives Markdown: no brackets, backslashes, or line breaks. */
export function formatThreadLink(threadId: string, label: string): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `[${cleaned || threadId}](${THREAD_LINK_HREF_PREFIX}${threadId})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`](${THREAD_LINK_HREF_PREFIX}`);
}

/**
 * Relabels each thread link with `title(threadId)`, pointing it at the thread that title came from.
 * A link it returns nothing for keeps its label.
 */
export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const href = (args.at(-1) as { href?: string }).href;
    if (href === undefined) return source;
    const written = parseThreadLinkHref(href);
    if (written === null) return source;
    // The decoded id only stands in when the id as written names no thread.
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written) === undefined && decoded !== null && title(decoded) !== undefined
        ? decoded
        : written;
    const label = title(threadId)?.trim();
    return label ? formatThreadLink(threadId, label) : source;
  });
}
