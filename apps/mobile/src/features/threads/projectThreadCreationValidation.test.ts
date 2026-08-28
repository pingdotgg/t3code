import { describe, expect, it } from "vite-plus/test";

import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";

describe("resolveProjectThreadCreationBranch", () => {
  it("uses the live checkout for an untouched local draft label and recorded branch", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        selectedWorktreePath: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("feature/x");
  });

  it("prefers an explicit picker choice over the current checkout", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: "main",
        selectedWorktreePath: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });

  it("stays null when no ref is checked out (detached HEAD, non-repository, status not loaded)", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        selectedWorktreePath: null,
        currentCheckoutBranch: null,
      }),
    ).toBeNull();
  });

  it("never borrows the current checkout for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: null,
        selectedWorktreePath: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBeNull();
  });

  it("keeps the explicit base branch for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: "main",
        selectedWorktreePath: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });

  it("keeps a selected detached worktree detached", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        selectedWorktreePath: "/worktrees/detached",
        currentCheckoutBranch: "main",
      }),
    ).toBeNull();
  });
});
