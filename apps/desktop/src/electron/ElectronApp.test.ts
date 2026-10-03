import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  autoUpdaterOnMock,
  autoUpdaterRemoveListenerMock,
  exitMock,
  getAppPathMock,
  getSystemLocaleMock,
  getVersionMock,
  onMock,
  quitMock,
  relaunchMock,
  removeListenerMock,
  removeSwitchMock,
  setAboutPanelOptionsMock,
  setAppUserModelIdMock,
  setAsDefaultProtocolClientMock,
  setDesktopNameMock,
  setDockIconMock,
  setNameMock,
  setPathMock,
  whenReadyMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  autoUpdaterOnMock: vi.fn(),
  autoUpdaterRemoveListenerMock: vi.fn(),
  exitMock: vi.fn(),
  getAppPathMock: vi.fn(() => "/app"),
  getSystemLocaleMock: vi.fn(() => "en-GB"),
  getVersionMock: vi.fn(() => "1.2.3"),
  onMock: vi.fn(),
  quitMock: vi.fn(),
  relaunchMock: vi.fn(),
  removeListenerMock: vi.fn(),
  removeSwitchMock: vi.fn(),
  setAboutPanelOptionsMock: vi.fn(),
  setAppUserModelIdMock: vi.fn(),
  setAsDefaultProtocolClientMock: vi.fn(() => true),
  setDesktopNameMock: vi.fn(),
  setDockIconMock: vi.fn(),
  setNameMock: vi.fn(),
  setPathMock: vi.fn(),
  whenReadyMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  autoUpdater: {
    on: autoUpdaterOnMock,
    removeListener: autoUpdaterRemoveListenerMock,
  },
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
      removeSwitch: removeSwitchMock,
    },
    dock: {
      setIcon: setDockIconMock,
    },
    getAppPath: getAppPathMock,
    getSystemLocale: getSystemLocaleMock,
    getVersion: getVersionMock,
    isPackaged: true,
    name: "T3 Code",
    on: onMock,
    quit: quitMock,
    relaunch: relaunchMock,
    removeListener: removeListenerMock,
    runningUnderARM64Translation: false,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    setAsDefaultProtocolClient: setAsDefaultProtocolClientMock,
    setAppUserModelId: setAppUserModelIdMock,
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    setPath: setPathMock,
    whenReady: whenReadyMock,
    exit: exitMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

const spawnedCommands: Array<ChildProcess.StandardCommand> = [];
const electronAppLayer = ElectronApp.layer.pipe(
  Layer.provide(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          spawnedCommands.push(command as ChildProcess.StandardCommand);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: undefined as never,
            stdout: undefined as never,
            stderr: undefined as never,
            all: undefined as never,
            getInputFd: () => undefined as never,
            getOutputFd: () => undefined as never,
            unref: Effect.succeed(Effect.void),
          });
        }),
      ),
    ),
  ),
);

describe("ElectronApp", () => {
  beforeEach(() => {
    appendSwitchMock.mockClear();
    autoUpdaterOnMock.mockClear();
    autoUpdaterRemoveListenerMock.mockClear();
    exitMock.mockClear();
    onMock.mockClear();
    quitMock.mockClear();
    relaunchMock.mockClear();
    spawnedCommands.length = 0;
    removeListenerMock.mockClear();
    removeSwitchMock.mockClear();
    setPathMock.mockClear();
  });

  it.effect("reads app metadata through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const metadata = yield* electronApp.metadata;

      assert.deepEqual(metadata, {
        appVersion: "1.2.3",
        appPath: "/app",
        isPackaged: true,
        resourcesPath: process.resourcesPath,
        runningUnderArm64Translation: false,
      });
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("reads the OS locale through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;

      assert.strictEqual(yield* electronApp.systemLocale, "en-GB");
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("normalizes POSIX-style locale identifiers that Intl rejects", () =>
    Effect.gen(function* () {
      getSystemLocaleMock.mockImplementationOnce(() => "en_GB");
      const electronApp = yield* ElectronApp.ElectronApp;

      assert.strictEqual(yield* electronApp.systemLocale, "en-GB");
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("reports which app metadata property failed", () =>
    Effect.gen(function* () {
      const cause = new Error("version unavailable");
      getVersionMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.metadata.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppMetadataReadError);
      assert.strictEqual(error.property, "app-version");
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        'Failed to read Electron app metadata property "app-version".',
      );
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("preserves Electron readiness failures", () =>
    Effect.gen(function* () {
      const cause = new Error("ready failed");
      whenReadyMock.mockRejectedValueOnce(cause);

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.whenReady.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppWhenReadyError);
      assert.strictEqual(error.isPackaged, true);
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        "Failed to wait for the Electron app to become ready (packaged: true).",
      );
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("scopes app event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.on("activate", listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["activate", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["activate", listener]]);
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("scopes native updater quit listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.onBeforeQuitForUpdate(listener);
        }),
      );

      assert.deepEqual(autoUpdaterOnMock.mock.calls, [["before-quit-for-update", listener]]);
      assert.deepEqual(autoUpdaterRemoveListenerMock.mock.calls, [
        ["before-quit-for-update", listener],
      ]);
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("removes command-line switches through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      yield* electronApp.removeCommandLineSwitch("password-store");

      assert.deepEqual(removeSwitchMock.mock.calls, [["password-store"]]);
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("relaunches through app.relaunch() off Linux", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      yield* electronApp.relaunch({ args: ["--flag"] });

      assert.deepEqual(relaunchMock.mock.calls, [[{ args: ["--flag"] }]]);
      assert.equal(spawnedCommands.length, 0);
    }).pipe(Effect.provide(electronAppLayer), Effect.provideService(HostProcessPlatform, "darwin")),
  );

  it.effect("relaunches on Linux after this process exits without app.relaunch()", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3 relaunch " });
      const output = path.join(directory, "argv");

      yield* Effect.gen(function* () {
        const electronApp = yield* ElectronApp.ElectronApp;
        yield* electronApp.relaunch({
          execPath: "/bin/sh",
          args: ["-c", 'printf "%s\\n" "$@" > "$0"', output, "two words", "$HOME", "(Nightly)"],
        });
      }).pipe(
        Effect.provide(electronAppLayer),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      assert.equal(relaunchMock.mock.calls.length, 0);
      const [relauncher] = spawnedCommands;
      assert.isDefined(relauncher);

      // Run the relauncher against a stand-in for this process.
      const running = yield* spawner.spawn(ChildProcess.make("sleep", ["30"]));
      const [shell, script, , ...relaunchArgs] = relauncher!.args;
      const waiting = yield* spawner.spawn(
        ChildProcess.make(relauncher!.command, [
          shell!,
          script!,
          String(running.pid),
          ...relaunchArgs,
        ]),
      );
      assert.isTrue(yield* waiting.isRunning);
      assert.isFalse(yield* fileSystem.exists(output));

      yield* running.kill();
      assert.equal(yield* waiting.exitCode, 0);
      assert.equal(yield* fileSystem.readFileString(output), "two words\n$HOME\n(Nightly)\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
