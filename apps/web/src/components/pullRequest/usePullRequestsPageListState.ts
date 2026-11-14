import { SidebarPointerSensor } from "~/components/Sidebar.pointer";
import { resolveSidebarSweepKeys } from "~/components/Sidebar.logic";

import type { EnvironmentId, PullRequestListResult } from "@t3tools/contracts";

import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  collectPullRequestListFacets,
  mergePullRequestDiffStats,
  pullRequestDiffStatKey,
  pullRequestEntryKey,
  pullRequestStatsRefreshBatches,
  pullRequestStatsRequestBatches,
  retainVisiblePullRequestStatsBatches,
  type EnvironmentPullRequestEntry,
  type PullRequestDiffStats,
  type PullRequestStatsBatch,
  type PullRequestStatsScope,
} from "./pullRequestList.logic";

import { usePullRequestDisplayGroups } from "./usePullRequestListView";
import { pullRequestGroups } from "./pullRequestListGroups.logic";

import { registerCommands } from "~/shortcuts/dispatcher";

import { useStableCallback } from "~/hooks/useStableCallback";

import { usePullRequestListStats } from "~/state/pullRequests";

import { usePullRequestsPageState } from "./usePullRequestsPageState";

/**
 * One whole page from the host and no more: every provider asks for one row beyond the page as
 * its "is there more" probe, and GitHub serves a hundred per request — so asking for ninety-nine
 * costs one round trip where a hundred costs two.
 */
const EMPTY_VIEWERS: PullRequestListResult["viewers"] = {};
/**
 * Stats, grouping, and row interaction for the list above the page's own layout: which rows ask
 * for diff stats, the pointer close-sweep, and the display groups those render.
 */
export function usePullRequestsPageListState(prev: ReturnType<typeof usePullRequestsPageState>) {
  const {
    answered,
    authoredQuery,
    baselineEmpty,
    baselineQuery,
    closeBatch,
    closingKeys,
    environmentKey,
    facetQuery,
    filterKey,
    hasLocalFilters,
    invalidate,
    listData,
    loaded,
    localFilters,
    ordered,
    overrides,
    panelEnvironmentId,
    panelSummary,
    partitionsWanted,
    queryEnvironmentIds,
    querySettled,
    refreshList,
    reviewingQuery,
    scopeKey,
    search,
    setDetailRefreshToken,
    setInvalidating,
    showingCarried,
    sort,
    statsPolicy,
    statsScope,
    typedParsed,
  } = prev;
  const viewers = baselineQuery.data?.viewers ?? listData?.viewers ?? EMPTY_VIEWERS;
  const listErrors = baselineQuery.data?.errors ?? listData?.errors ?? [];
  const facets = collectPullRequestListFacets(
    [
      ...(facetQuery.data?.entries ?? []),
      ...(baselineQuery.data?.entries ?? listData?.entries ?? []),
    ],
    search.state,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const {
    entries,
    listedPullRequestTabStatuses,
    groups,
    entriesByStatsKey,
    heldPullRequestsBySurface,
  } = pullRequestGroups({
    known: ordered?.key === filterKey ? ordered.entries : (listData?.entries ?? []),
    providers: baselineQuery.data?.providers ?? listData?.providers ?? [],
    viewers,
    involvement: search.involvement,
    localFilters,
    hasLocalFilters,
    text: typedParsed.text,
    answeredLocally: querySettled && !showingCarried,
    baselineEmpty,
    held:
      loaded !== null && loaded.environmentKey === environmentKey && loaded.scope === scopeKey
        ? loaded.partitions
        : undefined,
    authored: partitionsWanted ? authoredQuery.data?.entries : undefined,
    reviewing: partitionsWanted ? reviewingQuery.data?.entries : undefined,
    partitionsWanted,
  });

  const visibleStatsKeys = useRef({ key: filterKey, values: new Set<string>() });
  const [statsByRow, setStatsByRow] = useState<PullRequestDiffStats>(() => new Map());
  if (
    panelEnvironmentId !== null &&
    panelSummary?.additions !== undefined &&
    panelSummary.deletions !== undefined
  ) {
    const stat = {
      ...panelSummary,
      environmentId: panelEnvironmentId,
      additions: panelSummary.additions,
      deletions: panelSummary.deletions,
    };
    const previous = statsByRow.get(pullRequestDiffStatKey(stat));
    if (previous?.additions !== stat.additions || previous.deletions !== stat.deletions) {
      setStatsByRow(mergePullRequestDiffStats(statsByRow, [stat]));
    }
  }
  const [statsTargetState, setStatsTargetState] = useState<{
    readonly key: string;
    readonly batches: ReadonlyArray<PullRequestStatsBatch>;
  }>({ key: filterKey, batches: [] });
  const statsBatches = statsTargetState.key === filterKey ? statsTargetState.batches : [];
  const statsTargets = statsBatches.map(({ environmentId, input }) => ({
    environmentId,
    input,
  }));
  const statsQuery = usePullRequestListStats(statsTargets);
  const statsObserver = useRef<IntersectionObserver | null>(null);
  const statsRows = useRef(new Set<HTMLDivElement>());
  // Called from a row's ref cleanup, which keeps the render it attached in; this reads the latest.
  const releaseStatsRow = useStableCallback((key: string | undefined) => {
    const visible = visibleStatsKeys.current;
    if (
      statsPolicy !== "visible" ||
      key === undefined ||
      !visible.values.delete(key) ||
      statsQuery.isPending
    ) {
      return;
    }
    setStatsTargetState((current) => {
      if (current.key !== visible.key) return current;
      const batches = retainVisiblePullRequestStatsBatches(current.batches, visible.values);
      return batches.length === current.batches.length ? current : { key: current.key, batches };
    });
  });
  // Every row takes this as its ref, so a new identity would detach and reattach them all.
  const registerStatsRow = useStableCallback((node: HTMLDivElement | null) => {
    if (node === null || typeof IntersectionObserver === "undefined") return;
    statsRows.current.add(node);
    statsObserver.current?.observe(node);
    return () => {
      statsRows.current.delete(node);
      statsObserver.current?.unobserve(node);
      releaseStatsRow(node.dataset.pullRequestStatsKey);
    };
  });
  // Arriving stats must not re-run the effects that ask for them.
  const readStatsProgress = useEffectEvent(() => ({
    statsByRow,
    pending: statsQuery.isPending,
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- queues eager stats batches for the rows, reading known stats and visible keys held outside render
  useEffect(() => {
    if (statsPolicy !== "eager") return;
    const { statsByRow: known } = readStatsProgress();
    const candidateKeys = visibleStatsKeys.current.values;
    setStatsTargetState((current) => {
      const batches = current.key === filterKey ? current.batches : [];
      const added = pullRequestStatsRequestBatches({
        entriesByKey: entriesByStatsKey,
        candidateKeys,
        policy: statsPolicy,
        activeBatches: batches,
        statsByRow: known,
      });
      if (added.length === 0 && current.key === filterKey) return current;
      return { key: filterKey, batches: [...batches, ...added] };
    });
  }, [filterKey, entriesByStatsKey, statsPolicy]);
  // The observer outlives the rows it watches, so it reads the rows held at the time it fires.
  const readStatsRows = useEffectEvent(() => entriesByStatsKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- IntersectionObserver on rows requests stats for rows that scroll into view
  useEffect(() => {
    if (statsPolicy !== "visible" || typeof IntersectionObserver === "undefined") return;
    visibleStatsKeys.current = { key: filterKey, values: new Set() };
    const observer = new IntersectionObserver(
      (observed) => {
        const visible = visibleStatsKeys.current;
        if (visible.key !== filterKey) return;
        let changed = false;
        const entered = new Set<string>();
        const entriesByKey = readStatsRows();
        for (const item of observed) {
          const key = (item.target as HTMLElement).dataset.pullRequestStatsKey;
          if (key === undefined) continue;
          const wasVisible = visible.values.has(key);
          if (item.isIntersecting && entriesByKey.has(key)) {
            visible.values.add(key);
            if (!wasVisible) entered.add(key);
          } else {
            visible.values.delete(key);
          }
          if (wasVisible !== visible.values.has(key)) changed = true;
        }
        if (!changed) return;
        const progress = readStatsProgress();
        setStatsTargetState((current) => {
          const batches = current.key === filterKey ? current.batches : [];
          const retained = progress.pending
            ? batches
            : retainVisiblePullRequestStatsBatches(batches, visible.values);
          const added = pullRequestStatsRequestBatches({
            entriesByKey,
            candidateKeys: entered,
            policy: statsPolicy,
            activeBatches: batches,
            statsByRow: progress.statsByRow,
          });
          if (added.length === 0 && retained.length === batches.length) return current;
          return { key: filterKey, batches: [...retained, ...added] };
        });
      },
      { root: scrollRef.current, rootMargin: "480px" },
    );
    statsObserver.current = observer;
    for (const row of statsRows.current) observer.observe(row);
    return () => {
      observer.disconnect();
      if (statsObserver.current === observer) statsObserver.current = null;
    };
  }, [filterKey, statsPolicy]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prunes stats batches to the observer's visible rows once a stats request settles
  useEffect(() => {
    if (statsPolicy !== "visible" || statsQuery.isPending) return;
    const visible = visibleStatsKeys.current;
    setStatsTargetState((current) => {
      if (current.key !== filterKey || visible.key !== filterKey) return current;
      const batches = retainVisiblePullRequestStatsBatches(current.batches, visible.values);
      return batches.length === current.batches.length ? current : { key: current.key, batches };
    });
  }, [filterKey, statsPolicy, statsQuery.isPending]);
  const [mergedStats, setMergedStats] = useState<typeof statsQuery.stats>(null);
  if (statsQuery.stats !== null && statsQuery.stats !== mergedStats) {
    const stats = statsQuery.stats;
    setMergedStats(stats);
    setStatsByRow((previous) => mergePullRequestDiffStats(previous, stats));
  }
  // Stable so a refresh that resumes after awaiting the host compares against the scope on screen
  // by then, not the one it started from.
  const refreshListAndStats = useStableCallback(
    (
      requestedStatsScope: PullRequestStatsScope = statsScope,
      actedEnvironmentId?: EnvironmentId,
    ) => {
      refreshList(true, actedEnvironmentId);
      const visible = visibleStatsKeys.current;
      const batches = pullRequestStatsRefreshBatches({
        requestedScope: requestedStatsScope,
        currentScope: statsScope,
        entriesByKey: entriesByStatsKey,
        candidateKeys: visible.key === requestedStatsScope.key ? visible.values : new Set(),
        statsByRow,
      });
      if (batches !== null) {
        setStatsTargetState({ key: requestedStatsScope.key, batches });
        statsQuery.refresh(
          batches
            .filter(({ environmentId }) =>
              actedEnvironmentId === undefined ? true : environmentId === actedEnvironmentId,
            )
            .map(({ environmentId, input }) => ({ environmentId, input })),
        );
      }
    },
  );
  const refreshFromHost = async () => {
    const requestedStatsScope = statsScope;
    setInvalidating(true);
    // Atom commands settle into results rather than throwing.
    await Promise.all(
      queryEnvironmentIds.map((environmentId) => invalidate({ environmentId, input: {} })),
    );
    setInvalidating(false);
    refreshListAndStats(requestedStatsScope);
    setDetailRefreshToken((token) => token + 1);
  };
  const {
    hosts,
    displayGroups,
    shownCount,
    hostActionsOf,
    closeSweepRows,
    listedPullRequestsBySurface,
  } = usePullRequestDisplayGroups({
    answered,
    host: search.host,
    groups,
    statsByRow,
    overrides,
    state: search.state,
    localFilters,
    hasLocalFilters,
    viewers,
    sort,
    text: typedParsed.text,
    involvement: search.involvement,
  });
  const showProvider = hosts.length > 1;
  const [closeSweepKeys, setCloseSweepKeys] = useState<ReadonlySet<string>>(() => new Set());
  const closeSensorRef = useRef<SidebarPointerSensor | null>(null);
  // A sweep spans many renders; each step reads the rows on screen at that moment.
  const readCloseSweep = useStableCallback(() => ({
    displayGroups,
    closeSweepRows,
    closingKeys,
    closeBatch,
    hostActionsOf,
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pointer close-sweep sensor when the list changes or on unmount
  useEffect(
    () => () => closeSensorRef.current?.cancel(),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The pointer sensor lives outside React; a new list under a sweep in progress must end it.
    [filterKey, search.q, sort],
  );
  const startCloseSweep = useStableCallback(
    (entry: EnvironmentPullRequestEntry, event: PointerEvent) => {
      closeSensorRef.current?.cancel();
      const originKey = pullRequestEntryKey(entry);
      const group = readCloseSweep().displayGroups.find((candidate) =>
        candidate.entries.some((row) => pullRequestEntryKey(row) === originKey),
      );
      if (!group || readCloseSweep().closingKeys.has(originKey)) return;
      const orderedKeys = readCloseSweep().displayGroups.flatMap((candidate) =>
        candidate.entries.map(pullRequestEntryKey),
      );
      const canClose = (key: string) => {
        const row = readCloseSweep().closeSweepRows.get(key);
        return (
          row?.groupKey === group.key &&
          row.entry.state === "open" &&
          readCloseSweep().hostActionsOf(row.entry).has("close") &&
          !readCloseSweep().closingKeys.has(key) &&
          !scrollRef.current?.querySelector(
            `[data-pull-request-key="${CSS.escape(key)}"] [data-pull-request-action-pending="true"]`,
          )
        );
      };
      let sweptKeys: string[] = [];
      let targetKey: string | null = null;
      const sweepTo = (key: string) => {
        if (key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(orderedKeys, originKey, key, canClose);
        setCloseSweepKeys(new Set(sweptKeys));
      };
      // Only while a sweep runs: Escape ends it, ahead of any other scope that would also take it.
      const releaseEscape = registerCommands(
        {},
        {
          capture: true,
          onKeyDown: (keyEvent) => {
            if (keyEvent.key !== "Escape") return false;
            keyEvent.preventDefault();
            sensor.cancel();
          },
        },
      );
      const sensor = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: 6,
          onAttach: () => {},
          onFinish: () => {
            releaseEscape();
            if (closeSensorRef.current === sensor) closeSensorRef.current = null;
            setCloseSweepKeys(new Set());
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) => {
          const viewport = scrollRef.current;
          if (!viewport) return;
          const bounds = viewport.getBoundingClientRect();
          const visibleY = Math.min(Math.max(y, bounds.top), bounds.bottom - 1);
          let key: string | null = null;
          for (const row of viewport.querySelectorAll<HTMLElement>("[data-pull-request-key]")) {
            if (key !== null && row.getBoundingClientRect().top > visibleY) break;
            key = row.dataset.pullRequestKey ?? null;
          }
          if (key !== null) sweepTo(key);
        },
        onEnd: () => {
          const batch = sweptKeys.filter(canClose).flatMap((key) => {
            const row = readCloseSweep().closeSweepRows.get(key);
            return row ? [row.entry] : [];
          });
          void readCloseSweep().closeBatch(batch);
        },
        onCancel: () => {},
        onAbort: () => {},
      });
      closeSensorRef.current = sensor;
    },
  );

  return {
    ...prev,
    closeSweepKeys,
    displayGroups,
    entries,
    facets,
    groups,
    heldPullRequestsBySurface,
    hostActionsOf,
    hosts,
    listErrors,
    listedPullRequestTabStatuses,
    listedPullRequestsBySurface,
    refreshFromHost,
    refreshListAndStats,
    registerStatsRow,
    scrollRef,
    showProvider,
    shownCount,
    startCloseSweep,
  };
}
