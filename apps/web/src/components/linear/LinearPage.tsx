import { useNavigate, useSearch } from "@tanstack/react-router";
import type { LinearConnectionStatus } from "@t3tools/contracts";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { isEditableFocused } from "~/lib/editableFocus";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useDebouncedValue } from "~/state/queries";

import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { LinearBanner } from "./LinearBanner";
import { LinearConnectCard } from "./LinearConnectCard";
import { LinearIssueDetailPanel } from "./LinearIssueDetailPanel";
import type { LinearIssueRowContext } from "./LinearIssueRow";
import { LinearJumpSearch } from "./LinearJumpSearch";
import {
  LinearJumpBackIn,
  LinearMilestoneList,
  LinearProjectList,
  LinearSectionTitle,
  LinearTeamCards,
} from "./LinearLevels";
import { LinearMilestoneView } from "./LinearMilestoneView";
import { LinearLaunchProvider } from "./useLinearLaunch";
import { classifyLinearFailure } from "@t3tools/client-runtime/linear/degradation";
import { LinearGlyph } from "./linearIcons";
import {
  jumpBackInIssueIds,
  orderJumpBackInIssues,
  runningCountByTeam,
} from "@t3tools/client-runtime/linear/activity";
import { buildLinearJumpTargets, type LinearJumpTarget } from "@t3tools/client-runtime/linear/jump";
import {
  buildLinearBreadcrumb,
  buildLinearNewIssueUrl,
  linearLevel,
  linearParentScope,
  patchLinearSearch,
  withLinearScope,
  type LinearScope,
  type LinearSearch,
  type LinearSearchPatch,
} from "@t3tools/client-runtime/linear/search";
import {
  useLinearActivity,
  useLinearDegradation,
  useLinearIssues,
  useLinearMilestones,
  useLinearPolling,
  useLinearProjects,
  useLinearRefresh,
  useLinearSearchIssues,
  useLinearStatus,
} from "./useLinearData";

const JUMP_SEARCH_DEBOUNCE_MS = 200;
const EMPTY_LIST: ReadonlyArray<never> = [];
const SKELETON_ROWS = ["a", "b", "c", "d"] as const;

function LinearHeaderBar({
  status,
  newIssueUrl,
  refreshing,
  onRefresh,
}: {
  status: LinearConnectionStatus | null;
  newIssueUrl: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <WorkspacePageHeader electron={isElectron} className="relative bg-background">
      <h1 className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
        <LinearGlyph className="size-3.5" />
        Linear
        {status?.organization ? (
          <span className="truncate font-normal text-muted-foreground">
            · {status.organization.name} workspace
          </span>
        ) : null}
      </h1>
      <div className="min-w-0 flex-1" />
      {status?.state === "connected" ? (
        <>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Refresh"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshIcon refreshing={refreshing} />
          </Button>
          {newIssueUrl ? (
            <Button
              variant="outline"
              size="sm"
              render={<a href={newIssueUrl} target="_blank" rel="noopener noreferrer" />}
            >
              <PlusIcon aria-hidden />
              New issue
            </Button>
          ) : null}
        </>
      ) : null}
    </WorkspacePageHeader>
  );
}

function LinearConnected({
  status,
  search,
  onNavigate,
}: {
  status: LinearConnectionStatus;
  search: LinearSearch;
  onNavigate: (next: LinearSearch, options?: { replace?: boolean }) => void;
}) {
  const level = linearLevel(search);
  const { refresh, refreshing } = useLinearRefresh();
  useLinearPolling(true);
  const activity = useLinearActivity();
  const projects = useLinearProjects(search.team, level !== "workspace");
  const milestones = useLinearMilestones(search.project);
  const jumpBackInIds = level === "workspace" ? jumpBackInIssueIds(activity.issues) : EMPTY_LIST;
  const jumpBackIn = useLinearIssues(
    jumpBackInIds.length === 0
      ? null
      : { assignee: "me", issueIds: [...jumpBackInIds], includeCompleted: true },
  );
  const [jumpTerm, setJumpTerm] = useState("");
  const debouncedJumpTerm = useDebouncedValue(jumpTerm, JUMP_SEARCH_DEBOUNCE_MS);
  const jumpIssues = useLinearSearchIssues(debouncedJumpTerm);
  const allProjects = useLinearProjects(undefined, jumpTerm.trim() !== "");
  const jumpSearchInputRef = useRef<HTMLInputElement | null>(null);
  const issueSearchInputRef = useRef<HTMLInputElement | null>(null);

  const patch = (change: LinearSearchPatch, options?: { replace?: boolean }) =>
    onNavigate(patchLinearSearch(search, change), { replace: options?.replace ?? true });
  const goToScope = (scope: LinearScope) => onNavigate(withLinearScope(search, scope));
  const selectIssue = (issueId: string | undefined) => patch({ issue: issueId });

  // ⌘K focuses the jump search here (the global palette keeps it elsewhere); "/" searches issues.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the page's keyboard scope with the shortcut dispatcher
  useEffect(
    () =>
      registerCommands(
        {},
        {
          onKeyDown: (event) => {
            if (event.defaultPrevented || event.isComposing) return false;
            if (
              (event.metaKey || event.ctrlKey) &&
              !event.shiftKey &&
              !event.altKey &&
              event.key.toLowerCase() === "k"
            ) {
              event.preventDefault();
              jumpSearchInputRef.current?.focus();
              jumpSearchInputRef.current?.select();
              return true;
            }
            if (event.metaKey || event.ctrlKey || event.altKey) return false;
            if (event.key === "/" && !isEditableFocused(event.target)) {
              const input = issueSearchInputRef.current;
              if (input === null) return false;
              event.preventDefault();
              input.focus();
              input.select();
              return true;
            }
            if (
              event.key === "Escape" &&
              search.issue !== undefined &&
              !isEditableFocused(event.target) &&
              document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]') ===
                null
            ) {
              event.preventDefault();
              selectIssue(undefined);
              return true;
            }
            return false;
          },
        },
      ),
    [search.issue, selectIssue],
  );

  const teamsById = new Map(status.teams.map((entry) => [entry.id, entry]));
  const team = search.team === undefined ? undefined : teamsById.get(search.team);
  const project = (projects.data ?? EMPTY_LIST).find((entry) => entry.id === search.project);
  const milestone = (milestones.data ?? EMPTY_LIST).find((entry) => entry.id === search.milestone);
  const crumbs = buildLinearBreadcrumb(search, {
    teamName: team?.name,
    projectName: project?.name,
    milestoneName: milestone?.name,
  });
  const parentScope = linearParentScope(search);

  const activityIssueIds = activity.issues.map((entry) => entry.issueId).slice(0, 250);
  const rowContext: LinearIssueRowContext = {
    activityByIssueId: activity.byIssueId,
    selectedIssueId: search.issue,
    onSelect: selectIssue,
  };

  const jumpTargets = buildLinearJumpTargets(jumpTerm, {
    teams: status.teams,
    projects: [...(allProjects.data ?? EMPTY_LIST), ...(projects.data ?? EMPTY_LIST)],
    milestones: milestones.data ?? EMPTY_LIST,
    issues: jumpIssues.data ?? EMPTY_LIST,
    fallbackTeamId: search.team,
  });
  const jump = (target: LinearJumpTarget) =>
    onNavigate(
      patchLinearSearch(withLinearScope(search, target.scope), {
        issue: target.kind === "issue" ? target.id : undefined,
      }),
    );

  const degradation = useLinearDegradation(
    [activity.failure, projects.failure, milestones.failure, jumpBackIn.failure],
    jumpBackIn.data?.stale === true,
  );
  // The milestone view owns its own banner; showing two would repeat the same message.
  const showPageBanner = degradation !== null && level !== "milestone";

  const newIssueUrl = buildLinearNewIssueUrl(status.organization?.urlKey ?? null, team?.key);
  const jumpBackInIssues = orderJumpBackInIssues(
    jumpBackIn.data?.issues ?? EMPTY_LIST,
    activity.issues,
  );

  return (
    <>
      <LinearHeaderBar
        status={status}
        newIssueUrl={newIssueUrl}
        refreshing={refreshing}
        onRefresh={refresh}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-y border-border/60 px-4">
            {parentScope === null ? null : (
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Up one level"
                title="Up one level"
                onClick={() => goToScope(parentScope)}
              >
                <ArrowLeftIcon aria-hidden />
              </Button>
            )}
            <nav aria-label="Linear breadcrumb" className="min-w-0 flex-1">
              <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-sm">
                {crumbs.map((crumb, index) => (
                  <li
                    key={
                      crumb.scope.milestone ??
                      crumb.scope.project ??
                      crumb.scope.team ??
                      "workspace"
                    }
                    className="flex min-w-0 items-center gap-1.5"
                  >
                    {index > 0 ? (
                      <span aria-hidden className="text-muted-foreground/60">
                        ›
                      </span>
                    ) : null}
                    {crumb.current ? (
                      <span aria-current="page" className="truncate font-medium">
                        {crumb.label}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => goToScope(crumb.scope)}
                        className="cursor-pointer truncate text-muted-foreground hover:text-foreground"
                      >
                        {crumb.label}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
            <LinearJumpSearch
              inputRef={jumpSearchInputRef}
              targets={jumpTargets}
              busy={jumpIssues.isPending && jumpTerm.trim() !== ""}
              onTermChange={setJumpTerm}
              onJump={jump}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="min-h-full gap-4 pt-4">
              {showPageBanner ? (
                <LinearBanner degradation={degradation} onRetry={refresh} retrying={refreshing} />
              ) : null}
              {level === "workspace" ? (
                <>
                  <section className="flex flex-col gap-2">
                    <LinearSectionTitle>Teams</LinearSectionTitle>
                    <LinearTeamCards
                      teams={status.teams}
                      runningByTeam={runningCountByTeam(activity.issues)}
                      onOpenTeam={(teamId) => goToScope({ team: teamId })}
                    />
                  </section>
                  <LinearJumpBackIn issues={jumpBackInIssues} context={rowContext} />
                </>
              ) : null}
              {level === "team" ? (
                <section className="flex flex-col gap-2">
                  <LinearSectionTitle>Projects</LinearSectionTitle>
                  {projects.data === null ? (
                    <ListPlaceholder error={projects.error} onRetry={projects.refresh} />
                  ) : projects.data.length === 0 ? (
                    <p className="m-0 text-sm text-muted-foreground">No projects in this team.</p>
                  ) : (
                    <LinearProjectList
                      projects={projects.data}
                      onOpenProject={(projectId) =>
                        goToScope({ team: search.team, project: projectId })
                      }
                    />
                  )}
                </section>
              ) : null}
              {level === "project" ? (
                <section className="flex flex-col gap-2">
                  <LinearSectionTitle>Milestones</LinearSectionTitle>
                  {milestones.data === null ? (
                    <ListPlaceholder error={milestones.error} onRetry={milestones.refresh} />
                  ) : (
                    <LinearMilestoneList
                      milestones={milestones.data}
                      showCompleted={search.showCompleted === true}
                      onToggleCompleted={() =>
                        patch({ showCompleted: search.showCompleted === true ? undefined : true })
                      }
                      onOpenMilestone={(milestoneId) =>
                        goToScope({
                          team: search.team,
                          project: search.project,
                          milestone: milestoneId,
                        })
                      }
                    />
                  )}
                </section>
              ) : null}
              {level === "milestone" ? (
                <LinearMilestoneView
                  search={search}
                  milestone={milestone}
                  activityIssueIds={activityIssueIds}
                  viewer={status.viewer}
                  rowContext={rowContext}
                  searchInputRef={issueSearchInputRef}
                  onSearchChange={patch}
                  onReplaceSearch={(next) => onNavigate(next, { replace: true })}
                />
              ) : null}
            </WorkspacePageContainer>
          </div>
        </div>
        {search.issue === undefined ? null : (
          <LinearIssueDetailPanel
            key={search.issue}
            issueId={search.issue}
            viewer={status.viewer}
            teamColors={new Map(status.teams.map((entry) => [entry.id, entry.color]))}
            onClose={() => selectIssue(undefined)}
            onSelectIssue={selectIssue}
          />
        )}
      </div>
    </>
  );
}

function ListPlaceholder({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (error === null) {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        {SKELETON_ROWS.map((row) => (
          <Skeleton key={row} className="h-11 w-full" shape="card" />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
      <p className="m-0">Couldn&apos;t load this list.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function LinearPage() {
  const search = useSearch({ from: "/_chat/linear" });
  const navigate = useNavigate();
  const status = useLinearStatus();
  const { refresh, refreshing } = useLinearRefresh();
  const onNavigate = (next: LinearSearch, options?: { replace?: boolean }) =>
    void navigate({ to: "/linear", search: next, replace: options?.replace ?? false });
  const connection = status.data;
  const failureKind = classifyLinearFailure(status.failure);
  const invalid = connection?.state === "invalid" || failureKind === "unauthorized";
  const disconnected =
    connection?.state === "disconnected" ||
    (connection === null && failureKind === "not_connected");
  return (
    <SidebarInset
      {...workspaceAreaProps("linear", 2, "Linear")}
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {connection?.state === "connected" ? (
        <LinearLaunchProvider>
          <LinearConnected status={connection} search={search} onNavigate={onNavigate} />
        </LinearLaunchProvider>
      ) : (
        <>
          <LinearHeaderBar
            status={connection}
            newIssueUrl={null}
            refreshing={false}
            onRefresh={refresh}
          />
          {invalid || disconnected ? (
            <LinearConnectCard invalid={invalid} />
          ) : status.error !== null && connection === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
              <p className="m-0 text-sm text-muted-foreground">Couldn&apos;t reach Linear.</p>
              <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
                <RefreshIcon refreshing={refreshing} />
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-6" aria-busy>
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-28 w-full" shape="card" />
            </div>
          )}
        </>
      )}
    </SidebarInset>
  );
}
