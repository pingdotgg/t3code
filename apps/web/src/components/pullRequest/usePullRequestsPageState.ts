import type { PullRequestSpeedActionResult } from "~/components/pullRequest/PullRequestSpeedActions";
import { usePullRequestCloseBatch } from "~/components/pullRequest/usePullRequestActions";

import type {
  EnvironmentId,
  ProjectId,
  PullRequestAction,
  PullRequestInvolvement,
  PullRequestListCursors,
  PullRequestListInput,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { useRef, useState } from "react";

import {
  narrowPullRequestsToFilters,
  pullRequestEntryKey,
  rankPullRequestMatches,
  type EnvironmentPullRequestEntry,
  type MergedPullRequestList,
  type PullRequestStatsPolicy,
  type PullRequestStatsScope,
  type PullRequestPartitionsSnapshot,
  type PullRequestListOverride,
  pullRequestOverrideAfterAction,
  reusePullRequestEntries,
  settlePullRequestOverrides,
  comparePullRequestsByRecency,
  largestPullRequestReadCount,
} from "./pullRequestList.logic";
import {
  pullRequestListPreferences,
  type PullRequestListPreferencePatch,
  writePullRequestListPreferences,
} from "./pullRequestListPreferences";

import {
  usePullRequestQueryFilters,
  usePullRequestScope,
  type PullRequestsSearch,
} from "./usePullRequestListView";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useOpenPanelPullRequestUrl } from "~/hooks/useOpenPanelPullRequestUrl";

import { usePanelAnimationSettings, usePanelPresence } from "~/panelAnimations";
import {
  PULL_REQUESTS_PANEL_REF,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import {
  pullRequestEnvironment,
  usePullRequestList,
  restoredPullRequestList,
  usePullRequestTurnRefreshes,
  useSharedPullRequestSummary,
  type EnvironmentQueryTarget,
} from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { primaryServerKeybindingsAtom } from "~/state/server";

/**
 * One whole page from the host and no more: every provider asks for one row beyond the page as
 * its "is there more" probe, and GitHub serves a hundred per request — so asking for ninety-nine
 * costs one round trip where a hundred costs two.
 */
const PAGE_SIZE = 99;
const MAX_PAGE_SIZE = 500;
const EMPTY_PARTITIONS: PullRequestPartitionsSnapshot = { authored: [], reviewing: [] };
const NO_LIST_TARGETS: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>> = [];

/**
 * The pull request list's data: scope, queries, paging, ordering, and overrides. Paging state
 * and the list query answer one question per filter key, so they live together here.
 */
export function usePullRequestsPageState() {
  const search = useSearch({ from: "/_chat/pull-requests" });
  const sort = search.sort ?? "ready";
  const statsPolicy: PullRequestStatsPolicy =
    sort === "ready" || sort === "largest" || sort === "smallest" ? "eager" : "visible";
  const navigate = useNavigate({ from: "/pull-requests" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const {
    capableEnvironments,
    scopedEnvironmentId,
    environmentKey,
    capabilityKnown,
    pullRequestsSupported,
    projects,
    environmentLabels,
    scopedProjectId,
    scopedProject,
    scopedProjects,
    selectedProject,
    queryEnvironmentIds,
    environmentQueries,
    assignmentKey,
    linkedSelection,
    expectedHosts,
    projectsKnown,
  } = usePullRequestScope(search);
  const rightPanelRef = capableEnvironments.length === 0 ? null : PULL_REQUESTS_PANEL_REF;
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(rightPanelRef);
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, rightPanelRef),
  );
  const selectedRightPanelSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, rightPanelRef),
  );
  const selectedPullRequestSurface =
    selectedRightPanelSurface?.kind === "pull-request" ? selectedRightPanelSurface : null;
  const activePullRequestSurface = rightPanelState.isOpen ? selectedPullRequestSurface : null;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const rightPanelPresenceValue = {
    activeSurface: selectedPullRequestSurface,
    surfaces: rightPanelState.surfaces,
  };
  const rightPanelPresence = usePanelPresence(
    rightPanelState.isOpen && selectedPullRequestSurface !== null,
    rightPanelPresenceValue,
    panelAnimationsActive,
    rightPanelRef?.threadId ?? null,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  const renderedPullRequestSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  const panelEnvironmentId =
    (renderedPullRequestSurface?.environmentId as EnvironmentId | undefined) ??
    selectedProject?.environmentId ??
    null;
  const panelSummary = useSharedPullRequestSummary(
    panelEnvironmentId,
    renderedPullRequestSurface === null
      ? null
      : {
          ...renderedPullRequestSurface,
          projectId: renderedPullRequestSurface.projectId as ProjectId,
        },
  );
  const updateSearch = (patch: {
    [Key in keyof PullRequestsSearch]?: PullRequestsSearch[Key] | undefined;
  }) =>
    void navigate({
      search: (previous: PullRequestsSearch): PullRequestsSearch => {
        const next = { ...previous, ...patch };
        return {
          involvement: next.involvement ?? previous.involvement,
          state: next.state ?? previous.state,
          ...(next.sort && next.sort !== "ready" ? { sort: next.sort } : {}),
          ...(next.repository ? { repository: next.repository } : {}),
          ...(next.number ? { number: next.number } : {}),
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.environmentId ? { environmentId: next.environmentId } : {}),
          ...(next.host ? { host: next.host } : {}),
          ...(next.selectedHost ? { selectedHost: next.selectedHost } : {}),
          ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
          ...(next.selectedEnvironmentId
            ? { selectedEnvironmentId: next.selectedEnvironmentId }
            : {}),
          ...(next.q ? { q: next.q } : {}),
          ...(next.draft ? { draft: next.draft } : {}),
          ...(next.review ? { review: next.review } : {}),
          ...(next.checks ? { checks: next.checks } : {}),
          ...(next.author ? { author: next.author } : {}),
          ...(next.labels && next.labels.length > 0 ? { labels: next.labels } : {}),
        };
      },
      replace: true,
    });

  const clearedSelection = {
    repository: undefined,
    number: undefined,
    selectedProjectId: undefined,
    selectedEnvironmentId: undefined,
    selectedHost: undefined,
  };
  const updateListScope = (patch: PullRequestListPreferencePatch) => {
    const currentPreferences = pullRequestListPreferences({
      ...search,
      ...patch,
      involvement: patch.involvement ?? search.involvement,
      state: patch.state ?? search.state,
    });
    writePullRequestListPreferences(currentPreferences);
    updateSearch(patch);
  };

  const typedQuery = (search.q ?? "").trim();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const {
    sentQuery,
    submitQuery,
    querySettled,
    typedParsed,
    sentParsed,
    menuFilters,
    menuFiltered,
    filters,
    hasFilters,
    localFilters,
    hasLocalFilters,
  } = usePullRequestQueryFilters(search, typedQuery);
  const turnRefreshes = usePullRequestTurnRefreshes(
    environmentQueries.map(({ environmentId }) => environmentId),
  );
  const turnRefreshToken = turnRefreshes
    .map(([environmentId, revision]) => `${environmentId}:${revision}`)
    .join("|");
  const scopeKey = `${environmentKey}:${assignmentKey}:${search.state}:${search.involvement}:${scopedProjectId ?? ""}:${search.host ?? ""}:${search.draft ?? ""}:${search.review ?? ""}:${search.checks ?? ""}:${search.author ?? ""}:${search.labels?.join("\u0000") ?? ""}`;
  const filterKey = `${scopeKey}:${sentQuery}`;
  const statsScope: PullRequestStatsScope = { key: filterKey, policy: statsPolicy };
  const [page, setPage] = useState<{
    key: string;
    size: number;
    cursors: Readonly<Record<string, PullRequestListCursors>> | null;
    /**
     * An environment can say it has more without saying where to carry on from — its provider has
     * no cursor to give — and a continuation naming only the others would strand its rows on the
     * host forever.
     */
    regrown: ReadonlyArray<string>;
    /** The turn refreshes a continuation was read under; a later turn makes its cursors stale. */
    turn: string;
  }>({ key: filterKey, size: PAGE_SIZE, cursors: null, regrown: [], turn: turnRefreshToken });
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const sentCursors = page.key === filterKey ? page.cursors : null;
  const sentRegrown = page.key === filterKey ? page.regrown : [];

  if (page.key !== filterKey) {
    setPage({
      key: filterKey,
      size: PAGE_SIZE,
      cursors: null,
      regrown: [],
      turn: turnRefreshToken,
    });
  }

  const listTargets = environmentQueries.flatMap(({ environmentId, projectIds }) => {
    const cursors = sentCursors?.[environmentId];
    if (sentCursors !== null && cursors === undefined && !sentRegrown.includes(environmentId)) {
      return [];
    }
    return [
      {
        environmentId,
        input: {
          state: search.state,
          involvement: search.involvement,
          limit: pageSize,
          ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
          ...(projectIds ? { projectIds } : {}),
          ...(search.host ? { host: search.host } : {}),
          ...(hasFilters ? { filters } : {}),
          ...(sentParsed.text ? { query: sentParsed.text } : {}),
          ...(cursors === undefined ? {} : { cursors }),
        } satisfies PullRequestListInput,
      },
    ];
  });
  const listQuery = usePullRequestList(listTargets);

  /**
   * Kept as its own read rather than remembered from an earlier answer because an answer cannot
   * say which question it belongs to: mid-switch the text has already changed and the data has
   * not, and a search's answer would file itself under the workspace.
   */
  const baselineTargets = environmentQueries.map(({ environmentId, projectIds }) => ({
    environmentId,
    input: {
      state: search.state,
      involvement: search.involvement,
      limit: PAGE_SIZE,
      ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
      ...(projectIds ? { projectIds } : {}),
      ...(search.host ? { host: search.host } : {}),
      ...(menuFiltered ? { filters: menuFilters } : {}),
    } satisfies PullRequestListInput,
  }));
  const baselineQuery = usePullRequestList(baselineTargets);
  const baselineEmpty =
    baselineQuery.data?.entries.length === 0 &&
    baselineQuery.data.errors.length === 0 &&
    !baselineQuery.isPending &&
    baselineQuery.error === null;
  const facetTargets = (() => {
    if (!filtersOpen) return NO_LIST_TARGETS;
    return environmentQueries.map(({ environmentId, projectIds }) => ({
      environmentId,
      input: {
        state: "all",
        involvement: search.involvement,
        limit: PAGE_SIZE,
        ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
        ...(projectIds ? { projectIds } : {}),
        ...(search.host ? { host: search.host } : {}),
      } satisfies PullRequestListInput,
    }));
  })();
  const facetQuery = usePullRequestList(facetTargets);
  const filterOptionScope = environmentQueries.map(({ environmentId, projectIds }) => ({
    environmentId,
    input: {
      ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
      ...(projectIds ? { projectIds } : {}),
      ...(search.host ? { host: search.host } : {}),
    },
  }));
  const partitionsWanted = search.involvement === "all" && typedQuery.length === 0;
  const partitionTargets = (() => {
    // The main list goes first. Besides putting the visible rows on screen sooner, it proves
    // which repositories the host search indexes, so an empty partition does not trigger the
    // expensive per-repository fallback.
    if (
      !partitionsWanted ||
      baselineQuery.data === null ||
      baselineQuery.data.entries.length === 0
    ) {
      return { authored: NO_LIST_TARGETS, reviewing: NO_LIST_TARGETS };
    }
    const targetsFor = (involvement: PullRequestInvolvement) =>
      environmentQueries.map(({ environmentId, projectIds }) => ({
        environmentId,
        input: {
          state: search.state,
          involvement,
          limit: PAGE_SIZE,
          ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
          ...(projectIds ? { projectIds } : {}),
          ...(search.host ? { host: search.host } : {}),
          ...(menuFiltered ? { filters: menuFilters } : {}),
        } satisfies PullRequestListInput,
      }));
    return { authored: targetsFor("authored"), reviewing: targetsFor("reviewing") };
  })();
  const authoredQuery = usePullRequestList(partitionTargets.authored);
  const reviewingQuery = usePullRequestList(partitionTargets.reviewing);
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [invalidating, setInvalidating] = useState(false);
  const refreshing = invalidating || listQuery.isPending;

  const [loaded, setLoaded] = useState<{
    environmentKey: string;
    scope: string;
    query: string;
    /** The answer this was built from, so a re-render with the same answer leaves it alone. */
    source: MergedPullRequestList | null;
    data: MergedPullRequestList;
    partitions?: PullRequestPartitionsSnapshot;
  } | null>(null);
  const [ordered, setOrdered] = useState<{
    key: string;
    source: MergedPullRequestList;
    entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  } | null>(null);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, PullRequestListOverride>>(
    () => new Map(),
  );
  const overrideToken = useRef(0);
  const overrideEntry = (
    entry: EnvironmentPullRequestEntry,
    action: PullRequestAction,
  ): number | null => {
    const token = ++overrideToken.current;
    const override = pullRequestOverrideAfterAction(entry, action, new Date(), token);
    if (override === null) return null;
    setOverrides((current) => new Map(current).set(pullRequestEntryKey(entry), override));
    return token;
  };
  const revertOverride = (key: string, token: number | null) => {
    if (token === null) return;
    setOverrides((current) => {
      if (current.get(key)?.token !== token) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  };
  const detailOverrideTokens = useRef(new Map<string, number | null>());
  const onSpeedAction = useStableCallback(({ entry, action }: PullRequestSpeedActionResult) => {
    // Some hosts accept a merge before it completes. Let the next host read declare it merged.
    if (action !== "merge") overrideEntry(entry, action);
  });
  const onBatchClosed = useStableCallback((entry: EnvironmentPullRequestEntry) => {
    onSpeedAction({ entry, action: "close" });
  });
  const { close: closeBatch, closingKeys } = usePullRequestCloseBatch(onBatchClosed);
  const [snapshotEnvironmentKey, setSnapshotEnvironmentKey] = useState("");
  if (environmentKey.length > 0 && snapshotEnvironmentKey !== environmentKey) {
    setSnapshotEnvironmentKey(environmentKey);
    if (loaded?.environmentKey !== environmentKey) {
      const restored = restoredPullRequestList(baselineTargets);
      const restoredPartition = (involvement: PullRequestInvolvement) =>
        restoredPullRequestList(
          baselineTargets.map((target) => ({ ...target, input: { ...target.input, involvement } })),
        )?.entries;
      const authored = partitionsWanted ? restoredPartition("authored") : undefined;
      const reviewing = partitionsWanted ? restoredPartition("reviewing") : undefined;
      setLoaded(
        restored === null
          ? null
          : {
              environmentKey,
              scope: scopeKey,
              query: "",
              source: null,
              data: restored,
              ...(authored === undefined || reviewing === undefined
                ? {}
                : { partitions: { authored, reviewing } }),
            },
      );
    }
  }
  const settledList = listQuery.data !== null && !listQuery.isPending ? listQuery.data : null;
  const answeredPartitions =
    partitionsWanted && baselineEmpty
      ? EMPTY_PARTITIONS
      : partitionsWanted && authoredQuery.data !== null && reviewingQuery.data !== null
        ? { authored: authoredQuery.data.entries, reviewing: reviewingQuery.data.entries }
        : null;
  const heldPartitions =
    loaded !== null && loaded.environmentKey === environmentKey && loaded.scope === scopeKey
      ? loaded.partitions
      : undefined;
  const nextPartitions = answeredPartitions ?? heldPartitions;
  const loadedEntries =
    settledList === null
      ? null
      : ordered?.key === filterKey
        ? ordered.entries
        : settledList.entries;
  if (
    settledList !== null &&
    loadedEntries !== null &&
    (loaded === null ||
      loaded.source !== settledList ||
      loaded.environmentKey !== environmentKey ||
      loaded.scope !== scopeKey ||
      loaded.query !== sentQuery ||
      loaded.data.entries !== loadedEntries ||
      loaded.partitions?.authored !== nextPartitions?.authored ||
      loaded.partitions?.reviewing !== nextPartitions?.reviewing)
  ) {
    setLoaded({
      environmentKey,
      scope: scopeKey,
      query: sentQuery,
      source: settledList,
      data: { ...settledList, entries: loadedEntries },
      ...(nextPartitions === undefined ? {} : { partitions: nextPartitions }),
    });
  }
  const narrowed = (() => {
    if (loaded === null || loaded.environmentKey !== environmentKey || loaded.scope === scopeKey) {
      return null;
    }
    const entries = narrowPullRequestsToFilters(loaded.data.entries, {
      state: search.state,
      projectId: scopedProjectId,
      host: search.host,
    });
    return entries.length === 0 ? null : { ...loaded.data, entries };
  })();
  // A grown page is read by the list and nothing else: the baseline always asks for one page, so
  // a host with no cursor to continue from — where "more" means asking for a longer page — would
  // have its extra rows thrown away for the ninety-nine the baseline keeps answering with.
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
  const loadingMore = listQuery.isPending && listData !== null;
  const firstLoad = listQuery.isPending && listData === null;

  if (
    answered !== null &&
    !listQuery.isPending &&
    !(listQuery.error && listQuery.data === null) &&
    (ordered === null || ordered.key !== filterKey || ordered.source !== answered)
  ) {
    if (ordered === null || ordered.key !== filterKey) {
      setOrdered({
        key: filterKey,
        source: answered,
        entries: rankPullRequestMatches(answered.entries, sentParsed.text),
      });
    } else if (sentCursors !== null) {
      const held = new Set(ordered.entries.map(pullRequestEntryKey));
      const arrived = answered.entries.filter((entry) => !held.has(pullRequestEntryKey(entry)));
      const appended = rankPullRequestMatches(
        arrived.toSorted(comparePullRequestsByRecency),
        sentParsed.text,
      );
      setOrdered({ key: filterKey, source: answered, entries: [...ordered.entries, ...appended] });
    } else {
      setOrdered({
        key: filterKey,
        source: answered,
        entries: reusePullRequestEntries(
          ordered.entries,
          rankPullRequestMatches(answered.entries, sentParsed.text),
          pullRequestEntryKey,
        ),
      });
    }
    const answeredEntries = answered.entries;
    setOverrides((current) =>
      settlePullRequestOverrides(current, answeredEntries, pullRequestEntryKey, Date.now()),
    );
  }

  // From this question's own answer, never from the rows being held while it travels: a
  // continuation is a boundary in one listing, and carrying one across a search would ask the new
  // question to start where the old one stopped — skipping its newest matches entirely.
  const nextCursors = answered?.nextCursors ?? {};
  const regrown = (answered?.truncatedEnvironments ?? []).filter(
    (environmentId) => nextCursors[environmentId] === undefined,
  );
  const canContinue = !showingCarried && Object.keys(nextCursors).length > 0;
  const loadMore = () => {
    if (canContinue) {
      setPage({
        key: filterKey,
        size: regrown.length === 0 ? pageSize : Math.min(pageSize + PAGE_SIZE, MAX_PAGE_SIZE),
        cursors: nextCursors,
        regrown,
        turn: turnRefreshToken,
      });
      return;
    }
    setPage({
      key: filterKey,
      size: Math.min(pageSize + PAGE_SIZE, MAX_PAGE_SIZE),
      cursors: null,
      regrown: [],
      turn: turnRefreshToken,
    });
  };

  const collapsedPage = () => {
    const loadedCount =
      ordered?.key === filterKey ? largestPullRequestReadCount(ordered.entries) : pageSize;
    return {
      key: filterKey,
      regrown: [],
      size: Math.min(
        Math.max(pageSize, Math.ceil(loadedCount / PAGE_SIZE) * PAGE_SIZE),
        MAX_PAGE_SIZE,
      ),
      cursors: null,
      turn: turnRefreshToken,
    };
  };
  // Every list read refetches itself when a turn completes, but a continuation would refetch only
  // its later page and strand the rows before it, so the whole loaded list is asked for again.
  if (sentCursors !== null && page.turn !== turnRefreshToken) setPage(collapsedPage());

  const refreshList = (includeRelated = false, actedEnvironmentId?: EnvironmentId) => {
    const related = (
      includeRelated
        ? [
            ...baselineTargets,
            ...facetTargets,
            ...partitionTargets.authored,
            ...partitionTargets.reviewing,
          ]
        : []
    ).filter(
      ({ environmentId }) =>
        actedEnvironmentId === undefined || environmentId === actedEnvironmentId,
    );
    if (sentCursors === null) {
      listQuery.refresh([
        ...listTargets.filter(
          ({ environmentId }) =>
            actedEnvironmentId === undefined || environmentId === actedEnvironmentId,
        ),
        ...related,
      ]);
      return;
    }
    if (related.length > 0) listQuery.refresh(related);
    setPage(collapsedPage());
  };

  useLiveRefresh(
    () => {
      refreshList(true);
    },
    { enabled: pullRequestsSupported },
  );

  return {
    activePullRequestSurface,
    answered,
    authoredQuery,
    baselineEmpty,
    baselineQuery,
    canContinue,
    capabilityKnown,
    capableEnvironments,
    clearedSelection,
    closeBatch,
    closingKeys,
    detailOverrideTokens,
    detailRefreshToken,
    environmentKey,
    environmentLabels,
    expectedHosts,
    facetQuery,
    filterKey,
    filterOptionScope,
    filters,
    firstLoad,
    hasLocalFilters,
    invalidate,
    keybindings,
    linkedSelection,
    listData,
    listQuery,
    loadMore,
    loaded,
    loadingMore,
    localFilters,
    menuFiltered,
    menuFilters,
    onSpeedAction,
    openPanelPullRequestUrl,
    ordered,
    overrideEntry,
    overrides,
    pageSize,
    panelAnimationDurationMs,
    panelAnimationsActive,
    panelEnvironmentId,
    panelSummary,
    partitionsWanted,
    projects,
    projectsKnown,
    pullRequestsSupported,
    queryEnvironmentIds,
    querySettled,
    refreshList,
    refreshing,
    renderedPullRequestSurface,
    renderedRightPanelSurfaces,
    revertOverride,
    reviewingQuery,
    rightPanelPresent,
    rightPanelRef,
    rightPanelState,
    scopeKey,
    scopedEnvironmentId,
    scopedProject,
    scopedProjectId,
    scopedProjects,
    search,
    selectedProject,
    selectedPullRequestSurface,
    sentCursors,
    setDetailRefreshToken,
    setFiltersOpen,
    setInvalidating,
    showingCarried,
    sort,
    statsPolicy,
    statsScope,
    submitQuery,
    typedParsed,
    typedQuery,
    updateListScope,
    updateSearch,
  };
}
