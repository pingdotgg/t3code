import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const successfulRunner = (fs: FileSystem.FileSystem, path: Path.Path) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.args[0] === "--input-type=commonjs") {
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        const prefixIndex = input.args.indexOf("--prefix");
        const stagingDir = input.args[prefixIndex + 1];
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
        assert.deepEqual(
          yield* decodeManifest(
            yield* fs.readFileString(path.join(stagingDir, "package.json")).pipe(Effect.orDie),
          ).pipe(Effect.orDie),
          { private: true, allowScripts: { "node-pty": true, "msgpackr-extract": true } },
        );
        const entry = path.join(stagingDir, "node_modules", "t3", "dist", "bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  for (const nativeModuleAvailable of [true, false]) {
    it.effect(
      nativeModuleAvailable
        ? "loads node-pty from the candidate before publishing it"
        : "rejects a successful install with a missing node-pty native binary",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-native-" });
          const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
          const nodeRunner = yield* ProcessRunner.make();
          const install = successfulRunner(fs, path);
          let validated = false;
          const result = yield* ensurePinnedRuntimeInstalled({
            baseDir,
            version: "1.2.3",
            execPath: process.execPath,
            fs,
            path,
            runner: ProcessRunner.ProcessRunner.of({
              run: (input) =>
                input.command !== "npm"
                  ? nodeRunner.run(input)
                  : Effect.gen(function* () {
                      const result = yield* install.run(input);
                      const prefix = input.args[input.args.indexOf("--prefix") + 1]!;
                      const moduleDir = path.join(prefix, "node_modules", "node-pty");
                      yield* fs.makeDirectory(moduleDir, { recursive: true }).pipe(Effect.orDie);
                      yield* fs
                        .writeFileString(
                          path.join(moduleDir, "index.js"),
                          nativeModuleAvailable
                            ? "require('node:fs').writeFileSync(__dirname + '/loaded', 'yes');"
                            : "require('./build/Release/pty.node');",
                        )
                        .pipe(Effect.orDie);
                      return result;
                    }),
            }),
            validate: (runtime) =>
              Effect.gen(function* () {
                validated = true;
                assert.isFalse(yield* fs.exists(runtime.sentinelPath));
                assert.isTrue(
                  yield* fs.exists(path.join(runtime.versionDir, "node_modules/node-pty/loaded")),
                );
              }).pipe(Effect.orDie),
          }).pipe(Effect.result);

          assert.equal(validated, nativeModuleAvailable);
          assert.equal(yield* fs.exists(finalPaths.sentinelPath), nativeModuleAvailable);
          if (nativeModuleAvailable) {
            assert.equal(result._tag, "Success");
          } else {
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") {
              assert.instanceOf(result.failure, PinnedRuntimeInstallError);
              assert.include(result.failure.message, "loading node-pty");
            }
            assert.deepEqual(yield* fs.readDirectory(path.dirname(finalPaths.versionDir)), []);
          }
        }),
    );
  }

  it.effect("installs through pnpm when its Node runtime has no npm executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-pnpm-" });
      const commands: Array<ProcessRunner.ProcessRunInput> = [];
      const install = successfulRunner(fs, path);
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        execPath: process.execPath,
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: (input) => {
            commands.push(input);
            return input.command === "npm"
              ? Effect.fail(
                  new ProcessRunner.ProcessSpawnError({
                    command: "npm",
                    argumentCount: input.args.length,
                    cause: PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                    }),
                  }),
                )
              : install.run(input);
          },
        }),
        validate: (staging) =>
          fs.exists(staging.entryPath).pipe(
            Effect.flatMap((exists) => (exists ? Effect.void : Effect.die("missing runtime"))),
            Effect.orDie,
          ),
      });
      assert.deepEqual(
        commands.map((command) => command.command),
        ["npm", "pnpm", process.execPath],
      );
      assert.deepEqual(commands[1]!.args, ["--package=npm@11", "dlx", "npm", ...commands[0]!.args]);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), "1.2.3\n");
    }),
  );

  it.effect("does not try a different installer for npm permission failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-permission-" });
      const commands: string[] = [];
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        execPath: process.execPath,
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: (input) => {
            commands.push(input.command);
            return Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: input.command,
                argumentCount: input.args.length,
                cause: PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "ChildProcess",
                  method: "spawn",
                }),
              }),
            );
          },
        }),
        validate: () => Effect.die("must not validate a failed install"),
      }).pipe(Effect.flip);
      assert.deepEqual(commands, ["npm"]);
    }),
  );

  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        execPath: process.execPath,
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), "1.2.3\n");
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        execPath: process.execPath,
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("replaces an incomplete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        execPath: process.execPath,
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: () => Effect.void,
      });

      assert.isFalse(yield* fs.exists(path.join(finalPaths.versionDir, "partial")));
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, "1.2.3\n");

      let validations = 0;
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        execPath: process.execPath,
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );

  it.effect("removes staging when installation is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-interrupt-" });
      const started = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        execPath: process.execPath,
        fs,
        path,
        runner,
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      const versionsDir = path.join(baseDir, "runtime", "versions");
      assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
    }),
  );
});
