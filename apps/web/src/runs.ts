import type { Project, SidebarThreadSummary } from "./types";

export type AgentRunStatus =
  | "awaiting-approval"
  | "awaiting-input"
  | "running"
  | "completed"
  | "interrupted"
  | "failed";

export interface AgentRun {
  thread: SidebarThreadSummary;
  project: Project | null;
  status: AgentRunStatus;
  statusAt: string;
}

const STATUS_PRIORITY: Record<AgentRunStatus, number> = {
  "awaiting-approval": 6,
  "awaiting-input": 5,
  running: 4,
  failed: 3,
  interrupted: 2,
  completed: 1,
};

export function resolveAgentRunStatus(thread: SidebarThreadSummary): AgentRunStatus | null {
  if (!thread.latestTurn) {
    return null;
  }
  if (thread.hasPendingApprovals) {
    return "awaiting-approval";
  }
  if (thread.hasPendingUserInput) {
    return "awaiting-input";
  }
  if (thread.latestTurn.state === "running") {
    return "running";
  }
  if (thread.latestTurn.state === "error") {
    return "failed";
  }
  return thread.latestTurn.state;
}

export function buildAgentRuns(input: {
  threads: readonly SidebarThreadSummary[];
  projects: readonly Project[];
}): AgentRun[] {
  const projectsByKey = new Map(
    input.projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );

  return input.threads
    .flatMap((thread): AgentRun[] => {
      const status = resolveAgentRunStatus(thread);
      if (!status || !thread.latestTurn) {
        return [];
      }

      return [
        {
          thread,
          project: projectsByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
          status,
          statusAt:
            thread.latestTurn.completedAt ??
            thread.latestTurn.startedAt ??
            thread.latestTurn.requestedAt,
        },
      ];
    })
    .sort(
      (left, right) =>
        STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status] ||
        right.statusAt.localeCompare(left.statusAt),
    );
}

export function isAgentRunActive(run: AgentRun): boolean {
  return isAgentRunStatusActive(run.status);
}

export function isThreadAgentRunActive(thread: SidebarThreadSummary): boolean {
  const status = resolveAgentRunStatus(thread);
  return status !== null && isAgentRunStatusActive(status);
}

function isAgentRunStatusActive(status: AgentRunStatus): boolean {
  return status === "running" || status === "awaiting-approval" || status === "awaiting-input";
}
