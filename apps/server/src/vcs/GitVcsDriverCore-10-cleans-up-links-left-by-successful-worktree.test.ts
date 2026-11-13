// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it, describe } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import {
  GitCommandError,
  ReviewDiffPreviewInput,
  VcsRef,
  VcsListRefsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewResult,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import {
  makeGitVcsDriverCore,
  parseGitCheckoutProgressLine,
  splitNullSeparatedGitStdoutPaths,
  windowsLongPathConfigEnv,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitConfigEnv } from "./VcsProcess.ts";

import {
  layerServerConfig,
  layerTest,
  makeSuccessfulHandle,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("worktree operations", () => {
    it.effect.each([false, true])(
      "cleans up links left by successful worktree removal, preserving ordinary files: %s",
      (keepFile) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const outside = yield* makeTmpDir("git-worktree-link-target-");
          yield* writeTextFile(outside, "keep.txt", "external target\n");
          const worktreePath = pathService.join(cwd, "leftover");
          const nested = pathService.join(worktreePath, "node_modules");
          yield* fileSystem.makeDirectory(nested, { recursive: true });
          yield* fileSystem.makeDirectory(pathService.join(worktreePath, "empty"));
          NodeFS.symlinkSync(outside, pathService.join(worktreePath, "linked"), "junction");
          NodeFS.symlinkSync(outside, pathService.join(nested, "pkg"), "junction");
          if (keepFile) {
            yield* writeTextFile(worktreePath, "notes/draft.txt", "new work\n");
          }

          // Git removes symlinks on Unix; simulate its successful Windows removal
          // leaving junctions behind so the cleanup is exercised on every platform.
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) =>
            ChildProcess.isStandardCommand(command) &&
            command.args.join(" ").includes("worktree remove")
              ? Effect.succeed(makeSuccessfulHandle(""))
              : delegate.spawn(command),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );

          yield* driver.removeWorktree({ cwd, path: worktreePath });

          assert.equal(
            yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
            "external target\n",
          );
          if (keepFile) {
            assert.deepEqual(yield* fileSystem.readDirectory(worktreePath), ["notes"]);
            assert.equal(
              yield* fileSystem.readFileString(pathService.join(worktreePath, "notes/draft.txt")),
              "new work\n",
            );
          } else {
            assert.equal(yield* fileSystem.exists(worktreePath), false);
          }
        }),
    );
    it.effect("keeps a worktree whose untracked files status is configured to hide", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "hidden");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/hidden",
        });
        yield* git(cwd, ["config", "status.showUntrackedFiles", "no"]);
        yield* writeTextFile(worktreePath, "notes.txt", "draft\n");
        assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");

        const result = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath }));

        assert.isTrue(Result.isFailure(result));
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(worktreePath, "notes.txt")),
          "draft\n",
        );
      }),
    );
    it.effect("leaves a folder alone that only shares the worktree's short name", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "short");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/short",
        });
        // Unrelated to the worktree, but resolving "short" against cwd lands here.
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        const unrelated = pathService.join(cwd, "short");
        NodeFS.mkdirSync(unrelated);
        NodeFS.symlinkSync(outside, pathService.join(unrelated, "linked"), "junction");

        yield* Effect.result(driver.removeWorktree({ cwd, path: "short" }));

        assert.isTrue(NodeFS.lstatSync(pathService.join(unrelated, "linked")).isSymbolicLink());
        assert.equal(yield* fileSystem.exists(worktreePath), true);
      }),
    );
    it.effect("force-removes a worktree without deleting what its junctions point to", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        yield* writeTextFile(outside, "keep.txt", "keep\n");
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "linked");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/linked",
        });
        // Junctions on Windows, the way pnpm links packages; symlinks elsewhere.
        NodeFS.mkdirSync(pathService.join(worktreePath, "node_modules"));
        NodeFS.symlinkSync(
          outside,
          pathService.join(worktreePath, "node_modules", "dep"),
          "junction",
        );
        NodeFS.symlinkSync(outside, pathService.join(worktreePath, "shared"), "junction");

        yield* driver.removeWorktree({ cwd, path: worktreePath, force: true });

        assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), []);
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
          "keep\n",
        );
      }),
    );
    it.effect("keeps the junctions of a worktree that git refuses to remove", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
        const pathService = yield* Path.Path;
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "linked");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/linked",
        });
        const link = pathService.join(worktreePath, "node_modules");
        NodeFS.symlinkSync(outside, link, "junction");
        yield* writeTextFile(worktreePath, "notes.txt", "draft\n");

        const result = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath }));

        assert.isTrue(Result.isFailure(result));
        assert.isTrue(NodeFS.lstatSync(link).isSymbolicLink());
        assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), ["linked"]);
      }),
    );
    it.effect("prunes stale registrations when removing an already-gone worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreesRoot = yield* makeTmpDir("git-worktrees-");
        const stalePath = pathService.join(worktreesRoot, "stale");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: stalePath,
          refName: initialBranch,
          newRefName: "feature/stale",
        });
        yield* fileSystem.remove(stalePath, { recursive: true });

        yield* driver.removeWorktree({
          cwd,
          path: pathService.join(worktreesRoot, "never-registered"),
        });

        const registered = yield* git(cwd, ["worktree", "list", "--porcelain"]);
        assert.notInclude(registered, "stale");
      }),
    );
  });
});
