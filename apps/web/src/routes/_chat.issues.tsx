import { useAtomValue } from "@effect/atom-react";
import { issueEntryKey, mergeIssueListPage } from "@t3tools/client-runtime/state/issues";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListCursors,
  IssueListEntry,
  IssueListInput,
  IssueListResult,
  IssueListState,
  IssueTrackerKind,
  IssueTrackerSummary,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { pullRequestHostOf } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AtSignIcon,
  CircleCheckIcon,
  LayersIcon,
  PenLineIcon,
  Plug2Icon,
  PlusIcon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

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
import { PullRequestDetailPanel } from "~/components/pullRequest/PullRequestDetailPanel";
import { PullRequestListGhost } from "~/components/pullRequest/PullRequestGhosts";
import {
  PullRequestFilterOptionIcon,
  PullRequestSearchInput,
  type PullRequestFilterOption,
} from "~/components/pullRequest/PullRequestListFilters";
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
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { isElectron } from "~/env";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
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
import { useProjects } from "~/state/entities";
import { useEnvironments, useIssuesSupported } from "~/state/environments";
import { issueEnvironment, useIssueList, type IssueListTarget } from "~/state/issues";
import { useDebouncedValue } from "~/state/queries";
import { primaryServerKeybindingsAtom } from "~/state/server";

export interface IssuesSearch extends IssueListPreferences {
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedProjectId?: ProjectId;
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
    // Always an own key: the router lays this over the parent route's unvalidated search.
    q: bounded(raw.q),
    ...present<"selectedEnvironmentId", EnvironmentId>(
      "selectedEnvironmentId",
      bounded(raw.selectedEnvironmentId),
    ),
    ...present<"selectedProjectId", ProjectId>("selectedProjectId", bounded(raw.selectedProjectId)),
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
}

function trackerKey(tracker: Pick<IssueTrackerSummary, "tracker" | "host">): string {
  return `${tracker.tracker} ${tracker.host.toLowerCase()}`;
}

function IssuesRoute() {
  const navigate = useNavigate({ from: "/issues" });
  const search = Route.useSearch();
  const { environments } = useEnvironments();
  const projects = useProjects();
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

  const debouncedQuery = useDebouncedValue(search.q ?? "", 300);
  const listInput = useMemo<IssueListInput>(
    () => ({
      state: search.status,
      involvement: search.who,
      limit: PAGE_SIZE,
      ...(search.host ? { host: search.host } : {}),
      ...(debouncedQuery ? { query: debouncedQuery } : {}),
    }),
    [search.status, search.who, search.host, debouncedQuery],
  );
  const targets = useMemo<ReadonlyArray<IssueListTarget>>(
    () => capableEnvironments.map((e) => ({ environmentId: e.environmentId, input: listInput })),
    [capableEnvironments, listInput],
  );
  const list = useIssueList(targets);
  useLiveRefresh(list.refresh, { key: JSON.stringify(targets) });

  // Continuations are laid over the first page they continue; a new first page forgets them.
  const [pages, setPages] = useState<ReadonlyMap<EnvironmentId, HeldPage>>(new Map());
  const held = useMemo(() => {
    const next = new Map<EnvironmentId, HeldPage>();
    for (const [environmentId, answer] of list.answers) {
      const previous = pages.get(environmentId);
      next.set(
        environmentId,
        previous?.answer === answer
          ? previous
          : { answer, entries: answer.entries, nextCursors: answer.nextCursors },
      );
    }
    return next;
  }, [list.answers, pages]);
  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  const [loadingMore, setLoadingMore] = useState<EnvironmentId | null>(null);
  const loadMore = async (environmentId: EnvironmentId) => {
    const page = held.get(environmentId);
    if (!page || Object.keys(page.nextCursors).length === 0 || loadingMore !== null) return;
    setLoadingMore(environmentId);
    const result = await loadPage({
      environmentId,
      input: { ...listInput, cursors: page.nextCursors },
    });
    setLoadingMore(null);
    if (result._tag === "Failure") return;
    setPages((current) => {
      const next = new Map(current);
      next.set(environmentId, {
        answer: page.answer,
        entries: mergeIssueListPage(page.entries, result.value.entries),
        nextCursors: result.value.nextCursors,
      });
      return next;
    });
  };

  // Rows grouped per tracker account, so a tracker that cannot be read says so where its rows
  // would be, and each tracker's rows carry on from their own cursors.
  const groups = useMemo(() => {
    const byTracker = new Map<
      string,
      {
        tracker: IssueTrackerSummary;
        rows: EnvironmentIssueEntry[];
        errors: Array<{ projectTitle: string; message: string; environmentId: EnvironmentId }>;
        more: EnvironmentId[];
      }
    >();
    const needle = debouncedQuery.toLowerCase();
    for (const [environmentId, page] of held) {
      for (const tracker of page.answer.trackers) {
        const key = trackerKey(tracker);
        if (!byTracker.has(key)) byTracker.set(key, { tracker, rows: [], errors: [], more: [] });
        const group = byTracker.get(key)!;
        if (!group.tracker.configured && tracker.configured) group.tracker = tracker;
        if (Object.keys(page.nextCursors).some((c) => c.startsWith(`${tracker.host} `)))
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
      for (const error of page.answer.errors) {
        const project = projects.find(
          (p) => p.environmentId === environmentId && p.id === error.projectId,
        );
        const kind = project?.repositoryIdentity?.provider as SourceControlProviderKind | undefined;
        const host = kind ? pullRequestHostOf(project?.repositoryIdentity, kind) : null;
        const group =
          (host ? byTracker.get(`${kind} ${host.toLowerCase()}`) : undefined) ??
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

  const updateSearch = useCallback(
    (patch: { [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined }) =>
      void navigate({
        search: (previous: IssuesSearch): IssuesSearch => {
          const next = { ...previous, ...patch };
          return {
            who: next.who ?? previous.who,
            status: next.status ?? previous.status,
            ...(next.host ? { host: next.host } : {}),
            q: next.q || undefined,
            ...(next.selectedEnvironmentId
              ? { selectedEnvironmentId: next.selectedEnvironmentId }
              : {}),
            ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
            ...(next.tracker ? { tracker: next.tracker } : {}),
            ...(next.scope ? { scope: next.scope } : {}),
            ...(next.key ? { key: next.key } : {}),
          };
        },
      }),
    [navigate],
  );
  const clearedSelection = {
    selectedEnvironmentId: undefined,
    selectedProjectId: undefined,
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
  const panelEnvironmentId =
    (renderedSurface?.environmentId as EnvironmentId | undefined) ??
    capableEnvironments[0]?.environmentId ??
    null;

  const selectSurfaceInUrl = (surface: RightPanelSurface | null) =>
    updateSearch(
      surface?.kind === "issue"
        ? {
            selectedEnvironmentId: surface.environmentId as EnvironmentId | undefined,
            selectedProjectId: surface.projectId as ProjectId,
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
      !search.selectedProjectId
    )
      return;
    useRightPanelStore.getState().openIssue(rightPanelRef, {
      ...(search.selectedEnvironmentId === undefined
        ? {}
        : { environmentId: search.selectedEnvironmentId }),
      projectId: search.selectedProjectId,
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
  const createScopes = useMemo<ReadonlyArray<IssueCreateScope>>(() => {
    const scopes: IssueCreateScope[] = [];
    for (const [environmentId, page] of held) {
      for (const project of projects) {
        if (project.environmentId !== environmentId) continue;
        const identity = project.repositoryIdentity;
        const kind = identity?.provider as SourceControlProviderKind | undefined;
        const scope = sourceControlRepositorySelector(identity);
        if (!identity || !kind || scope === null) continue;
        const host = pullRequestHostOf(identity, kind);
        const tracker = page.answer.trackers.find(
          (t) => String(t.tracker) === kind && t.host.toLowerCase() === host.toLowerCase(),
        );
        if (!tracker?.configured || tracker.capabilities?.create !== true) continue;
        if (
          scopes.some(
            (s) => s.scope.scope.toLowerCase() === scope.toLowerCase() && s.scope.host === host,
          )
        )
          continue;
        scopes.push({
          environmentId,
          projectTitle: project.title,
          templates: tracker.capabilities.templates,
          scope: { projectId: project.id, tracker: tracker.tracker, host, scope },
        });
      }
    }
    return scopes;
  }, [held, projects]);
  const [createOpen, setCreateOpen] = useState(false);

  const showTracker = groups.length > 1;
  const noneAnswered = list.answers.length === 0;

  const listBody: ReactNode = !issuesSupported ? (
    <PullRequestsUnavailableState
      title="Issues unavailable"
      error="Update this environment's T3 Code server to browse issues."
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
        <EmptyTitle>No trackers to read</EmptyTitle>
        <EmptyDescription>Add a project whose remote is on a supported tracker.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <div className="flex flex-col gap-6">
      {groups.map((group) => {
        const presentation = issueTrackerPresentation(group.tracker.tracker);
        const showScope = new Set(group.rows.map((row) => row.scope.toLowerCase())).size > 1;
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
                key={`${error.environmentId}:${error.projectTitle}`}
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
                onClick={() => void loadMore(environmentId)}
              >
                {loadingMore === environmentId ? "Loading…" : "Load more"}
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
                  options={INVOLVEMENT_TABS}
                  onChange={(who) => updateSearch({ who })}
                />
                {hostOptions.length > 2 ? (
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
      <IssueCreateDialog
        open={createOpen}
        scopes={createScopes}
        onOpenChange={setCreateOpen}
        onCreated={(scope, result) => {
          list.refresh();
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
