import { Schema } from "effect";
import { EnvironmentId, ProjectSearchEntriesInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  composerMentionMenuTarget,
  composerMentionSearchQuery,
  isResolvedComposerMention,
} from "./composerMentionMenuTarget";
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

it("requires an exact live file hit before offering mention actions", () => {
  const entries = [
    { path: "src/app.ts", kind: "file" },
    { path: "src/components", kind: "directory" },
  ];
  expect(isResolvedComposerMention("src/app.ts", entries)).toBe(true);
  expect(isResolvedComposerMention("app.ts", entries)).toBe(false);
  expect(isResolvedComposerMention("does-not-exist.ts", entries)).toBe(false);
  expect(isResolvedComposerMention("src/components", entries)).toBe(false);
  expect(isResolvedComposerMention("src/app.ts", [])).toBe(false);
});

it.each(["./src/app.ts", "src\\app.ts", "src/./app.ts"])(
  "normalizes %s before searching",
  (path) => {
    const target = composerMentionMenuTarget(EnvironmentId.make("remote"), "/task", path);
    expect(target?.filePath).toBe("src/app.ts");
    expect(
      isResolvedComposerMention(target!.filePath, [{ path: "src/app.ts", kind: "file" }]),
    ).toBe(true);
  },
);

it("keeps long file identity while using a contract-valid search suffix", () => {
  const path = `${"nested/".repeat(50)}app.ts`;
  const target = composerMentionMenuTarget(EnvironmentId.make("remote"), "/task", path)!;
  const input = Schema.decodeUnknownSync(ProjectSearchEntriesInput)({
    cwd: "/task",
    query: composerMentionSearchQuery(target.filePath),
    kind: "file",
    limit: 100,
  });
  expect(input.query.length).toBeLessThanOrEqual(256);
  expect(target.filePath).toBe(path);
  expect(isResolvedComposerMention(target.filePath, [{ path, kind: "file" }])).toBe(true);
  expect(isResolvedComposerMention(target.filePath, [{ path: input.query, kind: "file" }])).toBe(
    false,
  );
});
