import { describe, expect, it } from "bun:test";

import {
  resolveInitialBranch,
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
