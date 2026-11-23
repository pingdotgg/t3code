// @effect-diagnostics nodeBuiltinImport:off -- Cleans up the temp resources directory created in vi.hoisted.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DebUpdater, autoUpdater } from "electron-updater";
import { afterAll, beforeEach, expect, vi } from "vite-plus/test";

// Force electron-updater to instantiate DebUpdater by providing resources/package-type = "deb"
// and a stubbed electron module before importing ElectronUpdater.
const { electronStub, resourcesDir } = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const os = process.getBuiltinModule("node:os");
  const path = process.getBuiltinModule("node:path");
  const NodeModule = process.getBuiltinModule("node:module");
  const NodeEvents = process.getBuiltinModule("node:events");

  const tempResourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-deb-updater-res-"));
  fs.writeFileSync(path.join(tempResourcesDir, "package-type"), "deb");
  Object.defineProperty(process, "resourcesPath", {
    value: tempResourcesDir,
    configurable: true,
    writable: true,
  });

  const require = NodeModule.createRequire(import.meta.url);
  const electronPath = NodeModule.createRequire(require.resolve("electron-updater")).resolve(
    "electron",
  );
  const electronModule = new NodeModule.Module(electronPath);
  electronModule.filename = electronPath;
  electronModule.loaded = true;
  const stub = {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "T3 Code",
      isPackaged: true,
      relaunch: vi.fn(),
      quit: vi.fn(),
      once: vi.fn(),
    },
    autoUpdater: new NodeEvents.EventEmitter(),
  };
  electronModule.exports = stub;
  require.cache[electronPath] = electronModule;

  return { electronStub: stub, resourcesDir: tempResourcesDir };
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

afterAll(() => {
  NodeFS.rmSync(resourcesDir, { recursive: true, force: true });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater DebUpdater async install",
  () => {
    beforeEach(() => {
      electronStub.app.relaunch.mockReset();
      electronStub.app.quit.mockReset();
      autoUpdater.logger = null;
      Object.assign(autoUpdater, { quitAndInstallCalled: false });
    });

    it.live(
      "runs .deb install asynchronously without blocking the event loop and detaches stdio",
      () =>
        Effect.gen(function* () {
          assert.isTrue(autoUpdater instanceof DebUpdater);
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-deb-install-" });
          const fakeBinDir = path.join(dir, "bin");
          yield* fileSystem.makeDirectory(fakeBinDir);
          const debPath = path.join(dir, "T3-Code-1.0.1-amd64.deb");
          const reportPath = path.join(dir, "pkexec-report.txt");
          const startedPath = path.join(dir, "pkexec-started");
          const releasePath = path.join(dir, "pkexec-release");
          yield* fileSystem.writeFileString(debPath, "fake deb");

          // Stub dpkg and pkexec so pkexec waits for a marker file written by this test on the
          // same event loop—a synchronous spawnSync would deadlock here instead of completing.
          const fakeDpkg = path.join(fakeBinDir, "dpkg");
          yield* fileSystem.writeFileString(fakeDpkg, "#!/bin/sh\nexit 0\n");
          yield* fileSystem.chmod(fakeDpkg, 0o755);

          const fakePkexec = path.join(fakeBinDir, "pkexec");
          yield* fileSystem.writeFileString(
            fakePkexec,
            [
              "#!/bin/sh",
              'fd1="$(/usr/bin/readlink "/proc/$$/fd/1")"',
              'fd2="$(/usr/bin/readlink "/proc/$$/fd/2")"',
              'sid="$(/usr/bin/cut -d" " -f6 "/proc/$$/stat")"',
              `printf 'started\\n' > '${startedPath}'`,
              `while [ ! -f '${releasePath}' ]; do :; done`,
              `{`,
              `  printf 'ARGS:%s\\n' "$*"`,
              `  printf 'FD1:%s\\n' "$fd1"`,
              `  printf 'FD2:%s\\n' "$fd2"`,
              `  printf 'PID:%s\\n' "$$"`,
              `  printf 'SID:%s\\n' "$sid"`,
              `} > '${reportPath}'`,
              "exit 0",
            ].join("\n") + "\n",
          );
          yield* fileSystem.chmod(fakePkexec, 0o755);

          yield* Effect.acquireRelease(
            Effect.sync(() => vi.stubEnv("PATH", fakeBinDir)),
            () => Effect.sync(() => vi.unstubAllEnvs()),
          );

          Object.assign(autoUpdater, {
            downloadedUpdateHelper: {
              file: debPath,
              downloadedFileInfo: { isAdminRightsRequired: true },
            },
          });

          let beforeQuitForUpdateCount = 0;
          const onBeforeQuitForUpdate = () => {
            beforeQuitForUpdateCount += 1;
          };
          electronStub.autoUpdater.on("before-quit-for-update", onBeforeQuitForUpdate);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              electronStub.autoUpdater.removeListener(
                "before-quit-for-update",
                onBeforeQuitForUpdate,
              );
            }),
          );

          const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
          const fiber = yield* electronUpdater
            .quitAndInstall({ isSilent: true, isForceRunAfter: true })
            .pipe(Effect.forkChild);

          yield* Effect.promise(() => expect.poll(() => NodeFS.existsSync(startedPath)).toBe(true));
          yield* fileSystem.writeFileString(releasePath, "go");
          yield* Fiber.join(fiber);

          assert.equal(electronStub.app.relaunch.mock.calls.length, 1);
          assert.equal(beforeQuitForUpdateCount, 1);
          assert.equal(electronStub.app.quit.mock.calls.length, 1);

          const report = yield* fileSystem.readFileString(reportPath);
          assert.include(report, `ARGS:--disable-internal-agent dpkg -i ${debPath}`);
          assert.include(report, "FD1:/dev/null");
          assert.include(report, "FD2:/dev/null");

          const pidMatch = report.match(/^PID:(\d+)$/m);
          const sidMatch = report.match(/^SID:(\d+)$/m);
          assert.isNotNull(pidMatch);
          assert.isNotNull(sidMatch);
          // Detached child starts its own session (SID === PID).
          assert.equal(sidMatch?.[1], pidMatch?.[1]);
        }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );

    it.live("does not run apt-get fallback when pkexec is cancelled (126) and allows retry", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-deb-cancel-" });
        const fakeBinDir = path.join(dir, "bin");
        yield* fileSystem.makeDirectory(fakeBinDir);
        const debPath = path.join(dir, "T3-Code-1.0.1-amd64.deb");
        const callsPath = path.join(dir, "calls.log");
        yield* fileSystem.writeFileString(debPath, "fake deb");

        const fakeDpkg = path.join(fakeBinDir, "dpkg");
        yield* fileSystem.writeFileString(fakeDpkg, "#!/bin/sh\nexit 0\n");
        yield* fileSystem.chmod(fakeDpkg, 0o755);

        const fakePkexec = path.join(fakeBinDir, "pkexec");
        yield* fileSystem.writeFileString(
          fakePkexec,
          [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >> '${callsPath}'`,
            `if [ ! -f '${path.join(dir, "allow-success")}' ]; then exit 126; fi`,
            "exit 0",
          ].join("\n") + "\n",
        );
        yield* fileSystem.chmod(fakePkexec, 0o755);

        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("PATH", fakeBinDir)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: debPath,
            downloadedFileInfo: { isAdminRightsRequired: true },
          },
        });

        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        const firstExit = yield* Effect.exit(
          electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true }),
        );
        assert.isTrue(Exit.isFailure(firstExit));
        assert.equal(electronStub.app.relaunch.mock.calls.length, 0);
        assert.equal(electronStub.app.quit.mock.calls.length, 0);

        const firstCalls = (yield* fileSystem.readFileString(callsPath)).trim().split("\n");
        assert.equal(firstCalls.length, 1, "cancelled pkexec must not invoke apt-get fallback");

        // Second attempt after reset should succeed.
        yield* fileSystem.writeFileString(path.join(dir, "allow-success"), "1");
        yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        assert.equal(electronStub.app.relaunch.mock.calls.length, 1);
        assert.equal(electronStub.app.quit.mock.calls.length, 1);
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );

    it.live("falls back to apt-get install -f -y when dpkg exits with a dependency error", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-deb-fallback-" });
        const fakeBinDir = path.join(dir, "bin");
        yield* fileSystem.makeDirectory(fakeBinDir);
        const debPath = path.join(dir, "T3-Code-1.0.1-amd64.deb");
        const callsPath = path.join(dir, "calls.log");
        yield* fileSystem.writeFileString(debPath, "fake deb");

        const fakeDpkg = path.join(fakeBinDir, "dpkg");
        yield* fileSystem.writeFileString(fakeDpkg, "#!/bin/sh\nexit 0\n");
        yield* fileSystem.chmod(fakeDpkg, 0o755);

        const fakePkexec = path.join(fakeBinDir, "pkexec");
        yield* fileSystem.writeFileString(
          fakePkexec,
          [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >> '${callsPath}'`,
            'case "$*" in',
            '  *"dpkg -i"*) exit 1 ;;',
            '  *"apt-get install -f -y"*) exit 0 ;;',
            "  *) exit 2 ;;",
            "esac",
          ].join("\n") + "\n",
        );
        yield* fileSystem.chmod(fakePkexec, 0o755);

        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("PATH", fakeBinDir)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: debPath,
            downloadedFileInfo: { isAdminRightsRequired: true },
          },
        });

        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });

        const calls = (yield* fileSystem.readFileString(callsPath)).trim().split("\n");
        assert.deepEqual(calls, [
          `--disable-internal-agent dpkg -i ${debPath}`,
          "--disable-internal-agent apt-get install -f -y",
        ]);
        assert.equal(electronStub.app.relaunch.mock.calls.length, 1);
        assert.equal(electronStub.app.quit.mock.calls.length, 1);
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);
