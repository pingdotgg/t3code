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
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowDownUpIcon,
  AtSignIcon,
  CalendarArrowDownIcon,
  CircleCheckIcon,
  ClockIcon,
  LayersIcon,
  PenLineIcon,
  Plug2Icon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";

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
import { PullRequestListGhost } from "~/components/pullRequest/PullRequestGhosts";
import {
  PullRequestFilterOptionIcon,
  PullRequestSearchInput,
  type PullRequestFilterOption,
} from "~/components/pullRequest/PullRequestListFilters";
import { m, type MessageResolver } from "~/i18n/messages";
import { resolveFilterOptions } from "../pullRequest/pullRequestListOptions";
import { IssueFiltersMenu } from "./IssueListFilterPickers";
import { ISSUE_SAVED_VIEWS } from "./issueSavedViews";
import { SavedViewsMenu } from "~/components/SavedViewsMenu";
import { PullRequestCompactFilterMenu } from "../pullRequest/PullRequestCompactFilterMenu";
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
import { isElectron } from "~/env";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { shortcutLabelForCommand } from "~/keybindings";
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
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects } from "~/state/entities";
import { useEnvironments, useIssuesSupported } from "~/state/environments";
import { issueEnvironment, useIssueList, type IssueListTarget } from "~/state/issues";
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
  const navigate = useNavigate({ from: "/issues" });
  const search = useSearch({ from: "/_chat/issues" });
  const { environments } = useEnvironments();
  const projects = useProjects();
  const issuesSupported = useIssuesSupported();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const capableEnvironments = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.issues === true,
  );
  const environmentLabels = new Map(environments.map((e) => [e.environmentId, e.label] as const));

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
  const targets: ReadonlyArray<IssueListTarget> = capableEnvironments.map((e) => ({
    environmentId: e.environmentId,
    input: listInput,
  }));
  const list = useIssueList(targets);
  useLiveRefresh(list.refresh, { key: JSON.stringify(targets) });

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
    const result = await loadPage({ environmentId, input: { ...listInput, cursors } });
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
  const shown = chosenHost
    ? new Map(
        [...held].map(([environmentId, page]) => [
          environmentId,
          {
            ...page,
            answer: {
              ...page.answer,
              trackers: page.answer.trackers.filter(
                (tracker) => tracker.host.toLowerCase() === chosenHost,
              ),
            },
          },
        ]),
      )
    : held;
  const groups = groupIssues(shown, debouncedQuery, projects, search.order ?? "updated");
  const filterScopes = issueFilterScopes(shown, projects);

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
    void navigate({ search: next });
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

  const selectEntry = (entry: IssueRowTarget) => {
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
  };

  // A link into the page names an issue before any row was pressed.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the URL-linked issue in the right panel store
  useEffect(() => {
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
  }, [
    rightPanelRef,
    search.tracker,
    search.scope,
    search.key,
    search.selectedProjectId,
    search.selectedHost,
    search.selectedEnvironmentId,
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

  // Every writable scope the workspace has, for the composer.

  const showTracker = groups.length > 1;
  const noneAnswered = list.answers.length === 0;

  const listBody: ReactNode = !issuesSupported ? (
    <PullRequestsUnavailableState
      title={gt("Issues unavailable")}
      error={gt("Update this environment's T3 Code server to browse issues.")}
    />
  ) : noneAnswered && list.isPending ? (
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
        <EmptyTitle>
          <T>No trackers to read</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>Add a project whose remote is on a supported tracker.</T>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <div className="flex flex-col gap-6">
      {list.error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
          <span>
            <T>
              <Var>{list.error}</Var> Showing the issues that loaded.
            </T>
          </span>
          <Button size="xs" variant="outline" onClick={list.refresh}>
            <T>Retry</T>
          </Button>
        </div>
      ) : null}
      {groups.map((group) => {
        const presentation = issueTrackerPresentation(group.tracker.tracker);
        const showScope = new Set(group.rows.map((row) => row.scope.toLowerCase())).size > 1;
        return (
          <section key={issueTrackerKey(group.tracker)} className="flex flex-col gap-1">
            <h2 className="flex items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground">
              <presentation.Icon aria-hidden className="size-3.5" />
              {presentation.providerName}
              {presentation.providerName.toLowerCase() !== group.tracker.host ? (
                <span className="font-normal">· {group.tracker.host}</span>
              ) : null}
              <span className="font-normal">
                ·{" "}
                {gt("{count, plural, one {{count} project} other {{count} projects}}", {
                  count: group.tracker.projectCount,
                })}
              </span>
            </h2>
            {!group.tracker.configured ? (
              <p className="px-3 text-sm text-muted-foreground">
                {group.tracker.detail === null
                  ? gt("This tracker cannot be read right now.")
                  : issueTrackerDetailText(group.tracker.detail, resolve)}
              </p>
            ) : null}
            {group.errors.map((error) => (
              <p
                key={`${error.environmentId}:${error.projectTitle}`}
                className="px-3 text-xs text-destructive"
              >
                {error.projectTitle}: {error.message}
              </p>
            ))}
            {group.tracker.configured && group.rows.length === 0 && group.errors.length === 0 ? (
              <p className="px-3 text-sm text-muted-foreground">
                {debouncedQuery ? (
                  <T>Nothing matches that.</T>
                ) : (
                  <T>No issues under these filters.</T>
                )}
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
            {group.more.map((environmentId) => {
              const moreFailure = held.get(environmentId)?.moreFailure ?? null;
              return (
                <Fragment key={environmentId}>
                  {moreFailure === null ? null : (
                    <p className="px-3 text-xs text-destructive">{moreFailure}</p>
                  )}
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    className="self-start"
                    disabled={loadingMore !== null}
                    onClick={() => void loadMore(environmentId, group.tracker.host)}
                  >
                    {loadingMore === `${environmentId} ${group.tracker.host}` ? (
                      <T>Loading…</T>
                    ) : moreFailure === null ? (
                      <T>Load more</T>
                    ) : (
                      <T>Retry</T>
                    )}
                  </Button>
                </Fragment>
              );
            })}
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
            <WorkspaceBreadcrumb ariaLabel={gt("Issues breadcrumb")}>
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">
                  <T context="page title, list of issues">Issues</T>
                </h1>
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
                rightPanelUnavailableLabel={gt("Select an issue first")}
                onToggleTerminal={() => undefined}
                onToggleRightPanel={toggleRightPanel}
              />
            </div>
          </WorkspacePageHeader>

          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 basis-full @lg/issue-list:min-w-48 @lg/issue-list:basis-0 @lg/issue-list:flex-1">
                  <PullRequestSearchInput
                    value={search.q ?? ""}
                    label={gt("Search issues")}
                    placeholder={gt("Search issues")}
                    busy={
                      (search.q ?? "") !== debouncedQuery ||
                      (debouncedQuery.length > 0 && list.isPending)
                    }
                    onChange={(q) => updateSearch({ q: q || undefined })}
                    onSubmit={(q) => updateSearch({ q: q || undefined })}
                  />
                </div>
                <PullRequestCompactFilterMenu
                  label={gt("Sort issues")}
                  triggerIcon={<ArrowDownUpIcon aria-hidden className="size-4" />}
                  triggerLabel={gt("Sort", { $context: "verb, button that sorts a list" })}
                  outlined
                  value={search.order ?? "updated"}
                  options={resolveFilterOptions(SORT_OPTIONS, resolve)}
                  onChange={(order) =>
                    updateSearch({ order: order === "created" ? "created" : undefined })
                  }
                />
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
                />
                <SavedViewsMenu
                  kind={ISSUE_SAVED_VIEWS}
                  preferences={search}
                  onApply={(view) =>
                    // Explicit clears replace the old list scope; the selected issue stays open.
                    updateSearch({
                      who: view.who,
                      status: view.status,
                      host: view.host,
                      q: view.q,
                      label: view.label,
                      assignee: view.assignee,
                      order: view.order,
                    })
                  }
                />
                {hostOptions.length > 1 ? (
                  <FilterMenu
                    label={gt("Filter by tracker")}
                    value={search.host ?? ""}
                    options={hostOptions}
                    onChange={(host) => updateSearch({ host: host || undefined })}
                  />
                ) : null}
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={gt("Refresh issues")}
                  onClick={list.refresh}
                  disabled={list.isPending}
                >
                  <RefreshIcon size="md" refreshing={list.isPending} />
                </Button>
              </div>
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
                listEntry={panelListEntry}
                reference={{
                  projectId: renderedSurface.projectId as ProjectId,
                  tracker: renderedSurface.tracker as IssueTrackerKind,
                  ...(renderedSurface.host ? { host: renderedSurface.host } : {}),
                  scope: renderedSurface.scope,
                  key: renderedSurface.key,
                }}
                onSelectPullRequest={(reference) => {
                  useRightPanelStore.getState().openPullRequest(rightPanelRef, {
                    projectId: reference.projectId,
                    repository: reference.repository,
                    number: reference.number,
                    ...(reference.host === undefined ? {} : { host: reference.host }),
                    environmentId: panelEnvironmentId,
                  });
                }}
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
