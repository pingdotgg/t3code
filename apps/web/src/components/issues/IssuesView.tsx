import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type IssueListInput,
  type IssueListSort,
  type IssueListState,
  type IssuePullRequest,
  type IssueRef,
  ISSUE_STATUSES,
  type IssueStatus,
  issueStatusOf,
  parseIssueUrl,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowDownUpIcon,
  CalendarArrowDownIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  HashIcon,
  LayersIcon,
  ListFilterIcon,
  ListTreeIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  SearchIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { issueDetailRead, useIssueList } from "~/state/issues";
import type { EnvironmentQueryTarget } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { IssueDetailPanel } from "./IssueDetailPanel";
import {
  buildIssueTree,
  collectIssueFacets,
  environmentIdsWithCapability,
  issueKey,
  matchesIssueFilters,
  repositoryKey,
  sortIssues,
  type EnvironmentIssueEntry,
  type IssueListFilters,
  type IssueTreeNode,
} from "./issueList.logic";
import { publishIssuePaletteSource } from "./issuePaletteStore";
import { resolveIssuePanelEnvironment } from "./issueLinks.logic";
import { ISSUE_STATUS_PRESENTATION, IssueStateGlyph, IssueStatusGlyph } from "./issuePresentation";
import {
  COLLAPSED_ISSUE_STATUSES,
  groupIssuesByStatus,
  issueStatusInputOf,
  matchesIssueStatusFilters,
  type IssueRowThread,
  type IssueStatusFilters,
} from "./issueStatus.logic";
import { ListModeToggle } from "./ListModeToggle";
import { useIssueRowThreads } from "./useIssueRowThreads";
import { useStartThreadFromIssue } from "./useStartThreadFromIssue";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const PREFERENCES_KEY = "t3code:issue-list-preferences";

const STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const satisfies ReadonlyArray<{ value: IssueListState; label: string }>;

const SORT_OPTIONS = [
  { value: "updated", label: "Recently updated", Icon: ClockIcon },
  { value: "created", label: "Newest", Icon: CalendarArrowDownIcon },
  { value: "number", label: "Number", Icon: HashIcon },
] as const satisfies ReadonlyArray<{ value: IssueListSort; label: string; Icon: unknown }>;

interface IssueListPreferences {
  readonly state: IssueListState;
  readonly sort: IssueListSort;
  readonly groupByParent: boolean;
}

const DEFAULT_PREFERENCES: IssueListPreferences = {
  state: "open",
  sort: "updated",
  groupByParent: false,
};

function readPreferences(): IssueListPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    return {
      state: STATE_OPTIONS.find((option) => option.value === raw.state)?.value ?? "open",
      sort: SORT_OPTIONS.find((option) => option.value === raw.sort)?.value ?? "updated",
      groupByParent: raw.groupByParent === true,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

interface SelectedIssue {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRef;
}

const LINKED_OPTIONS = [
  { value: "", label: "Linked or not" },
  { value: "linked", label: "Linked to a thread" },
  { value: "unlinked", label: "Not linked" },
] as const;

const NO_THREADS: ReadonlyArray<IssueRowThread> = [];
const NO_LOGINS: ReadonlySet<string> = new Set();
const NO_LINKED_PULL_REQUESTS: ReadonlyMap<string, IssuePullRequest> = new Map();

interface IssueRowFacts {
  readonly status: IssueStatus;
  readonly threads: ReadonlyArray<IssueRowThread>;
}

/** The Issues half of the Pull Requests page (`/pull-requests?view=issues`). GitHub only. */
export function IssuesView() {
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environmentIdsWithCapability(environments, "issues"),
    [environments],
  );
  const capabilityKnown = environments.some((environment) => environment.serverConfig !== null);
  const projects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();

  const [preferences, setPreferences] = useState(readPreferences);
  const updatePreferences = useCallback((patch: Partial<IssueListPreferences>) => {
    setPreferences((previous) => {
      const next = { ...previous, ...patch };
      try {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
      } catch {
        // Storage is optional; the choice still holds for this visit.
      }
      return next;
    });
  }, []);
  const [searchValue, setSearchValue] = useState("");
  const query = useDebouncedValue(searchValue.trim(), SEARCH_DEBOUNCE_MS);
  const [filters, setFilters] = useState<IssueListFilters & IssueStatusFilters>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<IssueStatus>>(COLLAPSED_ISSUE_STATUSES);
  const navigate = useNavigate();
  const search = useSearch({ from: "/_chat/pull-requests" });

  // The open side panel lives in the URL, so a thread's linked Issue can open it from elsewhere.
  const selected = useMemo((): SelectedIssue | null => {
    const reference = search.issue === undefined ? null : parseIssueUrl(search.issue);
    if (reference === null) return null;
    const environmentId = resolveIssuePanelEnvironment(
      reference,
      search.selectedEnvironmentId,
      projects,
      {
        issues: environmentIdsWithCapability(environments, "issues"),
        issueLinks: environmentIdsWithCapability(environments, "issueLinks"),
      },
    );
    return environmentId === null ? null : { environmentId, reference };
  }, [environments, projects, search.issue, search.selectedEnvironmentId]);
  const selectedKey = selected === null ? null : issueKey(selected.reference);
  const select = useCallback(
    (next: { readonly environmentId: EnvironmentId; readonly url: string } | null) =>
      void navigate({
        to: "/pull-requests",
        search: (() => {
          const { issue: _issue, selectedEnvironmentId: _environmentId, ...rest } = search;
          return next === null
            ? rest
            : { ...rest, issue: next.url, selectedEnvironmentId: next.environmentId };
        })(),
        replace: true,
      }),
    [navigate, search],
  );

  // Repository, labels and milestone narrow the search on GitHub too, so the rows are complete
  // rather than a filter over one page. Parent narrows only the loaded rows.
  const baseInput = useMemo((): IssueListInput => {
    const repository = filters.repository?.split(" ");
    return {
      state: preferences.state,
      sort: preferences.sort,
      limit: PAGE_SIZE,
      ...(query.length > 0 ? { query: query.slice(0, 200) } : {}),
      ...(filters.labels && filters.labels.length > 0 ? { labels: filters.labels } : {}),
      ...(filters.milestone ? { milestone: filters.milestone } : {}),
      ...(repository?.length === 2 ? { repositories: [filters.repository!] } : {}),
    };
  }, [
    filters.labels,
    filters.milestone,
    filters.repository,
    preferences.sort,
    preferences.state,
    query,
  ]);
  const baseKey = JSON.stringify(baseInput);
  const [pages, setPages] = useState<{
    readonly key: string;
    readonly targets: ReadonlyArray<EnvironmentQueryTarget<IssueListInput>>;
  }>({ key: baseKey, targets: [] });
  const continuations = pages.key === baseKey ? pages.targets : [];
  const targets = useMemo(
    () => [
      ...environmentIds.map((environmentId) => ({ environmentId, input: baseInput })),
      ...continuations,
    ],
    [baseInput, continuations, environmentIds],
  );
  const list = useIssueList(targets);
  const data = list.data;

  const loadMore = useCallback(() => {
    if (data === null || data.nextCursors.size === 0) return;
    // A page already asked for is retried through Retry, not asked for twice.
    const asked = new Set(continuations.map((target) => JSON.stringify(target)));
    const next = [...data.nextCursors]
      .map(([environmentId, cursors]) => ({ environmentId, input: { ...baseInput, cursors } }))
      .filter((target) => !asked.has(JSON.stringify(target)));
    if (next.length === 0) return;
    setPages({ key: baseKey, targets: [...continuations, ...next] });
  }, [baseInput, baseKey, continuations, data]);

  const refresh = useCallback(() => list.refresh(), [list]);

  const linkEnvironments = useMemo(
    () => new Set(environmentIdsWithCapability(environments, "issueLinks")),
    [environments],
  );
  const { threadsByIssue, working } = useIssueRowThreads(data?.entries ?? [], linkEnvironments);
  const facts = useMemo(() => {
    const byKey = new Map<string, IssueRowFacts>();
    for (const entry of data?.entries ?? []) {
      const threads = threadsByIssue.get(issueKey(entry)) ?? NO_THREADS;
      byKey.set(issueKey(entry), {
        threads,
        status: issueStatusOf(
          issueStatusInputOf(entry, threads, {
            working,
            linkedPullRequests: data!.linkedPullRequests,
            trustedLogins: data!.trustedLogins.get(issueKey(entry)) ?? NO_LOGINS,
          }),
        ),
      });
    }
    return byKey;
  }, [data, threadsByIssue, working]);
  const factsOf = useCallback(
    (entry: EnvironmentIssueEntry): IssueRowFacts =>
      facts.get(issueKey(entry)) ?? { status: "to-do", threads: NO_THREADS },
    [facts],
  );

  const visible = useMemo(
    () =>
      data === null
        ? []
        : sortIssues(
            data.entries.filter((entry) => {
              if (!matchesIssueFilters(entry, filters)) return false;
              const { status, threads } = factsOf(entry);
              return matchesIssueStatusFilters(
                { status, linkedThreadCount: threads.length },
                filters,
              );
            }),
            preferences.sort,
          ),
    [data, factsOf, filters, preferences.sort],
  );
  const statusGroups = useMemo(
    () =>
      preferences.groupByParent
        ? null
        : groupIssuesByStatus(visible, (entry) => factsOf(entry).status),
    [factsOf, preferences.groupByParent, visible],
  );
  const facets = useMemo(() => collectIssueFacets(data?.entries ?? []), [data]);
  const projectRepositories = useMemo(
    () =>
      new Set(
        (data?.repositories ?? []).map((repository) =>
          repositoryKey(repository.host, repository.repository),
        ),
      ),
    [data],
  );
  const tree = useMemo(
    () => (preferences.groupByParent ? buildIssueTree(visible, projectRepositories) : null),
    [preferences.groupByParent, projectRepositories, visible],
  );

  const open = useCallback(
    (entry: EnvironmentIssueEntry) =>
      select({ environmentId: entry.environmentId, url: entry.url }),
    [select],
  );
  const openThread = useCallback(
    (thread: IssueRowThread) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      }),
    [navigate],
  );
  const { resolve: resolveStart, start: startFromIssue } = useStartThreadFromIssue();
  const readDetail = useAtomCommand(issueDetailRead, { reportFailure: false });
  // The row whose thread is being started; its button waits and repeat clicks do nothing.
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const starting = useRef(false);
  // The list carries no bodies; read the one Issue, and start with title and URL if that fails.
  const startFromEntry = useCallback(
    async (entry: EnvironmentIssueEntry) => {
      if (starting.current) return;
      starting.current = true;
      setStartingKey(issueKey(entry));
      const reference = { host: entry.host, repository: entry.repository, number: entry.number };
      const detail = await readDetail({ environmentId: entry.environmentId, input: reference });
      await startFromIssue({
        ...reference,
        url: entry.url,
        title: entry.title,
        body: detail._tag === "Success" ? detail.value.body : null,
      }).finally(() => {
        starting.current = false;
        setStartingKey(null);
      });
    },
    [readDetail, startFromIssue],
  );
  const startDisabledReason = useCallback(
    (entry: EnvironmentIssueEntry) => {
      const target = resolveStart(entry);
      return "reason" in target ? target.reason : null;
    },
    [resolveStart],
  );
  const renderRow = (entry: EnvironmentIssueEntry, showStatusLabel: boolean) => {
    const { status, threads } = factsOf(entry);
    return (
      <IssueRow
        entry={entry}
        status={status}
        showStatusLabel={showStatusLabel}
        threads={threads}
        showProject={projectRepositories.size > 1}
        selected={selectedKey === issueKey(entry)}
        startDisabledReason={startDisabledReason(entry)}
        starting={startingKey === issueKey(entry)}
        startBusy={startingKey !== null}
        onOpen={open}
        onOpenThread={openThread}
        onStart={startFromEntry}
      />
    );
  };
  // The command palette searches what the page shows while it is open.
  useEffect(() => {
    publishIssuePaletteSource({ entries: visible, open });
  }, [open, visible]);
  useEffect(() => () => publishIssuePaletteSource(null), []);

  const selectedCwd =
    selected === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === selected.environmentId &&
            project.repositoryIdentity?.canonicalKey?.toLowerCase() ===
              `${selected.reference.host}/${selected.reference.repository}`.toLowerCase(),
        )?.workspaceRoot ??
        projects.find((project) => project.environmentId === selected.environmentId)
          ?.workspaceRoot ??
        null);

  const repositoryOptions = data?.repositories ?? [];
  const activeFilterCount =
    (filters.repository ? 1 : 0) +
    (filters.labels?.length ?? 0) +
    (filters.milestone ? 1 : 0) +
    (filters.parent ? 1 : 0) +
    (filters.statuses?.length ?? 0) +
    (filters.linked ? 1 : 0);

  let body: ReactNode;
  if (environmentIds.length === 0) {
    body = (
      <EmptyState>
        {capabilityKnown ? "No connected server can read Issues." : <Spinner aria-hidden />}
      </EmptyState>
    );
  } else if (data === null) {
    body = list.error ? (
      <EmptyState>{list.error}</EmptyState>
    ) : (
      <EmptyState>
        <Spinner aria-label="Loading Issues" />
      </EmptyState>
    );
  } else if (data.repositories.length === 0 && projectsKnown) {
    body = (
      <EmptyState>
        {data.unsupported.length > 0
          ? "None of your projects are on GitHub. Issues are read from GitHub only."
          : "Add a project with a GitHub repository to see its Issues."}
      </EmptyState>
    );
  } else if (visible.length === 0) {
    body = <EmptyState>{list.isPending ? <Spinner aria-hidden /> : "No Issues match."}</EmptyState>;
  } else {
    body = (
      <ul className="flex flex-col">
        {tree === null
          ? (statusGroups ?? []).map((group) => (
              <IssueStatusGroup
                key={group.status}
                status={group.status}
                count={group.entries.length}
                collapsed={collapsed.has(group.status)}
                onToggle={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (!next.delete(group.status)) next.add(group.status);
                    return next;
                  })
                }
              >
                {group.entries.map((entry) => (
                  <li key={issueKey(entry)}>{renderRow(entry, false)}</li>
                ))}
              </IssueStatusGroup>
            ))
          : tree.map((node) => (
              <IssueTreeItem key={node.key} node={node} depth={0} renderRow={renderRow} />
            ))}
      </ul>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader electron={isElectron} className="bg-background">
            <WorkspaceBreadcrumb ariaLabel="Issues breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Issues</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="[-webkit-app-region:no-drag]">
              <ListModeToggle mode="issues" />
            </div>
            <div className="min-w-0 flex-1" />
          </WorkspacePageHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <InputGroup className="min-w-0 flex-1 basis-60 **:[input]:h-9 sm:**:[input]:h-8">
                  <InputGroupAddon>
                    {list.isPending && query.length > 0 ? (
                      <Spinner aria-hidden />
                    ) : (
                      <SearchIcon aria-hidden />
                    )}
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    value={searchValue}
                    onChange={(event) => setSearchValue(event.currentTarget.value)}
                    placeholder="Search Issues"
                    aria-label="Search Issues"
                  />
                </InputGroup>
                <RadioMenu
                  label="State"
                  value={preferences.state}
                  options={STATE_OPTIONS}
                  onChange={(state) => updatePreferences({ state })}
                />
                <RadioMenu
                  label="Sort"
                  icon={<ArrowDownUpIcon aria-hidden className="size-4" />}
                  value={preferences.sort}
                  options={SORT_OPTIONS}
                  onChange={(sort) => updatePreferences({ sort })}
                />
                <Menu>
                  <MenuTrigger render={<Button variant="outline" />}>
                    <ListFilterIcon aria-hidden className="size-4" />
                    <span>Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</span>
                  </MenuTrigger>
                  <MenuPopup align="end" side="bottom" className="max-h-96">
                    <MenuGroup>
                      <MenuGroupLabel>Repository</MenuGroupLabel>
                      <MenuRadioGroup
                        value={filters.repository ?? ""}
                        onValueChange={(value) =>
                          setFilters((previous) => ({
                            ...previous,
                            repository: value === "" ? undefined : (value as string),
                          }))
                        }
                      >
                        <MenuRadioItem value="">All projects</MenuRadioItem>
                        {repositoryOptions.map((repository) => (
                          <MenuRadioItem
                            key={repositoryKey(repository.host, repository.repository)}
                            value={`${repository.host} ${repository.repository}`}
                          >
                            {repository.projectTitle}
                            <span className="text-muted-foreground"> {repository.repository}</span>
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                    {facets.labels.length > 0 ? (
                      <>
                        <MenuSeparator />
                        <MenuGroup>
                          <MenuGroupLabel>Labels</MenuGroupLabel>
                          {facets.labels.map((label) => {
                            const checked =
                              filters.labels?.some(
                                (name) => name.toLowerCase() === label.name.toLowerCase(),
                              ) ?? false;
                            return (
                              <MenuCheckboxItem
                                key={label.name}
                                checked={checked}
                                closeOnClick={false}
                                onCheckedChange={(next) =>
                                  setFilters((previous) => {
                                    const others = (previous.labels ?? []).filter(
                                      (name) => name.toLowerCase() !== label.name.toLowerCase(),
                                    );
                                    const labels = next ? [...others, label.name] : others;
                                    return { ...previous, labels: labels.slice(0, 10) };
                                  })
                                }
                              >
                                <PullRequestLabelChip label={label} />
                              </MenuCheckboxItem>
                            );
                          })}
                        </MenuGroup>
                      </>
                    ) : null}
                    {facets.milestones.length > 0 || filters.milestone ? (
                      <>
                        <MenuSeparator />
                        <MenuGroup>
                          <MenuGroupLabel>Milestone</MenuGroupLabel>
                          <MenuRadioGroup
                            value={filters.milestone ?? ""}
                            onValueChange={(value) =>
                              setFilters((previous) => ({
                                ...previous,
                                milestone: value === "" ? undefined : (value as string),
                              }))
                            }
                          >
                            <MenuRadioItem value="">Any milestone</MenuRadioItem>
                            {facets.milestones.map((milestone) => (
                              <MenuRadioItem key={milestone} value={milestone}>
                                {milestone}
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuGroup>
                      </>
                    ) : null}
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Parent</MenuGroupLabel>
                      <MenuRadioGroup
                        value={filters.parent ?? ""}
                        onValueChange={(value) =>
                          setFilters((previous) => ({
                            ...previous,
                            parent: value === "" ? undefined : (value as string),
                          }))
                        }
                      >
                        <MenuRadioItem value="">Any parent</MenuRadioItem>
                        <MenuRadioItem value="none">No parent</MenuRadioItem>
                        {facets.parents.map((parent) => (
                          <MenuRadioItem key={issueKey(parent)} value={issueKey(parent)}>
                            <span className="truncate">
                              #{parent.number} {parent.title}
                            </span>
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Status</MenuGroupLabel>
                      {ISSUE_STATUSES.map((status) => (
                        <MenuCheckboxItem
                          key={status}
                          checked={filters.statuses?.includes(status) ?? false}
                          closeOnClick={false}
                          onCheckedChange={(next) =>
                            setFilters((previous) => {
                              const others = (previous.statuses ?? []).filter(
                                (value) => value !== status,
                              );
                              return { ...previous, statuses: next ? [...others, status] : others };
                            })
                          }
                        >
                          <IssueStatusGlyph status={status} className="size-3.5" />
                          {ISSUE_STATUS_PRESENTATION[status].label}
                        </MenuCheckboxItem>
                      ))}
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Linked</MenuGroupLabel>
                      <MenuRadioGroup
                        value={filters.linked ?? ""}
                        onValueChange={(value) =>
                          setFilters((previous) => ({
                            ...previous,
                            linked: value === "linked" || value === "unlinked" ? value : undefined,
                          }))
                        }
                      >
                        {LINKED_OPTIONS.map((option) => (
                          <MenuRadioItem key={option.value} value={option.value}>
                            {option.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                    {activeFilterCount > 0 ? (
                      <>
                        <MenuSeparator />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start"
                          onClick={() => setFilters({})}
                        >
                          Clear filters
                        </Button>
                      </>
                    ) : null}
                  </MenuPopup>
                </Menu>
                <Toggle
                  variant="outline"
                  aria-label="Group by parent"
                  title="Group by parent instead of status"
                  pressed={preferences.groupByParent}
                  onPressedChange={(pressed) => updatePreferences({ groupByParent: pressed })}
                >
                  <ListTreeIcon className="size-4" />
                </Toggle>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Refresh Issues"
                  onClick={refresh}
                  disabled={list.isPending}
                >
                  <RefreshIcon size="md" refreshing={list.isPending} />
                </Button>
              </div>

              {data !== null && data.unsupported.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Not supported:{" "}
                  {data.unsupported
                    .map(
                      ({ host, repositoryCount }) =>
                        `${repositoryCount} ${repositoryCount === 1 ? "repository" : "repositories"} on ${host}`,
                    )
                    .join(", ")}
                  . Issues are read from GitHub only.
                </p>
              ) : null}
              {/* A server or a further page that failed leaves the rows already loaded in
                  place, and says so rather than going quiet. */}
              {list.error !== null && data !== null ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
                  <span>{list.error} Showing the last Issues loaded.</span>
                  <Button size="xs" variant="outline" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              ) : null}
              {data !== null && data.errors.length > 0 ? (
                <p className="text-xs text-destructive-foreground">
                  {data.errors.map((error) => `${error.host}: ${error.message}`).join(" · ")}
                </p>
              ) : null}

              {body}

              {data !== null && data.nextCursors.size > 0 && list.error === null ? (
                <div className="flex justify-center">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={list.isPending}>
                    {list.isPending ? "Loading..." : "Load more"}
                  </Button>
                </div>
              ) : null}
            </WorkspacePageContainer>
          </div>
        </div>
        {selected !== null && selectedCwd !== null ? (
          <IssueDetailPanel
            key={`${selected.environmentId} ${selectedKey}`}
            environmentId={selected.environmentId}
            reference={selected.reference}
            cwd={selectedCwd}
            onClose={() => select(null)}
            onChanged={refresh}
            startDisabledReason={(() => {
              const target = resolveStart(selected.reference);
              return "reason" in target ? target.reason : null;
            })()}
            linkEnvironments={linkEnvironments}
            linkedPullRequests={data?.linkedPullRequests ?? NO_LINKED_PULL_REQUESTS}
            onOpenThread={openThread}
            onStart={(detail) =>
              void startFromIssue({
                ...selected.reference,
                url: detail.url,
                title: detail.title,
                body: detail.body,
              })
            }
          />
        ) : null}
      </div>
    </SidebarInset>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function RadioMenu<Value extends string>({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: Value;
  options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  onChange: (value: Value) => void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <Menu>
      <MenuTrigger aria-label={`${label}: ${current?.label}`} render={<Button variant="outline" />}>
        {icon}
        <span>{current?.label}</span>
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function IssueStatusGroup({
  status,
  count,
  collapsed,
  onToggle,
  children,
}: {
  status: IssueStatus;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={onToggle}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
        />
        <IssueStatusGlyph status={status} className="size-3.5" />
        <span>{ISSUE_STATUS_PRESENTATION[status].label}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      {collapsed ? null : <ul className="flex flex-col">{children}</ul>}
    </li>
  );
}

const IssueRow = memo(function IssueRow({
  entry,
  status,
  showStatusLabel,
  threads,
  showProject,
  selected,
  startDisabledReason,
  starting,
  startBusy,
  onOpen,
  onOpenThread,
  onStart,
}: {
  entry: EnvironmentIssueEntry;
  status: IssueStatus;
  /** Status groups already say it; the parent tree does not. */
  showStatusLabel: boolean;
  threads: ReadonlyArray<IssueRowThread>;
  showProject: boolean;
  selected: boolean;
  startDisabledReason: string | null;
  /** Its thread is being started. */
  starting: boolean;
  /** Some row's thread is being started; one start at a time. */
  startBusy: boolean;
  onOpen: (entry: EnvironmentIssueEntry) => void;
  onOpenThread: (thread: IssueRowThread) => void;
  onStart: (entry: EnvironmentIssueEntry) => Promise<void>;
}) {
  return (
    <div
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "group/issue-row px-2 hover:bg-accent/50",
        selected && "bg-accent text-accent-foreground",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => onOpen(entry)}
      >
        <IssueStatusGlyph status={status} />
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{entry.number}</span>}
          title={entry.title}
          status={
            <>
              {showStatusLabel ? (
                <span className="text-muted-foreground">
                  {ISSUE_STATUS_PRESENTATION[status].label}
                </span>
              ) : null}
              {entry.subIssueCount > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                  <LayersIcon aria-hidden className="size-3" />
                  {entry.subIssueCount}
                </span>
              ) : null}
            </>
          }
          meta={
            <>
              {entry.author ? <span className="shrink-0">{entry.author}</span> : null}
              {showProject ? <span className="shrink-0 truncate">{entry.repository}</span> : null}
              {entry.milestone ? (
                <span className="shrink-0 truncate">{entry.milestone}</span>
              ) : null}
              {entry.labels.slice(0, 3).map((label) => (
                <PullRequestLabelChip key={label.name} label={label} />
              ))}
            </>
          }
          updatedAt={entry.updatedAt}
        />
      </button>
      {threads.length > 0 ? (
        <span className="flex max-w-[40%] shrink-0 items-center gap-1">
          {threads.slice(0, 2).map((thread) => (
            <span key={`${thread.environmentId} ${thread.id}`} className="flex min-w-0 max-w-48">
              <Button size="xs" variant="ghost" onClick={() => onOpenThread(thread)}>
                <MessageSquareIcon />
                <span className="truncate">{thread.title}</span>
              </Button>
            </span>
          ))}
          {threads.length > 2 ? (
            <Tooltip>
              <TooltipTrigger render={<span className="shrink-0 text-2xs text-muted-foreground" />}>
                +{threads.length - 2}
              </TooltipTrigger>
              <TooltipPopup>
                {threads
                  .slice(2)
                  .map((thread) => thread.title)
                  .join(", ")}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      ) : null}
      <span
        className={cn(
          "flex opacity-0 group-hover/issue-row:opacity-100 has-[:focus-visible]:opacity-100",
          starting && "opacity-100",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Start a thread from #${entry.number}`}
                aria-busy={starting || undefined}
                disabled={startDisabledReason !== null || startBusy}
                onClick={() => void onStart(entry)}
              />
            }
          >
            {starting ? <Spinner aria-hidden /> : <MessageSquarePlusIcon />}
          </TooltipTrigger>
          <TooltipPopup>
            {startDisabledReason ??
              (starting
                ? "Starting a thread..."
                : startBusy
                  ? "Another thread is starting"
                  : `Start a thread from #${entry.number}`)}
          </TooltipPopup>
        </Tooltip>
      </span>
    </div>
  );
});

function IssueTreeItem({
  node,
  depth,
  renderRow,
}: {
  node: IssueTreeNode;
  depth: number;
  renderRow: (entry: EnvironmentIssueEntry, showStatusLabel: boolean) => ReactNode;
}) {
  return (
    <li style={{ paddingLeft: depth === 0 ? undefined : `${Math.min(depth, 6) * 1.25}rem` }}>
      {node.entry !== null ? (
        renderRow(node.entry, true)
      ) : (
        // A sub-Issue the page does not hold: filtered out, not loaded, or in another repository.
        <a
          href={node.link.url}
          target="_blank"
          rel="noreferrer"
          className={cn(PULL_REQUEST_ROW_CLASS, "px-2 text-muted-foreground hover:bg-accent/50")}
        >
          <IssueStateGlyph state={node.link.state} className="opacity-70" />
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>
              {node.link.repository}#{node.link.number}
            </span>{" "}
            {node.link.title}
          </span>
          {node.outsideProjects ? (
            <span className="shrink-0 rounded-sm border border-border px-1 text-2xs">
              Outside your projects
            </span>
          ) : null}
          <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
        </a>
      )}
      {node.children.length > 0 || node.unlistedChildCount > 0 ? (
        <ul className="flex flex-col">
          {node.children.map((child) => (
            <IssueTreeItem key={child.key} node={child} depth={depth + 1} renderRow={renderRow} />
          ))}
          {node.unlistedChildCount > 0 ? (
            <li
              className="flex items-center gap-1 px-2 py-1 text-2xs text-muted-foreground"
              style={{ paddingLeft: `${Math.min(depth + 1, 6) * 1.25 + 0.5}rem` }}
            >
              <CornerDownRightIcon aria-hidden className="size-3" />
              {node.unlistedChildCount} more sub-Issues on GitHub
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
