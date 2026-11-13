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
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("worktree operations", () => {
    it.effect("uses parallel checkout without skipping filters or hooks", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "filter.test.smudge", "sed s/original/filtered/g"]);
        yield* writeTextFile(cwd, ".gitattributes", "asset.txt filter=test\n");
        yield* writeTextFile(cwd, "asset.txt", "original\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "filtered asset"]);
        yield* writeTextFile(
          cwd,
          ".git/hooks/post-checkout",
          "#!/bin/sh\ngit config checkout.workers > checkout-workers\nexit 0\n",
        );
        yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "parallel");

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/parallel",
          baseRefName: initialBranch,
        });

        assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), "locked");
        assert.equal(yield* fs.readFileString(path.join(worktreePath, "checkout-workers")), "0\n");
        assert.equal(yield* fs.readFileString(path.join(worktreePath, "asset.txt")), "filtered\n");
        assert.equal(
          yield* git(worktreePath, ["rev-parse", "HEAD"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.equal(
          yield* git(cwd, ["config", "branch.feature/parallel.t3-merge-base"]),
          initialBranch,
        );
        for (const [configured, expected] of [
          ["1", "1"],
          ["", "0"],
        ] as const) {
          yield* git(cwd, ["config", "checkout.workers", configured]);
          const configuredPath = path.join(yield* makeTmpDir("git-worktrees-"), "configured");
          yield* driver.createWorktree({
            cwd,
            path: configuredPath,
            refName: initialBranch,
            newRefName: `feature/configured-${expected}`,
          });
          assert.equal(
            yield* fs.readFileString(path.join(configuredPath, "checkout-workers")),
            `${expected}\n`,
          );
        }
      }),
    );

    // regression: #27749 hooks inherited the driver's forced LC_ALL=C
    it.effect("runs post-checkout hooks under the server's own locale", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const serverLocale = process.env.LC_ALL ?? "unset";
        const seenLocale = path.join(yield* makeTmpDir("git-hook-locale-"), "lc-all");
        yield* writeTextFile(
          cwd,
          "hooks/post-checkout",
          `#!/bin/sh\necho "\${LC_ALL-unset}" > '${seenLocale}'\n[ "\${LC_ALL-unset}" = '${serverLocale}' ]\n`,
        );
        yield* fs.chmod(path.join(cwd, "hooks/post-checkout"), 0o755);
        yield* git(cwd, ["config", "core.hooksPath", path.join(cwd, "hooks")]);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "locale");

        const result = yield* driver
          .createWorktree({ cwd, path: worktreePath, refName: initialBranch, newRefName: "locale" })
          .pipe(Effect.result);

        assert.equal(
          (yield* fs.readFileString(seenLocale)).trim(),
          serverLocale,
          "post-checkout hook should see the server's LC_ALL",
        );
        assert.isTrue(Result.isSuccess(result), "worktree creation failed in the hook");
      }),
    );
    it.effect.each(["commit", "short-commit", "tag", "revision"] as const)(
      "creates a worktree from a %s without recording it as a PR base",
      (kind) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["tag", "v1"]);
          const baseRef =
            kind === "commit"
              ? commit
              : kind === "short-commit"
                ? commit.slice(0, 12)
                : kind === "tag"
                  ? "v1"
                  : "HEAD~0";
          const path = yield* Path.Path;
          const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "revision");
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: baseRef,
            newRefName: "feature/revision",
            baseRefName: baseRef,
          });

          assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), commit);
          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/revision.t3-merge-base"),
            null,
          );
        }),
    );

    // regression: #28354 a failed worktree add left its new branch behind and blocked retries
    it.effect("removes the new branch when the worktree cannot be added", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const occupiedPath = yield* makeTmpDir("git-worktrees-");
        yield* writeTextFile(occupiedPath, "existing.txt", "occupied\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const failed = yield* driver
          .createWorktree({
            cwd,
            path: occupiedPath,
            refName: initialBranch,
            newRefName: "t3/collide",
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(failed));
        assert.equal(yield* git(cwd, ["branch", "--list", "t3/collide"]), "");
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "retry");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "t3/collide",
        });
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "t3/collide");
      }),
    );
    it.effect("creates parallel worktrees in one repository without racing on its config", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        const path = yield* Path.Path;
        const worktrees = yield* makeTmpDir("git-worktrees-");

        // Git has no lock timeout for .git/config, which every worktree shares: a writer that
        // overlaps another fails, and a branch can then be left without its worktree.
        let configWriters = 0;
        let peakConfigWriters = 0;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const countingSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
            const writesConfig =
              (args.includes("worktree") && args.includes("add") && args.includes("-b")) ||
              (args[0] === "branch" &&
                (args[1] === "-m" || args[1]?.startsWith("--set-upstream-to"))) ||
              (args[0] === "config" && !args[1]?.startsWith("-"));
            if (!writesConfig) return yield* delegate.spawn(command);
            configWriters += 1;
            peakConfigWriters = Math.max(peakConfigWriters, configWriters);
            const handle = yield* delegate.spawn(command);
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.ensuring(Effect.sync(() => (configWriters -= 1))),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
          Effect.provide(layerServerConfig),
        );
        const branches = Array.from({ length: 8 }, (_, index) => `feature/parallel-${index}`);

        yield* Effect.forEach(
          branches,
          (branch) =>
            driver.createWorktree({
              cwd,
              path: path.join(worktrees, branch.replace("/", "-")),
              refName: `origin/${initialBranch}`,
              newRefName: branch,
              baseRefName: `origin/${initialBranch}`,
            }),
          { concurrency: "unbounded" },
        );
        // Launches rename their temporary branch from inside the new worktree.
        yield* Effect.forEach(
          branches,
          (branch) =>
            driver.renameBranch({
              cwd: path.join(worktrees, branch.replace("/", "-")),
              oldBranch: branch,
              newBranch: `${branch}-renamed`,
              exactName: true,
            }),
          { concurrency: "unbounded" },
        );

        assert.equal(peakConfigWriters, 1);
        for (const branch of branches) {
          const renamed = `${branch}-renamed`;
          assert.equal(yield* git(cwd, ["config", `branch.${renamed}.remote`]), "origin");
          assert.equal(
            yield* git(cwd, ["config", `branch.${renamed}.t3-merge-base-ref`]),
            `refs/remotes/origin/${initialBranch}`,
          );
        }
      }),
    );
    it.effect.each(["release/v2", "refs/heads/release/v2", "deadbeef"])(
      "records the branch name when creating a worktree from %s",
      (baseRef) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const baseBranch = baseRef.replace(/^refs\/heads\//, "");
          yield* git(cwd, ["branch", baseBranch]);
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* driver.createWorktree({
            cwd,
            path: path.join(yield* makeTmpDir("git-worktrees-"), "branch"),
            refName: baseRef,
            newRefName: "feature/branch",
            baseRefName: baseRef,
          });

          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/branch.t3-merge-base"),
            baseBranch,
          );
        }),
    );
    it.effect.each(["release/v2", "origin/release/v2", "refs/remotes/origin/release/v2"])(
      "records a remote-only PR base when creating a worktree from %s",
      (baseRef) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const remote = yield* makeTmpDir("git-remote-");
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "origin", "HEAD:refs/heads/release/v2"]);
          const commit = yield* git(cwd, ["rev-parse", "origin/release/v2"]);
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "remote");
          yield* driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: commit,
            newRefName: "feature/remote",
            baseRefName: baseRef,
          });

          const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
          const comparisonBase = preview.sources.find(
            (source) => source.kind === "branch-range",
          )!.baseRef;
          assert.equal(
            yield* git(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`]),
            commit,
          );
        }),
    );
    it("parses checkout progress lines from git's stderr", () => {
      assert.deepStrictEqual(parseGitCheckoutProgressLine("Updating files:  78% (2104/2700)"), {
        percent: 78,
        completed: 2104,
        total: 2700,
      });
      assert.deepStrictEqual(
        parseGitCheckoutProgressLine("Updating files: 100% (2700/2700), done."),
        { percent: 100, completed: 2700, total: 2700 },
      );
      assert.strictEqual(parseGitCheckoutProgressLine("Preparing worktree (new branch 'x')"), null);
    });

    // NTFS rejects a newline in a file name, so there is nothing to preserve there.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "preserves newline characters in worktree paths when listing refs",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
          const pathService = yield* Path.Path;
          const worktreePath = pathService.join(worktreesRoot, "linked\nworktree");
          const driver = yield* GitVcsDriver.GitVcsDriver;

          yield* git(cwd, ["worktree", "add", "-b", "feature/newline-path", worktreePath]);

          const refs = yield* driver.listRefs({ cwd, refresh: true });
          const listedPath = refs.refs.find(
            (ref) => ref.name === "feature/newline-path",
          )?.worktreePath;

          if (typeof listedPath !== "string") {
            return assert.fail("expected the linked branch to include its worktree path");
          }
          assert.equal(
            NodeFS.realpathSync.native(listedPath),
            NodeFS.realpathSync.native(worktreePath),
          );
        }),
    );
    it.effect.each([
      ["recursive", false],
      ["recursive", true],
      ["top-level", false],
      ["top-level", true],
    ] as const)("finishes a slow submodule checkout (%s, progress: %s)", ([submodules, progress]) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        // Git blocks file submodule transports (CVE-2022-39253) despite repo config; local fixtures need env permission.
        const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousAllowedProtocol === undefined) {
              delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
              process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
            }
          }),
        );

        const submoduleRepo = yield* makeTmpDir("git-submodule-");
        yield* initRepoWithCommit(submoduleRepo);
        yield* writeTextFile(submoduleRepo, ".gitattributes", "* text eol=lf\n");
        yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
        yield* git(submoduleRepo, ["add", "."]);
        yield* git(submoduleRepo, ["commit", "-m", "shared"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", submoduleRepo, "shared"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);
        const recordedHead = yield* git(submoduleRepo, ["rev-parse", "HEAD"]);
        yield* writeTextFile(submoduleRepo, "SHARED.md", "# newer remote default\n");
        yield* git(submoduleRepo, ["commit", "-am", "advance remote default"]);

        const updateStarted = yield* Deferred.make<void>();
        const releaseUpdate = yield* Deferred.make<void>();
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              ChildProcess.isStandardCommand(command) &&
              command.args[0] === "submodule" &&
              command.args[1] === "update"
            ) {
              yield* Deferred.succeed(updateStarted, undefined);
              yield* Deferred.await(releaseUpdate);
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const finished = yield* Ref.make<ReadonlyArray<{ ok: boolean; detail: string | null }>>([]);
        const lines = yield* Ref.make<ReadonlyArray<string>>([]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "submodule-worktree",
        );
        const creation = yield* driver
          .createWorktree(
            {
              cwd,
              path: worktreePath,
              refName: initialBranch,
              newRefName: "feature/submodules",
            },
            {
              submodules,
              progress: {
                onSubmodulesFinished: (result) =>
                  Ref.update(finished, (items) => [...items, result]),
                ...(progress
                  ? {
                      onSubmoduleLine: (line: string) =>
                        Ref.update(lines, (items) => [...items, line]),
                    }
                  : {}),
              },
            },
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(updateStarted);
        yield* TestClock.adjust("6 minutes");
        yield* Deferred.succeed(releaseUpdate, undefined);
        yield* Fiber.join(creation);

        assert.deepEqual(yield* Ref.get(finished), [{ ok: true, detail: null }]);
        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
          true,
        );
        assert.equal(
          yield* git(pathService.join(worktreePath, "shared"), ["rev-parse", "HEAD"]),
          recordedHead,
        );
        assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");
        assert.equal(
          yield* git(pathService.join(worktreePath, "shared"), ["status", "--porcelain"]),
          "",
        );
        if (progress) assert.isNotEmpty(yield* Ref.get(lines));
      }),
    );
    it.effect("still creates the worktree when submodule checkout fails", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(
          cwd,
          ".gitmodules",
          '[submodule "missing"]\n\tpath = missing\n\turl = /nonexistent/repo.git\n',
        );
        yield* git(cwd, ["add", "."]);
        const gitlink = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},missing`]);
        yield* git(cwd, ["commit", "-m", "add unreachable submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "broken-submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const finished = yield* Ref.make<ReadonlyArray<{ ok: boolean; detail: string | null }>>([]);
        const created = yield* driver.createWorktree(
          {
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/broken-submodules",
          },
          {
            progress: {
              onSubmodulesFinished: (result) => Ref.update(finished, (items) => [...items, result]),
            },
          },
        );

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(yield* fileSystem.exists(worktreePath), true);
        const results = yield* Ref.get(finished);
        assert.lengthOf(results, 1);
        assert.isFalse(results[0]!.ok);
        assert.include(results[0]!.detail, "GitVcsDriver.createWorktree.updateSubmodules");
      }),
    );
    it.effect("creates worktrees under the configured worktrees directory", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: "feature/custom-dir" },
          { worktreesDirectory },
        );
        const expected = pathService.join(
          worktreesDirectory,
          pathService.basename(cwd),
          "feature-custom-dir",
        );
        assert.equal(created.worktree.path, expected);
        assert.equal(yield* fileSystem.exists(expected), true);

        const error = yield* driver
          .createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: "feature/relative-dir" },
            { worktreesDirectory: "relative/worktrees" },
          )
          .pipe(Effect.flip);
        assert.match(error.detail, /must be an absolute folder on this machine/);

        const rootError = yield* driver
          .createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: "feature/root-dir" },
            { worktreesDirectory: "/" },
          )
          .pipe(Effect.flip);
        assert.match(rootError.detail, /not a drive root/);
      }),
    );
    it.effect("keeps generated worktree folders short without changing long branch names", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const folders = new Set<string>();
        const branches = [
          `feature/${"a".repeat(90)}/${"b".repeat(90)}/${"c".repeat(90)}`,
          `feature/${"a".repeat(90)}/${"b".repeat(90)}/${"d".repeat(90)}`,
          `feature/${"a".repeat(40)}/5fac`,
          `feature/${"a".repeat(40)}/18828`,
          `${"a".repeat(22)}😀/${"b".repeat(30)}`,
          "z".repeat(40),
          "z".repeat(41),
        ];
        for (const branch of branches) {
          const created = yield* driver.createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: branch },
            { worktreesDirectory },
          );
          const folder = pathService.basename(created.worktree.path);
          assert.isAtMost(folder.length, 40);
          if (branch.length <= 40) assert.equal(folder, branch);
          assert.equal(yield* git(created.worktree.path, ["branch", "--show-current"]), branch);
          assert.include(
            yield* git(cwd, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"]),
            `worktree ${created.worktree.path}`,
          );
          folders.add(folder);
        }
        assert.equal(folders.size, branches.length);
      }),
    );
    it.effect("resolves the submodule mode from the option, then t3.json", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousAllowedProtocol === undefined) {
              delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
              process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
            }
          }),
        );

        const nestedRepo = yield* makeTmpDir("git-nested-");
        yield* initRepoWithCommit(nestedRepo);
        yield* writeTextFile(nestedRepo, "NESTED.md", "# nested\n");
        yield* git(nestedRepo, ["add", "."]);
        yield* git(nestedRepo, ["commit", "-m", "nested"]);
        const innerRepo = yield* makeTmpDir("git-inner-");
        yield* initRepoWithCommit(innerRepo);
        yield* writeTextFile(innerRepo, "INNER.md", "# inner\n");
        yield* git(innerRepo, ["submodule", "add", nestedRepo, "nested"]);
        yield* git(innerRepo, ["add", "."]);
        yield* git(innerRepo, ["commit", "-m", "inner"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", innerRepo, "inner"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreesDir = yield* makeTmpDir("git-worktrees-");

        const createWithMode = Effect.fn(function* (
          fileMode: WorktreeSubmodules,
          branch: string,
          submodules: WorktreeSubmodules | null = null,
        ) {
          yield* writeTextFile(cwd, "t3.json", `{ "worktreeSubmodules": "${fileMode}" }`);
          yield* git(cwd, ["add", "t3.json"]);
          yield* git(cwd, ["commit", "--allow-empty", "-m", `submodules: ${fileMode}`]);
          const worktreePath = pathService.join(worktreesDir, branch);
          const disabled = yield* Ref.make<"settings" | "t3.json" | false>(false);
          yield* driver.createWorktree(
            { cwd, path: worktreePath, refName: initialBranch, newRefName: branch },
            {
              submodules,
              progress: { onSubmodulesDisabled: ({ source }) => Ref.set(disabled, source) },
            },
          );
          return {
            disabled: yield* Ref.get(disabled),
            inner: yield* fileSystem.exists(pathService.join(worktreePath, "inner", "INNER.md")),
            nested: yield* fileSystem.exists(
              pathService.join(worktreePath, "inner", "nested", "NESTED.md"),
            ),
          };
        });

        assert.deepEqual(yield* createWithMode("recursive", "recursive"), {
          disabled: false,
          inner: true,
          nested: true,
        });
        assert.deepEqual(yield* createWithMode("top-level", "top-level"), {
          disabled: false,
          inner: true,
          nested: false,
        });
        assert.deepEqual(yield* createWithMode("recursive", "setting-none", "none"), {
          disabled: "settings",
          inner: false,
          nested: false,
        });
        assert.deepEqual(yield* createWithMode("none", "setting-wins", "top-level"), {
          disabled: false,
          inner: true,
          nested: false,
        });
        assert.deepEqual(yield* createWithMode("none", "none"), {
          disabled: "t3.json",
          inner: false,
          nested: false,
        });
      }),
    );
    it.effect("still creates the worktree when the base-ref config stays locked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "locked-config");
        yield* writeTextFile(cwd, ".git/config.lock", "");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // The base-ref write retries on the real clock before giving up.
        const created = yield* TestClock.withLive(
          driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/locked-config",
            baseRefName: initialBranch,
          }),
        );

        assert.deepEqual(created.worktree, {
          path: worktreePath,
          refName: "feature/locked-config",
        });
        assert.equal(
          yield* git(worktreePath, ["branch", "--show-current"]),
          "feature/locked-config",
        );
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(worktreePath, "README.md")),
          "# test\n",
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.feature/locked-config.t3-merge-base"),
          null,
        );
        assert.equal(yield* fileSystem.exists(pathService.join(cwd, ".git/config.lock")), true);
      }),
    );
  });
});
