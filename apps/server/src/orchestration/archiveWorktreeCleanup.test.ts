import { describe, expect, it } from "vitest";

import { isRemovableArchiveWorktreePath } from "./archiveWorktreeCleanup.ts";

describe("archiveWorktreeCleanup", () => {
  it("rejects the project workspace root", () => {
    expect(
      isRemovableArchiveWorktreePath({
        canonicalWorktreePath: "/repo",
        canonicalWorkspaceRoot: "/repo",
      }),
    ).toBe(false);
  });

  it("allows linked worktree paths", () => {
    expect(
      isRemovableArchiveWorktreePath({
        canonicalWorktreePath: "/repo-worktrees/feature",
        canonicalWorkspaceRoot: "/repo",
      }),
    ).toBe(true);
  });

  it("rejects worktree paths nested below the project workspace root", () => {
    expect(
      isRemovableArchiveWorktreePath({
        canonicalWorktreePath: "/repo/nested/feature",
        canonicalWorkspaceRoot: "/repo",
      }),
    ).toBe(false);
  });
});
