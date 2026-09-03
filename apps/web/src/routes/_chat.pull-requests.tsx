import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pullRequestHostOf, resolveEnvironmentMachineKind, ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListCursors,
  PullRequestListFilters,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListState,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownUpIcon,
  CalendarArrowDownIcon,
  CalendarArrowUpIcon,
  ChevronDownIcon,
  ClockIcon,
  EyeIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LayersIcon,
  ListChecksIcon,
  PenLineIcon,
  LoaderIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import {
  filterPullRequestsByInvolvement,
  findScopedProject,
  collectPullRequestListFacets,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  matchesPullRequestQuery,
  parsePullRequestQuery,
  narrowPullRequestsToFilters,
  mergePullRequestDiffStats,
  partitionPullRequestsWithPriority,
  pullRequestDiffStatKey,
  pullRequestEntryKey,
  pullRequestEntryViewer,
  rankPullRequestMatches,
  sortPullRequestGroups,
  pullRequestEnvironmentSetKey,
  readPullRequestListSnapshot,
  resolveProjectScope,
  resolveQueryEnvironmentIds,
  resolveSelectedEnvironmentId,
  withDiffStat,
  writePullRequestListSnapshot,
  scorePullRequestMatch,
  pullRequestStatsRefreshBatches,
  pullRequestStatsRequestBatches,
  retainVisiblePullRequestStatsBatches,
  type EnvironmentPullRequestEntry,
  type MergedPullRequestList,
  type PullRequestDiffStats,
  type PullRequestStatsBatch,
  type PullRequestStatsPolicy,
  type PullRequestStatsScope,
  type PullRequestPartitionsSnapshot,
} from "../components/pullRequest/pullRequestList.logic";
import {
  pullRequestListPreferences,
  type PullRequestListPreferencePatch,
  type PullRequestListPreferences,
  type PullRequestListSort,
  writePullRequestListPreferences,
} from "../components/pullRequest/pullRequestListPreferences";
import { assignProjectsToEnvironments } from "../components/pullRequest/pullRequestProjectAssignment.logic";
import { environmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import {
  PullRequestFiltersMenu,
  PullRequestFilterOptionIcon,
  PullRequestSearchInput,
  pullRequestHostLabel,
  pullRequestProjectKey,
  type PullRequestExpectedHost,
  type PullRequestFilterOption,
} from "../components/pullRequest/PullRequestListFilters";
import { PullRequestListEmptyState } from "../components/pullRequest/PullRequestListEmptyState";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { PullRequestRow } from "../components/pullRequest/PullRequestRow";
import { PullRequestsUnavailableState } from "../components/pullRequest/PullRequestsUnavailableState";
import { RightPanelTabs, type PullRequestTabStatusSeed } from "../components/RightPanelTabs";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls";
import { Button } from "../components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
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
import { useEnvironments } from "../state/environments";
import {
  pullRequestEnvironment,
  usePullRequestList,
  usePullRequestListStats,
  type EnvironmentQueryTarget,
} from "../state/pullRequests";
import { useAtomCommand } from "../state/use-atom-command";
import { cn } from "~/lib/utils";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

export interface PullRequestsSearch extends PullRequestListPreferences {
  /**
   * Narrows the list to one server. Absent means every connected one, which is the default the
   * page has now — so a link written before servers could be chosen still opens the whole list.
   */
  readonly environmentId?: EnvironmentId;
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
  /**
   * Which server the selected pull request was read from. A project id only names a project on
   * its own server, so this is what tells two servers holding one project apart. Optional: a
   * link without it still opens, resolved by project id alone where that is unambiguous.
   */
  readonly selectedEnvironmentId?: EnvironmentId;
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

const SORT_OPTIONS = [
  { value: "ready", label: "Merge readiness", Icon: ListChecksIcon },
  { value: "updated", label: "Recently updated", Icon: ClockIcon },
  { value: "newest", label: "Newest shown", Icon: CalendarArrowDownIcon },
  { value: "oldest", label: "Oldest shown", Icon: CalendarArrowUpIcon },
  { value: "largest", label: "Largest shown", Icon: Maximize2Icon },
  { value: "smallest", label: "Smallest shown", Icon: Minimize2Icon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListSort>>;

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
/**
 * A fixed sentinel, not a real server: the panel is one workspace-level surface list (each
 * surface already carries the server it was read from), so its store key must not move when a
 * capable server disconnects or reconnects. Real environment ids are server-generated UUIDs, so
 * this string can never collide with one.
 */
const PULL_REQUESTS_PANEL_ENVIRONMENT_ID = "pull-requests-panel" as EnvironmentId;
/** Stable so a read that is not wanted right now does not re-key on every render. */
const NO_LIST_TARGETS: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>> = [];
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_PREVIEW_DESKTOP_STATE = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const EMPTY_PENDING_SURFACES = new Set<string>();
const MAX_SEARCH_LABEL_CANDIDATES = 100;

function pullRequestSearchLabels(raw: unknown): Partial<Pick<PullRequestsSearch, "labels">> {
  const values = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).slice(
    0,
    MAX_SEARCH_LABEL_CANDIDATES,
  );
  const labels: Array<string> = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim().slice(0, 200);
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) continue;
    labels.push(value);
    seen.add(key);
    if (labels.length === 10) break;
  }
  return labels.length === 0 ? {} : { labels };
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (raw: Record<string, unknown>): PullRequestsSearch => ({
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state:
      raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open",
    ...(SORT_OPTIONS.some((option) => option.value === raw.sort)
      ? { sort: raw.sort as PullRequestListSort }
      : {}),
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.host === "string" && raw.host ? { host: raw.host.slice(0, 200) } : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.selectedEnvironmentId === "string" && raw.selectedEnvironmentId
      ? { selectedEnvironmentId: raw.selectedEnvironmentId as EnvironmentId }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
    ...(raw.draft === "only" || raw.draft === "hide" ? { draft: raw.draft } : {}),
    ...(raw.review === "approved" ||
    raw.review === "changes-requested" ||
    raw.review === "review-required" ||
    raw.review === "none"
      ? { review: raw.review }
      : {}),
    ...(raw.checks === "passing" || raw.checks === "failing" ? { checks: raw.checks } : {}),
    ...(typeof raw.author === "string" && raw.author.trim()
      ? { author: raw.author.trim().slice(0, 200) }
      : {}),
    ...pullRequestSearchLabels(raw.labels),
  }),
  component: PullRequestsRouteView,
});

function PullRequestsRouteView() {
  const search = Route.useSearch();
  const sort = search.sort ?? "ready";
  const statsPolicy: PullRequestStatsPolicy =
    sort === "ready" || sort === "largest" || sort === "smallest" ? "eager" : "visible";
  const navigate = useNavigate({ from: Route.fullPath });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { environments } = useEnvironments();
  // Every connected environment that has said it can list pull requests. Sorted, so the query
  // keys, the scope key and the stored snapshot all read the same whichever order the
  // connections happened to come up in.
  const capableEnvironments = useMemo(
    () =>
      environments
        .filter(
          (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
        )
        .toSorted((left, right) => left.environmentId.localeCompare(right.environmentId)),
    [environments],
  );
  // The server the URL asks for, kept only while it is one the page could read: a link naming a
  // server this workspace no longer has falls back to all of them rather than to nothing.
  const scopedEnvironmentId =
    capableEnvironments.find((environment) => environment.environmentId === search.environmentId)
      ?.environmentId ?? null;
  // Every server this workspace has ever heard of, connecting or not — wider than
  // `capableEnvironments`, which only holds the ones ready to answer.
  const knownEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const environmentIds = useMemo(
    () =>
      capableEnvironments
        .filter(
          (environment) =>
            scopedEnvironmentId === null || environment.environmentId === scopedEnvironmentId,
        )
        .map((environment) => environment.environmentId),
    [capableEnvironments, scopedEnvironmentId],
  );
  const environmentKey = useMemo(
    () => pullRequestEnvironmentSetKey(environmentIds),
    [environmentIds],
  );
  // An environment may still be connecting, or may predate this feature. Until at least one has
  // reported, an empty set means "not known yet" rather than "no environment can", and the page
  // waits rather than telling a reader to upgrade a server that has not spoken.
  const capabilityKnown = environments.some((environment) => environment.serverConfig !== null);
  const pullRequestsSupported = environmentIds.length > 0;
  const allProjects = useProjects();
  // Whether the workspace has said what it holds yet. Until it has, an empty project list is
  // "not loaded" rather than "none", and telling a reader to add a project they already have is
  // the one wrong answer the empty state can give.
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  // Only the projects the page can actually read: one on an environment that cannot list pull
  // requests could neither be listed nor acted on.
  const projects = useMemo(
    () => allProjects.filter((project) => environmentIds.includes(project.environmentId)),
    [allProjects, environmentIds],
  );
  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const scopedProjects = useMemo(() => {
    // Two machines can hold the same repository, so a title the workspace carries twice is told
    // apart by the environment it lives on rather than left as two identical rows.
    const titleCounts = new Map<string, number>();
    for (const project of projects) {
      titleCounts.set(project.title, (titleCounts.get(project.title) ?? 0) + 1);
    }
    return projects
      .map((project) => ({
        id: project.id,
        environmentId: project.environmentId,
        title:
          (titleCounts.get(project.title) ?? 0) > 1
            ? `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
            : project.title,
        workspaceRoot: project.workspaceRoot,
        faviconPath: project.faviconPath ?? null,
        projectIcon: project.projectIcon ?? null,
      }))
      .toSorted((left, right) => left.title.localeCompare(right.title));
  }, [environmentLabels, projects]);
  // The scope the URL asks for, once the environments have had their say about whether it exists.
  const scopedProjectId = useMemo(
    () => resolveProjectScope(search.projectId, projects, projectsKnown),
    [projects, projectsKnown, search.projectId],
  );
  const scopedProject = useMemo(
    () => findScopedProject(projects, scopedEnvironmentId, scopedProjectId),
    [projects, scopedEnvironmentId, scopedProjectId],
  );

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

  // The selection is resolved the same way the scope is: an id no connected environment has can
  // never be read here, and one that arrived before the projects did is not yet wrong.
  const linkedProjectId = useMemo(
    () => resolveProjectScope(search.selectedProjectId, projects, projectsKnown),
    [projects, projectsKnown, search.selectedProjectId],
  );
  // The scope filter stands in as a last resort: a link can carry `projectId` with a repository
  // whose identity the inference above cannot match, and refusing to open it because of the
  // weaker signal would ignore the stronger one the URL spelled out.
  const selectedProjectId = linkedProjectId ?? projectIdForRepository ?? scopedProjectId;
  // Which server the selection belongs to. Named by the URL where a link had one to give;
  // otherwise the project id decides, and only where exactly one server has that project.
  // A named server still connecting is kept named rather than falling back: falling back while
  // it is merely not ready yet would resolve the project against whatever other server has
  // answered, which can be the wrong one where two servers share a project id. Only a name this
  // workspace has never heard of falls back to the scope above, the same way that scope treats a
  // stale name — a saved link naming a server that has since gone would otherwise open nothing,
  // even where the project id it also carries names exactly one remaining server.
  const selectedEnvironmentId = resolveSelectedEnvironmentId(
    search.selectedEnvironmentId,
    knownEnvironmentIds,
    scopedEnvironmentId,
  );
  const selectedProject = useMemo(
    () => findScopedProject(projects, selectedEnvironmentId, selectedProjectId),
    [projects, selectedEnvironmentId, selectedProjectId],
  );
  // One panel for the page rather than one per server: the surfaces carry the server they were
  // read from, so tabs from two of them sit side by side instead of replacing each other. Its ref
  // uses a fixed sentinel environment, not whichever server happens to sort first, so the tab
  // strip survives a capable server disconnecting or losing the pull-requests capability.
  const rightPanelRef = useMemo(
    () =>
      capableEnvironments.length === 0
        ? null
        : scopeThreadRef(PULL_REQUESTS_PANEL_ENVIRONMENT_ID, PULL_REQUESTS_PANEL_ID),
    [capableEnvironments.length],
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
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const rightPanelPresenceValue = useMemo(
    () => ({
      activeSurface: selectedPullRequestSurface,
      surfaces: rightPanelState.surfaces,
    }),
    [rightPanelState.surfaces, selectedPullRequestSurface],
  );
  const rightPanelPresence = usePanelPresence(
    rightPanelState.isOpen && selectedPullRequestSurface !== null,
    rightPanelPresenceValue,
    panelAnimationsActive,
    rightPanelRef === null ? null : PULL_REQUESTS_PANEL_ID,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  const renderedPullRequestSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  // The open tab names its own server; a link that arrived before any tab was opened names it
  // through the project it selected.
  const panelEnvironmentId =
    (renderedPullRequestSurface?.environmentId as EnvironmentId | undefined) ??
    selectedProject?.environmentId ??
    null;
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
            ...(next.sort && next.sort !== "ready" ? { sort: next.sort } : {}),
            ...(next.repository ? { repository: next.repository } : {}),
            ...(next.number ? { number: next.number } : {}),
            ...(next.projectId ? { projectId: next.projectId } : {}),
            ...(next.environmentId ? { environmentId: next.environmentId } : {}),
            ...(next.host ? { host: next.host } : {}),
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
      }),
    [navigate],
  );

  const clearedSelection = {
    repository: undefined,
    number: undefined,
    selectedProjectId: undefined,
    selectedEnvironmentId: undefined,
  };
  // List controls change the rows behind the detail, not the independent selected surface. The
  // reader can keep working in that panel while narrowing, sorting, or switching projects.
  const updateListScope = (patch: PullRequestListPreferencePatch) => {
    const currentPreferences = pullRequestListPreferences({
      ...search,
      ...patch,
      involvement: patch.involvement ?? search.involvement,
      state: patch.state ?? search.state,
    });
    // Opening a selected-only link does not save its default all/open list. Once a list control
    // changes, the entire visible scope is intentional and becomes the next sidebar destination.
    writePullRequestListPreferences(currentPreferences);
    updateSearch(patch);
  };

  // Searching asks the hosts, which takes a round trip, so the text is held for a moment before
  // it is sent. Until it lands, the rows already on screen are narrowed locally: the answer is
  // late but the page is not.
  const typedQuery = (search.q ?? "").trim();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sentQuery = useDebouncedValue(typedQuery, SEARCH_DEBOUNCE_MS);
  const querySettled = typedQuery === sentQuery;
  // What was typed, split into the qualifiers the hosts can act on and the words that are left.
  // The URL keeps the line as it was written; only the request sees the two halves.
  const typedParsed = useMemo(() => parsePullRequestQuery(typedQuery), [typedQuery]);
  const sentParsed = useMemo(() => parsePullRequestQuery(sentQuery), [sentQuery]);

  // One record for the hosts, rebuilt only when the URL's own fields change so the listing
  // inputs stay identical between renders.
  const menuFilters = useMemo(
    (): PullRequestListFilters => ({
      ...(search.draft ? { draft: search.draft } : {}),
      ...(search.review ? { review: search.review } : {}),
      ...(search.checks ? { checks: search.checks } : {}),
      ...(search.author ? { author: search.author } : {}),
      ...(search.labels ? { labels: search.labels.map((label) => [label]) } : {}),
    }),
    [search.author, search.checks, search.draft, search.labels, search.review],
  );
  const menuFiltered = Object.keys(menuFilters).length > 0;
  // A typed qualifier wins over the menu's own answer for the same thing, since it is the more
  // recent word on it, including a typed author or label over its menu counterpart.
  const filters = useMemo(
    (): PullRequestListFilters => ({ ...menuFilters, ...sentParsed.filters }),
    [menuFilters, sentParsed.filters],
  );
  const hasFilters = Object.keys(filters).length > 0;
  /** The same narrowings the moment they are typed, for the rows already on screen. */
  const localFilters = useMemo(
    (): PullRequestListFilters => ({ ...menuFilters, ...typedParsed.filters }),
    [menuFilters, typedParsed.filters],
  );
  const hasLocalFilters = Object.keys(localFilters).length > 0;
  // Scoping to a project scopes to the server that owns it, saving every other server a read
  // that could only answer with nothing. Where an id is ambiguous — two servers holding the
  // same project id, with no server named — only the servers that actually hold that id are
  // asked: a server without it may still hold an unrelated project of its own under the same
  // string, and asking it would return that project's rows rather than an honest empty answer.
  const queryEnvironmentIds = useMemo(
    () =>
      resolveQueryEnvironmentIds(
        environmentIds,
        projects,
        scopedProject,
        scopedProjectId,
        projectsKnown,
      ),
    [environmentIds, projects, projectsKnown, scopedProject, scopedProjectId],
  );
  /**
   * Which projects each server is asked about. Two servers holding the same repository would both
   * list the same pull requests, so each repository is listed by one of them — the first, which is
   * where the page's actions land — and the others are asked only for what is theirs alone. A
   * server left with nothing of its own is not read at all.
   *
   * Left alone while the projects are still arriving, and while the scope is a single project:
   * that path deliberately asks both servers holding an ambiguous id.
   */
  const environmentQueries = useMemo((): ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }> => {
    const plain = queryEnvironmentIds.map((environmentId) => ({ environmentId }));
    if (!projectsKnown || scopedProjectId !== undefined) return plain;
    const assignment = assignProjectsToEnvironments(
      projects,
      queryEnvironmentIds,
      queryEnvironmentIds[0],
    );
    const totals = new Map<EnvironmentId, number>();
    for (const project of projects) {
      totals.set(project.environmentId, (totals.get(project.environmentId) ?? 0) + 1);
    }
    return queryEnvironmentIds.flatMap((environmentId) => {
      const projectIds = assignment.get(environmentId);
      if (projectIds === undefined) return [];
      // It lists everything it holds anyway, so the filter is left off and a one-server workspace
      // asks exactly the question it asked before.
      if (projectIds.length === (totals.get(environmentId) ?? 0)) return [{ environmentId }];
      return [{ environmentId, projectIds }];
    });
  }, [projects, projectsKnown, queryEnvironmentIds, scopedProjectId]);
  // Part of the scope, since a different split is a different question and its answers must not
  // be filed under the same page state.
  const assignmentKey = useMemo(
    () =>
      environmentQueries
        .map(({ environmentId, projectIds }) => `${environmentId}#${projectIds?.join("+") ?? "*"}`)
        .join("|"),
    [environmentQueries],
  );
  // Page size is view state, not a URL concern: a shared link should open the first page.
  const scopeKey = `${environmentKey}:${assignmentKey}:${search.state}:${search.involvement}:${scopedProjectId ?? ""}:${search.host ?? ""}:${search.draft ?? ""}:${search.review ?? ""}:${search.checks ?? ""}:${search.author ?? ""}:${search.labels?.join("\u0000") ?? ""}`;
  const filterKey = `${scopeKey}:${sentQuery}`;
  const statsScopeRef = useRef<PullRequestStatsScope>({ key: filterKey, policy: statsPolicy });
  statsScopeRef.current = { key: filterKey, policy: statsPolicy };
  // Where the next slice carries on from, per repository within each environment, as that
  // environment handed it back. Sending it is what makes a second page cost a second page rather
  // than the whole list again — and a repository it does not name has run out and is not read a
  // second time. An environment absent from it has nothing more to give at all.
  const [page, setPage] = useState<{
    key: string;
    size: number;
    cursors: Readonly<Record<string, PullRequestListCursors>> | null;
    /**
     * The environments read again from the top at the larger page rather than continued. An
     * environment can say it has more without saying where to carry on from — its provider has
     * no cursor to give — and a continuation naming only the others would strand its rows on
     * the host forever.
     */
    regrown: ReadonlyArray<string>;
  }>({ key: filterKey, size: PAGE_SIZE, cursors: null, regrown: [] });
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const sentCursors = page.key === filterKey ? page.cursors : null;
  const sentRegrown = page.key === filterKey ? page.regrown : [];

  // Typing a search, or clearing one, starts the list again at its first page. Without this the
  // paging state from before the search is still filed under these filters and comes back with
  // it, so clearing would return to the slice that had been scrolled to rather than to the list.
  useEffect(() => {
    setPage({ key: filterKey, size: PAGE_SIZE, cursors: null, regrown: [] });
  }, [filterKey]);

  /** The listing input each environment is asked for, which differs only in its continuation. */
  const listTargets = useMemo(
    () =>
      environmentQueries.flatMap(({ environmentId, projectIds }) => {
        const cursors = sentCursors?.[environmentId];
        // A continuation asks the environments that said where to carry on from, plus the ones
        // that have more to give but no cursor to give it from — those are read again at the
        // larger page. The rest have run out, and re-reading them would answer with the page
        // that is already on screen.
        if (sentCursors !== null && cursors === undefined && !sentRegrown.includes(environmentId)) {
          return [];
        }
        return [
          {
            environmentId,
            input: {
              state: search.state,
              // The hosts narrow by involvement themselves — GitHub by author and review
              // request, and so on — so asking them is the difference between a page of results
              // and a page of everything with the answer somewhere further down it.
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
      }),
    [
      filters,
      hasFilters,
      pageSize,
      environmentQueries,
      scopedProjectId,
      search.host,
      search.involvement,
      search.state,
      sentCursors,
      sentRegrown,
      sentParsed.text,
    ],
  );
  const listQuery = usePullRequestList(listTargets);

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
  const baselineTargets = useMemo(
    () =>
      environmentQueries.map(({ environmentId, projectIds }) => ({
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
      })),
    [
      menuFiltered,
      menuFilters,
      environmentQueries,
      scopedProjectId,
      search.host,
      search.involvement,
      search.state,
    ],
  );
  const baselineQuery = usePullRequestList(baselineTargets);
  const facetTargets = useMemo(() => {
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
  }, [environmentQueries, filtersOpen, scopedProjectId, search.host, search.involvement]);
  const facetQuery = usePullRequestList(facetTargets);
  // The priority groups' own reads. The feed below is paginated by recency, so an older authored
  // or review-requested row can be missing from its first page; partitioned from these
  // server-filtered reads instead, the priority view is complete up front and a continuation can
  // only ever append below what is already on screen. A search re-ranks the whole list by match,
  // so no partitions are read for one. These are the same atoms the Authored and Reviewing tabs
  // ask for, so switching to either is answered from cache.
  const partitionsWanted = search.involvement === "all" && typedQuery.length === 0;
  // Built together so the two reads share one memo, and in the same field order the feed's own
  // input uses: the atoms are keyed by their input, so the Authored tab then reads this answer.
  const partitionTargets = useMemo(() => {
    // The main list goes first. Besides putting the visible rows on screen sooner, it proves
    // which repositories the host search indexes, so an empty partition does not trigger the
    // expensive per-repository fallback. With no rows at all both partitions are already empty.
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
  }, [
    menuFiltered,
    menuFilters,
    partitionsWanted,
    baselineQuery.data,
    environmentQueries,
    scopedProjectId,
    search.host,
    search.state,
  ]);
  const authoredQuery = usePullRequestList(partitionTargets.authored);
  const reviewingQuery = usePullRequestList(partitionTargets.reviewing);
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
    const requestedStatsScope = statsScopeRef.current;
    setInvalidating(true);
    try {
      // Every environment the page is reading, since what the reader pressed refresh for is the
      // list in front of them rather than whichever machine happens to be first.
      await Promise.all(
        queryEnvironmentIds.map((environmentId) => invalidate({ environmentId, input: {} })),
      );
    } finally {
      setInvalidating(false);
    }
    refreshList();
    baselineQuery.refresh();
    facetQuery.refresh();
    authoredQuery.refresh();
    reviewingQuery.refresh();
    const visible = visibleStatsKeys.current;
    const batches = pullRequestStatsRefreshBatches({
      requestedScope: requestedStatsScope,
      currentScope: statsScopeRef.current,
      entriesByKey: entriesByStatsKey.current,
      candidateKeys: visible.key === requestedStatsScope.key ? visible.values : new Set(),
      statsByRow: statsByRowRef.current,
    });
    if (batches !== null) {
      setStatsTargetState({ key: requestedStatsScope.key, batches });
      statsQuery.refresh(batches.map(({ environmentId, input }) => ({ environmentId, input })));
    }
    setDetailRefreshToken((token) => token + 1);
  };
  const refreshing = invalidating || listQuery.isPending;

  // Every page size and every search is its own query, and a new one starts empty. The last
  // answer for these filters is held so the page grows and narrows in place rather than blanking
  // out: a longer page reads as growth, and a search shows the rows it already has, narrowed
  // here, until the hosts answer for themselves.
  const [loaded, setLoaded] = useState<{
    environmentKey: string;
    scope: string;
    query: string;
    data: MergedPullRequestList;
    /** The priority groups' own answers, carried so a cold start has whole groups too. */
    partitions?: PullRequestPartitionsSnapshot;
  } | null>(null);
  // A longer page is the same list with more on the end, so the rows already read stay where
  // they were read: each answer is merged onto the last rather than replacing it, and anything
  // new lands at the bottom. Only a different question — other filters, another search — starts
  // the order again. Declared here, ahead of the snapshot write below, so that write can read
  // this round's accumulation rather than only its own slice.
  const [ordered, setOrdered] = useState<{
    key: string;
    entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  } | null>(null);
  // A reload recreates the registry the queries live in, so with nothing held the page would
  // cold-start into skeletons even though almost every row is unchanged. The last answer for
  // this set of environments is kept across reloads and hydrated here as the carried rows: they
  // render at once — narrowed to the current filters like any carried answer — and the live read
  // reconciles them in place by key rather than replacing them with ghosts.
  useEffect(() => {
    if (environmentKey.length === 0) return;
    setLoaded((current) => {
      // Rows read from a different set of environments cannot even be narrowed — one of them may
      // no longer be connected at all — so that set's own snapshot beats holding them.
      if (current !== null && current.environmentKey === environmentKey) return current;
      const snapshot = readPullRequestListSnapshot(
        typeof window === "undefined" ? undefined : window.localStorage,
        environmentKey,
      );
      if (snapshot === null) return null;
      return {
        environmentKey,
        scope: snapshot.scope,
        query: "",
        data: snapshot.data,
        ...(snapshot.partitions === undefined ? {} : { partitions: snapshot.partitions }),
      };
    });
  }, [environmentKey]);
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
              current.environmentKey === environmentKey &&
              current.scope === scopeKey
            ? current.partitions
            : undefined;
      // A search's answer is the search's, not the workspace's, so only unsearched lists
      // persist. Written here where the held partitions are in reach, so a feed settling
      // ahead of them cannot overwrite a stored snapshot that already had both groups.
      //
      // What is written is what the reader is actually looking at, not this round's own
      // answer: a continuation only asks the environments still paging, so its answer alone is
      // missing both the rows read on earlier pages and the hosts of whichever environment had
      // already run out of cursors. `ordered` carries the accumulated rows, and the baseline
      // read — which never drops an environment for lack of a cursor — carries the full hosts.
      if (environmentKey.length > 0 && sentQuery.length === 0) {
        const accumulatedEntries = ordered?.key === filterKey ? ordered.entries : data.entries;
        writePullRequestListSnapshot(
          typeof window === "undefined" ? undefined : window.localStorage,
          environmentKey,
          {
            scope: scopeKey,
            data: {
              ...data,
              entries: accumulatedEntries,
              viewers: baselineQuery.data?.viewers ?? data.viewers,
              providers: baselineQuery.data?.providers ?? data.providers,
            },
            ...(partitions === undefined ? {} : { partitions }),
          },
        );
      }
      return {
        environmentKey,
        scope: scopeKey,
        query: sentQuery,
        data,
        ...(partitions === undefined ? {} : { partitions }),
      };
    });
  }, [
    environmentKey,
    scopeKey,
    sentQuery,
    listQuery.data,
    listQuery.isPending,
    partitionsWanted,
    authoredQuery.data,
    reviewingQuery.data,
    ordered,
    filterKey,
    baselineQuery.data,
  ]);
  // Changing a filter asks a question nothing has answered yet, and the page is already holding
  // perfectly good rows for the last one. Rather than blank out for the round trip, those rows
  // are narrowed to the new filters and stay until the answer lands — a subset of it, never a
  // row it excludes. Narrowed to nothing there is nothing to carry, and the skeletons below are
  // right after all. Rows read from a different set of environments are dropped rather than
  // narrowed: one of those environments may no longer be connected.
  const narrowed = useMemo(() => {
    if (loaded === null || loaded.environmentKey !== environmentKey || loaded.scope === scopeKey) {
      return null;
    }
    const entries = narrowPullRequestsToFilters(loaded.data.entries, {
      state: search.state,
      projectId: scopedProjectId,
      host: search.host,
    });
    return entries.length === 0 ? null : { ...loaded.data, entries };
  }, [environmentKey, loaded, scopeKey, scopedProjectId, search.host, search.state]);
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

  // `ordered` is declared above, ahead of the snapshot write, but grown here from this round's
  // own answer.
  useEffect(() => {
    if (!answered) return;
    setOrdered((previous) => {
      if (previous === null || previous.key !== filterKey) {
        return {
          key: filterKey,
          entries: rankPullRequestMatches(answered.entries, sentParsed.text),
        };
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
          sentParsed.text,
        );
        return { key: filterKey, entries: [...previous.entries, ...appended] };
      }
      // A whole-page answer replaces the order outright. Positions used to be inherited so the
      // list would not shift under a reader, but inheriting them filed a pull request opened
      // since the last read at the bottom of the page — below rows a week older — where "the
      // latest" is exactly what a refresh was for. The host answers in the order the page
      // reads, so its order stands; a row that moved was updated, and moving is the news.
      return { key: filterKey, entries: rankPullRequestMatches(answered.entries, sentParsed.text) };
    });
  }, [answered, filterKey, sentCursors, sentParsed.text]);

  // Carrying on where the last answer stopped, and only raising the page size for the hosts that
  // could not say where that was.
  // From this question's own answer, never from the rows being held while it travels: a
  // continuation is a boundary in one listing, and carrying one across a search would ask the
  // new question to start where the old one stopped — skipping its newest matches entirely.
  const nextCursors = answered?.nextCursors ?? {};
  // The environments with more rows and no cursor to reach them by. They come along with any
  // continuation, read again at a page one step larger, which is the only way they grow.
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
      });
      return;
    }
    setPage({
      key: filterKey,
      size: Math.min(pageSize + PAGE_SIZE, MAX_PAGE_SIZE),
      cursors: null,
      regrown: [],
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
      regrown: [],
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
      authoredQuery.refresh();
      reviewingQuery.refresh();
    },
    { enabled: pullRequestsSupported },
  );

  const viewers = baselineQuery.data?.viewers ?? listData?.viewers ?? EMPTY_VIEWERS;
  const listErrors = baselineQuery.data?.errors ?? listData?.errors ?? [];
  const facets = useMemo(
    () =>
      collectPullRequestListFacets(
        [
          ...(facetQuery.data?.entries ?? []),
          ...(baselineQuery.data?.entries ?? listData?.entries ?? []),
        ],
        search.state,
      ),
    [baselineQuery.data?.entries, facetQuery.data?.entries, listData?.entries, search.state],
  );

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
    // The rows the hosts could not narrow themselves, for the fields a row actually carries:
    // a host with no filter of its own answers unnarrowed, and so does one whose answer for the
    // new filters has not arrived yet. Checks are absent here, because no row carries them.
    const narrowedEntries = hasLocalFilters
      ? involvementEntries.filter((entry) =>
          matchesPullRequestFilters(entry, localFilters, pullRequestEntryViewer(entry, viewers)),
        )
      : involvementEntries;
    // Newest update first once nothing is typed, so a list merged from several hosts reads in
    // one order rather than in each host's. With a search on, the relevance ranking above is
    // the order, and re-sorting by date here would undo it.
    if (typedParsed.text.length === 0) {
      return narrowedEntries.toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    }
    const answeredLocally = querySettled && !showingCarried;
    return narrowedEntries.filter(
      (entry) =>
        (answeredLocally && searchingHosts.has(entry.host)) ||
        matchesPullRequestQuery(entry, typedParsed.text),
    );
  }, [
    filterKey,
    hasLocalFilters,
    localFilters,
    listData,
    ordered,
    querySettled,
    search.involvement,
    searchingHosts,
    showingCarried,
    typedParsed.text,
    viewers,
  ]);

  // Seed the first tab paint from list rows while each tab's cached detail read lands.
  const listedPullRequestTabStatuses = useMemo<Record<string, PullRequestTabStatusSeed>>(
    () =>
      Object.fromEntries(
        entries.map((entry) => [
          pullRequestSurfaceId(entry),
          {
            state: entry.state,
            isDraft: entry.isDraft,
          },
        ]),
      ),
    [entries],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
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
      { root: scrollRef.current, rootMargin: "240px" },
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
      loaded !== null && loaded.environmentKey === environmentKey && loaded.scope === scopeKey
        ? loaded.partitions
        : undefined;
    // The priority reads answer the same question the feed does, so they take the same local
    // narrowing: a host that cannot filter for itself would otherwise put rows into Authored
    // that the filters above just took out of the feed.
    const narrow = (rows: ReadonlyArray<EnvironmentPullRequestEntry> | undefined) =>
      rows === undefined || !hasLocalFilters
        ? rows
        : rows.filter((entry) =>
            matchesPullRequestFilters(entry, localFilters, pullRequestEntryViewer(entry, viewers)),
          );
    const authored = narrow(
      partitionsWanted ? (authoredQuery.data?.entries ?? held?.authored) : undefined,
    );
    const reviewing = narrow(
      partitionsWanted ? (reviewingQuery.data?.entries ?? held?.reviewing) : undefined,
    );
    if (authored === undefined || reviewing === undefined) {
      return groupPullRequestsByInvolvement(entries, viewers);
    }
    return partitionPullRequestsWithPriority(entries, authored, reviewing);
  }, [
    hasLocalFilters,
    localFilters,
    authoredQuery.data?.entries,
    entries,
    environmentKey,
    loaded,
    partitionsWanted,
    reviewingQuery.data?.entries,
    scopeKey,
    search.involvement,
    viewers,
  ]);

  // Date sorts keep optional line-count reads near the viewport. Size sorts need every loaded
  // count before their order is final. Received counts stay cached across both policies.
  const entriesByStatsKey = useRef<ReadonlyMap<string, EnvironmentPullRequestEntry>>(new Map());
  entriesByStatsKey.current = new Map(
    groups.flatMap((group) =>
      group.entries.map((entry) => [pullRequestEntryKey(entry), entry] as const),
    ),
  );
  const visibleStatsKeys = useRef({ key: filterKey, values: new Set<string>() });
  const [statsByRow, setStatsByRow] = useState<PullRequestDiffStats>(() => new Map());
  const statsByRowRef = useRef(statsByRow);
  statsByRowRef.current = statsByRow;
  const [statsTargetState, setStatsTargetState] = useState<{
    readonly key: string;
    readonly batches: ReadonlyArray<PullRequestStatsBatch>;
  }>({ key: filterKey, batches: [] });
  const statsBatches = statsTargetState.key === filterKey ? statsTargetState.batches : [];
  const statsTargets = useMemo(
    () =>
      statsBatches.map(({ environmentId, input }) => ({
        environmentId,
        input,
      })),
    [statsBatches],
  );
  const statsObserver = useRef<IntersectionObserver | null>(null);
  const statsRows = useRef(new Set<HTMLButtonElement>());
  const statsPending = useRef(true);
  const statsPolicyRef = useRef(statsPolicy);
  statsPolicyRef.current = statsPolicy;
  const registerStatsRow = useCallback((node: HTMLButtonElement | null) => {
    if (node === null || typeof IntersectionObserver === "undefined") return;
    statsRows.current.add(node);
    statsObserver.current?.observe(node);
    return () => {
      statsRows.current.delete(node);
      statsObserver.current?.unobserve(node);
      const key = node.dataset.pullRequestStatsKey;
      const visible = visibleStatsKeys.current;
      if (
        statsPolicyRef.current !== "visible" ||
        key === undefined ||
        !visible.values.delete(key) ||
        statsPending.current
      ) {
        return;
      }
      setStatsTargetState((current) => {
        if (current.key !== visible.key) return current;
        const batches = retainVisiblePullRequestStatsBatches(current.batches, visible.values);
        return batches.length === current.batches.length ? current : { key: current.key, batches };
      });
    };
  }, []);
  useEffect(() => {
    if (statsPolicy !== "eager") return;
    setStatsTargetState((current) => {
      const batches = current.key === filterKey ? current.batches : [];
      const added = pullRequestStatsRequestBatches({
        entriesByKey: entriesByStatsKey.current,
        candidateKeys: visibleStatsKeys.current.values,
        policy: statsPolicy,
        activeBatches: batches,
        statsByRow: statsByRowRef.current,
      });
      if (added.length === 0 && current.key === filterKey) return current;
      return { key: filterKey, batches: [...batches, ...added] };
    });
  }, [filterKey, groups, statsPolicy]);
  useEffect(() => {
    if (statsPolicy !== "visible" || typeof IntersectionObserver === "undefined") return;
    visibleStatsKeys.current = { key: filterKey, values: new Set() };
    const observer = new IntersectionObserver(
      (observed) => {
        const visible = visibleStatsKeys.current;
        if (visible.key !== filterKey) return;
        let changed = false;
        const entered = new Set<string>();
        for (const item of observed) {
          const key = (item.target as HTMLElement).dataset.pullRequestStatsKey;
          if (key === undefined) continue;
          const wasVisible = visible.values.has(key);
          if (item.isIntersecting && entriesByStatsKey.current.has(key)) {
            visible.values.add(key);
            if (!wasVisible) entered.add(key);
          } else {
            visible.values.delete(key);
          }
          changed ||= wasVisible !== visible.values.has(key);
        }
        if (!changed) return;
        setStatsTargetState((current) => {
          const batches = current.key === filterKey ? current.batches : [];
          const retained = statsPending.current
            ? batches
            : retainVisiblePullRequestStatsBatches(batches, visible.values);
          const added = pullRequestStatsRequestBatches({
            entriesByKey: entriesByStatsKey.current,
            candidateKeys: entered,
            policy: statsPolicy,
            activeBatches: batches,
            statsByRow: statsByRowRef.current,
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
  const statsQuery = usePullRequestListStats(statsTargets);
  statsPending.current = statsQuery.isPending;
  useEffect(() => {
    if (statsPolicy !== "visible" || statsQuery.isPending) return;
    const visible = visibleStatsKeys.current;
    setStatsTargetState((current) => {
      if (current.key !== filterKey || visible.key !== filterKey) return current;
      const batches = retainVisiblePullRequestStatsBatches(current.batches, visible.values);
      return batches.length === current.batches.length ? current : { key: current.key, batches };
    });
  }, [filterKey, statsPolicy, statsQuery.isPending]);
  // Adding or removing one row keys a fresh stats query with nothing in it yet, so the counts
  // are merged into what is already held rather than rebuilt: every count on screen stays until
  // its replacement arrives.
  useEffect(() => {
    const stats = statsQuery.stats;
    if (stats === null) return;
    setStatsByRow((previous) => mergePullRequestDiffStats(previous, stats));
  }, [statsQuery.stats]);
  const displayGroups = useMemo(() => {
    const enriched = groups.map((group) => ({
      ...group,
      entries: group.entries.map((entry) => withDiffStat(entry, statsByRow)),
    }));
    // Searching keeps its relevance order and priority groups unless the reader explicitly asks
    // for another sort. The readiness queue is the default browse order, not a way to bury a
    // closer text match.
    return sortPullRequestGroups(
      enriched,
      sort,
      typedParsed.text,
      (entry) =>
        entry.additions + entry.deletions > 0 || statsByRow.has(pullRequestDiffStatKey(entry)),
    );
  }, [groups, sort, statsByRow, typedParsed.text]);

  const linkedSelection = useMemo(
    () =>
      search.repository && search.number && selectedProject
        ? {
            environmentId: selectedProject.environmentId,
            repository: search.repository,
            number: search.number,
            projectId: selectedProject.id,
          }
        : null,
    [search.number, search.repository, selectedProject],
  );
  const rightPanelAvailable = selectedPullRequestSurface !== null;
  useEffect(() => {
    if (!pullRequestsSupported || rightPanelRef === null || linkedSelection === null) return;
    useRightPanelStore.getState().openPullRequest(rightPanelRef, linkedSelection);
  }, [linkedSelection, pullRequestsSupported, rightPanelRef]);

  const selected =
    rightPanelState.isOpen && activePullRequestSurface !== null
      ? {
          environmentId: activePullRequestSurface.environmentId,
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
            ...(surface.environmentId === undefined
              ? {}
              : { selectedEnvironmentId: surface.environmentId as EnvironmentId }),
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
    () =>
      new Map(
        listErrors.map(
          (error) =>
            [
              pullRequestProjectKey({ id: error.projectId, environmentId: error.environmentId }),
              error.message,
            ] as const,
        ),
      ),
    [listErrors],
  );

  // Stable so the memoized rows can skip re-rendering when the list around them changes.
  const selectEntry = useCallback(
    (entry: EnvironmentPullRequestEntry) => {
      // The surface carries the row's own server, which is what its detail reads and acts on.
      if (rightPanelRef === null) return;
      useRightPanelStore.getState().openPullRequest(rightPanelRef, entry);
      updateSearch({
        repository: entry.repository,
        number: entry.number,
        selectedProjectId: entry.projectId,
        selectedEnvironmentId: entry.environmentId,
      });
    },
    [rightPanelRef, updateSearch],
  );

  const searchInput = (
    <PullRequestSearchInput
      value={search.q ?? ""}
      busy={typedQuery.length > 0 && (!querySettled || showingCarried)}
      onChange={(query) => updateListScope({ q: query || undefined })}
    />
  );
  const panelToggleControls = (
    <PanelLayoutControls
      showTerminalControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      rightPanelAvailable={rightPanelAvailable}
      rightPanelOpen={rightPanelState.isOpen}
      rightPanelShortcutLabel={null}
      rightPanelUnavailableLabel="Select a pull request first"
      liveAgentCount={0}
      onToggleTerminal={() => undefined}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const openPanelControls = (
    <div
      // The bare workspace-titlebar-controls inset plus mr-px: the same
      // anchor the thread view's controls and the sidebar trigger use, so
      // every titlebar cluster in the app sits one shared inset from its
      // edge.
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
        <PullRequestListGhost rows={7} />
      ) : !pullRequestsSupported ? (
        <PullRequestsUnavailableState
          title="Pull requests unavailable"
          error="Update your T3 Code servers to browse pull requests."
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
            menuFiltered ||
            search.state !== "open" ||
            search.involvement !== "all" ||
            scopedProjectId !== undefined ||
            search.host !== undefined
          }
          searching={typedQuery.length > 0 && (!querySettled || showingCarried)}
          canLoadMore={listData?.truncated === true && (canContinue || pageSize < MAX_PAGE_SIZE)}
          loadingMore={loadingMore}
          onClearQuery={() => updateListScope({ q: undefined })}
          onLoadMore={loadMore}
        />
      ) : (
        <div className="space-y-3">
          {displayGroups.map((group) => (
            <div key={group.key} className="space-y-0.5">
              {group.label ? (
                <h2 className="px-3 pb-0.5 text-xs font-medium text-muted-foreground/70">
                  {group.label}
                </h2>
              ) : null}
              {group.entries.map((entry) => {
                const entryKey = pullRequestEntryKey(entry);
                return (
                  <PullRequestRow
                    key={entryKey}
                    statsKey={entryKey}
                    statsRef={registerStatsRow}
                    entry={entry}
                    showProjectTitle
                    showProvider={showProvider}
                    {...(capableEnvironments.length > 1 &&
                    environmentLabels.get(entry.environmentId) !== undefined
                      ? { environmentLabel: environmentLabels.get(entry.environmentId)! }
                      : {})}
                    // Ten is the floor the ranking gives a row whose own fields say nothing
                    // about the search: the host matched something this row cannot show.
                    matchedElsewhere={
                      typedParsed.text.length > 0 &&
                      scorePullRequestMatch(entry, typedParsed.text) <= MATCHED_ELSEWHERE_SCORE
                    }
                    selected={
                      selected?.environmentId === entry.environmentId &&
                      selected.repository === entry.repository &&
                      selected.number === entry.number
                    }
                    onSelect={selectEntry}
                  />
                );
              })}
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
  // The same shape the host pills take, so the two groups read as one control. Each server
  // wears the machine it runs on.
  const serverMenuOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: "", label: "All servers", Icon: LayersIcon },
    ...capableEnvironments.map((environment) => ({
      value: environment.environmentId,
      label: environment.label,
      Icon: environmentMachineIcon(resolveEnvironmentMachineKind(environment.serverConfig)),
    })),
  ];
  const sortMenu = (
    <CompactFilterMenu
      label="Sort pull requests"
      triggerIcon={<ArrowDownUpIcon aria-hidden className="size-4" />}
      triggerLabel="Sort"
      outlined
      value={sort}
      options={SORT_OPTIONS}
      onChange={(next) => updateListScope({ sort: next })}
    />
  );
  const filtersMenu = (
    <PullRequestFiltersMenu
      onOpenChange={setFiltersOpen}
      state={search.state}
      stateOptions={STATE_TABS}
      onState={(state) => updateListScope({ state })}
      involvement={search.involvement}
      involvementOptions={INVOLVEMENT_TABS}
      onInvolvement={(involvement) => updateListScope({ involvement })}
      filters={menuFilters}
      onFilters={(next) =>
        updateListScope({
          draft: next.draft,
          review: next.review,
          checks: next.checks,
          author: next.author,
          labels: next.labels?.flatMap((group) => group),
        })
      }
      authorOptions={facets.authors}
      labelOptions={facets.labels}
      host={search.host}
      hostOptions={hostMenuOptions}
      onHost={(host) => updateListScope({ host })}
      server={scopedEnvironmentId ?? undefined}
      serverOptions={serverMenuOptions}
      // Narrowing to one server drops a project scope belonging to another, which would
      // otherwise narrow the list to nothing with no visible filter to explain it.
      onServer={(server) => updateListScope({ environmentId: server, projectId: undefined })}
      projects={scopedProjects}
      projectId={scopedProjectId}
      projectEnvironmentId={scopedProject?.environmentId}
      unavailable={unavailableProjects}
      // The environment comes along with the project it belongs to, so a duplicate id on
      // another server never gets narrowed to by mistake; picking "All projects" leaves the
      // server scope as it was rather than clearing it.
      onProject={(projectId, environmentId) =>
        updateListScope(environmentId === undefined ? { projectId } : { projectId, environmentId })
      }
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
    sortMenu,
    filtersMenu,
    rightPanelControl:
      // Footprint reserve while the panel is closed: the toggle itself stays
      // mounted at the fixed titlebar inset in both states so it cannot move
      // on toggle, and this spacer keeps refresh from sliding underneath it
      // (sized per header padding so refresh ends a normal gap short of it).
      !pullRequestsSupported ? null : (
        <span
          aria-hidden
          className={cn(
            "shrink-0",
            rightPanelState.isOpen ? "-ml-3 w-0" : "w-7 sm:w-5",
            panelAnimationsActive && "transition-[width,margin] ease-out",
          )}
          style={
            panelAnimationsActive
              ? { transitionDuration: `${panelAnimationDurationMs}ms` }
              : undefined
          }
        />
      ),
    titlebarControls:
      // While the panel is closed the strip lives inside the header: a no-drag
      // descendant beats the header's desktop drag-region, where a floating
      // sibling loses (app-region hit-testing ignores z-index). While the
      // floating strip crosses the header during motion, the narrow extension
      // keeps that overlap non-draggable without moving the toggle.
      pullRequestsSupported ? (
        rightPanelPresent ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-full w-7 [-webkit-app-region:no-drag]"
          />
        ) : (
          openPanelControls
        )
      ) : null,
    rightPanelOpen: rightPanelState.isOpen,
    listBody,
    scrollRef,
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

  // This page has no ChatView, so the shared panel handles `rightPanel.close`
  // itself. With nothing open the event falls through to its native meaning.
  const closeActiveSurfaceFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (activePullRequestSurface === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) closeSurface(activePullRequestSurface);
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command === "rightPanel.close") closeActiveSurfaceFromShortcut(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {pullRequestsSupported && rightPanelPresent ? openPanelControls : null}
        <PullRequestsColumn {...columnProps} />

        {rightPanelPresent && renderedPullRequestSurface && panelEnvironmentId !== null ? (
          <RightPanelTabs
            mode="inline"
            open={rightPanelState.isOpen}
            widthStorageKey="t3code:pull-request-panel-width"
            // Default to roughly half the viewport: the PR list needs more
            // room than a chat, so the 540px chat-preview default squashes
            // it. SSR has no window, so fall back to a reasonable width.
            defaultWidth={typeof window === "undefined" ? 640 : Math.floor(window.innerWidth / 2)}
            surfaces={renderedRightPanelSurfaces}
            environmentId={panelEnvironmentId}
            activeSurfaceId={renderedPullRequestSurface.id}
            pendingSurfaceIds={EMPTY_PENDING_SURFACES}
            previewSessions={EMPTY_PREVIEW_SESSIONS}
            desktopByTabId={EMPTY_PREVIEW_DESKTOP_STATE}
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
            onAddBrowserInProfile={() => undefined}
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
            pullRequestStatusSeeds={listedPullRequestTabStatuses}
          >
            <PullRequestDetailPanel
              key={renderedPullRequestSurface.id}
              environmentId={panelEnvironmentId}
              reference={{
                projectId: renderedPullRequestSurface.projectId as ProjectId,
                repository: renderedPullRequestSurface.repository,
                number: renderedPullRequestSurface.number,
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
            />
          </RightPanelTabs>
        ) : null}
      </div>
    </SidebarInset>
  );
}

/** A compact stand-in for one pill group when the header is narrow. */
function CompactFilterMenu<Value extends string>({
  label,
  triggerIcon,
  triggerLabel,
  outlined = false,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  triggerIcon?: ReactNode;
  triggerLabel?: string;
  outlined?: boolean;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
  className?: string;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={triggerLabel ? `${label}: ${current.label}` : label}
        render={outlined ? <Button variant="outline" /> : undefined}
        className={
          outlined
            ? className
            : cn(
                "inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                className,
              )
        }
      >
        {triggerLabel ? (
          <>
            {triggerIcon}
            <span>{triggerLabel}</span>
          </>
        ) : (
          <>
            <span className="truncate">{current.label}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-40">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
          {options.map((option) => {
            const item = (
              <MenuRadioItem
                key={option.value}
                value={option.value}
                disabled={option.unavailable !== undefined}
                className="data-disabled:pointer-events-auto"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <PullRequestFilterOptionIcon option={option} />
                  {option.label}
                </span>
              </MenuRadioItem>
            );
            return option.unavailable === undefined ? (
              item
            ) : (
              <Tooltip key={option.value}>
                <TooltipTrigger render={item} />
                <TooltipPopup side="right" className="max-w-64 break-words">
                  {option.unavailable}
                </TooltipPopup>
              </Tooltip>
            );
          })}
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
        className="w-56 min-w-24 shrink"
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
  sortMenu,
  filtersMenu,
  rightPanelControl,
  titlebarControls,
  rightPanelOpen,
  listBody,
  scrollRef,
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
  sortMenu: ReactNode;
  filtersMenu: ReactNode;
  rightPanelControl: ReactNode;
  titlebarControls: ReactNode;
  rightPanelOpen: boolean;
  listBody: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
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
  const searchExpanded = searchOpen || searchValue.length > 0;
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
      {/* A closed right panel leaves this column full-width, so the shared header
          reserves native window controls and hosts the controls strip itself: on
          desktop the header is a drag-region, and only a no-drag descendant wins
          clicks from it - a floating sibling loses to app-region hit-testing no
          matter its z-index. While the panel is open, the strip mounts back at
          the route level, whose box spans the panel too, so the toggle keeps one
          fixed top-right anchor. */}
      <WorkspacePageHeader
        electron={isElectron}
        reserveNativeControls={!rightPanelOpen}
        className="relative bg-background"
      >
        {titlebarControls}
        {condensed ? (
          <WorkspaceBreadcrumb ariaLabel="Pull request scope" className="overflow-hidden">
            {/* An expanded search owns the scarce horizontal space. The page title stays
                available to readers while the live filters remain available in both states. */}
            <WorkspaceBreadcrumbItem current className={cn(searchExpanded && "sr-only")}>
              <h1 className="truncate">Pull Requests</h1>
            </WorkspaceBreadcrumbItem>
            {searchExpanded ? null : <WorkspaceBreadcrumbSeparator />}
            <WorkspaceBreadcrumbItem className="shrink gap-1.5">
              <CompactFilterMenu
                label="Filter by state"
                value={state}
                options={STATE_TABS}
                onChange={onState}
                className="shrink-0"
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
          <div className="flex shrink items-center gap-1.5">
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
            <PullRequestRefreshControl compact refreshing={refreshing} onRefresh={onRefresh} />
          </div>
        ) : null}
        {rightPanelControl}
      </WorkspacePageHeader>

      <div
        ref={scrollRef}
        className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      >
        {/* The top padding is the shared fade band's height, the same pairing the
            settings page makes: at rest the controls sit fully below the mask, and only
            content actually passing under the chrome fades. */}
        <WorkspacePageContainer width="expanded" className="gap-4">
          <div className="flex flex-col gap-3">
            <div ref={inFlowSearchRef} className="flex items-center gap-2">
              {searchInput}
              {sortMenu}
              {filtersMenu}
              {!condensed ? (
                <PullRequestRefreshControl refreshing={refreshing} onRefresh={onRefresh} />
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

function PullRequestRefreshControl({
  compact = false,
  refreshing,
  onRefresh,
}: {
  compact?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      size={compact ? "icon-sm" : "icon"}
      variant={compact ? "ghost" : "outline"}
      aria-label="Refresh pull requests"
      onClick={onRefresh}
      disabled={refreshing}
    >
      <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
    </Button>
  );
}
