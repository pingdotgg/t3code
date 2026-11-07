import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  managedWorktreesDirectories,
  parseRelativeWorktreesDirectory,
} from "./worktreesDirectory.ts";

describe("managedWorktreesDirectories", () => {
  it.effect("keeps in-project settings out of the shared roots orphan scans and access use", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        managedWorktreesDirectories(
          {
            worktreesDirectory: ".claude/worktrees",
            previousWorktreesDirectories: ["~/worktrees", "worktrees", "/old/worktrees"],
          },
          "/home/user/.t3/worktrees",
          yield* Path.Path,
          "/home/user",
        ),
        ["/home/user/.t3/worktrees", "/home/user/worktrees", "/old/worktrees"],
      );
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );
});

describe("parseRelativeWorktreesDirectory", () => {
  it.each([
    [".claude/worktrees", [".claude", "worktrees"]],
    [".claude/worktrees/", [".claude", "worktrees"]],
    ["a//b", ["a", "b"]],
    // Backslashes split too, so a setting synced from Windows names the same folders.
    [".claude\\worktrees", [".claude", "worktrees"]],
    ["work trees/[wip] #1 !x/ünï", ["work trees", "[wip] #1 !x", "ünï"]],
    ["a.git/.github/gitx", ["a.git", ".github", "gitx"]],
  ])("accepts %j", (setting, segments) => {
    assert.deepEqual(parseRelativeWorktreesDirectory(setting), segments);
  });

  it.each([
    "",
    "/",
    // Absolute and home settings keep their existing resolution.
    "/abs/worktrees",
    "~",
    "~/worktrees",
    "~other/worktrees",
    // Traversal and no-op segments.
    "..",
    "../escape",
    "a/../b",
    "a\\..\\b",
    ".",
    "./a",
    "a/./b",
    // The repository's own directory, in any case or Windows alias.
    ".git",
    ".GIT/worktrees",
    "a/.Git/b",
    "a/.git./b",
    "a/.git /b",
    "git~1/b",
    // Foreign-platform roots must never read as relative.
    "C:\\worktrees",
    "C:/worktrees",
    "c:worktrees",
    "\\\\server\\share\\worktrees",
    "\\worktrees",
    // Names Windows cannot hold or silently rewrites.
    "a:b",
    "a*b",
    "a?b",
    'a"b',
    "a|b",
    "a<b>",
    "nul",
    "a/CON.txt",
    "com1/b",
    "a./b",
    "a /b",
    // Control characters would break exclude lines and terminal output.
    "a\nb",
    "a\rb",
    "a\tb",
    "a\u0000b",
    "a\u007fb",
  ])("rejects %j", (setting) => {
    assert.isNull(parseRelativeWorktreesDirectory(setting));
  });
});
