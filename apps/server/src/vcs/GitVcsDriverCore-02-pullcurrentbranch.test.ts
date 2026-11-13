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
  encodeGitCommandError,
  layerServerConfig,
  layerTest,
  makeNonRepositoryHandle,
  makeSuccessfulHandle,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
  withPaddedPull,
  cloneBehindRemote,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

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
          if (isPull) onPull?.(command.args.map(String));
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
        yield* git(cwd, ["tag", initialBranch]);
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
      ).pipe(
        Effect.provide(
          layerServerConfig.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
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
    ).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
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
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
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
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
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
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
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
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
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
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
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
        assert.equal(command.options.env?.LANGUAGE, "C");
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
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
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
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
it.effect("does not fetch for status when the branch tracks a local branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetches: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("fetch")) {
          fetches.push(command.args.map(String));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "feature", remote]);
      yield* git(cwd, ["branch", "feature/base"]);
      yield* git(cwd, ["checkout", "-b", "stacked", "--track", "feature/base"]);

      const status = yield* driver.statusDetailsRemote(cwd);

      assert.equal(status.upstreamRef, "feature/base");
      assert.deepStrictEqual(fetches, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);
