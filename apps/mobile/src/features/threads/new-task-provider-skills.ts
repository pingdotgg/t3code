import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

export type NewTaskWorkspaceMode = "local" | "worktree";

export function promptHasNewTaskProviderSkillReference(prompt: string): boolean {
  return collectComposerInlineTokens(prompt).some((token) => token.type === "skill");
}

/**
 * Resolves the only workspace path whose skills are safe to expose before a
 * task exists. A future worktree has no materialized directory yet, so using a
 * checkout for its selected base branch could leak uncommitted skills that the
 * new worktree will not contain. Returning null keeps the provider snapshot as
 * the fallback until the task has a real cwd.
 */
export function resolveNewTaskProviderSkillsCwd(input: {
  readonly workspaceMode: NewTaskWorkspaceMode;
  readonly selectedWorktreePath: string | null;
  readonly projectWorkspaceRoot: string | null;
}): string | null {
  if (input.workspaceMode === "worktree") {
    return null;
  }

  return input.selectedWorktreePath ?? input.projectWorkspaceRoot;
}
