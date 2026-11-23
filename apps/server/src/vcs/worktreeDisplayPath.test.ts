import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  extractAliasedWorktreePrefix,
  formatWorktreeDisplayPrefix,
  isNumberedWorktreePath,
  readWorktreeBranchName,
  unaliasWorktreeDisplayPath,
} from "./worktreeDisplayPath.ts";

describe("worktreeDisplayPath", () => {
  it("recognizes numbered pool worktree paths and ignores named or regular repos", () => {
    assert.isTrue(isNumberedWorktreePath("dotfiles.worktrees/1"));
    assert.isTrue(isNumberedWorktreePath("external/t3code.worktrees/12"));
    assert.isFalse(isNumberedWorktreePath("dotfiles.worktrees/pr-1"));
    assert.isFalse(isNumberedWorktreePath("dotfiles"));
    assert.isFalse(isNumberedWorktreePath("dotfiles.worktrees/1/src/file.ts"));
  });

  it("formats numbered worktree prefixes with branch names and slot numbers", () => {
    assert.strictEqual(
      formatWorktreeDisplayPrefix("dotfiles.worktrees/1", "migrate-bench-land"),
      "dotfiles [migrate-bench-land #1]",
    );
    assert.strictEqual(
      formatWorktreeDisplayPrefix("external/t3code.worktrees/2", "feat/worktree-ui"),
      "external/t3code [feat-worktree-ui #2]",
    );
    assert.strictEqual(
      formatWorktreeDisplayPrefix("dotfiles.worktrees/3", "fix/[weird]"),
      "dotfiles [fix-weird- #3]",
    );
    assert.strictEqual(formatWorktreeDisplayPrefix("dotfiles.worktrees/1", null), "dotfiles [#1]");
    assert.strictEqual(formatWorktreeDisplayPrefix("dotfiles.worktrees/1", "  "), "dotfiles [#1]");
    assert.strictEqual(formatWorktreeDisplayPrefix("dotfiles", "main"), "dotfiles");
    assert.strictEqual(
      formatWorktreeDisplayPrefix("dotfiles.worktrees/pr-1", "feat"),
      "dotfiles.worktrees/pr-1",
    );
  });

  it("unaliases relative, nested, absolute, and Windows worktree display paths", () => {
    assert.strictEqual(
      unaliasWorktreeDisplayPath("dotfiles [migrate-bench-land #1]/capabilities/foo.ts"),
      "dotfiles.worktrees/1/capabilities/foo.ts",
    );
    assert.strictEqual(
      unaliasWorktreeDisplayPath("dotfiles [#1]/capabilities/foo.ts"),
      "dotfiles.worktrees/1/capabilities/foo.ts",
    );
    assert.strictEqual(
      unaliasWorktreeDisplayPath("external/t3code [dg-custom #2]/src/index.ts"),
      "external/t3code.worktrees/2/src/index.ts",
    );
    assert.strictEqual(
      unaliasWorktreeDisplayPath("dotfiles [fix #99 #4]/a.ts"),
      "dotfiles.worktrees/4/a.ts",
    );
    assert.strictEqual(
      unaliasWorktreeDisplayPath("/Users/me/Projects/dotfiles [migrate-bench-land #1]/a.ts:42:5"),
      "/Users/me/Projects/dotfiles.worktrees/1/a.ts:42:5",
    );
    assert.strictEqual(
      unaliasWorktreeDisplayPath("C:\\Projects\\dotfiles [feat #1]\\a.ts"),
      "C:\\Projects\\dotfiles.worktrees\\1\\a.ts",
    );
    assert.strictEqual(
      unaliasWorktreeDisplayPath("dotfiles.worktrees/1/a.ts"),
      "dotfiles.worktrees/1/a.ts",
    );
    assert.strictEqual(unaliasWorktreeDisplayPath("apps/web/src/App.tsx"), "apps/web/src/App.tsx");
  });

  it("extracts an aliased display prefix matching a resolved nested worktree path", () => {
    assert.strictEqual(
      extractAliasedWorktreePrefix(
        "external/t3code [old-branch #2]/src/a.ts",
        "external/t3code.worktrees/2",
      ),
      "external/t3code [old-branch #2]",
    );
    assert.strictEqual(
      extractAliasedWorktreePrefix("dotfiles [#1]/src/a.ts", "dotfiles.worktrees/1"),
      "dotfiles [#1]",
    );
    assert.strictEqual(
      extractAliasedWorktreePrefix("dotfiles.worktrees/1/src/a.ts", "dotfiles.worktrees/1"),
      undefined,
    );
  });

  it.effect(
    "reads the checked-out branch name from linked worktree and regular .git HEAD files",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "worktree-display-" });

        const gitDir = path.join(root, "repo/.git/worktrees/1");
        const worktreeDir = path.join(root, "repo.worktrees/1");
        yield* fileSystem.makeDirectory(gitDir, { recursive: true });
        yield* fileSystem.makeDirectory(worktreeDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
        yield* fileSystem.writeFileString(
          path.join(gitDir, "HEAD"),
          "ref: refs/heads/feat/display-names\n",
        );
        assert.strictEqual(
          yield* readWorktreeBranchName(worktreeDir, fileSystem, path),
          "feat/display-names",
        );

        yield* fileSystem.writeFileString(
          path.join(gitDir, "HEAD"),
          "0123456789abcdef0123456789abcdef01234567\n",
        );
        assert.strictEqual(yield* readWorktreeBranchName(worktreeDir, fileSystem, path), null);

        const regularRepo = path.join(root, "regular");
        yield* fileSystem.makeDirectory(path.join(regularRepo, ".git"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(regularRepo, ".git/HEAD"),
          "ref: refs/heads/main\n",
        );
        assert.strictEqual(yield* readWorktreeBranchName(regularRepo, fileSystem, path), "main");

        assert.strictEqual(
          yield* readWorktreeBranchName(path.join(root, "missing"), fileSystem, path),
          null,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
