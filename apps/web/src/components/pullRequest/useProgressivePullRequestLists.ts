import type {
  EnvironmentId,
  PullRequestListInput,
  PullRequestListResult,
} from "@t3tools/contracts";
import { keepPreviousData, queryOptions, useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { pullRequestQueryKeys } from "../../lib/pullRequestReactQuery";
import {
  mergePullRequestPages,
  PROGRESSIVE_AUTO_PAGE_BUDGET,
  type PullRequestListRowEntry,
} from "./pullRequestListLogic";

export type ProgressiveListRequest = Omit<PullRequestListInput, "cursors">;

export interface ProgressiveEnvState {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isFetchingMore: boolean;
  readonly error: unknown;
  readonly pageCount: number;
  readonly hasMore: boolean;
  readonly budgetExhausted: boolean;
  readonly fetchMore: () => void;
}

export interface ProgressiveLists {
  readonly entries: PullRequestListRowEntry[];
  readonly errors: ReadonlyArray<{ projectId: string; projectTitle: string; message: string }>;
  readonly envStates: ProgressiveEnvState[];
  readonly isInitialLoading: boolean;
  readonly isBackgroundLoading: boolean;
  readonly hasPartialFailure: boolean;
  readonly hasMore: boolean;
  readonly fetchMore: () => void;
  readonly refetchAll: () => void;
  readonly baseQueriesFetching: boolean;
}

function requestKeyOf(request: ProgressiveListRequest): string {
  return JSON.stringify([
    request.state,
    request.involvement ?? "all",
    request.projectId ?? null,
    request.host ?? null,
    request.limit ?? null,
    request.query ?? null,
  ]);
}

/**
 * Progressive pull-request listing: the first page per environment resolves
 * through React Query (cached, `keepPreviousData`, env-isolated keys), then
 * subsequent pages append one slice at a time without blocking usable rows.
 *
 * Server cursor semantics are preserved verbatim — each continuation hands
 * back exactly the `nextCursors` the server issued. When the automatic page
 * budget is reached with cursors still remaining, fetching stops and an
 * honest "Load more" continuation takes over instead of silently discarding
 * the rest. One slice per environment at a time keeps request fanout bounded
 * to the environment count.
 *
 * Generation invariants keep rapid filter/search changes — and base
 * refreshes — from mixing result sets: every `queryFn` closes over the same
 * render's `request` value its `queryKey` was built from (never a mutable
 * ref, so delayed executions, retries, and refetches cannot fetch one query
 * into another key's cache entry); every continuation binds its cursors to a
 * monotonic generation that bumps on request changes and base refreshes,
 * discarding the page if its generation moved on while it was in flight;
 * and each in-flight continuation holds a token so a settling request can
 * only clear its own fetching flag. A refreshed base (a new first page under
 * the same request) drops appended pages and rebuilds progressively, since
 * they belong to the old generation. A failed continuation suspends
 * automatic pagination until an explicit retry or a base refresh — never an
 * unbounded same-cursor loop — and repository errors from any page aggregate
 * into the shared error list.
 */
export function useProgressivePullRequestLists(
  environmentIds: readonly EnvironmentId[],
  request: ProgressiveListRequest,
): ProgressiveLists {
  const requestKey = requestKeyOf(request);

  const baseQueries = useQueries({
    queries: environmentIds.map((environmentId) =>
      queryOptions({
        queryKey: pullRequestQueryKeys.list(environmentId, request),
        queryFn: () => ensureEnvironmentApi(environmentId).pullRequests.list({ ...request }),
        staleTime: 30_000,
        placeholderData: keepPreviousData,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      }),
    ),
  });

  const [extraPages, setExtraPages] = useState<ReadonlyMap<string, PullRequestListResult[]>>(
    () => new Map(),
  );
  // One token per in-flight continuation, so a settling request can prove
  // ownership of the flag it clears instead of deleting a newer request's
  // flag for the same environment unconditionally.
  const [fetchingMore, setFetchingMore] = useState<ReadonlyMap<string, object>>(() => new Map());
  const [pageErrors, setPageErrors] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const lastRequestKeyRef = useRef(requestKey);
  // Monotonic generation: bumped on every request change and every base
  // refresh, so late continuations can tell their pages are stale.
  const generationRef = useRef(0);
  // Last base first-page per environment. React Query shares structure for
  // deep-equal payloads, so a changed reference means the base generation
  // actually moved — not just that a background refetch ran.
  const baseDataRefs = useRef(new Map<string, PullRequestListResult | undefined>());
  if (lastRequestKeyRef.current !== requestKey) {
    lastRequestKeyRef.current = requestKey;
    baseDataRefs.current = new Map(
      environmentIds.map((environmentId, index) => [
        environmentId as string,
        baseQueries[index]?.data,
      ]),
    );
    generationRef.current += 1;
    setExtraPages(new Map());
    setFetchingMore(new Map());
    setPageErrors(new Map());
  } else {
    let baseRefreshed = false;
    environmentIds.forEach((environmentId, index) => {
      const key = environmentId as string;
      const data = baseQueries[index]?.data;
      if (!baseDataRefs.current.has(key)) {
        baseDataRefs.current.set(key, data);
        return;
      }
      if (baseDataRefs.current.get(key) !== data) {
        baseDataRefs.current.set(key, data);
        baseRefreshed = true;
      }
    });
    if (baseRefreshed) {
      // The base generation moved under the same request (window-focus or
      // mutation refresh with actually new rows): appended pages belong to
      // the old generation, so drop them instead of merging stale rows and
      // shifted boundaries into the new first page. Progressive pagination
      // rebuilds from the fresh base; the failure flags clear too, which
      // permits one bounded retry — a fresh failure re-suspends automation.
      generationRef.current += 1;
      setExtraPages(new Map());
      setFetchingMore(new Map());
      setPageErrors(new Map());
    }
  }

  const baseByEnv = useMemo(() => {
    const map = new Map<string, PullRequestListResult | undefined>();
    environmentIds.forEach((environmentId, index) => {
      map.set(environmentId as string, baseQueries[index]?.data);
    });
    return map;
  }, [baseQueries, environmentIds]);

  const lastPageOf = useCallback(
    (environmentId: EnvironmentId): PullRequestListResult | undefined => {
      const extras = extraPages.get(environmentId as string) ?? [];
      if (extras.length > 0) return extras[extras.length - 1];
      return baseByEnv.get(environmentId as string);
    },
    [baseByEnv, extraPages],
  );

  const fetchMoreFor = useCallback(
    async (environmentId: EnvironmentId) => {
      const key = environmentId as string;
      if (fetchingMore.has(key)) return;
      const last = lastPageOf(environmentId);
      const cursors = last?.nextCursors;
      if (!cursors || Object.keys(cursors).length === 0) return;
      // Bind the continuation to the generation that issued these cursors.
      // If the filter/search moves on — or the base refreshes — while the
      // slice is in flight, the page is discarded on landing instead of
      // mixing two generations' rows.
      const requestAtCall = request;
      const generationAtCall = generationRef.current;
      const token = {};
      setFetchingMore((previous) => new Map(previous).set(key, token));
      try {
        const page = await ensureEnvironmentApi(environmentId).pullRequests.list({
          ...requestAtCall,
          cursors,
        });
        if (generationRef.current !== generationAtCall) return;
        setExtraPages((previous) => {
          const next = new Map(previous);
          next.set(key, [...(next.get(key) ?? []), page]);
          return next;
        });
        setPageErrors((previous) => {
          if (!previous.has(key)) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      } catch (error) {
        if (generationRef.current !== generationAtCall) return;
        setPageErrors((previous) => new Map(previous).set(key, error));
      } finally {
        setFetchingMore((previous) => {
          if (previous.get(key) !== token) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      }
    },
    [fetchingMore, lastPageOf, request],
  );

  const autoFetch = useCallback(() => {
    for (const environmentId of environmentIds) {
      const key = environmentId as string;
      const base = baseByEnv.get(key);
      if (!base || fetchingMore.has(key)) continue;
      // A failed continuation suspends automatic pagination: without this
      // the loop would re-request the same cursor on every state change
      // with no backoff and no budget. An explicit fetchMore retry — or a
      // base refresh, which clears the flag for one bounded retry — resumes.
      if (pageErrors.has(key)) continue;
      const extras = extraPages.get(key) ?? [];
      const pageCount = 1 + extras.length;
      const last = extras.length > 0 ? extras[extras.length - 1] : base;
      const remaining = last?.nextCursors ? Object.keys(last.nextCursors).length : 0;
      if (remaining > 0 && pageCount < PROGRESSIVE_AUTO_PAGE_BUDGET) {
        void fetchMoreFor(environmentId);
      }
    }
  }, [baseByEnv, environmentIds, extraPages, fetchingMore, fetchMoreFor, pageErrors]);

  useEffect(() => {
    autoFetch();
  }, [autoFetch]);

  const entries = useMemo(() => {
    const merged: PullRequestListRowEntry[] = [];
    environmentIds.forEach((environmentId, index) => {
      const base = baseQueries[index]?.data;
      const extras = extraPages.get(environmentId as string) ?? [];
      const pages = base ? [base, ...extras] : extras;
      const rows = pages.flatMap((page) =>
        page.entries.map((entry) => ({ ...entry, environmentId })),
      );
      merged.push(...mergePullRequestPages([], rows));
    });
    return merged;
  }, [baseQueries, environmentIds, extraPages]);

  // Repository failures that land on later pages resolve successfully with
  // a populated `errors` array, so they must be aggregated like first-page
  // ones — otherwise pagination reads as successfully finished while rows
  // are silently missing.
  const continuationErrors = useMemo(
    () => [...extraPages.values()].flatMap((pages) => pages.flatMap((page) => page.errors)),
    [extraPages],
  );
  const errors = useMemo(
    () => [...baseQueries.flatMap((query) => query.data?.errors ?? []), ...continuationErrors],
    [baseQueries, continuationErrors],
  );

  const envStates: ProgressiveEnvState[] = useMemo(
    () =>
      environmentIds.map((environmentId, index) => {
        const query = baseQueries[index];
        const extras = extraPages.get(environmentId as string) ?? [];
        const pageCount = (query?.data ? 1 : 0) + extras.length;
        const last = extras.length > 0 ? extras[extras.length - 1] : query?.data;
        const remaining = last?.nextCursors ? Object.keys(last.nextCursors).length : 0;
        const hasMore = remaining > 0;
        return {
          environmentId,
          isPending: query?.isPending ?? true,
          isFetching: query?.isFetching ?? false,
          isFetchingMore: fetchingMore.has(environmentId as string),
          error: query?.error ?? pageErrors.get(environmentId as string) ?? null,
          pageCount,
          hasMore,
          budgetExhausted: hasMore && pageCount >= PROGRESSIVE_AUTO_PAGE_BUDGET,
          fetchMore: () => void fetchMoreFor(environmentId),
        };
      }),
    [baseQueries, environmentIds, extraPages, fetchingMore, fetchMoreFor, pageErrors],
  );

  const isInitialLoading = baseQueries.length > 0 && baseQueries.every((query) => query.isPending);
  const isBackgroundLoading =
    baseQueries.some((query) => query.isFetching) ||
    envStates.some((state) => state.isFetchingMore);
  const succeededEnvs = envStates.filter((state) => !state.isPending && !state.error).length;
  const failedEnvs = envStates.filter(
    (state) => state.error !== null && state.error !== undefined,
  ).length;
  // A late repository failure arrives silently in the background (unlike a
  // first-page one seen during initial load), so it earns the partial
  // banner whenever rows are still shown.
  const hasPartialFailure =
    (failedEnvs > 0 && (succeededEnvs > 0 || entries.length > 0)) ||
    (continuationErrors.length > 0 && entries.length > 0);
  const hasMore = envStates.some((state) => state.hasMore);

  const fetchMore = useCallback(() => {
    for (const state of envStates) {
      if (state.hasMore && !state.isFetchingMore) state.fetchMore();
    }
  }, [envStates]);

  const refetchAll = useCallback(() => {
    setExtraPages(new Map());
    setPageErrors(new Map());
    void Promise.all(baseQueries.map((query) => query.refetch()));
  }, [baseQueries]);

  return {
    entries,
    errors,
    envStates,
    isInitialLoading,
    isBackgroundLoading,
    hasPartialFailure,
    hasMore,
    fetchMore,
    refetchAll,
    baseQueriesFetching: baseQueries.some((query) => query.isFetching),
  };
}
