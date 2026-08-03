/**
 * History paging + hybrid search.
 *
 * Paging is client-owned (`logPaging.ts`) rather than atom-owned, because a
 * page is appended to a list the lane graph folds over: the graph must see the
 * full contiguous newest-first array, so the array has to live somewhere that
 * survives a page boundary.
 *
 * Search is hybrid: an instant client-side filter over what is already loaded,
 * plus a debounced server `workingCopy.log`. Every server answer is tagged with
 * the filter key it was issued for and dropped if the filter has moved on, so a
 * stale response can never be shown.
 *
 * fork: f4 source-control panel
 */
import {
  HISTORY_SEARCH_DEBOUNCE_MS,
  HISTORY_SEARCH_SERVER_LIMIT,
  historyFilterKey,
  isHashIshQuery,
  isHistoryFilterActive,
  matchesHistoryFilter,
  mergeHistorySearchResults,
  type HistoryFilter,
} from "@t3tools/client-runtime/state/working-copy-logic";
import { workingCopyRevisionAtom } from "@t3tools/client-runtime/state/working-copy";
import { useAtomValue } from "@effect/atom-react";
import type { WorkingCopyLogEntry } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EMPTY_LOG_PAGE_STATE,
  applyLogPage,
  nextLogCursor,
  type LogPageState,
} from "~/lib/sourceControl/logPaging";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { workingCopyEnvironment } from "~/state/workingCopy";

import type { SourceControlScope } from "./useWorkingCopy";

const HISTORY_PAGE_SIZE = 100;

export interface WorkingCopyHistoryView {
  /** The contiguous newest-first page state the lane graph folds over. */
  readonly page: LogPageState;
  /** What the list renders: the page, or the merged search result. */
  readonly entries: ReadonlyArray<WorkingCopyLogEntry>;
  readonly filterActive: boolean;
  /** Anything is in flight — the dimming the toolbar uses. */
  readonly isLoading: boolean;
  /**
   * fork: f4 F-16 — the NEXT page specifically. The load-more row used to read
   * the shared flag, which every mutation flips through the head reload, so the
   * button was enabled at the instant of a press it would then drop.
   */
  readonly isLoadingMore: boolean;
  readonly isSearching: boolean;
  readonly error: string | null;
  readonly canLoadMore: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
}

export function useWorkingCopyHistory(
  scope: SourceControlScope | null,
  filter: HistoryFilter,
  options: { readonly enabled: boolean },
): WorkingCopyHistoryView {
  const runLog = useAtomQueryRunner(workingCopyEnvironment.log);
  const [page, setPage] = useState<LogPageState>(EMPTY_LOG_PAGE_STATE);
  const [searchResults, setSearchResults] = useState<ReadonlyArray<WorkingCopyLogEntry>>([]);
  // fork: f4 F-16 — one flag per intent. They used to be one shared flag.
  const [headLoading, setHeadLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revision = useAtomValue(
    scope === null
      ? EMPTY_REVISION_ATOM
      : workingCopyRevisionAtom({ environmentId: scope.environmentId, cwd: scope.cwd }),
  );

  const filterKey = historyFilterKey(filter);
  const filterActive = isHistoryFilterActive(filter);
  const liveFilterKeyRef = useRef(filterKey);
  liveFilterKeyRef.current = filterKey;

  const environmentId = scope?.environmentId ?? null;
  const cwd = scope?.cwd ?? null;

  /**
   * fork: f4 — generation guard. Two rapid mutations issue two head reloads;
   * without this the older answer could resolve last and write the page that
   * does NOT contain the commit you just made.
   */
  const headGenerationRef = useRef(0);

  const loadHead = useCallback(async () => {
    if (environmentId === null || cwd === null) return;
    headGenerationRef.current += 1;
    const generation = headGenerationRef.current;
    setHeadLoading(true);
    try {
      const result = await runLog({
        environmentId,
        input: { cwd, limit: HISTORY_PAGE_SIZE },
      });
      if (headGenerationRef.current !== generation) return;
      if (result._tag === "Failure") {
        setError("The commit history could not be read.");
        return;
      }
      setError(null);
      setPage((current) => applyLogPage(current, result.value, "head"));
    } finally {
      if (headGenerationRef.current === generation) setHeadLoading(false);
    }
  }, [cwd, environmentId, runLog]);

  // Head reload on mount, on repo change, and on every mutation (the revision
  // atom is bumped by the commands' `onSettled`).
  useEffect(() => {
    if (!options.enabled) return;
    void loadHead();
  }, [loadHead, options.enabled, revision]);

  // Repo change resets the page outright — appending a second repository's
  // commits onto the first would produce a lane graph that is quietly wrong.
  useEffect(() => {
    setPage(EMPTY_LOG_PAGE_STATE);
    setSearchResults([]);
    // fork: f4 F-28 — the previous repo's failure banner used to survive the
    // switch and sit over a repository that reads perfectly well.
    setError(null);
  }, [cwd, environmentId]);

  const loadMore = useCallback(() => {
    if (environmentId === null || cwd === null || pageLoading) return;
    const cursor = nextLogCursor(page);
    if (cursor === null || !page.hasMore) return;
    setPageLoading(true);
    void (async () => {
      try {
        const result = await runLog({
          environmentId,
          input: { cwd, limit: HISTORY_PAGE_SIZE, before: cursor },
        });
        if (result._tag === "Failure") {
          setError("The next page of history could not be read.");
          return;
        }
        setError(null);
        setPage((current) => applyLogPage(current, result.value, "append"));
      } finally {
        setPageLoading(false);
      }
    })();
  }, [cwd, environmentId, page, pageLoading, runLog]);

  // Debounced server search. The response is discarded unless the filter it was
  // issued for is still the live one.
  useEffect(() => {
    if (!options.enabled || environmentId === null || cwd === null) return;
    if (!filterActive) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    const issuedFor = filterKey;
    setIsSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const query = filter.query.trim();
        const author = filter.author.trim();
        const input = {
          cwd,
          limit: HISTORY_SEARCH_SERVER_LIMIT,
          ...(query.length > 0 && !isHashIshQuery(query) ? { grep: query } : {}),
          ...(author.length > 0 ? { author } : {}),
        };
        const requests = [runLog({ environmentId, input })];
        if (isHashIshQuery(query)) {
          requests.push(runLog({ environmentId, input: { cwd, limit: 1, rev: query } }));
        }
        try {
          const results = await Promise.all(requests);
          if (liveFilterKeyRef.current !== issuedFor) return;
          const entries: WorkingCopyLogEntry[] = [];
          let anyFailed = false;
          for (const result of results) {
            if (result._tag === "Success") entries.push(...result.value.entries);
            else anyFailed = true;
          }
          // fork: f4 F-27 — a failed search used to render as "no matching
          // commits", which is a different and much worse answer.
          setError(anyFailed ? "The commit search could not be run." : null);
          setSearchResults(entries);
        } finally {
          // Cleared on EVERY path, including the stale-key early return: the
          // "searching" dimming used to stick until the next successful search.
          if (liveFilterKeyRef.current === issuedFor) setIsSearching(false);
        }
      })();
    }, HISTORY_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      setIsSearching(false);
    };
  }, [
    cwd,
    environmentId,
    filter.author,
    filter.query,
    filterActive,
    filterKey,
    options.enabled,
    runLog,
  ]);

  const entries = useMemo(() => {
    if (!filterActive) return page.entries;
    return mergeHistorySearchResults(page.entries, searchResults, filter);
  }, [filter, filterActive, page.entries, searchResults]);

  const reload = useCallback(() => {
    void loadHead();
  }, [loadHead]);

  return {
    page,
    entries,
    filterActive,
    isLoading: headLoading || pageLoading,
    isLoadingMore: pageLoading,
    isSearching,
    error,
    // Paging is only offered on the unfiltered list: "load more" under a filter
    // pages the underlying log, not the filtered view, and reads as broken.
    canLoadMore: !filterActive && page.hasMore && nextLogCursor(page) !== null,
    loadMore,
    reload,
  };
}

const EMPTY_REVISION_ATOM = workingCopyRevisionAtom({
  environmentId: "__none__" as never,
  cwd: "",
});

/** Re-exported so the toolbar can show "N of M" without importing the logic module. */
export function countMatching(
  entries: ReadonlyArray<WorkingCopyLogEntry>,
  filter: HistoryFilter,
): number {
  let count = 0;
  for (const entry of entries) {
    if (matchesHistoryFilter(entry, filter)) count += 1;
  }
  return count;
}
