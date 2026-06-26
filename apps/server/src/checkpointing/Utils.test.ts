import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { resolveThreadRepoRoots, resolveThreadWorkspaceCwd } from "./Utils.ts";

describe("resolveThreadRepoRoots", () => {
  it("returns all repo roots in order for a multi-repo project", () => {
    expect(
      resolveThreadRepoRoots({
        worktreePath: null,
        repoRoots: ["/work/backend", "/work/frontend"],
        workspaceRoot: "/work",
      }),
    ).toEqual(["/work/backend", "/work/frontend"]);
  });

  it("falls back to [workspaceRoot] when no repo roots are recorded", () => {
    expect(
      resolveThreadRepoRoots({
        worktreePath: null,
        repoRoots: [],
        workspaceRoot: "/work/solo",
      }),
    ).toEqual(["/work/solo"]);
  });

  it("uses the legacy single worktree path in isolated mode, ignoring repo roots", () => {
    expect(
      resolveThreadRepoRoots({
        worktreePath: "/worktrees/p/t/backend",
        repoRoots: ["/work/backend", "/work/frontend"],
        workspaceRoot: "/work",
      }),
    ).toEqual(["/worktrees/p/t/backend"]);
  });

  it("fans out to every per-root worktree in isolated multi-repo mode", () => {
    expect(
      resolveThreadRepoRoots({
        worktreePath: "/worktrees/p/t/backend",
        worktrees: [
          { repoRoot: "/work/backend", worktreePath: "/worktrees/p/t/backend" },
          { repoRoot: "/work/frontend", worktreePath: "/worktrees/p/t/frontend" },
        ],
        repoRoots: ["/work/backend", "/work/frontend"],
        workspaceRoot: "/work",
      }),
    ).toEqual(["/worktrees/p/t/backend", "/worktrees/p/t/frontend"]);
  });
});

describe("resolveThreadWorkspaceCwd", () => {
  const projectId = ProjectId.make("project-1");
  const projects = [{ id: projectId, workspaceRoot: "/work", repoRoots: ["/work/backend"] }];

  it("anchors on the workspace-root worktree in isolated multi-repo mode", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: {
          projectId,
          worktreePath: "/worktrees/p/t/frontend",
          worktrees: [
            { repoRoot: "/oss/frontend", worktreePath: "/worktrees/p/t/frontend" },
            { repoRoot: "/work", worktreePath: "/worktrees/p/t/anchor" },
          ],
        },
        projects,
      }),
    ).toBe("/worktrees/p/t/anchor");
  });

  it("falls back to the first worktree when none matches the workspace root", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: {
          projectId,
          worktreePath: null,
          worktrees: [
            { repoRoot: "/work/backend", worktreePath: "/worktrees/p/t/backend" },
            { repoRoot: "/oss/frontend", worktreePath: "/worktrees/p/t/frontend" },
          ],
        },
        projects,
      }),
    ).toBe("/worktrees/p/t/backend");
  });

  it("falls back to the first repo root when no worktrees are recorded", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, worktreePath: null, worktrees: [] },
        projects,
      }),
    ).toBe("/work/backend");
  });
});
