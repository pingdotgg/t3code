import {
  groupIssues,
  holdIssuePages,
  type HeldIssuePage,
} from "@t3tools/client-runtime/issue-list";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import type { EnvironmentId, IssueListInput, IssueTrackerKind } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Columns3Icon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useState, type ReactNode } from "react";

import { issueFilterProjects, issueListTargets } from "~/components/issue/issuesSearch.logic";
import { IssueGlyph } from "~/components/issue/issuePresentation";
import { PullRequestListGhost } from "~/components/pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "~/components/pullRequest/PullRequestsUnavailableState";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { SidebarInset } from "~/components/ui/sidebar";
import { Switch } from "~/components/ui/switch";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useProjects } from "~/state/entities";
import { useEnvironments, useIssuesSupported } from "~/state/environments";
import { useIssueList } from "~/state/issues";

import {
  anyIssueHasStatusLabel,
  BOARD_COLUMN_IDS,
  type BoardColumnId,
  filterIssuesByLabelNames,
  groupIssuesByBoardColumn,
  isStatusLabelName,
} from "./boardColumns.logic";
import { BoardLabelFilter } from "./BoardLabelFilter";
import type { BoardSearch } from "./boardSearch.logic";
import { TrailBoardCard } from "./TrailBoardCard";
import { TrailIssueDrawer, type TrailIssueSelection } from "./TrailIssueDrawer";

const PAGE_SIZE = 100;

function boardColumnTitle(gt: ReturnType<typeof useGT>, columnId: BoardColumnId): string {
  switch (columnId) {
    case "backlog":
      return gt("Backlog", { $context: "kanban column" });
    case "todo":
      return gt("Todo", { $context: "kanban column" });
    case "in-progress":
      return gt("In progress", { $context: "kanban column" });
    case "review":
      return gt("Review", { $context: "kanban column" });
    case "done":
      return gt("Done", { $context: "kanban column" });
  }
}

const clearedSelection = {
  selectedEnvironmentId: undefined,
  selectedProjectId: undefined,
  selectedHost: undefined,
  tracker: undefined,
  scope: undefined,
  key: undefined,
} as const;

export function TrailBoardPage() {
  const gt = useGT();
  const navigate = useNavigate({ from: "/board" });
  const search = useSearch({ from: "/_chat/board" });
  const { environments } = useEnvironments();
  const projects = useProjects();
  const issuesSupported = useIssuesSupported();
  const [pages] = useState<ReadonlyMap<EnvironmentId, HeldIssuePage>>(() => new Map());

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

  const listInput: IssueListInput = {
    state: search.status,
    involvement: "all",
    limit: PAGE_SIZE,
    ...(search.host ? { host: search.host } : {}),
    ...(search.label?.length ? { labels: search.label } : {}),
  };
  const targets = issueListTargets(
    capableEnvironments.map((e) => e.environmentId),
    filterProjects,
    undefined,
    listInput,
  );
  const list = useIssueList(targets);
  useLiveRefresh(
    () => {
      if (!list.isPending) list.reload();
    },
    { key: JSON.stringify(targets) },
  );

  const held = holdIssuePages(list.answers, pages);
  const groups = groupIssues(held, "", projects, "updated");
  const rows = groups.flatMap((group) => group.rows);

  // Client-side label filter also covers status:* so the menu can narrow columns without a refetch
  // when the tracker already returned a broader page.
  const filteredRows = filterIssuesByLabelNames(rows, search.label ?? []);
  const columns = groupIssuesByBoardColumn(filteredRows);
  const hasStatusLabels = anyIssueHasStatusLabel(rows);
  const otherLabelNames = (() => {
    const names = new Set<string>();
    for (const row of rows) {
      for (const label of row.labels) {
        if (!isStatusLabelName(label.name)) names.add(label.name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  })();

  const updateSearch = (patch: Partial<BoardSearch>) => {
    void navigate({
      to: "/board",
      search: (previous) => ({ ...previous, ...patch }),
      replace: true,
    });
  };

  const selection: TrailIssueSelection | null =
    search.tracker &&
    search.scope &&
    search.key &&
    search.selectedProjectId &&
    search.selectedEnvironmentId
      ? {
          environmentId: search.selectedEnvironmentId,
          projectId: search.selectedProjectId,
          tracker: search.tracker as IssueTrackerKind,
          host: search.selectedHost ?? search.host ?? "",
          scope: search.scope,
          key: search.key,
        }
      : null;

  const selectedEntry =
    selection === null
      ? null
      : (rows.find(
          (row) =>
            row.environmentId === selection.environmentId &&
            issueEntryKey(row) ===
              issueEntryKey({
                projectId: selection.projectId,
                host: selection.host || row.host,
                scope: selection.scope,
                key: selection.key,
              }),
        ) ?? null);

  const selectEntry = (entry: (typeof rows)[number]) => {
    updateSearch({
      selectedEnvironmentId: entry.environmentId,
      selectedProjectId: entry.projectId,
      selectedHost: entry.host,
      tracker: entry.tracker,
      scope: entry.scope,
      key: entry.key,
    });
  };

  const noneAnswered = list.answers.length === 0;

  const boardBody: ReactNode = !issuesSupported ? (
    <PullRequestsUnavailableState
      title={gt("Board unavailable")}
      error={gt("Update this environment's T3 Code server to browse issues.")}
    />
  ) : noneAnswered && list.isPending ? (
    <PullRequestListGhost />
  ) : noneAnswered && list.error ? (
    <PullRequestsUnavailableState
      error={list.error}
      onRetry={list.retry}
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
  ) : filteredRows.length === 0 ? (
    <Empty>
      <EmptyMedia variant="icon">
        <Columns3Icon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>
          <T>No issues under these filters</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>Widen the label filter or include closed issues.</T>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <div className="flex min-h-0 flex-col gap-3">
      {list.error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
          <span>{list.error}</span>
          <Button size="xs" variant="outline" onClick={list.retry}>
            <T>Retry</T>
          </Button>
        </div>
      ) : null}
      {!hasStatusLabels ? (
        <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <T>
            No status:* labels yet. Every issue sits in Backlog until you add status:todo,
            status:in-progress, status:review, or status:done.
          </T>
        </div>
      ) : null}
      <div className="flex min-h-0 gap-3 overflow-x-auto pb-2">
        {BOARD_COLUMN_IDS.map((columnId) => {
          const cards = columns[columnId];
          const title = boardColumnTitle(gt, columnId);
          return (
            <section
              key={columnId}
              className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted/30 p-2"
              aria-label={title}
            >
              <header className="flex items-center justify-between gap-2 px-1 pt-0.5">
                <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
                <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
              </header>
              <div className="flex flex-col gap-2">
                {cards.map((entry) => {
                  const selected =
                    selection !== null &&
                    entry.environmentId === selection.environmentId &&
                    entry.projectId === selection.projectId &&
                    entry.tracker === selection.tracker &&
                    entry.scope === selection.scope &&
                    entry.key === selection.key;
                  return (
                    <TrailBoardCard
                      key={`${entry.environmentId}:${issueEntryKey(entry)}`}
                      entry={entry}
                      selected={selected}
                      onSelect={selectEntry}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="relative bg-background"
        >
          <WorkspaceBreadcrumb ariaLabel={gt("Board breadcrumb")}>
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">
                <T context="page title, kanban board">Board</T>
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
        </WorkspacePageHeader>

        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  size="sm"
                  checked={search.status === "all" || search.status === "closed"}
                  onCheckedChange={(checked) => updateSearch({ status: checked ? "all" : "open" })}
                />
                <span>
                  <T>Include closed</T>
                </span>
              </label>
              <BoardLabelFilter
                selected={search.label ?? []}
                otherLabels={otherLabelNames}
                onChange={(label) => updateSearch({ label: label.length ? label : undefined })}
              />
              <Button
                size="icon"
                variant="outline"
                aria-label={gt("Refresh board")}
                onClick={list.refresh}
                disabled={list.isPending}
              >
                <RefreshIcon size="md" refreshing={list.isPending} />
              </Button>
            </div>
            {boardBody}
          </WorkspacePageContainer>
        </div>
      </div>

      <TrailIssueDrawer
        open={selection !== null}
        selection={selection}
        listEntry={selectedEntry}
        onOpenChange={(open) => {
          if (!open) updateSearch(clearedSelection);
        }}
      />
    </SidebarInset>
  );
}
