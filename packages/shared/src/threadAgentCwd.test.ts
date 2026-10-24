import { describe, expect, it } from "vite-plus/test";

import { threadAgentCwd } from "./projectScripts.ts";

describe("threadAgentCwd", () => {
  it("keeps a subdirectory project's path inside the thread's worktree", () => {
    expect(
      threadAgentCwd({ projectRoot: "/repo/ios", repositoryRoot: "/repo", worktreePath: "/wt/a" }),
    ).toBe("/wt/a/ios");
    expect(
      threadAgentCwd({
        projectRoot: "C:\\repo\\apps\\ios",
        repositoryRoot: "C:\\repo",
        worktreePath: "C:\\wt\\a",
      }),
    ).toBe("C:\\wt\\a\\apps\\ios");
  });

  it("uses the worktree root when the project is the checkout or outside it", () => {
    expect(
      threadAgentCwd({ projectRoot: "/repo", repositoryRoot: "/repo", worktreePath: "/wt/a" }),
    ).toBe("/wt/a");
    expect(
      threadAgentCwd({
        projectRoot: "/repository",
        repositoryRoot: "/repo",
        worktreePath: "/wt/a",
      }),
    ).toBe("/wt/a");
    expect(threadAgentCwd({ projectRoot: "/repo/ios", worktreePath: "/wt/a" })).toBe("/wt/a");
  });

  it("uses the project root without a worktree", () => {
    expect(
      threadAgentCwd({ projectRoot: "/repo/ios", repositoryRoot: "/repo", worktreePath: null }),
    ).toBe("/repo/ios");
  });
});
