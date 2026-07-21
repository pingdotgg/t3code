import { describe, expect, it } from "vite-plus/test";

import { buildLaunchContextEnv, mergeResolvedProjectLaunchEnv } from "./projectLaunchEnvUtils.ts";

describe("projectLaunchEnvUtils", () => {
  it("builds launch context env", () => {
    expect(
      buildLaunchContextEnv({
        projectRoot: "/repo",
        projectId: "project-1",
        threadId: "thread-1",
        worktreePath: "/repo/worktree-a",
      }),
    ).toEqual({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_PROJECT_ID: "project-1",
      T3CODE_THREAD_ID: "thread-1",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("merges custom env with authoritative server and launch values", () => {
    expect(
      mergeResolvedProjectLaunchEnv({
        extraEnv: {
          T3CODE_PROJECT_ROOT: "/custom-root",
          T3CODE_PORT: "3773",
          T3_MCP_BEARER_TOKEN: "client-token",
          T3_CUSTOM: "client-custom",
          CUSTOM_FLAG: "1",
        },
        t3Home: "/data/.t3",
        context: {
          projectRoot: "/repo",
          projectId: "project-1",
          threadId: "thread-1",
          worktreePath: "/repo/worktree-a",
        },
      }),
    ).toEqual({
      CUSTOM_FLAG: "1",
      T3CODE_HOME: "/data/.t3",
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_PROJECT_ID: "project-1",
      T3CODE_THREAD_ID: "thread-1",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });
});
