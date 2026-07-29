import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { worktreeResourceThreadId } from "./worktreeResource.ts";

describe("worktreeResourceThreadId", () => {
  const projectId = ProjectId.make("project-1");

  it("is stable for every client viewing the same checkout", () => {
    expect(worktreeResourceThreadId(projectId, "/repo/worktree")).toBe(
      worktreeResourceThreadId(projectId, "/repo/worktree"),
    );
  });

  it("keeps whitespace-bearing paths distinct", () => {
    expect(worktreeResourceThreadId(projectId, "/repo/worktree")).not.toBe(
      worktreeResourceThreadId(projectId, "/repo/worktree "),
    );
  });

  it("uses one owner for blank and local-checkout paths", () => {
    expect(worktreeResourceThreadId(projectId, null)).toBe(worktreeResourceThreadId(projectId, ""));
  });
});
