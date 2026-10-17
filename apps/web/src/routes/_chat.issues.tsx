import { useAtomValue } from "@effect/atom-react";
import {
  continueIssueListPage,
  createIssueSourceRefreshQueue,
  holdIssueListAnswer,
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
import { IssueRef, issueHostKey, issueScopeKeyOf, pullRequestHostOf } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { IssueCreateDialog, type IssueCreateScope } from "~/components/issue/IssueCreateDialog";
import { IssueScrollSentinel } from "~/components/issue/IssueLoadMore";
import { readableFailure } from "~/components/pullRequest/pullRequestDetail.logic";
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
import {
  IssueFiltersMenu,
  compareIssueListRows,
  issueSortOptions,
  supportedIssueSort,
} from "~/components/issue/IssueListFilters";
import { IssueGlyph, issueTrackerPresentation } from "~/components/issue/issuePresentation";
import { reportIssueResult } from "~/components/issue/issueMutation";
import {
  issueCreateSources,
  issueFilterProjects,
  issueListProjectScope,
  issueListRefreshSource,
  type IssueListSources,
} from "~/components/issue/issueProjectFilter.logic";
import { PullRequestDetailPanel } from "~/components/pullRequest/PullRequestDetailPanel";
import { findScopedProject } from "~/components/pullRequest/pullRequestList.logic";
import { PullRequestListGhost } from "~/components/pullRequest/PullRequestGhosts";
import {
  PullRequestRefreshControl,
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
import { SidebarInset } from "~/components/ui/sidebar";
import { isElectron } from "~/env";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { useIssueViewRefresh } from "~/hooks/useIssueViewRefresh";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { usePanelAnimationSettings, usePanelPresence } from "~/panelAnimations";
import {
  ISSUES_PANEL_REF,
  issueRefOfSurface,
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
import { issueEnvironment, useIssueList, type IssueListTarget } from "~/state/issues";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useDebouncedValue } from "~/state/queries";
import { primaryServerKeybindingsAtom } from "~/state/server";

export interface IssuesSearch extends IssueListPreferences {
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedProjectId?: ProjectId;
  readonly selectedHost?: string;
  readonly selectedConnectionId?: string;
  readonly tracker?: string | undefined;
  readonly scope?: string | undefined;
  readonly key?: string | undefined;
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
const issueKey = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : bounded(value);
const decodeAccountSelector = Schema.decodeUnknownSync(IssueRef.fields.connectionId);
function selectedIssueHost(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== "string")
    throw new Error("The selected issue host is invalid.");
  return bounded(value);
}
function accountSelector(value: unknown): string | undefined {
  const connectionId = decodeAccountSelector(value);
  if (connectionId !== value) throw new Error("The issue account selector is invalid.");
  return connectionId;
}
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
    ...(raw.issueSort === "created" || raw.issueSort === "updated" || raw.issueSort === "comments"
      ? { issueSort: raw.issueSort }
      : {}),
    ...(raw.issueOrder === "asc" || raw.issueOrder === "desc"
      ? { issueOrder: raw.issueOrder }
      : {}),
    ...present("host", bounded(raw.host)),
    ...present("connectionId", accountSelector(raw.connectionId)),
    ...present<"environmentId", EnvironmentId>("environmentId", bounded(raw.environmentId)),
    ...present<"projectId", ProjectId>("projectId", bounded(raw.projectId)),
    // Always an own key: the router lays this over the parent route's unvalidated search.
    q: bounded(raw.q),
    ...present<"selectedEnvironmentId", EnvironmentId>(
      "selectedEnvironmentId",
      bounded(raw.selectedEnvironmentId),
    ),
    ...present<"selectedProjectId", ProjectId>("selectedProjectId", bounded(raw.selectedProjectId)),
    ...present("selectedHost", selectedIssueHost(raw.selectedHost)),
    ...present("selectedConnectionId", accountSelector(raw.selectedConnectionId)),
    tracker: bounded(raw.tracker),
    scope: bounded(raw.scope),
    key: issueKey(raw.key),
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

function trackerKey(tracker: {
  readonly tracker: string;
  readonly host: string;
  readonly connectionId?: string | undefined;
}): string {
  const key = `${tracker.tracker} ${issueHostKey(tracker.host)}`;
  return tracker.connectionId === undefined
    ? key
    : `@${encodeURIComponent(tracker.connectionId)} ${key}`;
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

  const capableEnvironments = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.issues === true,
  );
  const environmentLabels = new Map(environments.map((e) => [e.environmentId, e.label] as const));

  const capableProjects = projects.filter((project) =>
    capableEnvironments.some((e) => e.environmentId === project.environmentId),
  );
  const projectScope = issueListProjectScope(
    capableProjects,
    { projectId: search.projectId, environmentId: search.environmentId },
    projectsKnown,
  );
  const scopedProject = projectScope === "waiting" ? null : projectScope;
  const listedEnvironments =
    projectScope === "waiting"
      ? []
      : capableEnvironments.filter(
          (e) => projectScope === null || e.environmentId === projectScope.environmentId,
        );

  const sortSourceKey = JSON.stringify([
    listedEnvironments.map((environment) => environment.environmentId),
    scopedProject?.id,
    search.host,
    search.connectionId,
  ]);
  const [sortPolicy, setSortPolicy] = useState({
    sourceKey: "",
    environments: new Map<EnvironmentId, ReturnType<typeof issueSortOptions>>(),
  });
  const knownSortPolicies =
    sortPolicy.sourceKey === sortSourceKey ? [...sortPolicy.environments.values()] : [];
  const sortOptions = issueSortOptions(
    knownSortPolicies.map(({ sorts, orders }) => ({
      capabilities: { listSorts: sorts, listOrders: orders },
    })),
  );
  const effectiveSort =
    knownSortPolicies.length === 0
      ? { sort: search.issueSort ?? "updated", order: search.issueOrder ?? "desc" }
      : supportedIssueSort(search.issueSort, search.issueOrder, sortOptions);
  const debouncedQuery = useDebouncedValue(search.q ?? "", 300);
  const baseInput: IssueListInput = {
    state: search.status,
    involvement: search.who,
    sort: effectiveSort.sort,
    order: effectiveSort.order,
    ...(search.status === "all"
      ? {}
      : {
          stateCategories:
            search.status === "open"
              ? ["backlog", "unstarted", "started"]
              : ["completed", "canceled"],
        }),
    ...(scopedProject ? { projectId: scopedProject.id } : {}),
    ...(search.host ? { host: search.host } : {}),
    ...(search.connectionId === undefined ? {} : { connectionId: search.connectionId }),
    ...(debouncedQuery ? { query: debouncedQuery } : {}),
  };
  const filterKey = JSON.stringify([listedEnvironments.map((e) => e.environmentId), baseInput]);
  const [paging, setPaging] = useState<{
    readonly key: string;
    readonly pages: ReadonlyMap<EnvironmentId, HeldPage>;
  }>({ key: filterKey, pages: new Map() });
  const filterKeyRef = useRef(filterKey);
  const current = paging.key === filterKey ? paging : null;
  const targets: ReadonlyArray<IssueListTarget> = listedEnvironments.map((e) => ({
    environmentId: e.environmentId,
    input: { ...baseInput, limit: PAGE_SIZE },
  }));
  const list = useIssueList(targets);
  if (list.values.length > 0) {
    const next = new Map(sortPolicy.sourceKey === sortSourceKey ? sortPolicy.environments : []);
    let changed = sortPolicy.sourceKey !== sortSourceKey;
    for (const [environmentId, answer] of list.values) {
      const policy = issueSortOptions(
        (answer.sources ?? answer.trackers)
          .filter((source) => !("configured" in source) || source.configured)
          .map((source) => ({ capabilities: source.capabilities })),
      );
      const previous = next.get(environmentId);
      if (
        previous?.sorts.join() !== policy.sorts.join() ||
        previous?.orders.join() !== policy.orders.join()
      ) {
        next.set(environmentId, policy);
        changed = true;
      }
    }
    if (changed) setSortPolicy({ sourceKey: sortSourceKey, environments: next });
  }
  const [refreshedPages] = useState(() => new WeakMap<HeldPage, HeldPage>());
  const held = (() => {
    const refreshed = (previous: HeldPage, answer: IssueListResult) => {
      const cached = refreshedPages.get(previous);
      if (cached?.answer === answer) return cached;
      const page = { ...refreshIssueListPage(cached ?? previous, answer), answer };
      refreshedPages.set(previous, page);
      return page;
    };
    const next = new Map<EnvironmentId, HeldPage>();
    for (const [environmentId, answer] of list.values) {
      const previous = current?.pages.get(environmentId);
      next.set(
        environmentId,
        previous === undefined
          ? holdIssueListAnswer(answer)
          : previous.answer === answer
            ? previous
            : refreshed(previous, answer),
      );
    }
    for (const [environmentId, page] of current?.pages ?? []) {
      if (!next.has(environmentId)) next.set(environmentId, page);
    }
    return next;
  })();
  const [knownSources, setKnownSources] = useState(
    () => new Map<EnvironmentId, IssueListSources>(),
  );
  if (projectScope === null && !search.host && search.connectionId === undefined) {
    const changed = [...held].filter(
      ([environmentId, page]) =>
        page.sources !== undefined && knownSources.get(environmentId) !== page.sources,
    );
    if (changed.length > 0) {
      const next = new Map(knownSources);
      for (const [environmentId, page] of changed) next.set(environmentId, page.sources!);
      setKnownSources(next);
    }
  }
  const filterProjects = pullRequestFilterProjects(
    issueFilterProjects(capableProjects, knownSources, scopedProject),
    environmentLabels,
    scopedProject ?? undefined,
    true,
  );
  const heldRef = useRef(held);
  useEffect(() => {
    heldRef.current = held;
  }, [held]);

  useIssueViewRefresh(list.refresh, targets, filterKey);

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
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [pageErrors, setPageErrors] = useState(() => ({
    key: filterKey,
    errors: new Map<string, { answer: IssueListResult; error: string }>(),
  }));
  const pageRequestKey = (
    environmentId: EnvironmentId,
    tracker: Parameters<typeof trackerKey>[0],
  ) => JSON.stringify([filterKey, environmentId, trackerKey(tracker)]);
  const loadMore = async (
    environmentId: EnvironmentId,
    host: string,
    tracker: string,
    connectionId?: string,
  ) => {
    const page = held.get(environmentId);
    const cursors = page ? issueListCursorsOn(page.nextCursors, host, tracker, connectionId) : {};
    if (!page || Object.keys(cursors).length === 0 || loadingMoreRef.current) return;
    const key = filterKey;
    const requestKey = pageRequestKey(environmentId, { tracker, host, connectionId });
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const result = await loadPage({
      environmentId,
      input: {
        ...baseInput,
        ...(connectionId === undefined ? {} : { connectionId }),
        limit: PAGE_SIZE,
        cursors,
      },
    });
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (key !== filterKeyRef.current) return;
    const error =
      result._tag === "Success"
        ? result.value.errors.map((error) => error.message).join(" ")
        : readableFailure(squashAtomCommandFailure(result), "More issues could not be read.");
    setPageErrors((previous) => {
      const next = new Map(previous.key === key ? previous.errors : []);
      if (error) next.set(requestKey, { answer: page.answer, error });
      else next.delete(requestKey);
      return { key, errors: next };
    });
    if (!reportIssueResult(result, "More issues could not be read", "The server refused it."))
      return;
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
        ...(canonical.connectionId === undefined ? {} : { connectionId: canonical.connectionId }),
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
            ...(canonical.connectionId === undefined
              ? {}
              : { connectionId: canonical.connectionId }),
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
              (error.host === undefined || issueHostKey(error.host) === issueHostKey(scope.host)) &&
              error.connectionId === scope.connectionId,
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
  const groups = (() => {
    const byTracker = new Map<
      string,
      {
        tracker: IssueTrackerSummary;
        rows: EnvironmentIssueEntry[];
        errors: Array<IssueListResult["errors"][number] & { environmentId: EnvironmentId }>;
        more: EnvironmentId[];
      }
    >();
    const groupOf = (tracker: string, host: string, connectionId?: string) =>
      byTracker.get(trackerKey({ tracker, host, connectionId }));
    const needle = debouncedQuery.toLowerCase();
    for (const [environmentId, page] of held) {
      for (const tracker of page.answer.trackers) {
        const key = trackerKey(tracker);
        if (!byTracker.has(key)) byTracker.set(key, { tracker, rows: [], errors: [], more: [] });
        const group = byTracker.get(key)!;
        if (!group.tracker.configured && tracker.configured) group.tracker = tracker;
        if (
          Object.keys(
            issueListCursorsOn(
              page.nextCursors,
              tracker.host,
              tracker.tracker,
              tracker.connectionId,
            ),
          ).length > 0
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
          (error.tracker && error.host
            ? groupOf(error.tracker, error.host, error.connectionId)
            : undefined) ??
          (kind && host ? groupOf(kind, host, error.connectionId) : undefined) ??
          (error.connectionId === undefined
            ? [...byTracker.values()].find((group) => group.tracker.connectionId === undefined)
            : undefined);
        group?.errors.push({ ...error, environmentId });
      }
    }
    for (const group of byTracker.values()) {
      group.rows.sort((a, b) =>
        compareIssueListRows(a, b, effectiveSort.sort, effectiveSort.order),
      );
    }
    return [...byTracker.values()].sort((a, b) =>
      trackerKey(a.tracker).localeCompare(trackerKey(b.tracker)),
    );
  })();

  const hostOptions: ReadonlyArray<PullRequestFilterOption<string>> = (() => {
    const hosts = new Map<string, IssueTrackerSummary>();
    for (const group of groups) {
      const tracker = group.tracker;
      hosts.set(
        tracker.connectionId === undefined
          ? tracker.host
          : JSON.stringify([tracker.host, tracker.connectionId]),
        tracker,
      );
    }
    return [
      { value: "", label: "All trackers", Icon: Plug2Icon },
      ...[...hosts.entries()].map(([value, tracker]) => ({
        value,
        label:
          tracker.connectionId !== undefined
            ? `${issueTrackerPresentation(tracker.tracker).providerName} (${tracker.host}) · ${tracker.connectionId}`
            : hosts.size > 1 &&
                issueTrackerPresentation(tracker.tracker).providerName === tracker.host
              ? tracker.host
              : `${issueTrackerPresentation(tracker.tracker).providerName} (${tracker.host})`,
        Icon: issueTrackerPresentation(tracker.tracker).Icon,
        ...(tracker.configured ? {} : { unavailable: tracker.detail ?? "Unavailable" }),
      })),
      ...(search.connectionId !== undefined &&
      !hosts.has(JSON.stringify([search.host, search.connectionId]))
        ? [
            {
              value: JSON.stringify([search.host, search.connectionId]),
              label: `${search.host ?? "Tracker"} · ${search.connectionId}`,
              Icon: Plug2Icon,
              unavailable: "This account is not available",
            },
          ]
        : []),
    ];
  })();
  const projectOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: "", label: "All projects", Icon: LayersIcon },
    ...filterProjects.map((project) => ({
      value: pullRequestProjectKey(project),
      label: project.title,
      Icon: FolderGit2Icon,
      project,
    })),
  ];
  const offeredInvolvements = (() => {
    const offered = offeredIssueInvolvements(
      groups.map((group) => group.tracker),
      search.who,
    );
    return offered === null
      ? INVOLVEMENT_TABS
      : INVOLVEMENT_TABS.filter((tab) => offered.has(tab.value));
  })();

  const updateSearch = (patch: { [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined }) =>
    void navigate({
      search: (previous: IssuesSearch): IssuesSearch => {
        const next = { ...previous, ...patch };
        return {
          who: next.who ?? previous.who,
          status: next.status ?? previous.status,
          ...(next.issueSort ? { issueSort: next.issueSort } : {}),
          ...(next.issueOrder ? { issueOrder: next.issueOrder } : {}),
          ...(next.host ? { host: next.host } : {}),
          ...(next.connectionId === undefined ? {} : { connectionId: next.connectionId }),
          ...(next.environmentId ? { environmentId: next.environmentId } : {}),
          ...(next.projectId ? { projectId: next.projectId } : {}),
          q: next.q || undefined,
          ...(next.selectedEnvironmentId
            ? { selectedEnvironmentId: next.selectedEnvironmentId }
            : {}),
          ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
          ...(next.selectedHost ? { selectedHost: next.selectedHost } : {}),
          ...(next.selectedConnectionId === undefined
            ? {}
            : { selectedConnectionId: next.selectedConnectionId }),
          ...(next.tracker ? { tracker: next.tracker } : {}),
          ...(next.scope ? { scope: next.scope } : {}),
          ...(next.key ? { key: next.key } : {}),
        };
      },
      replace: true,
    });
  const clearedSelection = {
    selectedEnvironmentId: undefined,
    selectedProjectId: undefined,
    selectedHost: undefined,
    selectedConnectionId: undefined,
    tracker: undefined,
    scope: undefined,
    key: undefined,
  } as const;
  const updateListScope = (patch: {
    [Key in keyof IssueListPreferences]?: IssueListPreferences[Key] | undefined;
  }) => {
    writeIssueListPreferences(
      issueListPreferences({
        ...search,
        ...patch,
        who: patch.who ?? search.who,
        status: patch.status ?? search.status,
      }),
    );
    updateSearch(patch);
  };

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
  const hasIssueSelection = Boolean(
    search.selectedProjectId && search.tracker && search.scope && search.key,
  );
  const selectedIssueEnvironmentId =
    search.selectedEnvironmentId ??
    (projectsKnown
      ? findScopedProject(projects, undefined, search.selectedProjectId)?.environmentId
      : undefined);
  const panelProject =
    renderedSurface?.environmentId !== undefined
      ? findScopedProject(projects, renderedSurface.environmentId, renderedSurface.projectId)
      : undefined;
  const panelEnvironmentId =
    panelProject !== undefined &&
    environments.some(
      (environment) =>
        environment.environmentId === panelProject.environmentId &&
        (renderedSurface?.kind === "issue"
          ? environment.serverConfig?.environment.capabilities.issues
          : environment.serverConfig?.environment.capabilities.pullRequests) === true,
    ) &&
    (!hasIssueSelection || selectedIssueEnvironmentId === panelProject.environmentId)
      ? panelProject.environmentId
      : null;

  const selectSurfaceInUrl = (surface: RightPanelSurface | null) =>
    updateSearch(
      surface?.kind === "issue"
        ? {
            selectedEnvironmentId: surface.environmentId as EnvironmentId | undefined,
            selectedProjectId: surface.projectId as ProjectId,
            selectedHost: surface.host,
            selectedConnectionId: surface.connectionId,
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
      selectedConnectionId: entry.connectionId,
      tracker: entry.tracker,
      scope: entry.scope,
      key: entry.key,
    });
  };

  const updateSelectedEnvironment = useEffectEvent((environmentId: EnvironmentId) =>
    updateSearch({ selectedEnvironmentId: environmentId }),
  );
  // A link into the page names an issue before any row was pressed.
  useEffect(() => {
    if (
      rightPanelRef === null ||
      !search.tracker ||
      !search.scope ||
      !search.key ||
      !search.selectedProjectId ||
      selectedIssueEnvironmentId === undefined
    )
      return;
    useRightPanelStore.getState().openIssue(rightPanelRef, {
      environmentId: selectedIssueEnvironmentId,
      projectId: search.selectedProjectId,
      tracker: search.tracker,
      ...(search.selectedHost === undefined ? {} : { host: search.selectedHost }),
      ...(search.selectedConnectionId === undefined
        ? {}
        : { connectionId: search.selectedConnectionId }),
      scope: search.scope,
      key: search.key,
    });
    if (search.selectedEnvironmentId === undefined)
      updateSelectedEnvironment(selectedIssueEnvironmentId);
  }, [
    rightPanelRef,
    search.selectedHost,
    search.selectedConnectionId,
    search.tracker,
    search.scope,
    search.key,
    search.selectedProjectId,
    search.selectedEnvironmentId,
    selectedIssueEnvironmentId,
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
  const createScopes: ReadonlyArray<IssueCreateScope> = (() => {
    const scopes: IssueCreateScope[] = [];
    const seen = new Set<string>();
    const known = (
      environmentId: EnvironmentId,
      tracker: string,
      host: string,
      scope: string,
      connectionId?: string,
    ) => {
      const key = issueScopeKey(environmentId, { tracker, host, scope, connectionId });
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    };
    for (const [environmentId, page] of held) {
      if (page.sources !== undefined) {
        for (const source of issueCreateSources(page.answer, page.sources)) {
          if (known(environmentId, source.tracker, source.host, source.scope, source.connectionId))
            continue;
          scopes.push({
            environmentId,
            projectTitle: source.projectTitle,
            templates: source.capabilities.templates,
            labels: source.capabilities.labels,
            assignees: source.capabilities.assignees,
            maxAssignees: source.capabilities.maxAssignees,
            ...(source.capabilities.createFields === undefined
              ? {}
              : { createFields: source.capabilities.createFields }),
            ...(source.capabilities.createIssueTypes === undefined
              ? {}
              : { createIssueTypes: source.capabilities.createIssueTypes }),
            scope: {
              ...(source.connectionId === undefined ? {} : { connectionId: source.connectionId }),
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
          (t) =>
            String(t.tracker) === kind &&
            issueHostKey(t.host) === issueHostKey(host) &&
            t.connectionId === undefined,
        );
        if (!tracker?.configured || tracker.capabilities?.create !== true) continue;
        if (known(environmentId, tracker.tracker, host, scope)) continue;
        scopes.push({
          environmentId,
          projectTitle: project.title,
          templates: tracker.capabilities.templates,
          labels: tracker.capabilities.labels,
          assignees: tracker.capabilities.assignees,
          maxAssignees: tracker.capabilities.maxAssignees,
          ...(tracker.capabilities.createFields === undefined
            ? {}
            : { createFields: tracker.capabilities.createFields }),
          ...(tracker.capabilities.createIssueTypes === undefined
            ? {}
            : { createIssueTypes: tracker.capabilities.createIssueTypes }),
          scope: { projectId: project.id, tracker: tracker.tracker, host, scope },
        });
      }
    }
    return scopes;
  })();
  const [createOpen, setCreateOpen] = useState(false);

  const showTracker = groups.length > 1;
  const noneAnswered = held.size === 0;

  const listBody: ReactNode = !issuesSupported ? (
    <PullRequestsUnavailableState
      title="Issues unavailable"
      icon={<IssueGlyph.issue />}
      error="Update this environment's T3 Code server to browse issues."
    />
  ) : noneAnswered && (list.isPending || projectScope === "waiting") ? (
    <PullRequestListGhost label="Loading issues" />
  ) : noneAnswered && list.error ? (
    <PullRequestsUnavailableState
      title="Could not load issues"
      icon={<IssueGlyph.issue />}
      error={list.error}
      onRetry={() => list.refresh()}
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
              {group.tracker.connectionId === undefined ? null : ` · ${group.tracker.connectionId}`}
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
                key={JSON.stringify([
                  error.environmentId,
                  error.projectId,
                  error.tracker,
                  error.host,
                  error.connectionId,
                ])}
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
            {group.more.map((environmentId) => {
              const requestKey = pageRequestKey(environmentId, group.tracker);
              const failure =
                pageErrors.key === filterKey ? pageErrors.errors.get(requestKey) : undefined;
              return (
                <IssueScrollSentinel
                  key={requestKey}
                  hasMore
                  isPending={loadingMore}
                  error={
                    failure?.answer === held.get(environmentId)?.answer
                      ? (failure?.error ?? null)
                      : null
                  }
                  loadMore={() =>
                    void loadMore(
                      environmentId,
                      group.tracker.host,
                      group.tracker.tracker,
                      group.tracker.connectionId,
                    )
                  }
                />
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
                    onChange={(q) => updateListScope({ q: q || undefined })}
                    placeholder="Search issues, or label:bug"
                    aria-label="Search issues"
                  />
                </div>
                <IssueFiltersMenu
                  state={search.status}
                  stateOptions={STATE_TABS}
                  onState={(status) => updateListScope({ status })}
                  involvement={search.who}
                  involvementOptions={offeredInvolvements}
                  onInvolvement={(who) => updateListScope({ who })}
                  project={scopedProject ? pullRequestProjectKey(scopedProject) : ""}
                  projectOptions={projectOptions}
                  onProject={(key) => {
                    const project = filterProjects.find(
                      (candidate) => pullRequestProjectKey(candidate) === key,
                    );
                    updateListScope({
                      projectId: project?.id,
                      environmentId: project?.environmentId,
                    });
                  }}
                  tracker={
                    search.connectionId === undefined
                      ? (search.host ?? "")
                      : JSON.stringify([search.host, search.connectionId])
                  }
                  trackerOptions={hostOptions}
                  onTracker={(value) => {
                    const tracker = groups.find(
                      (group) =>
                        group.tracker.connectionId !== undefined &&
                        JSON.stringify([group.tracker.host, group.tracker.connectionId]) === value,
                    )?.tracker;
                    updateListScope({
                      host: tracker?.host ?? (value || undefined),
                      connectionId: tracker?.connectionId,
                    });
                  }}
                  sorts={sortOptions.sorts}
                  sort={effectiveSort.sort}
                  orders={sortOptions.orders}
                  order={effectiveSort.order}
                  onSort={(issueSort) => updateListScope({ issueSort })}
                  onOrder={(issueOrder) => updateListScope({ issueOrder })}
                />
                <PullRequestRefreshControl
                  aria-label="Refresh issues"
                  refreshing={list.isPending}
                  onRefresh={() => list.refresh()}
                />
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
                    onClick={() => list.refresh()}
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
                reference={issueRefOfSurface(renderedSurface)}
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
                      ...(renderedSurface.connectionId === undefined
                        ? {}
                        : { connectionId: renderedSurface.connectionId }),
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
            ...(scope.scope.connectionId === undefined
              ? {}
              : { connectionId: scope.scope.connectionId }),
            scope: scope.scope.scope,
            key: result.key,
            url: result.url,
          });
        }}
      />
    </SidebarInset>
  );
}
