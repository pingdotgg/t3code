import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pullRequestHostOf, ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListResult,
  PullRequestListState,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  EyeIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LayersIcon,
  PenLineIcon,
  LoaderIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestQuery,
  narrowPullRequestsToFilters,
  mergePullRequestDiffStats,
  partitionPullRequestsWithPriority,
  pullRequestEntryKey,
  rankPullRequestMatches,
  readPullRequestListSnapshot,
  resolveProjectScope,
  withDiffStat,
  writePullRequestListSnapshot,
  scorePullRequestMatch,
  type PullRequestDiffStats,
  type PullRequestPartitionsSnapshot,
} from "../components/pullRequest/pullRequestList.logic";
import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import {
  PullRequestFiltersMenu,
  PullRequestSearchInput,
  pullRequestHostLabel,
  type PullRequestExpectedHost,
  type PullRequestFilterOption,
} from "../components/pullRequest/PullRequestListFilters";
import { PullRequestListEmptyState } from "../components/pullRequest/PullRequestListEmptyState";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { PullRequestRow } from "../components/pullRequest/PullRequestRow";
import { PullRequestsUnavailableState } from "../components/pullRequest/PullRequestsUnavailableState";
import { RightPanelTabs, type PullRequestTabStatus } from "../components/RightPanelTabs";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls";
import { Button } from "../components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { SidebarInset } from "../components/ui/sidebar";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import {
  pullRequestSurfaceId,
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type PullRequestSurface,
} from "../rightPanelStore";
import { useDebouncedValue } from "../state/queries";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

export interface PullRequestsSearch {
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
  /** Scopes the list. Separate from the selection so one cannot silently change the other. */
  readonly projectId?: ProjectId;
  /**
   * Narrows the list to one host, named as the host itself: two GitHub installs are two
   * accounts, and their shared provider kind cannot tell them apart. Absent means every host.
   */
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
  readonly q?: string;
}

// The state filters wear the same glyphs the rows do, so the two read as one vocabulary.
const INVOLVEMENT_TABS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "reviewing", label: "Reviewing", Icon: EyeIcon },
  { value: "authored", label: "Authored", Icon: PenLineIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

const STATE_TABS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "open", label: "Open", Icon: GitPullRequestIcon },
  { value: "closed", label: "Closed", Icon: GitPullRequestClosedIcon },
  { value: "merged", label: "Merged", Icon: GitMergeIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

/** Long enough that a keystroke does not become a request, short enough to feel answered. */
const SEARCH_DEBOUNCE_MS = 250;
/** What `scorePullRequestMatch` gives a row none of whose own fields carry the search text. */
const MATCHED_ELSEWHERE_SCORE = 10;
/**
 * One whole page from the host and no more: every provider asks for one row beyond the page as
 * its "is there more" probe, and GitHub serves a hundred per request — so asking for ninety-nine
 * costs one round trip where a hundred costs two.
 */
const PAGE_SIZE = 99;
/** The largest page the listing accepts; past it the request is refused outright. */
const MAX_PAGE_SIZE = 500;
/** Stable empty map so the memos below do not see a new object on every render. */
const EMPTY_VIEWERS: PullRequestListResult["viewers"] = {};
/** The list owns one environment-scoped right panel rather than borrowing a real thread's. */
const PULL_REQUESTS_PANEL_ID = ThreadId.make("pull-requests-panel");
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const EMPTY_PENDING_SURFACES = new Set<string>();

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (raw: Record<string, unknown>): PullRequestsSearch => ({
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state:
      raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open",
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.host === "string" && raw.host ? { host: raw.host.slice(0, 200) } : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
  }),
  component: PullRequestsRouteView,
});

function PullRequestsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const capabilityKnown = primaryEnvironment !== null && primaryEnvironment.serverConfig !== null;
  const pullRequestsSupported =
    primaryEnvironment?.serverConfig?.environment.capabilities.pullRequests === true;
  // The primary environment may still be connecting, or may predate this feature. In either
  // case every query remains idle until the server has explicitly advertised these APIs.
  const pullRequestEnvironmentId = pullRequestsSupported ? environmentId : null;
  const allProjects = useProjects();
  // Whether the workspace has said what it holds yet. Until it has, an empty project list is
  // "not loaded" rather than "none", and telling a reader to add a project they already have is
  // the one wrong answer the empty state can give.
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  // The page reads one environment, so a project from another one could neither be listed
  // nor acted on: scoping here keeps the filter and the selection honest.
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const scopedProjects = useMemo(
    () =>
      projects
        .map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        }))
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );
  // The scope the URL asks for, once the environment has had its say about whether it exists.
  const scopedProjectId = useMemo(
    () => resolveProjectScope(search.projectId, projects, projectsKnown),
    [projects, projectsKnown, search.projectId],
  );
  const rightPanelRef = useMemo(
    () => (environmentId === null ? null : scopeThreadRef(environmentId, PULL_REQUESTS_PANEL_ID)),
    [environmentId],
  );
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, rightPanelRef),
  );
  const selectedRightPanelSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, rightPanelRef),
  );
  const selectedPullRequestSurface =
    selectedRightPanelSurface?.kind === "pull-request" ? selectedRightPanelSurface : null;
  const activePullRequestSurface = rightPanelState.isOpen ? selectedPullRequestSurface : null;
  const [pullRequestTabStatuses, setPullRequestTabStatuses] = useState<
    Record<string, PullRequestTabStatus>
  >({});
  const handlePullRequestTabStatusChange = useCallback((status: PullRequestTabStatus) => {
    const id = pullRequestSurfaceId(status);
    setPullRequestTabStatuses((current) =>
      current[id]?.state === status.state && current[id]?.isDraft === status.isDraft
        ? current
        : { ...current, [id]: status },
    );
  }, []);

  const updateSearch = useCallback(
    (patch: {
      [Key in keyof PullRequestsSearch]?: PullRequestsSearch[Key] | undefined;
    }) =>
      void navigate({
        // Rebuilt rather than spread so a cleared field leaves the URL instead of
        // lingering as an explicit `undefined`.
        search: (previous: PullRequestsSearch): PullRequestsSearch => {
          const next = { ...previous, ...patch };
          return {
            involvement: next.involvement ?? previous.involvement,
            state: next.state ?? previous.state,
            ...(next.repository ? { repository: next.repository } : {}),
            ...(next.number ? { number: next.number } : {}),
            ...(next.projectId ? { projectId: next.projectId } : {}),
            ...(next.host ? { host: next.host } : {}),
            ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
            ...(next.q ? { q: next.q } : {}),
          };
        },
        replace: true,
      }),
    [navigate],
  );

  // Changing what the list contains must not leave a selection from the previous view open.
  // The project filter is untouched: it is the user's scope, not part of the selection.
  const clearedSelection = {
    repository: undefined,
    number: undefined,
    selectedProjectId: undefined,
  };
  const updateListScope = (patch: {
    [Key in keyof PullRequestsSearch]?: PullRequestsSearch[Key] | undefined;
  }) => {
    if (rightPanelRef !== null) {
      // Hide the old selection while retaining peer PR tabs for parallel reviews.
      useRightPanelStore.getState().close(rightPanelRef);
    }
    updateSearch({ ...patch, ...clearedSelection });
  };

  // Searching asks the hosts, which takes a round trip, so the text is held for a moment before
  // it is sent. Until it lands, the rows already on screen are narrowed locally: the answer is
  // late but the page is not.
  const typedQuery = (search.q ?? "").trim();
  const sentQuery = useDebouncedValue(typedQuery, SEARCH_DEBOUNCE_MS);
  const querySettled = typedQuery === sentQuery;

  // Page size is view state, not a URL concern: a shared link should open the first page.
  const scopeKey = `${environmentId ?? ""}:${search.state}:${search.involvement}:${scopedProjectId ?? ""}:${search.host ?? ""}`;
  const filterKey = `${scopeKey}:${sentQuery}`;
  // Where the next slice carries on from, per repository, as the server handed it back. Sending
  // it is what makes a second page cost a second page rather than the whole list again — and a
  // repository it does not name has run out and is not read a second time.
  const [page, setPage] = useState<{
    key: string;
    size: number;
    cursors: Record<string, string> | null;
  }>({ key: filterKey, size: PAGE_SIZE, cursors: null });
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const sentCursors = page.key === filterKey ? page.cursors : null;

  // Typing a search, or clearing one, starts the list again at its first page. Without this the
  // paging state from before the search is still filed under these filters and comes back with
  // it, so clearing would return to the slice that had been scrolled to rather than to the list.
  useEffect(() => {
    setPage({ key: filterKey, size: PAGE_SIZE, cursors: null });
  }, [filterKey]);

  const listQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null
      ? null
      : pullRequestEnvironment.list({
          environmentId: pullRequestEnvironmentId,
          input: {
            state: search.state,
            // The hosts narrow by involvement themselves — GitHub by author and review request,
            // and so on — so asking them is the difference between a page of results and a page
            // of everything with the answer somewhere further down it.
            involvement: search.involvement,
            limit: pageSize,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(search.host ? { host: search.host } : {}),
            ...(sentQuery ? { query: sentQuery } : {}),
            ...(sentCursors ? { cursors: sentCursors } : {}),
          },
        }),
  );

  /**
   * The same filters with nothing typed, read whether or not anything is. It is the same atom the
   * list itself uses while no search is on, so it costs nothing then; while one is, it is what the
   * page knows about the workspace — who is signed in, which hosts there are, which repositories
   * could not be read — and what it shows the moment the search is cleared.
   *
   * Kept as its own read rather than remembered from an earlier answer because an answer cannot
   * say which question it belongs to: mid-switch the text has already changed and the data has
   * not, and a search's answer would file itself under the workspace.
   */
  const baselineQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null
      ? null
      : pullRequestEnvironment.list({
          environmentId: pullRequestEnvironmentId,
          input: {
            state: search.state,
            involvement: search.involvement,
            limit: PAGE_SIZE,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(search.host ? { host: search.host } : {}),
          },
        }),
  );
  // The priority groups' own reads. The feed below is paginated by recency, so an older authored
  // or review-requested row can be missing from its first page; partitioned from these
  // server-filtered reads instead, the priority view is complete up front and a continuation can
  // only ever append below what is already on screen. A search re-ranks the whole list by match,
  // so no partitions are read for one. These are the same atoms the Authored and Reviewing tabs
  // ask for, so switching to either is answered from cache.
  const partitionsWanted = search.involvement === "all" && typedQuery.length === 0;
  const authoredQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null || !partitionsWanted
      ? null
      : pullRequestEnvironment.list({
          environmentId: pullRequestEnvironmentId,
          input: {
            state: search.state,
            involvement: "authored",
            limit: PAGE_SIZE,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(search.host ? { host: search.host } : {}),
          },
        }),
  );
  const reviewingQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null || !partitionsWanted
      ? null
      : pullRequestEnvironment.list({
          environmentId: pullRequestEnvironmentId,
          input: {
            state: search.state,
            involvement: "reviewing",
            limit: PAGE_SIZE,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(search.host ? { host: search.host } : {}),
          },
        }),
  );
  // The header's refresh punches through the server's cache before re-reading; the error and
  // empty states retry plainly, because a failure is never cached.
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  // What the reader pressed refresh for is everything they can see, not the one query that
  // happens to be theirs: the list, the counts beside its rows, and whatever the panel is
  // showing. The panel owns its own reads, so it is told to redo them rather than reached into.
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  // The queries only go pending once the invalidation has come back, so refreshing is tracked
  // from the first moment rather than the second: a button that stays live through the slow half
  // of its own work is a button that gets pressed again, and buys the whole cascade twice.
  const [invalidating, setInvalidating] = useState(false);
  const refreshFromHost = async () => {
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
    statsQuery.refresh();
    setDetailRefreshToken((token) => token + 1);
  };
  const refreshing = invalidating || listQuery.isPending;

  // Every page size and every search is its own query, and a new one starts empty. The last
  // answer for these filters is held so the page grows and narrows in place rather than blanking
  // out: a longer page reads as growth, and a search shows the rows it already has, narrowed
  // here, until the hosts answer for themselves.
  const [loaded, setLoaded] = useState<{
    environmentId: EnvironmentId | null;
    scope: string;
    query: string;
    data: PullRequestListResult;
    /** The priority groups' own answers, carried so a cold start has whole groups too. */
    partitions?: PullRequestPartitionsSnapshot;
  } | null>(null);
  // A reload recreates the registry the queries live in, so with nothing held the page would
  // cold-start into skeletons even though almost every row is unchanged. The last answer for
  // this environment is kept across reloads and hydrated here as the carried rows: they render
  // at once — narrowed to the current filters like any carried answer — and the live read
  // reconciles them in place by key rather than replacing them with ghosts.
  useEffect(() => {
    if (environmentId === null) return;
    setLoaded((current) => {
      // Another environment's rows could not even be narrowed — nothing on a row says which
      // environment read it — so its snapshot beats holding them.
      if (current !== null && current.environmentId === environmentId) return current;
      const snapshot = readPullRequestListSnapshot(
        typeof window === "undefined" ? undefined : window.localStorage,
        environmentId,
      );
      if (snapshot === null) return null;
      return {
        environmentId,
        scope: snapshot.scope,
        query: "",
        data: snapshot.data,
        ...(snapshot.partitions === undefined ? {} : { partitions: snapshot.partitions }),
      };
    });
  }, [environmentId]);
  useEffect(() => {
    // Only once this query has settled. While a search is being swapped in or out the text has
    // already changed and the data has not, so recording them together would file the previous
    // answer under the new question — which is how a search's answer came to speak for the
    // workspace after the search was cleared.
    if (!listQuery.data || listQuery.isPending) return;
    const data = listQuery.data;
    setLoaded((current) => {
      // The partitions arrive on their own clock, so this records whichever have landed by
      // now and runs again when the rest do. Until then the ones already held for this scope
      // stay — hydrated or previously answered — rather than being dropped for a feed that
      // merely settled first.
      const partitions =
        partitionsWanted && authoredQuery.data !== null && reviewingQuery.data !== null
          ? { authored: authoredQuery.data.entries, reviewing: reviewingQuery.data.entries }
          : current !== null &&
              current.environmentId === environmentId &&
              current.scope === scopeKey
            ? current.partitions
            : undefined;
      // A search's answer is the search's, not the workspace's, so only unsearched lists
      // persist. Written here where the held partitions are in reach, so a feed settling
      // ahead of them cannot overwrite a stored snapshot that already had both groups.
      if (environmentId !== null && sentQuery.length === 0) {
        writePullRequestListSnapshot(
          typeof window === "undefined" ? undefined : window.localStorage,
          environmentId,
          { scope: scopeKey, data, ...(partitions === undefined ? {} : { partitions }) },
        );
      }
      return {
        environmentId,
        scope: scopeKey,
        query: sentQuery,
        data,
        ...(partitions === undefined ? {} : { partitions }),
      };
    });
  }, [
    environmentId,
    scopeKey,
    sentQuery,
    listQuery.data,
    listQuery.isPending,
    partitionsWanted,
    authoredQuery.data,
    reviewingQuery.data,
  ]);
  // Changing a filter asks a question nothing has answered yet, and the page is already holding
  // perfectly good rows for the last one. Rather than blank out for the round trip, those rows
  // are narrowed to the new filters and stay until the answer lands — a subset of it, never a
  // row it excludes. Narrowed to nothing there is nothing to carry, and the skeletons below are
  // right after all. Another environment's rows are dropped rather than narrowed: nothing on a
  // row says which environment read it.
  const narrowed = useMemo(() => {
    if (loaded === null || loaded.environmentId !== environmentId || loaded.scope === scopeKey) {
      return null;
    }
    const entries = narrowPullRequestsToFilters(loaded.data.entries, {
      state: search.state,
      projectId: scopedProjectId,
      host: search.host,
    });
    return entries.length === 0 ? null : { ...loaded.data, entries };
  }, [environmentId, loaded, scopeKey, scopedProjectId, search.host, search.state]);
  // With nothing typed and nothing to carry on from, the answer is taken from the read that is
  // keyed to exactly that question. Otherwise a search's answer lingers for a render after the
  // text has gone — the data cannot say which question it belongs to, but the read it came from
  // can, and that is what stops a cleared search from keeping its own rows.
  // A grown page is read by the list and nothing else: the baseline always asks for one page, so
  // a host with no cursor to continue from — where "more" means asking for a longer page — would
  // have its extra rows thrown away for the ninety-nine the baseline keeps answering with.
  const answered =
    (sentQuery.length === 0 && sentCursors === null && pageSize === PAGE_SIZE
      ? baselineQuery.data
      : listQuery.data) ??
    (loaded?.scope === scopeKey && loaded.query === sentQuery ? loaded.data : null);
  // Clearing a search returns to a list that has already been read, so it comes back at once
  // rather than after another round trip: the search was the temporary state, not the list.
  const carried =
    (sentQuery.length === 0 ? baselineQuery.data : undefined) ??
    (loaded?.scope === scopeKey ? loaded.data : null) ??
    narrowed;
  const listData = answered ?? carried;
  /** The rows on screen answer the previous question, held while this one is on its way. */
  const showingCarried = answered === null && carried !== null;
  const loadingMore = listQuery.isPending && listData !== null;
  /** Nothing read and nothing to carry, which is the one thing skeletons are for. */
  const firstLoad = listQuery.isPending && listData === null;

  // A longer page is the same list with more on the end, so the rows already read stay where
  // they were read: each answer is merged onto the last rather than replacing it, and anything
  // new lands at the bottom. Only a different question — other filters, another search — starts
  // the order again.
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
        // A continuation is a slice, not the list: it carries only what comes after the rows
        // already held, and says nothing about a repository that has run out. Everything on
        // screen therefore stays, and the slice — ordered among itself, since one repository's
        // next rows can be newer than another's last — lands under it.
        const held = new Set(previous.entries.map(pullRequestEntryKey));
        const arrived = answered.entries.filter((entry) => !held.has(pullRequestEntryKey(entry)));
        const appended = rankPullRequestMatches(
          arrived.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          sentQuery,
        );
        return { key: filterKey, entries: [...previous.entries, ...appended] };
      }
      // A whole-page answer replaces the order outright. Positions used to be inherited so the
      // list would not shift under a reader, but inheriting them filed a pull request opened
      // since the last read at the bottom of the page — below rows a week older — where "the
      // latest" is exactly what a refresh was for. The host answers in the order the page
      // reads, so its order stands; a row that moved was updated, and moving is the news.
      return { key: filterKey, entries: rankPullRequestMatches(answered.entries, sentQuery) };
    });
  }, [answered, filterKey, sentCursors, sentQuery]);

  // Carrying on where the last answer stopped, and only raising the page size for the hosts that
  // could not say where that was.
  // From this question's own answer, never from the rows being held while it travels: a
  // continuation is a boundary in one listing, and carrying one across a search would ask the
  // new question to start where the old one stopped — skipping its newest matches entirely.
  const nextCursors = answered?.nextCursors ?? {};
  const canContinue = !showingCarried && Object.keys(nextCursors).length > 0;
  const loadMore = () => {
    if (canContinue) {
      setPage({ key: filterKey, size: pageSize, cursors: nextCursors });
      return;
    }
    setPage({
      key: filterKey,
      size: Math.min(pageSize + PAGE_SIZE, MAX_PAGE_SIZE),
      cursors: null,
    });
  };

  // A refresh means the whole visible list again, and a cursored query cannot answer that: it
  // re-reads only its own slice, so the rows loaded before it would never see a merge, a close,
  // or a retitle. Going back to a single page long enough to cover everything on screen lets the
  // merge above bring every row up to date in place.
  const refreshList = () => {
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
  };

  // The list goes stale the same way the detail does: somebody opens a pull request, a check
  // finishes, a branch is merged. So it reads again on the way back to the window, and once a
  // minute while somebody is reading it. Those reads go through the server's cache and stop
  // when the reader stops, which is what keeps a page left open from spending a night of the
  // host's rate limit.
  useLiveRefresh(
    () => {
      refreshList();
      baselineQuery.refresh();
      authoredQuery.refresh();
      reviewingQuery.refresh();
    },
    { enabled: pullRequestEnvironmentId !== null },
  );

  const viewers = baselineQuery.data?.viewers ?? listData?.viewers ?? EMPTY_VIEWERS;
  const listErrors = baselineQuery.data?.errors ?? listData?.errors ?? [];

  /** The hosts that narrowed the listing themselves, so their answer is not narrowed again. */
  const searchingHosts = useMemo(
    () =>
      new Set(
        (baselineQuery.data?.providers ?? listData?.providers ?? []).flatMap((provider) =>
          provider.searchesOnHost ? [provider.host] : [],
        ),
      ),
    [baselineQuery.data?.providers, listData?.providers],
  );

  const entries = useMemo(() => {
    const known = ordered?.key === filterKey ? ordered.entries : (listData?.entries ?? []);
    const involvementEntries = filterPullRequestsByInvolvement(known, viewers, search.involvement);
    // The hosts search more than the row shows — a body, a review, a commit message — so once
    // their answer is in, narrowing it again here would throw away matches the reader asked for.
    // The local pass stands in for the answer that has not arrived yet, and for the hosts that
    // answered without searching at all: Azure DevOps has no text filter, so its rows arrive
    // whole and would otherwise sit under a search that never touched them.
    if (typedQuery.length === 0) return involvementEntries;
    const answeredLocally = querySettled && !showingCarried;
    return involvementEntries.filter(
      (entry) =>
        (answeredLocally && searchingHosts.has(entry.host)) ||
        matchesPullRequestQuery(entry, typedQuery),
    );
  }, [
    filterKey,
    listData,
    ordered,
    querySettled,
    search.involvement,
    searchingHosts,
    showingCarried,
    typedQuery,
    viewers,
  ]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    // A failed page must stop the observer. Retained rows keep the sentinel on screen, so
    // re-arming it after a failure would ask for the next page again, forever.
    //
    // Rows on screen are also what makes reaching the sentinel mean anything: with none, it
    // sits directly below the empty state and is always in view, so a search that matches
    // nothing would page through the whole host on its own — one listing of every repository
    // per step — while the reader looks at an empty page. With nothing to scroll past, the
    // next page is asked for rather than assumed.
    if (
      !sentinel ||
      entries.length === 0 ||
      listData?.truncated !== true ||
      listQuery.isPending ||
      listQuery.error !== null ||
      // The rows on screen belong to the previous question, so nothing about them says where
      // this one carries on from. Growing the page under them would answer neither.
      showingCarried ||
      // Asking past the cap is refused, which would strand the list on an error the retry
      // could never clear, so growth stops here and the rest stays on the host. A continuation
      // does not grow the page at all, so the cap does not apply to it.
      (!canContinue && pageSize >= MAX_PAGE_SIZE)
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      // Start the next page slightly before the sentinel is on screen.
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    entries.length,
    filterKey,
    canContinue,
    listData?.truncated,
    listQuery.error,
    listQuery.isPending,
    pageSize,
    showingCarried,
  ]);

  /**
   * The line counts, asked for once the rows are on screen. On GitHub they are forty per cent of
   * the read that answers the whole page, for two small numbers at the end of a row — so the
   * listing leaves them out and they arrive a moment later, into rows that already draw without
   * them. Keyed by the rows being shown, so scrolling further asks only about what is new.
   */
  const groups = useMemo(() => {
    if (search.involvement !== "all") return [{ key: "others" as const, label: "", entries }];
    // Until both partitions have answered, the snapshot's stand in — they are yesterday's
    // groups, but whole ones, where grouping the feed's first page locally loses every
    // authored row older than it. Once the live reads land they take over; with neither,
    // the local grouping is still better than nothing.
    const held =
      loaded !== null && loaded.environmentId === environmentId && loaded.scope === scopeKey
        ? loaded.partitions
        : undefined;
    const authored = partitionsWanted ? (authoredQuery.data?.entries ?? held?.authored) : undefined;
    const reviewing = partitionsWanted
      ? (reviewingQuery.data?.entries ?? held?.reviewing)
      : undefined;
    if (authored === undefined || reviewing === undefined) {
      return groupPullRequestsByInvolvement(entries, viewers);
    }
    return partitionPullRequestsWithPriority(entries, authored, reviewing);
  }, [
    authoredQuery.data?.entries,
    entries,
    environmentId,
    loaded,
    partitionsWanted,
    reviewingQuery.data?.entries,
    scopeKey,
    search.involvement,
    viewers,
  ]);

  // Keyed by every row being shown — the partitions can hold rows the feed has not paged to —
  // so scrolling further asks only about what is new.
  const statsInput = useMemo(
    () => ({
      refs: groups
        .flatMap((group) => group.entries)
        .map((entry) => ({
          projectId: entry.projectId,
          repository: entry.repository,
          number: entry.number,
        })),
    }),
    [groups],
  );
  const statsQuery = useEnvironmentQuery(
    pullRequestEnvironmentId === null || statsInput.refs.length === 0
      ? null
      : pullRequestEnvironment.listStats({
          environmentId: pullRequestEnvironmentId,
          input: statsInput,
        }),
  );
  // Adding or removing one row keys a fresh stats query with nothing in it yet, so the counts
  // are merged into what is already held rather than rebuilt: every count on screen stays until
  // its replacement arrives.
  const [statsByRow, setStatsByRow] = useState<PullRequestDiffStats>(() => new Map());
  useEffect(() => {
    const stats = statsQuery.data?.stats;
    if (stats === undefined) return;
    setStatsByRow((previous) => mergePullRequestDiffStats(previous, stats));
  }, [statsQuery.data]);

  // A link from a thread or the sidebar only knows the repository, so the owning project is
  // resolved here; an explicit `projectId` in the URL still wins.
  const projectIdForRepository = useMemo(() => {
    const repository = search.repository?.toLowerCase();
    if (repository === undefined) return undefined;
    const identity = projects.find(
      (project) =>
        project.repositoryIdentity?.owner &&
        project.repositoryIdentity.name &&
        `${project.repositoryIdentity.owner}/${project.repositoryIdentity.name}`.toLowerCase() ===
          repository &&
        // The same `owner/name` can exist on two hosts. Without this the first match wins, and
        // a link that named its host opens the pull request from the other one.
        (search.host === undefined ||
          pullRequestHostOf(
            project.repositoryIdentity,
            project.repositoryIdentity.provider as SourceControlProviderKind,
          ) === search.host.toLowerCase()),
    );
    return identity?.id;
  }, [projects, search.host, search.repository]);

  // The selection is resolved the same way the scope is: an id from another environment can
  // never be read here, and one that arrived before the projects did is not yet wrong.
  const linkedProjectId = useMemo(
    () => resolveProjectScope(search.selectedProjectId, projects, projectsKnown),
    [projects, projectsKnown, search.selectedProjectId],
  );
  // The scope filter stands in as a last resort: a link can carry `projectId` with a repository
  // whose identity the inference above cannot match, and refusing to open it because of the
  // weaker signal would ignore the stronger one the URL spelled out.
  const selectedProjectId = linkedProjectId ?? projectIdForRepository ?? scopedProjectId;
  const linkedSelection = useMemo(
    () =>
      search.repository && search.number && selectedProjectId
        ? { repository: search.repository, number: search.number, projectId: selectedProjectId }
        : null,
    [search.number, search.repository, selectedProjectId],
  );
  useEffect(() => {
    if (!pullRequestsSupported || rightPanelRef === null || linkedSelection === null) return;
    useRightPanelStore.getState().openPullRequest(rightPanelRef, linkedSelection);
  }, [linkedSelection, pullRequestsSupported, rightPanelRef]);

  const selected =
    rightPanelState.isOpen && activePullRequestSurface !== null
      ? {
          repository: activePullRequestSurface.repository,
          number: activePullRequestSurface.number,
          projectId: activePullRequestSurface.projectId as ProjectId,
        }
      : null;

  const selectSurfaceInUrl = (surface: PullRequestSurface | null) =>
    updateSearch(
      surface === null
        ? clearedSelection
        : {
            repository: surface.repository,
            number: surface.number,
            selectedProjectId: surface.projectId as ProjectId,
          },
    );

  const toggleRightPanel = () => {
    if (rightPanelRef === null) return;
    if (rightPanelState.isOpen) {
      useRightPanelStore.getState().close(rightPanelRef);
      updateSearch(clearedSelection);
      return;
    }
    if (selectedPullRequestSurface === null) return;
    useRightPanelStore.getState().show(rightPanelRef);
    selectSurfaceInUrl(selectedPullRequestSurface);
  };

  // The provider list is the workspace's hosts, not the filtered ones, so switching to a host
  // cannot make the switcher that got you there disappear.
  const [hosts, setHosts] = useState<PullRequestListResult["providers"]>([]);
  useEffect(() => {
    // Only from an answer to these filters. Rows carried over from the previous ones bring the
    // host summaries of the question they answered, and coming back from one host to all of them
    // would take the switcher's other hosts out of it on the strength of the narrowed answer.
    if (answered === null) return;
    // An unfiltered response is the full set of hosts. A filtered one only seeds the switcher
    // when there is nothing to seed it with, which is a link that arrived already scoped.
    setHosts((previous) =>
      search.host === undefined || previous.length === 0 ? answered.providers : previous,
    );
  }, [answered, search.host]);
  const showProvider = hosts.length > 1;
  // The workspace's own projects already name their hosts, so the row's shape is known before
  // the list is. Only its shape: which hosts can actually be read still comes from the server.
  const expectedHosts = useMemo(() => {
    const byHost = new Map<string, PullRequestExpectedHost>();
    for (const project of projects) {
      const kind = project.repositoryIdentity?.provider as SourceControlProviderKind | undefined;
      if (kind === undefined) continue;
      const host = pullRequestHostOf(project.repositoryIdentity, kind);
      if (!byHost.has(host)) byHost.set(host, { host, kind });
    }
    return [...byHost.values()];
  }, [projects]);

  /** Reported per project rather than as a count, so the reader can see which one it was. */
  const unavailableProjects = useMemo(
    () => new Map(listErrors.map((error) => [error.projectId, error.message] as const)),
    [listErrors],
  );

  // Stable so the memoized rows can skip re-rendering when the list around them changes.
  const selectEntry = useCallback(
    (entry: PullRequestListEntry) => {
      if (rightPanelRef === null) return;
      useRightPanelStore.getState().openPullRequest(rightPanelRef, entry);
      updateSearch({
        repository: entry.repository,
        number: entry.number,
        selectedProjectId: entry.projectId,
      });
    },
    [rightPanelRef, updateSearch],
  );

  const searchInput = (
    <PullRequestSearchInput
      value={search.q ?? ""}
      busy={typedQuery.length > 0 && (!querySettled || showingCarried)}
      onChange={(query) => updateSearch({ q: query || undefined })}
    />
  );
  const panelToggleControls = (
    <PanelLayoutControls
      showTerminalControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      rightPanelAvailable={rightPanelState.surfaces.length > 0}
      rightPanelOpen={rightPanelState.isOpen}
      rightPanelShortcutLabel={null}
      liveAgentCount={0}
      onToggleTerminal={() => undefined}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const openPanelControls = (
    <div className="workspace-titlebar-controls right-2 z-50 gap-1 [-webkit-app-region:no-drag] wco:right-[var(--workspace-controls-right)]">
      {panelToggleControls}
    </div>
  );
  // The rows carried over from the last filters can also narrow to nothing one step further on,
  // where involvement is applied against the viewers of the answer they came from. "Nothing under
  // these filters" is a claim, and it is the wrong one to make about a question still in flight,
  // so that case waits with the skeletons rather than answering for the hosts. A search says so
  // in its own words and is left to.
  const carriedToNothing =
    showingCarried && listQuery.isPending && entries.length === 0 && typedQuery.length === 0;
  const listBody = (
    <>
      {!capabilityKnown ? (
        <PullRequestListGhost rows={7} />
      ) : !pullRequestsSupported ? (
        <PullRequestsUnavailableState
          title="Pull requests unavailable"
          error="Update this environment's T3 Code server to browse pull requests."
        />
      ) : firstLoad ? (
        <PullRequestListGhost rows={7} />
      ) : listQuery.error && listData === null ? (
        <PullRequestsUnavailableState error={listQuery.error} onRetry={() => listQuery.refresh()} />
      ) : carriedToNothing ? (
        <PullRequestListGhost rows={7} />
      ) : entries.length === 0 ? (
        <PullRequestListEmptyState
          hasProjects={!projectsKnown || projects.length > 0}
          refreshing={refreshing}
          onRefresh={() => void refreshFromHost()}
          query={typedQuery}
          filtered={
            search.state !== "open" ||
            search.involvement !== "all" ||
            scopedProjectId !== undefined ||
            search.host !== undefined
          }
          searching={typedQuery.length > 0 && (!querySettled || showingCarried)}
          canLoadMore={listData?.truncated === true && (canContinue || pageSize < MAX_PAGE_SIZE)}
          loadingMore={loadingMore}
          onClearQuery={() => updateSearch({ q: undefined })}
          onLoadMore={loadMore}
        />
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.key} className="space-y-0.5">
              {group.label ? (
                <h2 className="px-3 pb-0.5 text-xs font-medium text-muted-foreground/70">
                  {group.label}
                </h2>
              ) : null}
              {group.entries.map((entry) => (
                <PullRequestRow
                  key={pullRequestEntryKey(entry)}
                  // A row whose host reported its line counts keeps them; one whose host left
                  // them for later takes whatever has arrived since, and draws without them
                  // until it does.
                  entry={withDiffStat(entry, statsByRow)}
                  showProjectTitle
                  showProvider={showProvider}
                  // Ten is the floor the ranking gives a row whose own fields say nothing
                  // about the search: the host matched something this row cannot show.
                  matchedElsewhere={
                    typedQuery.length > 0 &&
                    scorePullRequestMatch(entry, typedQuery) <= MATCHED_ELSEWHERE_SCORE
                  }
                  selected={
                    selected?.repository === entry.repository && selected.number === entry.number
                  }
                  onSelect={selectEntry}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {listQuery.error && listData !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <span>The latest request failed. Showing the last pull requests loaded.</span>
          <Button size="xs" variant="outline" onClick={() => listQuery.refresh()}>
            Retry
          </Button>
        </div>
      ) : null}
      {listData?.truncated && entries.length > 0 ? (
        <div ref={sentinelRef} className="flex justify-center py-2 text-xs text-muted-foreground">
          {loadingMore ? (
            <span className="flex items-center gap-2">
              <LoaderIcon aria-hidden className="size-3.5 animate-spin" />
              Loading more
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
  // The same names and glyphs the host pills wear, so the compact menu and the pills read as
  // one control: "GitHub" with its mark, never the bare hostname — unless two installs of one
  // kind force the hostname to tell them apart.
  const hostEntries = hosts.length > 0 ? hosts : expectedHosts;
  const hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: "", label: "All hosts", Icon: LayersIcon },
    ...hostEntries.map((entry) => {
      // `expectedHosts` stands in before the server has answered, and nothing is known to be
      // unreadable yet; once the summaries arrive they carry whether each one could be read.
      const summary = hosts.find((host) => host.host === entry.host);
      return {
        value: entry.host,
        label: pullRequestHostLabel(hostEntries, entry),
        Icon: getSourceControlPresentationForKind(entry.kind).Icon,
        ...(summary === undefined || summary.configured
          ? {}
          : { unavailable: summary.detail ?? "This host could not be read." }),
      };
    }),
  ];
  const filtersMenu = (
    <PullRequestFiltersMenu
      state={search.state}
      stateOptions={STATE_TABS}
      onState={(state) => updateListScope({ state })}
      involvement={search.involvement}
      involvementOptions={INVOLVEMENT_TABS}
      onInvolvement={(involvement) => updateListScope({ involvement })}
      host={search.host}
      hostOptions={hostMenuOptions}
      onHost={(host) => updateListScope({ host })}
      environmentId={environmentId}
      projects={scopedProjects}
      projectId={scopedProjectId}
      unavailable={unavailableProjects}
      onProject={(projectId) => updateListScope({ projectId })}
    />
  );
  const columnProps = {
    refreshing,
    onRefresh: () => void refreshFromHost(),
    searchValue: search.q ?? "",
    involvement: search.involvement,
    state: search.state,
    host: search.host,
    hostMenuOptions,
    onInvolvement: (involvement: PullRequestInvolvement) => updateListScope({ involvement }),
    onState: (state: PullRequestListState) => updateListScope({ state }),
    onHost: (host: string | undefined) => updateListScope({ host }),
    searchInput,
    filtersMenu,
    rightPanelControl:
      !pullRequestsSupported || rightPanelState.isOpen ? null : panelToggleControls,
    rightPanelOpen: rightPanelState.isOpen,
    listBody,
  };

  const activateSurface = (surface: PullRequestSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().activateSurface(rightPanelRef, surface.id);
    selectSurfaceInUrl(surface);
  };
  const closeSurface = (surface: PullRequestSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurface(rightPanelRef, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      rightPanelRef,
    );
    selectSurfaceInUrl(next?.kind === "pull-request" ? next : null);
  };
  const closeOtherSurfaces = (surface: PullRequestSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeOtherSurfaces(rightPanelRef, surface.id);
    selectSurfaceInUrl(surface);
  };
  const closeSurfacesToRight = (surface: PullRequestSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurfacesToRight(rightPanelRef, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      rightPanelRef,
    );
    selectSurfaceInUrl(next?.kind === "pull-request" ? next : null);
  };
  const closeAllSurfaces = () => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeAllSurfaces(rightPanelRef);
    selectSurfaceInUrl(null);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {pullRequestsSupported && rightPanelState.isOpen ? openPanelControls : null}
        <PullRequestsColumn {...columnProps} />

        {rightPanelState.isOpen && activePullRequestSurface && pullRequestEnvironmentId !== null ? (
          <RightPanelTabs
            mode="inline"
            widthStorageKey="t3code:pull-request-panel-width"
            // Default to roughly half the viewport: the PR list needs more
            // room than a chat, so the 540px chat-preview default squashes
            // it. SSR has no window, so fall back to a reasonable width.
            defaultWidth={typeof window === "undefined" ? 640 : Math.floor(window.innerWidth / 2)}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={activePullRequestSurface.id}
            pendingSurfaceIds={EMPTY_PENDING_SURFACES}
            previewSessions={EMPTY_PREVIEW_SESSIONS}
            terminalLabelsById={EMPTY_TERMINAL_LABELS}
            onActivate={(surface) => {
              if (surface.kind === "pull-request") activateSurface(surface);
            }}
            onCloseSurface={(surface) => {
              if (surface.kind === "pull-request") closeSurface(surface);
            }}
            onCloseOtherSurfaces={(surface) => {
              if (surface.kind === "pull-request") closeOtherSurfaces(surface);
            }}
            onCloseSurfacesToRight={(surface) => {
              if (surface.kind === "pull-request") closeSurfacesToRight(surface);
            }}
            onCloseAllSurfaces={closeAllSurfaces}
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddAgents={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            agentsAvailable={false}
            liveAgentCount={0}
            pullRequestStatuses={pullRequestTabStatuses}
          >
            <PullRequestDetailPanel
              key={activePullRequestSurface.id}
              environmentId={pullRequestEnvironmentId}
              reference={{
                projectId: activePullRequestSurface.projectId as ProjectId,
                repository: activePullRequestSurface.repository,
                number: activePullRequestSurface.number,
              }}
              refreshToken={detailRefreshToken}
              // Merging, closing or reopening changes the row this panel was opened from, so
              // the list behind it is out of date the moment the host takes the action.
              onActed={() => {
                refreshList();
                baselineQuery.refresh();
                authoredQuery.refresh();
                reviewingQuery.refresh();
              }}
              onStateChange={handlePullRequestTabStatusChange}
              chromeVariant="collapse"
            />
          </RightPanelTabs>
        ) : null}
      </div>
    </SidebarInset>
  );
}

/**
 * A compact stand-in for one pill group: the trigger wears the current choice, the choices
 * live in a menu. Same options, same handler — only the footprint changes.
 */
function CompactFilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <Menu>
      <MenuTrigger
        aria-label={label}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {current.label}
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-40">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
          {options.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              // A host the server has already said it cannot read is not a choice here either.
              // The pills disable it; a menu that offers it would answer the press by replacing
              // a working list with the same failure the pill row exists to explain.
              disabled={option.unavailable !== undefined}
              title={option.unavailable}
            >
              <span className="flex min-w-0 items-center gap-2">
                <option.Icon aria-hidden className="size-3.5" />
                {option.label}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The search, folded to an icon until asked for. Opening moves focus into the input — the
 * whole point of pressing it is to type. It stays open while it holds a query, so an active
 * search is never invisible; empty and blurred, it folds back.
 */
function ExpandableSearch({
  searchInput,
  searchValue,
  open,
  onOpenChange,
  focusToken,
  onFocusWithin,
}: {
  searchInput: ReactNode;
  searchValue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bumped to pull focus into the input while it is already showing — the Mod+F path. */
  focusToken: number;
  /**
   * Focus entering and leaving the expanded input. An unmount fires no blur, which is the
   * point: whoever unmounted this can still see the reader was mid-typing and move the
   * focus somewhere that continues the sentence.
   */
  onFocusWithin?: (focused: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    containerRef.current?.querySelector("input")?.focus();
  }, [open]);
  const appliedFocusToken = useRef(focusToken);
  useEffect(() => {
    if (appliedFocusToken.current === focusToken) return;
    appliedFocusToken.current = focusToken;
    const input = containerRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, [focusToken]);
  if (open || searchValue.length > 0) {
    return (
      <div
        ref={containerRef}
        className="w-56 shrink-0"
        onFocus={() => onFocusWithin?.(true)}
        onBlur={() => {
          onFocusWithin?.(false);
          if (searchValue.length === 0) onOpenChange(false);
        }}
      >
        {searchInput}
      </div>
    );
  }
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Search pull requests"
      onClick={() => onOpenChange(true)}
    >
      <SearchIcon className="size-4" />
    </Button>
  );
}

/**
 * The pull request list column. The full controls live at the top of the scroll flow; once
 * they scroll away, the title transforms into the scope itself — "Pull Requests / Open ▾
 * Authored ▾" — where each segment is the menu for that filter, and a folded search sits on
 * the right. Scrolled back up, the topbar returns to the plain title. The topbar is the
 * window drag region throughout; its interactive children opt out through the `.drag-region`
 * descendant rules.
 */
function PullRequestsColumn({
  refreshing,
  onRefresh,
  searchValue,
  involvement,
  state,
  host,
  hostMenuOptions,
  onInvolvement,
  onState,
  onHost,
  searchInput,
  filtersMenu,
  rightPanelControl,
  rightPanelOpen,
  listBody,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  searchValue: string;
  involvement: PullRequestInvolvement;
  state: PullRequestListState;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  onState: (state: PullRequestListState) => void;
  onHost: (host: string | undefined) => void;
  searchInput: ReactNode;
  filtersMenu: ReactNode;
  rightPanelControl: ReactNode;
  rightPanelOpen: boolean;
  listBody: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCondensed(entry ? !entry.isIntersecting : false),
      { root: scrollRef.current },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);
  // Typing into the topbar search narrows the list, and a short enough list un-scrolls the
  // page — which dissolves the condensed topbar and unmounts the very input being typed in.
  // The two inputs are one search to the reader, so the focus follows the value into the
  // in-flow bar, caret at the end, and the sentence continues.
  const topbarSearchFocusedRef = useRef(false);
  const inFlowSearchRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  // Mod+F belongs to this page's own search: the desktop shell binds no find-in-page, so the
  // shortcut would otherwise do nothing. Condensed, it unfolds the topbar search; at the top,
  // it focuses the in-flow bar and selects the query the way a find field would.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (condensed) {
        setSearchOpen(true);
        setSearchFocusToken((token) => token + 1);
        return;
      }
      const input = inFlowSearchRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [condensed]);
  useEffect(() => {
    if (condensed) return;
    // The fold-out is gone from the chrome; forgetting it open keeps the next condensing
    // from starting with an empty expanded search nobody asked for.
    setSearchOpen(false);
    if (!topbarSearchFocusedRef.current) return;
    topbarSearchFocusedRef.current = false;
    const input = inFlowSearchRef.current?.querySelector("input");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [condensed]);

  return (
    // Painted flat like the chat column: the inset underneath carries the chrome grain, and a
    // content surface that lets it show reads as a different background than every thread.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header
        className={cn(
          "workspace-topbar drag-region gap-1.5 px-3 sm:px-5",
          // A closed right panel leaves this column full-width, so its header runs
          // underneath the native window controls on Windows; reserve the inset the
          // way Settings and the chat view do. While the panel is open the column
          // ends at the panel's left edge and the absolute controls strip (already
          // WCO-aware) owns the top-right corner.
          !rightPanelOpen && "wco:pr-[var(--workspace-native-controls-inset)]",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        {condensed ? (
          <WorkspaceBreadcrumb ariaLabel="Pull request scope">
            {/* The page name remains the foreground anchor in both states; the live filters are
                its compact scope, grouped as the second crumb rather than pretending each menu
                is a separate page in the hierarchy. */}
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Pull Requests</h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem className="gap-1.5 overflow-hidden">
              <CompactFilterMenu
                label="Filter by state"
                value={state}
                options={STATE_TABS}
                onChange={onState}
              />
              <CompactFilterMenu
                label="Filter by involvement"
                value={involvement}
                options={INVOLVEMENT_TABS}
                onChange={onInvolvement}
              />
              {hostMenuOptions.length > 2 ? (
                <CompactFilterMenu
                  label="Filter by host"
                  value={host ?? ""}
                  options={hostMenuOptions}
                  onChange={(next) => onHost(next === "" ? undefined : next)}
                />
              ) : null}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        ) : (
          <WorkspaceBreadcrumb ariaLabel="Pull requests breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Pull Requests</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        )}
        <div className="min-w-0 flex-1" />
        {condensed ? (
          <ExpandableSearch
            searchInput={searchInput}
            searchValue={searchValue}
            open={searchOpen}
            onOpenChange={setSearchOpen}
            focusToken={searchFocusToken}
            onFocusWithin={(focused) => {
              topbarSearchFocusedRef.current = focused;
            }}
          />
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh pull requests"
          onClick={onRefresh}
        >
          <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
        </Button>
        {rightPanelControl}
      </header>

      <div
        ref={scrollRef}
        className="pull-requests-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      >
        {/* The top padding is the fade band's own height (1.5rem here), the same pairing the
            settings page makes: at rest the controls sit fully below the mask, and only
            content actually passing under the chrome fades. */}
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 pt-6 pb-12">
          <div className="flex flex-col gap-3">
            <div ref={inFlowSearchRef} className="flex items-center gap-2">
              {searchInput}
              {filtersMenu}
            </div>
            {/* Scrolled past this marker, the controls are gone and the title takes over. */}
            <div ref={markerRef} aria-hidden className="-mt-3 h-px w-full" />
          </div>

          {listBody}
        </div>
      </div>
    </div>
  );
}
