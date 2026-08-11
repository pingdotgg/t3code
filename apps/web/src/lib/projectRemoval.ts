import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

interface ProjectRemovalTarget {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

interface ProjectRemovalThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function projectThreadCount(
  project: ProjectRemovalTarget,
  threads: ReadonlyArray<ProjectRemovalThread>,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.environmentId === project.environmentId && thread.projectId === project.id) {
      count += 1;
    }
  }
  return count;
}

export function projectDeleteCommandInput(
  projectId: ProjectId,
  threadCount: number,
): {
  readonly projectId: ProjectId;
  readonly force?: true;
} {
  return {
    projectId,
    ...(threadCount > 0 ? { force: true as const } : {}),
  };
}
