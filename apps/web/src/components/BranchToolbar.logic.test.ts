import { ThreadId, type GitBranch } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { deriveSyncedLocalBranch } from "./BranchToolbar.logic";

const branches: GitBranch[] = [
  {
    name: "main",
    current: true,
    isDefault: true,
    worktreePath: null,
  },
  {
    name: "feature/demo",
    current: false,
    isDefault: false,
    worktreePath: null,
  },
];

describe("deriveSyncedLocalBranch", () => {
  it("syncs to git current branch in local mode", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const result = deriveSyncedLocalBranch({
      activeThreadId: threadId,
      activeWorktreePath: null,
      envMode: "local",
      activeThreadBranch: "feature/demo",
      queryBranches: branches,
    });

    expect(result).toBe("main");
  });

  it("does not sync when creating a new worktree", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const result = deriveSyncedLocalBranch({
      activeThreadId: threadId,
      activeWorktreePath: null,
      envMode: "worktree",
      activeThreadBranch: "feature/demo",
      queryBranches: branches,
    });

    expect(result).toBeNull();
  });

  it("does not sync when thread already targets a worktree path", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const result = deriveSyncedLocalBranch({
      activeThreadId: threadId,
      activeWorktreePath: "/tmp/repo/worktrees/feature-demo",
      envMode: "local",
      activeThreadBranch: "feature/demo",
      queryBranches: branches,
    });

    expect(result).toBeNull();
  });
});
