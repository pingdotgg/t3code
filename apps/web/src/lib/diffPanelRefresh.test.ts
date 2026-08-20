import { describe, expect, it } from "vite-plus/test";
import { advanceGitDiffRefreshTracker, type GitDiffRefreshTracker } from "./diffPanelRefresh";

const WORKSPACE_ROOT = "/repo";

function thread(input: {
  id: string;
  turnId?: string;
  completedAt?: string | null;
  worktreePath?: string | null;
}) {
  return {
    id: input.id,
    worktreePath: input.worktreePath ?? null,
    latestTurn: input.turnId
      ? {
          turnId: input.turnId,
          completedAt:
            input.completedAt === undefined ? "2026-08-20T12:00:00.000Z" : input.completedAt,
        }
      : null,
  };
}

function advance(
  previous: GitDiffRefreshTracker | null,
  threads: ReturnType<typeof thread>[],
  overrides: Partial<{
    scopeKey: string;
    cwd: string;
    activeThreadId: string;
  }> = {},
) {
  return advanceGitDiffRefreshTracker(previous, {
    scopeKey: overrides.scopeKey ?? `environment:${WORKSPACE_ROOT}`,
    cwd: overrides.cwd ?? WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    activeThreadId: overrides.activeThreadId ?? "active",
    threads,
  });
}

describe("advanceGitDiffRefreshTracker", () => {
  it("baselines existing sibling completions without refreshing", () => {
    const result = advance(null, [
      thread({ id: "active" }),
      thread({ id: "sibling", turnId: "1" }),
    ]);

    expect(result.shouldRefresh).toBe(false);
    expect(result.next.completedTurnIdByThread.get("sibling")).toBe("1");
  });

  it("refreshes when a sibling completes a new turn in the same checkout", () => {
    const baseline = advance(null, [thread({ id: "sibling", turnId: "1" })]).next;
    const result = advance(baseline, [thread({ id: "sibling", turnId: "2" })]);

    expect(result.shouldRefresh).toBe(true);
    expect(result.next.completedTurnIdByThread.get("sibling")).toBe("2");
  });

  it("waits for a running sibling turn to complete", () => {
    const baseline = advance(null, [thread({ id: "sibling", turnId: "1" })]).next;
    const running = advance(baseline, [thread({ id: "sibling", turnId: "2", completedAt: null })]);
    const completed = advance(running.next, [thread({ id: "sibling", turnId: "2" })]);

    expect(running.shouldRefresh).toBe(false);
    expect(completed.shouldRefresh).toBe(true);
  });

  it("ignores completions from the active thread and other worktrees", () => {
    const baseline = advance(null, []).next;
    const result = advance(baseline, [
      thread({ id: "active", turnId: "1" }),
      thread({ id: "other-worktree", turnId: "1", worktreePath: "/repo-worktree" }),
    ]);

    expect(result.shouldRefresh).toBe(false);
    expect(result.next.completedTurnIdByThread.size).toBe(0);
  });

  it("re-baselines instead of refreshing when the active checkout changes", () => {
    const baseline = advance(null, [thread({ id: "sibling", turnId: "1" })]).next;
    const result = advance(
      baseline,
      [thread({ id: "worktree-sibling", turnId: "1", worktreePath: "/repo-worktree" })],
      { scopeKey: "environment:/repo-worktree", cwd: "/repo-worktree" },
    );

    expect(result.shouldRefresh).toBe(false);
    expect(result.next.completedTurnIdByThread.get("worktree-sibling")).toBe("1");
  });
});
