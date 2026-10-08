import { describe, expect, it } from "vite-plus/test";

import { projectScriptCwd } from "./projectScripts.ts";

describe("projectScriptCwd", () => {
  it("uses the project directory without a worktree", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo/ios", repositoryRoot: "/repo" },
        worktreePath: null,
      }),
    ).toBe("/repo/ios");
  });

  it("keeps the project's subdirectory inside a worktree", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo/apps/ios", repositoryRoot: "/repo" },
        worktreePath: "/worktrees/repo/feature",
      }),
    ).toBe("/worktrees/repo/feature/apps/ios");
  });

  it("uses the worktree for a project at the repository root", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo/", repositoryRoot: "/repo" },
        worktreePath: "/worktrees/repo/feature",
      }),
    ).toBe("/worktrees/repo/feature");
  });

  it("uses the worktree when the repository root is unknown or unrelated", () => {
    expect(
      projectScriptCwd({ project: { cwd: "/repo/ios" }, worktreePath: "/worktrees/feature" }),
    ).toBe("/worktrees/feature");
    expect(
      projectScriptCwd({
        project: { cwd: "/repo-other/ios", repositoryRoot: "/repo" },
        worktreePath: "/worktrees/feature",
      }),
    ).toBe("/worktrees/feature");
  });

  it("joins Windows paths with backslashes and keeps the subdirectory's case", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "C:\\Repo\\Apps\\iOS", repositoryRoot: "c:/repo" },
        worktreePath: "C:\\worktrees\\feature",
      }),
    ).toBe("C:\\worktrees\\feature\\Apps\\iOS");
  });
});
