// @effect-diagnostics nodeBuiltinImport:off -- Intercepts the spawn electron-updater requires natively.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { autoUpdater } from "electron-updater";
import type * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";

// electron-updater requires Electron natively, outside vi.mock's reach, and builds its
// autoUpdater singleton as soon as it is imported.
vi.hoisted(() => {
  const NodeModule = process.getBuiltinModule("node:module");
  const NodeEvents = process.getBuiltinModule("node:events");
  const require = NodeModule.createRequire(import.meta.url);
  const electronPath = NodeModule.createRequire(require.resolve("electron-updater")).resolve(
    "electron",
  );
  const electronModule = new NodeModule.Module(electronPath);
  electronModule.filename = electronPath;
  electronModule.loaded = true;
  electronModule.exports = {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "T3 Code",
      isPackaged: true,
      quit: () => undefined,
      once: () => undefined,
    },
    autoUpdater: new NodeEvents.EventEmitter(),
  };
  require.cache[electronPath] = electronModule;
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

const childProcess = NodeModule.createRequire(import.meta.url)("node:child_process") as {
  spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater AppImage install",
  () => {
    it.live("relaunches the installed AppImage without the updating process's descriptors", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-appimage-install-" });
        const appImagePath = path.join(dir, "T3-Code.AppImage");
        const stagedPath = path.join(dir, "T3-Code-1.0.1.AppImage");
        const fdReportPath = path.join(dir, "relaunched-fds.txt");
        yield* fileSystem.writeFileString(appImagePath, "old AppImage");
        yield* fileSystem.writeFileString(
          stagedPath,
          `#!/bin/sh\nls /proc/self/fd > '${fdReportPath}'\n`,
        );
        yield* fileSystem.chmod(stagedPath, 0o755);

        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("APPIMAGE", appImagePath)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        autoUpdater.logger = null;
        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: stagedPath,
            downloadedFileInfo: { isAdminRightsRequired: false },
          },
        });

        // Electron's main process holds the AppImage runtime's keepalive pipe and some
        // Chromium files without O_CLOEXEC. Node cannot hold such a descriptor, so the
        // relaunch runs with fd 7 opened that way to stand in for them.
        const relaunched = yield* Deferred.make<void>();
        const realSpawn = childProcess.spawn;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            childProcess.spawn = (command, args, options) => {
              const child = realSpawn(
                "bash",
                ["-c", 'exec 7</dev/null; exec "$@"', "leaky-parent", command, ...args],
                options,
              );
              child.once("exit", () => Deferred.doneUnsafe(relaunched, Effect.void));
              return child;
            };
            NodeModule.syncBuiltinESMExports();
          }),
          () =>
            Effect.sync(() => {
              childProcess.spawn = realSpawn;
              NodeModule.syncBuiltinESMExports();
            }),
        );

        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        yield* Deferred.await(relaunched);

        const descriptors = (yield* fileSystem.readFileString(fdReportPath)).trim().split("\n");
        assert.notInclude(
          descriptors,
          "7",
          `relaunched AppImage inherited the updating process's fd 7 (open fds: ${descriptors.join(" ")})`,
        );
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);

class FakeSquirrel implements ElectronUpdater.NativeUpdater {
  readonly events = new NodeEvents.EventEmitter();
  checks = 0;
  answer: (squirrel: FakeSquirrel) => void = () => {};
  on(event: string, listener: (...args: Array<never>) => void) {
    this.events.on(event, listener as (...args: Array<unknown>) => void);
  }
  // NativeUpdater listeners take specific arguments; the emitter passes whatever was emitted.
  once(event: string, listener: (...args: Array<never>) => void) {
    this.events.once(event, listener as (...args: Array<unknown>) => void);
  }
  removeListener(event: string, listener: (...args: Array<never>) => void) {
    this.events.removeListener(event, listener as (...args: Array<unknown>) => void);
  }
  emit(event: string, ...args: Array<unknown>) {
    this.events.emit(event, ...args);
  }
  checkForUpdates() {
    this.checks += 1;
    this.answer(this);
  }
}

// One persistent watcher per event outlives each prepare; its own listeners must not.
const settledListeners = (squirrel: FakeSquirrel) =>
  ["update-downloaded", "update-not-available", "error"].map((event) =>
    squirrel.events.listenerCount(event),
  );

describe("prepareInstall", () => {
  it.effect("succeeds once Squirrel has the update and stops listening", () =>
    Effect.gen(function* () {
      const squirrel = new FakeSquirrel();
      squirrel.answer = (fake) => fake.emit("update-downloaded");
      yield* ElectronUpdater.makePrepareInstall(() => squirrel);
      assert.deepEqual(settledListeners(squirrel), [1, 1, 1]);
    }),
  );

  it.effect.each([
    ["an error", (fake: FakeSquirrel) => fake.emit("error", new Error("No space left on device"))],
    ["no update", (fake: FakeSquirrel) => fake.emit("update-not-available")],
    [
      "a throw",
      () => {
        throw new Error("no feed URL");
      },
    ],
  ] as const)("fails on %s and stops listening", ([, answer]) =>
    Effect.gen(function* () {
      const squirrel = new FakeSquirrel();
      squirrel.answer = answer;
      const error = yield* Effect.flip(ElectronUpdater.makePrepareInstall(() => squirrel));
      assert.equal(error._tag, "ElectronUpdaterPrepareInstallError");
      assert.deepEqual(settledListeners(squirrel), [1, 1, 1]);
    }),
  );

  it.effect("counts a prepare that finished after the timeout", () =>
    Effect.gen(function* () {
      const squirrel = new FakeSquirrel();
      const prepareInstall = ElectronUpdater.makePrepareInstall(() => squirrel);
      const first = yield* prepareInstall.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("2 minutes");
      assert.equal((yield* Fiber.join(first))._tag, "ElectronUpdaterPrepareInstallError");

      // A retry while Squirrel is still checking waits for that check instead of starting another.
      const retry = yield* prepareInstall.pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(squirrel.checks, 1);
      squirrel.emit("update-downloaded");
      yield* Fiber.join(retry);
      yield* prepareInstall;
      assert.equal(squirrel.checks, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
