import { describe, expect, it } from "vite-plus/test";

import { withUpstreamLayoutNames } from "./forkLegacyLayoutEnv.ts";

describe("withUpstreamLayoutNames", () => {
  it("hands a layout command each Lathe variable under upstream's name too", () => {
    expect(
      withUpstreamLayoutNames({
        LATHE_PROJECT_ROOT: "/repo",
        LATHE_WORKTREE_BRANCH: "lathe/feature",
        LATHE_WORKTREE_BASE: "",
      }),
    ).toEqual({
      LATHE_PROJECT_ROOT: "/repo",
      LATHE_WORKTREE_BRANCH: "lathe/feature",
      LATHE_WORKTREE_BASE: "",
      T3_PROJECT_ROOT: "/repo",
      T3_WORKTREE_BRANCH: "lathe/feature",
      T3_WORKTREE_BASE: "",
    });
  });

  it("leaves every other variable under its one name", () => {
    expect(withUpstreamLayoutNames({ PATH: "/usr/bin", GIT_DIR: "" })).toEqual({
      PATH: "/usr/bin",
      GIT_DIR: "",
    });
  });
});
