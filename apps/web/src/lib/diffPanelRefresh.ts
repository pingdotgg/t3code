interface DiffRefreshThread {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly latestTurn: {
    readonly turnId: string;
    readonly completedAt: string | null;
  } | null;
}

export interface GitDiffRefreshTracker {
  readonly scopeKey: string;
  readonly completedTurnIdByThread: ReadonlyMap<string, string>;
}

interface AdvanceGitDiffRefreshTrackerInput {
  readonly scopeKey: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly activeThreadId: string;
  readonly threads: ReadonlyArray<DiffRefreshThread>;
}

/** Tracks completed sibling turns that could have changed the active checkout. */
export function advanceGitDiffRefreshTracker(
  previous: GitDiffRefreshTracker | null,
  input: AdvanceGitDiffRefreshTrackerInput,
): {
  readonly next: GitDiffRefreshTracker;
  readonly shouldRefresh: boolean;
} {
  const sameScope = previous?.scopeKey === input.scopeKey;
  const completedTurnIdByThread = new Map(sameScope ? previous.completedTurnIdByThread : undefined);
  let shouldRefresh = false;

  for (const thread of input.threads) {
    const latestTurn = thread.latestTurn;
    const threadCwd = thread.worktreePath ?? input.workspaceRoot;
    if (
      thread.id === input.activeThreadId ||
      threadCwd !== input.cwd ||
      latestTurn === null ||
      latestTurn.completedAt === null
    ) {
      continue;
    }

    if (sameScope && completedTurnIdByThread.get(thread.id) !== latestTurn.turnId) {
      shouldRefresh = true;
    }
    completedTurnIdByThread.set(thread.id, latestTurn.turnId);
  }

  return {
    next: { scopeKey: input.scopeKey, completedTurnIdByThread },
    shouldRefresh,
  };
}
