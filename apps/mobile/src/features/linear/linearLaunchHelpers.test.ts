import { describe, expect, it } from "vite-plus/test";

import { linearDraftWorkspaceSelection } from "./linearLaunchHelpers";

describe("linear launch helpers", () => {
  it("starts a worktree on the mapped base branch and a local checkout on the current one", () => {
    expect(
      linearDraftWorkspaceSelection({ envMode: "worktree", branch: "main", worktreePath: null }),
    ).toEqual({ mode: "worktree", branch: "main", worktreePath: null });
    expect(
      linearDraftWorkspaceSelection({ envMode: "local", branch: null, worktreePath: null }),
    ).toEqual({ mode: "local", branch: null, worktreePath: null, followsCurrentCheckout: true });
  });
});
