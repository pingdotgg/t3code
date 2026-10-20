// @effect-diagnostics nodeBuiltinImport:off -- The relaunch regression needs a separate parent process that really exits.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const electronAppLayer = ElectronApp.layer.pipe(Layer.provide(NodeServices.layer));

describe("ElectronApp", () => {
  beforeEach(() => {
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
    }).pipe(
      Effect.provide(electronAppLayer),
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
  );

  it.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "keeps the detached Linux relaunch alive until parent exit without setting NoNewPrivs",
    async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 relaunch "));
      const executable = NodePath.join(directory, "node $HOME (Nightly)");
      await NodeFSP.symlink(process.execPath, executable);
      const server = NodeNet.createServer();
      const listening = NodeEvents.EventEmitter.once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing TCP port");
      let restarted = false;
      const result = new Promise<string>((resolve, reject) => {
        server.once("connection", (socket) => {
          restarted = true;
          let output = "";
          socket.setEncoding("utf8");
          socket.on("data", (chunk) => {
            output += chunk;
          });
          socket.once("end", () => resolve(output));
          socket.once("error", reject);
        });
      });
      const args = ["two words", "$HOME", "$(printf expanded)", "'quoted'", "", "line\nbreak"];
      // Node stands in for the relaunched executable; Electron itself is never launched.
      const restartedScript = `
        const fs = require("node:fs");
        const net = require("node:net");
        const socket = net.connect(Number(process.argv[1]), "127.0.0.1", () => {
          socket.end(JSON.stringify({
            args: process.argv.slice(2),
            status: fs.readFileSync("/proc/self/status", "utf8"),
          }));
        });
      `;
      const parentScript = `
        import * as Effect from "effect/Effect";
        import * as Layer from "effect/Layer";
        import * as NodeServices from "@effect/platform-node/NodeServices";
        import * as Spawner from "effect/process/ChildProcessSpawner";
        import * as App from "./src/electron/ElectronApp.ts";
        import { readFileSync } from "node:fs";
        let handle;
        const capture = Layer.effect(Spawner.ChildProcessSpawner, Effect.gen(function* () {
          const actual = yield* Spawner.ChildProcessSpawner;
          return Spawner.make(command => actual.spawn(command).pipe(Effect.tap(value => {
            handle = value;
            return Effect.void;
          })));
        })).pipe(Layer.provide(NodeServices.layer));
        await Effect.runPromise(Effect.gen(function* () {
          const app = yield* App.ElectronApp;
          yield* app.relaunch(${JSON.stringify({ execPath: executable, args: ["-e", restartedScript, String(address.port), ...args] })});
        }).pipe(Effect.provide(App.layer.pipe(Layer.provide(capture)))));
        process.stdout.write(JSON.stringify({
          pid: handle.pid,
          running: await Effect.runPromise(handle.isRunning),
          status: readFileSync("/proc/self/status", "utf8"),
        }) + "\\n");
        process.stdin.resume();
        process.stdin.once("end", () => process.exit(0));
      `;
      const parent = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "-e", parentScript],
        {
          cwd: NodeURL.fileURLToPath(new URL("../..", import.meta.url)),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const exited = NodeEvents.EventEmitter.once(parent, "exit");
      let stderr = "";
      parent.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      let shellPid: number | undefined;
      try {
        const ready = await Promise.race([
          NodeEvents.EventEmitter.once(parent.stdout, "data").then(([data]) =>
            JSON.parse(String(data)),
          ),
          exited.then(([code]) => {
            throw new Error(`Relaunch parent exited: ${code} ${stderr}`);
          }),
        ]);
        shellPid = ready.pid;
        assert.isNumber(shellPid);
        assert.isTrue(ready.running, "relauncher survives its Effect scope closing");
        assert.match(ready.status, /^NoNewPrivs:\s+0$/m);
        const stat = await NodeFSP.readFile(`/proc/${shellPid}/stat`, "utf8");
        const [, ppid, group, session] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        assert.equal(Number(ppid), parent.pid);
        assert.equal(Number(group), shellPid, "detached process group");
        assert.equal(Number(session), shellPid, "detached session");
        assert.equal(
          await NodeFSP.readlink(`/proc/${shellPid}/exe`),
          await NodeFSP.realpath("/bin/sh"),
          "the shell must still be waiting, even if the replacement executable starts slowly",
        );
        assert.isFalse(restarted, "stdin remains open after the relaunch scope closes");

        parent.stdin.end();
        assert.deepEqual(await exited, [0, null]);
        const launched = JSON.parse(await result);
        assert.deepEqual(launched.args, args);
        assert.match(launched.status, /^NoNewPrivs:\s+0$/m);
      } finally {
        if (parent.exitCode === null) parent.kill();
        if (shellPid !== undefined) {
          try {
            process.kill(shellPid, "SIGKILL");
          } catch {
            // The stand-in normally exits as soon as it sends its result.
          }
        }
        server.close();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  );
});
