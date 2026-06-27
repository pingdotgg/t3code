export type T3workViewWorkspaceThread = {
  readonly branch: string | null;
  readonly worktreePath: string | null;
};

export type T3workViewWorkspaceProject = {
  readonly workspaceRoot: string;
};

export function buildThreadWorkspaceView(input: {
  readonly thread: T3workViewWorkspaceThread;
  readonly project: T3workViewWorkspaceProject | undefined;
}) {
  const worktreePath = input.thread.worktreePath ?? null;
  const executionScope = worktreePath ? "repository" : "metarepo";
  const projectWorkspaceRoot = input.project?.workspaceRoot ?? null;

  return {
    executionScope,
    workspace: {
      executionScope,
      projectWorkspaceRoot,
      currentWorkspaceRoot: worktreePath ?? projectWorkspaceRoot,
      worktreePath,
      branch: input.thread.branch ?? null,
    },
  };
}
