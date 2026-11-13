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
  makeDriverReleasingLock,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
  commitWithHooks,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("remote operations", () => {
    it.effect("ensureRemote reuses a partial clone remote and avoids its name", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "https://github.com/pingdotgg/t3code.git"]);
        yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
        yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const reused = yield* driver.ensureRemote({
          cwd,
          preferredName: "origin",
          url: "git@github.com:pingdotgg/t3code.git",
        });
        assert.equal(reused, "origin");
        const added = yield* driver.ensureRemote({
          cwd,
          preferredName: "origin",
          url: "https://github.com/another-owner/t3code.git",
        });
        assert.equal(added, "origin-1");
      }),
    );

    it.effect("ensureRemote returns the remote a parallel call added for the same URL", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        // Hold the first add until both calls have listed remotes, so both decide to add.
        let listings = 0;
        const bothListed = yield* Deferred.make<void>();
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
            if (args[0] === "remote" && args[1] === "-v") {
              listings += 1;
              if (listings === 2) yield* Deferred.succeed(bothListed, undefined);
            }
            if (args[0] === "remote" && args[1] === "add") yield* Deferred.await(bothListed);
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const input = { cwd, preferredName: "fork", url: "https://github.com/fork/t3code.git" };

        const names = yield* Effect.all([driver.ensureRemote(input), driver.ensureRemote(input)], {
          concurrency: "unbounded",
        });

        assert.deepEqual(names, ["fork", "fork"]);
      }),
    );

    it.effect("retries a config write while another process holds the config lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lockPath = path.join(cwd, ".git", "config.lock");
        yield* fileSystem.writeFileString(lockPath, "");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args[1] === "t3.test",
          lockPath,
        );

        // The retry waits on the real clock; the lock is already gone by then.
        yield* TestClock.withLive(
          driver.writeConfigValue({ cwd, key: "t3.test", value: "written" }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(yield* git(cwd, ["config", "t3.test"]), "written");
      }),
    );

    it.effect("tracks a remote start point once another process releases the config lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lockPath = path.join(cwd, ".git", "config.lock");
        yield* fileSystem.writeFileString(lockPath, "");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
          lockPath,
        );

        // The upstream retry waits on the real clock; the lock is already gone by then.
        yield* TestClock.withLive(
          driver.createWorktree({
            cwd,
            path: path.join(yield* makeTmpDir("git-worktrees-"), "tracked"),
            refName: `origin/${initialBranch}`,
            newRefName: "feature/tracked",
          }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature/tracked@{upstream}"]),
          `origin/${initialBranch}`,
        );
      }),
    );

    it.effect("fetches a remote branch into a tracking branch past another process's lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", `${initialBranch}:refs/heads/pr-head`]);
        const lockPath = (yield* Path.Path).join(cwd, ".git", "config.lock");
        yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
          lockPath,
        );

        yield* TestClock.withLive(
          driver.fetchRemoteBranch({
            cwd,
            remoteName: "origin",
            remoteBranch: "pr-head",
            localBranch: "review/pr-head",
          }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "review/pr-head@{upstream}"]),
          "origin/pr-head",
        );
      }),
    );

    // regression: #12485 explain fetch failures without exposing remote output
    it.effect("explains a real fetch failure for a missing local remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const missingRemote = `${cwd}/private-missing-remote`;
        yield* git(cwd, ["remote", "add", "origin", missingRemote]);
        const error = yield* driver.fetchRemote({ cwd, remoteName: "origin" }).pipe(Effect.flip);
        assert.include(error.detail, "could not access the remote repository");
        assert.equal(error.exitCode, 128);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, missingRemote);
        assert.notProperty(error, "stderr");
      }),
    );

    it.effect("fetches from a configured remote whose name looks like an option", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        // Remote names come from .git/config. Read as an option, this one runs `touch` in cwd.
        const remoteName = "--upload-pack=touch${IFS}t3-marker;false";
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, [
          "push",
          remote,
          `HEAD:refs/heads/${initialBranch}`,
          "HEAD:refs/pull/7/head",
        ]);
        yield* git(cwd, ["config", `remote.${remoteName}.url`, remote]);

        assert.equal(yield* driver.resolvePrimaryRemoteName(cwd), remoteName);
        yield* driver.fetchRemoteTrackingBranch({ cwd, remoteName, remoteBranch: initialBranch });
        yield* driver.fetchRemote({ cwd, remoteName });
        const head = yield* driver.fetchRefCommit({ cwd, ref: "refs/pull/7/head" });

        assert.isFalse(yield* fileSystem.exists((yield* Path.Path).join(cwd, "t3-marker")));
        assert.equal(head.commitSha, yield* git(cwd, ["rev-parse", "HEAD"]));
        assert.equal(
          yield* git(cwd, ["rev-parse", `refs/remotes/${remoteName}/${initialBranch}`]),
          head.commitSha,
        );
      }),
    );

    it.effect("ensureRemote reuses an existing remote across ssh/https transport variants", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["remote", "add", "origin", "https://github.com/pingdotgg/t3code.git"]);

        const reusedForSsh = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "git@github.com:pingdotgg/t3code.git",
        });
        assert.equal(reusedForSsh, "origin");

        const reusedForSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com/pingdotgg/t3code",
        });
        assert.equal(reusedForSshScheme, "origin");

        const reusedForBareSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://github.com/pingdotgg/t3code",
        });
        assert.equal(reusedForBareSshScheme, "origin");

        const reusedForSshPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com:22/pingdotgg/t3code",
        });
        assert.equal(reusedForSshPort, "origin");

        const reusedForSshWithPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com:22/pingdotgg/t3code.git",
        });
        assert.equal(reusedForSshWithPort, "origin");

        const addedForFork = yield* driver.ensureRemote({
          cwd,
          preferredName: "octocat",
          url: "git@github.com:octocat/t3code.git",
        });
        assert.equal(addedForFork, "octocat");
        assert.equal(yield* git(cwd, ["remote"]), "octocat\norigin");
      }),
    );
  });
  describe("commit context", () => {
    it.effect("prepares source patches without running textconv", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["config", "diff.probe.textconv", "touch textconv-ran; echo converted"]);
        yield* writeTextFile(cwd, ".gitattributes", "*.doc diff=probe\n");
        yield* writeTextFile(cwd, "notes.doc", "original source\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "source document"]);
        yield* writeTextFile(cwd, "notes.doc", "updated source\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;

        const context = yield* driver.prepareCommitContext(cwd, ["notes.doc"]);

        assert.include(context?.stagedPatch ?? "", "-original source");
        assert.include(context?.stagedPatch ?? "", "+updated source");
        assert.notInclude(context?.stagedPatch ?? "", "converted");
        assert.include(context?.stagedSummary ?? "", "notes.doc");
        assert.isFalse(yield* fileSystem.exists(`${cwd}/textconv-ran`));
      }),
    );

    it.effect("can omit the patch while preserving change detection and the real index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        assert.isNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
        yield* writeTextFile(cwd, "selected.txt", "selected content\n");
        yield* writeTextFile(cwd, "other.txt", "other content\n");
        yield* git(cwd, ["add", "other.txt"]);
        const before = yield* git(cwd, ["diff", "--cached"]);
        const summaryOnly = yield* driver.prepareCommitContext(cwd, ["selected.txt"], {
          includePatch: false,
        });
        assert.include(summaryOnly?.stagedSummary ?? "", "selected.txt");
        assert.notInclude(summaryOnly?.stagedSummary ?? "", "other.txt");
        assert.equal(summaryOnly?.stagedPatch, "");
        const full = yield* driver.prepareCommitContext(cwd, ["selected.txt"]);
        assert.equal(full?.stagedSummary, summaryOnly?.stagedSummary);
        assert.include(full?.stagedPatch ?? "", "+selected content");
        assert.equal(yield* git(cwd, ["diff", "--cached"]), before);
      }),
    );

    it.effect("prepares selected files without staging and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");

        const commit = yield* driver.commit(cwd, "Add a", "", { stage: { filePaths: ["a.txt"] } });
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );

    it.effect("stops a selected-file commit when another process holds the index lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        const lockPath = (yield* Path.Path).join(cwd, ".git", "index.lock");
        yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
        const { driver } = yield* makeDriverReleasingLock(
          (args) => args.includes("reset"),
          lockPath,
        );

        const error = yield* driver
          .commit(cwd, "Add a", "", { stage: { filePaths: ["a.txt"] } })
          .pipe(Effect.flip);

        assert.equal(error.operation, "GitVcsDriver.commit.reset");
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), head);
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "staged.txt");
      }),
    );

    it.effect.each([
      { location: "root", ref: "refs/heads/MERGE_HEAD" },
      { location: "nested", ref: "refs/heads/MERGE_HEAD" },
      { location: "worktree", ref: "refs/heads/MERGE_HEAD" },
      { location: "root", ref: "refs/tags/MERGE_HEAD" },
      { location: "nested", ref: "refs/tags/MERGE_HEAD" },
      { location: "worktree", ref: "refs/tags/MERGE_HEAD" },
    ])(
      "commits selected files with a MERGE_HEAD ref and no merge ($location, $ref)",
      ({ location, ref }) =>
        Effect.gen(function* () {
          let cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const originalHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["update-ref", ref, originalHead]);
          if (location === "worktree") {
            const linked = path.join(yield* makeTmpDir(), "linked");
            yield* git(cwd, ["worktree", "add", "-b", "linked", linked]);
            cwd = linked;
          }
          const commitCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
          yield* fs.makeDirectory(commitCwd, { recursive: true });
          yield* writeTextFile(cwd, "selected.txt", "selected\n");
          yield* writeTextFile(cwd, "unrelated.txt", "unrelated\n");
          const mergePath = yield* git(commitCwd, ["rev-parse", "--git-path", "MERGE_HEAD"]);
          assert.isFalse(yield* fs.exists(path.resolve(commitCwd, mergePath)));

          yield* driver.commit(commitCwd, "Selected without merge", "", {
            stage: { filePaths: ["selected.txt"] },
          });

          assert.equal(yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]), originalHead);
          assert.equal(
            yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]),
            "selected.txt",
          );
          assert.equal(yield* git(cwd, ["rev-parse", ref]), originalHead);
          assert.include(yield* git(cwd, ["status", "--porcelain"]), "?? unrelated.txt");
        }),
    );

    it.effect.each([
      { location: "root", conflict: false },
      { location: "nested", conflict: false },
      { location: "worktree", conflict: false },
      { location: "root", conflict: true },
      { location: "nested", conflict: true },
      { location: "worktree", conflict: true },
    ])(
      "rejects selected-file merge commits without mutation ($location, conflict: $conflict)",
      ({ location, conflict }) =>
        Effect.gen(function* () {
          let cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* git(cwd, ["checkout", "-b", "feature"]);
          yield* writeTextFile(cwd, "feature.txt", "feature\n");
          if (conflict) yield* writeTextFile(cwd, "README.md", "feature version\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "Feature"]);
          const featureHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["checkout", initialBranch]);
          yield* writeTextFile(cwd, "main.txt", "main\n");
          if (conflict) yield* writeTextFile(cwd, "README.md", "main version\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "Main"]);
          const mainHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          if (location === "worktree") {
            const worktree = path.join(yield* makeTmpDir(), "linked");
            yield* git(cwd, ["worktree", "add", "-b", "linked", worktree]);
            cwd = worktree;
          }
          const merge = yield* driver.execute({
            operation: "test.merge",
            cwd,
            args: ["merge", "--no-commit", "--no-ff", "feature"],
            allowNonZeroExit: true,
          });
          assert.equal(merge.exitCode, conflict ? 1 : 0);
          yield* writeTextFile(cwd, "unrelated.txt", "unrelated\n");
          const commitCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
          yield* fs.makeDirectory(commitCwd, { recursive: true });
          const gitDir = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
          const names = ["index", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "ORIG_HEAD"];
          const before = names.map((name) => NodeFS.readFileSync(path.join(gitDir, name)));
          const files = ["README.md", "feature.txt", "main.txt", "unrelated.txt"];
          const contents = files.map((name) => NodeFS.readFileSync(path.join(cwd, name)));
          const unmerged = yield* git(cwd, ["ls-files", "--unmerged"]);

          const result = yield* driver
            .commit(commitCwd, "Partial merge", "", { stage: { filePaths: ["feature.txt"] } })
            .pipe(Effect.result);
          if (Result.isSuccess(result)) {
            const parents = yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]);
            assert.fail(
              `Selected merge commit succeeded with parents ${parents}; MERGE_HEAD exists: ${NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD"))}`,
            );
          } else {
            assert.include(result.failure.detail, "Cannot commit selected files during a merge");
            assert.include(result.failure.detail, "Commit all files");
          }
          assert.deepEqual(
            names.map((name) => NodeFS.readFileSync(path.join(gitDir, name))),
            before,
          );
          assert.deepEqual(
            files.map((name) => NodeFS.readFileSync(path.join(cwd, name))),
            contents,
          );
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), mainHead);
          assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);

          if (conflict) yield* writeTextFile(cwd, "README.md", "resolved version\n");
          yield* driver.commit(commitCwd, "Finish merge", "", { stage: {} });
          assert.equal(
            yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]),
            `${mainHead} ${featureHead}`,
          );
          assert.isFalse(NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD")));
          assert.equal(yield* git(cwd, ["show", "HEAD:feature.txt"]), "feature");
          assert.equal(yield* git(cwd, ["show", "HEAD:unrelated.txt"]), "unrelated");
          if (conflict)
            assert.equal(yield* git(cwd, ["show", "HEAD:README.md"]), "resolved version");
        }),
    );

    it.effect("treats selected file paths literally", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "selected[1].txt", "literal\n");
        yield* writeTextFile(cwd, "selected1.txt", "pattern match\n");

        const context = yield* driver.prepareCommitContext(cwd, ["selected[1].txt"]);

        assert.include(context?.stagedSummary ?? "", "selected[1].txt");
        assert.notInclude(context?.stagedSummary ?? "", "selected1.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");
        yield* driver.commit(cwd, "Add literal path", "", {
          stage: { filePaths: ["selected[1].txt"] },
        });
        assert.equal(
          yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]),
          "selected[1].txt",
        );

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? selected1.txt");
      }),
    );

    const commitWithHooks = (hooks: Record<string, string>) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const [name, script] of Object.entries(hooks)) {
          yield* writeTextFile(cwd, `.git/hooks/${name}`, `#!/bin/sh\n${script}\n`);
          yield* fs.chmod(path.join(cwd, ".git/hooks", name), 0o755);
        }
        yield* writeTextFile(cwd, "a.txt", "a\n");
        const events: string[] = [];
        const result = yield* (yield* GitVcsDriver.GitVcsDriver)
          .commit(cwd, "Add a", "", {
            stage: { filePaths: ["a.txt"] },
            progress: {
              onHookStarted: (hookName) => Effect.sync(() => void events.push(`start ${hookName}`)),
              onHookFinished: ({ hookName, exitCode }) =>
                Effect.sync(() => void events.push(`finish ${hookName} ${exitCode}`)),
            },
          })
          .pipe(Effect.result);
        return { events, committed: Result.isSuccess(result) };
      });

    it.effect("reports each commit hook finishing with its exit code", () =>
      Effect.gen(function* () {
        // The pre-commit hook runs git, whose own children reuse child_id 0 in the shared trace.
        const { events, committed } = yield* commitWithHooks({
          "pre-commit": "git -c alias.noop='!false' noop\nexit 0",
          "commit-msg": "exit 0",
        });
        assert.isTrue(committed);
        assert.deepEqual(events, [
          "start pre-commit",
          "finish pre-commit 0",
          "start commit-msg",
          "finish commit-msg 0",
        ]);
      }),
    );

    it.effect("reports the exit code of a commit hook that rejects the commit", () =>
      Effect.gen(function* () {
        const { events, committed } = yield* commitWithHooks({ "commit-msg": "exit 3" });
        assert.isFalse(committed);
        assert.deepEqual(events, ["start commit-msg", "finish commit-msg 3"]);
      }),
    );

    it.effect.each([false, true])(
      "preserves partial staging and split-index files (split: %s)",
      (split) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          if (split) yield* git(cwd, ["config", "core.splitIndex", "true"]);
          yield* writeTextFile(cwd, "README.md", "# test\nstaged\n");
          yield* git(cwd, ["add", "README.md"]);
          yield* writeTextFile(cwd, "README.md", "# test\nstaged\nunstaged\n");
          yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
          yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
          yield* writeTextFile(cwd, "ignored.txt", "ignored\n");
          const before = NodeFS.readFileSync(`${cwd}/.git/index`);
          const shared = NodeFS.readdirSync(`${cwd}/.git`).filter((name) =>
            name.startsWith("sharedindex."),
          );
          const driver = yield* GitVcsDriver.GitVcsDriver;
          for (const paths of [undefined, ["README.md"]]) {
            const context = yield* driver.prepareCommitContext(cwd, paths);
            assert.include(context?.stagedPatch ?? "", "unstaged");
            assert.notInclude(context?.stagedSummary ?? "", "ignored.txt");
            assert.deepEqual(NodeFS.readFileSync(`${cwd}/.git/index`), before);
            assert.deepEqual(
              NodeFS.readdirSync(`${cwd}/.git`).filter((name) => name.startsWith("sharedindex.")),
              shared,
            );
          }
        }),
    );

    it.effect("prepares an unborn repository without creating a real index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "initial.txt", "initial\n");
        for (const paths of [undefined, ["initial.txt"]]) {
          const context = yield* driver.prepareCommitContext(cwd, paths);
          assert.include(context?.stagedSummary ?? "", "initial.txt");
          assert.isFalse(NodeFS.existsSync(`${cwd}/.git/index`));
        }
        yield* driver.commit(cwd, "Initial", "", { stage: { filePaths: ["initial.txt"] } });
        assert.equal(yield* git(cwd, ["show", "HEAD:initial.txt"]), "initial");
      }),
    );

    it.effect("preserves merge metadata while preparing selected and all files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Feature"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* git(cwd, ["merge", "--no-commit", "--no-ff", "feature"]);
        yield* writeTextFile(cwd, "README.md", "# test\nmerge edit\n");
        const names = ["index", "MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"];
        const before = names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`));
        const driver = yield* GitVcsDriver.GitVcsDriver;
        for (const paths of [undefined, ["README.md"]]) {
          yield* driver.prepareCommitContext(cwd, paths);
          assert.deepEqual(
            names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`)),
            before,
          );
        }
      }),
    );
  });
});
