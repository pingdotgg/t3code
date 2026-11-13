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
  makeReviewDiffFileContentsInput,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("review diff previews", () => {
    it.effect.each([
      { scenario: "kept", before: "\uFEFFold\n", after: "\uFEFFnew\n" },
      { scenario: "added", before: "same\n", after: "\uFEFFsame\n" },
      { scenario: "removed", before: "\uFEFFsame\n", after: "same\n" },
    ])("preserves byte-order marks in diff expansion when $scenario", ({ before, after }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", before);
        yield* git(cwd, ["commit", "-am", "write original contents"]);
        yield* writeTextFile(cwd, "README.md", after);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd),
        );

        assert.deepStrictEqual(contents, { oldContents: before, newContents: after });
      }),
    );
    it.effect("reads a base ref that looks like an option as a revision", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const output = (yield* Path.Path).join(yield* makeTmpDir(), "out");

        yield* driver
          .getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, { baseRef: `--output=${output}` }),
          )
          .pipe(Effect.flip);
        yield* driver.readRangeContext(cwd, `--output=${output}`).pipe(Effect.flip);

        assert.isFalse(yield* fileSystem.exists(`${output}:README.md`));
        assert.isFalse(yield* fileSystem.exists(`${output}..HEAD`));
      }),
    );
    it.effect("reads raw range context regardless of Git display configuration", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["config", "diff.probe.textconv", "touch textconv-ran; echo converted"]);
        yield* git(cwd, ["config", "color.ui", "always"]);
        yield* git(cwd, ["config", "diff.relative", "true"]);
        yield* git(cwd, ["config", "log.decorate", "short"]);
        yield* git(cwd, ["checkout", "-b", "feature/range"]);
        yield* writeTextFile(cwd, ".gitattributes", "*.doc diff=probe\n");
        yield* writeTextFile(cwd, "notes.doc", "source line\n");
        yield* writeTextFile(cwd, "plain.txt", "plain line\n");
        yield* writeTextFile(cwd, "binary.dat", "binary\0data");
        yield* git(cwd, ["add", "."]);
        const signingKey = `${yield* makeTmpDir("git-vcs-driver-signing-key-")}/key`;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const keygen = ChildProcess.make("ssh-keygen", [
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-f",
          signingKey,
        ]);
        assert.equal(Number(yield* spawner.exitCode(keygen)), 0);
        yield* git(cwd, ["config", "gpg.format", "ssh"]);
        // A global signer such as 1Password's cannot use the fixture's generated key.
        yield* git(cwd, ["config", "gpg.ssh.program", "ssh-keygen"]);
        yield* git(cwd, ["config", "user.signingkey", `${signingKey}.pub`]);
        yield* git(cwd, ["config", "log.showSignature", "true"]);
        yield* git(cwd, ["commit", "-S", "-m", "range files"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const projectCwd = `${cwd}/app`;
        yield* fileSystem.makeDirectory(projectCwd);

        const context = yield* driver.readRangeContext(projectCwd, initialBranch);

        assert.match(context.commitSummary.trim(), /^[a-f0-9]+ range files$/);
        assert.include(context.diffPatch, "+source line");
        assert.notInclude(context.diffPatch, "converted");
        assert.include(context.diffPatch, "+plain line");
        assert.include(context.diffPatch, "Binary files /dev/null and b/binary.dat differ");
        assert.include(context.diffSummary, "notes.doc");
        for (const output of [context.commitSummary, context.diffSummary, context.diffPatch]) {
          assert.notInclude(output, "\u001b[");
        }
        assert.isFalse(yield* fileSystem.exists(`${cwd}/textconv-ran`));

        yield* writeTextFile(cwd, "notes.doc", "updated source line\n");
        const staged = yield* driver.prepareCommitContext(projectCwd, ["notes.doc"]);
        assert.include(staged?.stagedPatch ?? "", "+updated source line");
        assert.notInclude(staged?.stagedPatch ?? "", "converted");
        assert.notInclude(staged?.stagedPatch ?? "", "\u001b[");
        assert.include(staged?.stagedSummary ?? "", "notes.doc");
        assert.isFalse(yield* fileSystem.exists(`${cwd}/textconv-ran`));
      }),
    );
    it.effect("loads new and deleted files without reading their missing side", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "added.ts", "export const added = true;\n");
        yield* fileSystem.remove(pathService.join(cwd, "README.md"));

        const [added, deleted] = yield* Effect.all([
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "added.ts",
              newPath: "added.ts",
            }),
          ),
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, { changeType: "deleted" }),
          ),
        ]);

        assert.deepStrictEqual(added, {
          oldContents: "",
          newContents: "export const added = true;\n",
        });
        assert.deepStrictEqual(deleted, {
          oldContents: "# test\n",
          newContents: "",
        });
      }),
    );
    it.effect("loads merge-base and disk contents for Changes expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/context"]);
        yield* writeTextFile(cwd, "README.md", "# branch change\nunchanged context\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change readme"]);
        yield* writeTextFile(cwd, "README.md", "# dirty change\nunchanged context\n");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "branch-range",
            baseRef: initialBranch,
            headRef: "feature/context",
          }),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# dirty change\nunchanged context\n");
      }),
    );
    it.effect("Changes combines commits, uncommitted edits, and untracked files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const sourceFiles = (
          preview: ReviewDiffPreviewResult,
          kind: "working-tree" | "branch-range",
        ) => preview.sources.find((source) => source.kind === kind)!.files;
        yield* git(cwd, ["checkout", "-b", "feature/combined"]);
        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
        yield* git(cwd, ["commit", "-am", "commit edit"]);

        const clean = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        assert.deepStrictEqual(sourceFiles(clean, "working-tree"), []);
        assert.deepStrictEqual(sourceFiles(clean, "branch-range"), [
          { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
        ]);

        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\ndirty\n");
        yield* writeTextFile(cwd, "new.txt", "new\n");
        const dirty = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        const changes = dirty.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "README.md", previousPath: null, additions: 2, deletions: 0 },
          { path: "new.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.strictEqual(changes.diff.match(/^diff --git a\/README\.md /gm)?.length, 1);
        assert.include(changes.diff, "+dirty");
        assert.deepStrictEqual(sourceFiles(dirty, "working-tree"), [
          { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
          { path: "new.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
      }),
    );
    it.effect("Changes on the default branch compares with its remote copy", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* writeTextFile(cwd, "unpushed.txt", "unpushed\n");
        yield* git(cwd, ["add", "unpushed.txt"]);
        yield* git(cwd, ["commit", "-m", "unpushed"]);

        const local = yield* driver.getReviewDiffPreview({ cwd });
        const localChanges = local.sources.find((source) => source.kind === "branch-range")!;
        assert.isNull(localChanges.baseRef);
        assert.deepStrictEqual(localChanges.files, []);

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD~1:refs/heads/main"]);
        yield* git(cwd, ["fetch", "origin"]);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, "origin/main");
        assert.deepStrictEqual(changes.files, [
          { path: "unpushed.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
      }),
    );
    it.effect("honors configured remote-qualified bases for Changes and ahead counts", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        const upstream = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(fork, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["remote", "add", "canonical/team", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* writeTextFile(cwd, "upstream.txt", "unrelated upstream work\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "upstream work"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["fetch", "canonical/team"]);
        yield* git(cwd, ["branch", "release/v2"]);
        yield* git(cwd, ["checkout", "-b", "feature/configured-base"]);
        yield* writeTextFile(cwd, "feature.txt", "intended branch change\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature work"]);

        for (const baseRef of ["upstream/main", "canonical/team/main", "release/v2"]) {
          yield* git(cwd, ["config", "branch.feature/configured-base.gh-merge-base", baseRef]);
          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, { baseRef, insertions: 1, deletions: 0 });
          assert.strictEqual(status.aheadCount, 1);
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const changes = preview.sources.find((source) => source.kind === "branch-range")!;
          assert.strictEqual(changes.baseRef, baseRef);
          assert.deepStrictEqual(changes.files, [
            { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
          ]);
        }

        for (const baseRef of ["origin/main", "upstream/missing", "main"]) {
          yield* git(cwd, ["config", "branch.feature/configured-base.gh-merge-base", baseRef]);
          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, {
            baseRef: "origin/main",
            insertions: 2,
            deletions: 0,
          });
          assert.strictEqual(status.aheadCount, 2);
        }

        yield* git(cwd, [
          "config",
          "branch.feature/configured-base.gh-merge-base",
          "refs/remotes/upstream/main",
        ]);
        yield* writeTextFile(cwd, "upstream.txt", "feature edits upstream file\n");
        for (const shadowRef of ["refs/heads/upstream/main", "refs/tags/upstream/main"]) {
          yield* git(cwd, ["update-ref", shadowRef, "HEAD~2"]);
          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, {
            baseRef: "refs/remotes/upstream/main",
            insertions: 2,
            deletions: 1,
          });
          assert.strictEqual(status.aheadCount, 1);
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const changes = preview.sources.find((source) => source.kind === "branch-range")!;
          assert.strictEqual(changes.baseRef, "refs/remotes/upstream/main");
          assert.deepStrictEqual(changes.files, [
            { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
            { path: "upstream.txt", previousPath: null, additions: 1, deletions: 1 },
          ]);
          const contents = yield* driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              sourceKind: "branch-range",
              baseRef: changes.baseRef,
              headRef: "feature/configured-base",
              oldPath: "upstream.txt",
              newPath: "upstream.txt",
            }),
          );
          assert.deepStrictEqual(contents, {
            oldContents: "unrelated upstream work\n",
            newContents: "feature edits upstream file\n",
          });
          yield* git(cwd, ["update-ref", "-d", shadowRef]);
        }
      }),
    );
    it.effect("does not guess a Changes base for a branch renamed during the status read", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        const upstream = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(fork, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* writeTextFile(cwd, "upstream.txt", "work missing from the fork\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "upstream work"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["fetch", "origin"]);
        yield* git(cwd, ["fetch", "upstream"]);
        yield* git(cwd, ["checkout", "-b", "t3/temporary"]);
        yield* git(cwd, ["config", "branch.t3/temporary.t3-merge-base", "main"]);
        yield* git(cwd, [
          "config",
          "branch.t3/temporary.t3-merge-base-ref",
          "refs/remotes/upstream/main",
        ]);
        yield* writeTextFile(cwd, "feature.txt", "thread work\n");

        const outer = yield* GitVcsDriver.GitVcsDriver;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const renameClaimed = yield* Ref.make(false);
        const renamed = yield* Deferred.make<void>();
        // Rename after `git status` has read HEAD, as the thread launcher does after the first turn.
        // Base config reads start only after status completes; hold every one until the rename lands.
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "config") {
              if (!(yield* Ref.getAndSet(renameClaimed, true))) {
                yield* git(cwd, ["branch", "-m", "t3/temporary", "feature/named"]).pipe(
                  Effect.provideService(GitVcsDriver.GitVcsDriver, outer),
                  Effect.orDie,
                );
                yield* Deferred.succeed(renamed, undefined);
              }
              yield* Deferred.await(renamed);
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

        assert.strictEqual(status.branch, "t3/temporary");
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: null,
          insertions: 1,
          deletions: 0,
        });
      }),
    );
    it.effect("keeps local branch bases consistent when tags share their names", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        const initialCommit = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["update-ref", "refs/tags/main", initialCommit]);
        yield* git(cwd, ["update-ref", "refs/tags/release/v2", initialCommit]);
        yield* writeTextFile(cwd, "README.md", "# test\nbase work\n");
        yield* git(cwd, ["commit", "-am", "base work"]);
        yield* git(cwd, ["branch", "release/v2", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/local-base", "HEAD"]);
        yield* writeTextFile(cwd, "README.md", "# test\nbase work\nfeature work\n");
        yield* git(cwd, ["commit", "-am", "feature work"]);

        for (const configuredBase of [undefined, "main", "release/v2"]) {
          if (configuredBase !== undefined) {
            yield* git(cwd, ["config", "branch.feature/local-base.gh-merge-base", configuredBase]);
          }
          const baseRef = configuredBase ?? "main";
          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, { baseRef, insertions: 1, deletions: 0 });
          assert.strictEqual(status.aheadCount, 1);
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const changes = preview.sources.find((source) => source.kind === "branch-range")!;
          assert.strictEqual(changes.baseRef, baseRef);
          assert.deepStrictEqual(changes.files, [
            { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
          ]);
          const scoped = yield* driver.getReviewDiffPreview({
            cwd,
            baseRef,
            file: { path: "README.md", previousPath: null, sourceKind: "branch-range" },
          });
          const scopedChanges = scoped.sources.find((source) => source.kind === "branch-range")!;
          assert.deepStrictEqual(scopedChanges.files, changes.files);
          assert.strictEqual(scopedChanges.diff, changes.diff);
          const contents = yield* driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              sourceKind: "branch-range",
              baseRef: changes.baseRef,
              headRef: "feature/local-base",
            }),
          );
          assert.deepStrictEqual(contents, {
            oldContents: "# test\nbase work\n",
            newContents: "# test\nbase work\nfeature work\n",
          });
        }

        for (const baseRef of ["refs/tags/main", initialCommit, "HEAD~2"]) {
          const contents = yield* driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              sourceKind: "branch-range",
              baseRef,
              headRef: "feature/local-base",
            }),
          );
          assert.strictEqual(contents.oldContents, "# test\n");
        }
      }),
    );
    it.effect("Changes accepts an explicit base on a detached HEAD and rejects a bad one", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "--detach"]);
        yield* writeTextFile(cwd, "detached.txt", "detached\n");
        yield* git(cwd, ["add", "detached.txt"]);
        yield* git(cwd, ["commit", "-m", "detached work"]);

        const explicit = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        assert.deepStrictEqual(
          explicit.sources.find((source) => source.kind === "branch-range")!.files,
          [{ path: "detached.txt", previousPath: null, additions: 1, deletions: 0 }],
        );
        const implicit = yield* driver.getReviewDiffPreview({ cwd });
        assert.deepStrictEqual(
          implicit.sources.find((source) => source.kind === "branch-range")!.files,
          [],
        );
        const error = yield* driver
          .getReviewDiffPreview({ cwd, baseRef: "missing-base" })
          .pipe(Effect.flip);
        assert.strictEqual(error.operation, "GitVcsDriver.resolveReviewMergeBase");
      }),
    );
    it.effect("Changes compares with the empty tree before the first commit", () =>
      Effect.gen(function* () {
        const upstream = yield* makeTmpDir();
        yield* initRepoWithCommit(upstream);
        yield* git(upstream, ["branch", "-M", "main"]);
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["init", "-b", "main"]);
        yield* git(cwd, ["remote", "add", "origin", upstream]);
        yield* git(cwd, ["fetch", "origin"]);
        yield* writeTextFile(cwd, "new.txt", "one\ntwo\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.isNull(changes.baseRef);
        assert.deepStrictEqual(changes.files, [
          { path: "new.txt", previousPath: null, additions: 2, deletions: 0 },
        ]);
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: null,
          insertions: 2,
          deletions: 0,
        });
      }),
    );
    it.effect("Changes does not show newer base commits as deletions", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/rebased"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature work"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "base moves"]);
        yield* git(cwd, ["checkout", "feature/rebased"]);

        for (const rebase of [false, true]) {
          if (rebase) yield* git(cwd, ["rebase", initialBranch]);
          const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
          assert.deepStrictEqual(
            preview.sources.find((source) => source.kind === "branch-range")!.files,
            [{ path: "feature.txt", previousPath: null, additions: 1, deletions: 0 }],
          );
        }
      }),
    );
  });
});
