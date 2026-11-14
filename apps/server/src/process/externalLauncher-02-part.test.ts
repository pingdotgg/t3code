// @effect-diagnostics nodeBuiltinImport:off - the Windows launch smoke tests use filesystem notifications to observe real PowerShell launches.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { EDITORS } from "@t3tools/contracts";
import { resolveEditorCommand } from "@t3tools/shared/editor";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

// Windows drive letters break mocked POSIX PATH splitting; these tests also require /bin/sh stubs.


// Windows drive letters cannot resolve the POSIX editor stub.







import { windowsHost, type MockSpawnResult, makeMockDetachedHandle, layerTest } from "./externalLauncher-fixtures.testkit.ts";
it.effect(
  "memoizes editor discovery and refreshes in the background after the cache window",
  () => {
    let statCalls = 0;
    const rescanned = Deferred.makeUnsafe<void>();
    let initialScanDone = false;
    const fileInfo = { type: "File" } as FileSystem.File.Info;
    const layerLauncher = ExternalLauncher.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            stat: () =>
              Effect.sync(() => {
                statCalls += 1;
                return fileInfo;
              }).pipe(
                Effect.tap(() =>
                  initialScanDone ? Deferred.succeed(rescanned, undefined) : Effect.void,
                ),
              ),
          }),
          Path.layer,
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      const first = yield* launcher.resolveAvailableEditors();
      assert.equal(first.includes("vscode"), true);
      const statCallsAfterFirstScan = statCalls;
      initialScanDone = true;
      assert.isAbove(statCallsAfterFirstScan, 0);

      // Past the shared command-resolution cache TTL (30s) but within the
      // discovery cache window: the memoized set is reused without any scan.
      yield* TestClock.adjust("31 seconds");
      const second = yield* launcher.resolveAvailableEditors();
      assert.deepEqual([...second], [...first]);
      assert.equal(statCalls, statCallsAfterFirstScan);

      // Past the discovery cache window the next call still answers from the
      // memoized set and rescans in the background.
      yield* TestClock.adjust("30 seconds");
      const third = yield* launcher.resolveAvailableEditors();
      assert.deepEqual([...third], [...first]);
      yield* Deferred.await(rescanned);
      assert.isAbove(statCalls, statCallsAfterFirstScan);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerLauncher,
          Layer.succeed(HostProcess.Platform, "win32"),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                PATH: "C:\\t3-editor-discovery-cache-test",
                PATHEXT: ".COM;.EXE;.BAT;.CMD",
              },
            }),
          ),
          TestClock.layer(),
        ),
      ),
    );
  },
);
it.effect("keeps scanning after the caller is interrupted and shares that scan", () => {
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const release = Deferred.makeUnsafe<void>();
  let parkedStats = 0;
  const layerLauncher = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              if (!Deferred.isDoneUnsafe(release)) {
                parkedStats += 1;
                yield* Deferred.await(release);
              }
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    const interrupted = yield* Effect.forkChild(launcher.resolveAvailableEditors());
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(interrupted);

    const next = yield* Effect.forkChild(launcher.resolveAvailableEditors());
    yield* Effect.yieldNow;
    assert.equal(parkedStats, 1);

    yield* Deferred.succeed(release, undefined);
    const editors = yield* Fiber.join(next);
    assert.equal(editors.includes("vscode"), true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerLauncher,
        Layer.succeed(HostProcess.Platform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-interrupt-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
      ),
    ),
  );
});
