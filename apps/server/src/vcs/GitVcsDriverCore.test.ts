// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

const encodeGitCommandError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));
const decodeVcsRef = Schema.decodeUnknownSync(VcsRef);
const decodeVcsListRefsResult = Schema.decodeUnknownSync(VcsListRefsResult);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(NodeServices.layer),
);

const makeNonRepositoryHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make("fatal: not a git repository")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeSuccessfulHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeFailedHandle = (stderr: string) =>
  ChildProcessSpawner.makeHandle({
    ...makeNonRepositoryHandle(),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    stderr: Stream.encodeText(Stream.make(stderr)),
  });

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
    }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
    }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const makeReviewDiffFileContentsInput = (
  cwd: string,
  overrides: Partial<Omit<ReviewDiffFileContentsInput, "cwd">> = {},
): ReviewDiffFileContentsInput => ({
  cwd,
  sourceKind: "working-tree",
  changeType: "change",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "README.md",
  newPath: "README.md",
  ...overrides,
});

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
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

it.effect("invalidates origin remote cache when a driver mutation adds origin", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    const before = yield* driver.statusDetailsLocal(cwd);
    assert.equal(before.hasOriginRemote, false);

    yield* driver.ensureRemote({ cwd, preferredName: "origin", url: remote });

    const after = yield* driver.statusDetailsLocal(cwd);
    assert.equal(after.hasOriginRemote, true);
  }).pipe(Effect.provide(layerTest)),
);

describe("pullCurrentBranch", () => {
  // A fast-forward that prints over 1 MB takes thousands of files, so the real pull's output is
  // padded past the cap instead.
  const withPaddedPull = (
    stream: "stdout" | "stderr",
    onPull?: (args: ReadonlyArray<string>) => void,
  ) =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const padding = new Uint8Array(1_000_001).fill(0x20);
      const paddingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          const isPull =
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("pull") &&
            command.args.includes("--ff-only");
          if (isPull) onPull?.(command.args);
          return isPull
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                [stream]: Stream.concat(handle[stream], Stream.make(padding)),
              })
            : handle;
        }),
      );
      return yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, paddingSpawner),
      );
    });

  const cloneBehindRemote = Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    const updater = yield* makeTmpDir("git-vcs-driver-updater-");
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* git(cwd, ["push", "-u", "origin", initialBranch]);
    yield* git(updater, ["clone", remote, "."]);
    yield* git(updater, ["config", "user.email", "test@test.com"]);
    yield* git(updater, ["config", "user.name", "Test"]);
    yield* writeTextFile(updater, "remote.txt", "remote\n");
    yield* git(updater, ["add", "remote.txt"]);
    yield* git(updater, ["commit", "-m", "remote commit"]);
    yield* git(updater, ["push", "origin", initialBranch]);
    return {
      cwd,
      remote,
      updater,
      initialBranch,
      remoteHead: yield* git(updater, ["rev-parse", "HEAD"]),
    };
  });

  it.effect("still fetches other branches on the first pull", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { cwd, updater, remoteHead } = yield* cloneBehindRemote;
      yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);

      const result = yield* driver.pullCurrentBranch(cwd);

      assert.equal(result.status, "pulled");
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
      assert.equal(yield* git(cwd, ["rev-parse", "refs/remotes/origin/other"]), remoteHead);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "pulls past an unrelated lock with custom fetch mapping=%s",
    (customMapping) =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fs = yield* FileSystem.FileSystem;
        const { cwd, updater, initialBranch, remoteHead } = yield* cloneBehindRemote;
        yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);
        const remoteName = customMapping ? "team/upstream" : "origin";
        const refPrefix = customMapping
          ? `refs/remotes/${remoteName}/mapped`
          : "refs/remotes/origin";
        if (customMapping) {
          yield* git(cwd, ["remote", "rename", "origin", remoteName]);
          yield* git(cwd, ["config", `remote.${remoteName}.fetch`, `+refs/heads/*:${refPrefix}/*`]);
          yield* git(cwd, ["update-ref", `${refPrefix}/${initialBranch}`, "HEAD"]);
        }
        const lock = `.git/${refPrefix}/other.lock`;
        yield* writeTextFile(cwd, lock, "");

        const result = yield* driver.pullCurrentBranch(cwd);

        assert.equal(result.status, "pulled");
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
        assert.equal(yield* git(cwd, ["rev-parse", `${refPrefix}/${initialBranch}`]), remoteHead);
        assert.isTrue(yield* fs.exists(`${cwd}/${lock}`));
        assert.equal(yield* fs.readFileString(`${cwd}/${lock}`), "");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports an upstream lock after the fallback without removing it", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const { cwd, initialBranch } = yield* cloneBehindRemote;
      const before = yield* git(cwd, ["rev-parse", "HEAD"]);
      const lock = `.git/refs/remotes/origin/${initialBranch}.lock`;
      yield* writeTextFile(cwd, lock, "");

      const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

      assert.include(error.detail, "could not update a local reference");
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), before);
      assert.isTrue(yield* fs.exists(`${cwd}/${lock}`));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["branch", "HEAD"] as const)(
    "does not retry a failed fetch if another operation moved %s",
    (moved) =>
      Effect.gen(function* () {
        const fixtureDriver = yield* GitVcsDriver.GitVcsDriver;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { cwd, updater } = yield* cloneBehindRemote;
        yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);
        yield* writeTextFile(cwd, ".git/refs/remotes/origin/other.lock", "");
        let pulls = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (!ChildProcess.isStandardCommand(command) || !command.args.includes("pull")) {
              return handle;
            }
            pulls += 1;
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.tap(() =>
                  git(
                    cwd,
                    moved === "branch"
                      ? ["checkout", "-b", "moved"]
                      : ["commit", "--allow-empty", "-m", "concurrent commit"],
                  ).pipe(
                    Effect.provideService(GitVcsDriver.GitVcsDriver, fixtureDriver),
                    Effect.orDie,
                  ),
                ),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

        assert.include(error.detail, "could not update a local reference");
        assert.equal(pulls, 1);
      }).pipe(Effect.scoped, Effect.provide(layerServerConfig.pipe(Layer.provideMerge(layerTest)))),
  );

  it.effect.each(["stdout", "stderr"] as const)(
    "reports a fast-forward whose %s passes the cap as pulled",
    (stream) =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* withPaddedPull(stream);
          yield* Effect.gen(function* () {
            const { cwd, remoteHead } = yield* cloneBehindRemote;

            const result = yield* driver.pullCurrentBranch(cwd);

            assert.equal(result.status, "pulled");
            assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
          }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
        }),
      ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

  it.effect("still fails a pull that Git rejects, whatever its output size", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pulls: ReadonlyArray<string>[] = [];
        const driver = yield* withPaddedPull("stderr", (args) => pulls.push(args));
        yield* Effect.gen(function* () {
          const { cwd } = yield* cloneBehindRemote;
          yield* writeTextFile(cwd, "local.txt", "local\n");
          yield* git(cwd, ["add", "local.txt"]);
          yield* git(cwd, ["commit", "-m", "local commit"]);

          const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

          assert.equal(error.operation, "GitVcsDriver.pullCurrentBranch.pull");
          assert.equal(error.exitCode, 128);
          assert.notInclude(error.detail, "exceeded");
          assert.lengthOf(pulls, 1);
        }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      }),
    ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});

it.effect("retries an in-flight ref snapshot invalidated by a mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const firstRefScanCompleted = yield* Deferred.make<void>();
      const releaseFirstWorktreeScan = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const refScans = yield* Ref.make(0);
      const coordinatingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false))) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Deferred.await(releaseFirstWorktreeScan);
          }
          const handle = yield* delegate.spawn(command);
          const isRefScan =
            command.args.includes("for-each-ref") &&
            command.args.includes("refs/heads") &&
            command.args.includes("refs/remotes");
          if (!isRefScan) return handle;
          const scan = yield* Ref.updateAndGet(refScans, (count) => count + 1);
          return scan === 1
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(firstRefScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, coordinatingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const inFlight = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(firstRefScanCompleted);

      yield* driver.createRef({ cwd, refName: "feature/during-refresh" });
      yield* Deferred.succeed(releaseFirstWorktreeScan, undefined);

      const refs = yield* Fiber.join(inFlight);
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/during-refresh"));
      assert.equal(yield* Ref.get(refScans), 2);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("invalidates a ref snapshot when a mutation fails after changing Git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const partiallyFailingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args[0] === "branch" && command.args.at(-1) === "feature/partial-failure") {
            const handle = yield* delegate.spawn(command);
            yield* handle.exitCode;
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, partiallyFailingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* driver.listRefs({ cwd, refresh: true });

      yield* driver.createRef({ cwd, refName: "feature/partial-failure" }).pipe(Effect.flip);

      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/partial-failure"));
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("marks the current branch when worktree metadata is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const incompleteMetadataSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeRoot =
            command.args.includes("rev-parse") && command.args.includes("--show-toplevel");
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeRoot || isWorktreeList) {
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, incompleteMetadataSpawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.isTrue(refs.isRepo);
      assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("ignores worktree metadata for directories that no longer exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missingWorktreePath = "/missing/deleted-worktree";
      const staleWorktreeSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeList) {
            return makeSuccessfulHandle(
              `worktree ${missingWorktreePath}\0HEAD deadbeef\0branch refs/heads/stale-worktree\0\0`,
            );
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, staleWorktreeSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* git(cwd, ["branch", "stale-worktree"]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.equal(refs.refs.find((ref) => ref.name === "stale-worktree")?.worktreePath, null);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("reads worktrees from git that rejects worktree list -z", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Git before 2.36 has no `worktree list -z` and exits with a usage error.
      const oldGitSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("worktree") && command.args.includes("-z")) {
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(129)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.encodeText(Stream.make("error: unknown switch `z'")),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, oldGitSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      const worktreePath = NodeFS.realpathSync.native(yield* makeTmpDir());
      yield* git(cwd, ["worktree", "add", "-b", "feature/old-git", worktreePath]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });
      const listedPath = refs.refs.find((ref) => ref.name === "feature/old-git")?.worktreePath;
      assert.equal(listedPath && NodeFS.realpathSync.native(listedPath), worktreePath);

      const paths = yield* driver.listWorktreePaths(cwd);
      assert.include(
        paths.map((listed) => NodeFS.realpathSync.native(listed)),
        worktreePath,
      );
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("does not report a separate git dir as the worktree of its branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const gitDir = yield* makeTmpDir();
      yield* git(cwd, ["init", `--separate-git-dir=${gitDir}`]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "init"]);

      const refs = yield* driver.listRefs({ cwd, refresh: true });
      const worktreePath = refs.refs.find((ref) => ref.current)?.worktreePath;

      assert.equal(
        worktreePath && NodeFS.realpathSync.native(worktreePath),
        NodeFS.realpathSync.native(cwd),
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  {
    name: "HTTPS credentials",
    stderr: "fatal: Authentication failed for",
    expected: "could not authenticate",
  },
  {
    name: "SSH credentials",
    stderr: "git@example.com: Permission denied (publickey).",
    expected: "could not authenticate",
  },
  {
    name: "disabled prompts",
    stderr: "fatal: could not read Username: terminal prompts disabled",
    expected: "could not authenticate",
  },
  {
    name: "DNS failure",
    stderr: "fatal: Could not resolve host: example.com",
    expected: "could not reach the remote",
  },
  {
    name: "connection failure",
    stderr: "ssh: connect to host example.com port 22: Connection refused",
    expected: "could not reach the remote",
  },
  {
    name: "missing remote",
    stderr: "remote: Repository not found.",
    expected: "could not access the remote repository",
  },
  {
    name: "invalid remote",
    stderr: "fatal: remote does not appear to be a git repository",
    expected: "could not access the remote repository",
  },
  {
    name: "reference lock",
    stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def",
    expected: "could not update a local reference",
    attempts: 2,
  },
  {
    name: "lock file",
    stderr: "fatal: Unable to create '/repo/.git/FETCH_HEAD.lock': File exists.",
    expected: "could not update a local reference",
    attempts: 2,
  },
  {
    name: "reference race on Git 2.53",
    stderr: "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
    expected: "could not update a local reference",
    attempts: 2,
  },
  {
    name: "held reference lock on Git 2.53",
    stderr: "error: fetching ref refs/remotes/origin/main failed: reference already exists",
    expected: "could not update a local reference",
    attempts: 2,
  },
  {
    name: "unrelated remote chatter",
    stderr:
      "remote: Help: authentication failed, connection refused, cannot lock ref\nremote: unrelated service error",
    expected: "git fetch origin failed",
  },
  {
    name: "HTTPS DNS failure",
    stderr:
      "fatal: unable to access 'https://example.com/repo.git/': Could not resolve host: example.com",
    expected: "could not reach the remote",
  },
  {
    name: "unknown failure",
    stderr: "fatal: unexpected remote failure",
    expected: "git fetch origin failed",
  },
] as const)("reports $name during fetch without retaining remote output", (scenario) =>
  Effect.gen(function* () {
    const secret = "secret-fetch-token";
    const stderr = `${scenario.stderr}\nhttps://user:${secret}@example.com/private?token=${secret}`;
    const attempts = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] !== "fetch") return makeNonRepositoryHandle();
        assert.deepEqual(command.args, ["fetch", "--quiet", "--", "origin"]);
        assert.equal(command.options.env?.LC_ALL, "C");
        assert.equal(command.options.env?.GIT_TERMINAL_PROMPT, "0");
        yield* Ref.update(attempts, (count) => count + 1);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(secret)),
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    const error = yield* driver.fetchRemote({ cwd, remoteName: "origin" }).pipe(Effect.flip);
    assert.include(error.detail, scenario.expected);
    assert.equal(error.exitCode, 128);
    assert.equal(error.stderrLength, stderr.length);
    assert.equal(error.stdoutLength, secret.length);
    assert.notInclude(error.message, secret);
    assert.notInclude(yield* encodeGitCommandError(error), secret);
    assert.notProperty(error, "stderr");
    assert.notProperty(error, "args");
    assert.equal(yield* Ref.get(attempts), "attempts" in scenario ? scenario.attempts : 1);
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("retries a fetch that lost a ref update to another Git process", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] !== "fetch") return makeNonRepositoryHandle();
        const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
        if (attempt > 1) return makeSuccessfulHandle("");
        return ChildProcessSpawner.makeHandle({
          ...makeNonRepositoryHandle(),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          stderr: Stream.encodeText(
            Stream.make(
              "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    yield* driver.fetchRemote({ cwd, remoteName: "origin", refName: "main" });
    assert.equal(yield* Ref.get(attempts), 2);
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

describe("rejected git refs", () => {
  const remoteUrl = "https://user:token-123@git.example.invalid/org/secret-repo.git";
  const failedPush = `error: failed to push some refs to '${remoteUrl}'`;
  const leakedText = [
    "token-123",
    "secret-repo",
    "git.example.invalid",
    "private-branch",
    "workflow scope",
  ];

  const failWith = (stderr: string) => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeFailedHandle(stderr)));
    const layer = GitVcsDriver.layer.pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      return yield* driver
        .execute({
          operation: "GitVcsDriver.test.rejectedRef",
          cwd: "/repo",
          args: ["push", "origin", "HEAD"],
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(layer));
  };

  it.effect.each([
    {
      label: "a ref the remote refused",
      stderr: [
        "remote: Unable to determine if workflow can be created; workflow scope may be required.",
        `To ${remoteUrl}`,
        " ! [remote rejected] private-branch -> private-branch (workflow scope may be required.)",
        failedPush,
      ],
      reason: "push_rejected_by_remote" as const,
      detail: "The remote rejected the push.",
    },
    {
      label: "a non-fast-forward push",
      stderr: [
        `To ${remoteUrl}`,
        " ! [rejected]        private-branch -> private-branch (non-fast-forward)",
        failedPush,
      ],
      reason: "push_rejected_non_fast_forward" as const,
      detail: "Pull or rebase",
    },
  ])("names $label without quoting stderr", ({ stderr, reason, detail }) =>
    Effect.gen(function* () {
      const error = yield* failWith(stderr.join("\n"));

      assert.deepInclude(error, { reason });
      assert.include(error.detail, detail);
      for (const text of leakedText) assert.notInclude(error.message, text);
    }),
  );

  // A fetch into a diverged local branch prints the same rejected line, but
  // never "failed to push some refs".
  it.effect("leaves a rejected fetch unclassified", () =>
    Effect.gen(function* () {
      const error = yield* failWith(
        [`From ${remoteUrl}`, " ! [rejected]        main       -> side  (non-fast-forward)"].join(
          "\n",
        ),
      );

      assert.equal(error.reason, undefined);
      assert.equal(error.detail, "Git command exited with a non-zero status.");
    }),
  );
});

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("structured errors", () => {
    it.effect("does not retain git arguments or stderr in command failures", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const secret = "secret-token-value";
        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.redactedFailure",
            cwd,
            args: ["status", `--unknown-option=${secret}`],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.redactedFailure",
          command: "git",
          argumentCount: 2,
          cwd,
        });
        assert.isNumber(error.exitCode);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, secret);
        assert.notInclude(error.message, secret);
        assert.notProperty(error, "args");
        assert.notProperty(error, "stderr");
        assert.notProperty(error, "reason");
      }),
    );

    // regression: #8645 name the cause of a failed git command
    it.effect("names the branch conflict behind a failed worktree add", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        const firstWorktree = pathService.join(parent, "first");
        yield* git(cwd, ["worktree", "add", firstWorktree, "-b", "shared-branch"]);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.worktreeAddConflict",
            cwd,
            args: ["worktree", "add", pathService.join(parent, "second"), "shared-branch"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.worktreeAddConflict",
          reason: "branch_checked_out_in_worktree",
        });
        assert.include(error.message, "(branch_checked_out_in_worktree)");
        assert.notInclude(error.message, firstWorktree);
      }),
    );

    // regression: #8645 name the cause of a failed git command
    it.effect("names a missing repository behind a failed command", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.notARepository",
            cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.notARepository",
          reason: "not_a_repository",
        });
        assert.include(error.message, "(not_a_repository)");
      }),
    );

    it.effect.each([
      { action: "worktree add", detail: "git worktree add failed" },
      { action: "switch", detail: "git checkout failed" },
    ])(
      "reports a missing ref during $action with stable, redacted diagnostics",
      ({ action, detail }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const path = yield* Path.Path;
          const refName = "private/deleted-base";
          const locales: Array<string | undefined> = [];
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) => {
            if (
              ChildProcess.isStandardCommand(command) &&
              (command.args.includes("worktree") || command.args[0] === "checkout")
            ) {
              locales.push(command.options.env?.LC_ALL);
            }
            return delegate.spawn(command);
          });
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );
          const error =
            action === "switch"
              ? yield* driver.switchRef({ cwd, refName }).pipe(Effect.flip)
              : yield* driver
                  .createWorktree({
                    cwd,
                    refName,
                    newRefName: "t3/new-thread",
                    path: path.join(cwd, "worktree"),
                  })
                  .pipe(Effect.flip);

          assert.deepInclude(error, { _tag: "GitCommandError", detail, reason: "ref_not_found" });
          assert.include(error.message, `${detail} (ref_not_found)`);
          assert.notInclude(error.message, refName);
          assert.notInclude(yield* encodeGitCommandError(error), refName);
          assert.deepEqual(locales, ["C"]);
          assert.notProperty(error, "stderr");
          assert.notProperty(error, "args");
        }),
    );

    it.effect.each([
      // Git cannot tell a missing revision from a missing file in these.
      { label: "an argument that may be a path", args: ["log", "-1", "missing"] },
      {
        label: "a pathspec worded like a diagnostic",
        args: ["checkout", "HEAD", "--", "fatal: invalid reference: missing"],
      },
      // The tag exists; it names a tree, which git reports in the same words.
      {
        label: "a worktree from a non-commit",
        args: ["worktree", "add", "tree-worktree", "tree-tag"],
      },
    ])("leaves $label unclassified rather than calling it a missing ref", ({ args }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        if (args.includes("tree-tag")) {
          yield* git(cwd, ["tag", "tree-tag", "HEAD^{tree}"]);
        }

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.ambiguousMissingName",
            cwd,
            args,
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
      }),
    );

    it.effect.each([
      {
        label: "a refused key",
        sshMessage: "git@example.invalid: Permission denied (publickey).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused key among several methods",
        sshMessage: "git@example.invalid: Permission denied (publickey,password).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused keyboard-interactive attempt",
        sshMessage: "git@example.invalid: Permission denied (keyboard-interactive).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a rejected password",
        sshMessage: "Permission denied, please try again.",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "an untrusted host key",
        sshMessage: "Host key verification failed.",
        expectedReason: "host_key_unverified" as const,
        expectedText: "(host_key_unverified)",
      },
    ])(
      "names $label rather than an unreachable remote",
      ({ sshMessage, expectedReason, expectedText }) =>
        Effect.gen(function* () {
          const parent = yield* makeTmpDir();
          const pathService = yield* Path.Path;
          const cwd = pathService.join(parent, "repo");
          const fileSystem = yield* FileSystem.FileSystem;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* fileSystem.makeDirectory(cwd);
          yield* initRepoWithCommit(cwd);
          yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
          const fakeSsh = pathService.join(parent, "fake-ssh");
          yield* writeTextFile(
            parent,
            "fake-ssh",
            `#!/bin/sh\necho "${sshMessage}" >&2\nexit 255\n`,
          );
          yield* fileSystem.chmod(fakeSsh, 0o755);

          const error = yield* driver
            .execute({
              operation: "GitVcsDriver.test.sshRefusal",
              cwd,
              args: ["fetch", "origin"],
              env: { LC_ALL: "C", GIT_SSH_COMMAND: fakeSsh },
            })
            .pipe(Effect.flip);

          assert.deepInclude(error, { reason: expectedReason });
          assert.include(error.message, expectedText);
        }),
    );

    it.effect("does not read a filesystem permission error as an ssh refusal", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
        const fakeSsh = pathService.join(parent, "fake-ssh");
        yield* writeTextFile(
          parent,
          "fake-ssh",
          '#!/bin/sh\necho "fatal: cannot open backup file: Permission denied (os error 13)" >&2\nexit 255\n',
        );
        yield* fileSystem.chmod(fakeSsh, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.osPermission",
            cwd,
            args: ["fetch", "origin"],
            env: { LC_ALL: "C", GIT_SSH_COMMAND: fakeSsh },
          })
          .pipe(Effect.flip);

        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("reads a hook-declined push from git's rejection line, not the hook's output", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const remote = pathService.join(parent, "origin.git");
        const cwd = pathService.join(parent, "work");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["init", "--bare", remote]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        const preReceive = pathService.join(remote, "hooks", "pre-receive");
        yield* writeTextFile(
          remote,
          "hooks/pre-receive",
          '#!/bin/sh\necho "authentication failed" >&2\necho "Permission denied (publickey)." >&2\necho "Host key verification failed." >&2\nexit 1\n',
        );
        yield* fileSystem.chmod(preReceive, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.remoteHookOutput",
            cwd,
            args: ["push", "origin", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, { reason: "push_rejected_by_remote" });
        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("leaves a tag collision unclassified rather than calling it a path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["tag", "v1"]);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.tagCollision",
            cwd,
            args: ["tag", "v1"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
        assert.notInclude(error.message, "(path_already_exists)");
      }),
    );

    it.effect("keeps line callbacks flowing past the output cap when asked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const lines: Array<string> = [];
        const result = yield* driver.execute({
          operation: "GitVcsDriver.test.callbacksPastCap",
          cwd,
          args: [
            "-c",
            'alias.spew=!for i in $(seq 1 128); do printf "é%03d\\n" $i >&2; done; echo fatal: last line >&2',
            "spew",
          ],
          maxOutputBytes: 512,
          appendTruncationMarker: true,
          keepLineCallbacksAfterTruncation: true,
          progress: { onStderrLine: (line) => Effect.sync(() => void lines.push(line)) },
        });

        assert.isTrue(result.stderrTruncated);
        assert.isAtMost(result.stderr.length, 600);
        assert.equal(lines.length, 129);
        assert.equal(lines[0], "é001");
        assert.equal(lines[127], "é128");
        assert.equal(lines.at(-1), "fatal: last line");
        assert.isFalse(lines.some((line) => line.includes("\uFFFD")));
      }),
    );

    it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const [localStatus, remoteStatus, refs] = yield* Effect.all([
          driver.statusDetails(cwd),
          driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
          driver.listRefs({ cwd }),
        ]);

        assert.equal(localStatus.isRepo, false);
        assert.equal(remoteStatus.isRepo, false);
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );
  });

  describe("review diff previews", () => {
    it.effect("loads repository-relative files from a nested project directory", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature/nested"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "committed\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "nested file"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "changed\n");
        yield* writeTextFile(cwd, "untracked.txt", "new\n");
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const nestedCwd = path.join(cwd, "nested");
        const preview = yield* driver.getReviewDiffPreview({
          cwd: nestedCwd,
          baseRef: initialBranch,
        });
        assert.equal(
          preview.sources.find((source) => source.kind === "working-tree")!.files!.length,
          2,
        );
        for (const source of preview.sources) {
          for (const file of source.files ?? []) {
            const scoped = yield* driver.getReviewDiffPreview({
              cwd: nestedCwd,
              baseRef: initialBranch,
              file: { path: file.path, previousPath: file.previousPath, sourceKind: source.kind },
            });
            const patch = scoped.sources.find((item) => item.kind === source.kind)!;
            assert.deepStrictEqual(patch.files, [file]);
            assert.include(patch.diff, `b/${file.path}`);
          }
        }
      }),
    );

    it.effect("reads complete tracked and untracked manifests beyond 1 MB", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const mergeBase = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "untracked.txt", "untracked content\n");
        const paths = Array.from({ length: 5000 }, (_, index) => `${"a".repeat(220)}-${index}.txt`);
        const stats = paths.map((path) => `1\t0\t${path}\0`).join("");
        const untracked = [...paths, "untracked.txt"].join("\0") + "\0";
        assert.isAbove(stats.length, 1024 * 1024);
        assert.isAbove(untracked.length, 1024 * 1024);
        let readLargeUntracked = false;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) {
            if (command.args.includes("--numstat") && command.args.includes(mergeBase)) {
              return Effect.succeed(makeSuccessfulHandle(stats));
            }
            if (command.args.includes("ls-files") && command.args.includes("--others")) {
              return Effect.succeed(makeSuccessfulHandle(readLargeUntracked ? untracked : ""));
            }
          }
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const branch = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
        });
        const files = branch.sources.find((source) => source.kind === "branch-range")!.files!;
        assert.equal(files.length, paths.length);
        assert.equal(files.at(-1)?.path, paths.at(-1));
        assert.equal(
          files.reduce((total, file) => total + file.additions, 0),
          paths.length,
        );
        readLargeUntracked = true;
        const dirty = yield* driver.getReviewDiffPreview({
          cwd,
          file: { path: "untracked.txt", previousPath: null, sourceKind: "working-tree" },
        });
        const source = dirty.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(source.files, [
          { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(source.diff, "+untracked content");
      }),
    );

    it.effect("propagates patch failures instead of reporting an empty complete diff", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", "changed\n");
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.includes("--patch")
            ? Effect.succeed(makeNonRepositoryHandle())
            : delegate.spawn(command),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const result = yield* driver.getReviewDiffPreview({ cwd }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure.operation, "GitVcsDriver.getReviewDiffPreview.patch");
        }
      }),
    );

    it.effect("drops an unterminated path from truncated NUL-separated git output", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0partial",
          stdoutTruncated: true,
        });

        assert.deepStrictEqual(paths, ["complete.txt"]);
      }),
    );

    it.effect("keeps a/ and b/ patch prefixes when the repository disables them", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "diff.noprefix", "true"]);
        yield* git(cwd, ["config", "diff.mnemonicPrefix", "true"]);
        yield* git(cwd, ["checkout", "-b", "feature/noprefix"]);
        yield* writeTextFile(cwd, "README.md", "# committed change\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "committed change"]);
        yield* writeTextFile(cwd, "README.md", "# dirty change\n");
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");

        const preview = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });

        const workingTree = preview.sources.find((source) => source.kind === "working-tree")?.diff;
        const branchRange = preview.sources.find((source) => source.kind === "branch-range")?.diff;
        assert.include(workingTree, "diff --git a/README.md b/README.md");
        assert.include(workingTree, "+++ b/untracked.txt");
        assert.include(branchRange, "diff --git a/README.md b/README.md");
      }),
    );

    it.effect("keeps untracked filenames with pathspec magic in the review", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, ":(exclude)after.ts", "literal pathspec contents\n");
        yield* writeTextFile(cwd, "ordinary.ts", "ordinary contents\n");
        const indexBefore = yield* git(cwd, ["ls-files", "--stage"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "+literal pathspec contents");
        assert.include(diff, "+ordinary contents");
        const scoped = yield* driver.getReviewDiffPreview({
          cwd,
          file: {
            path: ":(exclude)after.ts",
            previousPath: null,
            sourceKind: "working-tree",
          },
        });
        const scopedSource = scoped.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(scopedSource.files, [
          { path: ":(exclude)after.ts", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(scopedSource.diff, "+literal pathspec contents");
        assert.notInclude(scopedSource.diff, "ordinary.ts");
        assert.strictEqual(yield* git(cwd, ["ls-files", "--stage"]), indexBefore);
      }),
    );

    it.effect("detects an unstaged rename with edits without mutating a split index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "before.ts", "one\ntwo\nthree\nfour\nfive\n");
        yield* git(cwd, ["add", "before.ts"]);
        yield* git(cwd, ["commit", "-m", "add source file"]);
        yield* git(cwd, ["config", "core.splitIndex", "true"]);
        yield* git(cwd, ["config", "splitIndex.sharedIndexExpire", "now"]);
        yield* git(cwd, ["update-index", "--split-index"]);
        const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
        const indexHashBefore = yield* git(cwd, ["hash-object", indexPath]);
        const gitDirValue = yield* git(cwd, ["rev-parse", "--git-dir"]);
        const gitDir = pathService.isAbsolute(gitDirValue)
          ? gitDirValue
          : pathService.resolve(cwd, gitDirValue);
        const sharedIndexesBefore = (yield* fileSystem.readDirectory(gitDir))
          .filter((entry) => entry.startsWith("sharedindex."))
          .sort();
        yield* fileSystem.rename(
          pathService.join(cwd, "before.ts"),
          pathService.join(cwd, "after.ts"),
        );
        yield* writeTextFile(cwd, "after.ts", "one\ntwo\nTHREE\nfour\nfive\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";
        const indexHashAfter = yield* git(cwd, ["hash-object", indexPath]);
        const sharedIndexesAfter = (yield* fileSystem.readDirectory(gitDir))
          .filter((entry) => entry.startsWith("sharedindex."))
          .sort();

        const source = preview.sources.find((candidate) => candidate.kind === "working-tree")!;
        assert.deepStrictEqual(source.files, [
          { path: "after.ts", previousPath: "before.ts", additions: 1, deletions: 1 },
        ]);
        const scoped = yield* driver.getReviewDiffPreview({
          cwd,
          file: { path: "after.ts", previousPath: "before.ts", sourceKind: "working-tree" },
        });
        const scopedSource = scoped.sources.find((candidate) => candidate.kind === "working-tree")!;
        assert.deepStrictEqual(scopedSource.files, source.files);
        assert.equal(scopedSource.diff, diff);
        assert.include(diff, "rename from before.ts");
        assert.include(diff, "rename to after.ts");
        assert.include(diff, "-three");
        assert.include(diff, "+THREE");
        assert.strictEqual(diff.match(/^diff --git /gm)?.length, 1);
        assert.strictEqual(indexHashAfter, indexHashBefore);
        assert.deepStrictEqual(sharedIndexesAfter, sharedIndexesBefore);
      }),
    );

    it.effect("keeps tracked changes visible when untracked discovery fails", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const failingLsFilesSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) {
            return Effect.die("expected a standard Git command");
          }
          return command.args[0] === "ls-files" && command.args[1] === "--others"
            ? Effect.succeed(makeNonRepositoryHandle())
            : delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingLsFilesSpawner),
          Effect.provide(layerServerConfig),
        );
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd).pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
        );
        yield* writeTextFile(cwd, "README.md", "# tracked change\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "-# test");
        assert.include(diff, "+# tracked change");
      }),
    );

    it.effect("preserves a staged deletion when the removed path still exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "removed.txt", "remove me\n");
        yield* git(cwd, ["add", "removed.txt"]);
        yield* git(cwd, ["commit", "-m", "add removable file"]);
        yield* git(cwd, ["rm", "--cached", "removed.txt"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "deleted file mode");
        assert.include(diff, "-remove me");
        assert.notInclude(diff, "new file mode");
      }),
    );

    it.effect.each([false, true])(
      "keeps the preceding second cached in review previews (split: %s)",
      (splitIndex) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, ".gitattributes", "stable.txt filter=probe\n");
          yield* writeTextFile(cwd, "stable.txt", "unchanged\n");
          yield* writeTextFile(
            cwd,
            ".git/filter.cjs",
            'require("node:fs").appendFileSync(".git/filter-runs", "read\\n"); process.stdin.pipe(process.stdout);',
          );
          yield* git(cwd, ["config", "filter.probe.clean", "node .git/filter.cjs"]);
          yield* fs.utimes(path.join(cwd, "stable.txt"), 1_699_999_999.5, 1_699_999_999.5);
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "cache stable file"]);
          if (splitIndex) yield* git(cwd, ["update-index", "--split-index"]);
          const indexPath = path.join(cwd, ".git", "index");
          yield* fs.utimes(indexPath, 1_700_000_000, 1_700_000_000);
          const originalIndex = yield* fs.readFile(indexPath);
          const originalMtime = (yield* fs.stat(indexPath)).mtime;
          yield* writeTextFile(cwd, ".git/filter-runs", "");
          yield* writeTextFile(cwd, "untracked.txt", "new\n");
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          assert.deepStrictEqual(
            preview.sources.find((source) => source.kind === "working-tree")!.files,
            [{ path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 }],
          );
          assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".git/filter-runs")), "");
          assert.deepStrictEqual(yield* fs.readFile(indexPath), originalIndex);
          assert.deepStrictEqual((yield* fs.stat(indexPath)).mtime, originalMtime);
        }),
    );

    it.effect.each([
      [1_700_000_000, false],
      [1_700_000_000.9999, false],
      [1_700_000_000, true],
      [1_700_000_000.9999, true],
    ] as const)(
      "preserves same-size edits with a racy review index (%s, split: %s)",
      ([timestamp, splitIndex]) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const filePath = path.join(cwd, "tracked.txt");
          const indexPath = path.join(cwd, ".git", "index");
          yield* git(cwd, ["config", "core.trustctime", "false"]);
          yield* writeTextFile(cwd, "tracked.txt", "before\n");
          yield* fileSystem.utimes(filePath, timestamp, timestamp);
          yield* git(cwd, ["add", "tracked.txt"]);
          yield* git(cwd, ["commit", "-m", "record racy file"]);
          if (splitIndex) yield* git(cwd, ["update-index", "--split-index"]);
          yield* fileSystem.utimes(indexPath, timestamp, timestamp);
          const originalIndex = yield* fileSystem.readFile(indexPath);
          const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
          yield* writeTextFile(cwd, "tracked.txt", "after!\n");
          yield* fileSystem.utimes(filePath, timestamp, timestamp);
          yield* writeTextFile(cwd, "untracked.txt", "new\n");

          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
          assert.deepStrictEqual(dirty.files, [
            { path: "tracked.txt", previousPath: null, additions: 1, deletions: 1 },
            { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
          ]);
          assert.include(dirty.diff, "-before");
          assert.include(dirty.diff, "+after!");
          assert.deepStrictEqual(yield* fileSystem.readFile(indexPath), originalIndex);
          assert.deepStrictEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
        }),
    );

    it.effect("keeps complete stats for files beyond the combined patch limit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const largeContents = "a long line of changed content for the diff preview\n".repeat(4000);
        yield* git(cwd, ["checkout", "-b", "feature/large"]);
        yield* writeTextFile(cwd, "a-large.txt", largeContents);
        yield* writeTextFile(cwd, "z-last.txt", "last file\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "large change"]);
        yield* writeTextFile(cwd, "a-large.txt", largeContents.replaceAll("changed", "updated"));
        yield* writeTextFile(cwd, "z-last.txt", "last file updated\n");
        yield* writeTextFile(cwd, "untracked.txt", largeContents);

        const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        const branch = preview.sources.find((source) => source.kind === "branch-range")!;
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.isTrue(branch.truncated);
        assert.isTrue(dirty.truncated);
        assert.notInclude(branch.diff, "z-last.txt");
        for (const source of [branch, dirty]) {
          for (const file of source.files ?? []) {
            const individual = yield* driver.getReviewDiffPreview({
              cwd,
              baseRef: initialBranch,
              file: { path: file.path, previousPath: file.previousPath, sourceKind: source.kind },
            });
            const patch = individual.sources.find((candidate) => candidate.kind === source.kind)!;
            assert.isFalse(patch.truncated);
            assert.deepStrictEqual(patch.files, [file]);
            assert.include(patch.diff, `b/${file.path}`);
            assert.isEmpty(
              individual.sources.find((candidate) => candidate.kind !== source.kind)!.diff,
            );
          }
        }

        assert.deepStrictEqual(branch.files, [
          { path: "a-large.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "untracked.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "z-last.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.deepStrictEqual(dirty.files, [
          { path: "a-large.txt", previousPath: null, additions: 4000, deletions: 4000 },
          { path: "untracked.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "z-last.txt", previousPath: null, additions: 1, deletions: 1 },
        ]);
      }),
    );

    it.effect("preserves renames, unusual paths, modes, and binary statistics", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "mode-only.sh", "echo unchanged\n");
        yield* git(cwd, ["add", "mode-only.sh"]);
        yield* git(cwd, ["commit", "-m", "add executable candidate"]);
        yield* git(cwd, ["checkout", "-b", "feature/paths"]);
        yield* git(cwd, ["mv", "README.md", "renamed.md"]);
        yield* writeTextFile(cwd, "[literal].txt", "literal\n");
        yield* writeTextFile(cwd, " leading.txt", "whitespace path\n");
        yield* writeTextFile(cwd, "l.txt", "other\n");
        yield* writeTextFile(cwd, "binary.dat", "binary\0data");
        if ((yield* HostProcess.Platform) !== "win32") {
          yield* writeTextFile(cwd, "tab\tand\nnewline.txt", "unusual path\n");
        }
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["update-index", "--chmod=+x", "mode-only.sh"]);
        yield* git(cwd, ["commit", "-m", "rename and add files"]);
        const preview = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
        });
        const branch = preview.sources.find((source) => source.kind === "branch-range")!;
        for (const path of ["renamed.md", "[literal].txt", " leading.txt", "mode-only.sh"]) {
          const stat = branch.files!.find((file) => file.path === path)!;
          const request = yield* Schema.decodeEffect(ReviewDiffPreviewInput)({
            cwd,
            baseRef: initialBranch,
            file: { path, previousPath: stat.previousPath, sourceKind: "branch-range" },
          });
          const result = yield* driver.getReviewDiffPreview(request);
          const scoped = result.sources.find((source) => source.kind === "branch-range")!;
          assert.deepStrictEqual(scoped.files, [stat]);
          assert.notInclude(scoped.diff, "b/l.txt");
          if (path === "renamed.md") assert.include(scoped.diff, "rename from README.md");
          if (path === "mode-only.sh") {
            assert.include(scoped.diff, "old mode 100644");
            assert.include(scoped.diff, "new mode 100755");
          }
        }
        assert.include(branch.diff, "rename from README.md");
        assert.include(branch.diff, "rename to renamed.md");
        assert.deepInclude(branch.files ?? [], {
          path: "renamed.md",
          previousPath: "README.md",
          additions: 0,
          deletions: 0,
        });
        assert.deepInclude(branch.files ?? [], {
          path: "binary.dat",
          previousPath: null,
          additions: 0,
          deletions: 0,
        });
        if ((yield* HostProcess.Platform) !== "win32") {
          assert.deepInclude(branch.files ?? [], {
            path: "tab\tand\nnewline.txt",
            previousPath: null,
            additions: 1,
            deletions: 0,
          });
        }
      }),
    );

    it.effect("reports staged and untracked changes before the first commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(dirty.files, [
          { path: "staged.txt", previousPath: null, additions: 1, deletions: 0 },
          { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(dirty.diff, "b/staged.txt");
        assert.include(dirty.diff, "b/untracked.txt");
      }),
    );

    it.effect("loads full file contents for working-tree diff expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "nested/.keep", "");
        yield* writeTextFile(cwd, "README.md", "# changed\nunchanged context\n");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(pathService.join(cwd, "nested")),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# changed\nunchanged context\n");
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

  describe("repository status", () => {
    it.effect("does not open a project folder laid out as a bare repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        // Plain files a project save or a clone can hold. Git discovers them as a bare repository.
        const planted = pathService.join(cwd, "planted");
        yield* writeTextFile(planted, "HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(planted, "objects/info/keep", "");
        yield* writeTextFile(planted, "refs/heads/keep", "");
        yield* writeTextFile(
          planted,
          "config",
          '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "echo ran >> fsmonitor-runs; false"\n',
        );

        yield* Effect.exit(driver.statusDetailsLocal(planted));
        assert.isFalse(yield* fileSystem.exists(pathService.join(planted, "fsmonitor-runs")));
        assert.isTrue((yield* driver.statusDetailsLocal(cwd)).isRepo);
      }),
    );

    it.effect("reads Changes totals without minimizing and keeps review diffs minimal", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "diff.algorithm", "myers"]);
        // Repeated lines make the default and minimal algorithms choose different edits.
        const lines = Array.from({ length: 2000 }, (_, index) => index);
        yield* writeTextFile(
          cwd,
          "repeated.txt",
          lines.map((index) => `${(index ^ (index >> 3)) % 16}\n`).join(""),
        );
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "repeated lines"]);
        yield* git(cwd, ["checkout", "-b", "feature/totals"]);
        yield* writeTextFile(
          cwd,
          "repeated.txt",
          lines.map((index) => `${(index ^ (index >> 5)) % 16}\n`).join(""),
        );
        const defaultStat = yield* git(cwd, ["diff", "--numstat", "HEAD", "--"]);
        const minimalStat = yield* git(cwd, ["diff", "--minimal", "--numstat", "HEAD", "--"]);
        assert.notEqual(defaultStat, minimalStat);
        const [insertions, deletions] = defaultStat.split("\t");
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: initialBranch,
          insertions: Number(insertions),
          deletions: Number(deletions),
        });

        const [additions, removals] = minimalStat.split("\t");
        const minimalPatch = yield* git(cwd, [
          "diff",
          "--minimal",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "HEAD",
          "--",
        ]);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        for (const source of preview.sources) {
          assert.deepStrictEqual(source.files, [
            {
              path: "repeated.txt",
              previousPath: null,
              additions: Number(additions),
              deletions: Number(removals),
            },
          ]);
          assert.strictEqual(source.diff.trim(), minimalPatch);
        }
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "lists the real repository through a symlink when a decoy repo occupies the lexical common dir",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const sandbox = yield* makeTmpDir("git-symlink-subdir-");
          yield* initRepoWithCommit(sandbox);
          yield* git(sandbox, ["branch", "-M", "decoy-only"]);
          const repo = pathService.join(sandbox, "repo");
          const link = pathService.join(sandbox, "nest", "link");
          yield* fileSystem.makeDirectory(pathService.join(repo, "sub", "dir"), {
            recursive: true,
          });
          yield* fileSystem.makeDirectory(pathService.dirname(link), { recursive: true });
          yield* fileSystem.symlink(pathService.join(repo, "sub", "dir"), link);

          yield* initRepoWithCommit(repo);
          yield* git(repo, ["checkout", "-b", "real-only"]);

          // The decoy must exist before the first lookup, which caches repository paths.
          const refs = yield* (yield* GitVcsDriver.GitVcsDriver).listRefs({ cwd: link });
          assert.isTrue(refs.isRepo);
          assert.isFalse(refs.refs.some((ref) => ref.name === "decoy-only"));
          assert.isTrue(refs.refs.some((ref) => ref.name === "real-only"));
        }),
    );

    it.effect("reads Changes totals with untracked files when requested", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/totals"]);
        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
        yield* git(cwd, ["commit", "-am", "commit edit"]);
        yield* writeTextFile(cwd, "nested/untracked.txt", "one\ntwo\n");

        const status = yield* driver.statusDetailsLocal(pathService.join(cwd, "nested"), {
          includeBranchChanges: true,
        });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: "main",
          insertions: 3,
          deletions: 0,
        });
        assert.isUndefined((yield* driver.statusDetailsLocal(cwd)).branchChanges);
      }),
    );

    it.effect("Changes compares the default branch with its tracking upstream, not origin", () =>
      Effect.gen(function* () {
        // `origin` is a fork whose main is behind; the checkout tracks the
        // canonical repository through a second remote (#15314).
        const canonical = yield* makeTmpDir();
        yield* initRepoWithCommit(canonical);
        yield* git(canonical, ["branch", "-M", "main"]);
        const fork = yield* makeTmpDir();
        yield* git(fork, ["clone", "--quiet", canonical, "."]);
        yield* writeTextFile(canonical, "canonical.txt", "one\ntwo\nthree\n");
        yield* git(canonical, ["add", "canonical.txt"]);
        yield* git(canonical, ["commit", "-m", "canonical moves ahead"]);

        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["init", "-b", "main"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", canonical]);
        yield* git(cwd, ["fetch", "--quiet", "--all"]);
        yield* git(cwd, ["reset", "--hard", "--quiet", "upstream/main"]);
        yield* git(cwd, ["branch", "--set-upstream-to=upstream/main", "main"]);

        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: "upstream/main",
          insertions: 0,
          deletions: 0,
        });
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, "upstream/main");
        assert.deepStrictEqual(changes.files, []);

        // Without an upstream the primary remote's copy stays the base.
        yield* git(cwd, ["branch", "--unset-upstream", "main"]);
        const untracked = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(untracked.branchChanges, {
          baseRef: "origin/main",
          insertions: 3,
          deletions: 0,
        });
      }),
    );

    it.effect(
      "counts many untracked files exactly while collapsing their directory in status",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(cwd, ["checkout", "-b", "feature/many-untracked"]);
          yield* Effect.forEach(
            Array.from({ length: 1_001 }, (_, index) => `bulk/${index}.txt`),
            (file) => writeTextFile(cwd, file, "one\ntwo\n"),
            { concurrency: 32, discard: true },
          );

          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, {
            baseRef: "main",
            insertions: 2_002,
            deletions: 0,
          });
          assert.deepStrictEqual(
            status.workingTree.files.map((file) => file.path),
            ["bulk/"],
          );
        }),
    );

    it.effect("reports changes to a file named HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "HEAD", "first line\n");
        yield* git(cwd, ["add", "HEAD"]);
        yield* git(cwd, ["commit", "-m", "add HEAD file"]);
        yield* writeTextFile(cwd, "HEAD", "first line\nsecond line\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.deepInclude(status.workingTree.files, {
          path: "HEAD",
          insertions: 1,
          deletions: 0,
        });
      }),
    );

    it.effect("reports renamed and non-ASCII files by paths that can be committed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "src/old.ts", "one\ntwo\nthree\n");
        yield* writeTextFile(cwd, "café notes.md", "draft\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add files"]);
        yield* git(cwd, ["mv", "src/old.ts", "src/new.ts"]);
        yield* writeTextFile(cwd, "src/new.ts", "one\ntwo\nthree\nfour\n");
        yield* writeTextFile(cwd, "café notes.md", "draft\nedit\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetails(cwd);

        assert.deepEqual(status.workingTree.files, [
          { path: "café notes.md", insertions: 1, deletions: 0 },
          { path: "src/new.ts", insertions: 1, deletions: 0 },
          { path: "src/old.ts", insertions: 0, deletions: 0 },
        ]);
        yield* driver.commit(cwd, "Commit selection", "", {
          stage: { filePaths: status.workingTree.files.map((file) => file.path) },
        });
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "");
      }),
    );

    it.effect("commits selected files from a nested project directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        // A root basename ending in whitespace catches a root lookup that trims Git's output.
        const cwd = path.join(yield* makeTmpDir(), "repo ");
        yield* (yield* FileSystem.FileSystem).makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "nested/tracked.txt", "one\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add nested file"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "one\ntwo\n");
        yield* writeTextFile(cwd, "nested/new.txt", "new\n");
        yield* writeTextFile(cwd, "README.md", "# test\nleft out\n");
        const nestedCwd = path.join(cwd, "nested");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetails(nestedCwd);

        assert.deepEqual(status.workingTree.files, [
          { path: "nested/new.txt", insertions: 0, deletions: 0 },
          { path: "nested/tracked.txt", insertions: 1, deletions: 0 },
          { path: "README.md", insertions: 1, deletions: 0 },
        ]);
        // The root is what the paths above are relative to, not the nested cwd, and it keeps
        // the trailing space so the resolved editor target is the file that exists.
        assert.equal(status.workingTree.rootPath, NodeFS.realpathSync.native(cwd));
        assert.equal(
          NodeFS.existsSync(path.join(status.workingTree.rootPath!, "nested", "new.txt")),
          true,
        );
        yield* driver.commit(nestedCwd, "Commit nested selection", "", {
          stage: { filePaths: ["nested/new.txt", "nested/tracked.txt"] },
        });
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "M README.md");
      }),
    );

    it.effect("reports the linked worktree as the root of a nested directory in it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const worktreePath = yield* makeTmpDir("git-vcs-driver-linked-");
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "nested/tracked.txt", "one\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add nested file"]);
        yield* git(cwd, ["worktree", "add", "-b", "feature/linked", worktreePath]);
        yield* writeTextFile(worktreePath, "nested/tracked.txt", "one\ntwo\n");
        yield* writeTextFile(worktreePath, "nested/new.txt", "new\n");
        const nestedCwd = (yield* Path.Path).join(worktreePath, "nested");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetails(nestedCwd);

        assert.deepEqual(status.workingTree.files, [
          { path: "nested/new.txt", insertions: 0, deletions: 0 },
          { path: "nested/tracked.txt", insertions: 1, deletions: 0 },
        ]);
        assert.equal(
          NodeFS.realpathSync.native(status.workingTree.rootPath!),
          NodeFS.realpathSync.native(worktreePath),
        );
      }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports remote status on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);

        const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }),
    );

    it.effect("can read cached remote divergence without fetching upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
          refreshUpstream: false,
        });
        const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

        assert.equal(cachedStatus.behindCount, 0);
        assert.equal(refreshedStatus.behindCount, 1);
      }),
    );

    it.effect("does not start Git auto-maintenance from background upstream fetches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["repack", "-d"]);
        yield* writeTextFile(cwd, "second.txt", "second\n");
        yield* git(cwd, ["add", "second.txt"]);
        yield* git(cwd, ["commit", "-m", "second commit"]);
        yield* git(cwd, ["push"]);
        yield* git(cwd, ["repack", "-d"]);
        yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
        yield* git(cwd, ["config", "gc.autoDetach", "false"]);
        yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
        const packCount = git(cwd, ["count-objects", "-v"]).pipe(
          Effect.map((stdout) => stdout.match(/^packs: (\d+)$/m)?.[1]),
        );
        assert.equal(yield* packCount, "2");

        yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(yield* packCount, "2");
      }),
    );

    it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* writeTextFile(cwd, "release.txt", "release\n");
        yield* git(cwd, ["add", "release.txt"]);
        yield* git(cwd, ["commit", "-m", "release commit"]);
        yield* git(cwd, ["push", "-u", "upstream", "release"]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/upstream/HEAD",
          "refs/remotes/upstream/release",
        ]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.branch, "release");
        assert.equal(status.upstreamRef, "upstream/release");
        assert.equal(status.isDefaultBranch, false);
      }),
    );

    it.effect("makes background upstream status fetches non-interactive", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = yield* pathService.fromFileUrl(
          new URL("./testing/GitVcsDriverCore.fixture.sh", import.meta.url),
        );
        const envKeys = [
          "GCM_INTERACTIVE",
          "GIT_ASKPASS",
          "GIT_SSH",
          "GIT_TERMINAL_PROMPT",
          "SSH_ASKPASS",
          "SSH_ASKPASS_REQUIRE",
          "T3_TEST_SSH_ASKPASS_LOG",
        ] as const;
        const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.GCM_INTERACTIVE = "always";
          process.env.GIT_ASKPASS = "git-askpass";
          process.env.GIT_TERMINAL_PROMPT = "1";
          process.env.SSH_ASKPASS = "ssh-askpass";
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

          assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
            "GCM_INTERACTIVE=never",
            "GIT_ASKPASS=",
            "GIT_TERMINAL_PROMPT=0",
            "SSH_ASKPASS=",
            "SSH_ASKPASS_REQUIRE=never",
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const previous = previousEnv.get(key);
                if (previous === undefined) {
                  delete process.env[key];
                } else {
                  process.env[key] = previous;
                }
              }
            }),
          ),
        );
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports combined staged and unstaged edits to the same file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* git(cwd, ["commit", "-m", "add feature"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n// line three\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        const file = status.workingTree.files.find((f) => f.path === "feature.ts");
        assert.ok(file);
        assert.equal(file.insertions, 2);
        assert.equal(file.deletions, 0);
      }),
    );

    it.effect("reports staged file counts on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "initial.ts", "// first file\n");
        yield* git(cwd, ["add", "initial.ts"]);

        const status = yield* driver.statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.workingTree.files.length, 1);
        const file = status.workingTree.files[0];
        if (file) {
          assert.equal(file.path, "initial.ts");
          assert.equal(file.insertions, 1);
        }
      }),
    );
  });

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

        // A lone "-" is still the previous checkout.
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
      }),
    );
  });

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
          yield* git(cwd, ["config", "branch.feature/parallel.gh-merge-base"]),
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
            yield* driver.readConfigValue(cwd, "branch.feature/revision.gh-merge-base"),
            null,
          );
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
            yield* driver.readConfigValue(cwd, "branch.feature/branch.gh-merge-base"),
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

    it.effect("checks out submodules in a new worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        // Git refuses `file:` submodule transports by default (CVE-2022-39253)
        // and ignores repo-level config for it, so a local fixture needs the
        // env allowance. Real submodules are https/ssh and need none of this.
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
        yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
        yield* git(submoduleRepo, ["add", "."]);
        yield* git(submoduleRepo, ["commit", "-m", "shared"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", submoduleRepo, "shared"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/submodules",
        });

        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
          true,
        );
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
        yield* git(cwd, ["commit", "-m", "add unreachable submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "broken-submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/broken-submodules",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(yield* fileSystem.exists(worktreePath), true);
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

    it.effect("still creates the worktree when the base-ref config is locked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "locked-config");
        yield* writeTextFile(cwd, ".git/config.lock", "");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/locked-config",
          baseRefName: initialBranch,
        });

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
          yield* driver.readConfigValue(worktreePath, "branch.feature/locked-config.gh-merge-base"),
          null,
        );
        assert.equal(yield* fileSystem.exists(pathService.join(cwd, ".git/config.lock")), true);
      }),
    );

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
        const head = yield* driver.fetchPullRequestHeadCommit({ cwd, prNumber: 7 });

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

  describe("remote operations", () => {
    it.effect("creates a worktree from the latest fetched remote commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const peer = yield* makeTmpDir("git-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["--git-dir=.", "symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "remote-change.txt", "remote\n");
        yield* git(peer, ["add", "remote-change.txt"]);
        yield* git(peer, ["commit", "-m", "remote change"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
        assert.notEqual(beforeFetch, remoteHead);

        yield* git(peer, ["push", "origin", "HEAD:refs/heads/unrelated"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemote({
          cwd,
          remoteName: "origin",
          refName: `origin/${initialBranch}`,
        });
        assert.isFalse(
          yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
        );

        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: initialBranch,
          }),
          true,
        );
        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: "local-only",
          }),
          false,
        );

        const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: initialBranch,
          fallbackRemoteName: "origin",
        });
        const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: `origin/${initialBranch}`,
          fallbackRemoteName: "origin",
        });

        assert.deepEqual(resolvedBase, {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.deepEqual(explicitlyResolvedBase, resolvedBase);
        assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-fetched-worktrees-"),
          "fetched-origin",
        );
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: resolvedBase.commitSha,
          newRefName: "t3code/fetched-origin",
          baseRefName: resolvedBase.remoteRefName,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(
          yield* git(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`]),
          remoteHead,
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.remote"),
          null,
        );
        const status = yield* driver.statusDetails(worktreePath);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);

        yield* driver.fetchRemote({ cwd, remoteName: "origin", refName: "local-only" });
        assert.isTrue(
          yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
        );
      }),
    );

    it.effect("fetches the selected worktree base for Changes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fork = yield* makeTmpDir("git-fork-");
        const source = yield* makeTmpDir("git-source-");
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "stable"]);
        yield* git(fork, ["init", "--bare"]);
        yield* git(source, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", source]);
        yield* git(cwd, ["push", "origin", "stable"]);
        yield* git(cwd, ["push", "-u", "upstream", "stable:release"]);
        const localHead = yield* git(cwd, ["rev-parse", "HEAD"]);

        yield* writeTextFile(cwd, "fork.txt", "fork-only work\n");
        yield* git(cwd, ["add", "fork.txt"]);
        yield* git(cwd, ["commit", "-m", "fork work"]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/release"]);
        yield* git(cwd, ["reset", "--hard", localHead]);

        // Advance the source without updating this checkout's tracking refs.
        yield* writeTextFile(cwd, "upstream.txt", "upstream-only work\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "source advance"]);
        const remoteHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(source, ["--git-dir=.", "fetch", cwd, "stable:refs/heads/release"]);
        yield* git(cwd, ["reset", "--hard", localHead]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const fetched = yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "stable" });
        assert.deepEqual(fetched, {
          commitSha: remoteHead,
          remoteRefName: "upstream/release",
        });
        yield* git(cwd, ["update-ref", "-d", "refs/remotes/upstream/release"]);
        assert.deepEqual(
          yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "upstream/release" }),
          { commitSha: remoteHead, remoteRefName: "upstream/release" },
        );
        yield* git(cwd, ["branch", "--unset-upstream", "stable"]);
        assert.deepEqual(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "stable" }), {
          commitSha: localHead,
          remoteRefName: "origin/stable",
        });
        assert.equal(yield* git(cwd, ["rev-parse", "stable"]), localHead);

        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "feature");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: fetched!.commitSha,
          newRefName: "feature/from-upstream",
          baseRefName: `refs/remotes/${fetched!.remoteRefName}`,
        });
        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        yield* writeTextFile(worktreePath, "feature.txt", "feature work\n");
        yield* git(worktreePath, ["add", "feature.txt"]);
        yield* git(worktreePath, ["commit", "-m", "feature work"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(changes.diff, "+feature work");
        assert.notInclude(changes.diff, "upstream-only work");
        const status = yield* driver.statusDetailsLocal(worktreePath, {
          includeBranchChanges: true,
        });
        assert.strictEqual(status.aheadCount, 1);
        assert.strictEqual(status.branchChanges?.insertions, 1);
        assert.strictEqual(status.branchChanges?.deletions, 0);
        // gh pr create consumes this setting verbatim as the hosted target branch.
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.feature/from-upstream.gh-merge-base"),
          "release",
        );
        assert.equal(changes.baseRef, "upstream/release");
      }),
    );

    it.effect("does not use a deleted remote worktree base's stale tracking commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", `${initialBranch}:release`]);
        yield* git(remote, ["--git-dir=.", "update-ref", "-d", "refs/heads/release"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.equal(
          yield* git(cwd, ["rev-parse", "refs/remotes/origin/release"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }));
        yield* git(cwd, ["remote", "remove", "origin"]);
        assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }));
      }),
    );

    it.effect("fails instead of falling back when the worktree base remote is unreachable", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", `${cwd}/missing.git`]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const error = yield* driver
          .fetchWorktreeBaseCommit({ cwd, refName: initialBranch })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
      }),
    );

    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect.each(["feature/push", "origin/feature/push"])(
      "publishes %s when the configured diff base already contains HEAD",
      (branch) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const originRemote = yield* makeTmpDir("git-origin-remote-");
          const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(originRemote, ["init", "--bare"]);
          yield* git(upstreamRemote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", originRemote]);
          yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
          yield* git(cwd, ["push", "origin", "main", "main:refs/heads/feature/push"]);
          yield* git(cwd, ["checkout", "--no-track", "-b", branch]);
          yield* writeTextFile(cwd, "feature.txt", "feature\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Add feature", "");
          yield* git(cwd, ["push", "upstream", "HEAD:refs/heads/main"]);
          yield* git(cwd, ["config", `branch.${branch}.gh-merge-base`, "upstream/main"]);

          const status = yield* driver.statusDetails(cwd);
          assert.equal(status.hasUpstream, false);
          assert.equal(status.aheadCount, 0);
          assert.equal(status.behindCount, 0);
          const head = yield* git(cwd, ["rev-parse", "HEAD"]);
          assert.notEqual(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            head,
          );

          const pushed = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(pushed, {
            status: "pushed",
            branch,
            upstreamBranch: "origin/feature/push",
            setUpstream: true,
          });
          assert.equal(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            head,
          );

          yield* git(cwd, ["branch", "--unset-upstream"]);
          const skipped = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(skipped, { status: "skipped_up_to_date", branch });

          yield* writeTextFile(cwd, "remote.txt", "remote update\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Advance publish branch", "");
          yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature/push"]);
          const publishedHead = yield* git(originRemote, [
            "--git-dir=.",
            "rev-parse",
            "refs/heads/feature/push",
          ]);
          yield* git(cwd, ["reset", "--hard", head]);
          const skippedBehindRemote = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(skippedBehindRemote, { status: "skipped_up_to_date", branch });
          assert.equal(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            publishedHead,
          );
        }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("publishes a branch tracking its base under its own name, not the base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const upstream = yield* makeTmpDir("git-upstream-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "dev"]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream work\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add upstream update", "");
        yield* git(cwd, ["push", "upstream", "dev"]);
        const upstreamDevSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/x", "upstream/dev"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "feature/x"]),
          "Add feature",
        );
        assert.equal(yield* git(remote, ["--git-dir=.", "rev-parse", "dev"]), devSha);
        assert.equal(yield* git(upstream, ["--git-dir=.", "rev-parse", "dev"]), upstreamDevSha);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/x",
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/x.gh-merge-base"), "dev");

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.equal(changes.baseRef, "upstream/dev");
      }),
    );

    it.effect("keeps a recorded merge base when publishing a tracked branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/y", "origin/main"]);
        yield* git(cwd, ["config", "branch.feature/y.gh-merge-base", "release/v2"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.gh-merge-base"),
          "release/v2",
        );
      }),
    );

    it.effect("still pushes a git-mangled tracking alias to its upstream head", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
        yield* git(cwd, ["push", "my-org/upstream", "main:effect-atom"]);
        yield* git(cwd, ["fetch", "my-org/upstream"]);
        yield* git(cwd, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "upstream/effect-atom",
        );
        yield* writeTextFile(cwd, "alias.txt", "alias\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add alias update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "upstream/effect-atom",
          upstreamBranch: "my-org/upstream/effect-atom",
          setUpstream: false,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "effect-atom"]),
          "Add alias update",
        );
      }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});

describe("Windows long path configuration", () => {
  const readGitConfig = Effect.fn("readGitConfig")(function* (
    platform: NodeJS.Platform,
    key: string,
  ) {
    const layer = GitVcsDriver.layer.pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
    );
    return yield* Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir("git-longpath-test-");
      const result = yield* driver.execute({
        operation: "GitVcsDriverTest.readGitConfig",
        cwd,
        args: ["config", "--get", key],
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "user.name",
          GIT_CONFIG_VALUE_0: "inherited-name",
          GIT_CONFIG_KEY_1: "core.longpaths",
          GIT_CONFIG_VALUE_1: "false",
          GIT_CONFIG_KEY_2: "user.name",
          GIT_CONFIG_VALUE_2: "outside-count",
        },
      });
      return result.stdout.trim();
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("enables long paths for every Git command on Windows", () =>
    Effect.gen(function* () {
      assert.equal(yield* readGitConfig("win32", "core.longpaths"), "true");
      assert.equal(yield* readGitConfig("win32", "user.name"), "inherited-name");
    }),
  );

  it("extends the per-command count when inherited and per-command casings differ", () => {
    assert.deepStrictEqual(
      windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: "0", git_config_count: "1" }),
      {
        GIT_CONFIG_COUNT: "2",
        git_config_count: "2",
        GIT_CONFIG_KEY_1: "core.longpaths",
        GIT_CONFIG_VALUE_1: "true",
      },
    );
  });

  it("reads only the exact count name outside Windows", () => {
    assert.deepStrictEqual(
      gitConfigEnv({ git_config_count: "3" }, "safe.bareRepository", "explicit", "linux"),
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.bareRepository",
        GIT_CONFIG_VALUE_0: "explicit",
      },
    );
  });

  it("appends after inherited entries, parsing the count as Git does", () => {
    for (const [count, next] of [
      [undefined, 0],
      ["", 0],
      ["0", 0],
      ["-0", 0],
      ["2", 2],
      [" 2", 2],
      ["+2", 2],
      ["02", 2],
    ] as const) {
      assert.deepStrictEqual(
        windowsLongPathConfigEnv("win32", count === undefined ? {} : { GIT_CONFIG_COUNT: count }),
        {
          GIT_CONFIG_COUNT: String(next + 1),
          [`GIT_CONFIG_KEY_${next}`]: "core.longpaths",
          [`GIT_CONFIG_VALUE_${next}`]: "true",
        },
        `GIT_CONFIG_COUNT=${JSON.stringify(count)}`,
      );
    }
  });

  // regression: #14917 Windows worktrees with long paths failed or stranded
  it("leaves a count Git would reject for Git to report", () => {
    for (const count of ["nope", "2x", "-1", "1.5", "  ", "1 "]) {
      assert.deepStrictEqual(
        windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: count }),
        {},
        `GIT_CONFIG_COUNT=${JSON.stringify(count)}`,
      );
    }
  });
});
