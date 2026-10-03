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

const { getSystemLocaleMock, getUserDefaultMock, relaunchMock } = vi.hoisted(() => ({
  relaunchMock: vi.fn(),
  getSystemLocaleMock: vi.fn(() => "en-GB"),
  getUserDefaultMock: vi.fn((_key: string) => false),
}));

vi.mock("electron", () => ({
  app: {
    getSystemLocale: getSystemLocaleMock,
    relaunch: relaunchMock,
  },
  systemPreferences: {
    getUserDefault: getUserDefaultMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

const electronAppLayer = ElectronApp.layer.pipe(Layer.provide(NodeServices.layer));

describe("ElectronApp", () => {
  beforeEach(() => {
    getSystemLocaleMock.mockReset();
    getUserDefaultMock.mockReset();
    relaunchMock.mockClear();
  });

  it("keeps the macOS region override and hour cycle in the locale tag", () => {
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en_GB"), "en-GB");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en-US@rg=nlzzzz", "h12"), "en-NL-u-hc-h12");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en_US@rg=nlzzzz"), "en-NL");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en-GB", "h23"), "en-GB-u-hc-h23");
  });

  it("drops ICU keywords Intl cannot read instead of losing the whole locale", () => {
    assert.strictEqual(ElectronApp.toSystemLocaleTag("de_DE@calendar=buddhist"), "de-DE");
  });

  it.effect("follows LC_TIME on Linux when it differs from the language", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {
          LANG: "en_US.UTF-8",
          LC_TIME: "de_DE.UTF-8",
        }),
      );

      assert.strictEqual(systemLocale, "de-DE");
    }).pipe(Effect.provide(electronAppLayer)),
  );

  it.effect("falls back to Chromium's locale on Linux when the time locale is C", () =>
    Effect.gen(function* () {
      getSystemLocaleMock.mockImplementationOnce(() => "fr-FR");
      const electronApp = yield* ElectronApp.ElectronApp;
      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { LANG: "C.UTF-8" }),
      );

      assert.strictEqual(systemLocale, "fr-FR");
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

it.effect("reads both macOS hour preferences without overriding explicit formats", () =>
  Effect.gen(function* () {
    for (const [preference, expected] of [
      ["AppleICUForce12HourTime", "en-NL-u-hc-h12"],
      ["AppleICUForce24HourTime", "en-NL-u-hc-h23"],
      ["", "en-NL"],
    ]) {
      getSystemLocaleMock.mockReturnValue("en_US@rg=nlzzzz");
      getUserDefaultMock.mockImplementation((key) => key === preference);
      const locale = yield* ElectronApp.make.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.strictEqual(locale, expected);
      for (const hour12 of [true, false]) {
        assert.strictEqual(
          new Intl.DateTimeFormat(locale, { hour: "numeric", hour12 }).resolvedOptions().hour12,
          hour12,
        );
      }
    }
  }),
);
