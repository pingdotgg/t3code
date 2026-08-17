import type { VcsWorkspace } from "@t3tools/contracts";

/**
 * Parse the newline format from `git worktree list --porcelain`. We avoid
 * `-z` because it requires Git 2.36, newer than Ubuntu 22.04's Git 2.34.
 * Paths containing newlines are unsupported, matching the rest of the driver.
 */
export function parseGitWorktreeListPorcelain(stdout: string): VcsWorkspace[] {
  const entries: VcsWorkspace[] = [];
  let currentPath: string | null = null;
  let currentRefName: string | null = null;
  let currentPrunable = false;

  const flush = () => {
    if (currentPath !== null) {
      entries.push({
        path: currentPath,
        refName: currentRefName,
        prunable: currentPrunable,
      });
    }
    currentPath = null;
    currentRefName = null;
    currentPrunable = false;
  };

  for (const field of stdout.split(/\r?\n/)) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      // Be tolerant of malformed output containing a new record without the
      // expected empty separator.
      if (currentPath !== null) flush();
      currentPath = field.slice("worktree ".length);
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
