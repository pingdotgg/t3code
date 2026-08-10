/**
 * Pure helpers for deciding whether an archived chat should schedule worktree cleanup.
 */

export function isRemovableArchiveWorktreePath(input: {
  readonly canonicalWorktreePath: string;
  readonly canonicalWorkspaceRoot: string;
}): boolean {
  return input.canonicalWorktreePath !== input.canonicalWorkspaceRoot;
}

export function shouldScheduleArchiveWorktreeCleanup(input: {
  readonly pullRequestState: "open" | "closed" | "merged" | null | undefined;
  readonly hasActiveOwner: boolean;
  readonly isRemovableWorktreePath: boolean;
}): boolean {
  return (
    input.pullRequestState === "merged" && !input.hasActiveOwner && input.isRemovableWorktreePath
  );
}
