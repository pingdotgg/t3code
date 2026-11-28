import { useAtomValue } from "@effect/atom-react";
import {
  continueIssuePage,
  groupIssues,
  holdIssuePages,
  issueCursorsForHost,
  issueFilterScopes,
  issueTrackerKey,
  type HeldIssuePage,
} from "@t3tools/client-runtime/issue-list";
import { issueTrackerDetailText } from "@t3tools/client-runtime/state/issue-trackers";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListInput,
  IssueListSort,
  IssueListState,
  IssueTrackerKind,
  IssueTrackerSummary,
  ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownUpIcon,
  AtSignIcon,
  CalendarArrowDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  LayersIcon,
  PenLineIcon,
  Plug2Icon,
  SearchIcon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { IssueDetailPanel } from "~/components/issue/IssueDetailPanel";
import { IssueRow, type IssueRowTarget } from "~/components/issue/IssueRow";
import {
  issueListPreferences,
  writeIssueListPreferences,
  type IssueListPreferences,
} from "~/components/issue/issueListPreferences";
import { IssueGlyph, issueTrackerPresentation } from "~/components/issue/issuePresentation";
import { PullRequestDetailPanel } from "~/components/pullRequest/PullRequestDetailPanel";
import { PullRequestMarkdownPanelContext } from "~/components/pullRequest/PullRequestMarkdown";
import { PullRequestListGhost } from "~/components/pullRequest/PullRequestGhosts";
import { PullRequestListNotice } from "~/components/pullRequest/PullRequestListEmptyState";
import { WorkItemGroupHeader } from "~/components/pullRequest/PullRequestListGroups";
import {
  pullRequestProjectKey,
  PullRequestSearchInput,
  type PullRequestFilterOption,
} from "~/components/pullRequest/PullRequestListFilters";
import { m, type MessageResolver } from "~/i18n/messages";
import { resolveFilterOptions } from "../pullRequest/pullRequestListOptions";
import { IssueFiltersMenu } from "./IssueListFilterPickers";
import {
  issueFilterProjects,
  issueListTargets,
  issueProjectKeys,
  issuesSearchFromUrl,
} from "./issuesSearch.logic";
import { ISSUE_SAVED_VIEWS } from "./issueSavedViews";
import { SavedViewsMenu } from "~/components/SavedViewsMenu";
import { PullRequestCompactFilterMenu } from "../pullRequest/PullRequestCompactFilterMenu";
import { RightPanelMaximizeControl } from "../chat/PanelLayoutControls";
import { RightPanelTabs, type RightPanelTabsHandle } from "~/components/RightPanelTabs";
import { WorkItemListColumn } from "../workItem/WorkItemListColumn";
import { WorkItemWindowedList, type WorkItemListItem } from "../workItem/WorkItemWindowedList";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { SidebarInset, useMobileSidebarSheetMounted } from "~/components/ui/sidebar";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { PREVIEW_PANEL_SPLIT_MIN_ROW_WIDTH } from "~/hooks/usePreviewPanelInlineSize";
import { useStableCallback } from "~/hooks/useStableCallback";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { useLayoutPane, useLayoutPaneFocusedRef } from "~/layout/layoutPaneContext";
import { useLayoutPageLocation } from "~/layout/pageNavigation";
import { isModalDialogOpen } from "~/lib/modalDialog";
import { observeResize } from "~/lib/observeResize";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { cn } from "~/lib/utils";
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
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects } from "~/state/entities";
import { useEnvironments, useIssuesSupported } from "~/state/environments";
import { issueEnvironment, useIssueList } from "~/state/issues";
import { useDebouncedValue } from "~/state/queries";
import { primaryServerKeybindingsAtom } from "~/state/server";

export interface IssuesSearch extends IssueListPreferences {
  readonly selectedEnvironmentId?: EnvironmentId | undefined;
  readonly selectedProjectId?: ProjectId | undefined;
  /** Part of the panel tab's identity, so a link reopens the tab a row press opened. */
  readonly selectedHost?: string | undefined;
  readonly tracker?: string | undefined;
  readonly scope?: string | undefined;
  readonly key?: string | undefined;
}

const STATE_TABS = [
  { value: "open", label: msg("Open", { $context: "issue state" }), Icon: IssueGlyph.issue },
  { value: "closed", label: msg("Closed", { $context: "issue state" }), Icon: CircleCheckIcon },
  { value: "all", label: msg("All", { $context: "issue filter" }), Icon: LayersIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueListState>>;

const INVOLVEMENT_TABS = [
  { value: "all", label: msg("Everyone", { $context: "issue filter" }), Icon: UsersIcon },
  { value: "assigned", label: msg("Assigned to me"), Icon: UserCheckIcon },
  { value: "authored", label: msg("Opened by me"), Icon: PenLineIcon },
  { value: "mentioned", label: msg("Mentioning me"), Icon: AtSignIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueInvolvement>>;

const SORT_OPTIONS = [
  { value: "updated", label: msg("Recently updated"), Icon: ClockIcon },
  {
    value: "created",
    label: msg("Newest", { $context: "sort order" }),
    Icon: CalendarArrowDownIcon,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueListSort>>;

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

function hostOptionsFor(
  trackers: ReadonlyArray<IssueTrackerSummary>,
  chosen: string | undefined,
  resolve: MessageResolver,
) {
  const hosts = new Map<string, IssueTrackerSummary>();
  const ordered = [...trackers].sort((a, b) =>
    issueTrackerKey(a).localeCompare(issueTrackerKey(b)),
  );
  for (const tracker of ordered) {
    const existing = hosts.get(tracker.host);
    if (existing === undefined || (!existing.configured && tracker.configured))
      hosts.set(tracker.host, tracker);
  }
  return [
    { value: "", label: resolve(msg("All", { $context: "issue filter" })), Icon: Plug2Icon },
    // A remembered host no project is on any more stays listed, so the filter can be taken off.
    ...(chosen !== undefined && !hosts.has(chosen)
      ? [{ value: chosen, label: chosen, Icon: Plug2Icon }]
      : []),
    ...[...hosts.values()].map((tracker) => ({
      value: tracker.host,
      label:
        hosts.size > 1 && issueTrackerPresentation(tracker.tracker).providerName === tracker.host
          ? tracker.host
          : `${issueTrackerPresentation(tracker.tracker).providerName} (${tracker.host})`,
      Icon: issueTrackerPresentation(tracker.tracker).Icon,
      ...(tracker.configured
        ? {}
        : {
            unavailable:
              tracker.detail === null
                ? resolve(msg("Unavailable"))
                : issueTrackerDetailText(tracker.detail, resolve),
          }),
    })),
  ];
}

export function IssuesPage() {
  const gt = useGT();
  const resolve = useMessages();
  const { visible } = useLayoutPane();
  const location = useLayoutPageLocation();
  const search = issuesSearchFromUrl(location.search);
  const focusedRef = useLayoutPaneFocusedRef();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const issuesSupported = useIssuesSupported();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // The windowed rows follow the page's scroller once it mounts.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

  const capableEnvironments = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.issues === true,
  );
  const environmentLabels = new Map(environments.map((e) => [e.environmentId, e.label] as const));
  const filterProjects = issueFilterProjects(
    projects.filter((project) =>
      capableEnvironments.some((e) => e.environmentId === project.environmentId),
    ),
    environmentLabels,
  );
  const hiddenProjects = issueProjectKeys(search.hideProjects);

  const debouncedQuery = useDebouncedValue(search.q ?? "", 300);
  const listInput: IssueListInput = {
    state: search.status,
    involvement: search.who,
    limit: PAGE_SIZE,
    ...(search.host ? { host: search.host } : {}),
    ...(debouncedQuery ? { query: debouncedQuery } : {}),
    ...(search.label?.length ? { labels: search.label } : {}),
    ...(search.assignee ? { assignee: search.assignee } : {}),
    ...(search.order ? { sort: search.order } : {}),
  };
  const everyProjectHidden =
    filterProjects.length > 0 &&
    filterProjects.every((project) => hiddenProjects.has(pullRequestProjectKey(project)));
  const targets = everyProjectHidden
    ? []
    : issueListTargets(
        capableEnvironments.map((e) => e.environmentId),
        filterProjects,
        search.hideProjects,
        listInput,
      );
  const list = useIssueList(targets);
  // Refreshing a list still loading would cancel it and start over, losing the scopes already read.
  useLiveRefresh(
    () => {
      if (!list.isPending) list.reload();
    },
    { key: JSON.stringify(targets) },
  );

  const [pages, setPages] = useState<ReadonlyMap<EnvironmentId, HeldIssuePage>>(new Map());
  const held = holdIssuePages(list.answers, pages);
  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  // One tracker group's button carries on that tracker's scopes only.
  const loadMore = async (environmentId: EnvironmentId, host: string) => {
    const page = held.get(environmentId);
    const cursors = page ? issueCursorsForHost(page.nextCursors, host) : {};
    if (!page || Object.keys(cursors).length === 0 || loadingMore !== null) return;
    setLoadingMore(`${environmentId} ${host}`);
    const input = targets.find((target) => target.environmentId === environmentId)?.input;
    if (!input) return;
    const result = await loadPage({ environmentId, input: { ...input, cursors } });
    setLoadingMore(null);
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setPages((current) => {
      const next = new Map(current);
      next.set(
        environmentId,
        continueIssuePage(
          page,
          result._tag === "Failure"
            ? {
                failure:
                  failure instanceof Error ? failure.message : m(msg("The next page failed.")),
              }
            : result.value,
          cursors,
        ),
      );
      return next;
    });
  };

  // Rows grouped per tracker account, so a tracker that cannot be read says so where its rows
  // would be, and each tracker's rows carry on from their own cursors.
  // The server names every tracker so the menu can switch hosts, but reads only the chosen one.
  const chosenHost = search.host?.toLowerCase();
  // A server older than `excludeProjectIds` still answers for hidden projects.
  const shown =
    chosenHost || hiddenProjects.size > 0
      ? new Map(
          [...held].map(([environmentId, page]) => [
            environmentId,
            {
              ...page,
              entries: page.entries.filter(
                (entry) =>
                  !hiddenProjects.has(
                    pullRequestProjectKey({ environmentId, id: entry.projectId }),
                  ),
              ),
              errors: page.errors.filter(
                (error) =>
                  !hiddenProjects.has(
                    pullRequestProjectKey({ environmentId, id: error.projectId }),
                  ),
              ),
              answer: {
                ...page.answer,
                scopes: page.answer.scopes?.filter(
                  (scope) =>
                    !hiddenProjects.has(
                      pullRequestProjectKey({ environmentId, id: scope.projectId }),
                    ),
                ),
                trackers: chosenHost
                  ? page.answer.trackers.filter(
                      (tracker) => tracker.host.toLowerCase() === chosenHost,
                    )
                  : page.answer.trackers,
              },
            },
          ]),
        )
      : held;
  const groups = groupIssues(shown, debouncedQuery, projects, search.order ?? "updated");
  const filterScopes = issueFilterScopes(
    shown,
    projects.filter((project) => !hiddenProjects.has(pullRequestProjectKey(project))),
  );

  const hostOptions = hostOptionsFor(
    [...held.values()].flatMap((page) => page.answer.trackers),
    search.host,
    resolve,
  );

  const updateSearch = (patch: { [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined }) => {
    const merged = { ...search, ...patch };
    const next: IssuesSearch = {
      who: merged.who ?? search.who,
      status: merged.status ?? search.status,
      ...(merged.hideProjects?.length ? { hideProjects: merged.hideProjects } : {}),
      ...(merged.host ? { host: merged.host } : {}),
      q: merged.q || undefined,
      ...(merged.label?.length ? { label: merged.label } : {}),
      ...(merged.assignee ? { assignee: merged.assignee } : {}),
      ...(merged.order ? { order: merged.order } : {}),
      ...(merged.selectedEnvironmentId
        ? { selectedEnvironmentId: merged.selectedEnvironmentId }
        : {}),
      ...(merged.selectedProjectId ? { selectedProjectId: merged.selectedProjectId } : {}),
      ...(merged.selectedHost ? { selectedHost: merged.selectedHost } : {}),
      ...(merged.tracker ? { tracker: merged.tracker } : {}),
      ...(merged.scope ? { scope: merged.scope } : {}),
      ...(merged.key ? { key: merged.key } : {}),
    };
    writeIssueListPreferences(issueListPreferences(next));
    void navigate({ to: "/issues", search: next, replace: true });
  };
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
  const activeSurface = rightPanelState.isOpen ? panelSurface : null;
  const { active: panelAnimationsActive, durationMs } = usePanelAnimationSettings();
  const presenceValue = { activeSurface: panelSurface, surfaces: rightPanelState.surfaces };
  const presence = usePanelPresence(
    rightPanelState.isOpen && panelSurface !== null,
    presenceValue,
    panelAnimationsActive,
    rightPanelRef?.threadId ?? null,
    durationMs,
  );
  const renderedSurface = presence.value?.activeSurface ?? null;
  const panelEnvironmentId =
    (renderedSurface?.environmentId as EnvironmentId | undefined) ??
    capableEnvironments[0]?.environmentId ??
    null;

  const panelListEntry =
    renderedSurface?.kind === "issue"
      ? (groups
          .flatMap((group) => group.rows)
          .find(
            (row) =>
              row.environmentId === panelEnvironmentId &&
              issueEntryKey(row) ===
                issueEntryKey({
                  ...renderedSurface,
                  host: renderedSurface.host ?? row.host,
                  projectId: renderedSurface.projectId as ProjectId,
                }),
          ) ?? null)
      : null;

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

  const selectEntry = useStableCallback(
    (entry: Omit<IssueRowTarget, "host"> & { readonly host?: string }) => {
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
  );

  // A link into the page names an issue before any row was pressed.
  const openLinkedIssue = useEffectEvent(() => {
    if (
      rightPanelRef === null ||
      !search.tracker ||
      !search.scope ||
      !search.key ||
      !search.selectedProjectId
    )
      return;
    useRightPanelStore.getState().openIssue(rightPanelRef, {
      ...(search.selectedEnvironmentId === undefined
        ? {}
        : { environmentId: search.selectedEnvironmentId }),
      projectId: search.selectedProjectId,
      ...(search.selectedHost === undefined ? {} : { host: search.selectedHost }),
      tracker: search.tracker,
      scope: search.scope,
      key: search.key,
    });
  });
  const linkedSelectionKey =
    search.tracker && search.scope && search.key && search.selectedProjectId
      ? JSON.stringify([
          search.selectedEnvironmentId,
          search.selectedProjectId,
          search.selectedHost,
          search.tracker,
          search.scope,
          search.key,
        ])
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the URL-linked issue in the right panel store
  useEffect(() => {
    if (!visible || rightPanelRef === null || linkedSelectionKey === null) return;
    openLinkedIssue();
  }, [linkedSelectionKey, rightPanelRef, visible]);

  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  const [maximized, setMaximized] = useState(false);
  // A pane too narrow for the list and the issue at their minimums shows the issue alone.
  const [tooNarrowToSplit, setTooNarrowToSplit] = useState(false);
  const observeSplitRow = useStableCallback((row: HTMLDivElement) =>
    observeResize(row, () =>
      setTooNarrowToSplit(row.clientWidth < PREVIEW_PANEL_SPLIT_MIN_ROW_WIDTH),
    ),
  );
  const rightPanelMaximized = rightPanelState.isOpen && (maximized || tooNarrowToSplit);
  if (!rightPanelState.isOpen && maximized) setMaximized(false);
  const toggleRightPanelMaximized = () => {
    if (rightPanelState.isOpen) {
      setMaximized((value) => !value);
      return;
    }
    // A closed panel opens straight into maximized.
    if (rightPanelRef === null || panelSurface === null) return;
    toggleRightPanel();
    setMaximized(true);
  };

  const closeSurfaces = (surfaces: readonly RightPanelSurface[]) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurfaces(
      rightPanelRef,
      surfaces.map((surface) => surface.id),
    );
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

  const rightPanelTabsRef = useRef<RightPanelTabsHandle>(null);
  const closeActiveSurfaceFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (activeSurface === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      if (!rightPanelTabsRef.current?.closeSelectedTabs()) closeSurfaces([activeSurface]);
    }
  });
  const toggleRightPanelFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (panelSurface === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggleRightPanel();
  });
  const toggleRightPanelMaximizedFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!rightPanelState.isOpen && (rightPanelRef === null || panelSurface === null)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggleRightPanelMaximized();
  });
  const onDocumentKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      !focusedRef.current ||
      event.defaultPrevented ||
      isCommandPaletteOpen() ||
      isModalDialogOpen()
    )
      return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: { ...getShortcutContext(), rightPanelOpen: rightPanelState.isOpen },
    });
    if (command === "rightPanel.close" || command === "tab.close")
      closeActiveSurfaceFromShortcut(event);
    if (command === "rightPanel.toggle") toggleRightPanelFromShortcut(event);
    if (command === "rightPanel.toggleMaximized") toggleRightPanelMaximizedFromShortcut(event);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document keydown listener for the right panel shortcuts
  useEffect(() => {
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, []);

  const listFiltered =
    search.status !== "open" ||
    search.who !== "all" ||
    hiddenProjects.size > 0 ||
    search.host !== undefined ||
    (search.label?.length ?? 0) > 0 ||
    search.assignee !== undefined;
  const clearListFilters = () =>
    updateSearch({
      status: "open",
      who: "all",
      hideProjects: undefined,
      host: undefined,
      label: undefined,
      assignee: undefined,
    });
  const showTracker = groups.length > 1;
  const noneAnswered = list.answers.length === 0;

  // Flat, so only the rows near the view mount; each group's gap rides on its first item.
  const issueListItems = (): WorkItemListItem[] => {
    const items: WorkItemListItem[] = [];
    if (list.error) {
      items.push({
        key: "error",
        type: "notice",
        node: (
          <div className="pb-3">
            <div className="flex items-center justify-between gap-3 rounded-control border border-warning/30 bg-warning-surface px-3 py-2 text-meta">
              <span>
                <T>
                  <Var>{list.error}</Var> Showing the issues that loaded.
                </T>
              </span>
              <Button size="xs" variant="secondary" onClick={list.retry}>
                <T>Retry</T>
              </Button>
            </div>
          </div>
        ),
      });
    }
    for (const [groupIndex, group] of groups.entries()) {
      const groupKey = issueTrackerKey(group.tracker);
      const presentation = issueTrackerPresentation(group.tracker.tracker);
      const showScope = new Set(group.rows.map((row) => row.scope.toLowerCase())).size > 1;
      // Said in the rows' text column, under the heading, where the rows would be.
      const note = (text: ReactNode, tone: "muted" | "error" = "muted") => (
        <p
          className={cn(
            "ps-10 pe-3 py-1.5 text-body",
            tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {text}
        </p>
      );
      items.push({
        key: `${groupKey}:header`,
        type: groupIndex > 0 ? "header:gap" : "header",
        node: (
          <div className={groupIndex > 0 ? "pt-3" : undefined}>
            <WorkItemGroupHeader
              icon={presentation.Icon}
              label={presentation.providerName}
              // The host sits with the count, in the quieter ink, after the tracker's name.
              count={
                <span className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap">
                  {presentation.providerName.toLowerCase() !== group.tracker.host ? (
                    <span className="truncate">{group.tracker.host}</span>
                  ) : null}
                  <span className="shrink-0">
                    {gt("{count, plural, one {{count} project} other {{count} projects}}", {
                      count: group.tracker.projectCount,
                    })}
                  </span>
                </span>
              }
            />
          </div>
        ),
      });
      if (!group.tracker.configured) {
        items.push({
          key: `${groupKey}:unconfigured`,
          type: "note",
          node: note(
            group.tracker.detail === null
              ? gt("This tracker cannot be read right now.")
              : issueTrackerDetailText(group.tracker.detail, resolve),
          ),
        });
      }
      for (const error of group.errors) {
        items.push({
          key: `${groupKey}:error:${error.environmentId}:${error.projectTitle}`,
          type: "note",
          node: note(`${error.projectTitle}: ${error.message}`, "error"),
        });
      }
      if (group.tracker.configured && group.rows.length === 0 && group.errors.length === 0) {
        items.push({
          key: `${groupKey}:empty`,
          type: "notice",
          node: debouncedQuery ? (
            <PullRequestListNotice
              icon={SearchIcon}
              title={<T>Nothing matches that.</T>}
              description={null}
            >
              <Button size="sm" variant="secondary" onClick={() => updateSearch({ q: undefined })}>
                <T>Clear search</T>
              </Button>
            </PullRequestListNotice>
          ) : (
            <PullRequestListNotice
              icon={IssueGlyph.issue}
              title={<T>No issues under these filters.</T>}
              description={null}
            >
              {listFiltered ? (
                <Button size="sm" variant="secondary" onClick={clearListFilters}>
                  <T>Clear filters</T>
                </Button>
              ) : null}
            </PullRequestListNotice>
          ),
        });
      }
      for (const [index, row] of group.rows.entries()) {
        const key = issueEntryKey(row);
        const selected =
          renderedSurface?.kind === "issue" &&
          renderedSurface.environmentId === row.environmentId &&
          issueEntryKey({
            ...renderedSurface,
            host: renderedSurface.host ?? "",
            projectId: renderedSurface.projectId as ProjectId,
          }) === key;
        items.push({
          key: `${groupKey}:${row.environmentId}:${key}`,
          // One height per type (a row after another carries the separator), so the list's
          // estimate for a row it has not measured is exact.
          type: index > 0 ? "row:separated" : "row",
          node: (
            <div>
              {index > 0 ? <Separator /> : null}
              <IssueRow
                entry={row}
                selected={selected}
                showScope={showScope}
                showTracker={showTracker}
                {...(capableEnvironments.length > 1 && environmentLabels.has(row.environmentId)
                  ? { environmentLabel: environmentLabels.get(row.environmentId) }
                  : {})}
                onSelect={selectEntry}
              />
            </div>
          ),
        });
      }
      for (const environmentId of group.more) {
        const moreFailure = held.get(environmentId)?.moreFailure ?? null;
        const loadingThis = loadingMore === `${environmentId} ${group.tracker.host}`;
        items.push({
          key: `${groupKey}:more:${environmentId}`,
          type: "more",
          node: (
            <div className="flex flex-col items-center gap-2 py-3 text-meta text-muted-foreground">
              {moreFailure === null ? null : (
                <span className="text-destructive-foreground">{moreFailure}</span>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={loadingMore !== null}
                onClick={() => void loadMore(environmentId, group.tracker.host)}
              >
                {loadingThis ? (
                  <T>Loading…</T>
                ) : moreFailure === null ? (
                  <T>Load more</T>
                ) : (
                  <T>Retry</T>
                )}
              </Button>
            </div>
          ),
        });
      }
    }
    return items;
  };

  const listBody: ReactNode = !issuesSupported ? (
    <PullRequestListNotice
      icon={IssueGlyph.issue}
      title={gt("Issues unavailable")}
      description={gt("Update this environment's T3 Code server to browse issues.")}
    />
  ) : noneAnswered && list.isPending ? (
    <PullRequestListGhost rows={7} caption={gt("Loading issues…")} />
  ) : noneAnswered && list.error ? (
    <PullRequestListNotice
      icon={CircleAlertIcon}
      title={gt("Could not load issues")}
      description={list.error}
    >
      <Button size="sm" variant="secondary" disabled={list.isPending} onClick={list.retry}>
        <RefreshIcon size="sm" refreshing={list.isPending} />
        <T>Retry</T>
      </Button>
    </PullRequestListNotice>
  ) : everyProjectHidden ? (
    <PullRequestListNotice
      icon={IssueGlyph.issue}
      title={gt("Every project is hidden")}
      description={null}
    >
      <Button
        size="sm"
        variant="secondary"
        onClick={() => updateSearch({ hideProjects: undefined })}
      >
        <T>Show all projects</T>
      </Button>
    </PullRequestListNotice>
  ) : groups.length === 0 ? (
    <PullRequestListNotice
      icon={IssueGlyph.issue}
      title={<T>No trackers to read</T>}
      description={<T>Add a project whose remote is on a supported tracker.</T>}
    />
  ) : (
    <WorkItemWindowedList
      items={issueListItems()}
      scrollElement={scrollElement}
      estimatedItemSize={61}
    />
  );

  const openPanelControls =
    rightPanelState.isOpen && !tooNarrowToSplit ? (
      <div
        className={cn(
          "absolute top-[var(--workspace-pane-local-controls-top)] right-[var(--workspace-pane-local-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
          mobileSidebarSheetMounted && "hidden",
        )}
        data-workspace-titlebar-controls
      >
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
          shortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggleMaximized")}
        />
      </div>
    ) : null;

  const splitPanes =
    presence.present &&
    renderedSurface !== null &&
    panelEnvironmentId !== null &&
    rightPanelRef !== null;
  return (
    <SidebarInset
      variant={splitPanes ? "split" : "pane"}
      className="h-full min-h-0 overflow-hidden overscroll-y-none"
    >
      <div ref={observeSplitRow} className="relative flex min-h-0 flex-1">
        {presence.present ? openPanelControls : null}
        <WorkItemListColumn
          area="issues"
          title={gt("Issues", { $context: "sidebar link to the list of issues" })}
          icon={<IssueGlyph.issue aria-hidden className="size-3.5 shrink-0 text-foreground" />}
          refreshLabel={gt("Refresh issues")}
          refreshing={list.isPending}
          onRefresh={list.refresh}
          providerMenu={
            hostOptions.length > 1 ? (
              <PullRequestCompactFilterMenu
                label={gt("Filter by tracker")}
                iconOnly={search.host !== undefined}
                triggerIcon={<Plug2Icon aria-hidden className="size-4" />}
                triggerLabel={gt("All", { $context: "all providers" })}
                value={search.host ?? ""}
                options={hostOptions}
                onChange={(host) => updateSearch({ host: host || undefined })}
              />
            ) : null
          }
          searchInput={
            <PullRequestSearchInput
              value={search.q ?? ""}
              label={gt("Search issues")}
              placeholder={gt("Search issues")}
              busy={
                (search.q ?? "") !== debouncedQuery || (debouncedQuery.length > 0 && list.isPending)
              }
              onChange={(q) => updateSearch({ q: q || undefined })}
              onSubmit={(q) => updateSearch({ q: q || undefined })}
            />
          }
          sortMenu={
            <PullRequestCompactFilterMenu
              label={gt("Sort issues")}
              triggerIcon={<ArrowDownUpIcon aria-hidden className="size-4" />}
              triggerLabel={gt("Sort", { $context: "verb, sort a list" })}
              value={search.order ?? "updated"}
              options={resolveFilterOptions(SORT_OPTIONS, resolve)}
              onChange={(order) =>
                updateSearch({ order: order === "created" ? "created" : undefined })
              }
            />
          }
          filtersMenu={
            <IssueFiltersMenu
              state={search.status}
              stateOptions={resolveFilterOptions(STATE_TABS, resolve)}
              onState={(status) => updateSearch({ status })}
              involvement={search.who}
              involvementOptions={resolveFilterOptions(INVOLVEMENT_TABS, resolve)}
              onInvolvement={(who) => updateSearch({ who })}
              scopes={filterScopes}
              labels={search.label ?? []}
              onLabels={(label) => updateSearch({ label })}
              assignee={search.assignee}
              onAssignee={(assignee) => updateSearch({ assignee })}
              projects={filterProjects}
              hiddenProjects={hiddenProjects}
              onHiddenProjects={(hideProjects) => updateSearch({ hideProjects })}
            />
          }
          savedViewsMenu={
            <SavedViewsMenu
              kind={ISSUE_SAVED_VIEWS}
              preferences={search}
              onApply={(view) =>
                // Explicit clears replace the old list scope; the selected issue stays open.
                updateSearch({
                  who: view.who,
                  status: view.status,
                  hideProjects: view.hideProjects,
                  host: view.host,
                  q: view.q,
                  label: view.label,
                  assignee: view.assignee,
                  order: view.order,
                })
              }
            />
          }
          rightPanelOpen={rightPanelState.isOpen}
          maximizedAway={rightPanelMaximized}
          split={splitPanes}
          listBody={listBody}
          scrollRef={setScrollElement}
        />

        {splitPanes ? (
          <RightPanelTabs
            ref={rightPanelTabsRef}
            mode="inline"
            pane
            open={rightPanelState.isOpen}
            maximized={rightPanelMaximized}
            holdsPaneTabs={rightPanelMaximized}
            keybindings={keybindings}
            widthStorageKey="t3code:issue-panel-width"
            defaultWidth={
              typeof window === "undefined" ? 550 : Math.floor(window.innerWidth * 0.43)
            }
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
            onCloseSurface={(surface) => closeSurfaces([surface])}
            onCloseSelectedSurfaces={closeSurfaces}
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
            onMoveSurfaces={(surfaceIds, targetId) =>
              useRightPanelStore.getState().moveSurfaces(rightPanelRef, surfaceIds, targetId)
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
            <PullRequestMarkdownPanelContext value={rightPanelRef}>
              {renderedSurface.kind === "issue" ? (
                <IssueDetailPanel
                  key={`${panelEnvironmentId}:${renderedSurface.id}`}
                  environmentId={panelEnvironmentId}
                  listEntry={panelListEntry}
                  reference={{
                    projectId: renderedSurface.projectId as ProjectId,
                    tracker: renderedSurface.tracker as IssueTrackerKind,
                    ...(renderedSurface.host ? { host: renderedSurface.host } : {}),
                    scope: renderedSurface.scope,
                    key: renderedSurface.key,
                  }}
                  onBack={tooNarrowToSplit ? toggleRightPanel : undefined}
                  onSelectPullRequest={(reference) => {
                    useRightPanelStore.getState().openPullRequest(rightPanelRef, {
                      projectId: reference.projectId,
                      repository: reference.repository,
                      number: reference.number,
                      ...(reference.host === undefined ? {} : { host: reference.host }),
                      environmentId: panelEnvironmentId,
                    });
                  }}
                  onSelectIssue={({ host, ...reference }) =>
                    selectEntry({
                      ...reference,
                      ...(host === undefined ? {} : { host }),
                      environmentId: panelEnvironmentId,
                    })
                  }
                />
              ) : (
                <PullRequestDetailPanel
                  key={renderedSurface.id}
                  getShortcutContext={getShortcutContext}
                  shortcutsEnabled={panelSurface?.id === renderedSurface.id}
                  environmentId={panelEnvironmentId}
                  onBack={tooNarrowToSplit ? toggleRightPanel : undefined}
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
            </PullRequestMarkdownPanelContext>
          </RightPanelTabs>
        ) : null}
      </div>
    </SidebarInset>
  );
}
