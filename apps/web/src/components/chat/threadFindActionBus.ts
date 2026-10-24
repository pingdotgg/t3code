import type { OrchestrationThreadSearchMatch } from "@t3tools/contracts";
import {
  findSearchTokenRanges,
  messagePhrase,
  messageSearchTokens,
} from "@t3tools/shared/paletteSearch";
import type { ThreadFindStart } from "./threadFind";

const THREAD_FIND_OPEN_EVENT = "t3:thread-find-open";

export function requestThreadFindOpen(): void {
  window.dispatchEvent(new Event(THREAD_FIND_OPEN_EVENT));
}

export function subscribeThreadFindOpen(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_OPEN_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_OPEN_EVENT, listener);
}

const THREAD_FIND_QUERY_EVENT = "t3:thread-find-query";
interface PendingFind {
  readonly query: string;
  /** Where find starts, such as the message a palette result came from. */
  readonly start?: ThreadFindStart;
}
// A find a palette message result asked for, until that thread's view takes
// it. One the view never took (the navigation failed) lets go after a while,
// so a later visit does not open an old find.
const PENDING_FIND_MS = 30_000;
let pendingFind: (PendingFind & { readonly threadKey: string; readonly at: number }) | null = null;

/** Opens find on `query` in the thread's view, now or once it mounts. */
export function requestThreadFindQuery(threadKey: string, find: PendingFind): void {
  pendingFind = { threadKey, at: Date.now(), ...find };
  window.dispatchEvent(new Event(THREAD_FIND_QUERY_EVENT));
}

/** The find waiting for this thread's view; answers once. */
export function takeThreadFindQuery(threadKey: string): PendingFind | null {
  if (pendingFind?.threadKey !== threadKey) return null;
  const { at, threadKey: _threadKey, ...find } = pendingFind;
  pendingFind = null;
  return Date.now() - at < PENDING_FIND_MS ? find : null;
}

/**
 * The find a message search result opens, at the matched message: the whole
 * query when the snippet holds it as typed ("vp run dev"), else its longest
 * word, as the most telling ("sidebar" in "fix sidebar"), written as the
 * snippet writes it ("Café" for "cafe", since find matches accents).
 */
export function findForMessageMatch(
  match: Pick<OrchestrationThreadSearchMatch, "snippet" | "messageId">,
  query: string,
): PendingFind {
  const start = match.messageId ? { start: { entryId: match.messageId, occurrence: 0 } } : {};
  // Apostrophes are straight in the query; straightening keeps offsets.
  const together = messagePhrase(query)?.exec(match.snippet.replace(/[\u2018\u2019]/g, "'"));
  if (together) {
    return {
      query: match.snippet.slice(together.index, together.index + together[0].length),
      ...start,
    };
  }
  const word =
    messageSearchTokens(query).long.reduce(
      (longest, token) => (token.length > longest.length ? token : longest),
      "",
    ) || query;
  const ranges = findSearchTokenRanges(match.snippet, word);
  // A whole word first, as search ranked it: "Café", not "Cafe" in "Cafeteria".
  const shown =
    ranges.find((range) => !/[\p{L}\p{N}]/u.test(match.snippet[range.end] ?? "")) ?? ranges[0];
  return { query: shown ? match.snippet.slice(shown.start, shown.end) : word, ...start };
}

export function subscribeThreadFindQuery(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_QUERY_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_QUERY_EVENT, listener);
}
