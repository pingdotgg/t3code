import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  autoUpdaterOnMock,
  autoUpdaterRemoveListenerMock,
  exitMock,
  getAppPathMock,
  getSystemLocaleMock,
  getVersionMock,
  isPackagedMock,
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
  isPackagedMock: vi.fn(() => true),
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
    get isPackaged() {
      return isPackagedMock();
    },
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

const electronAppLayer = ElectronApp.layer.pipe(Layer.provide(NodeServices.layer));

describe("ElectronApp", () => {
  beforeEach(() => {
    isPackagedMock.mockReturnValue(true);
    appendSwitchMock.mockClear();
    autoUpdaterOnMock.mockClear();
    autoUpdaterRemoveListenerMock.mockClear();
    exitMock.mockClear();
    onMock.mockClear();
    quitMock.mockClear();
    relaunchMock.mockClear();
    removeListenerMock.mockClear();
    removeSwitchMock.mockClear();
    setPathMock.mockClear();
  });

  it.effect.each([
    { platform: "linux", APPIMAGE: undefined, packaged: true },
    { platform: "linux", APPIMAGE: "  ", packaged: true },
    { platform: "linux", APPIMAGE: "/tmp/app.AppImage", packaged: false },
    { platform: "darwin", APPIMAGE: "/tmp/app.AppImage", packaged: true },
    { platform: "win32", APPIMAGE: "/tmp/app.AppImage", packaged: true },
  ] as const)("keeps native relaunch outside packaged AppImages: %j", (input) => {
    isPackagedMock.mockReturnValue(input.packaged);
    return Effect.gen(function* () {
      const app = yield* ElectronApp.ElectronApp;
      yield* app.relaunch({ execPath: "/app/native", args: ["two words"] });
      assert.deepEqual(relaunchMock.mock.calls, [
        [{ execPath: "/app/native", args: ["two words"] }],
      ]);
    }).pipe(
      Effect.provide(electronAppLayer),
      Effect.provideService(HostProcessPlatform, input.platform),
      Effect.provideService(HostProcessEnvironment, { APPIMAGE: input.APPIMAGE }),
    );
  });

  it.effect("waits for exit and preserves the exact AppImage path and arguments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3 appimage relaunch " });
      const launcher = path.join(directory, " launcher (AppImage) ");
      const output = path.join(directory, "result");
      const startup = path.join(directory, "startup");
      const startupMarker = path.join(directory, "startup-ran");
      yield* fs.writeFileString(startup, `printf ran > "${startupMarker}"\nexec </dev/null\n`);
      yield* fs.writeFileString(
        launcher,
        '#!/bin/sh\nif [ -e /proc/self/fd/3 ] || [ -e /proc/self/fd/65 ]; then exit 65; fi\nprintf "%s\\n" "$@" > "$1"\n',
      );
      yield* fs.chmod(launcher, 0o700);
      let command: ChildProcess.StandardCommand | undefined;
      let unreferenced = false;
      const recordingSpawner = ChildProcessSpawner.make((value) =>
        Effect.sync(() => {
          assert.equal(value._tag, "StandardCommand");
          command = value as ChildProcess.StandardCommand;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.sync(() => {
              unreferenced = true;
              return Effect.void;
            }),
          });
        }),
      );
      yield* Effect.gen(function* () {
        const app = yield* ElectronApp.ElectronApp;
        yield* app.relaunch({ args: [output, "two words", "$HOME", "(Nightly)", " trailing "] });
      }).pipe(
        Effect.provide(ElectronApp.layer),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, {
          APPIMAGE: launcher,
          BASH_ENV: startup,
          PATH: process.env.PATH,
        }),
      );
      assert.equal(relaunchMock.mock.calls.length, 0);
      assert.isTrue(unreferenced);
      assert.isDefined(command);
      const waiting = yield* spawner.spawn(
        ChildProcess.make(command!.command, command!.args, {
          ...command!.options,
          env: command!.options.env ?? { ...process.env, BASH_ENV: startup },
          detached: false,
          additionalFds: { fd3: { type: "output" }, fd65: { type: "output" } },
        }),
      );
      assert.isTrue(yield* waiting.isRunning);
      assert.isFalse(yield* fs.exists(output));
      // Closing the parent-owned pipe stands in for parent exit, without a PID poll.
      yield* Stream.run(Stream.empty, waiting.stdin);
      assert.equal(yield* waiting.exitCode, 0);
      assert.isFalse(yield* fs.exists(startupMarker));
      assert.equal(
        yield* fs.readFileString(output),
        `${output}\ntwo words\n$HOME\n(Nightly)\n trailing \n`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "surfaces an asynchronous spawn failure instead of scheduling a broken native restart",
    () =>
      Effect.gen(function* () {
        const app = yield* ElectronApp.ElectronApp;
        const result = yield* Effect.exit(app.relaunch({ execPath: "/tmp/app.AppImage" }));
        assert.isTrue(Exit.isFailure(result));
        assert.equal(relaunchMock.mock.calls.length, 0);
      }).pipe(
        Effect.provide(ElectronApp.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { APPIMAGE: "/tmp/app.AppImage" }),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.yieldNow.pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                    pathOrDescriptor: "/bin/bash",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
  );

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
});
