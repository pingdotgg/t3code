import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * In-app links to threads. Agents put them in Markdown as
 * `[title](t3-thread://v1/<environmentId>/<threadId>)`, and clients open the
 * thread instead of a browser. Thread tools return a ready `link` for each
 * thread, so agents never build one by hand.
 */
export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const LINK_LABEL_MAX_CHARS = 120;

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

function formatThreadLinkHref(environmentId: string, threadId: string): string {
  return `${THREAD_LINK_HREF_PREFIX}${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

/** A Markdown link to the thread, labeled with its title. */
export function formatThreadLink(thread: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}): string {
  const label =
    thread.title
      .replace(/[[\]\\\r\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, LINK_LABEL_MAX_CHARS) || "Untitled thread";
  return `[${label}](${formatThreadLinkHref(thread.environmentId, thread.threadId)})`;
}

export function parseThreadLinkHref(
  href: string,
): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  const parts = href.slice(THREAD_LINK_HREF_PREFIX.length).split("/");
  if (parts.length !== 2) return null;
  try {
    const environmentId = decodeEnvironmentId(decodeURIComponent(parts[0]!));
    const threadId = decodeThreadId(decodeURIComponent(parts[1]!));
    return Option.isSome(environmentId) && Option.isSome(threadId)
      ? { environmentId: environmentId.value, threadId: threadId.value }
      : null;
  } catch {
    // Malformed percent encoding.
    return null;
  }
}
