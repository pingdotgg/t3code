// @effect-diagnostics nodeBuiltinImport:off -- mkfifo and the vi.hoisted resources directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DebUpdater, autoUpdater } from "electron-updater";
import { afterAll, vi } from "vite-plus/test";

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

// ElectronUpdater emits on the app's own Electron import; electron-updater gets the same stub natively.
vi.mock("electron", () => electronStub);

import * as ElectronUpdater from "./ElectronUpdater.ts";

afterAll(() => {
  NodeFS.rmSync(resourcesDir, { recursive: true, force: true });
});

const writeScript = (path: string, lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(path, `#!/bin/sh\n${lines.join("\n")}\n`);
    yield* fileSystem.chmod(path, 0o755);
  });

// Stages fake trusted system binaries (`dpkg`, `apt-get`, `pkexec`) and a downloaded .deb,
// independent of the runner's UID and caller PATH.
const stageDebInstall = (pkexec: (dir: string) => ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-deb-install-" });
    const binDir = path.join(dir, "bin");
    yield* fileSystem.makeDirectory(binDir);
    const debPath = path.join(dir, "T3-Code-1.0.1-amd64.deb");
    yield* fileSystem.writeFileString(debPath, "fake deb");
    yield* writeScript(path.join(binDir, "dpkg"), ["exit 0"]);
    yield* writeScript(path.join(binDir, "apt-get"), ["exit 0"]);
    yield* writeScript(path.join(binDir, "pkexec"), pkexec(dir));
    // Ensure non-root privilege path is exercised even when tests run as root.
    if (typeof process.getuid === "function") {
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(process, "getuid").mockReturnValue(1000)),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
    }
    Object.assign(autoUpdater, {
      quitAndInstallCalled: false,
      downloadedUpdateHelper: {
        file: debPath,
        downloadedFileInfo: { isAdminRightsRequired: true },
      },
    });
    electronStub.app.relaunch.mockReset();
    electronStub.app.quit.mockReset();
    const updater = ElectronUpdater.makeWithOptions({ systemBinDirs: [binDir] });
    return { dir, binDir, debPath, updater };
  });

const unblockFifo = (fifoPath: string, flags: number) =>
  Effect.sync(() => {
    try {
      const fd = NodeFS.openSync(fifoPath, flags | NodeFS.constants.O_NONBLOCK);
      NodeFS.closeSync(fd);
    } catch {
      // No peer was waiting on the FIFO.
    }
  });

const raceWithInstallExit = <A, E, R>(
  step: Effect.Effect<A, E, R>,
  install: Fiber.Fiber<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>,
  unblock: Effect.Effect<void>,
  stage: string,
) =>
  Effect.raceFirst(
    step.pipe(Effect.map((value) => ({ _tag: "step" as const, value }))),
    Fiber.await(install).pipe(
      Effect.tap(() => unblock),
      Effect.map((exit) => ({ _tag: "exited" as const, exit })),
    ),
  ).pipe(
    Effect.flatMap((result) =>
      result._tag === "step"
        ? Effect.succeed(result.value)
        : Effect.sync(() =>
            assert.fail(`Installer exited before ${stage}: ${String(result.exit)}`),
          ),
    ),
  );

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater .deb install",
  () => {
    it.live("installs without blocking the main thread, detached from the app's stdio", () =>
      Effect.gen(function* () {
        assert.isTrue(autoUpdater instanceof DebUpdater);
        autoUpdater.logger = null;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dir, binDir, debPath, updater } = yield* stageDebInstall((dir) => [
          'fd1="$(/usr/bin/readlink /proc/$$/fd/1)"',
          // Bounded so a blocking install fails the test instead of hanging the worker.
          `/usr/bin/timeout 10 /bin/sh -c "printf started > '${dir}/started'; read _ < '${dir}/release'"`,
          `{`,
          `  printf 'ARGS:%s\\n' "$*"`,
          `  printf 'FD1:%s\\n' "$fd1"`,
          `  printf 'PID:%s\\n' "$$"`,
          `  printf 'SID:%s\\n' "$(/usr/bin/cut -d' ' -f6 /proc/$$/stat)"`,
          `} > '${dir}/report'`,
        ]);
        const started = path.join(dir, "started");
        const release = path.join(dir, "release");
        NodeChildProcess.execFileSync("/usr/bin/mkfifo", [started, release]);

        let beforeQuitForUpdate = 0;
        const onBeforeQuitForUpdate = () => {
          beforeQuitForUpdate += 1;
        };
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            electronStub.autoUpdater.on("before-quit-for-update", onBeforeQuitForUpdate),
          ),
          () =>
            Effect.sync(() =>
              electronStub.autoUpdater.removeListener(
                "before-quit-for-update",
                onBeforeQuitForUpdate,
              ),
            ),
        );

        const install = yield* updater
          .quitAndInstall({ isSilent: true, isForceRunAfter: true })
          .pipe(Effect.forkChild);
        // Both FIFOs need this event loop while pkexec runs; a spawnSync install deadlocks here.
        yield* raceWithInstallExit(
          fileSystem.readFileString(started),
          install,
          unblockFifo(started, NodeFS.constants.O_WRONLY),
          "FIFO started signal",
        );
        yield* raceWithInstallExit(
          fileSystem.writeFileString(release, "go\n"),
          install,
          unblockFifo(release, NodeFS.constants.O_RDONLY),
          "FIFO release handshake",
        );
        yield* Fiber.join(install);

        assert.equal(electronStub.app.relaunch.mock.calls.length, 1);
        assert.equal(electronStub.app.quit.mock.calls.length, 1);
        assert.equal(beforeQuitForUpdate, 1);
        const report = yield* fileSystem.readFileString(path.join(dir, "report"));
        assert.include(
          report,
          `ARGS:--disable-internal-agent ${path.join(binDir, "dpkg")} -i ${debPath}`,
        );
        assert.include(report, "FD1:/dev/null");
        // A detached child leads its own session.
        assert.equal(report.match(/^SID:(\d+)$/m)?.[1], report.match(/^PID:(\d+)$/m)?.[1]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("a dismissed prompt skips the apt-get repair and the install can be retried", () =>
      Effect.gen(function* () {
        autoUpdater.logger = null;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dir, binDir, debPath, updater } = yield* stageDebInstall((dir) => [
          `printf '%s\\n' "$*" >> '${dir}/calls'`,
          `[ -f '${dir}/authorized' ] || exit 126`,
          'case "$*" in *"dpkg -i"*) exit 1 ;; esac',
        ]);
        const readCalls = fileSystem
          .readFileString(path.join(dir, "calls"))
          .pipe(Effect.map((calls) => calls.trim().split("\n")));

        const errors: Array<unknown> = [];
        yield* updater.on("error", (error: unknown) => errors.push(error));

        // Failures reach DesktopUpdates through the updater's error event, as upstream's do.
        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        assert.equal(errors.length, 1);
        assert.deepEqual(yield* readCalls, [
          `--disable-internal-agent ${path.join(binDir, "dpkg")} -i ${debPath}`,
        ]);
        assert.equal(electronStub.app.quit.mock.calls.length, 0);

        // dpkg now fails on dependencies, so the retry repairs them with apt-get.
        yield* fileSystem.writeFileString(path.join(dir, "authorized"), "");
        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        assert.deepEqual((yield* readCalls).slice(1), [
          `--disable-internal-agent ${path.join(binDir, "dpkg")} -i ${debPath}`,
          `--disable-internal-agent ${path.join(binDir, "apt-get")} install -f -y`,
        ]);
        assert.equal(electronStub.app.relaunch.mock.calls.length, 1);
        assert.equal(electronStub.app.quit.mock.calls.length, 1);
        assert.equal(errors.length, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("honors ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER=apt when both dpkg and apt exist", () =>
      Effect.gen(function* () {
        autoUpdater.logger = null;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dir, binDir, debPath, updater } = yield* stageDebInstall((dir) => [
          `printf '%s\\n' "$*" >> '${dir}/calls'`,
        ]);
        yield* writeScript(path.join(binDir, "apt"), ["exit 0"]);
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER", "apt")),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });

        const calls = (yield* fileSystem.readFileString(path.join(dir, "calls")))
          .trim()
          .split("\n");
        assert.deepEqual(calls, [
          `--disable-internal-agent ${path.join(binDir, "apt")} install -y --allow-unauthenticated --allow-downgrades --allow-change-held-packages ${debPath}`,
        ]);
        assert.equal(electronStub.app.relaunch.mock.calls.length, 1);
        assert.equal(electronStub.app.quit.mock.calls.length, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
