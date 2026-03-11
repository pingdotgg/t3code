import { describe, expect, it } from "vitest";

import { resolveGitPanelContext } from "./gitPanelContext";

describe("resolveGitPanelContext", () => {
  it("uses the primary workspace when no dedicated worktree exists", () => {
    expect(
      resolveGitPanelContext({
        activeProjectId: "project-1",
        activeProjectCwd: "/repo",
        activeThreadId: "thread-1",
        activeThreadWorktreePath: null,
        repoRoot: "/repo",
      }),
    ).toEqual({
      activeProjectId: "project-1",
      activeThreadId: "thread-1",
      repoRoot: "/repo",
      repoCwd: "/repo",
      workspaceCwd: "/repo",
      workspaceKind: "primary",
      contextKey: "project-1::thread-1::/repo::/repo",
    });
  });

  it("uses the dedicated worktree when the thread is attached to one", () => {
    expect(
      resolveGitPanelContext({
        activeProjectId: "project-1",
        activeProjectCwd: "/repo",
        activeThreadId: "thread-1",
        activeThreadWorktreePath: "/repo/.worktrees/thread-1",
        repoRoot: "/repo",
      }),
    ).toEqual({
      activeProjectId: "project-1",
      activeThreadId: "thread-1",
      repoRoot: "/repo",
      repoCwd: "/repo",
      workspaceCwd: "/repo/.worktrees/thread-1",
      workspaceKind: "dedicated",
      contextKey: "project-1::thread-1::/repo::/repo/.worktrees/thread-1",
    });
  });

  it("falls back to project scope when no thread is active", () => {
    expect(
      resolveGitPanelContext({
        activeProjectId: "project-2",
        activeProjectCwd: "/repo-b",
        activeThreadId: null,
        activeThreadWorktreePath: null,
        repoRoot: null,
      }),
    ).toEqual({
      activeProjectId: "project-2",
      activeThreadId: null,
      repoRoot: null,
      repoCwd: "/repo-b",
      workspaceCwd: "/repo-b",
      workspaceKind: "primary",
      contextKey: "project-2::none::none::/repo-b",
    });
  });
});
