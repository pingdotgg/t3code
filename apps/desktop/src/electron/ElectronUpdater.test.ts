// @effect-diagnostics nodeBuiltinImport:off - safe-install tests drive the real filesystem boundary the updater swaps across.
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: "latest",
    disableDifferentialDownload: false,
    fullChangelog: false,
    downloadedUpdateHelper: null as null | {
      readonly file: string | null;
      readonly downloadedFileInfo: {
        readonly fileName: string;
        readonly sha512: string;
      } | null;
    },
    logger: null as null | {
      readonly info: (...args: ReadonlyArray<unknown>) => void;
      readonly warn: (...args: ReadonlyArray<unknown>) => void;
      readonly error: (...args: ReadonlyArray<unknown>) => void;
    },
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

const {
  appQuitMock,
  autoUpdaterEmitMock,
  execFileSyncMock,
  loggerErrorMock,
  loggerInfoMock,
  loggerWarnMock,
  spawnMock,
  spawnOnMock,
  spawnUnrefMock,
} = vi.hoisted(() => ({
  appQuitMock: vi.fn(),
  autoUpdaterEmitMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  spawnMock: vi.fn(() => ({ pid: 4242, on: spawnOnMock, unref: spawnUnrefMock })),
  spawnOnMock: vi.fn(),
  spawnUnrefMock: vi.fn(),
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

vi.mock("electron", () => ({
  app: { quit: appQuitMock },
  autoUpdater: { emit: autoUpdaterEmitMock },
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  beforeEach(() => {
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
  });

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.gen(function* () {
      const cause = new Error("network unavailable");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "beta";

      const error = yield* updater.checkForUpdates.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.equal(error.channel, "beta");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Electron updater failed to check for updates on channel beta.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.gen(function* () {
      const cause = new Error("download unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.downloadUpdate.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to download the update on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("sets full changelog mode", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setFullChangelog(true);
      assert.equal(autoUpdaterMock.fullChangelog, true);

      yield* updater.setFullChangelog(false);
      assert.equal(autoUpdaterMock.fullChangelog, false);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "alpha";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.equal(error.channel, "alpha");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to quit and install the update on channel alpha (silent: true, force run after: false).",
      );
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  describe("safe AppImage install", () => {
    const ambientAppImage = process.env.APPIMAGE;
    let tempDirs: string[] = [];

    const trackTempDir = () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "safe-appimage-install-"));
      tempDirs.push(dir);
      return dir;
    };

    const sha512Base64 = (contents: string) =>
      NodeCrypto.createHash("sha512").update(contents, "utf8").digest("base64");

    const flushImmediate = () =>
      Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

    beforeEach(() => {
      tempDirs = [];
      delete process.env.APPIMAGE;
      autoUpdaterMock.downloadedUpdateHelper = null;
      autoUpdaterMock.logger = {
        info: loggerInfoMock,
        warn: loggerWarnMock,
        error: loggerErrorMock,
      };
      appQuitMock.mockClear();
      autoUpdaterEmitMock.mockClear();
      execFileSyncMock.mockClear();
      loggerErrorMock.mockClear();
      loggerInfoMock.mockClear();
      loggerWarnMock.mockClear();
      spawnMock.mockClear();
      spawnOnMock.mockClear();
      spawnUnrefMock.mockClear();
    });

    afterEach(() => {
      if (ambientAppImage === undefined) {
        delete process.env.APPIMAGE;
      } else {
        process.env.APPIMAGE = ambientAppImage;
      }
      for (const dir of tempDirs) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
      tempDirs = [];
    });

    it.effect("refuses to install when the downloaded AppImage is empty", () =>
      Effect.gen(function* () {
        const dir = trackTempDir();
        const appImage = NodePath.join(dir, "T3-Code-x86_64.AppImage");
        const installer = NodePath.join(dir, "pending.AppImage");
        NodeFS.writeFileSync(appImage, "running-binary");
        // The exact #10685 symptom: a 0-byte download where a verified artifact was expected.
        NodeFS.writeFileSync(installer, "");
        process.env.APPIMAGE = appImage;
        autoUpdaterMock.downloadedUpdateHelper = {
          file: installer,
          downloadedFileInfo: {
            fileName: "T3-Code-x86_64.AppImage",
            sha512: sha512Base64("expected-binary"),
          },
        };

        const updater = yield* ElectronUpdater.ElectronUpdater;
        const error = yield* updater
          .quitAndInstall({ isSilent: true, isForceRunAfter: true })
          .pipe(Effect.flip);

        assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
        assert.equal(autoUpdaterMock.quitAndInstall.mock.calls.length, 0);
        assert.equal(appQuitMock.mock.calls.length, 0);
        assert.equal(NodeFS.readFileSync(appImage, "utf8"), "running-binary");
        assert.deepEqual(
          NodeFS.readdirSync(dir).filter((entry) => entry.startsWith(".")),
          [],
        );
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );

    it.effect("refuses to install when the installer hash does not match", () =>
      Effect.gen(function* () {
        const dir = trackTempDir();
        const appImage = NodePath.join(dir, "T3-Code-x86_64.AppImage");
        const installer = NodePath.join(dir, "pending.AppImage");
        NodeFS.writeFileSync(appImage, "running-binary");
        NodeFS.writeFileSync(installer, "corrupted-binary");
        process.env.APPIMAGE = appImage;
        autoUpdaterMock.downloadedUpdateHelper = {
          file: installer,
          downloadedFileInfo: {
            fileName: "T3-Code-x86_64.AppImage",
            sha512: sha512Base64("expected-binary"),
          },
        };

        const updater = yield* ElectronUpdater.ElectronUpdater;
        const error = yield* updater
          .quitAndInstall({ isSilent: true, isForceRunAfter: true })
          .pipe(Effect.flip);

        assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
        assert.equal(autoUpdaterMock.quitAndInstall.mock.calls.length, 0);
        assert.equal(appQuitMock.mock.calls.length, 0);
        assert.equal(NodeFS.readFileSync(appImage, "utf8"), "running-binary");
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );

    it.effect("refuses to install when no update was downloaded", () =>
      Effect.gen(function* () {
        const dir = trackTempDir();
        const appImage = NodePath.join(dir, "T3-Code-x86_64.AppImage");
        NodeFS.writeFileSync(appImage, "running-binary");
        process.env.APPIMAGE = appImage;
        autoUpdaterMock.downloadedUpdateHelper = null;

        const updater = yield* ElectronUpdater.ElectronUpdater;
        const error = yield* updater
          .quitAndInstall({ isSilent: true, isForceRunAfter: true })
          .pipe(Effect.flip);

        assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
        assert.equal(autoUpdaterMock.quitAndInstall.mock.calls.length, 0);
        assert.equal(appQuitMock.mock.calls.length, 0);
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );

    it.effect("installs atomically on the same filesystem and relaunches", () =>
      Effect.gen(function* () {
        const dir = trackTempDir();
        const appImage = NodePath.join(dir, "T3-Code-x86_64.AppImage");
        const installer = NodePath.join(dir, "pending.AppImage");
        NodeFS.writeFileSync(appImage, "running-binary");
        NodeFS.writeFileSync(installer, "new-binary");
        process.env.APPIMAGE = appImage;
        autoUpdaterMock.downloadedUpdateHelper = {
          file: installer,
          downloadedFileInfo: {
            fileName: "T3-Code-x86_64.AppImage",
            sha512: sha512Base64("new-binary"),
          },
        };

        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });

        assert.equal(NodeFS.readFileSync(appImage, "utf8"), "new-binary");
        assert.equal(NodeFS.statSync(appImage).mode & 0o777, 0o755);
        assert.deepEqual(
          NodeFS.readdirSync(dir).filter((entry) => entry.startsWith(".")),
          [],
        );
        assert.equal(autoUpdaterMock.quitAndInstall.mock.calls.length, 0);
        assert.equal(spawnMock.mock.calls.length, 1);
        const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
          string,
          ReadonlyArray<string>,
          { readonly detached: boolean; readonly env: Record<string, string | undefined> },
        ];
        assert.equal(command, appImage);
        assert.deepEqual(args, []);
        assert.equal(options.detached, true);
        assert.equal(options.env.APPIMAGE_SILENT_INSTALL, "true");
        assert.equal(spawnUnrefMock.mock.calls.length, 1);
        assert.isAbove(loggerInfoMock.mock.calls.length, 0);

        yield* flushImmediate();
        assert.deepEqual(autoUpdaterEmitMock.mock.calls, [["before-quit-for-update"]]);
        assert.equal(appQuitMock.mock.calls.length, 1);
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );

    it.effect("runs the installer in place when relaunch after install is disabled", () =>
      Effect.gen(function* () {
        const dir = trackTempDir();
        const appImage = NodePath.join(dir, "T3-Code-x86_64.AppImage");
        const installer = NodePath.join(dir, "pending.AppImage");
        NodeFS.writeFileSync(appImage, "running-binary");
        NodeFS.writeFileSync(installer, "new-binary");
        process.env.APPIMAGE = appImage;
        autoUpdaterMock.downloadedUpdateHelper = {
          file: installer,
          downloadedFileInfo: {
            fileName: "T3-Code-x86_64.AppImage",
            sha512: sha512Base64("new-binary"),
          },
        };

        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: false });

        assert.equal(NodeFS.readFileSync(appImage, "utf8"), "new-binary");
        assert.equal(spawnMock.mock.calls.length, 0);
        assert.equal(execFileSyncMock.mock.calls.length, 1);
        const [command, args, options] = execFileSyncMock.mock.calls[0] as unknown as [
          string,
          ReadonlyArray<string>,
          { readonly env: Record<string, string | undefined> },
        ];
        assert.equal(command, appImage);
        assert.deepEqual(args, []);
        assert.equal(options.env.APPIMAGE_EXIT_AFTER_INSTALL, "true");

        yield* flushImmediate();
        assert.equal(appQuitMock.mock.calls.length, 1);
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );

    it.effect("never stages through a pre-planted symlink", () =>
      Effect.gen(function* () {
        const dir = trackTempDir();
        const appImage = NodePath.join(dir, "T3-Code-x86_64.AppImage");
        const installer = NodePath.join(dir, "pending.AppImage");
        const victim = NodePath.join(dir, "victim.txt");
        NodeFS.writeFileSync(appImage, "running-binary");
        NodeFS.writeFileSync(installer, "new-binary");
        NodeFS.writeFileSync(victim, "precious-data");
        // A predictable staging path would be followed here, overwriting the victim.
        NodeFS.symlinkSync(victim, NodePath.join(dir, ".T3-Code-x86_64.AppImage.t3-pending"));
        process.env.APPIMAGE = appImage;
        autoUpdaterMock.downloadedUpdateHelper = {
          file: installer,
          downloadedFileInfo: {
            fileName: "T3-Code-x86_64.AppImage",
            sha512: sha512Base64("new-binary"),
          },
        };

        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });

        assert.equal(NodeFS.readFileSync(victim, "utf8"), "precious-data");
        assert.equal(NodeFS.readFileSync(appImage, "utf8"), "new-binary");

        yield* flushImmediate();
        assert.equal(appQuitMock.mock.calls.length, 1);
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );

    it.effect("sweeps stale staging directories from killed installs", () =>
      Effect.gen(function* () {
        const dir = trackTempDir();
        const appImage = NodePath.join(dir, "T3-Code-x86_64.AppImage");
        const installer = NodePath.join(dir, "pending.AppImage");
        NodeFS.writeFileSync(appImage, "running-binary");
        NodeFS.writeFileSync(installer, "new-binary");
        const staleDir = NodePath.join(dir, ".t3-appimage-staging-deadbeef");
        NodeFS.mkdirSync(staleDir);
        NodeFS.writeFileSync(NodePath.join(staleDir, "pending.AppImage"), "stale-bytes");
        process.env.APPIMAGE = appImage;
        autoUpdaterMock.downloadedUpdateHelper = {
          file: installer,
          downloadedFileInfo: {
            fileName: "T3-Code-x86_64.AppImage",
            sha512: sha512Base64("new-binary"),
          },
        };

        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });

        assert.equal(NodeFS.readFileSync(appImage, "utf8"), "new-binary");
        assert.deepEqual(
          NodeFS.readdirSync(dir).filter((entry) => entry.startsWith(".")),
          [],
        );
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );

    it.effect("delegates to stock quitAndInstall when APPIMAGE is not set", () =>
      Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;

        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });

        assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, true]]);
        assert.equal(appQuitMock.mock.calls.length, 0);
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );

    it.effect("wires the electron-updater logger", () =>
      Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        const logger = { info: () => {}, warn: () => {}, error: () => {} };

        yield* updater.setLogger(logger);

        assert.strictEqual(autoUpdaterMock.logger, logger);
      }).pipe(
        Effect.provide(ElectronUpdater.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      ),
    );
  });
});
