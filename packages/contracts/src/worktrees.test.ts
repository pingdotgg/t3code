import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsPruneWorktreesInput,
  VcsReviveWorktreeInput,
  WorktreeInventoryError,
  WorktreeMutationError,
} from "./worktrees.ts";

const decodePruneWorktreesInput = Schema.decodeUnknownSync(VcsPruneWorktreesInput);
const decodeReviveWorktreeInput = Schema.decodeUnknownSync(VcsReviveWorktreeInput);

describe("worktree filesystem paths", () => {
  it("preserves leading and trailing whitespace", () => {
    const worktreePath = " /tmp/worktree ";
    const workspaceRoot = " /tmp/repository ";

    const prune = decodePruneWorktreesInput({
      paths: [worktreePath],
    });
    const revive = decodeReviveWorktreeInput({
      workspaceRoot,
      worktreePath,
      branch: "feature/worktrees",
    });

    expect(prune.paths).toEqual([worktreePath]);
    expect(revive.workspaceRoot).toBe(workspaceRoot);
    expect(revive.worktreePath).toBe(worktreePath);
  });
});

describe("worktree errors", () => {
  it("derives messages from structural stages", () => {
    const inventoryError = new WorktreeInventoryError({
      stage: "inspect_repository",
      workspaceRoot: "/tmp/repository",
    });
    const mutationError = new WorktreeMutationError({
      operation: "revive",
      stage: "branch_in_use",
      branch: "feature/worktrees",
      conflictingPath: "/tmp/existing",
    });

    expect(inventoryError.message).toBe(
      "Failed to inspect a repository for the worktree inventory.",
    );
    expect(mutationError.message).toBe(
      "Cannot revive branch 'feature/worktrees': it is already checked out at '/tmp/existing'.",
    );
  });
});
