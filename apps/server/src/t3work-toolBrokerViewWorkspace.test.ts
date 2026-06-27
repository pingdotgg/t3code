import { describe, expect, it } from "vite-plus/test";

import { buildThreadWorkspaceView } from "./t3work-toolBrokerViewWorkspace.ts";

describe("buildThreadWorkspaceView", () => {
  it("reports metarepo scope when the thread has no worktree", () => {
    expect(
      buildThreadWorkspaceView({
        thread: { branch: null, worktreePath: null },
        project: { workspaceRoot: "/workspace/project-1" },
      }),
    ).toEqual({
      executionScope: "metarepo",
      workspace: {
        executionScope: "metarepo",
        projectWorkspaceRoot: "/workspace/project-1",
        currentWorkspaceRoot: "/workspace/project-1",
        worktreePath: null,
        branch: null,
      },
    });
  });

  it("reports repository scope when the thread has a scoped worktree", () => {
    expect(
      buildThreadWorkspaceView({
        thread: {
          branch: "feature/review-repo-child",
          worktreePath:
            "/workspace/project-1/.t3work/child-session-worktrees/pingdotgg-t3code/feature",
        },
        project: { workspaceRoot: "/workspace/project-1" },
      }),
    ).toEqual({
      executionScope: "repository",
      workspace: {
        executionScope: "repository",
        projectWorkspaceRoot: "/workspace/project-1",
        currentWorkspaceRoot:
          "/workspace/project-1/.t3work/child-session-worktrees/pingdotgg-t3code/feature",
        worktreePath:
          "/workspace/project-1/.t3work/child-session-worktrees/pingdotgg-t3code/feature",
        branch: "feature/review-repo-child",
      },
    });
  });
});
