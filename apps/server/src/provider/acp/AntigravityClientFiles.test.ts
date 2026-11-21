import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  readAntigravityClientTextFile,
  resolveGitWorktreeDirectory,
} from "./AntigravityClientFiles.ts";

it.layer(NodeServices.layer)("AntigravityClientFiles", (it) => {
  it.effect("reads a linked worktree HEAD from its root and subdirectories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const repo = path.join(root, "repo");
      const worktree = path.join(root, "linked");
      const subdirectory = path.join(worktree, "apps", "web");
      const nestedRepo = path.join(worktree, "nested");
      const attachments = path.join(root, "attachments");
      yield* fileSystem.makeDirectory(attachments);
      for (const args of [
        ["init", "-qb", "main", repo],
        [
          "-C",
          repo,
          "-c",
          "user.name=T3",
          "-c",
          "user.email=t3@example.org",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-qm",
          "Initial commit",
        ],
        ["-C", repo, "worktree", "add", "-qb", "linked", worktree],
        ["init", "-qb", "main", nestedRepo],
      ]) {
        const code = yield* spawner.exitCode(ChildProcess.make("git", args));
        assert.equal(Number(code), 0, `git ${args.join(" ")}`);
      }
      yield* fileSystem.makeDirectory(subdirectory, { recursive: true });
      const gitDir = yield* fileSystem.realPath(path.join(repo, ".git", "worktrees", "linked"));
      for (const cwd of [worktree, subdirectory]) {
        const worktreeGitDir = yield* resolveGitWorktreeDirectory({ fileSystem, path, cwd });
        assert.equal(worktreeGitDir, gitDir);
        const allowedRoots =
          worktreeGitDir === undefined ? [cwd, attachments] : [cwd, attachments, worktreeGitDir];
        const read = (target: string) =>
          readAntigravityClientTextFile({
            fileSystem,
            path,
            allowedRoots,
            request: { sessionId: "worktree", path: target },
          });
        assert.equal((yield* read(path.join(gitDir, "HEAD"))).content, "ref: refs/heads/linked\n");
        const blocked = yield* read(path.join(repo, ".git", "config")).pipe(Effect.flip);
        assert.match(blocked.message, /outside the session workspace/);
      }

      const forged = path.join(worktree, "forged");
      yield* fileSystem.makeDirectory(forged);
      yield* fileSystem.symlink(path.join(worktree, ".git"), path.join(forged, ".git"));
      for (const boundary of [nestedRepo, forged]) {
        const cwd = path.join(boundary, "src");
        yield* fileSystem.makeDirectory(cwd);
        assert.isUndefined(yield* resolveGitWorktreeDirectory({ fileSystem, path, cwd }));
      }
    }),
  );

  it.effect.each([
    "a normal .git directory",
    "a missing backlink",
    "a mismatched backlink",
    "an oversized .git file",
    "an oversized backlink",
  ] as const)("grants no extra root for %s", (kind) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = path.join(root, "checkout");
      const dotGit = path.join(cwd, ".git");
      const gitDir = path.join(root, "backing");
      yield* fileSystem.makeDirectory(cwd);
      if (kind === "a normal .git directory") {
        yield* fileSystem.makeDirectory(dotGit);
      } else {
        yield* fileSystem.makeDirectory(gitDir);
        const padding = " ".repeat(4096);
        yield* fileSystem.writeFileString(
          dotGit,
          `gitdir: ${gitDir}${kind === "an oversized .git file" ? padding : ""}\n`,
        );
        if (kind !== "a missing backlink") {
          const target = kind === "a mismatched backlink" ? cwd : dotGit;
          yield* fileSystem.writeFileString(
            path.join(gitDir, "gitdir"),
            `${target}${kind === "an oversized backlink" ? padding : ""}\n`,
          );
        }
      }
      assert.isUndefined(yield* resolveGitWorktreeDirectory({ fileSystem, path, cwd }));
    }),
  );
});
