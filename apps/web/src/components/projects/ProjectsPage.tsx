import { useNavigate } from "@tanstack/react-router";
import { CloudIcon, ContainerIcon } from "lucide-react";
import { useMemo } from "react";

import { enumerateDays, formatPercent } from "@t3tools/shared/usageFormat";
import { isElectron } from "../../env";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { ProjectActivityChart, type ProjectActivitySeries } from "./ProjectActivityChart";
import { ProjectFavicon } from "../ProjectFavicon";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

interface ProjectStats {
  activeThreadCount: number;
  lastActivityAt: string | null;
}

const EMPTY_STATS: ProjectStats = { activeThreadCount: 0, lastActivityAt: null };
const ACTIVITY_WINDOW_DAYS = 30;
const ACTIVITY_SERIES_LIMIT = 5;
// Slots 1-5 of the categorical ramp; safe up to 8 for line/area charts, but a
// 6th top project starts crowding the legend, so the rest fold into "Other".
const ACTIVITY_COLORS = [
  "light-dark(#2a78d6, #3987e5)",
  "light-dark(#eb6834, #d95926)",
  "light-dark(#1baf7a, #199e70)",
  "light-dark(#eda100, #c98500)",
  "light-dark(#e87ba4, #d55181)",
];
const OTHER_SERIES_ID = "__other__";

/** Maps every physical project ref to its logical group key, for O(1) thread attribution. */
function buildProjectKeyByRef(
  groups: readonly SidebarProjectSnapshot[],
): ReadonlyMap<string, string> {
  const projectKeyByRef = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      projectKeyByRef.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    }
  }
  return projectKeyByRef;
}

/** Derives per-project thread counts and last-activity by matching thread shells against each
 * group's member project refs, in a single pass rather than one query per row. */
function useProjectStatsByKey(
  groups: readonly SidebarProjectSnapshot[],
): ReadonlyMap<string, ProjectStats> {
  const threads = useThreadShells();
  return useMemo(() => {
    const projectKeyByRef = buildProjectKeyByRef(groups);
    const stats = new Map<string, ProjectStats>();
    for (const thread of threads) {
      const projectKey = projectKeyByRef.get(`${thread.environmentId}:${thread.projectId}`);
      if (!projectKey) continue;
      const existing = stats.get(projectKey) ?? { activeThreadCount: 0, lastActivityAt: null };
      const activity = thread.latestUserMessageAt ?? thread.updatedAt;
      stats.set(projectKey, {
        activeThreadCount: existing.activeThreadCount + (thread.archivedAt === null ? 1 : 0),
        lastActivityAt:
          existing.lastActivityAt === null || activity > existing.lastActivityAt
            ? activity
            : existing.lastActivityAt,
      });
    }
    return stats;
  }, [groups, threads]);
}

interface ProjectActivityData {
  readonly series: readonly ProjectActivitySeries[];
  readonly days: readonly string[];
  readonly countsByDay: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly seriesTotals: ReadonlyMap<string, number>;
  readonly totalCount: number;
  readonly hasActivity: boolean;
}

/** Buckets each thread's most recent activity day into its project, then folds every project
 * past the top 5 by volume into "Other" so the chart never has to invent a 6th-and-beyond hue. */
function useProjectActivityData(groups: readonly SidebarProjectSnapshot[]): ProjectActivityData {
  const threads = useThreadShells();
  return useMemo(() => {
    const untilDay = new Date().toISOString().slice(0, 10);
    const sinceDay = new Date(Date.now() - (ACTIVITY_WINDOW_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const days = enumerateDays(sinceDay, untilDay);
    const projectKeyByRef = buildProjectKeyByRef(groups);

    const totalByProjectKey = new Map<string, number>();
    const dayAndProjectKeyToCount = new Map<string, Map<string, number>>();
    for (const thread of threads) {
      const projectKey = projectKeyByRef.get(`${thread.environmentId}:${thread.projectId}`);
      if (!projectKey) continue;
      const day = (thread.latestUserMessageAt ?? thread.updatedAt).slice(0, 10);
      if (day < sinceDay || day > untilDay) continue;

      totalByProjectKey.set(projectKey, (totalByProjectKey.get(projectKey) ?? 0) + 1);
      const perProject = dayAndProjectKeyToCount.get(day) ?? new Map<string, number>();
      perProject.set(projectKey, (perProject.get(projectKey) ?? 0) + 1);
      dayAndProjectKeyToCount.set(day, perProject);
    }

    const topProjectKeys = [...totalByProjectKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, ACTIVITY_SERIES_LIMIT)
      .map(([projectKey]) => projectKey);
    const displayNameByKey = new Map(groups.map((group) => [group.projectKey, group.displayName]));
    const series: ProjectActivitySeries[] = topProjectKeys.map((projectKey, index) => ({
      id: projectKey,
      label: displayNameByKey.get(projectKey) ?? projectKey,
      color: ACTIVITY_COLORS[index] ?? "var(--muted-foreground)",
    }));
    const hasOther = totalByProjectKey.size > topProjectKeys.length;
    if (hasOther) {
      series.push({ id: OTHER_SERIES_ID, label: "Other", color: "var(--muted-foreground)" });
    }

    const countsByDay = new Map<string, Map<string, number>>();
    const seriesTotals = new Map<string, number>();
    for (const [day, perProject] of dayAndProjectKeyToCount) {
      const counts = new Map<string, number>();
      for (const [projectKey, count] of perProject) {
        const seriesId = topProjectKeys.includes(projectKey) ? projectKey : OTHER_SERIES_ID;
        counts.set(seriesId, (counts.get(seriesId) ?? 0) + count);
        seriesTotals.set(seriesId, (seriesTotals.get(seriesId) ?? 0) + count);
      }
      countsByDay.set(day, counts);
    }
    const totalCount = [...totalByProjectKey.values()].reduce((sum, count) => sum + count, 0);

    return {
      series,
      days,
      countsByDay,
      seriesTotals,
      totalCount,
      hasActivity: totalByProjectKey.size > 0,
    };
  }, [groups, threads]);
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const groups = useSettingsProjectGroups();
  const statsByKey = useProjectStatsByKey(groups);
  const activity = useProjectActivityData(groups);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Projects breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Projects</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {groups.length === 0 ? (
              <Empty className="flex-1">
                <EmptyHeader className="max-w-md">
                  <EmptyTitle className="text-foreground text-xl">No projects yet</EmptyTitle>
                  <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                    Projects you add show up here once they have a thread.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-8">
                {activity.hasActivity ? (
                  <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                    <div className="flex min-w-0 flex-col gap-5">
                      <div className="flex flex-col gap-1">
                        <span className="text-4xl font-semibold text-foreground tabular-nums">
                          {activity.totalCount}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Active threads · last {ACTIVITY_WINDOW_DAYS} days
                        </span>
                      </div>
                      {activity.series.map((entry) => {
                        const total = activity.seriesTotals.get(entry.id) ?? 0;
                        const share = activity.totalCount === 0 ? 0 : total / activity.totalCount;
                        return (
                          <div key={entry.id} className="flex flex-col gap-1">
                            <div className="flex items-baseline justify-between gap-4">
                              <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                                <span
                                  aria-hidden
                                  className="size-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: entry.color }}
                                />
                                <span className="truncate">{entry.label}</span>
                              </span>
                              <span className="shrink-0 text-sm text-foreground tabular-nums">
                                {total}
                              </span>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {formatPercent(share)} of threads
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex min-w-0 flex-col gap-3">
                      <h2 className="text-sm font-medium text-foreground">Daily active threads</h2>
                      <ProjectActivityChart
                        series={activity.series}
                        days={activity.days}
                        countsByDay={activity.countsByDay}
                      />
                    </div>
                  </section>
                ) : null}
                <ul className="flex flex-col divide-y divide-border">
                  {groups.map((group) => (
                    <ProjectRow
                      key={group.projectKey}
                      group={group}
                      stats={statsByKey.get(group.projectKey) ?? EMPTY_STATS}
                      onOpen={() =>
                        void navigate({
                          to: "/projects/$projectKey",
                          params: { projectKey: group.projectKey },
                        })
                      }
                    />
                  ))}
                </ul>
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function ProjectRow({
  group,
  stats,
  onOpen,
}: {
  group: SidebarProjectSnapshot;
  stats: ProjectStats;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden"
      >
        <ProjectFavicon
          environmentId={group.environmentId}
          cwd={group.workspaceRoot}
          projectName={group.title}
          faviconPath={group.faviconPath}
          projectIcon={group.projectIcon}
          className="size-8 shrink-0"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{group.displayName}</span>
            {group.groupedProjectCount > 1 ? (
              <span className="shrink-0 text-secondary-label text-xs">
                {group.groupedProjectCount} environments
              </span>
            ) : null}
            {group.environmentPresence !== "local-only" ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      aria-label={
                        group.allRemoteMembersAreDesktopLocal
                          ? "Local sandbox project"
                          : "Remote project"
                      }
                      className="inline-flex shrink-0 items-center text-icon-muted"
                    />
                  }
                >
                  {group.allRemoteMembersAreDesktopLocal ? (
                    <ContainerIcon className="size-3" />
                  ) : (
                    <CloudIcon className="size-3" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {group.allRemoteMembersAreDesktopLocal
                    ? `Local sandbox: ${group.remoteEnvironmentLabels.join(", ")}`
                    : `Remote environment: ${group.remoteEnvironmentLabels.join(", ")}`}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          <span className="truncate text-xs text-muted-foreground">{group.workspaceRoot}</span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground">
          <span>
            {stats.activeThreadCount} {stats.activeThreadCount === 1 ? "thread" : "threads"}
          </span>
          <span>
            {stats.lastActivityAt ? formatRelativeTimeLabel(stats.lastActivityAt) : "No activity"}
          </span>
        </div>
      </button>
    </li>
  );
}
