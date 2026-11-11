import {
  nextShownOrder,
  threadSearchMatchKey,
  threadSearchSubject,
  type EnvironmentThreadSearchMatch,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { foldSearchQuery, rankMessageMatches } from "@t3tools/shared/paletteSearch";
import { useMemo, useState } from "react";

const NO_MATCHES: ReadonlyMap<string, EnvironmentThreadSearchMatch> = new Map();

/**
 * A thread list's message matches by thread key, ranked across environments
 * as the palette ranks them. Rows already shown keep their places while
 * slower environments answer. The map keeps its identity while nothing
 * changes, since lists pass it to every row.
 */
export function useThreadListSearchMatches(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  search: {
    readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
    readonly query: string;
  },
): ReadonlyMap<string, EnvironmentThreadSearchMatch> {
  const [now] = useState(() => Date.now());
  const [shownOrder, setShownOrder] = useState<ShownOrder | null>(null);
  const rankedKeys = useMemo(() => {
    if (search.matches.length === 0) return [];
    const subjectByKey = new Map(
      threads.map((thread) => [
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        threadSearchSubject(thread, null),
      ]),
    );
    return rankMessageMatches(
      search.matches,
      (match) => subjectByKey.get(threadSearchMatchKey(match)),
      foldSearchQuery(search.query),
      now,
      { picks: false },
    ).map(threadSearchMatchKey);
  }, [now, search.matches, search.query, threads]);
  // A list shows every match, so nothing is cut; late ones go below.
  const order = nextShownOrder(shownOrder, search.query, rankedKeys, Number.POSITIVE_INFINITY);
  if (order !== shownOrder) setShownOrder(order);
  return useMemo(() => {
    if (order.keys.length === 0) return NO_MATCHES;
    const matchByKey = new Map(search.matches.map((match) => [threadSearchMatchKey(match), match]));
    return new Map(
      order.keys.flatMap((key) => {
        const match = matchByKey.get(key);
        return match ? [[key, match] as const] : [];
      }),
    );
  }, [order, search.matches]);
}
