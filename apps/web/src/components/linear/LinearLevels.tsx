import type { LinearMilestone, LinearProject, LinearTeam } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { LinearIssueList } from "./LinearIssueList";
import type { LinearIssueRowContext } from "./LinearIssueRow";
import { LinearMilestoneIcon, LinearTeamBadge } from "./linearIcons";
import { formatProgressPercent } from "@t3tools/client-runtime/linear/issue-list";
import { formatLinearTargetDate } from "@t3tools/client-runtime/linear/jump";
import { NO_MILESTONE_ID } from "@t3tools/client-runtime/linear/search";
import type { LinearIssue } from "@t3tools/contracts";

function ProgressBar({ progress, className }: { progress: number; className?: string }) {
  const done = progress >= 1;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-[5px] w-[120px] overflow-hidden rounded-full bg-border",
        className,
      )}
    >
      <i
        className={cn("block h-full rounded-full", done ? "bg-success" : "bg-primary")}
        style={{ width: `${formatProgressPercent(progress)}%` }}
      />
    </span>
  );
}

function formatIssueCount(count: number, capped: boolean): string {
  if (capped) return `${count}+ issues`;
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

export function LinearProgressSummary({
  progress,
  issueCount,
  issueCountCapped,
  targetDate,
}: {
  progress: number;
  issueCount: number;
  issueCountCapped: boolean;
  targetDate: string | null;
}) {
  const target = formatLinearTargetDate(targetDate);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <ProgressBar progress={progress} />
      <span className="tabular-nums">{formatProgressPercent(progress)}%</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{formatIssueCount(issueCount, issueCountCapped)}</span>
      {target ? (
        <>
          <span aria-hidden>·</span>
          <span>Target {target}</span>
        </>
      ) : null}
    </div>
  );
}

export function LinearSectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="m-0 text-xs font-medium text-muted-foreground">{children}</h2>;
}

export function LinearTeamCards({
  teams,
  runningByTeam,
  onOpenTeam,
}: {
  teams: ReadonlyArray<LinearTeam>;
  runningByTeam: ReadonlyMap<string, number>;
  onOpenTeam: (teamId: string) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2.5">
      {teams.map((team) => {
        const running = runningByTeam.get(team.id) ?? 0;
        return (
          <button
            key={team.id}
            type="button"
            data-testid="linear-team-card"
            onClick={() => onOpenTeam(team.id)}
            className="flex cursor-pointer flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5 text-left transition-colors hover:border-foreground/20"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <LinearTeamBadge teamKey={team.key} color={team.color} />
              <span className="min-w-0 flex-1 truncate">{team.name}</span>
              <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
            </span>
            {team.description ? (
              <span className="line-clamp-2 text-xs text-muted-foreground">{team.description}</span>
            ) : null}
            <span className="flex items-center gap-3.5 text-2xs text-muted-foreground">
              <span>
                <b className="font-medium text-foreground tabular-nums">{team.projectCount}</b>{" "}
                {team.projectCount === 1 ? "project" : "projects"}
              </span>
              <span>
                <b className="font-medium text-foreground tabular-nums">
                  {team.assignedToViewerCount}
                </b>{" "}
                assigned to you
              </span>
              {running > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-info/35 bg-info/9 px-1.5 text-info-foreground">
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  <span className="tabular-nums">{running}</span> running
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function LinearJumpBackIn({
  issues,
  context,
}: {
  issues: ReadonlyArray<LinearIssue>;
  context: LinearIssueRowContext;
}) {
  if (issues.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <LinearSectionTitle>Jump back in</LinearSectionTitle>
      <LinearIssueList issues={issues} groupBy="none" context={context} />
    </section>
  );
}

export function LinearProjectList({
  projects,
  onOpenProject,
}: {
  projects: ReadonlyArray<LinearProject>;
  onOpenProject: (projectId: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {projects.map((project) => {
        const target = formatLinearTargetDate(project.targetDate);
        return (
          <button
            key={project.id}
            type="button"
            data-testid="linear-project-row"
            onClick={() => onOpenProject(project.id)}
            className="flex h-11 w-full cursor-pointer items-center gap-3 border-b border-border px-3 text-left last:border-b-0 hover:bg-accent/60"
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: project.status.color ?? "var(--muted-foreground)" }}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {project.status.name}
            </span>
            <ProgressBar progress={project.progress} />
            <span className="w-9 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
              {formatProgressPercent(project.progress)}%
            </span>
            <span className="hidden w-14 shrink-0 text-right text-xs text-muted-foreground sm:inline">
              {target ?? ""}
            </span>
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        );
      })}
    </div>
  );
}

export function LinearMilestoneList({
  milestones,
  showCompleted,
  onToggleCompleted,
  onOpenMilestone,
}: {
  milestones: ReadonlyArray<LinearMilestone>;
  showCompleted: boolean;
  onToggleCompleted: () => void;
  onOpenMilestone: (milestoneId: string) => void;
}) {
  const completedCount = milestones.filter((milestone) => milestone.completed).length;
  const visible = milestones
    .filter((milestone) => showCompleted || !milestone.completed)
    .toSorted((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {visible.map((milestone) => {
          const target = formatLinearTargetDate(milestone.targetDate);
          return (
            <button
              key={milestone.id}
              type="button"
              data-testid="linear-milestone-row"
              onClick={() => onOpenMilestone(milestone.id)}
              className="flex h-11 w-full cursor-pointer items-center gap-3 border-b border-border px-3 text-left last:border-b-0 hover:bg-accent/60"
            >
              <LinearMilestoneIcon progress={milestone.progress} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm font-medium",
                  milestone.completed && "font-normal text-muted-foreground",
                )}
              >
                {milestone.name}
              </span>
              <ProgressBar progress={milestone.progress} />
              <span className="w-9 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
                {formatProgressPercent(milestone.progress)}%
              </span>
              <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:inline">
                {formatIssueCount(milestone.issueCount, milestone.issueCountCapped)}
              </span>
              <span className="hidden w-14 shrink-0 text-right text-xs text-muted-foreground sm:inline">
                {target ?? ""}
              </span>
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
        <button
          type="button"
          data-testid="linear-no-milestone-row"
          onClick={() => onOpenMilestone(NO_MILESTONE_ID)}
          className="flex h-11 w-full cursor-pointer items-center gap-3 px-3 text-left hover:bg-accent/60"
        >
          <LinearMilestoneIcon progress={0} className="opacity-50" />
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            No milestone
          </span>
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </div>
      {completedCount > 0 ? (
        <button
          type="button"
          onClick={onToggleCompleted}
          className="w-fit cursor-pointer text-2xs text-muted-foreground hover:text-foreground"
        >
          {showCompleted ? "Hide completed" : `Show completed (${completedCount})`}
        </button>
      ) : null}
    </div>
  );
}
