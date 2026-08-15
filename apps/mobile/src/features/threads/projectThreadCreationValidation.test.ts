import { describe, expect, it } from "vite-plus/test";

import { resolveProjectThreadWorkspaceSelection } from "./projectThreadCreationValidation";

describe("resolveProjectThreadWorkspaceSelection", () => {
  it("preserves git project workspace selections", () => {
    expect(
      resolveProjectThreadWorkspaceSelection({
        isGitRepo: true,
        environmentMode: "worktree",
        branch: "main",
        worktreePath: "/repo/.t3/worktrees/feature",
      }),
    ).toEqual({
      environmentMode: "worktree",
      branch: "main",
      worktreePath: "/repo/.t3/worktrees/feature",
    });
  });

  it("forces non-git projects onto the local checkout without git metadata", () => {
    expect(
      resolveProjectThreadWorkspaceSelection({
        isGitRepo: false,
        environmentMode: "worktree",
        branch: "stale-branch",
        worktreePath: "/stale/worktree",
      }),
    ).toEqual({
      environmentMode: "local",
      branch: null,
      worktreePath: null,
    });
  });
});
