export interface WorktreeListEntry {
  readonly path: string;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly prunable: boolean;
}

/**
 * Parses NUL-separated `git worktree list --porcelain` output into entries in Git's order:
 * the main working tree (or bare repository) comes first.
 */
export function parseWorktreeList(stdout: string): ReadonlyArray<WorktreeListEntry> {
  const entries: WorktreeListEntry[] = [];
  let current: { path: string; branch: string | null; bare: boolean; prunable: boolean } | null =
    null;

  const flush = () => {
    if (current !== null) entries.push(current);
    current = null;
  };

  for (const field of stdout.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      flush();
      current = {
        path: field.slice("worktree ".length),
        branch: null,
        bare: false,
        prunable: false,
      };
    } else if (current === null) {
      continue;
    } else if (field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    } else if (field === "bare") {
      current.bare = true;
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  flush();

  return entries;
}
