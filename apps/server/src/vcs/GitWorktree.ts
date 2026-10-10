/** A checkout registered in local Git metadata. */
export interface GitWorktree {
  readonly path: string;
  readonly refName: string | null;
  readonly headCommit: string | null;
  readonly prunable: boolean;
}

/**
 * Parse `git worktree list --porcelain -z`. Fields are NUL-terminated and
 * records end with an extra NUL, so paths may contain newlines. `-z` needs
 * Git 2.36, which listRefs already requires.
 */
export function parseGitWorktreeListPorcelain(stdout: string): GitWorktree[] {
  const entries: GitWorktree[] = [];
  let currentPath: string | null = null;
  let currentRefName: string | null = null;
  let currentHeadCommit: string | null = null;
  let currentPrunable = false;

  const flush = () => {
    if (currentPath !== null) {
      entries.push({
        path: currentPath,
        refName: currentRefName,
        headCommit: currentHeadCommit,
        prunable: currentPrunable,
      });
    }
    currentPath = null;
    currentRefName = null;
    currentHeadCommit = null;
    currentPrunable = false;
  };

  for (const field of stdout.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      // Be tolerant of malformed output containing a new record without the
      // expected empty separator.
      if (currentPath !== null) flush();
      currentPath = field.slice("worktree ".length);
    } else if (field.startsWith("HEAD ")) {
      currentHeadCommit = field.slice("HEAD ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      currentRefName = field.slice("branch refs/heads/".length);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      currentPrunable = true;
    }
  }
  flush();

  return entries;
}

export function parseGitWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string> {
  const worktreePaths = new Map<string, string>();
  for (const entry of parseGitWorktreeListPorcelain(stdout)) {
    if (entry.refName !== null && !entry.prunable) {
      worktreePaths.set(entry.refName, entry.path);
    }
  }
  return worktreePaths;
}
