export interface GitPanelContextInput {
  activeProjectId: string | null;
  activeProjectCwd: string | null;
  activeThreadId: string | null;
  activeThreadWorktreePath: string | null;
  repoRoot: string | null;
}

export interface GitPanelContext {
  activeProjectId: string | null;
  activeThreadId: string | null;
  repoRoot: string | null;
  repoCwd: string | null;
  workspaceCwd: string | null;
  workspaceKind: "primary" | "dedicated" | "none";
  contextKey: string;
}

function toKeyPart(value: string | null): string {
  return value && value.length > 0 ? value : "none";
}

export function resolveGitPanelContext(input: GitPanelContextInput): GitPanelContext {
  const repoCwd = input.repoRoot ?? input.activeProjectCwd ?? null;
  const workspaceCwd = input.activeThreadWorktreePath ?? repoCwd;
  const workspaceKind = input.activeThreadWorktreePath
    ? "dedicated"
    : workspaceCwd
      ? "primary"
      : "none";
  const contextKey = [
    toKeyPart(input.activeProjectId),
    toKeyPart(input.activeThreadId),
    toKeyPart(input.repoRoot),
    toKeyPart(workspaceCwd),
  ].join("::");

  return {
    activeProjectId: input.activeProjectId,
    activeThreadId: input.activeThreadId,
    repoRoot: input.repoRoot,
    repoCwd,
    workspaceCwd,
    workspaceKind,
    contextKey,
  };
}
