import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";

const effectOverridesJson = JSON.stringify({
  effect: "4.0.0-rc.112",
  "@effect/platform-node": "4.0.0-rc.112",
  "@effect/platform-node-shared": "4.0.0-rc.112",
  "@effect/vitest>vitest": "-",
  vite: "npm:@voidzero-dev/vite-plus-core@0.3.0",
});

const okResult = (stdout = "", stderr = "") => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const failedResult = (stderr: string, stdout = "") => ({
  ...okResult(stdout, stderr),
  code: ChildProcessSpawner.ExitCode(1),
});

const isNpmView = (input: ProcessRunner.ProcessRunInput) =>
  input.args[0] === "view" || (input.command === "pnpm" && input.args.includes("view"));

const isNpmInstall = (input: ProcessRunner.ProcessRunInput) =>
  input.args[0] === "install" || (input.command === "pnpm" && input.args.includes("install"));

const stagingPrefix = (input: ProcessRunner.ProcessRunInput) => {
  const prefixIndex = input.args.indexOf("--prefix");
  return input.args[prefixIndex + 1];
};

const successfulRunner = (fs: FileSystem.FileSystem, path: Path.Path) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (isNpmView(input)) {
          return okResult(effectOverridesJson);
        }
        if (!isNpmInstall(input)) {
          return yield* Effect.die(`unexpected command: ${input.command} ${input.args.join(" ")}`);
        }
        const stagingDir = stagingPrefix(input);
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
        assert.isUndefined(
          input.args.find((arg) => arg.startsWith("t3@")),
          "install must use the staging manifest, not a positional t3@version",
        );
        const entry = path.join(stagingDir, "node_modules", "t3", "dist", "bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
        return okResult();
      }),
  });

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("writes Effect overrides into the staging manifest before install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-manifest-" });
      const commands: Array<ProcessRunner.ProcessRunInput> = [];
      let manifestBeforeInstall: unknown;

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.gen(function* () {
              commands.push(input);
              if (isNpmView(input)) {
                assert.deepEqual(input.args, ["view", "t3@1.2.3", "overrides", "--json"]);
                return okResult(effectOverridesJson);
              }
              const stagingDir = stagingPrefix(input);
              if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
              manifestBeforeInstall = JSON.parse(
                yield* fs.readFileString(path.join(stagingDir, "package.json")).pipe(Effect.orDie),
              );
              return yield* successfulRunner(fs, path).run(input);
            }),
        }),
        validate: () => Effect.void,
      });

      assert.equal(commands[0]?.args[0], "view");
      assert.equal(commands[1]?.args[0], "install");
      assert.deepEqual(commands[1]?.args, [
        "install",
        "--prefix",
        stagingPrefix(commands[1]!),
        "--no-fund",
        "--no-audit",
      ]);
      assert.deepEqual(manifestBeforeInstall, {
        dependencies: { t3: "1.2.3" },
        overrides: {
          effect: "4.0.0-rc.112",
          "@effect/platform-node": "4.0.0-rc.112",
          "@effect/platform-node-shared": "4.0.0-rc.112",
        },
      });
    }),
  );

  it.effect("surfaces a truncated npm stderr tail when install fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-stderr-" });
      const stderr = `npm warn ERESOLVE overriding peer dependency\n${"x".repeat(2500)}`;

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: (input) =>
            isNpmView(input)
              ? Effect.succeed(okResult(effectOverridesJson))
              : Effect.succeed(failedResult(stderr)),
        }),
        validate: () => Effect.die("must not validate a failed install"),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "PinnedRuntimeInstallError");
      assert.equal(error.exitCode, 1);
      assert.isTrue(error.message.includes("exit code 1"));
      assert.isTrue(error.outputTail !== undefined && error.outputTail.includes("ERESOLVE"));
      assert.equal(error.outputTail?.length, 2048);
      assert.isTrue(error.message.endsWith(error.outputTail!));
    }),
  );

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
        ["npm", "pnpm", "npm", "pnpm"],
      );
      assert.deepEqual(commands[1]!.args, ["--package=npm@11", "dlx", "npm", ...commands[0]!.args]);
      assert.deepEqual(commands[3]!.args, ["--package=npm@11", "dlx", "npm", ...commands[2]!.args]);
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
      // Fails on the first npm (view) without falling back to pnpm.
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
