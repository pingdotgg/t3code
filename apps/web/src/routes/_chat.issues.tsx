import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sourceControlHostOf, ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueListEntry,
  IssueListResult,
  IssueListState,
  LinearConnection,
  LinearProjectBinding,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AtSignIcon,
  CircleCheckIcon,
  CircleDotIcon,
  LayersIcon,
  LoaderIcon,
  PenLineIcon,
  UserCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  filterIssueQueryResults,
  filterIssuesByInvolvement,
  groupIssuesByInvolvement,
  issueEntryKey,
  narrowIssuesToFilters,
  partitionIssuesWithPriority,
  rankIssueMatches,
  readIssueListSnapshot,
  writeIssueListSnapshot,
  type IssuePartitionsSnapshot,
} from "../components/issue/issueList.logic";
import { IssueCreateDialog } from "../components/issue/IssueCreateDialog";
import { IssueDetailPanel } from "../components/issue/IssueDetailPanel";
import { LinearConnectionDialog } from "../components/issue/LinearConnectionDialog";
import { LinearIcon } from "../components/Icons";
import { ListGhost } from "../components/sourceControl/ListGhosts";
import {
  CompactFilterMenu as SharedCompactFilterMenu,
  ExpandableSearch,
  ListRefreshControl,
  useListSearchShortcut,
} from "../components/sourceControl/ListTitlebarControls";
import { IssueListEmptyState } from "../components/issue/IssueListEmptyState";
import {
  IssueFiltersMenu,
  renderIssueProviderMenuRadioGroup,
  IssueSortMenu,
} from "../components/issue/IssueListFilters";
import { ListSearchInput, type ListFilterOption } from "../components/sourceControl/ListFilterMenu";
import { IssueRow } from "../components/issue/IssueRow";
import {
  WorkItemSelectButton,
  WorkItemSelectionBarHost,
} from "../components/workItems/WorkItemSelectionBar";
import { IssuesUnavailableState } from "../components/issue/IssuesUnavailableState";
import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import { resolveProjectScope } from "../components/sourceControl/projectScope";
import {
  RightPanelTabs,
  type IssueTabStatus,
  type PullRequestTabStatus,
} from "../components/RightPanelTabs";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls";
import { Button } from "../components/ui/button";
import { MenuItem, MenuSeparator } from "../components/ui/menu";
import { SidebarInset } from "../components/ui/sidebar";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { usePrimarySettings } from "../hooks/useSettings";
import {
  pullRequestSurfaceId,
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  updateIssueTabStatus,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { useDebouncedValue } from "../state/queries";
import {
  findProjectForLink,
  openLinkInBrowser,
  repositoryForProjectLink,
} from "../lib/openIssueLink";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { issueEnvironment } from "../state/issues";
import { issueTrackingEnvironment } from "../state/issueTracking";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { getIssueProviderPresentation } from "../components/issue/issuePresentation";
import { toastManager } from "../components/ui/toast";
import { isWorkItemSelected, useWorkItemSelection } from "../workItemSelection";

export interface IssuesSearch {
  readonly involvement: IssueInvolvement;
  readonly state: IssueListState;
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
  readonly selectedProvider?: string;
  /**
   * One label name every row must wear. Narrowed here rather than on the hosts: a label is a
   * word the rows already carry, and asking four hosts about it would cost a round trip to
   * answer a question the page can answer itself.
   */
  readonly label?: string;
  readonly q?: string;
  readonly sort?: IssueListSort;
  readonly order?: IssueListOrder;
}

export function issueSelectionSearchPatch(target: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly provider?: string;
}) {
  return {
    repository: target.repository,
    number: target.number,
    selectedProjectId: target.projectId,
    selectedProvider: target.provider,
  };
}

export function isIssueEntryOpen(
  selected: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly provider?: string;
    readonly number: number;
  } | null,
  entry: Pick<IssueListEntry, "projectId" | "repository" | "provider" | "number">,
) {
  return (
    selected?.repository === entry.repository &&
    selected.projectId === entry.projectId &&
    (selected.provider === undefined || selected.provider === entry.provider) &&
    selected.number === entry.number
  );
}

export function mergeIssueProviderSummaries(
  previous: IssueListResult["providers"],
  next: IssueListResult["providers"],
  filteredHost: string | undefined,
): IssueListResult["providers"] {
  return filteredHost === undefined
    ? next
    : [...previous.filter((provider) => provider.host !== filteredHost), ...next];
}

export function stabilizeLinearProviderSummary(
  providers: IssueListResult["providers"],
  projectIds: ReadonlyArray<ProjectId>,
  projectBindings: Readonly<Record<ProjectId, LinearProjectBinding | null>>,
  hasLinearSource = false,
  projectTeams: Readonly<Record<string, string>> = {},
): IssueListResult["providers"] {
  const projectCount = projectIds.filter(
    (projectId) =>
      projectBindings[projectId] != null ||
      (projectBindings[projectId] === undefined && projectTeams[projectId] !== undefined),
  ).length;
  if (projectCount === 0)
    return hasLinearSource ? providers : providers.filter((provider) => provider.kind !== "linear");
  const linear = providers.find((provider) => provider.kind === "linear");
  const connected = {
    kind: "linear" as const,
    host: "linear.app",
    configured: true,
    searchesOnHost: false,
    projectCount,
    detail: null,
  };
  return linear === undefined
    ? [...providers, connected]
    : providers.map((provider) => (provider === linear ? { ...linear, ...connected } : provider));
}

export function hasLinearManagementState(
  connection: Pick<LinearConnection, "status" | "hasStoredToken"> | null | undefined,
  settings: {
    readonly projectBindings: Readonly<Record<string, LinearProjectBinding | null>>;
    readonly projectTeams: Readonly<Record<string, string>>;
  },
  projectIds?: ReadonlyArray<ProjectId>,
) {
  const isCurrentProject = (projectId: string) =>
    projectIds === undefined || projectIds.includes(projectId as ProjectId);
  return (
    connection?.status === "authenticated" ||
    connection?.hasStoredToken === true ||
    Object.entries(settings.projectBindings).some(
      ([projectId, binding]) => isCurrentProject(projectId) && binding != null,
    ) ||
    Object.keys(settings.projectTeams).some(
      (projectId) =>
        isCurrentProject(projectId) &&
        settings.projectBindings[projectId as ProjectId] === undefined,
    )
  );
}

interface CompactFilterAction {
  readonly connected: boolean;
  readonly onClick: () => void;
}

// The state filters wear the same glyphs the rows do, so the two read as one vocabulary.
const INVOLVEMENT_TABS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "assigned", label: "Assigned", Icon: UserCheckIcon },
  { value: "authored", label: "Authored", Icon: PenLineIcon },
  { value: "mentioned", label: "Mentioned", Icon: AtSignIcon },
] as const satisfies ReadonlyArray<ListFilterOption<IssueInvolvement>>;

const STATE_TABS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "open", label: "Open", Icon: CircleDotIcon },
  { value: "closed", label: "Closed", Icon: CircleCheckIcon },
] as const satisfies ReadonlyArray<ListFilterOption<IssueListState>>;

function issueListSort(value: unknown): IssueListSort | undefined {
  switch (value) {
    case "best-match":
    case "created":
    case "updated":
    case "comments":
    case "reactions":
    case "reactions-thumbs-up":
    case "reactions-thumbs-down":
    case "reactions-rocket":
    case "reactions-hooray":
    case "reactions-eyes":
    case "reactions-heart":
    case "reactions-laugh":
    case "reactions-confused":
      return value;
    default:
      return undefined;
  }
}

/** Long enough that a keystroke does not become a request, short enough to feel answered. */
const SEARCH_DEBOUNCE_MS = 250;
/**
 * One whole page from the host and no more: every provider asks for one row beyond the page as
 * its "is there more" probe, and GitHub serves a hundred per request — so asking for ninety-nine
 * costs one round trip where a hundred costs two.
 */
const PAGE_SIZE = 99;
/** The largest page the listing accepts; past it the request is refused outright. */
const MAX_PAGE_SIZE = 500;
/** Stable empty map so the memos below do not see a new object on every render. */
const EMPTY_VIEWERS: IssueListResult["viewers"] = {};
/** The list owns one environment-scoped right panel rather than borrowing a real thread's. */
const ISSUES_PANEL_ID = ThreadId.make("issues-panel");
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_PREVIEW_DESKTOP_STATE = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const EMPTY_PENDING_SURFACES = new Set<string>();

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Record<string, unknown>): IssuesSearch => {
    const sort = issueListSort(raw.sort);
    return {
      involvement:
        raw.involvement === "assigned" ||
        raw.involvement === "authored" ||
        raw.involvement === "mentioned"
          ? raw.involvement
          : "all",
      state: raw.state === "closed" || raw.state === "all" ? raw.state : "open",
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
      ...(typeof raw.selectedProvider === "string" && raw.selectedProvider
        ? { selectedProvider: raw.selectedProvider.slice(0, 100) }
        : {}),
      ...(typeof raw.label === "string" && raw.label ? { label: raw.label.slice(0, 200) } : {}),
      ...(sort === undefined ? {} : { sort }),
      ...(raw.order === "asc" || raw.order === "desc" ? { order: raw.order } : {}),
      ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
    };
  },
  component: IssuesRouteView,
});

function IssuesRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const capabilityKnown = primaryEnvironment !== null && primaryEnvironment.serverConfig !== null;
  const issuesSupported =
    primaryEnvironment?.serverConfig?.environment.capabilities.issues === true;
  // The primary environment may still be connecting, or may predate this feature. In either
  // case every query remains idle until the server has explicitly advertised these APIs.
  const issueEnvironmentId = issuesSupported ? environmentId : null;
  const linearSettings = usePrimarySettings((settings) => settings.issueTracking.linear);
  const linearConnection = useEnvironmentQuery(
    issueEnvironmentId === null
      ? null
      : issueTrackingEnvironment.linearStatus({
          environmentId: issueEnvironmentId,
          input: undefined,
        }),
  );
  const selectedWorkItems = useWorkItemSelection((state) => state.items);
  const toggleWorkItem = useWorkItemSelection((state) => state.toggle);
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
  const currentProjectIds = projects.map((project) => project.id);
  const linearProjectCount = currentProjectIds.filter(
    (projectId) =>
      linearSettings.projectBindings[projectId] != null ||
      (linearSettings.projectBindings[projectId] === undefined &&
        linearSettings.projectTeams[projectId] !== undefined),
  ).length;
  const linearManaged = hasLinearManagementState(
    linearConnection.data,
    linearSettings,
    currentProjectIds,
  );
  const hasCurrentLinearSource = hasLinearManagementState(
    undefined,
    linearSettings,
    currentProjectIds,
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
    () => (environmentId === null ? null : scopeThreadRef(environmentId, ISSUES_PANEL_ID)),
    [environmentId],
  );
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, rightPanelRef),
  );
  const selectedRightPanelSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, rightPanelRef),
  );
  // A change request opened from an issue reads beside it as a peer tab, so this panel holds
  // both kinds; only the issue tabs answer for the row highlighted in the list behind it.
  const activeSurface =
    rightPanelState.isOpen &&
    (selectedRightPanelSurface?.kind === "issue" ||
      selectedRightPanelSurface?.kind === "pull-request")
      ? selectedRightPanelSurface
      : null;
  const activeIssueSurface = activeSurface?.kind === "issue" ? activeSurface : null;
  const [issueTabStatuses, setIssueTabStatuses] = useState<Record<string, IssueTabStatus>>({});
  const activeIssueSurfaceId = activeIssueSurface?.id;
  const handleIssueTabStatusChange = useCallback(
    (status: IssueTabStatus) => {
      if (activeIssueSurfaceId === undefined) return;
      setIssueTabStatuses((current) => updateIssueTabStatus(current, activeIssueSurfaceId, status));
    },
    [activeIssueSurfaceId],
  );
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
      [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined;
    }) =>
      void navigate({
        // Rebuilt rather than spread so a cleared field leaves the URL instead of
        // lingering as an explicit `undefined`.
        search: (previous: IssuesSearch): IssuesSearch => {
          const next = { ...previous, ...patch };
          return {
            involvement: next.involvement ?? previous.involvement,
            state: next.state ?? previous.state,
            ...(next.repository ? { repository: next.repository } : {}),
            ...(next.number ? { number: next.number } : {}),
            ...(next.projectId ? { projectId: next.projectId } : {}),
            ...(next.host ? { host: next.host } : {}),
            ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
            ...(next.selectedProvider ? { selectedProvider: next.selectedProvider } : {}),
            ...(next.q ? { q: next.q } : {}),
            ...(next.sort ? { sort: next.sort } : {}),
            ...(next.order ? { order: next.order } : {}),
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
    selectedProvider: undefined,
  };
  const updateListScope = (patch: {
    [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined;
  }) => {
    if (rightPanelRef !== null) {
      // Hide the old selection while retaining peer issue tabs for parallel reading.
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
  const sort: IssueListSort = search.sort ?? (sentQuery ? "best-match" : "updated");
  const order: IssueListOrder = search.order ?? "desc";

  // Page size is view state, not a URL concern: a shared link should open the first page.
  const scopeKey = `${environmentId ?? ""}:${search.state}:${search.involvement}:${scopedProjectId ?? ""}:${search.host ?? ""}:${sort}:${order}`;
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
    issueEnvironmentId === null
      ? null
      : issueEnvironment.list({
          environmentId: issueEnvironmentId,
          input: {
            state: search.state,
            // The hosts narrow by involvement themselves — GitHub by author and assignee, and so
            // on — so asking them is the difference between a page of results and a page of
            // everything with the answer somewhere further down it.
            involvement: search.involvement,
            limit: pageSize,
            sort,
            order,
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
    issueEnvironmentId === null
      ? null
      : issueEnvironment.list({
          environmentId: issueEnvironmentId,
          input: {
            state: search.state,
            involvement: search.involvement,
            limit: PAGE_SIZE,
            sort: search.sort ?? "updated",
            order: search.order ?? "desc",
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(search.host ? { host: search.host } : {}),
          },
        }),
  );
  // The priority groups' own reads. The feed below is paginated by recency, so an older authored
  // or assigned row can be missing from its first page; partitioned from these server-filtered
  // reads instead, the priority view is complete up front and a continuation can only ever append
  // below what is already on screen. A search re-ranks the whole list by match, so no partitions
  // are read for one. These are the same atoms the Authored and Assigned tabs ask for, so
  // switching to either is answered from cache.
  const partitionsWanted =
    search.involvement === "all" &&
    typedQuery.length === 0 &&
    sort === "updated" &&
    order === "desc";
  const authoredQuery = useEnvironmentQuery(
    issueEnvironmentId === null || !partitionsWanted
      ? null
      : issueEnvironment.list({
          environmentId: issueEnvironmentId,
          input: {
            state: search.state,
            involvement: "authored",
            limit: PAGE_SIZE,
            sort: search.sort ?? "updated",
            order: search.order ?? "desc",
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(search.host ? { host: search.host } : {}),
          },
        }),
  );
  const assignedQuery = useEnvironmentQuery(
    issueEnvironmentId === null || !partitionsWanted
      ? null
      : issueEnvironment.list({
          environmentId: issueEnvironmentId,
          input: {
            state: search.state,
            involvement: "assigned",
            limit: PAGE_SIZE,
            sort: search.sort ?? "updated",
            order: search.order ?? "desc",
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(search.host ? { host: search.host } : {}),
          },
        }),
  );
  // The header's refresh punches through the server's cache before re-reading; the error and
  // empty states retry plainly, because a failure is never cached.
  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  // What the reader pressed refresh for is everything they can see, not the one query that
  // happens to be theirs: the list and whatever the panel is showing. The panel owns its own
  // reads, so it is told to redo them rather than reached into.
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  // The queries only go pending once the invalidation has come back, so refreshing is tracked
  // from the first moment rather than the second: a button that stays live through the slow half
  // of its own work is a button that gets pressed again, and buys the whole cascade twice.
  const [invalidating, setInvalidating] = useState(false);
  const invalidateHost = async () => {
    setInvalidating(true);
    try {
      if (issueEnvironmentId !== null) {
        await invalidate({ environmentId: issueEnvironmentId, input: {} });
      }
    } finally {
      setInvalidating(false);
    }
  };
  const refreshFromHost = async () => {
    await invalidateHost();
    refreshList();
    baselineQuery.refresh();
    authoredQuery.refresh();
    assignedQuery.refresh();
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
    data: IssueListResult;
    /** The priority groups' own answers, carried so a cold start has whole groups too. */
    partitions?: IssuePartitionsSnapshot;
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
      const snapshot = readIssueListSnapshot(
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
        partitionsWanted && authoredQuery.data !== null && assignedQuery.data !== null
          ? { authored: authoredQuery.data.entries, assigned: assignedQuery.data.entries }
          : current !== null &&
              current.environmentId === environmentId &&
              current.scope === scopeKey
            ? current.partitions
            : undefined;
      // A search's answer is the search's, not the workspace's, so only unsearched lists
      // persist. Written here where the held partitions are in reach, so a feed settling
      // ahead of them cannot overwrite a stored snapshot that already had both groups.
      if (environmentId !== null && sentQuery.length === 0) {
        writeIssueListSnapshot(
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
    assignedQuery.data,
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
    const entries = narrowIssuesToFilters(loaded.data.entries, {
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
  const baselineVisible = sentQuery.length === 0 && sentCursors === null && pageSize === PAGE_SIZE;
  const answered =
    (baselineVisible ? baselineQuery.data : listQuery.data) ??
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
    entries: ReadonlyArray<IssueListEntry>;
  } | null>(null);
  useEffect(() => {
    if (!answered) return;
    const hostOrdered =
      sort === "best-match" && answered.providers.some((provider) => provider.kind !== "github")
        ? rankIssueMatches(answered.entries, sentQuery)
        : answered.entries;
    setOrdered((previous) => {
      if (previous === null || previous.key !== filterKey) {
        return {
          key: filterKey,
          entries: hostOrdered,
        };
      }
      if (sentCursors !== null) {
        // A continuation is a slice, not the list: it carries only what comes after the rows
        // already held, and says nothing about a repository that has run out. Everything on
        // screen therefore stays, and the slice — ordered among itself, since one repository's
        // next rows can be newer than another's last — lands under it.
        const held = new Set(previous.entries.map(issueEntryKey));
        const arrived = answered.entries.filter((entry) => !held.has(issueEntryKey(entry)));
        return { key: filterKey, entries: [...previous.entries, ...arrived] };
      }
      // A whole-page answer replaces the order outright: the host answers in the order the page
      // reads, so its order stands, and an issue opened since the last read belongs at the top
      // rather than wherever the previous page happened to leave room for it.
      return {
        key: filterKey,
        entries: hostOrdered,
      };
    });
  }, [answered, filterKey, order, sentCursors, sentQuery, sort]);

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
  // re-reads only its own slice, so the rows loaded before it would never see a close, a reopen
  // or a retitle. Going back to a single page long enough to cover everything on screen lets the
  // merge above bring every row up to date in place.
  const refreshList = () => {
    if (sentCursors === null) {
      (baselineVisible ? baselineQuery : listQuery).refresh();
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

  // The list goes stale the same way the detail does: somebody files an issue, comments on one,
  // closes another. So it reads again on the way back to the window, and every five minutes while
  // somebody is reading it. Those reads go through the server's cache and stop when the reader
  // stops, which is what keeps a page left open from spending a night of the host's rate limit.
  useLiveRefresh(
    () => {
      refreshList();
      authoredQuery.refresh();
      assignedQuery.refresh();
    },
    { enabled: issueEnvironmentId !== null },
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
    const involvementEntries = filterIssuesByInvolvement(known, viewers, search.involvement);
    // The hosts search more than the row shows — a body, a comment — so once their answer is in,
    // narrowing it again here would throw away matches the reader asked for. The local pass
    // stands in for the answer that has not arrived yet, and for the hosts that answered without
    // searching at all: their rows arrive whole and would otherwise sit under a search that
    // never touched them.
    const labelled =
      search.label === undefined
        ? involvementEntries
        : involvementEntries.filter((entry) =>
            entry.labels.some((entryLabel) => entryLabel.name === search.label),
          );
    if (typedQuery.length === 0) return labelled;
    const answeredLocally = querySettled && !showingCarried;
    return filterIssueQueryResults(labelled, typedQuery, answeredLocally, searchingHosts);
  }, [
    filterKey,
    listData,
    ordered,
    querySettled,
    search.involvement,
    search.label,
    searchingHosts,
    showingCarried,
    typedQuery,
    viewers,
  ]);

  /**
   * The labels the rows on screen actually wear. Offered from what arrived rather than from a
   * read of every repository's label set: a label nothing here carries would filter to nothing.
   */
  const labelOptions = useMemo(() => {
    const known = ordered?.key === filterKey ? ordered.entries : (listData?.entries ?? []);
    const names = new Set(known.flatMap((entry) => entry.labels.map((label) => label.name)));
    if (search.label !== undefined) names.add(search.label);
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [filterKey, listData, ordered, search.label]);

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

  const groups = useMemo(() => {
    if (
      search.involvement !== "all" ||
      sort !== "updated" ||
      order !== "desc" ||
      typedQuery.length > 0
    ) {
      return [{ key: "others" as const, label: "", entries }];
    }
    // Until both partitions have answered, the snapshot's stand in — they are yesterday's
    // groups, but whole ones, where grouping the feed's first page locally loses every
    // authored row older than it. Once the live reads land they take over; with neither,
    // the local grouping is still better than nothing.
    const held =
      loaded !== null && loaded.environmentId === environmentId && loaded.scope === scopeKey
        ? loaded.partitions
        : undefined;
    const authored = partitionsWanted ? (authoredQuery.data?.entries ?? held?.authored) : undefined;
    const assigned = partitionsWanted ? (assignedQuery.data?.entries ?? held?.assigned) : undefined;
    if (authored === undefined || assigned === undefined) {
      return groupIssuesByInvolvement(entries, viewers);
    }
    // The label is narrowed here rather than on the hosts, so the partitions arrived without it.
    return partitionIssuesWithPriority(
      entries,
      authored,
      assigned,
      (entry) =>
        search.label === undefined ||
        entry.labels.some((entryLabel) => entryLabel.name === search.label),
    );
  }, [
    assignedQuery.data?.entries,
    authoredQuery.data?.entries,
    entries,
    environmentId,
    loaded,
    order,
    partitionsWanted,
    scopeKey,
    search.involvement,
    search.label,
    sort,
    typedQuery.length,
    viewers,
  ]);

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
        // a link that named its host opens the issue from the other one.
        (search.host === undefined ||
          sourceControlHostOf(
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
  const linkedSelection = useMemo(() => {
    if (!search.repository || !search.number || !selectedProjectId) return null;
    const provider =
      search.selectedProvider ??
      entries.find(
        (entry) =>
          entry.projectId === selectedProjectId &&
          entry.repository === search.repository &&
          entry.number === search.number,
      )?.provider;
    return {
      repository: search.repository,
      number: search.number,
      projectId: selectedProjectId,
      ...(provider === undefined ? {} : { provider }),
    };
  }, [entries, search.number, search.repository, search.selectedProvider, selectedProjectId]);
  useEffect(() => {
    if (!issuesSupported || rightPanelRef === null || linkedSelection === null) return;
    useRightPanelStore.getState().openIssue(rightPanelRef, linkedSelection);
  }, [issuesSupported, linkedSelection, rightPanelRef]);

  const selected =
    rightPanelState.isOpen && activeIssueSurface !== null
      ? {
          repository: activeIssueSurface.repository,
          number: activeIssueSurface.number,
          projectId: activeIssueSurface.projectId as ProjectId,
          ...(activeIssueSurface.provider === undefined
            ? {}
            : { provider: activeIssueSurface.provider }),
        }
      : null;

  // The URL's selection is an issue and is read back as one, so a change request tab leaves it
  // empty rather than naming a number this page would reopen as the issue of that number.
  const selectSurfaceInUrl = (surface: RightPanelSurface | null) =>
    updateSearch(
      surface?.kind === "issue"
        ? issueSelectionSearchPatch({
            ...surface,
            projectId: surface.projectId as ProjectId,
          })
        : clearedSelection,
    );

  const toggleRightPanel = () => {
    if (rightPanelRef === null) return;
    if (rightPanelState.isOpen) {
      useRightPanelStore.getState().close(rightPanelRef);
      updateSearch(clearedSelection);
      return;
    }
    if (selectedRightPanelSurface === null) return;
    useRightPanelStore.getState().show(rightPanelRef);
    selectSurfaceInUrl(selectedRightPanelSurface);
  };

  // The provider list is the workspace's hosts, not the filtered ones, so switching to a host
  // cannot make the switcher that got you there disappear.
  const [hosts, setHosts] = useState<IssueListResult["providers"]>([]);
  useEffect(() => {
    // Only from an answer to these filters. Rows carried over from the previous ones bring the
    // host summaries of the question they answered, and coming back from one host to all of them
    // would take the switcher's other hosts out of it on the strength of the narrowed answer.
    if (answered === null) return;
    // An unfiltered response is the full set. A filtered response replaces only its host, so
    // connection changes become visible without dropping every other provider from the menu.
    setHosts((previous) => mergeIssueProviderSummaries(previous, answered.providers, search.host));
  }, [answered, search.host]);
  const activeHosts = stabilizeLinearProviderSummary(
    hosts,
    currentProjectIds,
    linearSettings.projectBindings,
    hasCurrentLinearSource,
    linearSettings.projectTeams,
  ).filter((entry) => entry.configured);
  const showProvider = activeHosts.length > 1;

  /** Reported per project rather than as a count, so the reader can see which one it was. */
  const unavailableProjects = useMemo(
    () => new Map(listErrors.map((error) => [error.projectId, error.message] as const)),
    [listErrors],
  );

  // Stable so the memoized rows can skip re-rendering when the list around them changes.
  const selectEntry = useCallback(
    (entry: IssueListEntry) => {
      if (rightPanelRef === null) return;
      useRightPanelStore.getState().openIssue(rightPanelRef, entry);
      updateSearch({
        repository: entry.repository,
        number: entry.number,
        selectedProjectId: entry.projectId,
        selectedProvider: entry.provider,
      });
    },
    [rightPanelRef, updateSearch],
  );

  const toggleIssueSelection = useCallback(
    (entry: IssueListEntry) => {
      if (issueEnvironmentId === null) return;
      const error = toggleWorkItem({
        kind: "issue",
        provider: entry.provider,
        environmentId: issueEnvironmentId,
        projectId: entry.projectId,
        repository: entry.repository,
        number: entry.number,
        title: entry.title,
        url: entry.url,
      });
      if (error === "project")
        toastManager.add({ type: "warning", title: "Select items from one project" });
      if (error === "limit")
        toastManager.add({ type: "warning", title: "You can select up to 20 items" });
    },
    [issueEnvironmentId, toggleWorkItem],
  );

  const [creating, setCreating] = useState(false);
  const [linearDialogOpen, setLinearDialogOpen] = useState(false);
  const searchInput = (
    <ListSearchInput
      label="Search issues"
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
      rightPanelAvailable={selectedRightPanelSurface !== null}
      rightPanelOpen={rightPanelState.isOpen}
      rightPanelShortcutLabel={null}
      rightPanelUnavailableLabel="Select an issue first"
      liveAgentCount={0}
      onToggleTerminal={() => undefined}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const openPanelControls = (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
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
        <ListGhost rows={7} label="Loading issues" />
      ) : !issuesSupported ? (
        <IssuesUnavailableState
          title="Issues unavailable"
          error="Update this environment's T3 Code server to browse issues."
        />
      ) : firstLoad ? (
        <ListGhost rows={7} label="Loading issues" />
      ) : listQuery.error && listData === null ? (
        <IssuesUnavailableState error={listQuery.error} onRetry={() => listQuery.refresh()} />
      ) : carriedToNothing ? (
        <ListGhost rows={7} label="Loading issues" />
      ) : entries.length === 0 ? (
        <IssueListEmptyState
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
              {group.entries.map((entry) => {
                const selectionChecked =
                  issueEnvironmentId !== null &&
                  isWorkItemSelected(selectedWorkItems, {
                    kind: "issue",
                    provider: entry.provider,
                    environmentId: issueEnvironmentId,
                    projectId: entry.projectId,
                    repository: entry.repository,
                    number: entry.number,
                    title: entry.title,
                    url: entry.url,
                  });
                return (
                  <IssueRow
                    key={issueEntryKey(entry)}
                    entry={entry}
                    showProjectTitle
                    showProvider={showProvider}
                    reactionSort={sort}
                    selectionChecked={selectionChecked}
                    selected={isIssueEntryOpen(selected, entry)}
                    onSelect={selectEntry}
                    onToggleSelection={toggleIssueSelection}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}

      {listQuery.error && listData !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <span>The latest request failed. Showing the last issues loaded.</span>
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
  const hostMenuEntries = activeHosts.filter(
    (entry, index) => activeHosts.findIndex((other) => other.host === entry.host) === index,
  );
  const hostMenuOptions: ReadonlyArray<ListFilterOption<string>> = [
    { value: "", label: "All providers", Icon: LayersIcon },
    ...hostMenuEntries.map((entry) => {
      const presentation = getIssueProviderPresentation(entry.kind);
      const sharesKind = activeHosts.some((host) => host !== entry && host.kind === entry.kind);
      const sharesHost = activeHosts.some((host) => host !== entry && host.host === entry.host);
      return {
        value: entry.host,
        label: sharesKind || sharesHost ? entry.host : presentation.providerName,
        Icon: presentation.Icon,
      };
    }),
  ];
  const availableSortingHosts =
    scopedProjectId === undefined
      ? activeHosts
      : (answered?.providers.filter((entry) => entry.configured) ?? []);
  const sortingHosts = search.host
    ? availableSortingHosts.filter((entry) => entry.host === search.host)
    : availableSortingHosts;
  const githubSortingAvailable =
    sortingHosts.length > 0 && sortingHosts.every((entry) => entry.kind === "github");
  const filtersMenu = (
    <div className="flex shrink-0 items-center gap-1">
      <IssueFiltersMenu
        state={search.state}
        stateOptions={STATE_TABS}
        onState={(state) => updateListScope({ state })}
        involvement={search.involvement}
        involvementOptions={INVOLVEMENT_TABS}
        onInvolvement={(involvement) => updateListScope({ involvement })}
        hostFilter={{
          host: search.host,
          hostOptions: hostMenuOptions,
          onHost: (host) => updateListScope({ host, sort: undefined, order: undefined }),
          onManageLinear: () => setLinearDialogOpen(true),
          linearManaged,
        }}
        projectFilter={{
          environmentId,
          projects: scopedProjects,
          projectId: scopedProjectId,
          unavailable: unavailableProjects,
          onProject: (projectId) =>
            updateListScope({ projectId, sort: undefined, order: undefined }),
        }}
        label={search.label}
        labels={labelOptions}
        onLabel={(label) => updateListScope({ label })}
      />
      {githubSortingAvailable ? (
        <IssueSortMenu
          sort={sort}
          order={order}
          onSort={(nextSort) =>
            updateListScope({
              sort: nextSort === "updated" && sentQuery.length === 0 ? undefined : nextSort,
            })
          }
          onOrder={(nextOrder) =>
            updateListScope({ order: nextOrder === "desc" ? undefined : nextOrder })
          }
        />
      ) : null}
      <WorkItemSelectButton />
    </div>
  );
  const columnProps = {
    refreshing,
    onRefresh: () => void refreshFromHost(),
    searchValue: search.q ?? "",
    involvement: search.involvement,
    state: search.state,
    host: search.host,
    hostMenuOptions,
    hostMenuAction: {
      connected: linearManaged,
      onClick: () => setLinearDialogOpen(true),
    },
    onInvolvement: (involvement: IssueInvolvement) => updateListScope({ involvement }),
    onState: (state: IssueListState) => updateListScope({ state }),
    onHost: (host: string | undefined) =>
      updateListScope({ host, sort: undefined, order: undefined }),
    searchInput,
    filtersMenu,
    rightPanelControl: !issuesSupported || rightPanelState.isOpen ? null : panelToggleControls,
    rightPanelOpen: rightPanelState.isOpen,
    listBody,
  };

  const activateSurface = (surface: RightPanelSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().activateSurface(rightPanelRef, surface.id);
    selectSurfaceInUrl(surface);
  };
  const closeSurface = (surface: RightPanelSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurface(rightPanelRef, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      rightPanelRef,
    );
    selectSurfaceInUrl(next);
  };
  const closeOtherSurfaces = (surface: RightPanelSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeOtherSurfaces(rightPanelRef, surface.id);
    selectSurfaceInUrl(surface);
  };
  const closeSurfacesToRight = (surface: RightPanelSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurfacesToRight(rightPanelRef, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      rightPanelRef,
    );
    selectSurfaceInUrl(next);
  };
  const closeAllSurfaces = () => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeAllSurfaces(rightPanelRef);
    selectSurfaceInUrl(null);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {issuesSupported && rightPanelState.isOpen ? openPanelControls : null}
        <WorkItemSelectionBarHost>
          <IssuesColumn {...columnProps} />
        </WorkItemSelectionBarHost>

        {rightPanelState.isOpen && activeSurface && issueEnvironmentId !== null ? (
          <RightPanelTabs
            mode="inline"
            widthStorageKey="t3code:issue-panel-width"
            // Default to roughly half the viewport: an issue's conversation needs more room
            // than a chat, so the 540px chat-preview default squashes it. SSR has no window,
            // so fall back to a reasonable width.
            defaultWidth={typeof window === "undefined" ? 640 : Math.floor(window.innerWidth / 2)}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={activeSurface.id}
            pendingSurfaceIds={EMPTY_PENDING_SURFACES}
            previewSessions={EMPTY_PREVIEW_SESSIONS}
            desktopByTabId={EMPTY_PREVIEW_DESKTOP_STATE}
            terminalLabelsById={EMPTY_TERMINAL_LABELS}
            onActivate={activateSurface}
            onCloseSurface={closeSurface}
            onCloseOtherSurfaces={closeOtherSurfaces}
            onCloseSurfacesToRight={closeSurfacesToRight}
            onCloseAllSurfaces={closeAllSurfaces}
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddIssue={() => undefined}
            onAddAgents={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            issueAvailable={false}
            agentsAvailable={false}
            liveAgentCount={0}
            pullRequestStatuses={pullRequestTabStatuses}
            issueStatuses={issueTabStatuses}
          >
            {activeSurface.kind === "pull-request" ? (
              <PullRequestDetailPanel
                key={activeSurface.id}
                environmentId={issueEnvironmentId}
                reference={{
                  projectId: activeSurface.projectId as ProjectId,
                  repository: activeSurface.repository,
                  number: activeSurface.number,
                }}
                refreshToken={detailRefreshToken}
                // Merging or closing one of these can close the issue it was opened from, so the
                // list behind it is out of date the moment the host takes the action.
                onActed={() => {
                  refreshList();
                  baselineQuery.refresh();
                  authoredQuery.refresh();
                  assignedQuery.refresh();
                }}
                onStateChange={handlePullRequestTabStatusChange}
                onOpenLinkedIssue={(link) => {
                  const project = findProjectForLink(projects, link);
                  if (rightPanelRef === null || project === undefined) {
                    openLinkInBrowser(link.url);
                    return;
                  }
                  const target = {
                    projectId: project.id,
                    provider: link.provider,
                    repository: repositoryForProjectLink(project, link.repository),
                    number: link.number,
                  };
                  useRightPanelStore.getState().openIssue(rightPanelRef, target);
                  updateSearch({
                    repository: target.repository,
                    number: target.number,
                    selectedProjectId: target.projectId as ProjectId,
                    selectedProvider: target.provider,
                  });
                }}
              />
            ) : (
              <IssueDetailPanel
                key={activeSurface.id}
                environmentId={issueEnvironmentId}
                reference={{
                  projectId: activeSurface.projectId as ProjectId,
                  ...(activeSurface.provider === undefined
                    ? {}
                    : { provider: activeSurface.provider }),
                  repository: activeSurface.repository,
                  number: activeSurface.number,
                }}
                refreshToken={detailRefreshToken}
                // There is no thread behind this panel, so handing an issue to an agent starts
                // one rather than continuing whatever the reader last had open.
                handoffTarget={{ kind: "new-thread" }}
                // The change request that closes an issue is read beside it, as a peer tab in
                // this page's own panel: leaving for the pull requests page would take the issue
                // it answers off the screen.
                onOpenLinkedPullRequest={(link) => {
                  const project = findProjectForLink(projects, link);
                  if (rightPanelRef === null || project === undefined) {
                    openLinkInBrowser(link.url);
                    return;
                  }
                  useRightPanelStore.getState().openPullRequest(rightPanelRef, {
                    projectId: project.id,
                    repository: repositoryForProjectLink(project, link.repository),
                    number: link.number,
                  });
                  selectSurfaceInUrl(null);
                }}
                // Closing or reopening changes the row this panel was opened from, so the list
                // behind it is out of date the moment the host takes the action.
                onActed={() => {
                  refreshList();
                  baselineQuery.refresh();
                  authoredQuery.refresh();
                  assignedQuery.refresh();
                }}
                onStateChange={handleIssueTabStatusChange}
                chromeVariant="collapse"
              />
            )}
          </RightPanelTabs>
        ) : null}
      </div>

      {issueEnvironmentId === null ? null : (
        <>
          <IssueCreateDialog
            open={creating}
            onOpenChange={setCreating}
            environmentId={issueEnvironmentId}
            projects={scopedProjects}
            projectId={scopedProjectId}
            // Filed and then read: the new issue opens in the panel, and the list it was filed
            // from is a row out of date until the hosts are asked again.
            onCreated={(created) => {
              if (rightPanelRef !== null) {
                useRightPanelStore.getState().openIssue(rightPanelRef, created);
              }
              updateSearch(issueSelectionSearchPatch(created));
              refreshList();
              baselineQuery.refresh();
              authoredQuery.refresh();
              assignedQuery.refresh();
            }}
          />
          <LinearConnectionDialog
            open={linearDialogOpen}
            onOpenChange={setLinearDialogOpen}
            onProviderChanged={(change) => {
              if (change === "unavailable") {
                setHosts((current) => current.filter((entry) => entry.kind !== "linear"));
              }
              const shouldSelectLinear = change === "available" && linearProjectCount === 0;
              const shouldClearLinear = change === "unavailable" && search.host === "linear.app";
              if (shouldSelectLinear || shouldClearLinear) {
                void invalidateHost().then(() =>
                  updateListScope({
                    host: shouldSelectLinear ? "linear.app" : undefined,
                    sort: undefined,
                    order: undefined,
                  }),
                );
                return;
              }
              void refreshFromHost();
            }}
          />
        </>
      )}
    </SidebarInset>
  );
}

/**
 * A compact stand-in for one pill group: the trigger wears the current choice, the choices
 * live in a menu. Same options, same handler — only the footprint changes.
 */
export function CompactFilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
  action,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<ListFilterOption<Value>>;
  onChange: (value: Value) => void;
  action?: CompactFilterAction | undefined;
}) {
  const inlineLinearSettings =
    action?.connected === true && options.some((option) => option.value === "linear.app");
  return (
    <SharedCompactFilterMenu label={label} value={value} options={options} onChange={onChange}>
      {renderIssueProviderMenuRadioGroup({
        value,
        options,
        onChange: (next) => onChange(next as Value),
        ...(inlineLinearSettings ? { onManageLinear: action.onClick } : {}),
      })}
      {action && !inlineLinearSettings ? (
        <>
          <MenuSeparator />
          <MenuItem onClick={action.onClick}>
            <LinearIcon aria-hidden className="size-3.5" />
            {action.connected ? "Linear settings…" : "Connect Linear…"}
          </MenuItem>
        </>
      ) : null}
    </SharedCompactFilterMenu>
  );
}

/**
 * The issue list column. The full controls live at the top of the scroll flow; once they scroll
 * away, the title transforms into the scope itself — "Issues / Open ▾ Assigned ▾" — where each
 * segment is the menu for that filter, and a folded search sits on the right. Scrolled back up,
 * the topbar returns to the plain title. The topbar is the window drag region throughout; its
 * interactive children opt out through the `.drag-region` descendant rules.
 */
export function IssuesColumn({
  refreshing,
  onRefresh,
  searchValue,
  involvement,
  state,
  host,
  hostMenuOptions,
  hostMenuAction,
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
  involvement: IssueInvolvement;
  state: IssueListState;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<ListFilterOption<string>>;
  hostMenuAction: CompactFilterAction | undefined;
  onInvolvement: (involvement: IssueInvolvement) => void;
  onState: (state: IssueListState) => void;
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
  useListSearchShortcut({
    condensed,
    inFlowSearchRef,
    setSearchOpen,
    setSearchFocusToken,
  });
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
      <WorkspacePageHeader electron={isElectron} reserveNativeControls={!rightPanelOpen}>
        {condensed ? (
          <WorkspaceBreadcrumb ariaLabel="Issue scope">
            {/* The page name remains the foreground anchor in both states; the live filters are
                its compact scope, grouped as the second crumb rather than pretending each menu
                is a separate page in the hierarchy. */}
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Issues</h1>
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
              {hostMenuOptions.length > 2 || hostMenuAction !== undefined ? (
                <CompactFilterMenu
                  label="Filter by provider"
                  value={host ?? ""}
                  options={hostMenuOptions}
                  onChange={(next) => onHost(next === "" ? undefined : next)}
                  action={hostMenuAction}
                />
              ) : null}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        ) : (
          <WorkspaceBreadcrumb ariaLabel="Issues breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Issues</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        )}
        <div className="min-w-0 flex-1" />
        {condensed ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <ExpandableSearch
              label="Search issues"
              searchInput={searchInput}
              searchValue={searchValue}
              open={searchOpen}
              onOpenChange={setSearchOpen}
              focusToken={searchFocusToken}
              onFocusWithin={(focused) => {
                topbarSearchFocusedRef.current = focused;
              }}
            />
            <ListRefreshControl
              compact
              label="Refresh issues"
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          </div>
        ) : null}
        {rightPanelControl}
      </WorkspacePageHeader>

      <div
        ref={scrollRef}
        className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto [--topbar-scroll-fade-height:1.5rem] sm:[--topbar-scroll-fade-height:1.5rem]"
      >
        {/* The top padding is the fade band's own height (1.5rem here), the same pairing the
            settings page makes: at rest the controls sit fully below the mask, and only
            content actually passing under the chrome fades. */}
        <WorkspacePageContainer className="gap-4">
          <div className="flex flex-col gap-3">
            <div ref={inFlowSearchRef} className="flex items-center gap-2">
              {searchInput}
              {filtersMenu}
              {!condensed ? (
                <ListRefreshControl
                  label="Refresh issues"
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                />
              ) : null}
            </div>
            {/* Scrolled past this marker, the controls are gone and the title takes over. */}
            <div ref={markerRef} aria-hidden className="-mt-3 h-px w-full" />
          </div>

          {listBody}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}
