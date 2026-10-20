// @effect-diagnostics nodeBuiltinImport:off -- Build real electron-updater disk fixtures with its SHA-512 encoding.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { AppImageUpdater } from "electron-updater/out/AppImageUpdater.js";
import { DebUpdater } from "electron-updater/out/DebUpdater.js";
import { MacUpdater } from "electron-updater/out/MacUpdater.js";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import {
  CancellationToken,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater/out/types.js";
import { NsisUpdater } from "electron-updater/out/NsisUpdater.js";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "../updates/updatesTestHarness.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { VerifyUpdateCodeSignature } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

const { autoUpdaterMock, updaterOverride } = vi.hoisted(() => ({
  updaterOverride: { current: undefined as import("electron-updater").AppUpdater | undefined },
  autoUpdaterMock: {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: "latest",
    disableDifferentialDownload: false,
    fullChangelog: false,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    verifyUpdateCodeSignature: undefined as VerifyUpdateCodeSignature | undefined,
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  get autoUpdater() {
    return updaterOverride.current ?? autoUpdaterMock;
  },
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
    autoUpdaterMock.verifyUpdateCodeSignature = undefined;
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

  describe("Windows update signature check", () => {
    const publisherNames = ["T3 Tools Inc"];
    const installerPath = "C:\\updater\\pending\\temp-T3-Code-x64.exe";
    // execFile marks the error killed when the verifier exceeds its 20-second timeout.
    const timedOut = () =>
      Object.assign(new Error("Command failed: powershell.exe"), { killed: true });

    const downloadVerifyingSignature = () => {
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
        const rejection = await autoUpdaterMock.verifyUpdateCodeSignature!(
          publisherNames,
          installerPath,
        );
        // NSIS accepts only null as a successful signature check.
        if (rejection !== null) throw new Error(`Invalid signature: ${rejection}`);
        return [];
      });
      return Effect.flatMap(ElectronUpdater.ElectronUpdater, (updater) => updater.downloadUpdate);
    };

    it.effect("retries a timed-out signature check with the same verifier and installer", () =>
      Effect.gen(function* () {
        const verify = vi
          .fn<VerifyUpdateCodeSignature>()
          .mockRejectedValueOnce(timedOut())
          .mockResolvedValueOnce(null);
        autoUpdaterMock.verifyUpdateCodeSignature = verify;

        yield* downloadVerifyingSignature();

        assert.deepEqual(verify.mock.calls, [
          [publisherNames, installerPath],
          [publisherNames, installerPath],
        ]);
      }).pipe(Effect.provide(ElectronUpdater.layer)),
    );

    it.effect("fails on invalid signatures, other errors and two timeouts on each download", () =>
      Effect.gen(function* () {
        const cases = [
          { outcome: () => Promise.resolve("Invalid publisher"), calls: 1 },
          { outcome: () => Promise.reject(new Error("Cannot execute PowerShell")), calls: 1 },
          { outcome: () => Promise.reject(timedOut()), calls: 2 },
        ];
        for (const { outcome, calls } of cases) {
          const verify = vi.fn<VerifyUpdateCodeSignature>(outcome);
          autoUpdaterMock.verifyUpdateCodeSignature = verify;

          // Reusing the installed verifier must neither stack retries nor exhaust future retries.
          for (let download = 1; download <= 2; download++) {
            const error = yield* downloadVerifyingSignature().pipe(Effect.flip);
            assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
            assert.equal(verify.mock.calls.length, calls * download);
          }
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
    );

    it.effect("rejects a retry when the upstream capability probe skips verification", () =>
      Effect.gen(function* () {
        const verify = vi
          .fn<VerifyUpdateCodeSignature>()
          .mockRejectedValueOnce(timedOut())
          .mockImplementationOnce(async () => {
            // Upstream resolves null even though its failed capability probe skips verification.
            autoUpdaterMock.logger.warn(
              "Cannot execute ConvertTo-Json: spawnSync powershell.exe ETIMEDOUT. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.",
            );
            return null;
          });
        autoUpdaterMock.verifyUpdateCodeSignature = verify;

        const error = yield* downloadVerifyingSignature().pipe(Effect.flip);

        assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
        assert.equal(verify.mock.calls.length, 2);
      }).pipe(Effect.provide(ElectronUpdater.layer)),
    );
  });
});

describe("installed electron-updater cache recovery", () => {
  it.effect.each([
    {
      name: "Intel Mac",
      platform: "darwin",
      Updater: MacUpdater,
      selected: "x64.zip",
      other: "arm64.zip",
      rosetta: false,
    },
    {
      name: "Apple Silicon running Intel",
      platform: "darwin",
      Updater: MacUpdater,
      selected: "arm64.zip",
      other: "x64.zip",
      rosetta: true,
    },
    {
      name: "Windows",
      platform: "win32",
      Updater: NsisUpdater,
      selected: "x64.exe",
      other: "arm64.exe",
      rosetta: false,
    },
    {
      name: "Debian",
      platform: "linux",
      Updater: DebUpdater,
      selected: "x64.deb",
      other: "x64.AppImage",
      rosetta: false,
    },
    {
      name: "AppImage",
      platform: "linux",
      Updater: AppImageUpdater,
      selected: "x64.AppImage",
      other: "x64.deb",
      rosetta: false,
    },
  ] as const)("restores only the package selected by $name", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const cacheDirectory = NodePath.join(directory, "custom-updater-cache", "pending");
        const configPath = NodePath.join(directory, "app-update.yml");
        yield* fs.writeFileString(configPath, "updaterCacheDirName: custom-updater-cache\n");
        yield* fs.makeDirectory(cacheDirectory, { recursive: true });

        const require = NodeModule.createRequire(import.meta.url);
        require("electron");
        const electronModule = require.cache[require.resolve("electron")]!;
        const childProcess = require("node:child_process") as typeof import("node:child_process");
        const originalElectron = electronModule.exports;
        const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            // MacUpdater's native Squirrel bridge and host probes are OS boundaries.
            electronModule.exports = { autoUpdater: new NodeEvents.EventEmitter() };
            Object.defineProperty(process, "arch", { value: "x64", configurable: true });
            return vi
              .spyOn(childProcess, "execFileSync")
              .mockReturnValue(scenario.rosetta ? "sysctl.proc_translated: 1" : "x86_64");
          }),
          (probe) =>
            Effect.sync(() => {
              probe.mockRestore();
              Object.defineProperty(process, "arch", originalArch);
              electronModule.exports = originalElectron;
              updaterOverride.current = undefined;
            }),
        );

        const extensions =
          scenario.platform === "darwin"
            ? ["arm64.dmg", "x64.dmg", "arm64.zip", "x64.zip"]
            : scenario.platform === "win32"
              ? ["arm64.exe", "x64.exe"]
              : ["arm64.AppImage", "x64.AppImage", "arm64.deb", "x64.deb"];
        const files = extensions.map((extension) => {
          const url = `T3-Code-1.2.4-${extension}`;
          return { url, sha512: NodeCrypto.createHash("sha512").update(url).digest("base64") };
        });
        const info = {
          version: "1.2.4",
          releaseDate: "2026-10-01T00:00:00Z",
          files,
          path: files[0]!.url,
          sha512: files[0]!.sha512,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(GenericProvider.prototype, "getLatestVersion").mockResolvedValue(info),
          ),
          (feed) => Effect.sync(() => feed.mockRestore()),
        );

        // A fresh instance for each launch forces disk validation rather than in-memory reuse.
        yield* Effect.forEach([scenario.other, scenario.selected], (cachedExtension) =>
          Effect.scoped(
            Effect.gen(function* () {
              const cached = files.find((file) => file.url.endsWith(`-${cachedExtension}`))!;
              yield* fs.writeFileString(NodePath.join(cacheDirectory, cached.url), cached.url);
              yield* fs.writeFileString(
                NodePath.join(cacheDirectory, "update-info.json"),
                JSON.stringify({
                  fileName: cached.url,
                  sha512: cached.sha512,
                  isAdminRightsRequired: false,
                }),
              );
              const updater = new scenario.Updater(undefined, {
                version: "1.2.3",
                name: "T3 Code",
                isPackaged: true,
                appUpdateConfigPath: configPath,
                userDataPath: directory,
                baseCachePath: directory,
                whenReady: () => Promise.resolve(),
                relaunch: vi.fn(),
                quit: vi.fn(),
                onQuit: vi.fn(),
              });
              updater.logger = null;
              const networkDownload = vi.fn(() =>
                Promise.reject(new Error("unexpected network download")),
              );
              Object.assign(updater, { httpExecutor: { download: networkDownload } });
              if (updater instanceof MacUpdater) {
                // Keep real selection, executeDownload, and hash validation; stop at native handoff.
                Object.assign(updater, {
                  updateDownloaded: async (_file: unknown, event: UpdateDownloadedEvent) => {
                    updater.emit("update-downloaded", event);
                    return [];
                  },
                });
              }
              updaterOverride.current = updater;
              assert.deepEqual(
                yield* ElectronUpdater.make.pendingDownloadDirectory,
                Option.some(cacheDirectory),
              );

              const inspected = Deferred.makeUnsafe<void>();
              const downloadFinished = Deferred.makeUnsafe<void>();
              const download = vi.spyOn(updater, "downloadUpdate");
              const harness = makeHarness({
                platform: scenario.platform,
                runningUnderArm64Translation: scenario.rosetta,
                env: scenario.selected.endsWith("AppImage")
                  ? { APPIMAGE: "/test/T3-Code.AppImage" }
                  : {},
                updater: {
                  ...ElectronUpdater.make,
                  downloadUpdate: ElectronUpdater.make.downloadUpdate.pipe(
                    Effect.ensuring(Deferred.succeed(downloadFinished, undefined)),
                  ),
                },
                fileSystem: {
                  ...fs,
                  readFileString: (path, encoding) =>
                    path === "/missing/resources/package-type" && scenario.selected.endsWith("deb")
                      ? Effect.succeed("deb")
                      : fs.readFileString(path, encoding),
                  exists: (path) =>
                    fs.exists(path).pipe(Effect.tap(() => Deferred.succeed(inspected, undefined))),
                },
              });
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const updates = yield* DesktopUpdates.DesktopUpdates;
                  yield* updates.configure;
                  // AppImage activation reads the host environment; the fixture is intentionally not installed.
                  vi.spyOn(updater, "isUpdaterActive").mockReturnValue(true);
                  assert.isTrue((yield* updates.check("startup")).checked);
                  yield* Deferred.await(inspected);
                  yield* flushCallbacks;

                  if (cachedExtension === scenario.other) {
                    assert.equal(download.mock.calls.length, 0);
                    assert.equal((yield* updates.getState).status, "available");
                  } else {
                    yield* Deferred.await(downloadFinished);
                    yield* flushCallbacks;
                    assert.equal(download.mock.calls.length, 1);
                    assert.equal((yield* updates.getState).status, "downloaded");
                    assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
                  }
                  assert.equal(networkDownload.mock.calls.length, 0);
                }),
              ).pipe(Effect.provide(harness.layer));
            }),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("installed Windows updater package selection", () => {
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  const hosts = [
    { name: "native ARM64", arch: "arm64", translated: false, installerArch: "arm64" },
    { name: "x64 under Prism", arch: "x64", translated: true, installerArch: "arm64" },
    { name: "native x64", arch: "x64", translated: false, installerArch: "x64" },
  ];
  const installer = (arch: string) => `T3-Code-1.2.4-${arch}.exe`;
  const manifest = (...names: string[]): UpdateInfo => ({
    version: "1.2.4",
    releaseDate: "2026-10-01T00:00:00.000Z",
    path: names[0]!,
    sha512: "legacy-checksum",
    files: names.map((url) => ({ url, sha512: `${url}-checksum`, size: 100 })),
  });

  beforeEach(() => {
    vi.stubEnv("PROCESSOR_ARCHITEW6432", undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, "arch", originalArch);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeWindowsUpdater(host: (typeof hosts)[number]) {
    Object.defineProperty(process, "arch", { ...originalArch, value: host.arch });
    const app = {
      app: { runningUnderARM64Translation: host.translated },
      version: "1.2.3",
      name: "T3 Code",
      isPackaged: true,
      appUpdateConfigPath: "/unused/app-update.yml",
      userDataPath: "/unused/user-data",
      baseCachePath: "/unused/cache",
      whenReady: () => Promise.resolve(),
      relaunch: vi.fn(),
      quit: vi.fn(),
      onQuit: vi.fn(),
    };
    // Stop before filesystem, network, signature verification, or installer execution.
    class CapturingNsisUpdater extends NsisUpdater {
      override executeDownload = vi.fn((task: DownloadExecutorTask) =>
        Promise.resolve([task.fileInfo.url.href]),
      );

      async selectInstaller(info: UpdateInfo) {
        return this.doDownloadUpdate({
          updateInfoAndProvider: { info, provider },
          requestHeaders: {},
          cancellationToken: new CancellationToken(),
        });
      }
    }
    const updater = new CapturingNsisUpdater(null, app);
    const executor = new ElectronHttpExecutor();
    vi.spyOn(executor, "createRequest").mockImplementation(() => {
      throw new Error("Updater selection must not make network requests");
    });
    const provider = new GenericProvider(
      { provider: "generic", url: "https://updates.example.invalid/" },
      updater,
      { platform: "win32", isUseMultipleRangeRequest: false, executor },
    );
    return updater;
  }

  it.each(hosts)(
    "selects the host installer on $name regardless of manifest order",
    async (host) => {
      const updater = makeWindowsUpdater(host);
      const files = [installer("x64"), installer("arm64")];
      for (const order of [files, files.toReversed()]) {
        await expect(updater.selectInstaller(manifest(...order))).resolves.toEqual([
          `https://updates.example.invalid/${installer(host.installerArch)}`,
        ]);
      }
    },
  );

  it.each(hosts)("refuses an opposite-architecture-only release on $name", async (host) => {
    const updater = makeWindowsUpdater(host);
    const opposite = host.installerArch === "arm64" ? "x64" : "arm64";
    await expect(updater.selectInstaller(manifest(installer(opposite)))).rejects.toThrow();
    expect(updater.executeDownload).not.toHaveBeenCalled();
  });

  it("keeps legacy untagged manifests usable", async () => {
    const updater = makeWindowsUpdater(hosts[0]!);
    await expect(updater.selectInstaller(manifest("T3-Code-setup.exe"))).resolves.toEqual([
      "https://updates.example.invalid/T3-Code-setup.exe",
    ]);
  });
});
