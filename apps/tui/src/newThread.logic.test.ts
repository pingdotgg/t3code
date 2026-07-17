import { describe, expect, it } from "bun:test";

import {
  resolveInitialBranch,
  resolveNewThreadBranchSelection,
  resolveNewThreadContext,
  validateNewThread,
} from "./newThread.logic.ts";

const projects = [{ id: "project-one" }, { id: "project-two" }] as never;
const refs = [
  {
    name: "feature/tui",
    current: true,
    isDefault: false,
    worktreePath: null,
  },
  { name: "main", current: false, isDefault: true, worktreePath: null },
] as never;

describe("new-thread parity with the web UI", () => {
  it("Given a selected thread, when opening a new thread, then its project and workspace are inherited", () => {
    expect(
      resolveNewThreadContext({
        projects,
        thread: {
          projectId: "project-two",
          branch: "feature/tui",
          worktreePath: "/tmp/t3code-feature-tui",
        } as never,
        defaultEnvironmentMode: "local",
      }),
    ).toEqual({
      projectIndex: 1,
      workspaceMode: "current",
      branch: "feature/tui",
      worktreePath: "/tmp/t3code-feature-tui",
    });
  });

  it("Given no selected thread and worktree is the server default, then a new worktree is preselected", () => {
    expect(
      resolveNewThreadContext({
        projects,
        thread: null,
        defaultEnvironmentMode: "worktree",
      }).workspaceMode,
    ).toBe("new-worktree");
  });

  it("Given refs are loaded, then the current branch is selected for a new-worktree draft", () => {
    expect(resolveInitialBranch(refs, null)).toBe("feature/tui");
  });

  it("Given a new-worktree draft, when another ref is selected, then it becomes the base without switching a checkout", () => {
    expect(
      resolveNewThreadBranchSelection({
        workspaceMode: "new-worktree",
        projectCwd: "/repo",
        currentWorktreePath: "/repo/.t3/worktrees/current",
        ref: {
          name: "origin/feature/base",
          current: false,
          isDefault: false,
          isRemote: true,
          worktreePath: null,
        } as never,
      }),
    ).toEqual({
      kind: "select-base",
      branch: "origin/feature/base",
      worktreePath: null,
    });
  });

  it("Given a branch already has a worktree, when it is selected for the current workspace, then that worktree is reused", () => {
    expect(
      resolveNewThreadBranchSelection({
        workspaceMode: "current",
        projectCwd: "/repo",
        currentWorktreePath: null,
        ref: {
          name: "feature/existing",
          current: false,
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/existing",
        } as never,
      }),
    ).toEqual({
      kind: "reuse-worktree",
      branch: "feature/existing",
      worktreePath: "/repo/.t3/worktrees/existing",
    });
  });

  it("Given an unchecked-out branch, when it is selected for the current workspace, then the active checkout is switched", () => {
    expect(
      resolveNewThreadBranchSelection({
        workspaceMode: "current",
        projectCwd: "/repo",
        currentWorktreePath: "/repo/.t3/worktrees/current",
        ref: {
          name: "origin/feature/next",
          current: false,
          isDefault: false,
          isRemote: true,
          worktreePath: null,
        } as never,
      }),
    ).toEqual({
      kind: "switch-checkout",
      branch: "feature/next",
      checkoutCwd: "/repo/.t3/worktrees/current",
      worktreePath: "/repo/.t3/worktrees/current",
    });
  });

  it("Given New worktree has no base branch, when validating, then creation is blocked", () => {
    expect(
      validateNewThread({
        hasProject: true,
        message: "Implement it",
        hasModelSelection: true,
        workspaceMode: "new-worktree",
        branch: null,
      }),
    ).toBe("missing-base-branch");
  });

  it("Given an empty task, when validating, then the local draft remains invalid", () => {
    expect(
      validateNewThread({
        hasProject: true,
        message: "  ",
        hasModelSelection: true,
        workspaceMode: "current",
        branch: "main",
      }),
    ).toBe("missing-message");
  });
});
