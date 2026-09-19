import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError, VcsProcessExitError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const GitCaptureContractLayer = Layer.merge(
  GitContractLayer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

const makeCaptureStore = Effect.fn("test.makeCaptureStore")(function* (
  driver: VcsDriver.VcsDriver["Service"],
  cwd: string,
) {
  const repository = yield* driver.detectRepository(cwd);
  if (repository === null) return yield* Effect.die("Expected a test Git repository");
  const handle = { kind: repository.kind, repository, driver };
  return yield* CheckpointStore.make.pipe(
    Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, {
      get: () => Effect.succeed(driver),
      detect: () => Effect.succeed(handle),
      resolve: () => Effect.succeed(handle),
    }),
  );
});

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

const makeCheckpointFixture = Effect.fn("makeCheckpointFixture")(function* (
  driver: Effect.Success<ReturnType<typeof GitVcsDriver.makeVcsDriverShape>>,
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (args: ReadonlyArray<string>) =>
    driver.execute({ operation: "checkpoint-test", cwd, args });
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@test.com"]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "initial\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test");
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
  yield* git(["add", "."]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
  return { git, checkpointRef };
});

it.effect("checkpoint capture skips untracked nested repositories without a commit", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-unborn-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const nested = "scratch/empty [repo]";
    yield* git(["init", nested]);
    yield* git(["init", "another empty"]);
    yield* fileSystem.writeFileString(path.join(cwd, nested, "private.txt"), "nested\n");
    yield* git(["init", "committed"]);
    yield* git([
      "-C",
      "committed",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    const nestedHead = (yield* git(["-C", "committed", "rev-parse", "HEAD"])).stdout.trim();
    yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout, "new\n");
    assert.strictEqual((yield* git(["ls-tree", "-r", checkpointRef, "--", nested])).stdout, "");
    assert.strictEqual((yield* git(["ls-tree", checkpointRef, "--", "another empty"])).stdout, "");
    assert.strictEqual(
      (yield* git(["ls-tree", checkpointRef, "--", "committed"])).stdout,
      `160000 commit ${nestedHead}\tcommitted\n`,
    );
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(cwd, nested, "private.txt")),
      "nested\n",
    );
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("checkpoint recovery discovers nested HEAD independently of inherited GIT_DIR", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-git-dir-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.GIT_DIR;
        process.env.GIT_DIR = path.join(cwd, ".git");
        return previous;
      }),
      () => driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.GIT_DIR;
          else process.env.GIT_DIR = previous;
        }),
    );
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.strictEqual((yield* git(["ls-tree", "-r", checkpointRef, "--", "empty"])).stdout, "");
    assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("checkpoint capture still fails when a clean filter rejects a file", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-checkpoint-filter-failure-",
    });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* fileSystem.writeFileString(path.join(cwd, ".gitattributes"), "file.txt filter=reject\n");
    yield* git(["config", "filter.reject.clean", "false"]);
    yield* git(["config", "filter.reject.required", "true"]);
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    const result = yield* Effect.result(
      driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );

    assert.strictEqual(result._tag, "Failure");
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("checkpoint capture refuses a truncated nested repository listing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-truncated-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          liveProcess
            .run(input)
            .pipe(
              Effect.map((result) =>
                input.args.includes("--others") ? { ...result, stdoutTruncated: true } : result,
              ),
            ),
      }),
    );

    const result = yield* Effect.result(
      captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );

    assert.strictEqual(result._tag, "Failure");
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("checkpoint recovery refuses excessive candidates before probing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-recovery-cap-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty0"]);
    for (let i = 1; i < 65; i++)
      yield* fs.copy(path.join(cwd, "empty0"), path.join(cwd, `empty${i}`));
    const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
    let stageError: VcsProcessExitError | undefined;
    let nestedProbes = 0;
    let stageAttempts = 0;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.cwd !== cwd && input.args.includes("rev-parse")) nestedProbes++;
          if (input.args.includes("add") && input.args.includes("-A")) stageAttempts++;
          return liveProcess.run(input).pipe(
            Effect.tapError((error) => {
              if (error._tag === "VcsProcessExitError") stageError = error;
              return Effect.void;
            }),
          );
        },
      }),
    );
    const result = yield* Effect.result(
      captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );
    assert.strictEqual(nestedProbes, 0);
    assert.strictEqual(stageAttempts, 1);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure, stageError);
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect.each([
  { phase: "add", nestedRecovery: false, expireRecovery: false },
  { phase: "update-ref", nestedRecovery: false, expireRecovery: false },
  { phase: "update-ref", nestedRecovery: true, expireRecovery: false },
  { phase: "add", nestedRecovery: true, expireRecovery: false },
  { phase: "add", nestedRecovery: true, expireRecovery: true },
])(
  "checkpoint handles a $phase lock with nestedRecovery=$nestedRecovery, expireRecovery=$expireRecovery",
  ({ phase, nestedRecovery, expireRecovery }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveRunner = yield* ProcessRunner.ProcessRunner;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-ref-race-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      if (nestedRecovery) yield* git(["init", "empty"]);
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
      const refLockPath = path.join(cwd, ".git", `${checkpointRef}.lock`);
      const failed = yield* Deferred.make<void>();
      const retryReached = yield* Deferred.make<void>();
      const allowRetry = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      const privateIndexes = new Set<string>();
      let racedAttempts = 0;
      let discoveries = 0;
      let stageError: VcsProcessExitError | undefined;
      const captureProcess = yield* VcsProcess.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            if (input.args.includes("--others")) discoveries += 1;
            if (input.env?.GIT_INDEX_FILE) privateIndexes.add(input.env.GIT_INDEX_FILE);
            const initialStage =
              phase === "add" &&
              nestedRecovery &&
              !input.args.some((arg) => arg.startsWith(":(exclude,literal)"));
            if (!input.args.includes(phase) || initialStage || ++racedAttempts !== 1) {
              return liveRunner.run(input);
            }
            const lockPath = phase === "add" ? `${input.env!.GIT_INDEX_FILE!}.lock` : refLockPath;
            return Effect.gen(function* () {
              yield* fs
                .makeDirectory(path.dirname(lockPath), { recursive: true })
                .pipe(Effect.orDie);
              yield* fs.writeFileString(lockPath, "concurrent ref writer").pipe(Effect.orDie);
              return yield* liveRunner.run(input).pipe(
                Effect.ensuring(fs.remove(lockPath).pipe(Effect.orDie)),
                Effect.tap(() => Deferred.succeed(failed, undefined)),
              );
            });
          },
        }),
      );
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            captureProcess.run(input).pipe(
              Effect.tapError((error) => {
                if (input.args.includes("add") && error._tag === "VcsProcessExitError")
                  stageError = error;
                return Effect.void;
              }),
            ),
        }),
      );
      const captureStore = yield* makeCaptureStore(captureDriver, cwd);
      const fiber = yield* captureStore.captureCheckpoint({ cwd, checkpointRef }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            Duration.toMillis(duration) === 75
              ? Deferred.succeed(retryReached, undefined).pipe(
                  Effect.andThen(Deferred.await(allowRetry)),
                )
              : clock.sleep(duration),
        }),
        Effect.exit,
        Effect.forkScoped,
      );
      yield* Deferred.await(failed);
      yield* Deferred.await(retryReached);
      if (expireRecovery) yield* TestClock.adjust("5 seconds");
      else yield* Deferred.succeed(allowRetry, undefined);
      const result = yield* Fiber.join(fiber);
      if (expireRecovery) {
        if (Exit.isSuccess(result))
          return yield* Effect.die("Expected the recovery deadline to expire");
        const error = Cause.findErrorOption(result.cause);
        assert.isTrue(error._tag === "Some");
        if (error._tag === "Some") assert.strictEqual(error.value, stageError);
      } else assert.isTrue(Exit.isSuccess(result));
      assert.strictEqual(racedAttempts, expireRecovery ? 1 : 2);
      assert.strictEqual(discoveries, nestedRecovery ? 1 : 0);
      assert.strictEqual(privateIndexes.size, 1);
      assert.strictEqual(
        yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }),
        !expireRecovery,
      );
      for (const index of privateIndexes) {
        assert.isFalse(yield* fs.exists(index));
        assert.isFalse(yield* fs.exists(`${index}.lock`));
      }
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(GitCaptureContractLayer)),
);

for (const blockedPhase of ["discovery", "probe", "retry"] as const) {
  it.effect(`checkpoint recovery has one deadline including ${blockedPhase}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-recovery-timeout-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      yield* git(["init", "empty"]);
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
      const entered = yield* Deferred.make<void>();
      const discovered = yield* Deferred.make<void>();
      let stageError: VcsProcessExitError | undefined;
      let privateIndex: string | undefined;
      let interrupted = false;
      let stagingAttempts = 0;
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            const staging = input.args.includes("add") && input.args.includes("-A");
            if (staging) {
              privateIndex = input.env?.GIT_INDEX_FILE;
              stagingAttempts += 1;
            }
            const block =
              (blockedPhase === "discovery" && input.args.includes("--others")) ||
              (blockedPhase === "probe" && input.cwd !== cwd && input.args.includes("rev-parse")) ||
              (blockedPhase === "retry" &&
                staging &&
                input.args.some((arg) => arg.startsWith(":(exclude,literal)")));
            if (block)
              return (
                blockedPhase === "retry"
                  ? fs
                      .writeFileString(
                        `${input.env!.GIT_INDEX_FILE!}.lock`,
                        "interrupted index write",
                      )
                      .pipe(Effect.orDie)
                  : Effect.void
              ).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              );
            return liveProcess.run(input).pipe(
              Effect.tap(() =>
                blockedPhase === "probe" && input.args.includes("--others")
                  ? Deferred.succeed(discovered, undefined).pipe(
                      Effect.andThen(Effect.sleep("3 seconds")),
                    )
                  : Effect.void,
              ),
              Effect.tapError((error) => {
                if (staging && error._tag === "VcsProcessExitError") stageError = error;
                return Effect.void;
              }),
            );
          },
        }),
      );
      const captureStore = yield* makeCaptureStore(captureDriver, cwd);
      const fiber = yield* captureStore
        .captureCheckpoint({ cwd, checkpointRef })
        .pipe(Effect.flip, Effect.forkScoped);
      if (blockedPhase === "probe") {
        yield* Deferred.await(discovered);
        yield* TestClock.adjust("3 seconds");
      }
      yield* Deferred.await(entered);
      yield* TestClock.adjust(blockedPhase === "probe" ? "2 seconds" : "5 seconds");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error, stageError);
      assert.strictEqual(stagingAttempts, blockedPhase === "retry" ? 2 : 1);
      assert.isTrue(interrupted);
      assert.isDefined(privateIndex);
      assert.isFalse(yield* fs.exists(privateIndex!));
      assert.isFalse(yield* fs.exists(`${privateIndex!}.lock`));
      assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
  );
}

it.effect("checkpoint recovery preserves interruption and removes the private index", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-recovery-interrupt-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const entered = yield* Deferred.make<void>();
    let privateIndex: string | undefined;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.args.includes("add") && input.args.includes("-A"))
            privateIndex = input.env?.GIT_INDEX_FILE;
          return input.args.includes("--others")
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : liveProcess.run(input);
        },
      }),
    );
    const fiber = yield* captureDriver.checkpoints
      .captureCheckpoint({ cwd, checkpointRef })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.isDefined(privateIndex);
    assert.isFalse(yield* fs.exists(privateIndex!));
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("checkpoint capture does not rerun clean filters for unchanged indexed files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-cache-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* fileSystem.writeFileString(
      path.join(cwd, ".gitattributes"),
      "stable.txt filter=probe\n",
    );
    yield* fileSystem.writeFileString(path.join(cwd, "stable.txt"), "unchanged\n");
    yield* fileSystem.writeFileString(
      path.join(cwd, ".git", "filter.cjs"),
      'require("node:fs").appendFileSync(".git/filter-runs", "read\\n"); process.stdin.pipe(process.stdout);',
    );
    yield* git(["config", "filter.probe.clean", "node .git/filter.cjs"]);
    yield* fileSystem.utimes(path.join(cwd, "stable.txt"), 1_700_000_000, 1_700_000_000);
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "record stable file"]);
    yield* fileSystem.writeFileString(path.join(cwd, ".git", "filter-runs"), "");
    yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "changed\n");
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, ".git", "filter-runs")), "");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "changed\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:stable.txt`])).stdout, "unchanged\n");
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

for (const nested of [false, true]) {
  for (const indexState of [
    "sparse",
    "flags",
    "manual-skip",
    "missing",
    "non-cone-missing",
  ] as const) {
    it.effect(
      `sparse checkpoint preserves two captures (nested=${nested}, index=${indexState})`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.makeVcsDriverShape();
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-sparse-" });
          const { git } = yield* makeCheckpointFixture(driver, cwd);
          const write = Effect.fn(function* (name: string, contents: string) {
            yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
            yield* fs.writeFileString(path.join(cwd, name), contents);
          });
          for (const name of [
            "scope/in/edit",
            "scope/in/delete",
            "scope/out/deep/absent",
            "scope/out/present",
            "elsewhere/file",
          ]) {
            yield* write(name, "original\n");
          }
          yield* git(["add", "."]);
          yield* git(["commit", "-m", "sparse fixture"]);
          yield* git([
            "sparse-checkout",
            "set",
            "--cone",
            "--sparse-index",
            "scope/in",
            "elsewhere",
          ]);
          if (indexState === "non-cone-missing")
            yield* git(["sparse-checkout", "set", "--no-cone", "/scope/in/", "/elsewhere/"]);
          yield* write("scope/in/edit", "staged\n");
          yield* write("elsewhere/file", "staged outside\n");
          yield* git(["add", "."]);
          if (indexState === "flags")
            yield* git(["update-index", "--assume-unchanged", "scope/in/delete"]);
          if (indexState === "manual-skip")
            yield* git(["update-index", "--skip-worktree", "scope/in/delete"]);
          yield* git(["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
          yield* write("scope/in/edit", "working\n");
          yield* write("scope/out/present", "modified skipped\n");
          yield* write("scope/out/new file", "new outside cone\n");
          yield* write("elsewhere/file", "working outside\n");
          yield* fs.remove(path.join(cwd, "scope/in/delete"));
          const indexPath = path.join(cwd, ".git/index");
          if (indexState.endsWith("missing")) yield* fs.remove(indexPath);
          const originalIndex = yield* fs
            .readFile(indexPath)
            .pipe(Effect.orElseSucceed(() => null));
          const captureCwd = nested ? path.join(cwd, "scope") : cwd;
          for (const turn of [1, 2]) {
            const ref = CheckpointRef.make(`refs/t3/checkpoints/sparse/${turn}`);
            if (turn === 2) {
              yield* write("scope/in/edit", "second\n");
              yield* fs.remove(path.join(cwd, "scope/out/new file"));
              yield* write("scope/out/second", "second addition\n");
            }
            const capture = driver.checkpoints.captureCheckpoint({
              cwd: captureCwd,
              checkpointRef: ref,
            });
            if (indexState === "non-cone-missing") {
              assert.strictEqual((yield* capture.pipe(Effect.flip))._tag, "VcsProcessExitError");
              assert.isFalse(
                yield* driver.checkpoints.hasCheckpointRef({ cwd: captureCwd, checkpointRef: ref }),
              );
              assert.isFalse(yield* fs.exists(indexPath));
              break;
            }
            yield* capture;
            for (const [name, content] of [
              ["scope/out/deep/absent", "original\n"],
              ["scope/out/present", "modified skipped\n"],
              ["scope/in/edit", turn === 1 ? "working\n" : "second\n"],
              ["elsewhere/file", nested ? "original\n" : "working outside\n"],
              [
                turn === 1 ? "scope/out/new file" : "scope/out/second",
                turn === 1 ? "new outside cone\n" : "second addition\n",
              ],
            ]) {
              assert.strictEqual((yield* git(["show", `${ref}:${name}`])).stdout, content);
            }
            const files = (yield* git(["ls-tree", "-rz", "--name-only", ref])).stdout.split("\0");
            assert.notInclude(files, "scope/in/delete");
            if (turn === 2) assert.notInclude(files, "scope/out/new file");
            assert.deepEqual(
              yield* fs.readFile(indexPath).pipe(Effect.orElseSucceed(() => null)),
              originalIndex,
            );
            assert.isFalse(yield* fs.exists(path.join(cwd, "scope/out/deep/absent")));
            assert.strictEqual(
              yield* fs.readFileString(path.join(cwd, "elsewhere/file")),
              "working outside\n",
            );
          }
        }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
    );
  }
}

it.effect("checkpoint capture keeps the legacy path when Git lacks add --sparse", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-legacy-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["sparse-checkout", "set", "--cone", "included"]);
    const originalIndex = yield* fs.readFile(path.join(cwd, ".git/index"));
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.args.includes("-h"))
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(129),
              stdout: "usage: git add",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          return liveProcess.run(
            input.args.includes("--sparse")
              ? {
                  ...input,
                  args: input.args.map((arg) =>
                    arg === "--sparse" ? "--unsupported-sparse" : arg,
                  ),
                }
              : input,
          );
        },
      }),
    );
    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git/index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

for (const indexMode of ["normal", "flags", "sparse"] as const) {
  it.effect(
    `checkpoint index inspection handles entries beyond the output cap (index=${indexMode})`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const liveProcess = yield* VcsProcess.VcsProcess;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-inspection-" });
        const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
        yield* fs.writeFileString(path.join(cwd, ".gitattributes"), "stable filter=probe\n");
        yield* fs.writeFileString(path.join(cwd, "stable"), "unchanged\n");
        yield* fs.writeFileString(path.join(cwd, "z-skipped"), "original\n");
        yield* fs.makeDirectory(path.join(cwd, "excluded"));
        yield* fs.writeFileString(path.join(cwd, "excluded/file"), "absent\n");
        yield* fs.writeFileString(
          path.join(cwd, ".git/filter.cjs"),
          'require("node:fs").appendFileSync(".git/reads", "read\\n"); process.stdin.pipe(process.stdout);',
        );
        yield* git(["config", "filter.probe.clean", "node .git/filter.cjs"]);
        yield* fs.utimes(path.join(cwd, "stable"), 1_700_000_000, 1_700_000_000);
        yield* git(["add", "."]);
        yield* git(["commit", "-m", "inspection fixture"]);
        if (indexMode === "flags") yield* git(["update-index", "--skip-worktree", "z-skipped"]);
        if (indexMode === "sparse")
          yield* git(["sparse-checkout", "set", "--cone", "--sparse-index", "included"]);
        yield* fs.writeFileString(path.join(cwd, "z-skipped"), "modified\n");
        yield* fs.writeFileString(path.join(cwd, ".git/reads"), "");
        const originalIndex = yield* fs.readFile(path.join(cwd, ".git/index"));
        const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
          Effect.provideService(VcsProcess.VcsProcess, {
            run: (input) =>
              liveProcess.run(
                input.args.includes("ls-files")
                  ? {
                      ...input,
                      maxOutputBytes: 8,
                      onStdoutChunk: (chunk) => {
                        for (let i = 0; i < chunk.length; i++)
                          input.onStdoutChunk?.(chunk.subarray(i, i + 1));
                      },
                    }
                  : input,
              ),
          }),
        );
        yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
        assert.strictEqual(
          (yield* git(["show", `${checkpointRef}:z-skipped`])).stdout,
          "modified\n",
        );
        if (indexMode !== "flags")
          assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".git/reads")), "");
        assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git/index")), originalIndex);
      }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
  );
}

for (const timestamp of [1_700_000_000, 1_700_000_000.9999]) {
  it.effect(
    `checkpoint capture preserves same-size edits with racy index timestamps (${timestamp})`,
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-racy-" });
        const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
        const filePath = path.join(cwd, "file.txt");
        const indexPath = path.join(cwd, ".git", "index");
        yield* git(["config", "core.trustctime", "false"]);
        yield* fileSystem.writeFileString(filePath, "before\n");
        yield* fileSystem.utimes(filePath, timestamp, timestamp);
        yield* git(["add", "file.txt"]);
        yield* git(["commit", "-m", "record racy file"]);
        yield* fileSystem.utimes(indexPath, timestamp, timestamp);
        const originalIndex = yield* fileSystem.readFile(indexPath);
        const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
        yield* fileSystem.writeFileString(filePath, "after!\n");
        yield* fileSystem.utimes(filePath, timestamp, timestamp);

        yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

        assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "after!\n");
        assert.deepEqual(yield* fileSystem.readFile(indexPath), originalIndex);
        assert.deepEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
      }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
  );
}
for (const nested of [false, true]) {
  for (const indexState of [
    "sparse",
    "flags",
    "manual-skip",
    "missing",
    "non-cone-missing",
  ] as const) {
    it.effect(
      `sparse checkpoint preserves two captures (nested=${nested}, index=${indexState})`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.makeVcsDriverShape();
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-sparse-" });
          const { git } = yield* makeCheckpointFixture(driver, cwd);
          const write = Effect.fn(function* (name: string, contents: string) {
            yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
            yield* fs.writeFileString(path.join(cwd, name), contents);
          });
          for (const name of [
            "scope/in/edit",
            "scope/in/delete",
            "scope/out/deep/absent",
            "scope/out/present",
            "elsewhere/file",
          ]) {
            yield* write(name, "original\n");
          }
          yield* git(["add", "."]);
          yield* git(["commit", "-m", "sparse fixture"]);
          yield* git([
            "sparse-checkout",
            "set",
            "--cone",
            "--sparse-index",
            "scope/in",
            "elsewhere",
          ]);
          if (indexState === "non-cone-missing")
            yield* git(["sparse-checkout", "set", "--no-cone", "/scope/in/", "/elsewhere/"]);
          yield* write("scope/in/edit", "staged\n");
          yield* write("elsewhere/file", "staged outside\n");
          yield* git(["add", "."]);
          if (indexState === "flags")
            yield* git(["update-index", "--assume-unchanged", "scope/in/delete"]);
          if (indexState === "manual-skip")
            yield* git(["update-index", "--skip-worktree", "scope/in/delete"]);
          yield* git(["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
          yield* write("scope/in/edit", "working\n");
          yield* write("scope/out/present", "modified skipped\n");
          yield* write("scope/out/new file", "new outside cone\n");
          yield* write("elsewhere/file", "working outside\n");
          yield* fs.remove(path.join(cwd, "scope/in/delete"));
          const indexPath = path.join(cwd, ".git/index");
          if (indexState.endsWith("missing")) yield* fs.remove(indexPath);
          const originalIndex = yield* fs
            .readFile(indexPath)
            .pipe(Effect.orElseSucceed(() => null));
          const captureCwd = nested ? path.join(cwd, "scope") : cwd;
          for (const turn of [1, 2]) {
            const ref = CheckpointRef.make(`refs/t3/checkpoints/sparse/${turn}`);
            if (turn === 2) {
              yield* write("scope/in/edit", "second\n");
              yield* fs.remove(path.join(cwd, "scope/out/new file"));
              yield* write("scope/out/second", "second addition\n");
            }
            const capture = driver.checkpoints.captureCheckpoint({
              cwd: captureCwd,
              checkpointRef: ref,
            });
            if (indexState === "non-cone-missing") {
              assert.strictEqual((yield* capture.pipe(Effect.flip))._tag, "VcsProcessExitError");
              assert.isFalse(
                yield* driver.checkpoints.hasCheckpointRef({ cwd: captureCwd, checkpointRef: ref }),
              );
              assert.isFalse(yield* fs.exists(indexPath));
              break;
            }
            yield* capture;
            for (const [name, content] of [
              ["scope/out/deep/absent", "original\n"],
              ["scope/out/present", "modified skipped\n"],
              ["scope/in/edit", turn === 1 ? "working\n" : "second\n"],
              ["elsewhere/file", nested ? "original\n" : "working outside\n"],
              [
                turn === 1 ? "scope/out/new file" : "scope/out/second",
                turn === 1 ? "new outside cone\n" : "second addition\n",
              ],
            ]) {
              assert.strictEqual((yield* git(["show", `${ref}:${name}`])).stdout, content);
            }
            const files = (yield* git(["ls-tree", "-rz", "--name-only", ref])).stdout.split("\0");
            assert.notInclude(files, "scope/in/delete");
            if (turn === 2) assert.notInclude(files, "scope/out/new file");
            assert.deepEqual(
              yield* fs.readFile(indexPath).pipe(Effect.orElseSucceed(() => null)),
              originalIndex,
            );
            assert.isFalse(yield* fs.exists(path.join(cwd, "scope/out/deep/absent")));
            assert.strictEqual(
              yield* fs.readFileString(path.join(cwd, "elsewhere/file")),
              "working outside\n",
            );
          }
        }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
    );
  }
}

it.effect("checkpoint capture preserves racy edits made after resetting the index", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-racy-reset-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const racyPath = path.join(cwd, "racy.txt");
    const indexPath = path.join(cwd, ".git", "index");
    const timestamp = 1_700_000_000;
    yield* git(["config", "core.trustctime", "false"]);
    yield* fileSystem.writeFileString(racyPath, "before\n");
    yield* fileSystem.utimes(racyPath, timestamp, timestamp);
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "record racy file"]);
    yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
    yield* git(["add", "file.txt"]);
    yield* fileSystem.utimes(indexPath, timestamp, timestamp);
    const originalIndex = yield* fileSystem.readFile(indexPath);
    const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: Effect.fn(function* (input: VcsProcess.VcsProcessInput) {
          const result = yield* liveProcess.run(input);
          if (input.args.includes("read-tree") && input.args.includes("--reset")) {
            yield* fileSystem.writeFileString(racyPath, "after!\n").pipe(Effect.orDie);
            yield* fileSystem.utimes(racyPath, timestamp, timestamp).pipe(Effect.orDie);
          }
          return result;
        }),
      }),
    );

    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:racy.txt`])).stdout, "after!\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "staged\n");
    assert.deepEqual(yield* fileSystem.readFile(indexPath), originalIndex);
    assert.deepEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

for (const nested of [false, true]) {
  for (const indexMode of ["normal", "flags", "split"] as const) {
    it.effect(
      `checkpoint index reuse preserves two turns (nested=${nested}, index=${indexMode})`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.makeVcsDriverShape();
          const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-turns-" });
          const { git } = yield* makeCheckpointFixture(driver, cwd);
          const write = (name: string, contents: string) =>
            fileSystem.writeFileString(path.join(cwd, name), contents);
          yield* fileSystem.makeDirectory(path.join(cwd, "scope"));
          for (const name of [
            "scope/staged",
            "scope/deleted",
            "scope/assumed",
            "scope/skipped",
            "outside",
          ]) {
            yield* write(name, "original\n");
          }
          yield* git(["add", "."]);
          yield* git(["commit", "-m", "initial scoped files"]);
          yield* write("scope/staged", "staged\n");
          yield* write("scope/new-deleted", "staged then deleted\n");
          yield* write("outside", "staged outside\n");
          yield* git(["add", "."]);
          if (indexMode === "flags") {
            yield* git(["update-index", "--assume-unchanged", "scope/assumed"]);
            yield* git(["update-index", "--skip-worktree", "scope/skipped"]);
          }
          if (indexMode === "split") {
            yield* git(["update-index", "--split-index"]);
          }
          const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));
          for (const name of ["scope/staged", "scope/assumed", "scope/skipped", "outside"]) {
            yield* write(name, "working\n");
          }
          yield* write("scope/new", "first\n");
          yield* fileSystem.remove(path.join(cwd, "scope/deleted"));
          yield* fileSystem.remove(path.join(cwd, "scope/new-deleted"));
          const captureCwd = nested ? path.join(cwd, "scope") : cwd;
          const first = CheckpointRef.make("refs/t3/checkpoints/turns/1");
          const second = CheckpointRef.make("refs/t3/checkpoints/turns/2");
          yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: first });
          for (const name of ["scope/staged", "scope/assumed", "scope/skipped"]) {
            assert.strictEqual((yield* git(["show", `${first}:${name}`])).stdout, "working\n");
          }
          assert.strictEqual(
            (yield* git(["show", `${first}:outside`])).stdout,
            nested ? "original\n" : "working\n",
          );
          const files = (yield* git(["ls-tree", "-r", "--name-only", first])).stdout.split("\n");
          assert.notInclude(files, "scope/deleted");
          assert.notInclude(files, "scope/new-deleted");
          assert.include(files, "scope/new");

          yield* write("scope/staged", "second\n");
          yield* fileSystem.remove(path.join(cwd, "scope/new"));
          yield* write("scope/second", "added in second turn\n");
          yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: second });
          assert.strictEqual(
            (yield* git(["diff", "--name-only", first, second])).stdout,
            "scope/new\nscope/second\nscope/staged\n",
          );
          assert.strictEqual((yield* git(["show", `${second}:scope/staged`])).stdout, "second\n");
          assert.strictEqual(
            (yield* git(["show", `${second}:scope/second`])).stdout,
            "added in second turn\n",
          );
          assert.deepEqual(
            yield* fileSystem.readFile(path.join(cwd, ".git", "index")),
            originalIndex,
          );
        }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
    );
  }
}

for (const indexState of ["missing", "invalid"] as const) {
  it.effect(`checkpoint capture falls back when the user index is ${indexState}`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-index-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const indexPath = path.join(cwd, ".git", "index");
      if (indexState === "missing") {
        yield* fileSystem.remove(indexPath);
      } else {
        yield* fileSystem.writeFileString(indexPath, "invalid index");
      }

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
      if (indexState === "missing") {
        assert.isFalse(yield* fileSystem.exists(indexPath));
      } else {
        assert.strictEqual(yield* fileSystem.readFileString(indexPath), "invalid index");
      }
    }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
  );
}

it.effect("restores empty checkpoints without changing paths outside the workspace", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const nested of [false, true]) {
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-empty-checkpoint-" });
      yield* runGit(root, ["init"]);
      yield* runGit(root, ["config", "user.email", "test@test.com"]);
      yield* runGit(root, ["config", "user.name", "Test"]);
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "original\n");
        yield* runGit(root, ["add", "."]);
      }
      yield* runGit(root, ["commit", "--allow-empty", "-m", "initial"]);
      const cwd = nested ? path.join(root, "nested") : root;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/empty");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "changed\n");
        yield* runGit(root, ["add", "outside.txt"]);
      }
      for (const staged of [false, true]) {
        const addedPath = path.join(cwd, "added.txt");
        yield* fileSystem.writeFileString(addedPath, "new\n");
        if (staged) yield* runGit(cwd, ["add", "added.txt"]);
        assert.isTrue(
          yield* driver.checkpoints.restoreCheckpoint({
            cwd,
            checkpointRef,
            fallbackToHead: false,
          }),
        );
        assert.isFalse(yield* fileSystem.exists(addedPath));
      }
      yield* fileSystem.writeFileString(
        path.join(root, ".git", "info", "exclude"),
        "ignored.txt\n",
      );
      yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "keep\n");
      yield* fileSystem.makeDirectory(path.join(cwd, "untracked"));
      yield* fileSystem.writeFileString(path.join(cwd, "untracked", "file.txt"), "remove\n");
      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "ignored.txt")), "keep\n");
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "untracked")));
      if (nested) {
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(root, "outside.txt")),
          "changed\n",
        );
        const staged = yield* driver.execute({
          operation: "test",
          cwd: root,
          args: ["diff", "--cached", "--name-only"],
        });
        assert.strictEqual(staged.stdout.trim(), "outside.txt");
      }
    }
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;
  let observedOutputMode: VcsProcess.VcsProcessInput["outputMode"];

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
      outputMode: "error",
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
    assert.strictEqual(observedOutputMode, "error");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              observedOutputMode = input.outputMode;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("GitVcsDriver flushes checkpoint objects and refs to disk before publishing them", () => {
  const observedArgs: ReadonlyArray<string>[] = [];

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.checkpoints.captureCheckpoint({
      cwd: "/repo",
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/turn/1"),
    });

    const writeCommands = ["add", "write-tree", "commit-tree", "update-ref"];
    const writes = observedArgs.filter((args) =>
      writeCommands.some((command) => args.includes(command)),
    );
    assert.strictEqual(writes.length, 4);
    for (const args of writes) {
      const command = args.findIndex((arg) => writeCommands.includes(arg));
      for (const setting of ["core.fsync=objects,reference", "core.fsyncMethod=fsync"]) {
        const index = args.indexOf(setting);
        assert.strictEqual(args[index - 1], "-c", args.join(" "));
        assert.isBelow(index, command);
      }
    }
    assert.deepStrictEqual(observedArgs.at(-1), [
      "-C",
      "/repo",
      "-c",
      "core.fsync=objects,reference",
      "-c",
      "core.fsyncMethod=fsync",
      "update-ref",
      "refs/t3/checkpoints/thread/turn/1",
      "commit0000",
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedArgs.push(input.args);
              const stdout = input.args.includes("write-tree")
                ? "tree0000\n"
                : input.args.includes("commit-tree")
                  ? "commit0000\n"
                  : input.args.includes("--git-common-dir")
                    ? ".git\n"
                    : "";
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout,
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect(
  "detectRepository distinguishes a confirmed absent repository from detection failures",
  () => {
    let revParseResult = { exitCode: 0, stdout: "", stderr: "" };
    const observedEnvs: NodeJS.ProcessEnv[] = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-detect-" });
      // Git's "not a git repository" fatal is the nonzero signature that
      // confirms the workspace has no usable repository.
      revParseResult = {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      };
      // Ambient Git bindings must not leak into detection: seeding them here
      // means a missing scrub surfaces as the seeded value, not an omission.
      const seededGitEnv = {
        GIT_DIR: "/foreign/.git",
        GIT_WORK_TREE: "/foreign",
        GIT_COMMON_DIR: "/foreign/.git",
      };
      const previousGitEnv = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
      };
      Object.assign(process.env, seededGitEnv);
      try {
        assert.isNull(yield* driver.detectRepository(cwd));
        // The diagnostic locale is pinned so translated fatals cannot evade
        // the signature match, and ambient Git bindings are scrubbed so
        // discovery always reflects the workspace itself.
        assert.equal(observedEnvs.at(-1)?.LC_ALL, "C");
        assert.isUndefined(observedEnvs.at(-1)?.GIT_DIR);
        assert.isUndefined(observedEnvs.at(-1)?.GIT_WORK_TREE);
        assert.isUndefined(observedEnvs.at(-1)?.GIT_COMMON_DIR);
        // A successful detection runs the root and common-dir probes — the
        // scrub applies to every detection subprocess, not just the first.
        observedEnvs.length = 0;
        revParseResult = { exitCode: 0, stdout: "true\n", stderr: "" };
        const detected = yield* driver.detectRepository(cwd);
        assert.isNotNull(detected);
        assert.equal(observedEnvs.length, 3);
        for (const env of observedEnvs) {
          assert.equal(env.LC_ALL, "C");
          assert.isUndefined(env.GIT_DIR);
          assert.isUndefined(env.GIT_WORK_TREE);
          assert.isUndefined(env.GIT_COMMON_DIR);
        }
        revParseResult = {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        };
        // The same fatal with .git metadata present means the repository is
        // broken (unreadable HEAD, broken worktree pointer), not absent.
        yield* fileSystem.makeDirectory(`${cwd}/.git`, { recursive: true });
        const brokenError = yield* driver.detectRepository(cwd).pipe(Effect.flip);
        assert.equal(brokenError._tag, "VcsProcessExitError");
        yield* fileSystem.remove(`${cwd}/.git`, { recursive: true });
        // A dangling .git symlink is still metadata: exists() resolves its
        // missing target, but the entry itself must count as evidence.
        yield* fileSystem.symlink(`${cwd}/missing-target`, `${cwd}/.git`);
        const danglingError = yield* driver.detectRepository(cwd).pipe(Effect.flip);
        assert.equal(danglingError._tag, "VcsProcessExitError");
        yield* fileSystem.remove(`${cwd}/.git`);
        // Git resolves discovery from the physical path, so metadata on the
        // resolved ancestry — not the lexical one — counts. The link points
        // at a child beneath the metadata-bearing ancestor: lexically
        // `link/.git` resolves to `real/subdir/.git` (absent) and the lexical
        // parents never see `real/.git`.
        const real = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-detect-real-" });
        yield* fileSystem.makeDirectory(`${real}/.git`, { recursive: true });
        yield* fileSystem.makeDirectory(`${real}/subdir`);
        const link = `${cwd}/linked-workspace`;
        yield* fileSystem.symlink(`${real}/subdir`, link);
        const linkedError = yield* driver.detectRepository(link).pipe(Effect.flip);
        assert.equal(linkedError._tag, "VcsProcessExitError");
        yield* fileSystem.remove(`${real}/.git`, { recursive: true });
        // A workspace that cannot be resolved — it vanished between the Git
        // probe and the metadata walk — cannot prove absence, so the lookup
        // failure must surface as a detection failure instead.
        const goneError = yield* driver.detectRepository(`${cwd}/removed`).pipe(Effect.flip);
        assert.equal(goneError._tag, "VcsProcessExitError");
        // Other fatals (unreadable config, permission denied, I/O) mean
        // detection itself failed — they must propagate rather than report
        // the workspace as non-Git, which callers rely on to decide that no
        // repo state exists.
        revParseResult = {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: unable to access '.git/config': Permission denied\n",
        };
        const error = yield* driver.detectRepository(cwd).pipe(Effect.flip);
        assert.equal(error._tag, "VcsProcessExitError");
      } finally {
        for (const key of Object.keys(seededGitEnv) as (keyof typeof seededGitEnv)[]) {
          const previous = previousGitEnv[key];
          if (previous === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = previous;
          }
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                observedEnvs.push(input.env ?? {});
                const result = input.args.includes("--is-inside-work-tree")
                  ? revParseResult
                  : input.args.includes("--show-toplevel")
                    ? { exitCode: 0, stdout: "/resolved-root\n", stderr: "" }
                    : { exitCode: 0, stdout: "/resolved-root/.git\n", stderr: "" };
                return {
                  exitCode: ChildProcessSpawner.ExitCode(result.exitCode),
                  stdout: result.stdout,
                  stderr: result.stderr,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
      ),
    );
  },
);

it.effect("detectRepository does not cross filesystem boundaries Git discovery respects", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    // /repo/mnt/usb sits on a filesystem mounted beneath a repository: Git's
    // default discovery stops at the mount and reports "not a git
    // repository", so /repo/.git on the other device must not turn this
    // legitimately non-Git workspace into a detection failure.
    assert.isNull(yield* driver.detectRepository("/repo/mnt/usb"));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        FileSystem.layerNoop({
          realPath: (path) => Effect.succeed(path),
          stat: (path) =>
            Effect.succeed({
              dev: path === "/repo" || path === "/" ? 1 : 2,
            } as FileSystem.File.Info),
          exists: (path) => Effect.succeed(path === "/repo/.git"),
          readLink: (path) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: path,
              }),
            ),
        }),
        Layer.mock(VcsProcess.VcsProcess)({
          run: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(128),
              stdout: "",
              stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  ),
);

it.effect("deleteCheckpointRefs propagates update-ref failures instead of swallowing them", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const error = yield* driver.checkpoints
      .deleteCheckpointRefs({
        cwd: "/repo",
        checkpointRefs: [CheckpointRef.make("refs/t3/checkpoints/test/1-start")],
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "VcsProcessExitError");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            // Mirror the real VcsProcess contract: a nonzero exit fails the
            // effect unless the caller opted into allowNonZeroExit.
            input.allowNonZeroExit === true
              ? Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(1),
                  stdout: "",
                  stderr:
                    "fatal: cannot lock ref 'refs/t3/checkpoints/test/1-start': unable to lock",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                })
              : Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    exitCode: 1,
                    detail:
                      "fatal: cannot lock ref 'refs/t3/checkpoints/test/1-start': unable to lock",
                  }),
                ),
        }),
      ),
    ),
  ),
);
