import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import { checkpointWorkspace } from "./replayWorkspace.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(ChildProcess.make("git", args, { cwd }));
  });

const repositoryState = (repo: string, worktree: string, worktreeIndex: string) =>
  Effect.gen(function* () {
    return {
      config: yield* git(repo, ["config", "--local", "--list"]),
      refs: yield* git(repo, ["for-each-ref"]),
      worktrees: yield* git(repo, ["worktree", "list", "--porcelain"]),
      worktreeHead: yield* git(worktree, ["rev-parse", "HEAD"]),
      worktreeIndex: yield* git(repo, ["hash-object", "--no-filters", worktreeIndex]),
    };
  });

it.layer(NodeServices.layer)("checkpointWorkspace", (it) => {
  // `git bisect run` and `git rebase --exec` export GIT_DIR to what they run, and hooks add
  // GIT_INDEX_FILE. In a linked worktree both are absolute paths into the shared repository.
  it.effect.each([
    { runner: "git bisect run", selectors: ["GIT_DIR"] },
    { runner: "a git hook", selectors: ["GIT_DIR", "GIT_INDEX_FILE"] },
  ])("keeps to its own repository when run under $runner", ({ selectors }) =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      // These commits use the contributor's global config, which must not require a signing key.
      vi.stubEnv("GIT_CONFIG_COUNT", "1");
      vi.stubEnv("GIT_CONFIG_KEY_0", "commit.gpgsign");
      vi.stubEnv("GIT_CONFIG_VALUE_0", "false");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-replay-workspace-decoy-" });
      const repo = path.join(root, "repo");
      const worktree = path.join(root, "worktree");
      yield* fs.makeDirectory(repo);
      yield* git(repo, ["init"]);
      yield* git(repo, [
        "-c",
        "user.name=Decoy",
        "-c",
        "user.email=decoy@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "decoy",
      ]);
      yield* git(repo, ["worktree", "add", "--detach", worktree]);
      const worktreeGitDir = (yield* git(worktree, ["rev-parse", "--absolute-git-dir"])).trim();
      const worktreeIndex = path.join(worktreeGitDir, "index");
      const before = yield* repositoryState(repo, worktree, worktreeIndex);

      const inherited: Record<string, string> = {
        GIT_DIR: worktreeGitDir,
        GIT_INDEX_FILE: worktreeIndex,
      };
      for (const name of selectors) vi.stubEnv(name, inherited[name]);
      const workspace = yield* checkpointWorkspace("decoy-guard", { "src/a.txt": "a\n" });
      vi.unstubAllEnvs();

      assert.deepStrictEqual(yield* repositoryState(repo, worktree, worktreeIndex), before);
      assert.strictEqual(
        yield* git(workspace, ["log", "--format=%s%x00%an", "-1"]),
        "initial\u0000T3 Code Test\n",
      );
      assert.strictEqual(
        (yield* git(workspace, ["ls-files"])).trim().split("\n").join(","),
        "README.md,src/a.txt",
      );
    }),
  );
});
