import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { composerMentionMenuTarget } from "./composerMentionMenuTarget";
import { resolveFileContextMenuAbsolutePath } from "../../fileContextMenu";

describe("composer mention file identity", () => {
  it("resolves against the owning remote worktree", () => {
    const target = composerMentionMenuTarget(
      EnvironmentId.make("remote"),
      "/worktrees/task",
      "src/app.ts",
    );
    expect(target?.environmentId).toBe("remote");
    expect(resolveFileContextMenuAbsolutePath(target!)).toBe("/worktrees/task/src/app.ts");
  });
  it("withholds absolute paths until the shared resolver supports them", () => {
    const target = composerMentionMenuTarget(
      EnvironmentId.make("remote"),
      "/worktrees/task",
      "/shared/file.ts",
    );
    expect(target).toBeNull();
  });
  it("cannot infer a missing environment or workspace", () => {
    expect(composerMentionMenuTarget(null, "/task", "a.ts")).toBeNull();
    expect(composerMentionMenuTarget(EnvironmentId.make("remote"), null, "a.ts")).toBeNull();
  });
  it("does not advertise a file menu for an empty or directory mention", () => {
    for (const path of ["", " ", "src/", "src\\"])
      expect(composerMentionMenuTarget(EnvironmentId.make("remote"), "/task", path)).toBeNull();
  });
});
