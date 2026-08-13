import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListResult,
  PullRequestListState,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  mergePullRequestDiffStats,
  narrowPullRequestsToFilters,
  partitionPullRequestsWithPriority,
  rankPullRequestMatches,
  resolveProjectScope,
  withDiffStat,
  chunkPullRequestStatRefs,
  type PullRequestDiffStats,
  type PullRequestGroup,
} from "./pullRequestList.logic";

const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 99;
const MAX_PAGE_SIZE = 500;
const EMPTY_VIEWERS: PullRequestListResult["viewers"] = {};

function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [delayMs, value]);
  return debounced;
}

export function usePullRequestList(input: {
  readonly environmentId: EnvironmentId | null;
  readonly supported: boolean;
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
  readonly projectId: ProjectId | undefined;
  readonly host: string | undefined;
  readonly query: string;
  readonly projects: ReadonlyArray<{ readonly id: string }>;
  readonly projectsKnown: boolean;
}) {
  const pullRequestEnvironmentId = input.supported ? input.environmentId : null;
  const scopedProjectId = useMemo(
    () => resolveProjectScope(input.projectId, input.projects, input.projectsKnown),
    [input.projectId, input.projects, input.projectsKnown],
  );
  const typedQuery = input.query.trim();
  const sentQuery = useDebouncedValue(typedQuery, SEARCH_DEBOUNCE_MS);
  const scopeKey = `${input.environmentId ?? ""}:${input.state}:${input.involvement}:${scopedProjectId ?? ""}:${input.host ?? ""}`;
  const filterKey = `${scopeKey}:${sentQuery}`;
  const [page, setPage] = useState<{
    key: string;
    size: number;
    cursors: Record<string, string> | null;
  }>({ key: filterKey, size: PAGE_SIZE, cursors: null });
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const sentCursors = page.key === filterKey ? page.cursors : null;
  const partitionLimit = sentCursors !== null || pageSize > PAGE_SIZE ? MAX_PAGE_SIZE : PAGE_SIZE;

  useEffect(() => {
    setPage({ key: filterKey, size: PAGE_SIZE, cursors: null });
  }, [filterKey]);

  const listQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null
      ? null
      : pullRequestEnvironment.list({
          environmentId: pullRequestEnvironmentId,
          input: {
            state: input.state,
            involvement: input.involvement,
            limit: pageSize,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(input.host ? { host: input.host } : {}),
            ...(sentQuery ? { query: sentQuery } : {}),
            ...(sentCursors ? { cursors: sentCursors } : {}),
          },
        }),
  );
  const baselineQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null
      ? null
      : pullRequestEnvironment.list({
          environmentId: pullRequestEnvironmentId,
          input: {
            state: input.state,
            involvement: input.involvement,
            limit: PAGE_SIZE,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(input.host ? { host: input.host } : {}),
          },
        }),
  );
  const partitionsWanted = input.involvement === "all" && typedQuery.length === 0;
  const authoredQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null || !partitionsWanted
      ? null
      : pullRequestEnvironment.list({
          environmentId: pullRequestEnvironmentId,
          input: {
            state: input.state,
            involvement: "authored",
            limit: partitionLimit,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(input.host ? { host: input.host } : {}),
          },
        }),
  );
  const reviewingQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null || !partitionsWanted
      ? null
      : pullRequestEnvironment.list({
          environmentId: pullRequestEnvironmentId,
          input: {
            state: input.state,
            involvement: "reviewing",
            limit: partitionLimit,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(input.host ? { host: input.host } : {}),
          },
        }),
  );

  const [loaded, setLoaded] = useState<{
    environmentId: EnvironmentId | null;
    scope: string;
    query: string;
    data: PullRequestListResult;
    partitions?: {
      authored: ReadonlyArray<PullRequestListEntry>;
      reviewing: ReadonlyArray<PullRequestListEntry>;
    };
  } | null>(null);
  useEffect(() => {
    if (!listQuery.data || listQuery.isPending) return;
    const data = listQuery.data;
    setLoaded((current) => {
      const partitions =
        partitionsWanted && authoredQuery.data !== null && reviewingQuery.data !== null
          ? { authored: authoredQuery.data.entries, reviewing: reviewingQuery.data.entries }
          : current !== null &&
              current.environmentId === input.environmentId &&
              current.scope === scopeKey
            ? current.partitions
            : undefined;
      return {
        environmentId: input.environmentId,
        scope: scopeKey,
        query: sentQuery,
        data,
        ...(partitions === undefined ? {} : { partitions }),
      };
    });
  }, [
    authoredQuery.data,
    input.environmentId,
    listQuery.data,
    listQuery.isPending,
    partitionsWanted,
    reviewingQuery.data,
    scopeKey,
    sentQuery,
  ]);

  const narrowed = useMemo(() => {
    if (
      loaded === null ||
      loaded.environmentId !== input.environmentId ||
      loaded.scope === scopeKey
    ) {
      return null;
    }
    const entries = narrowPullRequestsToFilters(loaded.data.entries, {
      state: input.state,
      projectId: scopedProjectId,
      host: input.host,
    });
    return entries.length === 0 ? null : { ...loaded.data, entries };
  }, [input.environmentId, input.host, input.state, loaded, scopeKey, scopedProjectId]);

  const answered =
    (sentQuery.length === 0 && sentCursors === null && pageSize === PAGE_SIZE
      ? baselineQuery.data
      : listQuery.data) ??
    (loaded?.scope === scopeKey && loaded.query === sentQuery ? loaded.data : null);
  const carried =
    (sentQuery.length === 0 ? baselineQuery.data : undefined) ??
    (loaded?.scope === scopeKey ? loaded.data : null) ??
    narrowed;
  const listData = answered ?? carried;
  const showingCarried = answered === null && carried !== null;
  const firstLoad = listQuery.isPending && listData === null;

  const [ordered, setOrdered] = useState<{
    key: string;
    entries: ReadonlyArray<PullRequestListEntry>;
  } | null>(null);
  useEffect(() => {
    if (!answered) return;
    setOrdered((previous) => {
      if (previous === null || previous.key !== filterKey) {
        return { key: filterKey, entries: rankPullRequestMatches(answered.entries, sentQuery) };
      }
      if (sentCursors !== null) {
        const held = new Set(
          previous.entries.map((entry) => `${entry.host}:${entry.repository}#${entry.number}`),
        );
        const arrived = answered.entries.filter(
          (entry) => !held.has(`${entry.host}:${entry.repository}#${entry.number}`),
        );
        const appended = rankPullRequestMatches(
          [...arrived].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          sentQuery,
        );
        return { key: filterKey, entries: [...previous.entries, ...appended] };
      }
      return { key: filterKey, entries: rankPullRequestMatches(answered.entries, sentQuery) };
    });
  }, [answered, filterKey, sentCursors, sentQuery]);

  const nextCursors = answered?.nextCursors ?? {};
  const canContinue = !showingCarried && Object.keys(nextCursors).length > 0;
  const loadMore = useCallback(() => {
    if (showingCarried && listQuery.error !== null) {
      listQuery.refresh();
      return;
    }
    if (canContinue) {
      setPage({ key: filterKey, size: pageSize, cursors: nextCursors });
      return;
    }
    setPage({
      key: filterKey,
      size: Math.min(pageSize + PAGE_SIZE, MAX_PAGE_SIZE),
      cursors: null,
    });
  }, [canContinue, filterKey, listQuery, nextCursors, pageSize, showingCarried]);

  const refreshList = useCallback(() => {
    if (sentCursors === null) {
      listQuery.refresh();
      return;
    }
    const loadedCount = ordered?.key === filterKey ? ordered.entries.length : pageSize;
    setPage({
      key: filterKey,
      size: Math.min(
        Math.max(pageSize, Math.ceil(loadedCount / PAGE_SIZE) * PAGE_SIZE),
        MAX_PAGE_SIZE,
      ),
      cursors: null,
    });
  }, [filterKey, listQuery, ordered, pageSize, sentCursors]);

  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [invalidating, setInvalidating] = useState(false);
  const refreshFromHost = useCallback(async () => {
    setInvalidating(true);
    try {
      if (pullRequestEnvironmentId !== null) {
        await invalidate({ environmentId: pullRequestEnvironmentId, input: {} });
      }
    } finally {
      setInvalidating(false);
    }
    refreshList();
    baselineQuery.refresh();
    authoredQuery.refresh();
    reviewingQuery.refresh();
  }, [
    authoredQuery,
    baselineQuery,
    invalidate,
    pullRequestEnvironmentId,
    refreshList,
    reviewingQuery,
  ]);

  const refreshQueries = useCallback(() => {
    refreshList();
    baselineQuery.refresh();
    authoredQuery.refresh();
    reviewingQuery.refresh();
  }, [authoredQuery, baselineQuery, refreshList, reviewingQuery]);

  const viewers = listData?.viewers ?? EMPTY_VIEWERS;
  const feedEntries = ordered?.key === filterKey ? ordered.entries : (listData?.entries ?? []);
  const visibleEntries = useMemo(
    () =>
      typedQuery.length > 0
        ? rankPullRequestMatches(feedEntries, typedQuery)
        : filterPullRequestsByInvolvement(feedEntries, viewers, input.involvement),
    [feedEntries, input.involvement, typedQuery, viewers],
  );
  const groups: ReadonlyArray<PullRequestGroup> = useMemo(() => {
    if (typedQuery.length > 0) {
      return visibleEntries.length === 0
        ? []
        : [{ key: "others", label: "Matches", entries: visibleEntries }];
    }
    if (partitionsWanted && loaded?.scope === scopeKey && loaded.partitions !== undefined) {
      return partitionPullRequestsWithPriority(
        visibleEntries,
        loaded.partitions.authored,
        loaded.partitions.reviewing,
      );
    }
    return groupPullRequestsByInvolvement(visibleEntries, viewers);
  }, [loaded, partitionsWanted, scopeKey, typedQuery, viewers, visibleEntries]);

  const statsInput = useMemo(
    () => ({
      refs: groups.flatMap((group) =>
        group.entries.map((entry) => ({
          projectId: entry.projectId,
          repository: entry.repository,
          number: entry.number,
        })),
      ),
    }),
    [groups],
  );
  const statsChunks = useMemo(() => chunkPullRequestStatRefs(statsInput.refs), [statsInput.refs]);
  const [statsChunkIndex, setStatsChunkIndex] = useState(0);
  useEffect(() => {
    setStatsChunkIndex(0);
  }, [filterKey]);
  const statsChunk =
    statsChunks[statsChunkIndex] ??
    (statsChunks.length === 0 ? [] : statsChunks[statsChunks.length - 1]!);
  const statsQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null || statsChunk.length === 0
      ? null
      : pullRequestEnvironment.listStats({
          environmentId: pullRequestEnvironmentId,
          input: { refs: statsChunk },
        }),
  );
  const [statsByRow, setStatsByRow] = useState<PullRequestDiffStats>(() => new Map());
  useEffect(() => {
    const stats = statsQuery.data?.stats;
    if (stats === undefined || statsQuery.isPending) return;
    setStatsByRow((previous) => mergePullRequestDiffStats(previous, stats));
    if (statsChunkIndex + 1 < statsChunks.length) {
      setStatsChunkIndex(statsChunkIndex + 1);
    }
  }, [statsChunkIndex, statsChunks.length, statsQuery.data, statsQuery.isPending]);

  const decoratedGroups = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        entries: group.entries.map((entry) => withDiffStat(entry, statsByRow)),
      })),
    [groups, statsByRow],
  );

  return {
    groups: decoratedGroups,
    viewers,
    providers: listData?.providers ?? [],
    errors: listData?.errors ?? [],
    truncated: listData?.truncated ?? false,
    firstLoad,
    showingCarried,
    loadingMore: listQuery.isPending && listData !== null,
    refreshing: invalidating || listQuery.isPending,
    error: listQuery.error,
    canLoadMore:
      !showingCarried &&
      (canContinue || (listData?.truncated === true && pageSize < MAX_PAGE_SIZE)),
    loadMore,
    refreshFromHost,
    refreshQueries,
    refreshStats: statsQuery.refresh,
    typedQuery,
    sentQuery,
    querySettled: typedQuery === sentQuery,
  };
}
