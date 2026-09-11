import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import {
  CheckpointRef,
  GitCommandError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
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
  yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
  const originalRef = (yield* git(["rev-parse", checkpointRef])).stdout;
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
  yield* git(["add", "."]);
  const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
  return { git, checkpointRef, originalRef, originalIndex };
});

for (const outcome of ["failure", "timeout", "interruption"] as const) {
  it.effect(`checkpoint ${outcome} cleans only its own temporary files`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-cleanup-" });
      const concurrentPack = path.join(cwd, ".git", "objects", "pack", "tmp_pack_concurrent");
      const addStarted = yield* Deferred.make<void>();
      let injectFailure = false;
      let captureDirectory: string | undefined;
      let partialPack: string | undefined;
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: Effect.fn(function* (input: VcsProcess.VcsProcessInput) {
            if (!injectFailure || !input.args.includes("add")) {
              return yield* liveProcess.run(input);
            }
            const objectDirectory =
              input.env?.GIT_OBJECT_DIRECTORY ?? path.join(cwd, ".git", "objects");
            const indexPath = input.env?.GIT_INDEX_FILE;
            assert.ok(indexPath);
            captureDirectory = path.dirname(indexPath);
            yield* liveProcess.run(input);
            const packDirectory = path.join(objectDirectory, "pack");
            yield* fileSystem.makeDirectory(packDirectory, { recursive: true }).pipe(Effect.orDie);
            partialPack = path.join(packDirectory, "tmp_pack_partial");
            yield* fileSystem.writeFileString(partialPack, "partial").pipe(Effect.orDie);
            yield* fileSystem
              .writeFileString(concurrentPack, "another operation started during capture")
              .pipe(Effect.orDie);
            yield* fileSystem
              .writeFileString(`${indexPath}.lock`, "partial index")
              .pipe(Effect.orDie);
            yield* Deferred.succeed(addStarted, undefined);
            if (outcome === "interruption") {
              return yield* Effect.never;
            }
            if (outcome === "timeout") {
              return yield* new VcsProcessTimeoutError({
                operation: input.operation,
                command: "git",
                cwd,
                timeoutMs: 30_000,
              });
            }
            return yield* new VcsProcessExitError({
              operation: input.operation,
              command: "git",
              cwd,
              exitCode: 1,
              detail: "Injected failure after writing checkpoint objects.",
            });
          }),
        }),
      );
      const { git, checkpointRef, originalRef, originalIndex } = yield* makeCheckpointFixture(
        driver,
        cwd,
      );
      const unrelatedPack = path.join(cwd, ".git", "objects", "pack", "tmp_pack_unrelated");
      yield* fileSystem.writeFileString(unrelatedPack, "another operation");
      injectFailure = true;
      const capture = driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      if (outcome === "interruption") {
        const fiber = yield* capture.pipe(Effect.forkChild);
        yield* Deferred.await(addStarted);
        yield* Fiber.interrupt(fiber);
      } else {
        const error = yield* capture.pipe(Effect.flip);
        assert.strictEqual(
          error._tag,
          outcome === "timeout" ? "VcsProcessTimeoutError" : "VcsProcessExitError",
        );
      }
      assert.ok(partialPack);
      assert.isFalse(yield* fileSystem.exists(partialPack));
      assert.ok(captureDirectory);
      assert.isFalse(yield* fileSystem.exists(captureDirectory));
      assert.strictEqual(yield* fileSystem.readFileString(unrelatedPack), "another operation");
      assert.strictEqual(
        yield* fileSystem.readFileString(concurrentPack),
        "another operation started during capture",
      );
      assert.strictEqual((yield* git(["rev-parse", checkpointRef])).stdout, originalRef);
      assert.deepStrictEqual(
        yield* fileSystem.readFile(path.join(cwd, ".git", "index")),
        originalIndex,
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(cwd, "file.txt")),
        "unstaged\n",
      );
    }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
  );
}

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

for (const destinationExists of [false, true]) {
  it.effect(
    `checkpoint publication handles rename failure when destination exists: ${destinationExists}`,
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-publish-" });
        const publicationFailure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rename",
          description: "Injected checkpoint object publication failure.",
        });
        let injectFailure = false;
        let captureDirectory: string | undefined;
        const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            rename: Effect.fn(function* (source: string, destination: string) {
              if (injectFailure && !(yield* fileSystem.exists(destination))) {
                captureDirectory = path.dirname(path.dirname(path.dirname(source)));
                if (destinationExists) {
                  yield* fileSystem.copyFile(source, destination);
                }
                return yield* publicationFailure;
              }
              return yield* fileSystem.rename(source, destination);
            }),
          }),
        );
        const { git, checkpointRef, originalRef, originalIndex } = yield* makeCheckpointFixture(
          driver,
          cwd,
        );
        injectFailure = true;

        const capture = driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
        if (destinationExists) {
          yield* capture;
          assert.notStrictEqual((yield* git(["rev-parse", checkpointRef])).stdout, originalRef);
          assert.strictEqual(
            (yield* git(["show", `${checkpointRef}:file.txt`])).stdout,
            "unstaged\n",
          );
          yield* git(["fsck", "--no-dangling", checkpointRef]);
        } else {
          const error = yield* capture.pipe(Effect.flip);
          assert.strictEqual(error._tag, "VcsCheckpointStorageError");
          if (error._tag === "VcsCheckpointStorageError") {
            assert.strictEqual(error.cause, publicationFailure);
          }
          assert.strictEqual((yield* git(["rev-parse", checkpointRef])).stdout, originalRef);
        }
        assert.ok(captureDirectory);
        assert.isFalse(yield* fileSystem.exists(captureDirectory));
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(cwd, ".git", "index")),
          originalIndex,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(cwd, "file.txt")),
          "unstaged\n",
        );
      }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
  );
}

it.effect("checkpoint publication preserves shared repository directory permissions", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-shared-" });
    let objectPath: string | undefined;
    let sourceMode: number | undefined;
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        rename: Effect.fn(function* (source: string, destination: string) {
          if (destination === objectPath) {
            sourceMode = (yield* fileSystem.stat(path.dirname(source))).mode;
          }
          return yield* fileSystem.rename(source, destination);
        }),
      }),
    );
    const git = (args: ReadonlyArray<string>) =>
      driver.execute({ operation: "checkpoint-shared-test", cwd, args });
    yield* git(["init"]);
    yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/shared");
    yield* git(["config", "core.sharedRepository", "group"]);
    const objectId = (yield* git(["hash-object", "file.txt"])).stdout.trim();
    const objectDirectory = path.join(cwd, ".git", "objects", objectId.slice(0, 2));
    objectPath = path.join(objectDirectory, objectId.slice(2));
    assert.isFalse(yield* fileSystem.exists(objectDirectory));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.ok(sourceMode);
    const publishedMode = (yield* fileSystem.stat(objectDirectory)).mode;
    assert.strictEqual(publishedMode & 0o7777, sourceMode & 0o7777);
    assert.strictEqual(publishedMode & 0o020, 0o020);
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("checkpoint publication finishes before honoring interruption", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-interrupt-" });
    const publishStarted = yield* Deferred.make<void>();
    const publishAllowed = yield* Deferred.make<void>();
    let interruptPublication = false;
    let captureDirectory: string | undefined;
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        rename: Effect.fn(function* (source: string, destination: string) {
          if (interruptPublication) {
            interruptPublication = false;
            captureDirectory = path.dirname(path.dirname(path.dirname(source)));
            yield* Deferred.succeed(publishStarted, undefined);
            yield* Deferred.await(publishAllowed);
          }
          return yield* fileSystem.rename(source, destination);
        }),
      }),
    );
    const { git, checkpointRef, originalRef, originalIndex } = yield* makeCheckpointFixture(
      driver,
      cwd,
    );
    interruptPublication = true;
    const fiber = yield* driver.checkpoints
      .captureCheckpoint({ cwd, checkpointRef })
      .pipe(Effect.forkChild);
    yield* Deferred.await(publishStarted);
    assert.strictEqual((yield* git(["rev-parse", checkpointRef])).stdout, originalRef);
    fiber.interruptUnsafe();
    yield* Deferred.succeed(publishAllowed, undefined);
    yield* Fiber.await(fiber);

    assert.notStrictEqual((yield* git(["rev-parse", checkpointRef])).stdout, originalRef);
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    yield* git(["fsck", "--no-dangling", checkpointRef]);
    assert.ok(captureDirectory);
    assert.isFalse(yield* fileSystem.exists(captureDirectory));
    assert.deepStrictEqual(
      yield* fileSystem.readFile(path.join(cwd, ".git", "index")),
      originalIndex,
    );
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);
