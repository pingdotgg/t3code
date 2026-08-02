import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";

const successfulRunner = (fs: FileSystem.FileSystem, path: Path.Path) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const prefixIndex = input.args.indexOf("--prefix");
        const stagingDir = input.args[prefixIndex + 1];
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
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
        };
      }),
  });

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
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
