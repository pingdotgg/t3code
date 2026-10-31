import * as NodeEvents from "node:events";
import * as NodeReadline from "node:readline";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { beforeEach, vi } from "vite-plus/test";

const { getSystemLocaleMock, getUserDefaultMock, relaunchMock, spawnMock, unrefMock } = vi.hoisted(
  () => {
    const unrefMock = vi.fn();
    return {
      getSystemLocaleMock: vi.fn(() => "en-GB"),
      getUserDefaultMock: vi.fn((_key: string) => false),
      relaunchMock: vi.fn(),
      spawnMock: vi.fn<() => NodeEvents.EventEmitter & { unref: () => void }>(),
      unrefMock,
    };
  },
);

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

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

describe("ElectronApp", () => {
  beforeEach(() => {
    getSystemLocaleMock.mockReset();
    getUserDefaultMock.mockReset();
    relaunchMock.mockReset();
    spawnMock.mockReset().mockImplementation(() => {
      const child = Object.assign(new NodeEvents.EventEmitter(), { unref: unrefMock });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    unrefMock.mockReset();
  });

  it("waits for the old process before starting the new one on Linux", () => {
    const launch = ElectronApp.linuxRelaunchCommand(4321, "/opt/t3code/t3code", ["--flag", "it's"]);
    assert.strictEqual(launch.command, "/bin/sh");
    assert.deepStrictEqual(launch.args.slice(2), [
      "t3code-relaunch",
      "4321",
      "/opt/t3code/t3code",
      "--flag",
      "it's",
    ]);
  });

  it.effect("relaunches through a detached spawn on Linux instead of Electron's relauncher", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      yield* electronApp
        .relaunch({ execPath: "/opt/t3code/t3code", args: ["--x"] })
        .pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, {}),
        );

      assert.strictEqual(relaunchMock.mock.calls.length, 0);
      assert.strictEqual(spawnMock.mock.calls.length, 1);
      const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
        string,
        ReadonlyArray<string>,
        { detached: boolean; stdio: string },
      ];
      assert.strictEqual(command, "/bin/sh");
      assert.deepStrictEqual(args.slice(3), [String(process.pid), "/opt/t3code/t3code", "--x"]);
      assert.deepStrictEqual(options, { detached: true, stdio: "ignore" });
      assert.strictEqual(unrefMock.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("waits for the shell to spawn and preserves asynchronous startup errors", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      for (const event of ["spawn", "error"] as const) {
        const child = Object.assign(new NodeEvents.EventEmitter(), { unref: vi.fn() });
        const started = Promise.withResolvers<void>();
        const cause = new Error("shell spawn failed");
        spawnMock.mockImplementationOnce(() => {
          started.resolve();
          return child;
        });
        const relaunch = yield* electronApp
          .relaunch({ execPath: "/opt/t3code/t3code" })
          .pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, {}),
            Effect.exit,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Effect.promise(() => started.promise);
        assert.isUndefined(relaunch.pollUnsafe());
        child.emit(event, cause);
        const exit = yield* Fiber.join(relaunch);
        if (event === "spawn") {
          assert.strictEqual(exit._tag, "Success");
          assert.strictEqual(child.unref.mock.calls.length, 1);
        } else {
          assert.strictEqual(exit._tag, "Failure");
          if (exit._tag === "Failure") assert.strictEqual(Cause.squash(exit.cause), cause);
          assert.strictEqual(child.unref.mock.calls.length, 0);
        }
      }
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("uses an AppImage only when its mount contains the current executable", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const currentExecPath = "/tmp/t3-mount/t3code";
      for (const [execPath, env, expected] of [
        [currentExecPath, {}, currentExecPath],
        [currentExecPath, { APPIMAGE: "/Apps/Other.AppImage" }, currentExecPath],
        [currentExecPath, { APPDIR: "/tmp/t3-mount" }, currentExecPath],
        [
          currentExecPath,
          { APPIMAGE: "/Apps/Other.AppImage", APPDIR: "/unrelated/mount" },
          currentExecPath,
        ],
        [
          currentExecPath,
          { APPIMAGE: "/Apps/T3.AppImage", APPDIR: "/tmp/t3-mount/" },
          "/Apps/T3.AppImage",
        ],
        [currentExecPath, { APPIMAGE: "/Apps/Other.AppImage", APPDIR: "/tmp/t3" }, currentExecPath],
        [
          currentExecPath,
          { APPIMAGE: "/Apps/Other.AppImage", APPDIR: "/tmp/t3-mount/../other" },
          currentExecPath,
        ],
        [
          currentExecPath,
          { APPIMAGE: "/Apps/Other.AppImage", APPDIR: "tmp/t3-mount" },
          currentExecPath,
        ],
        [
          "/tmp/t3-mount/custom",
          { APPIMAGE: "/Apps/T3.AppImage", APPDIR: "/tmp/t3-mount" },
          "/tmp/t3-mount/custom",
        ],
      ] as const) {
        spawnMock.mockClear();
        yield* electronApp
          .relaunch({ execPath, args: ["--x"] })
          .pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provideService(HostProcess.ExecutablePath, currentExecPath),
          );
        const [, args] = spawnMock.mock.calls[0] as unknown as [string, ReadonlyArray<string>];
        assert.deepStrictEqual(args.slice(4), [expected, "--x"]);
      }
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  // oxlint-disable-next-line t3code/no-global-process-runtime -- These real subprocess fixtures require the host Linux /proc filesystem.
  it.runIf(process.platform === "linux")(
    "waits while the old process is live, then executes after exit",
    async () => {
      const { spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const old = spawn(process.execPath, ["-e", 'process.stdin.resume(); console.log("ready")']);
      const oldExit = NodeEvents.EventEmitter.once(old, "exit");
      const oldLines = NodeReadline.createInterface({ input: old.stdout })[Symbol.asyncIterator]();
      let relaunch: import("node:child_process").ChildProcessWithoutNullStreams | undefined;
      try {
        assert.strictEqual((await oldLines.next()).value, "ready");
        const launch = ElectronApp.linuxRelaunchCommand(old.pid!, "/bin/sh", [
          "-c",
          'printf "%s\\n" "$@"',
          "relaunch",
          "it's",
          "with spaces",
        ]);
        // Gate the real loop at sleep so the assertion needs no timing assumptions.
        const args = [...launch.args];
        args[1] = 'sleep() { printf "waiting\\n"; read -r release; }; ' + args[1];
        relaunch = spawn(launch.command, args);
        const relaunchExit = NodeEvents.EventEmitter.once(relaunch, "exit");
        const lines = NodeReadline.createInterface({ input: relaunch.stdout })[
          Symbol.asyncIterator
        ]();
        assert.strictEqual((await lines.next()).value, "waiting");
        relaunch.stdin.write("continue\n");
        assert.strictEqual((await lines.next()).value, "waiting");
        old.stdin.end();
        await oldExit;
        relaunch.stdin.end("continue\n");
        assert.strictEqual((await lines.next()).value, "it's");
        assert.strictEqual((await lines.next()).value, "with spaces");
        assert.deepStrictEqual(await relaunchExit, [0, null]);
      } finally {
        old.stdin.end();
        old.kill();
        relaunch?.stdin.end();
        relaunch?.kill();
      }
    },
  );

  // oxlint-disable-next-line t3code/no-global-process-runtime -- These real subprocess fixtures require the host Linux /proc filesystem.
  it.runIf(process.platform === "linux")(
    "executes while the old PID is still an unreaped zombie",
    async () => {
      const { spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      // Keep the child unreaped until stdin closes; waitid confirms it has exited.
      const owner = spawn("python3", [
        "-c",
        `
import os, sys
pid = os.fork()
if pid == 0:
    os._exit(0)
try:
    os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
    print(pid, flush=True)
    sys.stdin.read()
finally:
    os.waitpid(pid, 0)
`,
      ]);
      const ownerExit = NodeEvents.EventEmitter.once(owner, "exit");
      const ownerLines = NodeReadline.createInterface({ input: owner.stdout })[
        Symbol.asyncIterator
      ]();
      let relaunch: import("node:child_process").ChildProcessWithoutNullStreams | undefined;
      try {
        const pid = Number((await ownerLines.next()).value);
        assert.ok(pid > 0);
        assert.doesNotThrow(() => process.kill(pid, 0));
        const launch = ElectronApp.linuxRelaunchCommand(pid, "/bin/sh", [
          "-c",
          'printf "executed\\n"',
        ]);
        const args = [...launch.args];
        // A mistaken live-process wait fails immediately rather than hanging the test.
        args[1] = 'sleep() { printf "waiting\\n"; exit 1; }; ' + args[1];
        relaunch = spawn(launch.command, args);
        const relaunchExit = NodeEvents.EventEmitter.once(relaunch, "exit");
        const lines = NodeReadline.createInterface({ input: relaunch.stdout })[
          Symbol.asyncIterator
        ]();
        assert.strictEqual((await lines.next()).value, "executed");
        assert.deepStrictEqual(await relaunchExit, [0, null]);
        assert.doesNotThrow(() => process.kill(pid, 0));
      } finally {
        relaunch?.kill();
        owner.stdin.end();
        await ownerExit;
      }
    },
  );

  it.effect("keeps Electron's relauncher on other platforms", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      yield* electronApp
        .relaunch({ args: ["--x"] })
        .pipe(Effect.provideService(HostProcess.Platform, "darwin"));

      assert.deepStrictEqual(relaunchMock.mock.calls, [[{ args: ["--x"] }]]);
      assert.strictEqual(spawnMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

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
    }).pipe(Effect.provide(ElectronApp.layer)),
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
    }).pipe(Effect.provide(ElectronApp.layer)),
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
