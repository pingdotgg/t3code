/**
 * Pure path guard for archived-chat worktree cleanup.
 */
import path from "node:path";

export function isRemovableArchiveWorktreePath(input: {
  readonly canonicalWorktreePath: string;
  readonly canonicalWorkspaceRoot: string;
}): boolean {
  const relativePath = path.relative(input.canonicalWorkspaceRoot, input.canonicalWorktreePath);
  return (
    relativePath !== "" &&
    (relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath))
  );
}
