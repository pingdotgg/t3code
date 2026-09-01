import { describe, expect, it } from "vite-plus/test";

import { resolveNewTaskSendAction } from "./newTaskSendAction";

describe("resolveNewTaskSendAction", () => {
  it("sends a local task without needing a base branch", () => {
    expect(resolveNewTaskSendAction({ workspaceMode: "local", resolvedBranch: null })).toBe("send");
  });

  it("sends a local task even when a branch happens to be resolved", () => {
    expect(resolveNewTaskSendAction({ workspaceMode: "local", resolvedBranch: "main" })).toBe(
      "send",
    );
  });

  it("sends a worktree task once a base branch resolves", () => {
    expect(resolveNewTaskSendAction({ workspaceMode: "worktree", resolvedBranch: "main" })).toBe(
      "send",
    );
  });

  it("routes a worktree tap to the branch picker when nothing resolves", () => {
    expect(resolveNewTaskSendAction({ workspaceMode: "worktree", resolvedBranch: null })).toBe(
      "pick-branch",
    );
  });
});
