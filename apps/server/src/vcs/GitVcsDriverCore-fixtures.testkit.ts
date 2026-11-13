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

export const encodeGitCommandError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));

export const decodeVcsRef = Schema.decodeUnknownSync(VcsRef);

export const decodeVcsListRefsResult = Schema.decodeUnknownSync(VcsListRefsResult);

export const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});

export const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

export const makeNonRepositoryHandle = () =>
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

export const makeSuccessfulHandle = (stdout: string) =>
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

export const makeFailedHandle = (stderr: string) =>
  ChildProcessSpawner.makeHandle({
    ...makeNonRepositoryHandle(),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    stderr: Stream.encodeText(Stream.make(stderr)),
  });

// Releases the lock as soon as a matching git command fails on it, before the driver retries.

export const makeDriverReleasingLock = (
  matches: (args: ReadonlyArray<string>) => boolean,
  lockPath: string,
) =>
  Effect.gen(function* () {
    const failures = yield* Ref.make(0);
    const fileSystem = yield* FileSystem.FileSystem;
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const handle = yield* delegate.spawn(command);
        if (!ChildProcess.isStandardCommand(command) || !matches(command.args.map(String)))
          return handle;
        return ChildProcessSpawner.makeHandle({
          ...handle,
          exitCode: handle.exitCode.pipe(
            Effect.tap((exitCode) =>
              exitCode === 0
                ? Effect.void
                : Ref.update(failures, (count) => count + 1).pipe(
                    Effect.andThen(fileSystem.remove(lockPath, { force: true })),
                    Effect.orDie,
                  ),
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(layerServerConfig),
    );
    return { driver, failures };
  });

export const byteChunks = (text: string) =>
  Stream.fromIterable(Array.from(new TextEncoder().encode(text), (byte) => Uint8Array.of(byte)));

export const makeDriver = (output: { stdout?: string; stderr?: string }) =>
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

export const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

export const writeTextFile = (
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

export const makeReviewDiffFileContentsInput = (
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

export const git = (
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

export const initRepoWithCommit = (
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

export const withPaddedPull = (
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

export const cloneBehindRemote = Effect.gen(function* () {
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

export const remoteUrl = "https://user:token-123@git.example.invalid/org/secret-repo.git";

export const failedPush = `error: failed to push some refs to '${remoteUrl}'`;

export const leakedText = [
  "token-123",
  "secret-repo",
  "git.example.invalid",
  "private-branch",
  "workflow scope",
];

export const failWith = (stderr: string) => {
  const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeFailedHandle(stderr)));
  const layer = GitVcsDriver.layer.pipe(
    Layer.provide(layerServerConfig),
    Layer.provideMerge(
      Layer.merge(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
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

export const commitWithHooks = (hooks: Record<string, string>) =>
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

export const readGitConfig = Effect.fn("readGitConfig")(function* (
  platform: NodeJS.Platform,
  key: string,
) {
  const layer = GitVcsDriver.layer.pipe(
    Layer.provide(layerServerConfig),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
