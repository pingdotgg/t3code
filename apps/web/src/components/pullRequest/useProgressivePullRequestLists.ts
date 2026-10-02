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
 * Two generation invariants keep rapid filter/search changes from mixing
 * result sets: every `queryFn` closes over the same render's `request` value
 * its `queryKey` was built from (never a mutable ref, so delayed executions,
 * retries, and refetches cannot fetch one query into another key's cache
 * entry), and every continuation binds its cursors to the request generation
 * that issued them, discarding the page if the request moved on while it was
 * in flight.
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
  const [fetchingMore, setFetchingMore] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [pageErrors, setPageErrors] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const lastRequestKeyRef = useRef(requestKey);
  if (lastRequestKeyRef.current !== requestKey) {
    lastRequestKeyRef.current = requestKey;
    setExtraPages(new Map());
    setFetchingMore(new Map());
    setPageErrors(new Map());
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
      if (fetchingMore.get(key)) return;
      const last = lastPageOf(environmentId);
      const cursors = last?.nextCursors;
      if (!cursors || Object.keys(cursors).length === 0) return;
      // Bind the continuation to the request generation that issued these
      // cursors. If the filter/search moves on while the slice is in flight,
      // the page is discarded on landing instead of mixing two queries' rows.
      const requestAtCall = request;
      const requestKeyAtCall = requestKey;
      setFetchingMore((previous) => new Map(previous).set(key, true));
      try {
        const page = await ensureEnvironmentApi(environmentId).pullRequests.list({
          ...requestAtCall,
          cursors,
        });
        if (lastRequestKeyRef.current !== requestKeyAtCall) return;
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
        if (lastRequestKeyRef.current !== requestKeyAtCall) return;
        setPageErrors((previous) => new Map(previous).set(key, error));
      } finally {
        setFetchingMore((previous) => {
          if (!previous.has(key)) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      }
    },
    [extraPages, fetchingMore, lastPageOf, request, requestKey],
  );

  const autoFetch = useCallback(() => {
    for (const environmentId of environmentIds) {
      const key = environmentId as string;
      const base = baseByEnv.get(key);
      if (!base || fetchingMore.get(key)) continue;
      const extras = extraPages.get(key) ?? [];
      const pageCount = 1 + extras.length;
      const last = extras.length > 0 ? extras[extras.length - 1] : base;
      const remaining = last?.nextCursors ? Object.keys(last.nextCursors).length : 0;
      if (remaining > 0 && pageCount < PROGRESSIVE_AUTO_PAGE_BUDGET) {
        void fetchMoreFor(environmentId);
      }
    }
  }, [baseByEnv, environmentIds, extraPages, fetchingMore, fetchMoreFor]);

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

  const errors = useMemo(
    () => baseQueries.flatMap((query) => query.data?.errors ?? []),
    [baseQueries],
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
          isFetchingMore: fetchingMore.get(environmentId as string) === true,
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
  const hasPartialFailure = failedEnvs > 0 && (succeededEnvs > 0 || entries.length > 0);
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
