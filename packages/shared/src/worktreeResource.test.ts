import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseWorktreeResourceThreadId, worktreeResourceThreadId } from "./worktreeResource.ts";

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

describe("parseWorktreeResourceThreadId", () => {
  const projectId = ProjectId.make("project-1");

  it("round-trips worktree checkout ids", () => {
    const worktreePath = "/repo/path with spaces/worktree";
    expect(
      parseWorktreeResourceThreadId(worktreeResourceThreadId(projectId, worktreePath)),
    ).toEqual({
      projectId,
      worktreePath,
    });
  });

  it("round-trips local checkout ids to a null path", () => {
    expect(parseWorktreeResourceThreadId(worktreeResourceThreadId(projectId, null))).toEqual({
      projectId,
      worktreePath: null,
    });
  });

  it("rejects non-synthetic thread ids", () => {
    expect(parseWorktreeResourceThreadId("thread-1")).toBeNull();
    expect(parseWorktreeResourceThreadId("worktree:")).toBeNull();
    expect(parseWorktreeResourceThreadId("worktree:project-1")).toBeNull();
    expect(parseWorktreeResourceThreadId("worktree:project-1:")).toBeNull();
  });
});

it("round trips project ids containing colons", () => {
  const projectId = ProjectId.make("project:with:colons");
  for (const worktreePath of [null, "/work/feature:one"]) {
    expect(
      parseWorktreeResourceThreadId(worktreeResourceThreadId(projectId, worktreePath)),
    ).toEqual({ projectId, worktreePath });
  }
});
