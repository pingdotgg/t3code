import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { ensurePinnedRuntimeInstalled, pinnedRuntimePaths } from "./pinnedRuntime.ts";

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("serializes concurrent installs of the same runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const installStarted = yield* Deferred.make<void>();
      const allowInstallToFinish = yield* Deferred.make<void>();
      const paths = pinnedRuntimePaths(path, baseDir, "0.0.29");
      let npmRuns = 0;

      const runner = ProcessRunner.ProcessRunner.of({
        run: (_input) =>
          Effect.gen(function* () {
            npmRuns += 1;
            yield* Deferred.succeed(installStarted, undefined);
            yield* Deferred.await(allowInstallToFinish);
            yield* fs
              .makeDirectory(path.dirname(paths.entryPath), { recursive: true })
              .pipe(Effect.orDie);
            yield* fs.writeFileString(paths.entryPath, "export {};\n").pipe(Effect.orDie);
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
      const install = ensurePinnedRuntimeInstalled({
        baseDir,
        version: "0.0.29",
        fs,
        path,
        runner,
      });

      const first = yield* Effect.forkChild(install, { startImmediately: true });
      yield* Deferred.await(installStarted);
      const second = yield* Effect.forkChild(install, { startImmediately: true });
      yield* Effect.yieldNow;
      assert.equal(npmRuns, 1);

      yield* Deferred.succeed(allowInstallToFinish, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      assert.equal(npmRuns, 1);
      assert.isTrue(yield* fs.exists(paths.sentinelPath));
      assert.isTrue(yield* fs.exists(paths.entryPath));
    }),
  );
});
