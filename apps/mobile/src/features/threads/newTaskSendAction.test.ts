import { describe, expect, it } from "vite-plus/test";

import { resolveNewTaskSendAction } from "./newTaskSendAction";

describe("resolveNewTaskSendAction", () => {
  it("sends a settled local task without needing a base branch", () => {
    expect(
      resolveNewTaskSendAction({
        workspaceMode: "local",
        resolvedBranch: null,
        workspaceModeSettled: true,
      }),
    ).toBe("send");
  });

  it("routes a provisional local task to the picker until the mode settles", () => {
    // An unsettled "local" could resolve to "worktree" once t3.json loads, so
    // never auto-send it — that would silently misroute the task.
    expect(
      resolveNewTaskSendAction({
        workspaceMode: "local",
        resolvedBranch: null,
        workspaceModeSettled: false,
      }),
    ).toBe("pick-branch");
  });

  it("sends a local task even when a branch happens to be resolved", () => {
    expect(
      resolveNewTaskSendAction({
        workspaceMode: "local",
        resolvedBranch: "main",
        workspaceModeSettled: true,
      }),
    ).toBe("send");
  });

  it("sends a worktree task once a base branch resolves and the mode is settled", () => {
    expect(
      resolveNewTaskSendAction({
        workspaceMode: "worktree",
        resolvedBranch: "main",
        workspaceModeSettled: true,
      }),
    ).toBe("send");
  });

  it("routes a worktree tap to the branch picker when no branch resolves", () => {
    expect(
      resolveNewTaskSendAction({
        workspaceMode: "worktree",
        resolvedBranch: null,
        workspaceModeSettled: true,
      }),
    ).toBe("pick-branch");
  });

  it("routes a worktree tap to the picker while the mode is still unsettled, even with a branch", () => {
    // The provisional mode could resolve away from worktree once t3.json loads,
    // so never auto-send (or freeze it into the draft) — let the user settle it.
    expect(
      resolveNewTaskSendAction({
        workspaceMode: "worktree",
        resolvedBranch: "main",
        workspaceModeSettled: false,
      }),
    ).toBe("pick-branch");
  });
});
