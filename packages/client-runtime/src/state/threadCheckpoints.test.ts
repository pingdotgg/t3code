import { describe, expect, it } from "vite-plus/test";

import { resolveCheckpointFilePath } from "./threadCheckpoints.ts";

const repository = (pathPrefix: string, worktreePath: string) => ({ pathPrefix, worktreePath });

describe("resolveCheckpointFilePath", () => {
  it("keeps the same file in two repositories apart", () => {
    const repositories = [
      repository("alpha", "/worktrees/alpha/work"),
      repository("beta", "/worktrees/beta/work"),
    ];

    expect(resolveCheckpointFilePath(repositories, "alpha/README.md")).toEqual({
      worktreePath: "/worktrees/alpha/work",
      relativePath: "README.md",
    });
    expect(resolveCheckpointFilePath(repositories, "beta/README.md")).toEqual({
      worktreePath: "/worktrees/beta/work",
      relativePath: "README.md",
    });
  });

  it("sends a submodule's own worktree files there, not to its parent", () => {
    const repositories = [
      repository("server", "/worktrees/server/work"),
      repository("server/framework", "/worktrees/framework/work"),
    ];

    expect(resolveCheckpointFilePath(repositories, "server/framework/lib/core.ts")).toEqual({
      worktreePath: "/worktrees/framework/work",
      relativePath: "lib/core.ts",
    });
    expect(resolveCheckpointFilePath(repositories, "server/app.ts")?.worktreePath).toBe(
      "/worktrees/server/work",
    );
  });

  it("leaves the thread's own files, including look-alike names, in its workspace", () => {
    expect(
      resolveCheckpointFilePath([repository("alpha", "/worktrees/alpha")], "alphabet/notes.md"),
    ).toBeNull();
    expect(resolveCheckpointFilePath(undefined, "README.md")).toBeNull();
  });
});
