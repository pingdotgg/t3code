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
  decodeVcsRef,
  decodeVcsListRefsResult,
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("refName operations", () => {
    it.effect("lists root and upstream metadata and optionally includes matching remote refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["remote", "add", "team/upstream", remote]);
        yield* git(cwd, ["push", "team/upstream", "HEAD:refs/heads/feature/a"]);
        yield* git(cwd, ["branch", "--track", "feature/a", "team/upstream/feature/a"]);
        yield* git(cwd, ["branch", "--no-track", "local-only"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const deduplicated = yield* driver.listRefs({ cwd });
        assert.equal(
          deduplicated.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          false,
        );

        const worktreePath = yield* makeTmpDir("git-vcs-driver-worktree-");
        yield* git(cwd, ["worktree", "add", worktreePath, "feature/a"]);
        yield* writeTextFile(worktreePath, "packages/app/file.txt", "nested project\n");
        const pathService = yield* Path.Path;
        const nestedCwd = pathService.join(worktreePath, "packages", "app");
        const complete = yield* driver.listRefs({
          cwd: nestedCwd,
          includeMatchingRemoteRefs: true,
        });
        const untracked = complete.refs.find((ref) => ref.name === "local-only");
        assert.ok(untracked);
        assert.equal("upstreamRef" in untracked, false);
        assert.deepEqual(decodeVcsRef(untracked), untracked);
        assert.equal(
          complete.refs.some((ref) => ref.name === initialBranch),
          true,
        );
        assert.equal(
          complete.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          true,
        );

        const remoteOnly = yield* driver.listRefs({
          cwd,
          includeMatchingRemoteRefs: true,
          refKind: "remote",
          limit: 1,
        });
        assert.equal(remoteOnly.refs.length, 1);
        assert.equal(remoteOnly.refs[0]?.name, `origin/${initialBranch}`);
        assert.equal(remoteOnly.refs[0]?.isRemote, true);

        const tracked = complete.refs.find((ref) => ref.name === "feature/a");
        assert.ok(tracked);
        assert.deepEqual(decodeVcsRef(tracked), {
          ...tracked,
          upstreamRef: "refs/remotes/team/upstream/feature/a",
        });
        const aliasCwd = pathService.join(cwd, "worktree-alias");
        NodeFS.symlinkSync(worktreePath, aliasCwd, "junction");
        const aliased = yield* driver.listRefs({ cwd: aliasCwd });
        const expected = [
          { ...complete, isAtRepositoryRoot: false },
          { ...aliased, isAtRepositoryRoot: true },
        ];
        assert.deepEqual([complete, aliased], expected);
        assert.deepEqual(
          [decodeVcsListRefsResult(complete), decodeVcsListRefsResult(aliased)],
          expected,
        );
      }),
    );

    it.effect("marks the origin default ref as default when no local copy exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["remote", "set-head", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/only-local"]);
        yield* git(cwd, ["branch", "-D", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        const remoteDefault = refs.refs.find((ref) => ref.name === `origin/${initialBranch}`);
        assert.equal(remoteDefault?.isRemote, true);
        assert.equal(remoteDefault?.isDefault, true);
      }),
    );

    it.effect("preserves exact custom names and refuses collisions without a suffix", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createRef({ cwd, refName: "Julius/ABC-123" });
        const failed = yield* driver
          .renameBranch({
            cwd,
            oldBranch: initialBranch,
            newBranch: "Julius/ABC-123",
            exactName: true,
          })
          .pipe(Effect.exit);
        assert.equal(failed._tag, "Failure");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: initialBranch,
          newBranch: "Julius/ABC-124.v2",
          exactName: true,
        });
        assert.equal(renamed.branch, "Julius/ABC-124.v2");
      }),
    );

    it.effect("flattens a generated name when a branch at its parent path blocks it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // A local `t3` branch is why launches start on the flat `t3-<hex>` temporary branch.
        yield* git(cwd, ["branch", "t3"]);
        yield* git(cwd, ["checkout", "-b", "t3-abcd1234"]);
        yield* git(cwd, ["branch", "t3-fix-login"]);

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "t3-abcd1234",
          newBranch: "t3/fix-login",
        });

        assert.equal(renamed.branch, "t3-fix-login-1");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3-fix-login-1");
      }),
    );

    it.effect("skips a flattened name that a nested branch blocks", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "t3"]);
        yield* git(cwd, ["checkout", "-b", "t3-abcd1234"]);
        yield* git(cwd, ["branch", "t3-fix-login/child"]);

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "t3-abcd1234",
          newBranch: "t3/fix-login",
        });

        assert.equal(renamed.branch, "t3-fix-login-1");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3-fix-login-1");
      }),
    );

    it.effect("rejects a missing branch without restoring a matching dirty file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "obsolete-branch", "original\n");
        yield* git(cwd, ["add", "obsolete-branch"]);
        yield* git(cwd, ["commit", "-m", "tracked file"]);
        yield* git(cwd, ["branch", "obsolete-branch"]);
        yield* git(cwd, ["branch", "-D", "obsolete-branch"]);
        yield* writeTextFile(cwd, "obsolete-branch", "uncommitted work\n");

        const result = yield* driver
          .switchRef({ cwd, refName: "obsolete-branch" })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        assert.equal(
          yield* fileSystem.readFileString(path.join(cwd, "obsolete-branch")),
          "uncommitted work\n",
        );
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      }),
    );

    it.effect("treats ref names that look like options as ref names", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature", "HEAD:refs/heads/-M"]);
        // Git refuses such branch names, but update-ref writes them, here tracking origin/feature.
        yield* git(cwd, ["update-ref", "refs/heads/-f", "HEAD"]);
        yield* git(cwd, ["config", "branch.-f.remote", "origin"]);
        yield* git(cwd, ["config", "branch.-f.merge", "refs/heads/feature"]);
        yield* git(cwd, ["branch", "keep"]);
        yield* writeTextFile(cwd, "README.md", "uncommitted work\n");
        const branches = yield* driver.listLocalBranchNames(cwd);
        const worktrees = yield* makeTmpDir("git-worktrees-");

        yield* driver.switchRef({ cwd, refName: "-f" }).pipe(Effect.flip);
        yield* driver.switchRef({ cwd, refName: "origin/feature" }).pipe(Effect.flip);
        yield* driver.createRef({ cwd, refName: "--list" }).pipe(Effect.flip);
        for (const [refName, newRefName] of [
          ["--detach", undefined],
          ["-M", undefined],
          ["-M", "renamed"],
          ["-D", "keep"],
          ["keep", "-M"],
          ["keep", "-D"],
        ] as const) {
          yield* driver
            .createWorktree({
              cwd,
              path: pathService.join(worktrees, "wt"),
              refName,
              ...(newRefName ? { newRefName } : {}),
            })
            .pipe(Effect.flip);
        }

        assert.equal(
          yield* fileSystem.readFileString(pathService.join(cwd, "README.md")),
          "uncommitted work\n",
        );
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        assert.deepEqual(yield* driver.listLocalBranchNames(cwd), branches);
        assert.isFalse(yield* fileSystem.exists(pathService.join(worktrees, "wt")));

        yield* git(cwd, ["checkout", "-q", "keep"]);
        yield* git(cwd, ["checkout", "-q", initialBranch]);
        assert.equal((yield* driver.switchRef({ cwd, refName: "-" })).refName, "keep");
        const previous = yield* driver.createWorktree({
          cwd,
          path: pathService.join(worktrees, "previous"),
          refName: "-",
        });
        assert.equal(
          yield* git(previous.worktree.path, ["branch", "--show-current"]),
          initialBranch,
        );
        const fromPrevious = yield* driver.createWorktree({
          cwd,
          path: pathService.join(worktrees, "from-previous"),
          refName: "-",
          newRefName: "from-previous",
        });
        assert.equal(
          yield* git(fromPrevious.worktree.path, ["rev-parse", "HEAD"]),
          yield* git(cwd, ["rev-parse", initialBranch]),
        );
      }),
    );
  });
});
