import { useAtomValue } from "@effect/atom-react";
import {
  continueIssueListPage,
  createIssueSourceRefreshQueue,
  readIssueListSourcePage,
  issueEntryKey,
  issueListCursorsOn,
  issueScopeKey,
  offeredIssueInvolvements,
  refreshIssueListPage,
} from "@t3tools/client-runtime/state/issues";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListCursors,
  IssueListEntry,
  IssueListInput,
  IssueListResult,
  IssueListState,
  IssueScopeRef,
  IssueTrackerKind,
  IssueTrackerSummary,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { issueScopeKeyOf, pullRequestHostOf } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AtSignIcon,
  CircleCheckIcon,
  FolderGit2Icon,
  LayersIcon,
  PenLineIcon,
  Plug2Icon,
  PlusIcon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { IssueCreateDialog, type IssueCreateScope } from "~/components/issue/IssueCreateDialog";
import { IssueDetailPanel } from "~/components/issue/IssueDetailPanel";
import {
  IssueRow,
  type EnvironmentIssueEntry,
  type IssueRowTarget,
} from "~/components/issue/IssueRow";
import {
  issueListPreferences,
  writeIssueListPreferences,
  type IssueListPreferences,
} from "~/components/issue/issueListPreferences";
import { IssueGlyph, issueTrackerPresentation } from "~/components/issue/issuePresentation";
import {
  issueCreateSources,
  issueFilterProjects,
  issuePanelEnvironmentId,
  issueListProjectScope,
  issueListRefreshSource,
  type IssueListSources,
} from "~/components/issue/issueProjectFilter.logic";
import { PullRequestDetailPanel } from "~/components/pullRequest/PullRequestDetailPanel";
import { readableFailure } from "~/components/pullRequest/pullRequestDetail.logic";
import { findScopedProject } from "~/components/pullRequest/pullRequestList.logic";
import { PullRequestListGhost } from "~/components/pullRequest/PullRequestGhosts";
import {
  PullRequestFilterOptionIcon,
  PullRequestSearchInput,
  pullRequestProjectKey,
  type PullRequestFilterOption,
} from "~/components/pullRequest/PullRequestListFilters";
import { pullRequestFilterProjects } from "~/components/pullRequest/pullRequestProjectFilter.logic";
import { PullRequestsUnavailableState } from "~/components/pullRequest/PullRequestsUnavailableState";
import { RightPanelTabs } from "~/components/RightPanelTabs";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { PanelLayoutControls } from "~/components/chat/PanelLayoutControls";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { SidebarInset } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { isElectron } from "~/env";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { usePanelAnimationSettings, usePanelPresence } from "~/panelAnimations";
import {
  ISSUES_PANEL_REF,
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type PullRequestSurface,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "~/state/entities";
import { useEnvironments, useIssuesSupported } from "~/state/environments";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { issueEnvironment, useIssueList, type IssueListTarget } from "~/state/issues";
import { useDebouncedValue } from "~/state/queries";
import { primaryServerKeybindingsAtom } from "~/state/server";

export interface IssuesSearch extends IssueListPreferences {
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedProjectId?: ProjectId;
  readonly selectedHost?: string;
  readonly tracker?: string;
  readonly scope?: string;
  readonly key?: string;
}

const STATE_TABS = [
  { value: "open", label: "Open", Icon: IssueGlyph.issue },
  { value: "closed", label: "Closed", Icon: CircleCheckIcon },
  { value: "all", label: "All", Icon: LayersIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueListState>>;

const INVOLVEMENT_TABS = [
  { value: "all", label: "Everyone", Icon: UsersIcon },
  { value: "assigned", label: "Assigned to me", Icon: UserCheckIcon },
  { value: "authored", label: "Opened by me", Icon: PenLineIcon },
  { value: "mentioned", label: "Mentioning me", Icon: AtSignIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueInvolvement>>;

const PAGE_SIZE = 50;
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_RECORD = {} as const;
const EMPTY_MAP = new Map<string, string>();

function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

const bounded = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
/** A search key that is either present as a string or absent, never present as undefined. */
function present<K extends string, V extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Record<string, unknown>): IssuesSearch => ({
    who:
      raw.who === "assigned" || raw.who === "authored" || raw.who === "mentioned" ? raw.who : "all",
    status: raw.status === "closed" || raw.status === "all" ? raw.status : "open",
    ...present("host", bounded(raw.host)),
    ...present<"environmentId", EnvironmentId>("environmentId", bounded(raw.environmentId)),
    ...present<"projectId", ProjectId>("projectId", bounded(raw.projectId)),
    // Always an own key: the router lays this over the parent route's unvalidated search.
    q: bounded(raw.q),
    ...present<"selectedEnvironmentId", EnvironmentId>(
      "selectedEnvironmentId",
      bounded(raw.selectedEnvironmentId),
    ),
    ...present<"selectedProjectId", ProjectId>("selectedProjectId", bounded(raw.selectedProjectId)),
    ...present("selectedHost", bounded(raw.selectedHost)),
    ...present("tracker", bounded(raw.tracker)),
    ...present("scope", bounded(raw.scope)),
    ...present("key", bounded(raw.key)),
  }),
  component: IssuesRoute,
});

/** Rows from every environment that answered, with any continuation pages laid over them. */
interface HeldPage {
  readonly answer: IssueListResult;
  readonly entries: ReadonlyArray<IssueListEntry>;
  readonly nextCursors: IssueListCursors;
  readonly firstCursors: IssueListCursors;
  readonly firstKeys: ReadonlySet<string>;
  readonly errors: IssueListResult["errors"];
  readonly sources?: IssueListResult["sources"];
  readonly restartSources?: ReadonlyArray<IssueScopeRef>;
}

function trackerKey(tracker: Pick<IssueTrackerSummary, "tracker" | "host">): string {
  return `${tracker.tracker} ${tracker.host.toLowerCase()}`;
}

function IssuesRoute() {
  const navigate = useNavigate({ from: "/issues" });
  const search = Route.useSearch();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const issuesSupported = useIssuesSupported();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEscapeToGoBack();

  useEffect(() => {
    writeIssueListPreferences(issueListPreferences(search));
  }, [search]);

  const capableEnvironments = useMemo(
    () =>
      environments.filter(
        (environment) => environment.serverConfig?.environment.capabilities.issues === true,
      ),
    [environments],
  );
  const environmentLabels = useMemo(
    () => new Map(environments.map((e) => [e.environmentId, e.label] as const)),
    [environments],
  );

  const capableProjects = useMemo(
    () =>
      projects.filter((project) =>
        capableEnvironments.some((e) => e.environmentId === project.environmentId),
      ),
    [projects, capableEnvironments],
  );
  const projectScope = useMemo(
    () =>
      issueListProjectScope(
        capableProjects,
        { projectId: search.projectId, environmentId: search.environmentId },
        projectsKnown,
      ),
    [capableProjects, search.projectId, search.environmentId, projectsKnown],
  );
  const scopedProject = projectScope === "waiting" ? null : projectScope;
  const listedEnvironments = useMemo(
    () =>
      projectScope === "waiting"
        ? []
        : capableEnvironments.filter(
            (e) => projectScope === null || e.environmentId === projectScope.environmentId,
          ),
    [capableEnvironments, projectScope],
  );

  const debouncedQuery = useDebouncedValue(search.q ?? "", 300);
  const baseInput = useMemo<IssueListInput>(
    () => ({
      state: search.status,
      involvement: search.who,
      ...(scopedProject ? { projectId: scopedProject.id } : {}),
      ...(search.host ? { host: search.host } : {}),
      ...(debouncedQuery ? { query: debouncedQuery } : {}),
    }),
    [search.status, search.who, scopedProject, search.host, debouncedQuery],
  );
  const filterKey = JSON.stringify([listedEnvironments.map((e) => e.environmentId), baseInput]);
  const [paging, setPaging] = useState<{
    readonly key: string;
    readonly pages: ReadonlyMap<EnvironmentId, HeldPage>;
  }>({ key: filterKey, pages: new Map() });
  const filterKeyRef = useRef(filterKey);
  const current = paging.key === filterKey ? paging : null;
  const targets = useMemo<ReadonlyArray<IssueListTarget>>(
    () =>
      listedEnvironments.map((e) => ({
        environmentId: e.environmentId,
        input: { ...baseInput, limit: PAGE_SIZE },
      })),
    [listedEnvironments, baseInput],
  );
  const list = useIssueList(targets);
  const [refreshedPages] = useState(() => new WeakMap<HeldPage, HeldPage>());
  const held = useMemo(() => {
    const refreshed = (previous: HeldPage, answer: IssueListResult) => {
      const cached = refreshedPages.get(previous);
      if (cached?.answer === answer) return cached;
      const page = { ...refreshIssueListPage(cached ?? previous, answer), answer };
      refreshedPages.set(previous, page);
      return page;
    };
    const next = new Map<EnvironmentId, HeldPage>();
    for (const [environmentId, answer] of list.answers) {
      const previous = current?.pages.get(environmentId);
      next.set(
        environmentId,
        previous === undefined
          ? {
              answer,
              entries: answer.entries,
              nextCursors: answer.nextCursors,
              firstCursors: answer.nextCursors,
              firstKeys: new Set(answer.entries.map(issueEntryKey)),
              errors: answer.errors,
              sources: answer.sources,
            }
          : previous.answer === answer
            ? previous
            : refreshed(previous, answer),
      );
    }
    for (const [environmentId, page] of current?.pages ?? []) {
      if (!next.has(environmentId)) next.set(environmentId, page);
    }
    return next;
  }, [list.answers, current, refreshedPages]);
  const [knownSources] = useState(() => new Map<EnvironmentId, IssueListSources>());
  const filterProjects = useMemo(() => {
    if (projectScope === null && baseInput.host === undefined) {
      for (const [environmentId, page] of held) {
        if (page.sources !== undefined) knownSources.set(environmentId, page.sources);
      }
    }
    return pullRequestFilterProjects(
      issueFilterProjects(capableProjects, knownSources, scopedProject),
      environmentLabels,
      scopedProject ?? undefined,
      true,
    );
  }, [
    held,
    projectScope,
    baseInput.host,
    scopedProject,
    capableProjects,
    knownSources,
    environmentLabels,
  ]);
  const heldRef = useRef(held);
  useEffect(() => {
    heldRef.current = held;
  }, [held]);

  useLiveRefresh(list.refresh, { key: filterKey });

  const storePage = (
    key: string,
    environmentId: EnvironmentId,
    update: (page: HeldPage) => HeldPage,
  ) =>
    setPaging((previous) => {
      if (key !== filterKeyRef.current) return previous;
      const base = previous.key === key ? previous : { key, pages: new Map() };
      const stored = base.pages.get(environmentId);
      const rendered = heldRef.current.get(environmentId);
      const latest = stored !== undefined && stored.answer === rendered?.answer ? stored : rendered;
      if (latest === undefined) return previous;
      const pages = new Map(base.pages);
      pages.set(environmentId, update(latest));
      return { ...base, pages };
    });

  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const loadMore = async (environmentId: EnvironmentId, host: string, tracker: string) => {
    const page = held.get(environmentId);
    const cursors = page ? issueListCursorsOn(page.nextCursors, host, tracker) : {};
    if (!page || Object.keys(cursors).length === 0 || loadingMore !== null) return;
    const key = filterKey;
    setLoadingMore(`${environmentId} ${tracker} ${host}`);
    const result = await loadPage({
      environmentId,
      input: { ...baseInput, limit: PAGE_SIZE, cursors },
    });
    setLoadingMore(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "More issues could not be read",
        description: readableFailure(squashAtomCommandFailure(result), "The server refused it."),
      });
      return;
    }
    storePage(key, environmentId, (latest) =>
      continueIssueListPage(latest, cursors, result.value, page.firstCursors),
    );
  };

  const [queueSourceRefresh] = useState(createIssueSourceRefreshQueue);
  const sourceWrites = useRef(new Map<string, { revision: number; removed: Set<string> }>());
  const sourceRevision = useRef(0);
  useEffect(() => {
    filterKeyRef.current = filterKey;
    sourceWrites.current.clear();
  }, [filterKey, filterKeyRef]);
  const refreshSource = async (
    environmentId: EnvironmentId,
    source: IssueScopeRef,
    removedKey?: string,
  ) => {
    const key = filterKey;
    const lane = JSON.stringify([
      key,
      issueScopeKey(environmentId, { ...source, host: source.host ?? "" }),
    ]);
    const previous = sourceWrites.current.get(lane);
    const write = { revision: ++sourceRevision.current, removed: new Set(previous?.removed) };
    if (removedKey !== undefined) write.removed.add(removedKey);
    sourceWrites.current.set(lane, write);
    const isCurrentWrite = () =>
      key === filterKeyRef.current && sourceWrites.current.get(lane)?.revision === write.revision;
    return queueSourceRefresh(lane, async function readSource() {
      if (!isCurrentWrite()) return;
      const page = heldRef.current.get(environmentId);
      const canonical = issueListRefreshSource(
        environmentId,
        listedEnvironments.map((environment) => environment.environmentId),
        baseInput,
        source,
        page,
      );
      if (canonical === null) return;
      if (!page || canonical.host === undefined) {
        list.refresh();
        return;
      }
      const scope = {
        projectId: canonical.projectId,
        tracker: canonical.tracker,
        host: canonical.host,
        scope: canonical.scope,
      };
      const query = issueEnvironment.list({
        environmentId,
        input: { ...baseInput, limit: PAGE_SIZE },
      });
      const read = await readIssueListSourcePage(appAtomRegistry, query, () =>
        loadPage({
          environmentId,
          input: {
            ...baseInput,
            projectId: canonical.projectId,
            host: canonical.host,
            limit: PAGE_SIZE,
          },
        }),
      );
      if (read.result._tag === "Failure" || !isCurrentWrite()) return;
      const result = read.result.value;
      if (!read.isCurrent()) {
        void queueSourceRefresh(lane, readSource);
        return;
      }
      storePage(key, environmentId, (latest) => {
        if (!isCurrentWrite()) return latest;
        if (!read.isCurrent()) {
          void queueSourceRefresh(lane, readSource);
          return latest;
        }
        const refreshed = refreshIssueListPage(latest, result, {
          source: scope,
          removed: new Set([...write.removed].map((key) => issueEntryKey({ ...scope, key }))),
        });
        if (
          !result.errors.some(
            (error) =>
              error.projectId === scope.projectId &&
              (error.tracker === undefined || error.tracker === scope.tracker) &&
              (error.host === undefined || error.host.toLowerCase() === scope.host.toLowerCase()),
          )
        )
          sourceWrites.current.set(lane, { revision: write.revision, removed: new Set() });
        return { ...refreshed, answer: read.answer ?? latest.answer };
      });
    });
  };
  const [restarted] = useState(() => new WeakSet<HeldPage>());
  useEffect(() => {
    for (const [environmentId, page] of current?.pages ?? []) {
      if (restarted.has(page)) continue;
      restarted.add(page);
      for (const source of page.restartSources ?? []) void refreshSource(environmentId, source);
    }
  });

  // Rows grouped per tracker account, so a tracker that cannot be read says so where its rows
  // would be, and each tracker's rows carry on from their own cursors.
  const groups = useMemo(() => {
    const byTracker = new Map<
      string,
      {
        tracker: IssueTrackerSummary;
        rows: EnvironmentIssueEntry[];
        errors: Array<IssueListResult["errors"][number] & { environmentId: EnvironmentId }>;
        more: EnvironmentId[];
      }
    >();
    const groupOf = (tracker: string, host: string) =>
      byTracker.get(`${tracker} ${host.toLowerCase()}`);
    const needle = debouncedQuery.toLowerCase();
    for (const [environmentId, page] of held) {
      for (const tracker of page.answer.trackers) {
        const key = trackerKey(tracker);
        if (!byTracker.has(key)) byTracker.set(key, { tracker, rows: [], errors: [], more: [] });
        const group = byTracker.get(key)!;
        if (!group.tracker.configured && tracker.configured) group.tracker = tracker;
        if (
          Object.keys(issueListCursorsOn(page.nextCursors, tracker.host, tracker.tracker)).length >
          0
        )
          group.more.push(environmentId);
      }
      for (const entry of page.entries) {
        const key = trackerKey(entry);
        const group = byTracker.get(key);
        if (!group) continue;
        // A tracker that cannot search is narrowed here instead.
        if (
          needle.length > 0 &&
          group.tracker.capabilities?.search !== true &&
          !entry.title.toLowerCase().includes(needle) &&
          !entry.displayKey.toLowerCase().includes(needle)
        )
          continue;
        group.rows.push({ ...entry, environmentId });
      }
      for (const error of page.errors) {
        const project = projects.find(
          (p) => p.environmentId === environmentId && p.id === error.projectId,
        );
        const kind = project?.repositoryIdentity?.provider as SourceControlProviderKind | undefined;
        const host = kind ? pullRequestHostOf(project?.repositoryIdentity, kind) : null;
        const group =
          (error.tracker && error.host ? groupOf(error.tracker, error.host) : undefined) ??
          (kind && host ? groupOf(kind, host) : undefined) ??
          [...byTracker.values()][0];
        group?.errors.push({ ...error, environmentId });
      }
    }
    for (const group of byTracker.values()) {
      group.rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }
    return [...byTracker.values()].sort((a, b) =>
      trackerKey(a.tracker).localeCompare(trackerKey(b.tracker)),
    );
  }, [held, debouncedQuery, projects]);

  const hostOptions = useMemo<ReadonlyArray<PullRequestFilterOption<string>>>(() => {
    const hosts = new Map<string, IssueTrackerSummary>();
    for (const group of groups) hosts.set(group.tracker.host, group.tracker);
    return [
      { value: "", label: "All trackers", Icon: Plug2Icon },
      ...[...hosts.values()].map((tracker) => ({
        value: tracker.host,
        label:
          hosts.size > 1 && issueTrackerPresentation(tracker.tracker).providerName === tracker.host
            ? tracker.host
            : `${issueTrackerPresentation(tracker.tracker).providerName} (${tracker.host})`,
        Icon: issueTrackerPresentation(tracker.tracker).Icon,
        ...(tracker.configured ? {} : { unavailable: tracker.detail ?? "Unavailable" }),
      })),
    ];
  }, [groups]);
  const projectOptions = useMemo<ReadonlyArray<PullRequestFilterOption<string>>>(
    () => [
      { value: "", label: "All projects", Icon: LayersIcon },
      ...filterProjects.map((project) => ({
        value: pullRequestProjectKey(project),
        label: project.title,
        Icon: FolderGit2Icon,
        project,
      })),
    ],
    [filterProjects],
  );
  const offeredInvolvements = useMemo(() => {
    const offered = offeredIssueInvolvements(
      groups.map((group) => group.tracker),
      search.who,
    );
    return offered === null
      ? INVOLVEMENT_TABS
      : INVOLVEMENT_TABS.filter((tab) => offered.has(tab.value));
  }, [groups, search.who]);

  const updateSearch = useCallback(
    (patch: { [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined }) =>
      void navigate({
        search: (previous: IssuesSearch): IssuesSearch => {
          const next = { ...previous, ...patch };
          return {
            who: next.who ?? previous.who,
            status: next.status ?? previous.status,
            ...(next.host ? { host: next.host } : {}),
            ...(next.environmentId ? { environmentId: next.environmentId } : {}),
            ...(next.projectId ? { projectId: next.projectId } : {}),
            q: next.q || undefined,
            ...(next.selectedEnvironmentId
              ? { selectedEnvironmentId: next.selectedEnvironmentId }
              : {}),
            ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
            ...(next.selectedHost ? { selectedHost: next.selectedHost } : {}),
            ...(next.tracker ? { tracker: next.tracker } : {}),
            ...(next.scope ? { scope: next.scope } : {}),
            ...(next.key ? { key: next.key } : {}),
          };
        },
        replace: true,
      }),
    [navigate],
  );
  const clearedSelection = {
    selectedEnvironmentId: undefined,
    selectedProjectId: undefined,
    selectedHost: undefined,
    tracker: undefined,
    scope: undefined,
    key: undefined,
  } as const;

  // One shared panel for the page, with a fixed sentinel ref, as the pull-request page does.
  const rightPanelRef = capableEnvironments.length === 0 ? null : ISSUES_PANEL_REF;
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, rightPanelRef),
  );
  const selectedSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, rightPanelRef),
  );
  const panelSurface =
    selectedSurface?.kind === "issue" || selectedSurface?.kind === "pull-request"
      ? selectedSurface
      : null;
  const { active: panelAnimationsActive, durationMs } = usePanelAnimationSettings();
  const presenceValue = useMemo(
    () => ({ activeSurface: panelSurface, surfaces: rightPanelState.surfaces }),
    [panelSurface, rightPanelState.surfaces],
  );
  const presence = usePanelPresence(
    rightPanelState.isOpen && panelSurface !== null,
    presenceValue,
    panelAnimationsActive,
    rightPanelRef?.threadId ?? null,
    durationMs,
  );
  const renderedSurface = presence.value?.activeSurface ?? null;
  const panelEnvironmentId = issuePanelEnvironmentId(capableProjects, {
    environmentId: renderedSurface?.environmentId as EnvironmentId | undefined,
    projectId: renderedSurface?.projectId,
  });
  const selectedProject = useMemo(
    () =>
      findScopedProject(
        capableProjects,
        search.selectedEnvironmentId ??
          (search.selectedProjectId === undefined ? scopedProject?.environmentId : undefined),
        search.selectedProjectId ?? scopedProject?.id,
      ),
    [
      capableProjects,
      search.selectedEnvironmentId,
      search.selectedProjectId,
      scopedProject?.id,
      scopedProject?.environmentId,
    ],
  );

  const selectSurfaceInUrl = (surface: RightPanelSurface | null) =>
    updateSearch(
      surface?.kind === "issue"
        ? {
            selectedEnvironmentId: surface.environmentId as EnvironmentId | undefined,
            selectedProjectId: surface.projectId as ProjectId,
            selectedHost: surface.host,
            tracker: surface.tracker,
            scope: surface.scope,
            key: surface.key,
          }
        : clearedSelection,
    );

  const selectEntry = useCallback(
    (entry: IssueRowTarget) => {
      if (rightPanelRef === null) return;
      useRightPanelStore.getState().openIssue(rightPanelRef, entry);
      updateSearch({
        selectedEnvironmentId: entry.environmentId,
        selectedProjectId: entry.projectId,
        selectedHost: entry.host,
        tracker: entry.tracker,
        scope: entry.scope,
        key: entry.key,
      });
    },
    [rightPanelRef, updateSearch],
  );

  // A link into the page names an issue before any row was pressed.
  useEffect(() => {
    if (
      rightPanelRef === null ||
      !search.tracker ||
      !search.scope ||
      !search.key ||
      selectedProject === undefined
    )
      return;
    useRightPanelStore.getState().openIssue(rightPanelRef, {
      environmentId: selectedProject.environmentId,
      projectId: selectedProject.id,
      tracker: search.tracker,
      ...(search.selectedHost === undefined ? {} : { host: search.selectedHost }),
      scope: search.scope,
      key: search.key,
    });
  }, [
    rightPanelRef,
    search.selectedHost,
    search.tracker,
    search.scope,
    search.key,
    selectedProject,
  ]);

  const closeSurface = (surface: RightPanelSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurface(rightPanelRef, surface.id);
    selectSurfaceInUrl(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, rightPanelRef),
    );
  };
  const toggleRightPanel = () => {
    if (rightPanelRef === null) return;
    if (rightPanelState.isOpen) {
      useRightPanelStore.getState().close(rightPanelRef);
      updateSearch(clearedSelection);
      return;
    }
    if (panelSurface === null) return;
    useRightPanelStore.getState().show(rightPanelRef);
    selectSurfaceInUrl(panelSurface);
  };
  const toggleRightPanelFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (panelSurface === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggleRightPanel();
  });
  const closeActiveSurfaceFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!rightPanelState.isOpen || panelSurface === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) closeSurface(panelSurface);
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: getShortcutContext(),
      });
      if (command === "rightPanel.close") closeActiveSurfaceFromShortcut(event);
      if (command === "rightPanel.toggle") toggleRightPanelFromShortcut(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  // Every writable scope the workspace has, for the composer.
  const createScopes = useMemo<ReadonlyArray<IssueCreateScope>>(() => {
    const scopes: IssueCreateScope[] = [];
    const seen = new Set<string>();
    const known = (environmentId: EnvironmentId, tracker: string, host: string, scope: string) => {
      const key = issueScopeKey(environmentId, { tracker, host, scope });
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    };
    for (const [environmentId, page] of held) {
      if (page.sources !== undefined) {
        for (const source of issueCreateSources(page.answer, page.sources)) {
          if (known(environmentId, source.tracker, source.host, source.scope)) continue;
          scopes.push({
            environmentId,
            projectTitle: source.projectTitle,
            templates: source.capabilities.templates,
            ...(source.capabilities.createIssueTypes === undefined
              ? {}
              : { createIssueTypes: source.capabilities.createIssueTypes }),
            scope: {
              projectId: source.projectId,
              tracker: source.tracker,
              host: source.host,
              scope: source.scope,
            },
          });
        }
        continue;
      }
      for (const project of projects) {
        if (project.environmentId !== environmentId) continue;
        if (scopedProject !== null && project.id !== scopedProject.id) continue;
        const identity = project.repositoryIdentity;
        const kind = identity?.provider as SourceControlProviderKind | undefined;
        const scope = sourceControlRepositorySelector(identity);
        if (!identity || !kind || scope === null) continue;
        const host = pullRequestHostOf(identity, kind);
        const tracker = page.answer.trackers.find(
          (t) => String(t.tracker) === kind && t.host.toLowerCase() === host.toLowerCase(),
        );
        if (!tracker?.configured || tracker.capabilities?.create !== true) continue;
        if (known(environmentId, tracker.tracker, host, scope)) continue;
        scopes.push({
          environmentId,
          projectTitle: project.title,
          templates: tracker.capabilities.templates,
          ...(tracker.capabilities.createIssueTypes === undefined
            ? {}
            : { createIssueTypes: tracker.capabilities.createIssueTypes }),
          scope: { projectId: project.id, tracker: tracker.tracker, host, scope },
        });
      }
    }
    return scopes;
  }, [held, projects, scopedProject]);
  const [createOpen, setCreateOpen] = useState(false);

  const showTracker = groups.length > 1;
  const noneAnswered = held.size === 0;

  const listBody: ReactNode = !issuesSupported ? (
    <PullRequestsUnavailableState
      title="Issues unavailable"
      error="Update this environment's T3 Code server to browse issues."
    />
  ) : noneAnswered && (list.isPending || projectScope === "waiting") ? (
    <PullRequestListGhost />
  ) : noneAnswered && list.error ? (
    <PullRequestsUnavailableState
      error={list.error}
      onRetry={list.refresh}
      refreshing={list.isPending}
    />
  ) : groups.length === 0 ? (
    <Empty>
      <EmptyMedia variant="icon">
        <IssueGlyph.issue />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No trackers to read</EmptyTitle>
        <EmptyDescription>Add a project whose remote is on a supported tracker.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <div className="flex flex-col gap-6">
      {groups.map((group) => {
        const presentation = issueTrackerPresentation(group.tracker.tracker);
        const showScope = new Set(group.rows.map(issueScopeKeyOf)).size > 1;
        return (
          <section key={trackerKey(group.tracker)} className="flex flex-col gap-1">
            <h2 className="flex items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground">
              <presentation.Icon aria-hidden className="size-3.5" />
              {presentation.providerName}
              {presentation.providerName.toLowerCase() !== group.tracker.host ? (
                <span className="font-normal">· {group.tracker.host}</span>
              ) : null}
              <span className="font-normal">
                · {group.tracker.projectCount}{" "}
                {group.tracker.projectCount === 1 ? "project" : "projects"}
              </span>
            </h2>
            {!group.tracker.configured ? (
              <p className="px-3 text-sm text-muted-foreground">
                {group.tracker.detail ?? "This tracker cannot be read right now."}
              </p>
            ) : null}
            {group.errors.map((error) => (
              <p
                key={`${error.environmentId}:${error.projectId}:${error.tracker ?? ""}:${error.host ?? ""}`}
                className="px-3 text-xs text-destructive"
              >
                {error.projectTitle}: {error.message}
              </p>
            ))}
            {group.tracker.configured && group.rows.length === 0 && group.errors.length === 0 ? (
              <p className="px-3 text-sm text-muted-foreground">
                {debouncedQuery ? "Nothing matches that." : "No issues under these filters."}
              </p>
            ) : null}
            {group.rows.map((row) => {
              const key = issueEntryKey(row);
              const selected =
                renderedSurface?.kind === "issue" &&
                renderedSurface.environmentId === row.environmentId &&
                issueEntryKey({
                  ...renderedSurface,
                  host: renderedSurface.host ?? "",
                  projectId: renderedSurface.projectId as ProjectId,
                }) === key;
              return (
                <IssueRow
                  key={`${row.environmentId}:${key}`}
                  entry={row}
                  selected={selected}
                  showScope={showScope}
                  showTracker={showTracker}
                  {...(capableEnvironments.length > 1 && environmentLabels.has(row.environmentId)
                    ? { environmentLabel: environmentLabels.get(row.environmentId) }
                    : {})}
                  onSelect={selectEntry}
                />
              );
            })}
            {group.more.map((environmentId) => (
              <Button
                key={environmentId}
                size="sm"
                variant="ghost-muted"
                className="self-start"
                disabled={loadingMore !== null}
                onClick={() =>
                  void loadMore(environmentId, group.tracker.host, group.tracker.tracker)
                }
              >
                {loadingMore === `${environmentId} ${group.tracker.tracker} ${group.tracker.host}`
                  ? "Loading…"
                  : "Load more"}
              </Button>
            ))}
          </section>
        );
      })}
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1">
        <div className="@container/issue-list flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls={!rightPanelState.isOpen}
            className="relative bg-background"
          >
            <WorkspaceBreadcrumb ariaLabel="Issues breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Issues</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="min-w-0 flex-1" />
            <div
              className="flex items-center gap-1 [-webkit-app-region:no-drag]"
              data-workspace-titlebar-controls
            >
              <PanelLayoutControls
                showTerminalControl={false}
                showThreadPanelControl={false}
                terminalAvailable={false}
                terminalOpen={false}
                terminalShortcutLabel={null}
                threadPanelOpen={false}
                threadPanelPresentation="inline"
                threadPanelShortcutLabel={null}
                onToggleThreadPanel={() => undefined}
                rightPanelAvailable={panelSurface !== null}
                rightPanelOpen={rightPanelState.isOpen}
                rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
                rightPanelUnavailableLabel="Select an issue first"
                onToggleTerminal={() => undefined}
                onToggleRightPanel={toggleRightPanel}
              />
            </div>
          </WorkspacePageHeader>

          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 basis-full @lg/issue-list:basis-0 @lg/issue-list:flex-1">
                  <PullRequestSearchInput
                    value={search.q ?? ""}
                    busy={
                      (search.q ?? "") !== debouncedQuery ||
                      (debouncedQuery.length > 0 && list.isPending)
                    }
                    onChange={(q) => updateSearch({ q: q || undefined })}
                    placeholder="Search issues, or label:bug"
                    aria-label="Search issues"
                  />
                </div>
                <ToggleGroup
                  size="segmented"
                  variant="segmented"
                  aria-label="Filter by state"
                  value={[search.status]}
                  onValueChange={(next) => {
                    const status = STATE_TABS.find((tab) => tab.value === next[0])?.value;
                    if (status) updateSearch({ status });
                  }}
                >
                  {STATE_TABS.map((tab) => (
                    <Toggle key={tab.value} value={tab.value}>
                      {tab.label}
                    </Toggle>
                  ))}
                </ToggleGroup>
                <FilterMenu
                  label="Filter by involvement"
                  value={search.who}
                  options={offeredInvolvements}
                  onChange={(who) => updateSearch({ who })}
                />
                {projectOptions.length > 2 || search.projectId ? (
                  <FilterMenu
                    label="Filter by project"
                    value={scopedProject ? pullRequestProjectKey(scopedProject) : ""}
                    options={projectOptions}
                    onChange={(key) => {
                      const project = filterProjects.find(
                        (candidate) => pullRequestProjectKey(candidate) === key,
                      );
                      updateSearch({
                        projectId: project?.id,
                        environmentId: project?.environmentId,
                      });
                    }}
                  />
                ) : null}
                {hostOptions.length > 2 || search.host ? (
                  <FilterMenu
                    label="Filter by tracker"
                    value={search.host ?? ""}
                    options={hostOptions}
                    onChange={(host) => updateSearch({ host: host || undefined })}
                  />
                ) : null}
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Refresh issues"
                  onClick={list.refresh}
                  disabled={list.isPending}
                >
                  <RefreshIcon size="md" refreshing={list.isPending} />
                </Button>
                {createScopes.length > 0 ? (
                  <Button size="default" onClick={() => setCreateOpen(true)}>
                    <PlusIcon aria-hidden className="size-4" />
                    New issue
                  </Button>
                ) : null}
              </div>
              {!noneAnswered && list.error ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
                  <span>{list.error}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={list.isPending}
                    onClick={list.refresh}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {listBody}
            </WorkspacePageContainer>
          </div>
        </div>

        {presence.present &&
        renderedSurface &&
        panelEnvironmentId !== null &&
        rightPanelRef !== null ? (
          <RightPanelTabs
            mode="inline"
            open={rightPanelState.isOpen}
            keybindings={keybindings}
            getShortcutContext={getShortcutContext}
            widthStorageKey="t3code:issue-panel-width"
            defaultWidth={typeof window === "undefined" ? 640 : Math.floor(window.innerWidth / 2)}
            surfaces={presence.value?.surfaces ?? []}
            environmentId={panelEnvironmentId}
            activeSurfaceId={renderedSurface.id}
            pendingSurfaceIds={EMPTY_SET}
            previewSessions={EMPTY_RECORD}
            desktopByTabId={EMPTY_RECORD}
            terminalLabelsById={EMPTY_MAP}
            onActivate={(surface) => {
              useRightPanelStore.getState().activateSurface(rightPanelRef, surface.id);
              selectSurfaceInUrl(surface);
            }}
            onCloseSurface={closeSurface}
            onCloseOtherSurfaces={(surface) => {
              useRightPanelStore.getState().closeOtherSurfaces(rightPanelRef, surface.id);
              selectSurfaceInUrl(surface);
            }}
            onCloseSurfacesToRight={(surface) => {
              useRightPanelStore.getState().closeSurfacesToRight(rightPanelRef, surface.id);
              selectSurfaceInUrl(
                selectActiveRightPanelSurface(
                  useRightPanelStore.getState().byThreadKey,
                  rightPanelRef,
                ),
              );
            }}
            onCloseAllSurfaces={() => {
              useRightPanelStore.getState().closeAllSurfaces(rightPanelRef);
              selectSurfaceInUrl(null);
            }}
            onMoveSurface={(surfaceId, toIndex) =>
              useRightPanelStore.getState().moveSurface(rightPanelRef, surfaceId, toIndex)
            }
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddBrowserInProfile={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddPullRequests={() => undefined}
            onAddDevice={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            pullRequestsAvailable={false}
            deviceAvailable={false}
          >
            {renderedSurface.kind === "issue" ? (
              <IssueDetailPanel
                key={renderedSurface.id}
                environmentId={panelEnvironmentId}
                reference={{
                  projectId: renderedSurface.projectId as ProjectId,
                  tracker: renderedSurface.tracker as IssueTrackerKind,
                  ...(renderedSurface.host ? { host: renderedSurface.host } : {}),
                  scope: renderedSurface.scope,
                  key: renderedSurface.key,
                }}
                onSelectPullRequest={(target) => {
                  useRightPanelStore.getState().openPullRequest(rightPanelRef, {
                    ...target,
                    environmentId: panelEnvironmentId,
                  });
                }}
                onUpdated={() =>
                  void refreshSource(
                    panelEnvironmentId,
                    {
                      projectId: renderedSurface.projectId as ProjectId,
                      tracker: renderedSurface.tracker as IssueTrackerKind,
                      ...(renderedSurface.host ? { host: renderedSurface.host } : {}),
                      scope: renderedSurface.scope,
                    },
                    renderedSurface.key,
                  )
                }
              />
            ) : (
              <PullRequestDetailPanel
                key={renderedSurface.id}
                getShortcutContext={getShortcutContext}
                shortcutsEnabled={panelSurface?.id === renderedSurface.id}
                environmentId={panelEnvironmentId}
                reference={{
                  projectId: (renderedSurface as PullRequestSurface).projectId as ProjectId,
                  repository: (renderedSurface as PullRequestSurface).repository,
                  number: (renderedSurface as PullRequestSurface).number,
                  ...((renderedSurface as PullRequestSurface).host
                    ? { host: (renderedSurface as PullRequestSurface).host }
                    : {}),
                }}
              />
            )}
          </RightPanelTabs>
        ) : null}
      </div>
      <IssueCreateDialog
        open={createOpen}
        scopes={createScopes}
        onOpenChange={setCreateOpen}
        onCreated={(scope, result) => {
          void refreshSource(scope.environmentId, scope.scope);
          selectEntry({
            environmentId: scope.environmentId,
            projectId: scope.scope.projectId,
            tracker: scope.scope.tracker,
            host: scope.scope.host ?? "",
            scope: scope.scope.scope,
            key: result.key,
            url: result.url,
          });
        }}
      />
    </SidebarInset>
  );
}

function FilterMenu<Value extends string>({
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
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger aria-label={`${label}: ${current.label}`} render={<Button variant="outline" />}>
        <PullRequestFilterOptionIcon option={current} />
        <span className="truncate">{current.label}</span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
          {options.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              disabled={option.unavailable !== undefined}
            >
              <span className="flex min-w-0 items-center gap-2">
                <PullRequestFilterOptionIcon option={option} />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
