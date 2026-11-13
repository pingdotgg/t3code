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
  makeNonRepositoryHandle,
  makeSuccessfulHandle,
  byteChunks,
  makeDriver,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

describe("Git output collection", () => {
  // Git writes in arbitrary chunk sizes; one byte per chunk splits every
  // multibyte character across reads.
  const byteChunks = (text: string) =>
    Stream.fromIterable(Array.from(new TextEncoder().encode(text), (byte) => Uint8Array.of(byte)));
  const makeDriver = (output: { stdout?: string; stderr?: string }) =>
    makeGitVcsDriverCore().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              stdout: byteChunks(output.stdout ?? ""),
              stderr: byteChunks(output.stderr ?? ""),
            }),
          ),
        ),
      ),
    );

  it.effect("returns the same split UTF-8 and NUL output with and without line callbacks", () =>
    Effect.gen(function* () {
      const stdout = "a\\b\0雪\nlast ";
      const stderr = "Receiving é\r\nUpdating 雪\rdone";
      const driver = yield* makeDriver({ stdout, stderr });
      const input = { operation: "test.chunkedGitOutput", cwd: "/repo", args: ["status"] };
      const expected = {
        exitCode: 0,
        stdout,
        stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
      };

      assert.deepEqual(yield* driver.execute(input), expected);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const withCallbacks = yield* driver.execute({
        ...input,
        progress: {
          onStdoutLine: (line) => Effect.sync(() => void stdoutLines.push(line)),
          onStderrLine: (line) => Effect.sync(() => void stderrLines.push(line)),
        },
      });
      assert.deepEqual(withCallbacks, expected);
      assert.deepEqual(stdoutLines, ["a\\b\0雪", "last "]);
      assert.deepEqual(stderrLines, ["Receiving é", "Updating 雪", "done"]);
    }).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect("caps output without line callbacks", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver({ stderr: "é雪\rdone" });
      const input = {
        operation: "test.cappedGitOutput",
        cwd: "/repo",
        args: ["status"],
        maxOutputBytes: 3,
      };

      const truncated = yield* driver.execute({ ...input, appendTruncationMarker: true });
      assert.equal(truncated.stderr, "é\uFFFD");
      assert.isTrue(truncated.stderrTruncated);

      const error = yield* driver.execute(input).pipe(Effect.flip);
      assert.equal(error.outputLength, 4);
      assert.include(error.detail, "exceeded 3 bytes");
    }).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
it.effect.each(["root", "nested", "worktree"] as const)(
  "skips clean filters while the %s index is locked and resumes after unlock",
  (location) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* makeTmpDir();
      yield* initRepoWithCommit(repository);
      const cwd = location === "worktree" ? yield* makeTmpDir() : repository;
      if (location === "worktree") {
        yield* git(repository, ["worktree", "add", "--detach", cwd]);
      }
      yield* git(cwd, ["config", "filter.probe.clean", "echo clean >> .filter-runs; cat"]);
      yield* writeTextFile(cwd, ".gitattributes", "asset.bin filter=probe\n");
      yield* writeTextFile(cwd, ".gitignore", ".filter-runs\n");
      yield* writeTextFile(cwd, "asset.bin", "original\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "filtered asset"]);
      NodeFS.utimesSync(path.join(cwd, "asset.bin"), 1, 1);
      const runsPath = path.join(cwd, ".filter-runs");
      yield* fs.remove(runsPath, { force: true });
      const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
      const lockPath = `${path.resolve(cwd, indexPath)}.lock`;
      yield* fs.writeFileString(lockPath, "");
      const statusCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
      yield* fs.makeDirectory(statusCwd, { recursive: true });

      for (let poll = 0; poll < 3; poll++) {
        const result = yield* driver.statusDetailsLocal(statusCwd).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.include(result.failure.detail, "index is locked");
      }
      assert.isFalse(yield* fs.exists(runsPath));
      assert.isTrue(yield* fs.exists(lockPath));

      yield* fs.remove(lockPath);
      const status = yield* driver.statusDetailsLocal(statusCwd);
      assert.isFalse(status.hasWorkingTreeChanges);
      assert.include(yield* fs.readFileString(runsPath), "clean");
    }).pipe(Effect.provide(layerTest)),
);
it.effect.each(["origin", "github"] as const)(
  "recognizes %s as the primary remote after a driver mutation",
  (remoteName) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);

      assert.equal((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote, false);
      assert.equal((yield* driver.listRefs({ cwd })).hasPrimaryRemote, false);

      yield* driver.ensureRemote({ cwd, preferredName: remoteName, url: remote });

      assert.equal((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote, true);
      assert.equal((yield* driver.listRefs({ cwd })).hasPrimaryRemote, true);
    }).pipe(Effect.provide(layerTest)),
);
it.effect.each([
  { hookExitCode: 0, commonDirFailure: "none" },
  { hookExitCode: 1, commonDirFailure: "none" },
  { hookExitCode: 0, commonDirFailure: "error" },
  { hookExitCode: 1, commonDirFailure: "error" },
  { hookExitCode: 0, commonDirFailure: "non-repository" },
  { hookExitCode: 1, commonDirFailure: "non-repository" },
])(
  "invalidates sibling worktree refs and status after checkout hook exit $hookExitCode with common-dir failure $commonDirFailure",
  ({ hookExitCode, commonDirFailure }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        let invalidationFailure = "none";
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("expected a standard Git command");
            }
            spawnedArgs.push(command.args.map(String));
            if (invalidationFailure !== "none" && command.args.includes("--git-common-dir")) {
              if (invalidationFailure === "non-repository") return makeNonRepositoryHandle();
              return ChildProcessSpawner.makeHandle({
                ...makeNonRepositoryHandle(),
                stderr: Stream.encodeText(Stream.make("fatal: could not read repository metadata")),
              });
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const siblingPath = path.join(yield* makeTmpDir("git-worktrees-"), "sibling");
        yield* git(cwd, ["worktree", "add", "-b", "cache-sibling", siblingPath, "HEAD"]);

        const before = yield* driver.listRefs({ cwd: siblingPath, refresh: true });
        assert.isTrue(before.refs.find((ref) => ref.name === "cache-sibling")?.current);
        const statusBefore = yield* driver.statusDetailsLocal(siblingPath);
        assert.isFalse(statusBefore.hasOriginRemote);
        assert.isFalse(statusBefore.isDefaultBranch);
        yield* driver.listRefs({ cwd, refresh: true });
        yield* git(cwd, ["checkout", "-b", "creator-current"]);
        yield* writeTextFile(
          cwd,
          ".git/hooks/post-checkout",
          "#!/bin/sh\n" +
            "git remote add origin https://example.invalid/repo.git || exit 2\n" +
            "git update-ref refs/remotes/origin/cache-sibling HEAD || exit 2\n" +
            "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/cache-sibling || exit 2\n" +
            `exit ${hookExitCode}\n`,
        );
        yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "created");
        spawnedArgs.length = 0;
        invalidationFailure = commonDirFailure;

        const created = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/cache-created",
          })
          .pipe(Effect.result);

        assert.equal(Result.isSuccess(created), hookExitCode === 0);
        if (Result.isFailure(created)) {
          assert.equal(created.failure.operation, "GitVcsDriver.createWorktree");
          assert.equal(created.failure.detail, "git worktree add failed");
          assert.equal(created.failure.exitCode, hookExitCode);
        }
        const metadataQueries = spawnedArgs.filter((args) => args.includes("--git-common-dir"));
        assert.deepStrictEqual(metadataQueries, [["rev-parse", "--git-common-dir"]]);
        assert.isFalse(spawnedArgs.some((args) => args.includes("symbolic-ref")));
        invalidationFailure = "none";

        spawnedArgs.length = 0;
        const creatorStatus = yield* driver.statusDetailsLocal(cwd);
        assert.equal(creatorStatus.branch, "creator-current");
        assert.isTrue(spawnedArgs.some((args) => args.includes("--git-common-dir")));
        const siblingRefs = yield* driver.listRefs({ cwd: siblingPath });
        const createdRef = siblingRefs.refs.find((ref) => ref.name === "feature/cache-created");
        assert.isDefined(createdRef?.worktreePath);
        assert.equal(
          NodeFS.realpathSync.native(createdRef!.worktreePath!),
          NodeFS.realpathSync.native(worktreePath),
        );
        assert.isTrue(siblingRefs.hasPrimaryRemote);
        assert.isTrue(siblingRefs.refs.find((ref) => ref.name === "cache-sibling")?.current);
        const statusAfter = yield* driver.statusDetailsLocal(siblingPath);
        assert.isTrue(statusAfter.hasOriginRemote);
        assert.isTrue(statusAfter.isDefaultBranch);
        const creatorRefs = yield* driver.listRefs({ cwd });
        assert.isTrue(creatorRefs.refs.find((ref) => ref.name === "creator-current")?.current);
        assert.isFalse(creatorRefs.refs.find((ref) => ref.name === initialBranch)?.current);
      }),
    ).pipe(Effect.provide(layerTest)),
);
it.effect.each(["branch", "detached", "nested", "aliased-root", "aliased-nested"] as const)(
  "discovers only the common directory during worktree creation from %s",
  (location) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        if (location === "detached") yield* git(cwd, ["checkout", "--detach"]);
        const isNested = location === "nested" || location === "aliased-nested";
        const physicalCwd = isNested ? path.join(cwd, "nested") : cwd;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(physicalCwd, { recursive: true });
        const isAliased = location === "aliased-root" || location === "aliased-nested";
        const creationCwd = isAliased
          ? path.join(yield* makeTmpDir("git-alias-"), "link")
          : physicalCwd;
        if (isAliased) NodeFS.symlinkSync(physicalCwd, creationCwd, "junction");
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "cold");

        yield* driver.createWorktree({
          cwd: creationCwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/cold",
        });

        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
        assert.isFalse(spawnedArgs.some((args) => args.includes("--show-toplevel")));
        assert.isFalse(spawnedArgs.some((args) => args.includes("symbolic-ref")));
        spawnedArgs.length = 0;
        const originalStatus = yield* driver.statusDetailsLocal(creationCwd);
        assert.equal(originalStatus.branch, location === "detached" ? null : initialBranch);
        const originalRefs = yield* driver.listRefs({ cwd: creationCwd });
        assert.equal(originalRefs.isAtRepositoryRoot, !isNested);
        assert.deepStrictEqual(
          originalRefs.refs.filter((ref) => ref.current).map((ref) => ref.name),
          location === "detached" ? [] : [initialBranch],
        );
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
        const refs = yield* driver.listRefs({ cwd: worktreePath });
        assert.isTrue(refs.refs.find((ref) => ref.name === "feature/cold")?.current);
        assert.equal(
          yield* git(worktreePath, ["rev-parse", "HEAD"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);
it.effect.each(["bare", "unborn"] as const)(
  "invalidates a %s repository after worktree creation",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* makeTmpDir();
        const cwd = yield* makeTmpDir("git-discovery-fallback-");
        if (state === "bare") {
          yield* initRepoWithCommit(source);
          yield* git(source, ["clone", "--bare", source, cwd]);
        } else {
          yield* git(cwd, ["init"]);
        }
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
          return delegate.spawn(
            state === "bare" ? ChildProcess.setEnv(command, { GIT_DIR: cwd }) : command,
          );
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "fallback");
        const result = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: "HEAD",
            newRefName: "feature/fallback",
          })
          .pipe(Effect.result);
        assert.equal(Result.isSuccess(result), state === "bare");
        if (Result.isFailure(result)) {
          assert.equal(result.failure.operation, "GitVcsDriver.createWorktree.createBranch");
          assert.equal(result.failure.detail, "git worktree add failed");
        }
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
        assert.isFalse(spawnedArgs.some((args) => args[0] === "symbolic-ref"));
        spawnedArgs.length = 0;
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.isRepo);
        if (state === "bare") {
          assert.isTrue(refs.refs.some((ref) => ref.name === "feature/fallback"));
        } else {
          assert.isEmpty(refs.refs);
        }
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
      }),
    ).pipe(Effect.provide(layerTest)),
);
it.effect.each(["on a branch", "detached", "unborn"] as const)(
  "reads only the repository root for review requests that ignore the branch when %s",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const discoveries = () => {
          const commands = spawnedArgs.filter(
            (args) =>
              args.includes("--show-toplevel") ||
              args.includes("--git-common-dir") ||
              (args.includes("symbolic-ref") && args.includes("HEAD")),
          );
          spawnedArgs.length = 0;
          return commands.length;
        };
        const cwd = yield* makeTmpDir();
        if (state === "unborn") {
          yield* git(cwd, ["init", "-b", "main"]);
        } else {
          yield* initRepoWithCommit(cwd);
          yield* writeTextFile(cwd, "committed.txt", "committed\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "add file"]);
          if (state === "detached") yield* git(cwd, ["checkout", "--detach"]);
        }
        yield* writeTextFile(cwd, "new.txt", "new\n");
        spawnedArgs.length = 0;

        const workingTree = yield* driver.getReviewDiffPreview({
          cwd,
          file: { path: "new.txt", previousPath: null, sourceKind: "working-tree" },
        });
        assert.equal(discoveries(), 1);
        assert.deepStrictEqual(
          workingTree.sources
            .find((source) => source.kind === "working-tree")!
            .files!.map((file) => file.path),
          ["new.txt"],
        );

        if (state !== "unborn") {
          const commitSha = yield* git(cwd, ["rev-parse", "HEAD"]);
          spawnedArgs.length = 0;
          const commit = yield* driver.getReviewDiffPreview({
            cwd,
            commitSha,
            file: { path: "committed.txt", previousPath: null, sourceKind: "commit" },
          });
          assert.equal(discoveries(), 1);
          assert.include(commit.sources[0]!.diff, "+committed");
        }

        const general = yield* driver.getReviewDiffPreview({ cwd });
        assert.equal(discoveries(), 3);
        assert.equal(
          general.sources.find((source) => source.kind === "branch-range")!.headRef,
          state === "detached" ? "HEAD" : yield* git(cwd, ["branch", "--show-current"]),
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);
it.effect.each([
  { kind: "working-tree", request: { sourceKind: "working-tree" } },
  { kind: "commit", request: { sourceKind: "commit", commitSha: "HEAD" } },
] as const)("keeps $kind review requests safe without a worktree root", ({ request }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const bareRoot = yield* makeTmpDir("git-review-bare-");
      const spawner = ChildProcessSpawner.make((command) =>
        delegate.spawn(
          ChildProcess.isStandardCommand(command) && command.options.cwd === bareRoot
            ? ChildProcess.setEnv(command, { GIT_DIR: bareRoot })
            : command,
        ),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const path = yield* Path.Path;
      const file = { path: "README.md", previousPath: null, sourceKind: request.sourceKind };
      const input = (cwd: string) => ({
        cwd,
        file,
        ...("commitSha" in request ? { commitSha: request.commitSha } : {}),
      });
      const source = yield* makeTmpDir();
      yield* initRepoWithCommit(source);
      yield* git(source, ["clone", "--bare", source, bareRoot]);
      const nonRepository = yield* makeTmpDir();
      for (const cwd of [bareRoot, nonRepository, path.join(nonRepository, "missing")]) {
        assert.isEmpty((yield* driver.getReviewDiffPreview(input(cwd))).sources);
      }

      const brokenConfig = yield* makeTmpDir();
      yield* initRepoWithCommit(brokenConfig);
      yield* writeTextFile(brokenConfig, ".git/config", "[broken");
      const error = yield* driver.getReviewDiffPreview(input(brokenConfig)).pipe(Effect.flip);
      assert.equal(error.operation, "GitVcsDriver.resolveRepositoryPaths.commonDir");
    }),
  ).pipe(Effect.provide(layerTest)),
);
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "preserves embedded newlines in repository paths after worktree creation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const cwd = path.join(yield* makeTmpDir(), "repo\nwith-newline");
        yield* fs.makeDirectory(cwd);
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "newline");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/newline",
        });
        const status = yield* driver.statusDetailsLocal(cwd);
        assert.equal(status.branch, initialBranch);
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/newline"));
      }),
    ).pipe(Effect.provide(layerTest)),
);
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "preserves a trailing carriage return in the repository root after creation through an alias",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const sandbox = yield* makeTmpDir();
        const repository = path.join(sandbox, "repo\r");
        const cwd = path.join(sandbox, "alias");
        yield* fs.makeDirectory(repository);
        const { initialBranch } = yield* initRepoWithCommit(repository);
        NodeFS.symlinkSync(repository, cwd, "junction");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: path.join(yield* makeTmpDir("git-worktrees-"), "created"),
          refName: initialBranch,
          newRefName: "feature/carriage-return",
        });
        const status = yield* driver.statusDetailsLocal(cwd);
        assert.equal(status.workingTree.rootPath, NodeFS.realpathSync.native(repository));
        assert.equal(status.branch, initialBranch);
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.isAtRepositoryRoot);
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/carriage-return"));
      }),
    ).pipe(Effect.provide(layerTest)),
);
it.effect(
  "reads fresh metadata when another mutation completes during common-directory discovery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const discoveryComplete = yield* Deferred.make<void>();
        const releaseDiscovery = yield* Deferred.make<void>();
        let holdDiscovery = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (
              !holdDiscovery ||
              !ChildProcess.isStandardCommand(command) ||
              !command.args.includes("--git-common-dir")
            )
              return handle;
            holdDiscovery = false;
            const output = yield* Stream.runCollect(handle.stdout);
            yield* handle.exitCode;
            yield* Deferred.succeed(discoveryComplete, undefined);
            yield* Deferred.await(releaseDiscovery);
            return ChildProcessSpawner.makeHandle({
              ...handle,
              stdout: Stream.fromIterable(output),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* driver.listRefs({ cwd, refresh: true });
        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "concurrent");
        holdDiscovery = true;
        const creation = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: "HEAD",
            newRefName: "feature/concurrent",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.gen(function* () {
          yield* Deferred.await(discoveryComplete);
          yield* driver.switchRef({ cwd, refName: commit });
        }).pipe(Effect.ensuring(Deferred.succeed(releaseDiscovery, undefined)));
        const created = yield* Fiber.join(creation);
        assert.equal(created.worktree.path, worktreePath);
        const refs = yield* driver.listRefs({ cwd });
        assert.isEmpty(refs.refs.filter((ref) => ref.current));
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/concurrent"));
        assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, null);
      }),
    ).pipe(Effect.provide(layerTest)),
);
it.effect("invalidates cached metadata after interrupted worktree creation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const discoveryComplete = yield* Deferred.make<void>();
      const releaseDiscovery = yield* Deferred.make<void>();
      let holdDiscovery = false;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          if (
            !holdDiscovery ||
            !ChildProcess.isStandardCommand(command) ||
            !command.args.includes("--git-common-dir")
          )
            return handle;
          holdDiscovery = false;
          const output = yield* Stream.runCollect(handle.stdout);
          yield* handle.exitCode;
          yield* Deferred.succeed(discoveryComplete, undefined);
          yield* Deferred.await(releaseDiscovery);
          return ChildProcessSpawner.makeHandle({ ...handle, stdout: Stream.fromIterable(output) });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* driver.listRefs({ cwd, refresh: true });
      yield* driver.statusDetailsLocal(cwd);
      yield* git(cwd, ["checkout", "-b", "creator-current"]);
      const path = yield* Path.Path;
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "interrupted");
      holdDiscovery = true;
      const creation = yield* driver
        .createWorktree({
          cwd,
          path: worktreePath,
          refName: "HEAD",
          newRefName: "feature/interrupted",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const cancellation = yield* Effect.gen(function* () {
        yield* Deferred.await(discoveryComplete);
        return yield* Fiber.interrupt(creation).pipe(Effect.forkChild({ startImmediately: true }));
      }).pipe(Effect.ensuring(Deferred.succeed(releaseDiscovery, undefined)));
      yield* Fiber.join(cancellation);
      const exit = yield* Fiber.await(creation);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.find((ref) => ref.name === "creator-current")?.current);
      const interruptedRef = refs.refs.find((ref) => ref.name === "feature/interrupted");
      assert.isDefined(interruptedRef?.worktreePath);
      assert.equal(
        NodeFS.realpathSync.native(interruptedRef!.worktreePath!),
        NodeFS.realpathSync.native(worktreePath),
      );
      assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "creator-current");
      const nextPath = path.join(yield* makeTmpDir("git-worktrees-"), "after-interruption");
      yield* driver.createWorktree({
        cwd,
        path: nextPath,
        refName: "HEAD",
        newRefName: "feature/after",
      });
      assert.isTrue(
        (yield* driver.listRefs({ cwd })).refs.some((ref) => ref.name === "feature/after"),
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);
