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
  readonly isLoading: boolean;
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
  const [isLoading, setIsLoading] = useState(false);
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

  const loadHead = useCallback(async () => {
    if (environmentId === null || cwd === null) return;
    setIsLoading(true);
    try {
      const result = await runLog({
        environmentId,
        input: { cwd, limit: HISTORY_PAGE_SIZE },
      });
      if (result._tag === "Failure") {
        setError("The commit history could not be read.");
        return;
      }
      setError(null);
      setPage((current) => applyLogPage(current, result.value, "head"));
    } finally {
      setIsLoading(false);
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
  }, [cwd, environmentId]);

  const loadMore = useCallback(() => {
    if (environmentId === null || cwd === null || isLoading) return;
    const cursor = nextLogCursor(page);
    if (cursor === null || !page.hasMore) return;
    setIsLoading(true);
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
        setIsLoading(false);
      }
    })();
  }, [cwd, environmentId, isLoading, page, runLog]);

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
        const results = await Promise.all(requests);
        if (liveFilterKeyRef.current !== issuedFor) return;
        const entries: WorkingCopyLogEntry[] = [];
        for (const result of results) {
          if (result._tag === "Success") entries.push(...result.value.entries);
        }
        setSearchResults(entries);
        setIsSearching(false);
      })();
    }, HISTORY_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
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

  return {
    page,
    entries,
    filterActive,
    isLoading,
    isSearching,
    error,
    // Paging is only offered on the unfiltered list: "load more" under a filter
    // pages the underlying log, not the filtered view, and reads as broken.
    canLoadMore: !filterActive && page.hasMore,
    loadMore,
    reload: () => {
      void loadHead();
    },
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
