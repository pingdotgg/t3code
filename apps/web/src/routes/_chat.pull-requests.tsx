import {
  EnvironmentId,
  ThreadId,
  isGitHubRateLimitMessage,
  type ProjectId,
  type PullRequestInvolvement,
  type PullRequestListInput,
  type PullRequestListResult,
  type PullRequestListState,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { keepPreviousData, queryOptions, useQueries, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownUpIcon,
  CalendarArrowDownIcon,
  CalendarArrowUpIcon,
  ChevronDownIcon,
  GitPullRequestIcon,
  LayersIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import { PullRequestFiltersMenu } from "../components/pullRequest/PullRequestFiltersMenu";
import { PullRequestRow } from "../components/pullRequest/PullRequestRow";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { RightPanelTabs } from "../components/RightPanelTabs";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  pullRequestQueryKeys,
  pullRequestListStatsQueryOptions,
  prefetchPullRequestDetail,
} from "../lib/pullRequestReactQuery";
import { ensureEnvironmentApi } from "../environmentApi";
import { cn } from "../lib/utils";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useSettings } from "../hooks/useSettings";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { useEnvironments } from "../state/environments";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import type { Project } from "../types";

export interface PullRequestsSearch {
  readonly state?: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly sort?: PullRequestListSort;
  readonly projectId?: ProjectId;
  readonly q?: string;
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
  readonly environmentId?: EnvironmentId;
}
type PullRequestsSearchPatch = {
  readonly [Key in keyof PullRequestsSearch]?: PullRequestsSearch[Key] | undefined;
};

const LIST_STATES = ["all", "open", "closed", "merged"] as const;
const INVOLVEMENTS = ["all", "reviewing", "authored"] as const;
const SORT_OPTIONS = [
  { value: "ready", label: "Merge readiness", Icon: LayersIcon },
  { value: "updated", label: "Recently updated", Icon: RefreshCwIcon },
  { value: "newest", label: "Newest shown", Icon: CalendarArrowDownIcon },
  { value: "oldest", label: "Oldest shown", Icon: CalendarArrowUpIcon },
  { value: "largest", label: "Largest shown", Icon: Maximize2Icon },
  { value: "smallest", label: "Smallest shown", Icon: Minimize2Icon },
] as const;
type PullRequestListSort = (typeof SORT_OPTIONS)[number]["value"];
const INVOLVEMENT_LABELS: Record<(typeof INVOLVEMENTS)[number], string> = {
  all: "All involvement",
  reviewing: "Reviewing",
  authored: "Authored",
};
const PAGE_SIZE = 50;
const STATS_BATCH_SIZE = 500;
/** Pointer hovers shorter than this never leave the client. */
const HOVER_PREFETCH_DELAY_MS = 350;
const EMPTY_PROJECTS: readonly Project[] = [];
const PULL_REQUESTS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("pull-requests"),
  ThreadId.make("pull-requests"),
);

async function fetchAllPullRequestList(
  environmentId: EnvironmentId,
  request: Omit<PullRequestListInput, "cursors">,
): Promise<PullRequestListResult> {
  const pages: PullRequestListResult[] = [];
  let cursors: PullRequestListInput["cursors"] | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await ensureEnvironmentApi(environmentId).pullRequests.list({
      ...request,
      ...(cursors ? { cursors } : {}),
    });
    pages.push(result);
    if (Object.keys(result.nextCursors).length === 0) break;
    cursors = result.nextCursors;
  }
  const first = pages[0];
  if (!first) {
    throw new Error("Pull request list returned no pages.");
  }
  return {
    ...first,
    entries: pages.flatMap((page) => page.entries),
    errors: pages.flatMap((page) => page.errors),
    viewers: Object.assign({}, ...pages.map((page) => page.viewers)),
    nextCursors: {},
  };
}

function isListState(value: unknown): value is PullRequestListState {
  return typeof value === "string" && (LIST_STATES as readonly string[]).includes(value);
}

function isInvolvement(value: unknown): value is PullRequestInvolvement {
  return typeof value === "string" && (INVOLVEMENTS as readonly string[]).includes(value);
}

function isPullRequestListSort(value: unknown): value is PullRequestListSort {
  return SORT_OPTIONS.some((option) => option.value === value);
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (search: Record<string, unknown>): PullRequestsSearch => ({
    ...(isListState(search.state) ? { state: search.state } : {}),
    involvement: isInvolvement(search.involvement) ? search.involvement : "all",
    ...(isPullRequestListSort(search.sort) ? { sort: search.sort } : {}),
    ...(typeof search.projectId === "string" && search.projectId
      ? { projectId: search.projectId as ProjectId }
      : {}),
    ...(typeof search.q === "string" && search.q.trim() ? { q: search.q.slice(0, 200) } : {}),
    ...(typeof search.host === "string" && search.host ? { host: search.host.slice(0, 300) } : {}),
    ...(typeof search.repository === "string" && search.repository
      ? { repository: search.repository.slice(0, 300) }
      : {}),
    ...(typeof search.number === "number" &&
    Number.isSafeInteger(search.number) &&
    search.number > 0
      ? { number: search.number }
      : {}),
    ...(typeof search.selectedProjectId === "string" && search.selectedProjectId
      ? { selectedProjectId: search.selectedProjectId as ProjectId }
      : {}),
    ...(typeof search.environmentId === "string" && search.environmentId
      ? { environmentId: search.environmentId as EnvironmentId }
      : {}),
  }),
  component: PullRequestsRoute,
});

function PullRequestsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const { environments } = useEnvironments();
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const environmentTargets = useMemo(
    () =>
      environments
        .map((environment) => ({
          ...environment,
          descriptor:
            environment.environmentId === primaryDescriptor?.environmentId
              ? primaryDescriptor
              : (savedRuntime[environment.environmentId]?.descriptor ?? null),
        }))
        .filter((environment) => environment.descriptor?.capabilities.pullRequests === true),
    [environments, primaryDescriptor, savedRuntime],
  );
  const environmentIds = useMemo(
    () => environmentTargets.map((environment) => environment.environmentId),
    [environmentTargets],
  );
  const allProjects = useStore(selectProjectsAcrossEnvironments);
  const projects = useMemo(() => {
    if (environmentIds.length === 0) return EMPTY_PROJECTS;
    const supported = new Set(environmentIds);
    return allProjects.filter((project) => supported.has(project.environmentId));
  }, [allProjects, environmentIds]);
  const defaultListState = useSettings((s) => s.pullRequestsDefaultState);
  const effectiveState = search.state ?? defaultListState;
  const sort = search.sort ?? "ready";
  const deferredQuery = useDeferredValue(search.q ?? "");
  const listQueries = useQueries({
    queries: environmentTargets.map(({ environmentId }) =>
      queryOptions({
        queryKey: pullRequestQueryKeys.list(environmentId, {
          state: effectiveState,
          involvement: search.involvement,
          limit: PAGE_SIZE,
          ...(search.projectId ? { projectId: search.projectId } : {}),
          ...(deferredQuery.trim() ? { query: deferredQuery.trim() } : {}),
        }),
        queryFn: () =>
          fetchAllPullRequestList(environmentId, {
            state: effectiveState,
            involvement: search.involvement,
            limit: PAGE_SIZE,
            ...(search.projectId ? { projectId: search.projectId } : {}),
            ...(deferredQuery.trim() ? { query: deferredQuery.trim() } : {}),
          }),
        staleTime: 30_000,
        placeholderData: keepPreviousData,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      }),
    ),
  });
  const entries = useMemo(
    () =>
      listQueries.flatMap((query, index) =>
        (query.data?.entries ?? []).map((entry) => ({
          ...entry,
          environmentId: environmentTargets[index]!.environmentId,
        })),
      ),
    [environmentTargets, listQueries],
  );
  const statsTargets = useMemo(
    () =>
      environmentTargets.flatMap(({ environmentId }) => {
        const refs = entries
          .filter((entry) => entry.environmentId === environmentId)
          .map(({ projectId, repository, number }) => ({ projectId, repository, number }));
        return Array.from({ length: Math.ceil(refs.length / STATS_BATCH_SIZE) }, (_, index) => ({
          environmentId,
          refs: refs.slice(index * STATS_BATCH_SIZE, (index + 1) * STATS_BATCH_SIZE),
        }));
      }),
    [entries, environmentTargets],
  );
  const statsScopeKey = JSON.stringify([
    effectiveState,
    search.involvement,
    search.projectId ?? null,
    deferredQuery.trim(),
  ]);
  const [deferredStatsScopeKey, setDeferredStatsScopeKey] = useState<string | null>(null);
  const statsRequireAllRows = sort === "largest" || sort === "smallest";
  useEffect(() => {
    if (entries.length === 0 || statsRequireAllRows) {
      setDeferredStatsScopeKey(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) setDeferredStatsScopeKey(statsScopeKey);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [entries.length, statsRequireAllRows, statsScopeKey]);
  const statsEnabled = statsRequireAllRows || deferredStatsScopeKey === statsScopeKey;
  const statsQueries = useQueries({
    queries: statsTargets.map(({ environmentId, refs }) =>
      pullRequestListStatsQueryOptions({
        environmentId,
        request: { refs },
        enabled: statsEnabled,
      }),
    ),
  });
  const entriesWithStats = useMemo(() => {
    const stats = new Map(
      statsQueries.flatMap((query, index) =>
        (query.data?.stats ?? []).map((stat) => [
          `${statsTargets[index]?.environmentId}:${stat.projectId}:${stat.repository}#${stat.number}`,
          stat,
        ]),
      ),
    );
    return entries.map((entry) => {
      const stat = stats.get(
        `${entry.environmentId}:${entry.projectId}:${entry.repository}#${entry.number}`,
      );
      return stat && entry.additions === 0 && entry.deletions === 0 ? { ...entry, ...stat } : entry;
    });
  }, [entries, statsQueries, statsTargets]);
  const entriesByReference = useMemo(
    () =>
      new Map(
        entriesWithStats.map((entry) => [
          `${entry.environmentId}:${entry.projectId}:${entry.repository.toLowerCase()}#${entry.number}`,
          entry,
        ]),
      ),
    [entriesWithStats],
  );
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  /**
   * The list only narrows by title/repository client-side for display; a row
   * whose match came from elsewhere (description, comments) says so on the
   * row rather than reading as a random result.
   */
  const matchRowElsewhere = (entry: { readonly title: string; readonly repository: string }) => {
    if (!normalizedQuery) return false;
    return (
      !entry.title.toLowerCase().includes(normalizedQuery) &&
      !entry.repository.toLowerCase().includes(normalizedQuery)
    );
  };
  /**
   * Warm the detail an intentional hover is about to open, so selecting the
   * row reads from the cache. Pointer hovers wait 350ms — crossing rows on
   * the way somewhere else fires nothing — while keyboard focus prefetches
   * at once. Only the detail: the activity's review-thread walk is paginated
   * and unbounded, and the detail is one consolidated read.
   */
  const hoverPrefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverPrefetch = () => {
    if (hoverPrefetchTimer.current !== null) {
      clearTimeout(hoverPrefetchTimer.current);
      hoverPrefetchTimer.current = null;
    }
  };
  useEffect(() => cancelHoverPrefetch, []);
  const prefetchDetailFor = (entry: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly number: number;
    readonly environmentId?: EnvironmentId;
  }) => {
    const targetEnvironmentId = entry.environmentId ?? environmentTargets[0]?.environmentId;
    if (!targetEnvironmentId) return;
    void prefetchPullRequestDetail(queryClient, {
      environmentId: targetEnvironmentId,
      reference: {
        projectId: entry.projectId,
        repository: entry.repository,
        number: entry.number,
      },
    });
  };
  const scheduleHoverPrefetch = (entry: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly number: number;
  }) => {
    cancelHoverPrefetch();
    hoverPrefetchTimer.current = setTimeout(() => {
      hoverPrefetchTimer.current = null;
      prefetchDetailFor(entry);
    }, HOVER_PREFETCH_DELAY_MS);
  };
  const sortedEntries = useMemo(() => {
    if (sort === "ready") return entriesWithStats;
    return entriesWithStats.toSorted((left, right) => {
      if (sort === "updated") return right.updatedAt.localeCompare(left.updatedAt);
      if (sort === "newest") return right.createdAt.localeCompare(left.createdAt);
      if (sort === "oldest") return left.createdAt.localeCompare(right.createdAt);
      const leftSize = left.additions + left.deletions;
      const rightSize = right.additions + right.deletions;
      return sort === "largest" ? rightSize - leftSize : leftSize - rightSize;
    });
  }, [entriesWithStats, sort]);
  const reviewRequestedEntries = useMemo(
    () => sortedEntries.filter((entry) => entry.viewerReviewRequested),
    [sortedEntries],
  );
  const otherEntries = useMemo(
    () => sortedEntries.filter((entry) => !entry.viewerReviewRequested),
    [sortedEntries],
  );
  const selectedEntry = useMemo(
    () =>
      search.repository && search.number
        ? entriesWithStats.find(
            (entry) =>
              entry.repository === search.repository &&
              entry.number === search.number &&
              (!search.selectedProjectId || entry.projectId === search.selectedProjectId) &&
              (!search.environmentId || entry.environmentId === search.environmentId) &&
              (!search.host || entry.host === search.host),
          )
        : undefined,
    [
      entriesWithStats,
      search.environmentId,
      search.host,
      search.number,
      search.repository,
      search.selectedProjectId,
    ],
  );
  const selected = useMemo(
    () =>
      search.repository && search.number && search.selectedProjectId
        ? {
            projectId: search.selectedProjectId,
            repository: search.repository,
            number: search.number,
          }
        : selectedEntry
          ? {
              projectId: selectedEntry.projectId,
              repository: selectedEntry.repository,
              number: selectedEntry.number,
            }
          : null,
    [
      search.number,
      search.repository,
      search.selectedProjectId,
      selectedEntry?.number,
      selectedEntry?.projectId,
      selectedEntry?.repository,
    ],
  );
  const selectedEnvironmentId = search.environmentId ?? selectedEntry?.environmentId ?? null;
  const pullRequestsPanel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, PULL_REQUESTS_PANEL_REF),
  );
  const openPullRequest = useRightPanelStore((state) => state.openPullRequest);
  const activateSurface = useRightPanelStore((state) => state.activateSurface);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const closeOtherSurfaces = useRightPanelStore((state) => state.closeOtherSurfaces);
  const closeSurfacesToRight = useRightPanelStore((state) => state.closeSurfacesToRight);
  const closeAllSurfaces = useRightPanelStore((state) => state.closeAllSurfaces);
  const closePanel = useRightPanelStore((state) => state.close);
  const updateSearch = (patch: PullRequestsSearchPatch, clearSelection = false) => {
    void navigate({
      search: (previous: PullRequestsSearch) => {
        const next = { ...previous, ...patch };
        return {
          ...(next.state ? { state: next.state } : {}),
          involvement: next.involvement ?? "all",
          ...(next.sort && next.sort !== "ready" ? { sort: next.sort } : {}),
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.q ? { q: next.q } : {}),
          ...(!clearSelection && next.repository && next.number && next.selectedProjectId
            ? {
                ...(next.host ? { host: next.host } : {}),
                repository: next.repository,
                number: next.number,
                selectedProjectId: next.selectedProjectId,
                ...(next.environmentId ? { environmentId: next.environmentId } : {}),
              }
            : {}),
        };
      },
      replace: true,
    });
  };
  useEffect(() => {
    if (!selectedEntry || search.selectedProjectId) return;
    void navigate({
      search: (previous: PullRequestsSearch) => ({
        ...previous,
        repository: selectedEntry.repository,
        number: selectedEntry.number,
        selectedProjectId: selectedEntry.projectId,
        environmentId: selectedEntry.environmentId,
      }),
      replace: true,
    });
  }, [navigate, search.selectedProjectId, selectedEntry]);
  useEffect(() => {
    if (!selected || !selectedEnvironmentId) {
      closePanel(PULL_REQUESTS_PANEL_REF);
      return;
    }
    openPullRequest(PULL_REQUESTS_PANEL_REF, {
      environmentId: selectedEnvironmentId,
      reference: selected,
      ...(search.host ? { host: search.host } : {}),
      ...(selectedEntry?.title ? { title: selectedEntry.title } : {}),
    });
  }, [
    closePanel,
    openPullRequest,
    search.host,
    selected,
    selectedEntry?.title,
    selectedEnvironmentId,
  ]);
  const listIsPending = listQueries.some((query) => query.isPending);
  const listIsFetching = listQueries.some((query) => query.isFetching);
  const listError = listQueries.find((query) => query.error)?.error;
  const errors = listQueries.flatMap((query) => query.data?.errors ?? []);

  if (environments.length === 0) {
    return (
      <Surface>
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Loading environment…
        </div>
      </Surface>
    );
  }

  if (environmentTargets.length === 0) {
    return (
      <Surface>
        <EmptyState
          title="Pull requests are unavailable"
          description="This environment does not advertise GitHub pull request support."
        />
      </Surface>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader>
          <SidebarTrigger className="size-7" />
          <WorkspaceBreadcrumb ariaLabel="Pull requests breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Pull Requests</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className={cn("min-h-0 flex-1")}>
          <section className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
                <div className="flex flex-col gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <InputGroup className="min-w-0 flex-1">
                      <InputGroupAddon>
                        {listIsFetching ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
                      </InputGroupAddon>
                      <InputGroupInput
                        type="search"
                        aria-label="Search pull requests"
                        autoComplete="off"
                        name="pull-request-search"
                        placeholder="Search pull requests, or label:bug"
                        value={search.q ?? ""}
                        onChange={(event) =>
                          updateSearch({ q: event.currentTarget.value || undefined }, true)
                        }
                      />
                    </InputGroup>
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            aria-label="Sort pull requests"
                            size="default"
                            variant="outline"
                          />
                        }
                      >
                        <ArrowDownUpIcon aria-hidden />
                        <span>Sort</span>
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuRadioGroup
                          value={sort}
                          onValueChange={(value) =>
                            updateSearch({ sort: value as PullRequestListSort }, true)
                          }
                        >
                          {SORT_OPTIONS.map(({ value, label, Icon }) => (
                            <MenuRadioItem key={value} value={value}>
                              <Icon aria-hidden />
                              {label}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuPopup>
                    </Menu>
                    <PullRequestFiltersMenu
                      defaultListState={defaultListState}
                      effectiveState={effectiveState}
                      involvement={search.involvement}
                      projectId={search.projectId}
                      projects={projects}
                      onStateChange={(value) => updateSearch({ state: value }, true)}
                      onInvolvementChange={(value) => updateSearch({ involvement: value }, true)}
                      onProjectChange={(value) => updateSearch({ projectId: value }, true)}
                    />
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            aria-label="Filter by involvement"
                            size="default"
                            variant="outline"
                          />
                        }
                      >
                        <LayersIcon aria-hidden />
                        <span>
                          {INVOLVEMENT_LABELS[search.involvement].replace(" involvement", "")}
                        </span>
                        <ChevronDownIcon aria-hidden />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuRadioGroup
                          value={search.involvement}
                          onValueChange={(value) =>
                            updateSearch({ involvement: value as PullRequestInvolvement }, true)
                          }
                        >
                          {INVOLVEMENTS.map((involvement) => (
                            <MenuRadioItem key={involvement} value={involvement}>
                              {INVOLVEMENT_LABELS[involvement]}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuPopup>
                    </Menu>
                    <Button
                      aria-label="Refresh pull requests"
                      disabled={listIsFetching}
                      size="icon"
                      variant="outline"
                      onClick={() => void Promise.all(listQueries.map((query) => query.refetch()))}
                    >
                      <RefreshCwIcon className={cn(listIsFetching && "animate-spin")} />
                    </Button>
                  </div>
                  <p aria-live="polite" className="sr-only">
                    {entriesWithStats.length} pull request
                    {entriesWithStats.length === 1 ? "" : "s"}
                    {listIsFetching ? ", updating" : ""}
                  </p>
                </div>
                <div>
                  {listIsPending ? (
                    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                      <LoaderCircleIcon className="size-4 animate-spin" /> Loading pull requests…
                    </div>
                  ) : null}
                  {listError ? (
                    <EmptyState
                      title="Could not load pull requests"
                      description={
                        listError instanceof Error ? listError.message : "Please try again."
                      }
                      action={
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void Promise.all(listQueries.map((query) => query.refetch()))
                            }
                          >
                            Retry
                          </Button>
                          {listError instanceof Error &&
                          isGitHubRateLimitMessage(listError.message) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void navigate({ to: "/settings/pull-request-collaboration" })
                              }
                            >
                              See API usage
                            </Button>
                          ) : null}
                        </div>
                      }
                    />
                  ) : null}
                  {!listIsPending && !listError && entriesWithStats.length === 0 ? (
                    <EmptyState
                      title="No pull requests"
                      description={
                        search.q
                          ? "Nothing matches this search."
                          : "No pull requests match these filters."
                      }
                      action={
                        search.q ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => updateSearch({ q: undefined }, true)}
                          >
                            Clear search
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : null}
                  {reviewRequestedEntries.length > 0 ? (
                    <h2 className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">
                      Awaiting your review
                    </h2>
                  ) : null}
                  {reviewRequestedEntries.map((entry) => (
                    <PullRequestRow
                      entry={entry}
                      key={`${entry.environmentId}:${entry.projectId}:${entry.repository}#${entry.number}`}
                      matchedElsewhere={matchRowElsewhere(entry)}
                      selected={
                        selected?.projectId === entry.projectId &&
                        selected.repository === entry.repository &&
                        selected.number === entry.number
                      }
                      onSelect={(next) =>
                        updateSearch({
                          repository: next.repository,
                          number: next.number,
                          selectedProjectId: next.projectId,
                          environmentId: next.environmentId,
                        })
                      }
                      onHoverStart={scheduleHoverPrefetch}
                      onHoverEnd={cancelHoverPrefetch}
                      onFocusRow={prefetchDetailFor}
                    />
                  ))}
                  {otherEntries.length > 0 ? (
                    <h2
                      className={cn(
                        "px-3 pb-1 text-xs font-medium text-muted-foreground/70",
                        reviewRequestedEntries.length > 0 && "pt-3",
                      )}
                    >
                      Others
                    </h2>
                  ) : null}
                  {otherEntries.map((entry) => (
                    <PullRequestRow
                      entry={entry}
                      key={`${entry.environmentId}:${entry.projectId}:${entry.repository}#${entry.number}`}
                      matchedElsewhere={matchRowElsewhere(entry)}
                      selected={
                        selected?.projectId === entry.projectId &&
                        selected.repository === entry.repository &&
                        selected.number === entry.number
                      }
                      onSelect={(next) =>
                        updateSearch({
                          repository: next.repository,
                          number: next.number,
                          selectedProjectId: next.projectId,
                          environmentId: next.environmentId,
                        })
                      }
                      onHoverStart={scheduleHoverPrefetch}
                      onHoverEnd={cancelHoverPrefetch}
                      onFocusRow={prefetchDetailFor}
                    />
                  ))}
                  {errors.length > 0 ? (
                    <ul className="space-y-1 p-3 text-xs text-muted-foreground">
                      {errors.map((error) => (
                        <li key={error.projectId} className="break-words">
                          <span className="font-medium text-foreground">{error.projectTitle}:</span>{" "}
                          {error.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </WorkspacePageContainer>
            </div>
          </section>
        </div>
      </div>
      <RightPanelSheet
        open={pullRequestsPanel.isOpen}
        onClose={() => {
          closePanel(PULL_REQUESTS_PANEL_REF);
          updateSearch({}, true);
        }}
      >
        <RightPanelTabs
          mode="sheet"
          surfaces={pullRequestsPanel.surfaces}
          activeSurfaceId={pullRequestsPanel.activeSurfaceId}
          previewSessions={{}}
          terminalLabels={{}}
          showAddSurface={false}
          onActivate={(surface) => {
            if (surface.kind !== "pull-request") return;
            activateSurface(PULL_REQUESTS_PANEL_REF, surface.id);
            updateSearch({
              projectId: surface.reference.projectId,
              repository: surface.reference.repository,
              number: surface.reference.number,
              environmentId: surface.environmentId,
              ...(surface.host ? { host: surface.host } : {}),
            });
          }}
          onClose={(surface) => {
            closeSurface(PULL_REQUESTS_PANEL_REF, surface.id);
            const nextSurface = pullRequestsPanel.surfaces.findLast(
              (candidate) => candidate.id !== surface.id,
            );
            if (
              surface.id === pullRequestsPanel.activeSurfaceId &&
              nextSurface?.kind === "pull-request"
            ) {
              updateSearch({
                projectId: nextSurface.reference.projectId,
                repository: nextSurface.reference.repository,
                number: nextSurface.reference.number,
                environmentId: nextSurface.environmentId,
                ...(nextSurface.host ? { host: nextSurface.host } : {}),
              });
            } else if (surface.id === pullRequestsPanel.activeSurfaceId) {
              updateSearch({}, true);
            }
          }}
          onCloseOthers={(surface) => closeOtherSurfaces(PULL_REQUESTS_PANEL_REF, surface.id)}
          onCloseToRight={(surface) => closeSurfacesToRight(PULL_REQUESTS_PANEL_REF, surface.id)}
          onCloseAll={() => {
            closeAllSurfaces(PULL_REQUESTS_PANEL_REF);
            updateSearch({}, true);
          }}
          onClosePanel={() => {
            closePanel(PULL_REQUESTS_PANEL_REF);
            updateSearch({}, true);
          }}
          onCopyPath={() => undefined}
          onAddBrowserInProfile={() => undefined}
          onAddTerminal={() => undefined}
          onAddFiles={() => undefined}
          onAddDiff={() => undefined}
          onAddInsights={() => undefined}
        >
          {pullRequestsPanel.surfaces.map((surface) => {
            if (surface.kind !== "pull-request") return null;
            const visible =
              pullRequestsPanel.isOpen && surface.id === pullRequestsPanel.activeSurfaceId;
            return (
              <div className={cn("min-h-0 flex-1", !visible && "hidden")} key={surface.id}>
                <PullRequestDetailPanel
                  environmentId={surface.environmentId}
                  reference={surface.reference}
                  listEntry={
                    entriesByReference.get(
                      `${surface.environmentId}:${surface.reference.projectId}:${surface.reference.repository.toLowerCase()}#${surface.reference.number}`,
                    ) ?? null
                  }
                  onClose={() => {
                    closeSurface(PULL_REQUESTS_PANEL_REF, surface.id);
                    const nextSurface = pullRequestsPanel.surfaces.findLast(
                      (candidate) => candidate.id !== surface.id,
                    );
                    if (
                      surface.id === pullRequestsPanel.activeSurfaceId &&
                      nextSurface?.kind === "pull-request"
                    ) {
                      updateSearch({
                        projectId: nextSurface.reference.projectId,
                        repository: nextSurface.reference.repository,
                        number: nextSurface.reference.number,
                        environmentId: nextSurface.environmentId,
                        ...(nextSurface.host ? { host: nextSurface.host } : {}),
                      });
                    } else if (surface.id === pullRequestsPanel.activeSurfaceId) {
                      updateSearch({}, true);
                    }
                  }}
                />
              </div>
            );
          })}
        </RightPanelTabs>
      </RightPanelSheet>
    </SidebarInset>
  );
}

function Surface({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 bg-background text-foreground">{children}</SidebarInset>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 p-6 text-center">
      <GitPullRequestIcon className="size-7 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}
