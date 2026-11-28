// @effect-diagnostics nodeBuiltinImport:off -- Intercepts the spawn electron-updater requires natively.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { autoUpdater } from "electron-updater";
import type { VerifyUpdateCodeSignature } from "electron-updater";
import type * as NodeChildProcess from "node:child_process";
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

describe("ElectronUpdater Windows signature check", () => {
  const publisherNames = ["T3 Tools Inc"];
  const installerPath = "C:\\updater\\pending\\temp-T3-Code-x64.exe";
  // execFile marks the error killed when the verifier exceeds its 20-second timeout.
  const timedOut = () =>
    Object.assign(new Error("Command failed: powershell.exe"), { killed: true });
  const updater = autoUpdater as typeof autoUpdater & {
    verifyUpdateCodeSignature?: VerifyUpdateCodeSignature;
  };

  const downloadVerifyingSignature = () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(autoUpdater, "downloadUpdate").mockImplementationOnce(async () => {
            // NsisUpdater reads the current verifier and accepts only null as a valid signature.
            const rejection = await updater.verifyUpdateCodeSignature!(
              publisherNames,
              installerPath,
            );
            if (rejection !== null) throw new Error(`Invalid signature: ${rejection}`);
            return [];
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      return yield* Effect.flatMap(
        ElectronUpdater.ElectronUpdater,
        (electronUpdater) => electronUpdater.downloadUpdate,
      );
    }).pipe(Effect.scoped);

  const withVerifier = <A, E, R>(
    verify: VerifyUpdateCodeSignature,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        updater.verifyUpdateCodeSignature = verify;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          delete updater.verifyUpdateCodeSignature;
        }),
    );

  it.effect("downloads the update when the first Windows signature checks time out", () => {
    const verify = vi
      .fn<VerifyUpdateCodeSignature>()
      .mockRejectedValueOnce(timedOut())
      .mockRejectedValueOnce(timedOut())
      .mockRejectedValueOnce(timedOut())
      .mockResolvedValueOnce(null);
    return withVerifier(
      verify,
      Effect.gen(function* () {
        yield* downloadVerifyingSignature();
        assert.deepEqual(
          verify.mock.calls,
          Array.from({ length: 4 }, () => [publisherNames, installerPath]),
        );
      }),
    ).pipe(Effect.provide(ElectronUpdater.layer));
  });

  it.effect(
    "fails on invalid signatures, other errors and repeated timeouts on each download",
    () =>
      Effect.gen(function* () {
        const cases = [
          { outcome: () => Promise.resolve("Invalid publisher"), calls: 1 },
          { outcome: () => Promise.reject(new Error("Cannot execute PowerShell")), calls: 1 },
          { outcome: () => Promise.reject(timedOut()), calls: 5 },
        ];
        for (const { outcome, calls } of cases) {
          const verify = vi.fn<VerifyUpdateCodeSignature>(outcome);
          yield* withVerifier(
            verify,
            Effect.gen(function* () {
              // A second download must neither stack retries nor start with a spent budget.
              for (let download = 1; download <= 2; download++) {
                const error = yield* downloadVerifyingSignature().pipe(Effect.flip);
                assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
                assert.equal(verify.mock.calls.length, calls * download);
              }
            }),
          );
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("retries a check the upstream capability probe skipped, and never accepts one", () =>
    Effect.gen(function* () {
      const skipped = async () => {
        // electron-updater warns through the updater's logger, then resolves null unchecked.
        autoUpdater.logger?.warn(
          "Cannot execute ConvertTo-Json: spawnSync powershell.exe ETIMEDOUT. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.",
        );
        return null;
      };

      const recovers = vi
        .fn<VerifyUpdateCodeSignature>()
        .mockRejectedValueOnce(timedOut())
        .mockImplementationOnce(skipped)
        .mockResolvedValueOnce(null);
      yield* withVerifier(recovers, downloadVerifyingSignature());
      assert.equal(recovers.mock.calls.length, 3);

      const alwaysSkipped = vi
        .fn<VerifyUpdateCodeSignature>(skipped)
        .mockRejectedValueOnce(timedOut());
      const error = yield* withVerifier(
        alwaysSkipped,
        downloadVerifyingSignature().pipe(Effect.flip),
      );
      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(alwaysSkipped.mock.calls.length, 5);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
