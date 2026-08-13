import { ProjectId, type OrchestrationThreadWorktree } from "@t3tools/contracts";

interface ThreadRootConfig {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly worktrees?: ReadonlyArray<OrchestrationThreadWorktree> | undefined;
}

interface ProjectRootConfig {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly repoRoots?: ReadonlyArray<string> | undefined;
}

function uniquePaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths)];
}

/** Resolve every working directory a thread should operate on, in project order. */
export function resolveThreadRepoRoots(input: {
  readonly worktreePath: string | null;
  readonly worktrees?: ReadonlyArray<OrchestrationThreadWorktree> | undefined;
  readonly repoRoots: ReadonlyArray<string>;
  readonly workspaceRoot: string;
}): ReadonlyArray<string> {
  const worktrees = input.worktrees ?? [];
  if (worktrees.length > 0) {
    return uniquePaths(worktrees.map((entry) => entry.worktreePath));
  }
  if (input.worktreePath) {
    return [input.worktreePath];
  }
  return uniquePaths(input.repoRoots.length > 0 ? input.repoRoots : [input.workspaceRoot]);
}

/** Resolve the primary working directory for a provider session. */
export function resolveThreadWorkspaceCwd(input: {
  readonly thread: ThreadRootConfig;
  readonly projects: ReadonlyArray<ProjectRootConfig>;
}): string | undefined {
  const project = input.projects.find((candidate) => candidate.id === input.thread.projectId);
  const worktrees = input.thread.worktrees ?? [];
  if (worktrees.length > 0) {
    return (
      (project ? worktrees.find((entry) => entry.repoRoot === project.workspaceRoot) : undefined) ??
      worktrees[0]
    )?.worktreePath;
  }
  if (input.thread.worktreePath) {
    return input.thread.worktreePath;
  }
  if (!project) {
    return undefined;
  }
  return resolveThreadRepoRoots({
    worktreePath: null,
    repoRoots: project.repoRoots ?? [],
    workspaceRoot: project.workspaceRoot,
  })[0];
}
